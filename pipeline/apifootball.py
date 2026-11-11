"""Thin API-Football (v3) client: disk cache, rate limiting, call budget.

Docs: https://www.api-football.com/documentation-v3
Auth: header `x-apisports-key`.
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://v3.football.api-sports.io"


class ApiError(RuntimeError):
    """The API answered, but with an `errors` payload (bad params, plan limits, ...)."""


class PlanError(ApiError):
    """The subscription plan does not allow this request (e.g. season not covered)."""


class BudgetExceeded(RuntimeError):
    """The per-run request budget is used up."""


class ApiFootball:
    def __init__(self, key: str, cache_dir: Path, rpm: int = 10, max_calls: int = 90):
        if not key:
            raise ValueError("API_FOOTBALL_KEY is not set")
        self.key = key
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.min_interval = 60.0 / max(rpm, 1)
        self.max_calls = max_calls
        self.calls = 0
        self.cache_hits = 0
        self._last_call = 0.0
        self.remaining_daily: int | None = None
        self.daily_reserve = 3   # leave a few requests for manual `doctor` / `find-team`

    # -- low level -----------------------------------------------------------
    def _cache_path(self, path: str, params: dict) -> Path:
        raw = path + "?" + urllib.parse.urlencode(sorted(params.items()))
        return self.cache_dir / (hashlib.sha1(raw.encode()).hexdigest() + ".json")

    def _http(self, path: str, params: dict) -> dict:
        url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"x-apisports-key": self.key, "Accept": "application/json"})
        for attempt in range(4):
            wait = self.min_interval - (time.monotonic() - self._last_call)
            if wait > 0:
                time.sleep(wait)
            self._last_call = time.monotonic()
            try:
                with urllib.request.urlopen(req, timeout=40) as resp:
                    rem = resp.headers.get("x-ratelimit-requests-remaining")
                    if rem is not None and rem.isdigit():
                        self.remaining_daily = int(rem)
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                    time.sleep(2 ** (attempt + 1) * 2)
                    continue
                raise ApiError(f"HTTP {e.code} for {path}") from e
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt < 3:
                    time.sleep(2 ** (attempt + 1))
                    continue
                raise ApiError(f"network error for {path}: {e}") from e
        raise ApiError(f"giving up on {path}")

    @staticmethod
    def _check_errors(payload: dict, path: str) -> None:
        errors = payload.get("errors")
        if not errors:
            return
        text = json.dumps(errors, ensure_ascii=False)
        if isinstance(errors, dict) and ("plan" in errors or "access" in errors or "requests" in errors):
            raise PlanError(f"{path}: {text}")
        raise ApiError(f"{path}: {text}")

    def get(self, path: str, params: dict, ttl: float = 3600.0) -> list:
        """Return `response` list; use cached copy younger than `ttl` seconds."""
        cp = self._cache_path(path, params)
        if cp.exists():
            try:
                cached = json.loads(cp.read_text())
                if time.time() - cached["fetched_at"] < ttl:
                    self.cache_hits += 1
                    return cached["response"]
            except (ValueError, KeyError):
                pass
        if self.calls >= self.max_calls:
            raise BudgetExceeded(f"request budget {self.max_calls} reached at {path}")
        if self.remaining_daily is not None and self.remaining_daily <= self.daily_reserve:
            raise BudgetExceeded(f"daily API quota nearly used up ({self.remaining_daily} left) at {path}")
        self.calls += 1
        payload = self._http(path, params)
        self._check_errors(payload, path)
        response = payload.get("response", [])
        paging = payload.get("paging") or {}
        total = int(paging.get("total", 1) or 1)
        if total > 1:  # follow pagination (odds endpoints)
            for page in range(2, total + 1):
                if self.calls >= self.max_calls:
                    break
                self.calls += 1
                more = self._http(path, {**params, "page": page})
                self._check_errors(more, path)
                response = response + more.get("response", [])
        cp.write_text(json.dumps({"fetched_at": time.time(), "response": response}))
        return response

    # -- endpoints -----------------------------------------------------------
    def league_fixtures(self, league: int, season: int, ttl: float) -> list:
        return self.get("/fixtures", {"league": league, "season": season, "timezone": "UTC"}, ttl)

    def fixture_details(self, ids: list[int]) -> list:
        """Up to 20 fixtures per call, including statistics (immutable once finished)."""
        return self.get("/fixtures", {"ids": "-".join(str(i) for i in ids[:20])}, ttl=10 * 365 * 86400)

    def injuries(self, league: int, season: int, date: str) -> list:
        return self.get("/injuries", {"league": league, "season": season, "date": date}, ttl=6 * 3600)

    def odds(self, fixture: int, bookmaker: int) -> list:
        return self.get("/odds", {"fixture": fixture, "bookmaker": bookmaker}, ttl=3 * 3600)

    def leagues(self, league_id: int) -> list:
        return self.get("/leagues", {"id": league_id}, ttl=86400)

    def teams_search(self, name: str) -> list:
        return self.get("/teams", {"search": name}, ttl=30 * 86400)

    def fixture_by_id(self, fixture_id: int) -> list:
        return self.get("/fixtures", {"id": fixture_id, "timezone": "UTC"}, ttl=3600)
