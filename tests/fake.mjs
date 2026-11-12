// Synthetic API-Football + Claude fakes for tests (fictional teams, no real data).

const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function pois(r, lam) {
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  for (;;) { p *= r(); if (p <= L) return k; k++; }
}

export class FakeStorage {
  constructor() { this.m = new Map(); }
  async get(k) {
    if (Array.isArray(k)) return new Map(k.filter((x) => this.m.has(x)).map((x) => [x, structuredClone(this.m.get(x))]));
    return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined;
  }
  async put(k, v) { this.m.set(k, structuredClone(v)); }
  async delete(k) { this.m.delete(k); }
}

export function makeWorld(nowMs, { teamsPerLeague = 20, seed = 7, heavy = false } = {}) {
  const r = rng(seed);
  const truth = {};
  let tid = 1000, fid = 100000;
  const leagues = {}; // `${league}:${season}` -> fixtures
  const details = {};
  const curSeason = new Date(nowMs).getUTCMonth() + 1 >= 7 ? new Date(nowMs).getUTCFullYear() : new Date(nowMs).getUTCFullYear() - 1;
  const lam = (h, a, mu, ha) => [Math.exp(mu + ha + truth[h][0] - truth[a][1]), Math.exp(mu + truth[a][0] - truth[h][1])];
  const pad = heavy ? "x".repeat(2000) : "";
  function detail(id, h, a, lh, la, hg, ag) {
    const side = (l, g, t) => ({ team: { id: t }, statistics: [
      { type: "expected_goals", value: (l * (0.8 + 0.4 * r())).toFixed(2) }, { type: "Shots on Goal", value: Math.max(g, Math.round(l * 3)) },
      { type: "Total Shots", value: Math.round(l * 9) + 3 }, { type: "Ball Possession", value: `${45 + Math.round(10 * r())}%` }] });
    details[id] = { fixture: { id }, teams: { home: { id: h }, away: { id: a } }, statistics: [side(lh, hg, h), side(la, ag, a)],
      events: Array.from({ length: heavy ? 15 : 0 }, (_, i) => ({ minute: i, detail: pad.slice(0, 50) })),
      players: Array.from({ length: heavy ? 30 : 0 }, (_, i) => ({ id: i, stats: pad.slice(0, 600) })) };
  }
  function league(id, name, mu, playedRounds, names) {
    const ids = names.map((n) => { tid++; truth[tid] = [r() * 0.9 - 0.45, r() * 0.9 - 0.45]; return [tid, n]; });
    for (const season of [curSeason - 1, curSeason]) {
      const fx = [];
      const n = ids.length;
      const arr = ids.slice();
      const rounds = [];
      for (let k = 0; k < n - 1; k++) {
        const pairs = []; for (let i = 0; i < n / 2; i++) pairs.push([arr[i], arr[n - 1 - i]]);
        rounds.push(k % 2 ? pairs.map(([x, y]) => [y, x]) : pairs);
        arr.splice(1, 0, arr.pop());
      }
      const all = rounds.concat(rounds.map((p) => p.map(([x, y]) => [y, x])));
      const played = season < curSeason ? all.length : playedRounds;
      // next Saturday 15:30 UTC anchor for the current season
      const d = new Date(nowMs); const sat = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7) - (d.getUTCDay() === 6 ? 7 : 0), 15, 30);
      all.forEach((pairs, ri) => {
        const base = season < curSeason ? sat - (52 - ri) * 7 * 864e5 - 30 * 864e5 : sat + (ri - played) * 7 * 864e5;
        pairs.forEach(([[h, hn], [a, an]], pi) => {
          fid++;
          const ko = base + ((pi % 4) - 1) * 864e5 + (pi % 3) * 3 * 3600e3;
          const [lh, la] = lam(h, a, mu, 0.25);
          const done = ko < nowMs - 3 * 3600e3;
          const hg = done ? pois(r, lh) : null, ag = done ? pois(r, la) : null;
          if (done) detail(fid, h, a, lh, la, hg, ag);
          fx.push({ fixture: { id: fid, date: new Date(ko).toISOString(), status: { short: done ? "FT" : "NS" } },
            league: { id, name, season, round: `Regular Season - ${ri + 1}` }, teams: { home: { id: h, name: hn }, away: { id: a, name: an } },
            goals: { home: hg, away: ag } });
        });
      });
      leagues[`${id}:${season}`] = fx;
    }
  }
  const names = (p) => Array.from({ length: teamsPerLeague }, (_, i) => `${p} Team ${String.fromCharCode(65 + i)}`);
  league(39, "Premier League", 0.28, 12, names("Albion"));
  league(78, "Bundesliga", 0.38, 11, names("Borovia"));
  league(140, "La Liga", 0.25, 12, names("Cardena"));
  league(135, "Serie A", 0.25, 12, names("Dalmora"));
  league(61, "Ligue 1", 0.26, 12, names("Elbonia"));
  league(2, "UEFA Champions League", 0.35, 4, names("Fennick"));
  league(3, "UEFA Europa League", 0.3, 4, names("Gondor"));
  league(5, "UEFA Nations League", 0.15, 4, names("Nation").slice(0, 16));
  // national: 2026 season labels for NL
  for (const k of Object.keys(leagues)) if (k.startsWith("5:")) {
    const fx = leagues[k]; delete leagues[k];
    leagues[`5:${k.endsWith(String(curSeason)) ? 2026 : 2024}`] = fx.map((f) => ({ ...f, league: { ...f.league, season: k.endsWith(String(curSeason)) ? 2026 : 2024 } }));
  }
  let remaining = 7400;
  const limits = { rateLimitNext: 0, planBlockedSeasons: new Set(), espnDown: new Set(), fdDown: false };
  const calls = [];
  const SLUG = { "eng.1": 39, "ger.1": 78, "esp.1": 140, "ita.1": 135, "fra.1": 61, "uefa.champions": 2, "uefa.europa": 3, "uefa.nations": 5 };
  const FD = { PL: 39, BL1: 78, PD: 140, SA: 135, FL1: 61, CL: 2 };
  const allOf = (league) => Object.entries(leagues).filter(([k]) => k.startsWith(`${league}:`)).flatMap(([, v]) => v);
  const amer = (dec) => (dec >= 2 ? `+${Math.round((dec - 1) * 100)}` : `-${Math.round(100 / (dec - 1))}`);
  const reply = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers });

  function espnEvent(f) {
    const done = f.fixture.status.short === "FT";
    const det = details[f.fixture.id];
    const side = (homeAway, t, g, idx) => {
      const c = { homeAway, team: { displayName: t.name }, score: String(g ?? 0), statistics: [] };
      if (done && det) {
        const st = Object.fromEntries(det.statistics[idx].statistics.map((s) => [s.type, s.value]));
        c.statistics = [{ name: "totalShots", displayValue: String(st["Total Shots"]) }, { name: "shotsOnTarget", displayValue: String(st["Shots on Goal"]) },
          { name: "possessionPct", displayValue: String(st["Ball Possession"]).replace("%", "") }];
      }
      return c;
    };
    const comp = {
      competitors: [side("home", f.teams.home, f.goals.home, 0), side("away", f.teams.away, f.goals.away, 1)],
      altGameNote: f.league.id === 5 ? `UEFA Nations League, Group ${"ABCD"[f.fixture.id % 4]}1` : f.league.name,
      odds: done ? [null] : [{ provider: { name: "FakeBook" }, overUnder: 2.5,
        moneyline: { home: { close: { odds: amer(2.1) } }, draw: { close: { odds: amer(3.4) } }, away: { close: { odds: amer(3.6) } } } }],
    };
    return { id: String(f.fixture.id), date: f.fixture.date, season: { year: f.league.season },
      status: { type: { completed: done, state: done ? "post" : "pre", name: done ? "STATUS_FULL_TIME" : "STATUS_SCHEDULED" } }, competitions: [comp] };
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    calls.push(u.host + u.pathname + u.search);
    const p = Object.fromEntries(u.searchParams);
    if (u.host === "site.api.espn.com") {
      const slug = u.pathname.split("/")[6];
      if (limits.espnDown.has(slug)) return reply({ code: 500 }, 500);
      const league = SLUG[slug];
      const ym = p.dates;
      const events = league ? allOf(league).filter((f) => f.fixture.date.slice(0, 7).replace("-", "") === ym).map(espnEvent) : [];
      return reply({ events });
    }
    if (u.host === "api.football-data.org") {
      if (limits.fdDown) return reply({ message: "down" }, 503);
      const league = FD[u.pathname.split("/")[3]];
      const matches = (leagues[`${league}:${p.season}`] || []).map((f) => ({ id: f.fixture.id, utcDate: f.fixture.date,
        status: f.fixture.status.short === "FT" ? "FINISHED" : "TIMED", matchday: 1,
        homeTeam: { name: f.teams.home.name }, awayTeam: { name: f.teams.away.name }, score: { fullTime: { home: f.goals.home, away: f.goals.away } } }));
      return reply({ matches });
    }
    remaining--;
    const hdr = { "x-ratelimit-requests-remaining": String(remaining) };
    if (limits.rateLimitNext > 0) { limits.rateLimitNext--; return reply({ errors: { rateLimit: "Too many requests." }, response: [] }, 200, hdr); }
    if (p.season && limits.planBlockedSeasons.has(Number(p.season))) return reply({ errors: { plan: "Free plans do not have access to this season" }, response: [] }, 200, hdr);
    const response = u.pathname === "/fixtures" ? (leagues[`${p.league}:${p.season}`] || []) : [];
    return reply({ errors: [], response }, 200, hdr);
  }
  return { fetchImpl, calls, leagues, limits };
}

export function fakeClaude(counter = { n: 0 }) {
  const create = async (params) => {
    counter.n++;
    const user = params.messages[0].content;
    const usage = { input_tokens: 2000, output_tokens: 600, server_tool_use: { web_search_requests: 2 } };
    let payload;
    if (user.startsWith("Round:")) {
      payload = { overview: "[TEST] prehľad", top_picks: [], risks: ["[TEST]"] };
    } else {
      const d = JSON.parse(user.split("<dossier>\n")[1].split("\n</dossier>")[0]);
      payload = { xg_mult_home: 1.5, xg_mult_away: 0.97, summary: `[TEST] ${d.match.home}`, key_factors: [], absences: [
        { team: "home", player: "X", status: "out", source_url: "javascript:alert(1)", source_type: "club_official", confidence: "high" }],
        lineups_confirmed: false, data_gaps: [] };
    }
    return { stop_reason: "end_turn", usage, content: [{ type: "text", text: JSON.stringify(payload) }] };
  };
  return { beta: { messages: { create } }, messages: { create } };
}
