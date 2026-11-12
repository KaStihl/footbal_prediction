// Data sources, tried in order (see runner.js):
//   1. ESPN public JSON (no key, unofficial): fixtures, results, team stats, DraftKings odds - per month
//   2. football-data.org (free key): fixtures + results of the big club competitions - per season
//   3. API-Football (key; the free plan only serves seasons up to 2024) - per season
// Every adapter returns the same shape: { rows, names, stats, odds, groups }.
//   row   = [id, t(ms), status, homeKey, awayKey, hg, ag, compKey, season, round]
//   teams are identified by a normalised name key so the sources can be mixed.

import { ApiError, apiGet } from "./api.js";

export const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
export const FD_BASE = "https://api.football-data.org/v4";

// ---- team identity ---------------------------------------------------------

const ALIASES = {
  "bayern munich": "bayern munchen", "fc bayern munchen": "bayern munchen",
  "inter milan": "inter", "internazionale milano": "inter", "fc internazionale milano": "inter",
  "ac milan": "milan", "paris saint germain": "paris saint germain", "psg": "paris saint germain",
  "atletico madrid": "atletico madrid", "club atletico de madrid": "atletico madrid",
  "manchester united": "manchester united", "man united": "manchester united",
  "tottenham hotspur": "tottenham", "wolverhampton wanderers": "wolves", "brighton hove albion": "brighton",
  "west ham united": "west ham", "newcastle united": "newcastle", "nottingham forest": "nottingham",
  "borussia monchengladbach": "monchengladbach", "bayer 04 leverkusen": "bayer leverkusen",
  "turkiye": "turkey", "czechia": "czech republic", "republic of ireland": "ireland",
};
const DROP = new Set(["fc", "afc", "cf", "sc", "ssc", "as", "club", "calcio", "cfc"]);

export function teamKey(name) {
  let s = String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/ß/g, "ss").replace(/&/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (ALIASES[s]) return ALIASES[s];
  s = s.split(" ").filter((w) => !DROP.has(w)).join(" ") || s;
  return ALIASES[s] || s;
}

// ---- helpers -----------------------------------------------------------------

export function americanToDecimal(a) {
  const x = typeof a === "string" ? parseFloat(a.replace("+", "")) : Number(a);
  if (!Number.isFinite(x) || x === 0) return null;
  return Math.round((x > 0 ? 1 + x / 100 : 1 + 100 / -x) * 1000) / 1000;
}

function espnStatus(st) {
  const t = (st && st.type) || {};
  const name = t.name || "";
  if (t.completed) return "FT";
  if (/POSTPONED/.test(name)) return "PST";
  if (/CANCELED|CANCELLED|ABANDONED/.test(name)) return "CANC";
  if (t.state === "in") return "LIVE";
  return "NS";
}

const num = (v) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : null;
};

async function getJson(fetchImpl, url, headers = {}) {
  let resp;
  try {
    resp = await fetchImpl(url, { headers: { Accept: "application/json", ...headers } });
  } catch (e) {
    throw new ApiError(`network error: ${e.message}`);
  }
  if (!resp.ok) throw new ApiError(`HTTP ${resp.status}`);
  return resp.json();
}

// ---- 1) ESPN -------------------------------------------------------------------

