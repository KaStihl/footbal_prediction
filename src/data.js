// Normalisation + derived inputs (port of pipeline/data.py), on a compact row format
// so a whole family of competitions can be loaded within the Workers CPU budget.
//
// Fixture row: [id, t(ms), status, homeKey, awayKey, hg, ag, compKey, season, round]  (see sources.js)
// Stats row:   [xgH, sotH, shotsH, possH, xgA, sotA, shotsA, possA]  (null = unknown)

import { HALF_LIFE_DAYS, NEUTRAL_COMPETITIONS, XG_BLEND } from "./config.js";

export const F = { ID: 0, T: 1, ST: 2, H: 3, A: 4, HG: 5, AG: 6, LG: 7, SE: 8, R: 9 };
export const FINISHED = new Set(["FT", "AET", "PEN"]);
export const UPCOMING = new Set(["NS", "TBD"]);

export const isFinished = (r) => FINISHED.has(r[F.ST]) && r[F.HG] !== null && r[F.AG] !== null;
export const isNeutral = (r) => NEUTRAL_COMPETITIONS.has(r[F.LG]);

/** Blend real goals with xG (or a shots-on-target proxy) to reduce finishing luck. */
export function perfGoals(goals, xg, sot, shots) {
  let proxy = xg;
  if (proxy == null && sot != null) proxy = 0.3 * sot + 0.03 * Math.max((shots ?? sot) - sot, 0);
  return proxy == null ? goals : XG_BLEND * goals + (1 - XG_BLEND) * proxy;
}

/** Model rows: [home, away, yh, ya, w, comp, neutral]. */
export function buildRows(rows, stats, family, nowMs, fitWeight) {
  const half = HALF_LIFE_DAYS[family];
  const out = [];
  for (const r of rows) {
    if (!isFinished(r)) continue;
    const age = Math.max((nowMs - r[F.T]) / 864e5, 0);
    const w = 0.5 ** (age / half) * (fitWeight[r[F.LG]] ?? 1);
    if (w < 1e-4) continue;
    const s = stats[r[F.ID]];
    const yh = s ? perfGoals(r[F.HG], s[0], s[1], s[2]) : r[F.HG];
    const ya = s ? perfGoals(r[F.AG], s[4], s[5], s[6]) : r[F.AG];
    out.push([r[F.H], r[F.A], Math.round(yh * 1000) / 1000, Math.round(ya * 1000) / 1000, Math.round(w * 1e5) / 1e5, r[F.LG], isNeutral(r) ? 1 : 0]);
  }
  return out;
}

/** teamId -> finished rows, newest first. */
export function teamIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    if (!isFinished(r)) continue;
    for (const t of [r[F.H], r[F.A]]) {
      let l = idx.get(t);
      if (!l) idx.set(t, (l = []));
      l.push(r);
    }
  }
  for (const l of idx.values()) l.sort((a, b) => b[F.T] - a[F.T]);
  return idx;
}

const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
const r2 = (x) => Math.round(x * 100) / 100;

export function teamForm(teamId, idx, stats, names, leagueNames, beforeMs, n = 5) {
  const last = (idx.get(teamId) || []).filter((r) => r[F.T] < beforeMs).slice(0, n);
  const results = [];
  let gf = 0, ga = 0, pts = 0, cs = 0;
  const xgf = [], xga = [], sot = [], poss = [];
  for (const r of last) {
    const home = r[F.H] === teamId;
    const [f, a] = home ? [r[F.HG], r[F.AG]] : [r[F.AG], r[F.HG]];
    const res = f > a ? "W" : f === a ? "D" : "L";
    pts += res === "W" ? 3 : res === "D" ? 1 : 0;
    gf += f; ga += a; if (a === 0) cs++;
    const s = stats[r[F.ID]];
    if (s) {
      const [mine, theirs] = home ? [0, 4] : [4, 0];
      if (s[mine] != null) xgf.push(s[mine]);
      if (s[theirs] != null) xga.push(s[theirs]);
      if (s[mine + 1] != null) sot.push(s[mine + 1]);
      if (s[mine + 3] != null) poss.push(s[mine + 3]);
    }
    results.push({ date: new Date(r[F.T]).toISOString().slice(0, 10), opp: names[home ? r[F.A] : r[F.H]] || "?", home, score: `${f}-${a}`, res, comp: leagueNames[r[F.LG]] || "" });
  }
  const k = last.length;
  return {
    last: results, form: results.map((x) => x.res).join(""), points: pts, games: k,
    gf: k ? r2(gf / k) : null, ga: k ? r2(ga / k) : null,
    xg_for: avg(xgf), xg_against: avg(xga), sot: avg(sot), possession: avg(poss), clean_sheets: cs,
  };
}

