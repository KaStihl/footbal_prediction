"""Central configuration. Everything tunable lives here or in environment variables."""
from __future__ import annotations

import os
from datetime import date

TZ = "Europe/Bratislava"

# ---------------------------------------------------------------------------
# API-Football league ids: https://www.api-football.com/documentation-v3#tag/Leagues
# `seasons` use API-Football's convention (start year of the season). They are
# *verified* by `python -m pipeline doctor` against the live API, because the
# labelling of qualifier/tournament seasons is not guaranteed.
# `watch` = we also list upcoming fixtures of this competition.
# `fit_weight` = how much matches of this competition count when fitting strengths.
# ---------------------------------------------------------------------------


def current_club_season(today: date | None = None) -> int:
    today = today or date.today()
    return today.year if today.month >= 7 else today.year - 1


def _club(id_: int, name: str, country: str, *, watch: bool = True, weight: float = 3.0, fit_weight: float = 1.0):
    s = current_club_season()
    return {
        "id": id_, "name": name, "country": country, "family": "club",
        "watch": watch, "weight": weight, "fit_weight": fit_weight,
        "seasons": [s - 1, s],
    }


COMPETITIONS: dict[str, dict] = {
    "premier_league": _club(39, "Premier League", "England", weight=3.0),
    "bundesliga": _club(78, "Bundesliga", "Germany", weight=3.0),
    "la_liga": _club(140, "La Liga", "Spain", weight=2.2),
    "serie_a": _club(135, "Serie A", "Italy", weight=2.2),
    "ligue_1": _club(61, "Ligue 1", "France", weight=2.0),
    "champions_league": _club(2, "UEFA Champions League", "Europe", weight=3.0),
    "europa_league": _club(3, "UEFA Europa League", "Europe", weight=2.0),
    # --- national teams -----------------------------------------------------
    "nations_league": {
        "id": 5, "name": "UEFA Nations League", "country": "Europe", "family": "national",
        "watch": True, "weight": 3.0, "fit_weight": 1.0, "seasons": [2024, 2026],
    },
    "wc_qual_europe": {
        "id": 32, "name": "World Cup Qualification Europe", "country": "Europe", "family": "national",
        "watch": False, "weight": 1.0, "fit_weight": 1.0, "seasons": [2024],
    },
    "euro": {
        "id": 4, "name": "European Championship", "country": "Europe", "family": "national",
        "watch": False, "weight": 1.0, "fit_weight": 1.2, "seasons": [2024],
    },
    "world_cup": {
        "id": 1, "name": "World Cup", "country": "World", "family": "national",
        "watch": False, "weight": 1.0, "fit_weight": 1.2, "seasons": [2026],
    },
    "friendlies": {
        "id": 10, "name": "Friendlies", "country": "World", "family": "national",
        "watch": False, "weight": 0.5, "fit_weight": 0.5, "seasons": [2025, 2026],
    },
}

# Tournaments played at neutral venues (no home advantage).
NEUTRAL_LEAGUE_IDS = {1, 4}

WEEKEND_COMPETITIONS = ("premier_league", "bundesliga")
NATIONS_LEAGUE = "nations_league"

# Model hyper-parameters ------------------------------------------------------
HALF_LIFE_DAYS = {"club": 200.0, "national": 400.0}
RIDGE = 3.0               # shrinkage of attack/defence towards league average
DC_RHO = -0.08            # Dixon-Coles low-score correlation
MAX_GOALS = 8
XG_BLEND = 0.5            # weight of real goals when xG/shot-proxy is available
ANALYST_MAX_ADJ = 0.15    # analyst may move expected goals by at most +-15 %
VALUE_EDGE = 0.06         # model-vs-market probability gap flagged as "value"

# Horizon ---------------------------------------------------------------------
FIXTURE_WINDOW_DAYS = 14   # upcoming fixtures to list
ODDS_WINDOW_DAYS = 4       # fetch odds only this close to kickoff
INTERESTING_PER_DAY = 6


def env(name: str, default: str = "") -> str:
    return os.environ.get(name) or default  # empty string (unset GitHub variable) -> default


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


# Runtime knobs (set as repo variables / secrets in GitHub Actions) ----------
API_KEY = lambda: env("API_FOOTBALL_KEY")                       # noqa: E731
API_RPM = lambda: env_int("API_FOOTBALL_RPM", 10)               # free plan = 10/min  # noqa: E731
API_MAX_CALLS = lambda: env_int("API_FOOTBALL_MAX_CALLS", 90)   # free plan = 100/day  # noqa: E731
ODDS_BOOKMAKER = lambda: env_int("ODDS_BOOKMAKER", 8)           # 8 = Bet365  # noqa: E731
ANALYST_MODEL = lambda: env("ANALYST_MODEL", "claude-opus-5-5")  # noqa: E731
ANALYST_EFFORT = lambda: env("ANALYST_EFFORT", "medium")        # noqa: E731
ANALYST_MAX_MATCHES = lambda: env_int("ANALYST_MAX_MATCHES", 16)  # noqa: E731
ANALYST_WINDOW_HOURS = lambda: env_int("ANALYST_WINDOW_HOURS", 96)  # noqa: E731
ANALYST_MAX_AGE_HOURS = lambda: env_int("ANALYST_MAX_AGE_HOURS", 20)  # noqa: E731
ANALYST_PARALLEL = lambda: env_int("ANALYST_PARALLEL", 4)       # noqa: E731
ANALYST_ALLOWED_DOMAINS = lambda: [d.strip() for d in env("ANALYST_ALLOWED_DOMAINS").split(",") if d.strip()]  # noqa: E731
