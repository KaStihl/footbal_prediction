"""Daily orchestration: fetch -> fit -> predict -> pick tabs -> (analyst) -> write JSON for the site."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from . import analyst as analyst_mod
from . import config, data, model, track
from .apifootball import ApiError, ApiFootball, BudgetExceeded, PlanError

ROOT = Path(__file__).resolve().parent.parent
TZINFO = ZoneInfo(config.TZ)

DERBIES = [
    ("Arsenal", "Tottenham"), ("Liverpool", "Everton"), ("Liverpool", "Manchester United"),
    ("Manchester City", "Manchester United"), ("Arsenal", "Chelsea"), ("Chelsea", "Tottenham"),
    ("Newcastle", "Sunderland"), ("Bayern", "Dortmund"), ("Dortmund", "Schalke"), ("Hamburg", "Werder"),
    ("Real Madrid", "Barcelona"), ("Real Madrid", "Atletico"), ("AC Milan", "Inter"), ("Roma", "Lazio"),
    ("Juventus", "Inter"), ("Paris Saint Germain", "Marseille"),
]


def jload(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def jdump(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


# ---------------------------------------------------------------------------
# windows
# ---------------------------------------------------------------------------

def weekend_window(now: datetime) -> tuple[datetime, datetime, str]:
    """The next (or current) Fri 00:00 - Mon 06:00 local window."""
    local = now.astimezone(TZINFO)
    wd = local.weekday()
    friday = local.date() - timedelta(days=wd - 4) if wd >= 4 else local.date() + timedelta(days=4 - wd)
    start = datetime(friday.year, friday.month, friday.day, tzinfo=TZINFO)
    end = start + timedelta(days=3, hours=6)
    sun = start + timedelta(days=2)
    label = f"{start.day}.–{sun.day}. {sun.month}. {sun.year}"
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc), label


# ---------------------------------------------------------------------------
# data acquisition
# ---------------------------------------------------------------------------

def fetch_matches(api, now: datetime, warnings: list[str], quiet_empty: bool = False) -> list[dict]:
    seen: dict[int, dict] = {}
    cur = config.current_club_season(now.date())
    for key, c in config.COMPETITIONS.items():
        for season in c["seasons"]:
            current = season >= (cur if c["family"] == "club" else now.year)
            ttl = 3 * 3600 if current else 7 * 86400
            if not current and not c["fit_weight"]:
                continue
            try:
                resp = api.league_fixtures(c["id"], season, ttl)
            except PlanError as e:
                warnings.append(f"{c['name']} {season}: {e}")
                continue
            except BudgetExceeded as e:
                warnings.append(f"budget exhausted before {c['name']} {season}: {e}")
                break
            except ApiError as e:
                warnings.append(f"{c['name']} {season}: {e}")
                continue
            if not resp and not quiet_empty:
                warnings.append(f"{c['name']} {season}: API returned no fixtures (season label correct? run `doctor`)")
            for fx in resp:
                m = data.norm_fixture(fx, key)
                seen[m["id"]] = m
    return list(seen.values())


def backfill_stats(api, matches: list[dict], stats: dict, now: datetime, max_calls: int, warnings: list[str]) -> int:
    """Fetch xG/shots/possession for the newest finished matches that have none yet (immutable -> cached forever)."""
    cutoff = now - timedelta(days=150)
    todo = [m for m in matches if data.is_finished(m) and str(m["id"]) not in stats
            and data.parse_dt(m["kickoff"]) > cutoff]
    todo.sort(key=lambda m: m["kickoff"], reverse=True)
    fetched = 0
    calls = 0
    for i in range(0, len(todo), 20):
        if calls >= max_calls:
            break
        batch = todo[i:i + 20]
        try:
            details = api.fixture_details([m["id"] for m in batch])
        except (ApiError, BudgetExceeded) as e:
            warnings.append(f"stats backfill stopped: {e}")
            break
        calls += 1
        got = {d["fixture"]["id"]: d for d in details}
        for m in batch:
            d = got.get(m["id"])
            st = data.extract_stats(d) if d else None
            stats[str(m["id"])] = st or {"home": None, "away": None}
            fetched += 1
    return fetched


# ---------------------------------------------------------------------------
# odds / injuries parsing
# ---------------------------------------------------------------------------

def parse_odds(resp: list) -> dict | None:
    try:
        bm = resp[0]["bookmakers"][0]
    except (IndexError, KeyError, TypeError):
        return None
    out = {"bookmaker": bm.get("name")}
    for bet in bm.get("bets", []):
        vals = {v["value"]: float(v["odd"]) for v in bet.get("values", []) if v.get("odd")}
        if bet.get("id") == 1 and {"Home", "Draw", "Away"} <= set(vals):
            out.update(home=vals["Home"], draw=vals["Draw"], away=vals["Away"])
        elif bet.get("id") == 5 and "Over 2.5" in vals and "Under 2.5" in vals:
            out.update(over25=vals["Over 2.5"], under25=vals["Under 2.5"])
        elif bet.get("id") == 8 and "Yes" in vals and "No" in vals:
            out.update(btts_yes=vals["Yes"], btts_no=vals["No"])
    if "home" not in out:
        return None
    imp = model.implied_probs(out["home"], out["draw"], out["away"])
    out["implied"] = {k: round(imp[k], 4) for k in ("home", "draw", "away")}
    out["margin"] = round(imp["margin"], 4)
    return out


def parse_injuries(resp: list) -> dict[int, list[dict]]:
    by_fx: dict[int, list[dict]] = {}
    for it in resp:
        fid = (it.get("fixture") or {}).get("id")
        if fid is None:
            continue
        by_fx.setdefault(fid, []).append({
            "team_id": it["team"]["id"], "player": it["player"].get("name"),
            "type": it["player"].get("type"), "reason": it["player"].get("reason"),
        })
    return by_fx


# ---------------------------------------------------------------------------
# main build
# ---------------------------------------------------------------------------

def interest_score(m: dict, pred: dict, table: dict, comp: dict) -> float:
    s = comp["weight"]
    for tid in (m["home_id"], m["away_id"]):
        r = (table.get(tid) or {}).get("rank")
        if r:
            s += max(0.0, (7 - r) / 6.0)
    s += 1.0 - abs(pred["p_home"] - pred["p_away"])
    s += 0.5 * min(max(pred["xg_home"] + pred["xg_away"] - 2.5, 0.0), 1.5)
    names = (m["home"], m["away"])
    if any(all(any(d.lower() in n.lower() for n in names) for d in pair) for pair in DERBIES):
        s += 1.0
    return round(s, 3)


def input_hash(obj) -> str:
    return hashlib.sha1(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def build(api, claude, *, out_dir: Path, state_dir: Path, now: datetime, use_analyst: bool = True,
          demo: bool = False, stats_calls: int | None = None) -> dict:
    warnings: list[str] = []
    stats = jload(state_dir / "stats.json", {})
    history = jload(state_dir / "history.json", {})
    analysis_state = jload(state_dir / "analysis.json", {"matches": {}, "rounds": {}})

    # 1) fixtures + stats --------------------------------------------------------
    matches = fetch_matches(api, now, warnings, quiet_empty=demo)
    n_stats = backfill_stats(api, matches, stats, now,
                             stats_calls if stats_calls is not None else config.env_int("STATS_MAX_CALLS", 12), warnings)

    # 2) fit per family ----------------------------------------------------------
    fam_comp = {c["id"]: c["family"] for c in config.COMPETITIONS.values()}
    comp_by_id = {c["id"]: (k, c) for k, c in config.COMPETITIONS.items()}
    strengths = {}
    for fam in ("club", "national"):
        fam_matches = [m for m in matches if fam_comp.get(m["league_id"]) == fam]
        strengths[fam] = model.fit(data.build_rows(fam_matches, stats, fam, now))

    # 3) upcoming fixtures -------------------------------------------------------
    horizon = now + timedelta(days=config.FIXTURE_WINDOW_DAYS)
    upcoming = [m for m in matches if m["status"] in data.UPCOMING and now <= data.parse_dt(m["kickoff"]) <= horizon
                and config.COMPETITIONS[m["comp"]]["watch"]]
    # manual extras
    extras = jload(ROOT / "extra-matches.json", {"fixture_ids": []})
    known = {m["id"] for m in upcoming}
    for fid in extras.get("fixture_ids", []):
        if fid in known:
            continue
        try:
            resp = api.fixture_by_id(fid)
        except (ApiError, BudgetExceeded) as e:
            warnings.append(f"extra fixture {fid}: {e}")
            continue
        for fx in resp:
            m = data.norm_fixture(fx, comp_by_id.get(fx["league"]["id"], ("custom", None))[0])
            m["extra"] = True
            upcoming.append(m)
    upcoming.sort(key=lambda m: m["kickoff"])

    tables = {}
    entries = []
    for m in upcoming:
        comp = config.COMPETITIONS.get(m["comp"]) or {"family": "club", "name": m["league_name"], "weight": 1.5, "id": m["league_id"]}
        fam = comp["family"]
        kick = data.parse_dt(m["kickoff"])
        key = (m["league_id"], m["season"])
        if key not in tables:  # league tables only make sense for domestic/continental club competitions
            tables[key] = data.league_table(matches, *key) if fam == "club" else {}
        table = tables[key]
        fam_matches = [x for x in matches if fam_comp.get(x["league_id"]) == fam]
        pred = model.predict(strengths[fam], m["home_id"], m["away_id"], m["league_id"], m["neutral"])
        entries.append({
            "id": m["id"], "comp": m["comp"], "competition": comp["name"], "round": m["round"],
            "kickoff": m["kickoff"], "status": m["status"],
            "home": {"id": m["home_id"], "name": m["home"], "table": table.get(m["home_id"])},
            "away": {"id": m["away_id"], "name": m["away"], "table": table.get(m["away_id"])},
            "neutral": m["neutral"], "extra": bool(m.get("extra")),
            "model": pred, "final": pred, "analyst": None, "odds": None, "injuries": [],
            "form": {"home": data.team_form(m["home_id"], fam_matches, stats, kick),
                     "away": data.team_form(m["away_id"], fam_matches, stats, kick)},
            "h2h": data.head_to_head(m["home_id"], m["away_id"], fam_matches, kick),
            "interest": interest_score(m, pred, table, comp),
            "tabs": [],
        })

    # 4) tabs --------------------------------------------------------------------
    w_start, w_end, w_label = weekend_window(now)
    for e in entries:
        k = data.parse_dt(e["kickoff"])
        if e["comp"] in config.WEEKEND_COMPETITIONS and w_start <= k <= w_end:
            e["tabs"].append("weekend")
    nl = sorted((e for e in entries if e["comp"] == config.NATIONS_LEAGUE), key=lambda e: e["kickoff"])
    nl_rounds: list[str] = []
    for e in nl:
        if e["round"] not in nl_rounds:
            nl_rounds.append(e["round"])
    for e in nl:
        if e["round"] in nl_rounds[:2]:
            e["tabs"].append("nations_league")
    per_day: dict[str, list[dict]] = {}
    for e in entries:
        day = data.parse_dt(e["kickoff"]).astimezone(TZINFO).date().isoformat()
        per_day.setdefault(day, []).append(e)
    for day, es in per_day.items():
        for e in sorted(es, key=lambda x: -x["interest"])[:config.INTERESTING_PER_DAY]:
            if e["interest"] >= 4.5 or e["extra"]:
                e["tabs"].append("interesting")
    for e in entries:
        if e["extra"] and "interesting" not in e["tabs"]:
            e["tabs"].append("interesting")

    # 5) injuries + odds (only for matches that appear in a tab) -------------------
    shown = [e for e in entries if e["tabs"]]
    shown.sort(key=lambda e: (("weekend" not in e["tabs"], "nations_league" not in e["tabs"]), e["kickoff"]))
    inj_cache: dict[tuple, dict] = {}
    for e in shown:
        k = data.parse_dt(e["kickoff"])
        league_id = next(m["league_id"] for m in upcoming if m["id"] == e["id"])
        season = next(m["season"] for m in upcoming if m["id"] == e["id"])
        if k - now <= timedelta(days=config.ODDS_WINDOW_DAYS):
            try:
                o = parse_odds(api.odds(e["id"], config.ODDS_BOOKMAKER()))
                e["odds"] = o
            except (ApiError, BudgetExceeded) as ex:
                warnings.append(f"odds {e['id']}: {ex}")
        if e["comp"] in ("premier_league", "bundesliga", "la_liga", "serie_a", "ligue_1", "champions_league", "europa_league") \
                and k - now <= timedelta(days=3):
            ck = (league_id, season, k.date().isoformat())
            if ck not in inj_cache:
                try:
                    inj_cache[ck] = parse_injuries(api.injuries(league_id, season, ck[2]))
                except (ApiError, BudgetExceeded) as ex:
                    warnings.append(f"injuries {ck}: {ex}")
                    inj_cache[ck] = {}
            e["injuries"] = inj_cache[ck].get(e["id"], [])
    for e in entries:
        if e["odds"]:
            imp = e["odds"]["implied"]
            f = e["final"]
            e["odds"]["edge"] = {"home": round(f["p_home"] - imp["home"], 4),
                                 "draw": round(f["p_draw"] - imp["draw"], 4),
                                 "away": round(f["p_away"] - imp["away"], 4)}

    # 6) analyst -------------------------------------------------------------------
    usage = analyst_mod.Usage()
    analysed = 0
    if use_analyst and claude is not None:
        analysed = run_analyst(claude, usage, entries, analysis_state, now, warnings)
    apply_analysis(entries, analysis_state, now)
    if use_analyst and claude is not None:
        summarize_rounds(claude, usage, entries, analysis_state, w_label, nl_rounds[:2], warnings)

    # 7) track record ----------------------------------------------------------------
    for e in entries:
        e["hg"] = e["ag"] = None
    track.update_history(history, entries, now)
    for e in entries:
        h = history.get(str(e["id"]))
        if h is not None:
            h["tabs"] = e["tabs"]
    track.attach_results(history, [m for m in matches if data.is_finished(m)])
    track_summary = track.summarize(history)
    played = []
    for h in history.values():
        k = data.parse_dt(h["kickoff"])
        if now - timedelta(days=4) <= k <= now and h.get("tabs"):
            played.append(h)
    played.sort(key=lambda h: h["kickoff"], reverse=True)

    # 8) write -------------------------------------------------------------------------
    meta = {
        "generated_at": now.isoformat(), "demo": demo,
        "api": {"calls": api.calls, "cache_hits": api.cache_hits, "remaining_daily": api.remaining_daily,
                "stats_fetched": n_stats},
        "analyst": {"enabled": bool(use_analyst and claude is not None), "model": config.ANALYST_MODEL(),
                    "matches_analysed_this_run": analysed, "usage": usage.as_dict()},
        "weekend": {"label": w_label, "from": w_start.isoformat(), "to": w_end.isoformat()},
        "nations_league_rounds": nl_rounds[:2],
        "model": {"teams_club": len(strengths["club"].att), "teams_national": len(strengths["national"].att),
                  "home_adv_club": round(strengths["club"].home_adv, 3),
                  "home_adv_national": round(strengths["national"].home_adv, 3)},
        "warnings": warnings,
        "round_summaries": analysis_state.get("rounds", {}),
    }
    jdump(out_dir / "predictions.json", {"generated_at": now.isoformat(), "matches": [e for e in entries if e["tabs"]],
                                         "played": played})
    jdump(out_dir / "meta.json", meta)
    jdump(out_dir / "track.json", track_summary)
    jdump(state_dir / "stats.json", stats)
    jdump(state_dir / "history.json", history)
    jdump(state_dir / "analysis.json", analysis_state)
    return meta


# ---------------------------------------------------------------------------
# analyst glue
# ---------------------------------------------------------------------------

def dossier(e: dict) -> dict:
    return {
        "match": {"id": e["id"], "competition": e["competition"], "round": e["round"], "kickoff_utc": e["kickoff"],
                  "home": e["home"]["name"], "away": e["away"]["name"], "neutral_venue": e["neutral"]},
        "league_position": {"home": e["home"]["table"], "away": e["away"]["table"]},
        "model": {k: e["model"][k] for k in ("xg_home", "xg_away", "p_home", "p_draw", "p_away", "p_over25", "p_btts",
                                             "score", "confidence")},
        "form_last5": e["form"],
        "head_to_head": e["h2h"],
        "api_football_injuries": e["injuries"],
        "bookmaker_odds": {k: e["odds"][k] for k in ("bookmaker", "home", "draw", "away", "implied")} if e["odds"] else None,
    }


def run_analyst(claude, usage, entries, state, now, warnings) -> int:
    window = timedelta(hours=config.ANALYST_WINDOW_HOURS())
    max_age = timedelta(hours=config.ANALYST_MAX_AGE_HOURS())
    prio = {"weekend": 0, "nations_league": 1, "interesting": 2}
    cands = [e for e in entries if e["tabs"] and data.parse_dt(e["kickoff"]) - now <= window]
    cands.sort(key=lambda e: (min(prio[t] for t in e["tabs"]), e["kickoff"]))
    jobs = []
    for e in cands:
        d = dossier(e)
        h = input_hash({k: v for k, v in d.items() if k != "bookmaker_odds"})  # odds drift constantly; don't re-pay for that
        cur = state["matches"].get(str(e["id"]))
        fresh = cur and cur.get("hash") == h and now - data.parse_dt(cur["updated_at"]) < max_age
        if fresh:
            continue
        jobs.append((e["id"], d, h))
    jobs = jobs[:config.ANALYST_MAX_MATCHES()]
    if not jobs:
        return 0
    results = analyst_mod.analyse_many(claude, usage, [(fid, d) for fid, d, _ in jobs], now.date().isoformat())
    hashes = {fid: h for fid, _, h in jobs}
    ok = 0
    for fid, res in results.items():
        if isinstance(res, str):
            warnings.append(f"analyst {fid}: {res}")
            continue
        res["hash"] = hashes[fid]
        res["updated_at"] = now.isoformat()
        state["matches"][str(fid)] = res
        ok += 1
    return ok


def apply_analysis(entries, state, now) -> None:
    """Attach stored analyses; recompute the final numbers with the analyst's bounded multipliers."""
    for e in entries:
        a = state["matches"].get(str(e["id"]))
        if not a:
            continue
        k = data.parse_dt(e["kickoff"])
        if k < now:
            continue
        lh = e["model"]["xg_home"] * a["xg_mult_home"]
        la = e["model"]["xg_away"] * a["xg_mult_away"]
        n_min = min(e["model"]["n_eff_home"], e["model"]["n_eff_away"])
        final = model.summarize(lh, la, n_min)
        final["n_eff_home"], final["n_eff_away"] = e["model"]["n_eff_home"], e["model"]["n_eff_away"]
        e["final"] = final
        e["analyst"] = {k2: v for k2, v in a.items() if k2 not in ("hash",)}
        age_h = (now - data.parse_dt(a["updated_at"])).total_seconds() / 3600
        e["analyst"]["stale"] = age_h > config.ANALYST_MAX_AGE_HOURS() * 2


