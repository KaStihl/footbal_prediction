"""DEMO data generator: fictional teams, fake API, fake analyst.

Used to develop and test the pipeline + UI without an API key. Nothing here
resembles real clubs or real predictions; the site shows a loud DEMO banner when
`meta.demo` is true.
"""
from __future__ import annotations

import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from . import config, run

CLUB_A = ["Northbridge", "Eastvale", "Ironford", "Redmoor", "Stonegate", "Highfield", "Lakeside", "Westmark",
          "Oakhurst", "Brightwater", "Coldharbor", "Fairhaven"]
CLUB_B = ["FC Aldenau", "SV Brunnental", "TSG Kaltenburg", "VfB Lindwald", "FK Roterfels", "SC Sonnberg",
          "1. FC Wiesenau", "Hansa Nordhafen", "Union Grauwald", "FSV Eisental", "SpVgg Mühlbach", "Rapid Hohenau"]
NATIONS = ["Aurelia", "Borovia", "Cardenia", "Dalmora", "Elbonia", "Freedonia", "Gondwana", "Hesperia",
           "Illyria", "Jotunia", "Kerovia", "Lorania", "Montvale", "Norland", "Ostria", "Pelagia"]


def _pois(rnd: random.Random, lam: float) -> int:
    limit, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rnd.random()
        if p <= limit:
            return k
        k += 1


def _fx(fid, league_id, name, season, rnd_label, dt, hid, hname, aid, aname, hg=None, ag=None, status="NS"):
    return {
        "fixture": {"id": fid, "date": dt.isoformat(), "status": {"short": status}},
        "league": {"id": league_id, "name": name, "season": season, "round": rnd_label},
        "teams": {"home": {"id": hid, "name": hname}, "away": {"id": aid, "name": aname}},
        "goals": {"home": hg, "away": ag},
    }


