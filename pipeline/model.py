"""Statistical core: time-weighted, ridge-shrunk Poisson strengths + Dixon-Coles scoreline matrix.

No third-party dependencies. The same model is used for clubs and national teams
(fitted separately). Every number it produces is reproducible from the match list,
which is what makes the analyst layer auditable: the analyst may only nudge the
expected goals by a bounded factor, it never invents probabilities.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import config


@dataclass
class Row:
    """One historical match as seen by the fitter."""
    home: int
    away: int
    yh: float          # (blended) goals/xG of home team
    ya: float
    w: float           # time + competition weight
    comp: int          # competition id
    neutral: bool = False


@dataclass
class Strengths:
    att: dict[int, float] = field(default_factory=dict)
    dfn: dict[int, float] = field(default_factory=dict)
    n_eff: dict[int, float] = field(default_factory=dict)   # sum of weights per team
    n_games: dict[int, int] = field(default_factory=dict)
    mu: dict[int, float] = field(default_factory=dict)      # per competition log-baseline
    mu_default: float = 0.2
    home_adv: float = 0.25

    def lam(self, home: int, away: int, comp: int, neutral: bool = False) -> tuple[float, float]:
        mu = self.mu.get(comp, self.mu_default)
        ha = 0.0 if neutral else self.home_adv
        lh = math.exp(mu + ha + self.att.get(home, 0.0) - self.dfn.get(away, 0.0))
        la = math.exp(mu + self.att.get(away, 0.0) - self.dfn.get(home, 0.0))
        return lh, la


def time_weight(match_date: datetime, as_of: datetime, half_life_days: float) -> float:
    age = max((as_of - match_date).total_seconds() / 86400.0, 0.0)
    return 0.5 ** (age / half_life_days)


def fit(rows: list[Row], ridge: float = config.RIDGE, sweeps: int = 60) -> Strengths:
    """Coordinate-wise Newton ascent on the penalised weighted Poisson likelihood."""
    s = Strengths()
    if not rows:
        return s
    teams = {r.home for r in rows} | {r.away for r in rows}
    comps = {r.comp for r in rows}
    s.att = {t: 0.0 for t in teams}
    s.dfn = {t: 0.0 for t in teams}
    total_w = sum(r.w for r in rows)
    total_y = sum(r.w * (r.yh + r.ya) for r in rows)
    mean_goals = max(total_y / (2 * total_w), 0.2) if total_w else 1.3
    s.mu = {c: math.log(mean_goals) for c in comps}
    s.mu_default = math.log(mean_goals)
    s.home_adv = 0.2
    for r in rows:
        for t in (r.home, r.away):
            s.n_eff[t] = s.n_eff.get(t, 0.0) + r.w
            s.n_games[t] = s.n_games.get(t, 0) + 1

    by_home: dict[int, list[Row]] = {t: [] for t in teams}
    by_away: dict[int, list[Row]] = {t: [] for t in teams}
    for r in rows:
        by_home[r.home].append(r)
        by_away[r.away].append(r)

    def rates(r: Row) -> tuple[float, float]:
        return s.lam(r.home, r.away, r.comp, r.neutral)

    for _ in range(sweeps):
        # attack
        for t in teams:
            g = -ridge * s.att[t]
            h = ridge
            for r in by_home[t]:
                lh, _ = rates(r)
                g += r.w * (r.yh - lh)
                h += r.w * lh
            for r in by_away[t]:
                _, la = rates(r)
                g += r.w * (r.ya - la)
                h += r.w * la
            s.att[t] += max(-0.5, min(0.5, g / h))
        # defence (positive = strong, reduces opponents' scoring)
        for t in teams:
            g = -ridge * s.dfn[t]
            h = ridge
            for r in by_home[t]:        # t at home concedes ya
                _, la = rates(r)
                g += r.w * (la - r.ya)
                h += r.w * la
            for r in by_away[t]:        # t away concedes yh
                lh, _ = rates(r)
                g += r.w * (lh - r.yh)
                h += r.w * lh
            s.dfn[t] += max(-0.5, min(0.5, g / h))
        # competition baselines
        for c in comps:
            g = 0.0
            h = 1e-6
            for r in rows:
                if r.comp != c:
                    continue
                lh, la = rates(r)
                g += r.w * ((r.yh - lh) + (r.ya - la))
                h += r.w * (lh + la)
            s.mu[c] += max(-0.3, min(0.3, g / h))
        # home advantage
        g = 0.0
        h = 1e-6
        for r in rows:
            if r.neutral:
                continue
            lh, _ = rates(r)
            g += r.w * (r.yh - lh)
            h += r.w * lh
        s.home_adv += max(-0.3, min(0.3, g / h))
    # centre attack/defence so that mu keeps its meaning (league-average team == 0)
    ma = sum(s.att.values()) / len(s.att)
    md = sum(s.dfn.values()) / len(s.dfn)
    for t in teams:
        s.att[t] -= ma
        s.dfn[t] -= md
    shift = ma - md
    for c in comps:
        s.mu[c] += shift
    s.mu_default += shift
    return s


# ---------------------------------------------------------------------------
# Scoreline distribution
# ---------------------------------------------------------------------------

def _poisson_pmf(lam: float, kmax: int) -> list[float]:
    p = [math.exp(-lam)]
    for k in range(1, kmax + 1):
        p.append(p[-1] * lam / k)
    return p


def _tau(i: int, j: int, lh: float, la: float, rho: float) -> float:
    if i == 0 and j == 0:
        return 1.0 - lh * la * rho
    if i == 0 and j == 1:
        return 1.0 + lh * rho
    if i == 1 and j == 0:
        return 1.0 + la * rho
    if i == 1 and j == 1:
        return 1.0 - rho
    return 1.0


def score_matrix(lh: float, la: float, rho: float = config.DC_RHO, kmax: int = config.MAX_GOALS) -> list[list[float]]:
    ph = _poisson_pmf(lh, kmax)
    pa = _poisson_pmf(la, kmax)
    m = [[ph[i] * pa[j] * max(_tau(i, j, lh, la, rho), 0.0) for j in range(kmax + 1)] for i in range(kmax + 1)]
    total = sum(sum(row) for row in m)
    return [[v / total for v in row] for row in m]


def summarize(lh: float, la: float, n_min: float = 10.0) -> dict:
    """Turn expected goals into the numbers the UI shows."""
    m = score_matrix(lh, la)
    k = len(m)
    ph = sum(m[i][j] for i in range(k) for j in range(k) if i > j)
    pd = sum(m[i][i] for i in range(k))
    pa = sum(m[i][j] for i in range(k) for j in range(k) if i < j)
    over25 = sum(m[i][j] for i in range(k) for j in range(k) if i + j >= 3)
    btts = sum(m[i][j] for i in range(1, k) for j in range(1, k))
    cells = sorted(((m[i][j], i, j) for i in range(k) for j in range(k)), reverse=True)
    top = [{"score": f"{i}-{j}", "p": round(p, 4)} for p, i, j in cells[:3]]
    best = cells[0]
    maxp = max(ph, pd, pa)
    if n_min < 4 or maxp < 0.42:
        conf = "low"
    elif maxp >= 0.6 and n_min >= 8:
        conf = "high"
    else:
        conf = "medium"
    return {
        "xg_home": round(lh, 3), "xg_away": round(la, 3),
        "p_home": round(ph, 4), "p_draw": round(pd, 4), "p_away": round(pa, 4),
        "p_over25": round(over25, 4), "p_btts": round(btts, 4),
        "score": f"{best[1]}-{best[2]}", "top_scores": top,
        "pick": "1" if ph >= max(pd, pa) else ("X" if pd >= pa else "2"),
        "confidence": conf,
    }


def predict(strengths: Strengths, home: int, away: int, comp: int, neutral: bool = False,
            mult_home: float = 1.0, mult_away: float = 1.0) -> dict:
    lh, la = strengths.lam(home, away, comp, neutral)
    lh *= mult_home
    la *= mult_away
    n_min = min(strengths.n_eff.get(home, 0.0), strengths.n_eff.get(away, 0.0))
    out = summarize(lh, la, n_min)
    out["n_eff_home"] = round(strengths.n_eff.get(home, 0.0), 1)
    out["n_eff_away"] = round(strengths.n_eff.get(away, 0.0), 1)
    return out


# ---------------------------------------------------------------------------
# Market helpers
# ---------------------------------------------------------------------------

def implied_probs(odd_home: float, odd_draw: float, odd_away: float) -> dict:
    """Remove the bookmaker margin proportionally."""
    raw = [1.0 / odd_home, 1.0 / odd_draw, 1.0 / odd_away]
    total = sum(raw)
    return {"home": raw[0] / total, "draw": raw[1] / total, "away": raw[2] / total, "margin": total - 1.0}


def brier(p: tuple[float, float, float], outcome: int) -> float:
    """Multi-class Brier score. outcome: 0 home, 1 draw, 2 away."""
    return sum((p[k] - (1.0 if k == outcome else 0.0)) ** 2 for k in range(3))


def log_loss(p: tuple[float, float, float], outcome: int) -> float:
    return -math.log(max(p[outcome], 1e-9))


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