def summarize_rounds(claude, usage, entries, state, w_label, nl_rounds, warnings) -> None:
    def compact(es):
        return [{"match_id": e["id"], "match": f'{e["home"]["name"]} - {e["away"]["name"]}', "kickoff": e["kickoff"],
                 "pick": e["final"]["score"], "p": [e["final"]["p_home"], e["final"]["p_draw"], e["final"]["p_away"]],
                 "analysis": (e["analyst"] or {}).get("summary"),
                 "absences": [f'{a["player"]} ({a["status"]})' for a in (e["analyst"] or {}).get("absences", [])]}
                for e in es]

    for tab, title in (("weekend", f"Premier League + Bundesliga, víkend {w_label}"),
                       ("nations_league", "Liga národov: " + ", ".join(nl_rounds))):
        es = [e for e in entries if tab in e["tabs"] and e["analyst"]]
        if not es:
            continue
        items = compact(es)
        h = input_hash(items)
        cur = state["rounds"].get(tab)
        if cur and cur.get("hash") == h:
            continue
        res = analyst_mod.summarize_round(claude, usage, title, items)
        if isinstance(res, str):
            warnings.append(f"round summary {tab}: {res}")
            continue
        res.update(hash=h, title=title, updated_at=datetime.now(timezone.utc).isoformat())
        state["rounds"][tab] = res


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_doctor(api) -> int:
    print("Checking configured competitions against the live API ...")
    bad = 0
    for key, c in config.COMPETITIONS.items():
        try:
            resp = api.leagues(c["id"])
        except (ApiError, BudgetExceeded) as e:
            print(f"  {key:18} id={c['id']:<4} ERROR {e}")
            bad += 1
            continue
        if not resp:
            print(f"  {key:18} id={c['id']:<4} not found")
            bad += 1
            continue
        seasons = {s["year"]: s.get("coverage", {}) for s in resp[0].get("seasons", [])}
        for want in c["seasons"]:
            cov = seasons.get(want)
            if cov is None:
                print(f"  {key:18} season {want}: NOT AVAILABLE (known: {sorted(seasons)[-5:]})")
                bad += 1
            else:
                f = cov.get("fixtures", {})
                print(f"  {key:18} season {want}: ok  stats={f.get('statistics_fixtures')} "
                      f"injuries={cov.get('injuries')} odds={cov.get('odds')}")
    print("Remaining daily requests:", api.remaining_daily)
    return 1 if bad else 0