class FakeApi:
    """Same surface as ApiFootball for the methods the pipeline uses."""

    def __init__(self, now: datetime, seed: int = 11):
        self.now = now
        self.rnd = random.Random(seed)
        self.calls = 0
        self.cache_hits = 0
        self.remaining_daily = 1000
        self.truth: dict[int, tuple[float, float]] = {}
        self.fixtures: dict[int, list[dict]] = {}   # league id -> fixtures (current season)
        self.details: dict[int, dict] = {}
        self._fid = 100000
        self._tid = 1000
        self._build()

    def _team_ids(self, names):
        ids = {}
        for n in names:
            self._tid += 1
            ids[n] = self._tid
            self.truth[self._tid] = (self.rnd.uniform(-0.45, 0.45), self.rnd.uniform(-0.45, 0.45))
        return ids

    def _lam(self, h, a, mu, ha):
        return (math.exp(mu + ha + self.truth[h][0] - self.truth[a][1]),
                math.exp(mu + self.truth[a][0] - self.truth[h][1]))

    def _round_robin(self, teams):
        ids = list(teams)
        n = len(ids)
        rounds = []
        arr = ids[:]
        for r in range(n - 1):
            pairs = [(arr[i], arr[n - 1 - i]) for i in range(n // 2)]
            rounds.append(pairs if r % 2 == 0 else [(b, a) for a, b in pairs])
            arr = [arr[0]] + [arr[-1]] + arr[1:-1]
        return rounds + [[(b, a) for a, b in rd] for rd in rounds]

    def _league(self, league_id, name, names, mu, played_rounds, weekly_anchor, kick_hours):
        ids = self._team_ids(names)
        by_id = {v: k for k, v in ids.items()}
        rounds = self._round_robin(list(ids.values()))
        season = config.current_club_season(self.now.date())
        out = []
        for ri, pairs in enumerate(rounds[:played_rounds + 3]):
            day = weekly_anchor + timedelta(weeks=ri - played_rounds)
            for pi, (h, a) in enumerate(pairs):
                self._fid += 1
                hr = kick_hours[pi % len(kick_hours)]
                dt = day.replace(hour=hr[0], minute=hr[1]) + timedelta(days=hr[2])
                label = f"Regular Season - {ri + 1}"
                if dt < self.now - timedelta(hours=3):
                    lh, la = self._lam(h, a, mu, 0.25)
                    hg, ag = _pois(self.rnd, lh), _pois(self.rnd, la)
                    out.append(_fx(self._fid, league_id, name, season, label, dt, h, by_id[h], a, by_id[a], hg, ag, "FT"))
                    self._make_details(self._fid, h, a, lh, la, hg, ag)
                else:
                    out.append(_fx(self._fid, league_id, name, season, label, dt, h, by_id[h], a, by_id[a]))
        self.fixtures[league_id] = out

    def _make_details(self, fid, h, a, lh, la, hg, ag):
        def side(lam, goals, tid):
            xg = max(0.05, lam * self.rnd.uniform(0.75, 1.25))
            shots = int(xg * 8 + self.rnd.randint(2, 6))
            return {"team": {"id": tid}, "statistics": [
                {"type": "expected_goals", "value": f"{xg:.2f}"},
                {"type": "Shots on Goal", "value": max(goals, int(shots * 0.38))},
                {"type": "Total Shots", "value": shots},
                {"type": "Ball Possession", "value": f"{int(50 + (self.truth[tid][0] - 0.0) * 18 + self.rnd.randint(-5, 5))}%"},
                {"type": "Corner Kicks", "value": self.rnd.randint(2, 9)}]}
        self.details[fid] = {"teams": {"home": {"id": h}, "away": {"id": a}},
                             "fixture": {"id": fid}, "statistics": [side(lh, hg, h), side(la, ag, a)]}

    def _build(self):
        now = self.now
        sat = (now + timedelta(days=(5 - now.weekday()) % 7)).replace(hour=0, minute=0, second=0, microsecond=0)
        if now.weekday() == 6:
            sat = (now + timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
        kicks = [(15, 30, 0), (18, 0, 0), (15, 30, 0), (17, 30, 1), (20, 30, -1), (15, 0, 1), (15, 30, 0), (18, 30, 0), (14, 0, 1), (16, 30, 1)]
        self._league(39, "Premier League", CLUB_A, 0.28, 12, sat, kicks)
        self._league(78, "Bundesliga", CLUB_B, 0.38, 11, sat, kicks)
        # nations league: round 5 a few days ago, rounds 6 and 7 upcoming
        ids = self._team_ids(NATIONS)
        by_id = {v: k for k, v in ids.items()}
        tl = list(ids.values())
        self.rnd.shuffle(tl)
        out = []
        base = (now + timedelta(days=3)).replace(hour=0, minute=0, second=0, microsecond=0)
        for ri in range(-4, 2):
            self.rnd.shuffle(tl)
            for i in range(0, len(tl), 2):
                h, a = tl[i], tl[i + 1]
                self._fid += 1
                dt = base + timedelta(days=ri * 35 + (i // 4), hours=20, minutes=45)
                label = f"League Phase - {ri + 5}"
                if dt < now - timedelta(hours=3):
                    lh, la = self._lam(h, a, 0.15, 0.2)
                    hg, ag = _pois(self.rnd, lh), _pois(self.rnd, la)
                    out.append(_fx(self._fid, 5, "UEFA Nations League", 2026 if ri >= -1 else 2024, label, dt, h, by_id[h], a, by_id[a], hg, ag, "FT"))
                    self._make_details(self._fid, h, a, lh, la, hg, ag)
                else:
                    out.append(_fx(self._fid, 5, "UEFA Nations League", 2026, label, dt, h, by_id[h], a, by_id[a]))
        self.fixtures[5] = out
        self.names = {fx["teams"]["home"]["id"]: fx["teams"]["home"]["name"] for fxs in self.fixtures.values() for fx in fxs}

    # -- API surface ----------------------------------------------------------
    def league_fixtures(self, league, season, ttl):
        fxs = self.fixtures.get(league, [])
        return [f for f in fxs if f["league"]["season"] == season]

    def fixture_details(self, ids):
        return [self.details[i] for i in ids if i in self.details]

    def injuries(self, league, season, date):
        out = []
        for fx in self.fixtures.get(league, []):
            if fx["fixture"]["date"][:10] == date and fx["fixture"]["status"]["short"] == "NS":
                r = random.Random(fx["fixture"]["id"])
                if r.random() < 0.7:
                    t = fx["teams"]["home" if r.random() < 0.5 else "away"]
                    out.append({"player": {"name": f"Demo Player {r.randint(2, 30)}", "type": "Missing Fixture", "reason": "Knee Injury"},
                                "team": {"id": t["id"], "name": t["name"]}, "fixture": {"id": fx["fixture"]["id"]}})
        return out

    def odds(self, fixture, bookmaker):
        for fxs in self.fixtures.values():
            for fx in fxs:
                if fx["fixture"]["id"] == fixture:
                    h, a = fx["teams"]["home"]["id"], fx["teams"]["away"]["id"]
                    lh, la = self._lam(h, a, 0.25, 0.25)
                    from . import model
                    s = model.summarize(lh * self.rnd.uniform(0.92, 1.08), la * self.rnd.uniform(0.92, 1.08))
                    m = 1.06

                    def od(p):
                        return f"{max(1.05, 1 / (p * m)):.2f}"
                    return [{"bookmakers": [{"name": "DemoBook", "bets": [
                        {"id": 1, "values": [{"value": "Home", "odd": od(s["p_home"])}, {"value": "Draw", "odd": od(s["p_draw"])},
                                             {"value": "Away", "odd": od(s["p_away"])}]},
                        {"id": 5, "values": [{"value": "Over 2.5", "odd": od(s["p_over25"])}, {"value": "Under 2.5", "odd": od(1 - s["p_over25"])}]}]}]}]
        return []

    def fixture_by_id(self, fid):
        return []


# ---------------------------------------------------------------------------
# fake analyst (stands in for Claude in demo / tests)
# ---------------------------------------------------------------------------

class FakeClaude:
    def __init__(self):
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kw):
        user = kw["messages"][0]["content"]
        usage = SimpleNamespace(input_tokens=1800, output_tokens=700, cache_read_input_tokens=0,
                                cache_creation_input_tokens=0, server_tool_use=SimpleNamespace(web_search_requests=3))
        if user.startswith("Round:"):
            items = json.loads(user.split("<matches>")[1].split("</matches>")[0])
            payload = {
                "overview": f"[DEMO] Kolo má {len(items)} zápasov. Model vidí viac jasných favoritov než vyrovnaných zápasov; "
                            "toto je ukážkový text, nie reálna analýza.",
                "top_picks": [{"match_id": it["match_id"], "comment": f"[DEMO] {it['match']}: tip {it['pick']}."} for it in items[:3]],
                "risks": ["[DEMO] Vyrovnané zápasy s nízkou istotou modelu."],
            }
        else:
            d = json.loads(user.split("<dossier>")[1].split("</dossier>")[0])
            r = random.Random(d["match"]["id"])
            mh, ma = round(r.uniform(0.94, 1.05), 3), round(r.uniform(0.94, 1.05), 3)
            mo = d["model"]
            payload = {
                "xg_mult_home": mh, "xg_mult_away": ma,
                "summary": (f"[DEMO] Model očakáva {mo['xg_home']:.2f}:{mo['xg_away']:.2f} gólu a tipuje {mo['score']}. "
                            "Toto je vygenerovaný ukážkový text pre vývoj rozhrania, nie skutočná analýza správ o tímoch."),
                "key_factors": [{"factor": "Forma za posledných 5 zápasov", "favours": "home" if mo["p_home"] > mo["p_away"] else "away",
                                 "detail": "[DEMO] Ukážkový faktor."}],
                "absences": [{"team": "home" if r.random() < .5 else "away", "player": f"Demo Player {r.randint(2, 30)}",
                              "status": "out", "source_url": "https://example.com/demo-club-news", "source_type": "club_official",
                              "confidence": "high"}] if r.random() < 0.8 else [],
                "lineups_confirmed": False, "data_gaps": ["[DEMO] Žiadne reálne zdroje neboli čítané."],
            }
        return SimpleNamespace(stop_reason="end_turn", usage=usage,
                               content=[SimpleNamespace(type="text", text=json.dumps(payload))])


def build_demo(out: Path) -> int:
    now = datetime.now(timezone.utc)
    api = FakeApi(now)
    state = out.parent / "_demo_state"
    run.build(api, FakeClaude(), out_dir=out, state_dir=state, now=now, demo=True, stats_calls=50)
    # demo state is throwaway
    for f in state.glob("*.json"):
        f.unlink()
    state.rmdir()
    print(f"demo data written to {out}")
    return 0