/** One month (YYYYMM) of one competition. */
export async function fetchEspnMonth(fetchImpl, slug, compKey, ym) {
  const d = await getJson(fetchImpl, `${ESPN_BASE}/${slug}/scoreboard?dates=${ym}`);
  const out = { rows: [], names: {}, stats: {}, odds: {}, groups: {} };
  for (const e of d.events || []) {
    const c = (e.competitions || [])[0];
    if (!c) continue;
    const home = (c.competitors || []).find((x) => x.homeAway === "home");
    const away = (c.competitors || []).find((x) => x.homeAway === "away");
    if (!home || !away) continue;
    const hk = teamKey(home.team.displayName), ak = teamKey(away.team.displayName);
    out.names[hk] = home.team.displayName;
    out.names[ak] = away.team.displayName;
    const status = espnStatus(e.status || c.status);
    const id = Number(e.id);
    const season = (e.season && e.season.year) || null;
    out.rows.push([id, Date.parse(e.date), status, hk, ak, status === "FT" ? num(home.score) : null, status === "FT" ? num(away.score) : null, compKey, season, ""]);
    if (c.altGameNote) out.groups[id] = String(c.altGameNote).replace(/^UEFA Nations League,\s*/i, "");
    if (status === "FT") {
      const st = (t) => Object.fromEntries((t.statistics || []).map((s) => [s.name, num(s.displayValue)]));
      const hs = st(home), as = st(away);
      if (hs.totalShots != null || hs.possessionPct != null) {
        out.stats[id] = [null, hs.shotsOnTarget ?? null, hs.totalShots ?? null, hs.possessionPct ?? null, null, as.shotsOnTarget ?? null, as.totalShots ?? null, as.possessionPct ?? null];
      }
    } else if (status === "NS") {
      const o = (c.odds || []).find((x) => x && x.moneyline);
      if (o) {
        const ml = o.moneyline;
        const h = americanToDecimal(ml.home && (ml.home.close || ml.home.open || {}).odds);
        const dr = americanToDecimal(ml.draw && (ml.draw.close || ml.draw.open || {}).odds);
        const a = americanToDecimal(ml.away && (ml.away.close || ml.away.open || {}).odds);
        if (h && dr && a) {
          const tot = o.total || {};
          out.odds[id] = {
            bookmaker: `${(o.provider && o.provider.name) || "bookmaker"} (cez ESPN)`, home: h, draw: dr, away: a,
            ou_line: num(o.overUnder),
            over: americanToDecimal(tot.over && (tot.over.close || tot.over.open || {}).odds),
            under: americanToDecimal(tot.under && (tot.under.close || tot.under.open || {}).odds),
          };
        }
      }
    }
  }
  return out;
}

// ---- 2) football-data.org ------------------------------------------------------

const FD_STATUS = { FINISHED: "FT", AWARDED: "FT", SCHEDULED: "NS", TIMED: "NS", IN_PLAY: "LIVE", PAUSED: "LIVE", POSTPONED: "PST", SUSPENDED: "PST", CANCELLED: "CANC" };

export async function fetchFootballData(fetchImpl, key, code, compKey, season) {
  if (!key) throw new ApiError("FOOTBALL_DATA_KEY nie je nastavený");
  const d = await getJson(fetchImpl, `${FD_BASE}/competitions/${code}/matches?season=${season}`, { "X-Auth-Token": key });
  const out = { rows: [], names: {}, stats: {}, odds: {}, groups: {} };
  for (const m of d.matches || []) {
    const hn = m.homeTeam && (m.homeTeam.shortName || m.homeTeam.name), an = m.awayTeam && (m.awayTeam.shortName || m.awayTeam.name);
    if (!hn || !an) continue;
    const hk = teamKey(m.homeTeam.name), ak = teamKey(m.awayTeam.name);
    out.names[hk] = hn; out.names[ak] = an;
    const status = FD_STATUS[m.status] || "NS";
    const ft = (m.score && m.score.fullTime) || {};
    out.rows.push([m.id, Date.parse(m.utcDate), status, hk, ak, status === "FT" ? ft.home : null, status === "FT" ? ft.away : null, compKey, season, m.matchday ? `Kolo ${m.matchday}` : ""]);
  }
  return out;
}

// ---- 3) API-Football -------------------------------------------------------------

export async function fetchApiFootball(fetchImpl, key, base, leagueId, compKey, season) {
  const { response, remaining } = await apiGet(key, "/fixtures", { league: leagueId, season, timezone: "UTC" }, fetchImpl, base);
  const out = { rows: [], names: {}, stats: {}, odds: {}, groups: {}, remaining };
  const FIN = new Set(["FT", "AET", "PEN"]);
  for (const fx of response) {
    const hk = teamKey(fx.teams.home.name), ak = teamKey(fx.teams.away.name);
    out.names[hk] = fx.teams.home.name; out.names[ak] = fx.teams.away.name;
    const s = (fx.fixture.status || {}).short || "NS";
    const status = FIN.has(s) ? "FT" : s === "TBD" ? "NS" : s;
    out.rows.push([fx.fixture.id, Date.parse(fx.fixture.date), status, hk, ak, status === "FT" ? fx.goals.home : null, status === "FT" ? fx.goals.away : null, compKey, season, fx.league.round || ""]);
  }
  return out;
}