def cmd_find(api, name: str) -> int:
    for t in api.teams_search(name)[:5]:
        team = t["team"]
        print(f'{team["id"]:>6}  {team["name"]} ({team.get("country")}, national={team.get("national")})')
    return 0


def cmd_fixtures(api, team_id: int) -> int:
    resp = api.get("/fixtures", {"team": team_id, "next": 5, "timezone": "UTC"}, ttl=3600)
    for fx in resp:
        print(f'{fx["fixture"]["id"]:>9}  {fx["fixture"]["date"][:16]}  {fx["teams"]["home"]["name"]} - '
              f'{fx["teams"]["away"]["name"]}  [{fx["league"]["name"]}]')
    return 0


def make_claude():
    if not config.env("ANTHROPIC_API_KEY"):
        return None
    import anthropic
    return anthropic.Anthropic(timeout=600.0, max_retries=3)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pipeline")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="daily run")
    r.add_argument("--no-analyst", action="store_true")
    r.add_argument("--out", default=str(ROOT / "site" / "data"))
    r.add_argument("--state", default=str(ROOT / "state"))
    sub.add_parser("doctor", help="verify competitions/seasons against the live API")
    f = sub.add_parser("find-team")
    f.add_argument("name")
    nf = sub.add_parser("next-fixtures", help="list upcoming fixture ids of a team (for extra-matches.json)")
    nf.add_argument("team_id", type=int)
    d = sub.add_parser("demo", help="generate fictional DEMO data for UI development")
    d.add_argument("--out", default=str(ROOT / "site" / "data" / "demo"))
    args = ap.parse_args(argv)

    if args.cmd == "demo":
        from . import fake
        return fake.build_demo(Path(args.out))

    api = ApiFootball(config.API_KEY(), ROOT / ".cache" / "api", rpm=config.API_RPM(), max_calls=config.API_MAX_CALLS())
    if args.cmd == "doctor":
        return cmd_doctor(api)
    if args.cmd == "find-team":
        return cmd_find(api, args.name)
    if args.cmd == "next-fixtures":
        return cmd_fixtures(api, args.team_id)

    claude = None if args.no_analyst else make_claude()
    meta = build(api, claude, out_dir=Path(args.out), state_dir=Path(args.state), now=datetime.now(timezone.utc),
                 use_analyst=not args.no_analyst)
    print(json.dumps({k: meta[k] for k in ("api", "analyst", "weekend", "model", "warnings")}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
