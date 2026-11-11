import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from pipeline import analyst, fake, run, track


class WeekendWindowTests(unittest.TestCase):
    def test_midweek_points_to_coming_weekend(self):
        s, e, label = run.weekend_window(datetime(2026, 11, 11, 12, tzinfo=timezone.utc))  # Wednesday
        self.assertEqual(s.astimezone(run.TZINFO).strftime("%a %d.%m"), "Fri 13.11")
        self.assertEqual(e.astimezone(run.TZINFO).strftime("%a %H"), "Mon 06")
        self.assertIn("13.", label)

    def test_saturday_keeps_current_weekend(self):
        s, _, _ = run.weekend_window(datetime(2026, 11, 14, 9, tzinfo=timezone.utc))
        self.assertEqual(s.astimezone(run.TZINFO).strftime("%d.%m"), "13.11")

    def test_monday_moves_to_next_weekend(self):
        s, _, _ = run.weekend_window(datetime(2026, 11, 16, 9, tzinfo=timezone.utc))
        self.assertEqual(s.astimezone(run.TZINFO).strftime("%d.%m"), "20.11")


class AnalystSanitizeTests(unittest.TestCase):
    def test_multipliers_are_clamped_and_urls_checked(self):
        out = analyst.sanitize({
            "xg_mult_home": 3.0, "xg_mult_away": 0.1, "summary": "x" * 5000,
            "absences": [{"team": "home", "player": "A", "status": "out", "source_url": "javascript:alert(1)",
                          "source_type": "club_official", "confidence": "high"},
                         {"team": "zzz", "player": "B", "status": "??", "source_url": "https://club.example/news",
                          "source_type": "weird", "confidence": "??"}],
            "key_factors": [], "lineups_confirmed": "yes", "data_gaps": [],
        })
        self.assertAlmostEqual(out["xg_mult_home"], 1.15)
        self.assertAlmostEqual(out["xg_mult_away"], 0.85)
        self.assertEqual(len(out["summary"]), 1500)
        self.assertEqual(out["absences"][0]["source_url"], "")
        self.assertEqual(out["absences"][1]["team"], "home")
        self.assertEqual(out["absences"][1]["confidence"], "low")
        self.assertEqual(out["absences"][1]["source_url"], "https://club.example/news")

    def test_garbage_multiplier_defaults_to_one(self):
        self.assertEqual(analyst.sanitize({"xg_mult_home": "abc"})["xg_mult_home"], 1.0)


class OddsParseTests(unittest.TestCase):
    def test_parse(self):
        resp = [{"bookmakers": [{"name": "B", "bets": [
            {"id": 1, "values": [{"value": "Home", "odd": "2.0"}, {"value": "Draw", "odd": "3.5"}, {"value": "Away", "odd": "4.0"}]}]}]}]
        o = run.parse_odds(resp)
        self.assertAlmostEqual(sum(o["implied"].values()), 1.0, places=2)
        self.assertIsNone(run.parse_odds([]))


class TrackTests(unittest.TestCase):
    def _entry(self, fid, p, score, res):
        return {"id": fid, "kickoff": "2026-11-01T15:00:00+00:00", "comp": "premier_league", "competition": "Premier League",
                "home": "A", "away": "B",
                "pred": {"p_home": p[0], "p_draw": p[1], "p_away": p[2], "p_over25": .5, "p_btts": .5, "score": score, "xg_home": 1, "xg_away": 1},
                "model_only": {"p_home": p[0], "p_draw": p[1], "p_away": p[2], "score": score},
                "odds": {"home": .5, "draw": .25, "away": .25}, "result": res}

    def test_grading(self):
        h = {"1": self._entry(1, (.6, .2, .2), "2-0", {"hg": 2, "ag": 0}),
             "2": self._entry(2, (.2, .2, .6), "0-1", {"hg": 1, "ag": 1}),
             "3": self._entry(3, (.4, .3, .3), "1-0", None)}
        s = track.summarize(h)
        self.assertEqual(s["overall"]["n"], 2)
        self.assertEqual(s["overall"]["hit_1x2"], 0.5)
        self.assertEqual(s["overall"]["hit_exact"], 0.5)
        self.assertEqual(s["pending"], 1)
        self.assertIn("market", s["overall"])


class EndToEndDemoTests(unittest.TestCase):
    def test_demo_build_is_consistent(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "out"
            now = datetime(2026, 11, 11, 12, tzinfo=timezone.utc)
            api = fake.FakeApi(now)
            meta = run.build(api, fake.FakeClaude(), out_dir=out, state_dir=Path(d) / "state", now=now, demo=True, stats_calls=50)
            pred = json.loads((out / "predictions.json").read_text())
            self.assertTrue(meta["demo"])
            self.assertGreater(len(pred["matches"]), 5)
            tabs = {t for m in pred["matches"] for t in m["tabs"]}
            self.assertTrue({"weekend", "nations_league", "interesting"} <= tabs)
            for m in pred["matches"]:
                f = m["final"]
                self.assertAlmostEqual(f["p_home"] + f["p_draw"] + f["p_away"], 1.0, delta=0.01)
                if m["analyst"]:  # analyst may only nudge by the clamp
                    self.assertLessEqual(abs(m["analyst"]["xg_mult_home"] - 1), 0.15 + 1e-9)
                self.assertGreaterEqual(m["kickoff"], now.isoformat())
            # second run is stable and keeps cached analyses (no re-analysis of fresh matches)
            meta2 = run.build(api, fake.FakeClaude(), out_dir=out, state_dir=Path(d) / "state", now=now, demo=True, stats_calls=50)
            self.assertEqual(meta2["analyst"]["matches_analysed_this_run"], 0)
            hist = json.loads((Path(d) / "state" / "history.json").read_text())
            self.assertTrue(all(e["pred"]["score"] for e in hist.values()))


class AnalystFlowTests(unittest.TestCase):
    def _client(self, responses):
        from types import SimpleNamespace as NS
        it = iter(responses)

        def create(**kw):
            return next(it)
        return NS(beta=NS(messages=NS(create=create)), messages=NS(create=create))

    def _resp(self, stop, text=""):
        from types import SimpleNamespace as NS
        return NS(stop_reason=stop, content=[NS(type="text", text=text)], usage=None)

    def test_pause_turn_is_resumed(self):
        good = json.dumps({"xg_mult_home": 1.02, "xg_mult_away": 0.98, "summary": "ok", "key_factors": [], "absences": [],
                           "lineups_confirmed": False, "data_gaps": []})
        c = self._client([self._resp("pause_turn"), self._resp("end_turn", good)])
        out = analyst.analyse_match(c, analyst.Usage(), {"match": {}}, "2026-11-11")
        self.assertEqual(out["summary"], "ok")

    def test_refusal_and_truncation_raise(self):
        for stop in ("refusal", "max_tokens"):
            c = self._client([self._resp(stop)])
            with self.assertRaises(RuntimeError):
                analyst.analyse_match(c, analyst.Usage(), {"match": {}}, "2026-11-11")

    def test_failures_do_not_sink_the_batch(self):
        c = self._client([self._resp("end_turn", "not json at all")])
        res = analyst.analyse_many(c, analyst.Usage(), [(1, {"match": {}})], "2026-11-11")
        self.assertIsInstance(res[1], str)


if __name__ == "__main__":
    unittest.main()
