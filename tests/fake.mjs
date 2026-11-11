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
  const calls = [];
  async function fetchImpl(url) {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    remaining--;
    const p = Object.fromEntries(u.searchParams);
    let response = [];
    if (u.pathname === "/fixtures" && p.id) response = Object.values(leagues).flat().filter((f) => f.fixture.id === Number(p.id));
    else if (u.pathname === "/fixtures" && p.ids) response = p.ids.split("-").map(Number).filter((i) => details[i]).map((i) => details[i]);
    else if (u.pathname === "/fixtures") response = leagues[`${p.league}:${p.season}`] || [];
    else if (u.pathname === "/odds") response = [{ bookmakers: [{ name: "FakeBook", bets: [{ id: 1, values: [{ value: "Home", odd: "2.10" }, { value: "Draw", odd: "3.40" }, { value: "Away", odd: "3.60" }] }] }] }];
    else if (u.pathname === "/injuries") response = [];
    return new Response(JSON.stringify({ errors: [], response }), { headers: { "x-ratelimit-requests-remaining": String(remaining) } });
  }
  return { fetchImpl, calls, leagues };
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