export function headToHead(homeId, awayId, idx, names, beforeMs, n = 6) {
  const played = (idx.get(homeId) || []).filter((r) => r[F.T] < beforeMs && (r[F.H] === awayId || r[F.A] === awayId)).slice(0, n);
  const out = { n: 0, home_wins: 0, draws: 0, away_wins: 0, goals_home_team: 0, goals_away_team: 0, matches: [] };
  for (const r of played) {
    const gh = r[F.H] === homeId ? r[F.HG] : r[F.AG], ga = r[F.H] === homeId ? r[F.AG] : r[F.HG];
    out.n++; out.goals_home_team += gh; out.goals_away_team += ga;
    if (gh > ga) out.home_wins++; else if (gh < ga) out.away_wins++; else out.draws++;
    out.matches.push({ date: new Date(r[F.T]).toISOString().slice(0, 10), home: names[r[F.H]] || "?", away: names[r[F.A]] || "?", score: `${r[F.HG]}-${r[F.AG]}` });
  }
  return out;
}

export function leagueTable(rows) {
  const t = new Map();
  for (const r of rows) {
    if (!isFinished(r)) continue;
    for (const [id, f, a] of [[r[F.H], r[F.HG], r[F.AG]], [r[F.A], r[F.AG], r[F.HG]]]) {
      const x = t.get(id) || { pts: 0, gf: 0, ga: 0, gp: 0 };
      x.gp++; x.gf += f; x.ga += a; x.pts += f > a ? 3 : f === a ? 1 : 0;
      t.set(id, x);
    }
  }
  const order = [...t.entries()].sort((x, y) => y[1].pts - x[1].pts || (y[1].gf - y[1].ga) - (x[1].gf - x[1].ga) || y[1].gf - x[1].gf);
  const out = {};
  order.forEach(([id, x], i) => { out[id] = { rank: i + 1, points: x.pts, gd: x.gf - x.ga, played: x.gp, of: order.length }; });
  return out;
}

// ---- time helpers (Europe/Bratislava without a tz library) -------------------

function tzOffsetMs(dateMs, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(dateMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(dateMs / 1000) * 1000;
}

const ymdFmt = new Map();
export function localDate(dateMs, tz) {
  if (!ymdFmt.has(tz)) ymdFmt.set(tz, new Intl.DateTimeFormat("sv-SE", { timeZone: tz }));
  return ymdFmt.get(tz).format(new Date(dateMs)); // YYYY-MM-DD
}

/** UTC ms of local midnight for a YYYY-MM-DD in tz. */
export function localMidnightUtc(ymd, tz) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  return guess - tzOffsetMs(guess - tzOffsetMs(guess, tz), tz);
}

/** Next (or current) Friday 00:00 - Monday 06:00 local window. */
export function weekendWindow(nowMs, tz) {
  const [y, m, d] = localDate(nowMs, tz).split("-").map(Number);
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mon=0
  const shift = wd >= 4 ? -(wd - 4) : 4 - wd;
  const fri = new Date(Date.UTC(y, m - 1, d + shift));
  const sun = new Date(Date.UTC(y, m - 1, d + shift + 2));
  const mon = new Date(Date.UTC(y, m - 1, d + shift + 3));
  const start = localMidnightUtc(fri.toISOString().slice(0, 10), tz);
  const end = localMidnightUtc(mon.toISOString().slice(0, 10), tz) + 6 * 3600e3;
  return { start, end, label: `${fri.getUTCDate()}.–${sun.getUTCDate()}. ${sun.getUTCMonth() + 1}. ${sun.getUTCFullYear()}` };
}
