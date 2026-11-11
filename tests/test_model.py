import math
import random
import unittest
from datetime import datetime, timedelta, timezone

from pipeline import model


def synth(n_teams=12, seed=7, rounds=4):
    rnd = random.Random(seed)
    att = {t: rnd.uniform(-0.4, 0.4) for t in range(n_teams)}
    dfn = {t: rnd.uniform(-0.4, 0.4) for t in range(n_teams)}
    mu, ha = math.log(1.3), 0.25
    rows = []
    for _ in range(rounds):
        for h in range(n_teams):
            for a in range(n_teams):
                if h == a:
                    continue
                lh = math.exp(mu + ha + att[h] - dfn[a])
                la = math.exp(mu + att[a] - dfn[h])
                rows.append(model.Row(h, a, _pois(rnd, lh), _pois(rnd, la), 1.0, 39))
    return rows, att, dfn, ha


def _pois(rnd, lam):
    l, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rnd.random()
        if p <= l:
            return k
        k += 1


class ModelTests(unittest.TestCase):
    def test_fit_recovers_strength_ordering(self):
        rows, att, dfn, ha = synth(rounds=12)
        s = model.fit(rows)
        ts = sorted(att)
        true_net = [att[t] + dfn[t] for t in ts]
        fit_net = [s.att[t] + s.dfn[t] for t in ts]
        n = len(ts)
        mt, mf = sum(true_net) / n, sum(fit_net) / n
        cov = sum((a - mt) * (b - mf) for a, b in zip(true_net, fit_net))
        corr = cov / math.sqrt(sum((a - mt) ** 2 for a in true_net) * sum((b - mf) ** 2 for b in fit_net))
        self.assertGreater(corr, 0.9)
        self.assertAlmostEqual(s.home_adv, ha, delta=0.12)
        # predicted goal rates must match the generating process on average
        errs = []
        for h in att:
            for a in att:
                if h != a:
                    true = math.exp(math.log(1.3) + ha + att[h] - dfn[a])
                    errs.append(abs(s.lam(h, a, 39)[0] - true) / true)
        self.assertLess(sum(errs) / len(errs), 0.12)

    def test_probabilities_sum_to_one(self):
        out = model.summarize(1.6, 1.1)
        self.assertAlmostEqual(out["p_home"] + out["p_draw"] + out["p_away"], 1.0, places=2)
        self.assertGreater(out["p_home"], out["p_away"])
        self.assertEqual(out["pick"], "1")

    def test_equal_teams_symmetric(self):
        out = model.summarize(1.3, 1.3)
        self.assertAlmostEqual(out["p_home"], out["p_away"], places=3)

    def test_matrix_normalised(self):
        m = model.score_matrix(2.4, 0.7)
        self.assertAlmostEqual(sum(map(sum, m)), 1.0, places=9)

    def test_implied_probs_remove_margin(self):
        p = model.implied_probs(2.0, 3.5, 4.0)
        self.assertAlmostEqual(p["home"] + p["draw"] + p["away"], 1.0, places=9)
        self.assertGreater(p["margin"], 0)

    def test_time_weight_halves(self):
        now = datetime(2026, 11, 10, tzinfo=timezone.utc)
        self.assertAlmostEqual(model.time_weight(now - timedelta(days=100), now, 100), 0.5)

    def test_unknown_team_falls_back_to_average(self):
        rows, *_ = synth(n_teams=6, rounds=2)
        s = model.fit(rows)
        out = model.predict(s, 999, 1000, 39)
        self.assertEqual(out["confidence"], "low")


if __name__ == "__main__":
    unittest.main()
