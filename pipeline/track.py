"""Track record: freeze the last pre-kickoff prediction, grade it after full time."""
from __future__ import annotations

from datetime import datetime

from . import model
from .data import is_finished, parse_dt


def outcome(hg: int, ag: int) -> int:
    return 0 if hg > ag else (1 if hg == ag else 2)


def update_history(history: dict, matches: list[dict], now: datetime) -> dict:
    """matches: prediction entries of this run (with `final`, `odds`, kickoff, status, goals).

    A prediction is overwritten freely until kickoff; afterwards it is frozen.
    Results are filled in once the fixture is finished.
    """
    for m in matches:
        key = str(m["id"])
        kickoff = parse_dt(m["kickoff"])
        entry = history.get(key)
        if kickoff > now and m["status"] in ("NS", "TBD"):
            history[key] = {
                "id": m["id"], "kickoff": m["kickoff"], "comp": m["comp"], "competition": m["competition"],
                "home": m["home"]["name"], "away": m["away"]["name"],
                "pred": {k: m["final"][k] for k in ("p_home", "p_draw", "p_away", "p_over25", "p_btts", "score", "xg_home", "xg_away")},
                "model_only": {k: m["model"][k] for k in ("p_home", "p_draw", "p_away", "score")},
                "had_analyst": bool(m.get("analyst")),
                "odds": (m.get("odds") or {}).get("implied"),
                "frozen_at": now.isoformat(),
                "result": None,
            }
        elif entry is not None and is_finished({"status": m["status"], "hg": m.get("hg"), "ag": m.get("ag")}):
            entry["result"] = {"hg": m["hg"], "ag": m["ag"]}
    return history


def attach_results(history: dict, finished: list[dict]) -> int:
    """Fill results for frozen predictions from any finished fixture list. Returns number updated."""
    by_id = {str(m["id"]): m for m in finished if is_finished(m)}
    n = 0
    for key, e in history.items():
        if e.get("result") is None and key in by_id:
            e["result"] = {"hg": by_id[key]["hg"], "ag": by_id[key]["ag"]}
            n += 1
    return n


def _grade(entries: list[dict]) -> dict:
    graded = [e for e in entries if e.get("result")]
    n = len(graded)
    if n == 0:
        return {"n": 0}
    hit = exact = 0
    br = ll = 0.0
    n_mkt = 0
    br_m = ll_m = 0.0
    hit_m = 0
    br_model = 0.0
    for e in graded:
        r = e["result"]
        o = outcome(r["hg"], r["ag"])
        p = (e["pred"]["p_home"], e["pred"]["p_draw"], e["pred"]["p_away"])
        pick = max(range(3), key=lambda k: p[k])
        hit += pick == o
        exact += e["pred"]["score"] == f'{r["hg"]}-{r["ag"]}'
        br += model.brier(p, o)
        ll += model.log_loss(p, o)
        pm = (e["model_only"]["p_home"], e["model_only"]["p_draw"], e["model_only"]["p_away"])
        br_model += model.brier(pm, o)
        mk = e.get("odds")
        if mk:
            q = (mk["home"], mk["draw"], mk["away"])
            n_mkt += 1
            br_m += model.brier(q, o)
            ll_m += model.log_loss(q, o)
            hit_m += max(range(3), key=lambda k: q[k]) == o
    out = {
        "n": n,
        "hit_1x2": round(hit / n, 4),
        "hit_exact": round(exact / n, 4),
        "brier": round(br / n, 4),
        "brier_model_only": round(br_model / n, 4),
        "log_loss": round(ll / n, 4),
    }
    if n_mkt:
        out["market"] = {
            "n": n_mkt, "hit_1x2": round(hit_m / n_mkt, 4),
            "brier": round(br_m / n_mkt, 4), "log_loss": round(ll_m / n_mkt, 4),
        }
    return out


def summarize(history: dict) -> dict:
    entries = list(history.values())
    comps = sorted({e["comp"] for e in entries if e.get("comp")})
    recent = sorted((e for e in entries if e.get("result")), key=lambda e: e["kickoff"], reverse=True)[:40]
    return {
        "overall": _grade(entries),
        "by_competition": {c: _grade([e for e in entries if e.get("comp") == c]) for c in comps},
        "pending": sum(1 for e in entries if not e.get("result")),
        "recent": [{
            "id": e["id"], "kickoff": e["kickoff"], "competition": e["competition"],
            "home": e["home"], "away": e["away"], "pred_score": e["pred"]["score"],
            "p": [e["pred"]["p_home"], e["pred"]["p_draw"], e["pred"]["p_away"]],
            "result": f'{e["result"]["hg"]}-{e["result"]["ag"]}',
        } for e in recent],
    }
