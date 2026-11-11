"""Normalise API-Football payloads and derive model inputs (form, H2H, table, xG blend)."""
from __future__ import annotations

from datetime import datetime, timezone

from . import config
from .model import Row, time_weight

FINISHED = {"FT", "AET", "PEN"}
UPCOMING = {"NS", "TBD"}
LIVE = {"1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT", "SUSP"}


def parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def norm_fixture(fx: dict, comp_key: str | None = None) -> dict:
    f, lg, tm, gl = fx["fixture"], fx["league"], fx["teams"], fx.get("goals") or {}
    return {
        "id": f["id"],
        "comp": comp_key,
        "league_id": lg["id"],
        "league_name": lg.get("name"),
        "season": lg.get("season"),
        "round": lg.get("round"),
        "kickoff": parse_dt(f["date"]).isoformat(),
        "status": (f.get("status") or {}).get("short", "NS"),
        "home_id": tm["home"]["id"], "home": tm["home"]["name"],
        "away_id": tm["away"]["id"], "away": tm["away"]["name"],
        "hg": gl.get("home"), "ag": gl.get("away"),
        "neutral": lg["id"] in config.NEUTRAL_LEAGUE_IDS,
    }


def is_finished(m: dict) -> bool:
    return m["status"] in FINISHED and m["hg"] is not None and m["ag"] is not None


# -- statistics (xG / shots / possession) ------------------------------------

def _stat(stats: list[dict], name: str):
    for s in stats:
        if s.get("type") == name:
            v = s.get("value")
            if isinstance(v, str) and v.endswith("%"):
                v = v[:-1]
            try:
                return float(v) if v is not None else None
            except (TypeError, ValueError):
                return None
    return None


def extract_stats(detail: dict) -> dict | None:
    """Pull the numbers we use out of a /fixtures?ids=... entry."""
    out = {}
    for block in detail.get("statistics") or []:
        side = "home" if block["team"]["id"] == detail["teams"]["home"]["id"] else "away"
        st = block.get("statistics") or []
        out[side] = {
            "xg": _stat(st, "expected_goals"),
            "sot": _stat(st, "Shots on Goal"),
            "shots": _stat(st, "Total Shots"),
            "poss": _stat(st, "Ball Possession"),
            "corners": _stat(st, "Corner Kicks"),
        }
    return out if len(out) == 2 else None


def perf_goals(goals: float, st: dict | None) -> float:
    """Blend real goals with xG (or a shots-on-target proxy) to reduce finishing luck."""
    if not st:
        return float(goals)
    proxy = st.get("xg")
    if proxy is None and st.get("sot") is not None:
        shots = st.get("shots") if st.get("shots") is not None else st["sot"]
        proxy = 0.30 * st["sot"] + 0.03 * max(shots - st["sot"], 0.0)
    if proxy is None:
        return float(goals)
    return config.XG_BLEND * goals + (1.0 - config.XG_BLEND) * float(proxy)


# -- model rows --------------------------------------------------------------

def build_rows(matches: list[dict], stats: dict, family: str, as_of: datetime) -> list[Row]:
    comp_weight = {c["id"]: c["fit_weight"] for c in config.COMPETITIONS.values()}
    half_life = config.HALF_LIFE_DAYS[family]
    rows = []
    for m in matches:
        if not is_finished(m):
            continue
        st = stats.get(str(m["id"]))
        w = time_weight(parse_dt(m["kickoff"]), as_of, half_life) * comp_weight.get(m["league_id"], 1.0)
        if w < 1e-4:
            continue
        rows.append(Row(
            home=m["home_id"], away=m["away_id"],
            yh=perf_goals(m["hg"], st.get("home") if st else None),
            ya=perf_goals(m["ag"], st.get("away") if st else None),
            w=w, comp=m["league_id"], neutral=m["neutral"],
        ))
    return rows


# -- context shown in the UI / handed to the analyst --------------------------

