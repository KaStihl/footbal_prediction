// Central configuration for the Cloudflare pipeline (port of pipeline/config.py).

export const TZ = "Europe/Bratislava";

export function currentClubSeason(now = new Date()) {
  return now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// API-Football league ids. `seasons` follow API-Football's convention (start year).
export function competitions(now = new Date()) {
  const s = currentClubSeason(now);
  const club = (id, name, country, weight) => ({ id, name, country, family: "club", watch: true, weight, fitWeight: 1.0, seasons: [s - 1, s] });
  return {
    premier_league: club(39, "Premier League", "England", 3.0),
    bundesliga: club(78, "Bundesliga", "Germany", 3.0),
    la_liga: club(140, "La Liga", "Spain", 2.2),
    serie_a: club(135, "Serie A", "Italy", 2.2),
    ligue_1: club(61, "Ligue 1", "France", 2.0),
    champions_league: club(2, "UEFA Champions League", "Europe", 3.0),
    europa_league: club(3, "UEFA Europa League", "Europe", 2.0),
    nations_league: { id: 5, name: "UEFA Nations League", country: "Europe", family: "national", watch: true, weight: 3.0, fitWeight: 1.0, seasons: [2024, 2026] },
    wc_qual_europe: { id: 32, name: "World Cup Qualification Europe", country: "Europe", family: "national", watch: false, weight: 1.0, fitWeight: 1.0, seasons: [2024] },
    euro: { id: 4, name: "European Championship", country: "Europe", family: "national", watch: false, weight: 1.0, fitWeight: 1.2, seasons: [2024] },
    world_cup: { id: 1, name: "World Cup", country: "World", family: "national", watch: false, weight: 1.0, fitWeight: 1.2, seasons: [2026] },
    friendlies: { id: 10, name: "Friendlies", country: "World", family: "national", watch: false, weight: 0.5, fitWeight: 0.5, seasons: [2025, 2026] },
  };
}

export const NEUTRAL_LEAGUE_IDS = new Set([1, 4]);
export const WEEKEND_COMPETITIONS = ["premier_league", "bundesliga"];
export const NATIONS_LEAGUE = "nations_league";
export const INJURY_COMPETITIONS = new Set(["premier_league", "bundesliga", "la_liga", "serie_a", "ligue_1", "champions_league", "europa_league"]);

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
    statsMaxCalls: int("STATS_MAX_CALLS", 8),
    oddsBookmaker: int("ODDS_BOOKMAKER", 8),
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    analystModel: str("ANALYST_MODEL", "claude-opus-5-5"),
    analystEffort: str("ANALYST_EFFORT", "medium"),
    analystMaxMatches: int("ANALYST_MAX_MATCHES", 16),
    analystWindowHours: int("ANALYST_WINDOW_HOURS", 96),
    analystMaxAgeHours: int("ANALYST_MAX_AGE_HOURS", 20),
    analystAllowedDomains: str("ANALYST_ALLOWED_DOMAINS", "").split(",").map((d) => d.trim()).filter(Boolean),
    // manually added matches: API-Football fixture ids, comma separated (shown in "Zaujímavé")
    extraFixtureIds: str("EXTRA_FIXTURE_IDS", "").split(",").map((x) => parseInt(x, 10)).filter(Number.isFinite).slice(0, 20),
  };
}
