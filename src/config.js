// Central configuration for the Cloudflare pipeline (port of pipeline/config.py).

export const TZ = "Europe/Bratislava";

export function currentClubSeason(now = new Date()) {
  return now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// Competitions and where to get them. Keys are used everywhere as the competition id.
//   espn: ESPN slug, fd: football-data.org code (free tier), af: API-Football league id
//   months: ESPN months to load, relative to now: [back, forward]; or fixed: list of YYYYMM
//   seasons: seasons for the per-season fallback sources (start year of the season)
export function competitions(now = new Date()) {
  const s = currentClubSeason(now);
  const club = (name, espn, fd, af, weight) => ({ name, espn, fd, af, family: "club", watch: true, weight, fitWeight: 1.0, months: [15, 2], seasons: [s - 1, s] });
  const nat = (name, espn, fd, af, o) => ({ name, espn, fd, af, family: "national", ...o });
  return {
    premier_league: club("Premier League", "eng.1", "PL", 39, 3.0),
    bundesliga: club("Bundesliga", "ger.1", "BL1", 78, 3.0),
    la_liga: club("La Liga", "esp.1", "PD", 140, 2.2),
    serie_a: club("Serie A", "ita.1", "SA", 135, 2.2),
    ligue_1: club("Ligue 1", "fra.1", "FL1", 61, 2.0),
    champions_league: club("UEFA Champions League", "uefa.champions", "CL", 2, 3.0),
    europa_league: club("UEFA Europa League", "uefa.europa", null, 3, 2.0),
    nations_league: nat("UEFA Nations League", "uefa.nations", null, 5, { watch: true, weight: 3.0, fitWeight: 1.0, months: [30, 6], seasons: [2024, 2026] }),
    wc_qual_europe: nat("World Cup Qualification Europe", "fifa.worldq.uefa", null, 32, { watch: false, weight: 1.0, fitWeight: 1.0, months: [30, 0], seasons: [2024] }),
    euro: nat("European Championship", "uefa.euro", "EC", 4, { watch: false, weight: 1.0, fitWeight: 1.2, fixed: ["202406", "202407"], seasons: [2024], neutral: true }),
    world_cup: nat("World Cup", "fifa.world", "WC", 1, { watch: false, weight: 1.0, fitWeight: 1.2, fixed: ["202606", "202607"], seasons: [2026], neutral: true }),
    friendlies: nat("Friendlies", "fifa.friendly", null, 10, { watch: false, weight: 0.5, fitWeight: 0.5, months: [24, 1], seasons: [2025, 2026] }),
  };
}

/** YYYYMM strings to load from ESPN for a competition. */
export function espnMonths(comp, nowMs) {
  if (comp.fixed) return comp.fixed;
  const d = new Date(nowMs);
  const out = [];
  for (let k = -comp.months[0]; k <= comp.months[1]; k++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1));
    out.push(`${m.getUTCFullYear()}${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** Season (start year) a YYYYMM month belongs to. */
export function seasonOfMonth(ym) {
  const y = +ym.slice(0, 4), m = +ym.slice(4);
  return m >= 7 ? y : y - 1;
}

export const NEUTRAL_COMPETITIONS = new Set(["euro", "world_cup"]);
export const WEEKEND_COMPETITIONS = ["premier_league", "bundesliga"];
export const NATIONS_LEAGUE = "nations_league";

export const HALF_LIFE_DAYS = { club: 200, national: 400 };
export const RIDGE = 3.0;
export const DC_RHO = -0.08;
export const MAX_GOALS = 8;
export const XG_BLEND = 0.5;
export const ANALYST_MAX_ADJ = 0.15;

export const FIXTURE_WINDOW_DAYS = 14;
export const ODDS_WINDOW_DAYS = 4;
export const INTERESTING_PER_DAY = 6;
export const HISTORY_KEEP = 600;

export const DERBIES = [
  ["Arsenal", "Tottenham"], ["Liverpool", "Everton"], ["Liverpool", "Manchester United"],
  ["Manchester City", "Manchester United"], ["Arsenal", "Chelsea"], ["Chelsea", "Tottenham"],
  ["Newcastle", "Sunderland"], ["Bayern", "Dortmund"], ["Dortmund", "Schalke"], ["Hamburg", "Werder"],
  ["Real Madrid", "Barcelona"], ["Real Madrid", "Atletico"], ["AC Milan", "Inter"], ["Roma", "Lazio"],
  ["Juventus", "Inter"], ["Paris Saint Germain", "Marseille"],
];

// Runtime knobs: Worker variables / secrets (env). Empty strings fall back to defaults.
export function settings(env = {}) {
  const int = (k, d) => {
    const v = parseInt(env[k], 10);
    return Number.isFinite(v) ? v : d;
  };
  const str = (k, d) => (env[k] ? String(env[k]) : d);
  return {
    apiKey: env.API_FOOTBALL_KEY || "",
    apiBase: str("API_FOOTBALL_BASE", "https://v3.football.api-sports.io"), // override only for local testing
    anthropicBaseUrl: str("ANTHROPIC_BASE_URL", ""),                          // override only for local testing
    apiRpm: int("API_FOOTBALL_RPM", 10),
    apiMaxCalls: int("API_FOOTBALL_MAX_CALLS", 45),
    apiMaxSeason: int("API_FOOTBALL_MAX_SEASON", 2024), // free plan: seasons 2022-2024 only
    fdKey: env.FOOTBALL_DATA_KEY || "",
    espnMaxCalls: int("ESPN_MAX_CALLS", 400),
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    analystModel: str("ANALYST_MODEL", "claude-sonnet-5-5"),
    analystEffort: str("ANALYST_EFFORT", "medium"),
    analystMaxMatches: int("ANALYST_MAX_MATCHES", 16),
    analystWindowHours: int("ANALYST_WINDOW_HOURS", 96),
    analystMaxAgeHours: int("ANALYST_MAX_AGE_HOURS", 20),
    analystAllowedDomains: str("ANALYST_ALLOWED_DOMAINS", "").split(",").map((d) => d.trim()).filter(Boolean),
    // manually pinned matches: fixture ids from /api/find-fixtures, comma separated (shown in "Zaujímavé")
    extraFixtureIds: str("EXTRA_FIXTURE_IDS", "").split(",").map((x) => parseInt(x, 10)).filter(Number.isFinite).slice(0, 20),
  };
}