def team_form(team_id: int, matches: list[dict], stats: dict, before: datetime, n: int = 5) -> dict:
    played = [m for m in matches
              if is_finished(m) and parse_dt(m["kickoff"]) < before and team_id in (m["home_id"], m["away_id"])]
    played.sort(key=lambda m: m["kickoff"], reverse=True)
    last = played[:n]
    results, gf_sum, ga_sum, pts = [], 0, 0, 0
    xg_for, xg_against, sot, poss, sc = [], [], [], [], 0
    for m in last:
        home = m["home_id"] == team_id
        gf, ga = (m["hg"], m["ag"]) if home else (m["ag"], m["hg"])
        res = "W" if gf > ga else ("D" if gf == ga else "L")
        pts += 3 if res == "W" else (1 if res == "D" else 0)
        gf_sum += gf
        ga_sum += ga
        st = stats.get(str(m["id"]))
        mine = (st or {}).get("home" if home else "away") or {}
        theirs = (st or {}).get("away" if home else "home") or {}
        if mine.get("xg") is not None:
            xg_for.append(mine["xg"])
        if theirs.get("xg") is not None:
            xg_against.append(theirs["xg"])
        if mine.get("sot") is not None:
            sot.append(mine["sot"])
        if mine.get("poss") is not None:
            poss.append(mine["poss"])
        results.append({
            "date": m["kickoff"][:10], "opp": m["away"] if home else m["home"], "home": home,
            "score": f"{gf}-{ga}", "res": res, "comp": m["league_name"],
        })
        sc += 1 if ga == 0 else 0

    def avg(xs):
        return round(sum(xs) / len(xs), 2) if xs else None

    k = len(last)
    return {
        "last": results,
        "form": "".join(r["res"] for r in results),
        "points": pts, "games": k,
        "gf": round(gf_sum / k, 2) if k else None, "ga": round(ga_sum / k, 2) if k else None,
        "xg_for": avg(xg_for), "xg_against": avg(xg_against), "sot": avg(sot), "possession": avg(poss),
        "clean_sheets": sc,
    }


def head_to_head(home_id: int, away_id: int, matches: list[dict], before: datetime, n: int = 6) -> dict:
    played = [m for m in matches
              if is_finished(m) and parse_dt(m["kickoff"]) < before and {m["home_id"], m["away_id"]} == {home_id, away_id}]
    played.sort(key=lambda m: m["kickoff"], reverse=True)
    played = played[:n]
    hw = dw = aw = 0
    gh = ga = 0
    items = []
    for m in played:
        g_home_team = m["hg"] if m["home_id"] == home_id else m["ag"]
        g_away_team = m["ag"] if m["home_id"] == home_id else m["hg"]
        gh += g_home_team
        ga += g_away_team
        if g_home_team > g_away_team:
            hw += 1
        elif g_home_team < g_away_team:
            aw += 1
        else:
            dw += 1
        items.append({"date": m["kickoff"][:10], "home": m["home"], "away": m["away"], "score": f"{m['hg']}-{m['ag']}"})
    return {"n": len(played), "home_wins": hw, "draws": dw, "away_wins": aw, "goals_home_team": gh, "goals_away_team": ga, "matches": items}


def league_table(matches: list[dict], league_id: int, season: int) -> dict[int, dict]:
    """Rank from finished matches of one league season (no extra API call)."""
    pts, gf, ga, gp, name = {}, {}, {}, {}, {}
    for m in matches:
        if m["league_id"] != league_id or m["season"] != season or not is_finished(m):
            continue
        for tid, tname, f, a in ((m["home_id"], m["home"], m["hg"], m["ag"]), (m["away_id"], m["away"], m["ag"], m["hg"])):
            name[tid] = tname
            gp[tid] = gp.get(tid, 0) + 1
            gf[tid] = gf.get(tid, 0) + f
            ga[tid] = ga.get(tid, 0) + a
            pts[tid] = pts.get(tid, 0) + (3 if f > a else (1 if f == a else 0))
    order = sorted(pts, key=lambda t: (-pts[t], -(gf[t] - ga[t]), -gf[t]))
    return {t: {"rank": i + 1, "points": pts[t], "gd": gf[t] - ga[t], "played": gp[t], "of": len(order)} for i, t in enumerate(order)}
