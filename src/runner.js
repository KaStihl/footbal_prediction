// Daily pipeline logic, executed one small step per Durable Object alarm (see pipeline.js).
// Why steps: the Workers free plan allows ~10 ms CPU per invocation, so fetching,
// fitting, predicting and the analyst calls are split into many short invocations.
// Network waits do not count as CPU time. Large values are stored as JSON strings.
//
// Data source chain (sources.js): ESPN month by month; for a competition-season where
// ESPN fails or returns nothing, football-data.org, then API-Football.

import * as cfgm from "./config.js";
import * as D from "./data.js";
import * as M from "./model.js";
import * as T from "./track.js";
import * as S from "./sources.js";
import { ApiError, PlanError, RateLimitError } from "./api.js";
import * as AN from "./analyst.js";

const { F } = D;
const MAX_ATTEMPTS = 2;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_PAUSE_MS = 61_000;
const FIT_SWEEPS = 6;
const MAX_FIT_STEPS = 40;
const STALE_MS = 40 * 3600e3;  // analysis older than this is flagged in the UI
const REANALYSE_DP = 0.03;     // re-run the analyst when the model moved by > 3 p.p.
const ESPN_GAP_MS = 400;       // be polite to the public endpoint
const FD_GAP_MS = 6500;        // football-data.org free: 10 requests / minute
const SOURCE_LABEL = { espn: "ESPN", fd: "football-data.org", af: "API-Football" };

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const curYm = (now) => { const d = new Date(now); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

export function hashOf(obj) {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

export function initialSteps(now) {
  const steps = [];
  for (const [key, c] of Object.entries(cfgm.competitions(new Date(now)))) {
    if (c.espn) for (const ym of cfgm.espnMonths(c, now)) steps.push({ t: "espn", comp: key, ym });
  }
  steps.push({ t: "fallback" });
  for (const fam of ["club", "national"]) steps.push({ t: "merge", fam }, { t: "rows", fam }, { t: "fit", fam, n: 0 });
  steps.push({ t: "plan" }, { t: "entries" }, { t: "analyst_plan" }, { t: "publish" });
  return steps;
}

export class Runner {
  constructor(storage, env, deps = {}) {
    this.storage = storage;
    this.cfg = cfgm.settings(env);
    this.gap = Math.round(60000 / Math.max(this.cfg.apiRpm, 1)) + 500; // API-Football rate limit (free: 10/min)
    this.fetch = deps.fetch || ((...a) => fetch(...a));
    this.makeClient = deps.makeClient || ((key) => AN.makeClient(key, this.cfg.anthropicBaseUrl));
    this.now = deps.now || (() => Date.now());
  }

  async getJ(key, dflt) {
    const v = await this.storage.get(key);
    return v === undefined ? dflt : JSON.parse(v);
  }

  putJ(key, obj) {
    return this.storage.put(key, JSON.stringify(obj));
  }

  async start(kind) {
    const job = await this.storage.get("job");
    const now = this.now();
    if (job && !job.done && now - job.started < 3 * 3600e3) return { started: false, reason: "a run is already in progress", job: brief(job) };
    const fresh = {
      id: now.toString(36), kind, started: now, steps: initialSteps(now), i: 0, attempt: 0, warnings: [],
      apiCalls: 0, espnCalls: 0, fdCalls: 0, remaining: null, usage: {}, analysed: 0, espnFail: {}, done: false,
    };
    await this.storage.put("job", fresh);
    return { started: true, job: brief(fresh) };
  }

  /** Execute the current step; returns the delay (ms) until the next one, or null when finished. */
  async tick() {
    const job = await this.storage.get("job");
    if (!job || job.done) return null;
    const step = job.steps[job.i];
    job.attempt++;
    await this.storage.put("job", job); // persist the attempt before work: a CPU-limit kill still counts
    let delay = 200;
    const label = `${step.t}${step.comp ? " " + step.comp : ""}${step.ym ? " " + step.ym : ""}${step.season ? " " + step.season : ""}${step.fam ? " " + step.fam : ""}`;
    if (job.attempt > MAX_ATTEMPTS) {
      job.warnings.push(`krok ${label} preskočený po ${MAX_ATTEMPTS} pokusoch (limit CPU/čas?)`);
    } else {
      try {
        const res = (await this[`step_${step.t}`](step, job)) || {};
        delay = res.delay ?? 200;
        if (res.insert && res.insert.length) job.steps.splice(job.i + 1, 0, ...res.insert);
      } catch (e) {
        if (e instanceof RateLimitError && (step.rl || 0) < RATE_LIMIT_RETRIES) {
          step.rl = (step.rl || 0) + 1; // same step again after a minute
          job.attempt = 0;
          await this.storage.put("job", job);
          return RATE_LIMIT_PAUSE_MS;
        }
        if (e instanceof PlanError) job.planBlocked = true;
        job.warnings.push(`${label}: ${String((e && e.message) || e).slice(0, 300)}`);
        delay = e instanceof ApiError ? this.gap : 200;
      }
    }
    job.i++;
    job.attempt = 0;
    if (job.i >= job.steps.length) { job.done = true; job.finished = this.now(); }
    await this.storage.put("job", job);
    return job.done ? null : delay;
  }

  // ---- data access ---------------------------------------------------------
  /** Storage keys holding the data of one family (ESPN months + fallback seasons in use). */
  async dataKeys(fam) {
    const use = await this.getJ("fallback_use", {});
    const keys = [];
    for (const [key, c] of Object.entries(cfgm.competitions(new Date(this.now())))) {
      if (fam && c.family !== fam) continue;
      if (c.espn) for (const ym of cfgm.espnMonths(c, this.now())) keys.push({ k: `fx:espn:${key}:${ym}`, comp: key, src: "espn" });
      for (const [season, src] of Object.entries(use[key] || {})) keys.push({ k: `fx:${src}:${key}:${season}`, comp: key, src, season: +season });
    }
    return { keys, use };
  }

  /** Merged data of a family from the snapshot written by the merge step (cheap to load).
   *  parts: which of stats / odds are needed besides rows, names and groups. */
  async loadData(fam, { stats = false, odds = false } = {}) {
    const base = await this.storage.get(`data:${fam}:base`);
    if (!base) return this.mergeData(fam);
    const d = JSON.parse(base);
    d.stats = stats ? await this.getJ(`data:${fam}:stats`, {}) : {};
    d.odds = odds ? await this.getJ(`data:${fam}:odds`, {}) : {};
    return d;
  }

  async step_merge(step) {
    const d = await this.mergeData(step.fam);
    await this.putJ(`data:${step.fam}:base`, { rows: d.rows, names: d.names, groups: d.groups });
    await this.putJ(`data:${step.fam}:stats`, d.stats);
    await this.putJ(`data:${step.fam}:odds`, d.odds);
  }

  /** Merge { rows, names, stats, odds, groups } of a family; fallback seasons replace ESPN's. */
  async mergeData(fam) {
    const { keys, use } = await this.dataKeys(fam);
    const out = { rows: [], names: {}, stats: {}, odds: {}, groups: {} };
    const seen = new Set();
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const got = await this.storage.get(chunk.map((x) => x.k));
      for (const x of chunk) {
        const v = got.get(x.k);
        if (!v) continue;
        const d = JSON.parse(v);
        const replaced = x.src === "espn" ? use[x.comp] || {} : {};
        for (const r of d.rows) {
          if (replaced[r[F.SE]] || seen.has(r[F.ID])) continue;
          seen.add(r[F.ID]);
          out.rows.push(r);
        }
        for (const [k, n] of Object.entries(d.names || {})) if (!(k in out.names) || x.src === "espn") out.names[k] = n;
        Object.assign(out.stats, d.stats || {});
        Object.assign(out.odds, d.odds || {});
        Object.assign(out.groups, d.groups || {});
      }
    }
    return out;
  }

  // ---- source steps --------------------------------------------------------
  async step_espn(step, job) {
    const comp = cfgm.competitions(new Date(this.now()))[step.comp];
    const key = `fx:espn:${step.comp}:${step.ym}`;
    const at = await this.storage.get(`${key}:at`);
    const cur = curYm(this.now());
    const ageMonths = (+cur.slice(0, 4) - +step.ym.slice(0, 4)) * 12 + (+cur.slice(4) - +step.ym.slice(4));
    const ttlH = ageMonths >= 2 ? 24 * 14 : ageMonths === 1 ? 12 : 3;
    if (at && this.now() - at < ttlH * 3600e3) return { delay: 10 };
    if (job.espnCalls >= this.cfg.espnMaxCalls) throw new ApiError(`limit ${this.cfg.espnMaxCalls} volaní ESPN na beh`);
    job.espnCalls++;
    let d;
    try {
      d = await S.fetchEspnMonth(this.fetch, comp.espn, step.comp, step.ym);
    } catch (e) {
      ((job.espnFail[step.comp] ||= {})[cfgm.seasonOfMonth(step.ym)] = true);
      throw new ApiError(`ESPN: ${e.message}`);
    }
    if (step.comp !== cfgm.NATIONS_LEAGUE) d.groups = {};
    await this.putJ(key, d);
    await this.storage.put(`${key}:at`, this.now());
    const counts = await this.getJ("espn_counts", {});
    (counts[step.comp] ||= {})[step.ym] = d.rows.length;
    await this.putJ("espn_counts", counts);
    return { delay: ESPN_GAP_MS };
  }

  /** Decide which competition-seasons need another source and queue those requests. */
  async step_fallback(step, job) {
    const comps = cfgm.competitions(new Date(this.now()));
    const counts = await this.getJ("espn_counts", {});
    const use = await this.getJ("fallback_use", {});
    const insert = [];
    for (const [key, c] of Object.entries(comps)) {
      const months = c.espn ? cfgm.espnMonths(c, this.now()) : [];
      for (const season of c.seasons) {
        const inWindow = months.filter((ym) => cfgm.seasonOfMonth(ym) === season);
        const espnRows = inWindow.reduce((s, ym) => s + ((counts[key] || {})[ym] || 0), 0);
        const failed = Boolean((job.espnFail[key] || {})[season]);
        const needed = !c.espn || failed || (inWindow.length > 0 && espnRows === 0);
        if (!needed) { if (use[key]) delete use[key][season]; continue; }
        if (c.fd && this.cfg.fdKey) insert.push({ t: "fd", comp: key, season });
        else if (c.af && this.cfg.apiKey && season <= this.cfg.apiMaxSeason) insert.push({ t: "af", comp: key, season });
        else if (inWindow.length) job.warnings.push(`${c.name} ${season}: ESPN bez dát a žiadny záložný zdroj (pridaj FOOTBALL_DATA_KEY)`);
      }
    }
    await this.putJ("fallback_use", use);
    return { insert };
  }

  async storeFallback(job, step, src, d) {
    const use = await this.getJ("fallback_use", {});
    await this.putJ(`fx:${src}:${step.comp}:${step.season}`, d);
    (use[step.comp] ||= {})[step.season] = src;
    await this.putJ("fallback_use", use);
  }

  nextFallback(step, from) {
    const c = cfgm.competitions(new Date(this.now()))[step.comp];
    if (from === "fd" && c.af && this.cfg.apiKey && step.season <= this.cfg.apiMaxSeason) return [{ t: "af", comp: step.comp, season: step.season }];
    return [];
  }

  async step_fd(step, job) {
    const c = cfgm.competitions(new Date(this.now()))[step.comp];
    job.fdCalls++;
    let d;
    try {
      d = await S.fetchFootballData(this.fetch, this.cfg.fdKey, c.fd, step.comp, step.season);
    } catch (e) {
      job.warnings.push(`football-data.org ${step.comp} ${step.season}: ${e.message}`);
      return { delay: FD_GAP_MS, insert: this.nextFallback(step, "fd") };
    }
    if (!d.rows.length) return { delay: FD_GAP_MS, insert: this.nextFallback(step, "fd") };
    await this.storeFallback(job, step, "fd", d);
    return { delay: FD_GAP_MS };
  }

  async step_af(step, job) {
    const c = cfgm.competitions(new Date(this.now()))[step.comp];
    if (job.apiCalls >= this.cfg.apiMaxCalls) throw new ApiError(`limit ${this.cfg.apiMaxCalls} volaní API-Football na beh vyčerpaný`);
    if (job.remaining !== null && job.remaining <= 3) throw new ApiError(`denný limit API-Football takmer vyčerpaný (zostáva ${job.remaining})`);
    job.apiCalls++;
    const d = await S.fetchApiFootball(this.fetch, this.cfg.apiKey, this.cfg.apiBase, c.af, step.comp, step.season);
    if (d.remaining !== null) job.remaining = d.remaining;
    delete d.remaining;
    if (d.rows.length) await this.storeFallback(job, step, "af", d);
    else job.warnings.push(`${c.name} ${step.season}: žiadny zdroj nevrátil zápasy`);
    return { delay: this.gap };
  }

  // ---- model ---------------------------------------------------------------
  async step_rows(step) {
    const comps = cfgm.competitions(new Date(this.now()));
    const fitWeight = Object.fromEntries(Object.entries(comps).map(([k, c]) => [k, c.fitWeight]));
    const d = await this.loadData(step.fam, { stats: true });
    const rows = D.buildRows(d.rows, d.stats, step.fam, this.now(), fitWeight);
    const prev = await this.getJ(`params:${step.fam}`, null);
    await this.putJ(`rows:${step.fam}`, rows);
    await this.putJ(`params:${step.fam}`, M.initParams(rows, prev));
  }

  async step_fit(step) {
    const rows = await this.getJ(`rows:${step.fam}`, []);
    const p = await this.getJ(`params:${step.fam}`, null) || M.initParams(rows);
    M.fitSweeps(rows, p, { maxSweeps: FIT_SWEEPS });
    await this.putJ(`params:${step.fam}`, p);
    if (!p.converged && step.n + 1 < MAX_FIT_STEPS) return { insert: [{ t: "fit", fam: step.fam, n: step.n + 1 }] };
  }

  // ---- selection -----------------------------------------------------------
  async step_plan() {
    const now = this.now();
    const comps = cfgm.competitions(new Date(now));
    const data = { club: await this.loadData("club"), national: await this.loadData("national") };
    const params = { club: await this.getJ("params:club", null), national: await this.getJ("params:national", null) };
    const horizon = now + cfgm.FIXTURE_WINDOW_DAYS * 864e5;
    const extras = new Set(this.cfg.extraFixtureIds);

    const results = {};
    const index = [];
    for (const fam of ["club", "national"]) {
      for (const r of data[fam].rows) {
        if (D.isFinished(r) && now - r[F.T] < 14 * 864e5) results[r[F.ID]] = [r[F.HG], r[F.AG]];
        if (D.UPCOMING.has(r[F.ST]) && r[F.T] >= now && r[F.T] < now + 70 * 864e5) {
          index.push([r[F.ID], r[F.T], r[F.LG], data[fam].names[r[F.H]] || r[F.H], data[fam].names[r[F.A]] || r[F.A]]);
        }
      }
    }
    await this.putJ("recent_results", results);
    await this.putJ("upcoming_index", index.sort((a, b) => a[1] - b[1]));

    const cands = [];
    const tables = {};
    for (const fam of ["club", "national"]) {
      const { rows, names } = data[fam];
      for (const r of rows) {
        const c = comps[r[F.LG]];
        const extra = extras.has(r[F.ID]);
        if (!c || !D.UPCOMING.has(r[F.ST]) || r[F.T] < now) continue;
        if (!extra && (!c.watch || r[F.T] > horizon) && !(r[F.LG] === cfgm.NATIONS_LEAGUE && r[F.T] < now + 200 * 864e5)) continue;
        const tk = `${r[F.LG]}:${r[F.SE]}`;
        if (!(tk in tables)) tables[tk] = fam === "club" ? D.leagueTable(rows.filter((x) => x[F.LG] === r[F.LG] && x[F.SE] === r[F.SE])) : {};
        const pr = M.predict(params[fam] || M.emptyParams(), r[F.H], r[F.A], r[F.LG], D.isNeutral(r));
        cands.push({ r, key: r[F.LG], c, fam, pred: pr, table: tables[tk], interest: interest(r, names, pr, tables[tk], c), tabs: extra ? ["interesting"] : [], extra });
      }
    }
    cands.sort((a, b) => a.r[F.T] - b.r[F.T]);
    const w = D.weekendWindow(now, cfgm.TZ);
    for (const x of cands) if (cfgm.WEEKEND_COMPETITIONS.includes(x.key) && x.r[F.T] >= w.start && x.r[F.T] <= w.end) x.tabs.push("weekend");
    // Nations League: matchday windows = clusters of dates (ESPN has no round numbers); next two windows
    const nl = cands.filter((x) => x.key === cfgm.NATIONS_LEAGUE);
    const windows = [];
    for (const x of nl) {
      const last = windows[windows.length - 1];
      // an international window: consecutive match days, at most ~9 days long
      if (last && x.r[F.T] - last.end <= 3 * 864e5 && x.r[F.T] - last.start <= 9 * 864e5) { last.end = x.r[F.T]; last.items.push(x); }
      else windows.push({ start: x.r[F.T], end: x.r[F.T], items: [x] });
    }
    const fmt = (t) => { const [, m, d] = D.localDate(t, cfgm.TZ).split("-"); return [+d, +m]; };
    const nlRounds = [];
    for (const win of windows.slice(0, 2)) {
      const [d1, m1] = fmt(win.start), [d2, m2] = fmt(win.end);
      const label = m1 === m2 ? `Kolo ${d1}.–${d2}. ${m2}.` : `Kolo ${d1}. ${m1}. – ${d2}. ${m2}.`;
      nlRounds.push(label);
      for (const x of win.items) { x.tabs.push("nations_league"); x.roundLabel = label; }
    }
    const perDay = {};
    for (const x of cands) if (x.r[F.T] <= horizon) (perDay[D.localDate(x.r[F.T], cfgm.TZ)] ||= []).push(x);
    for (const list of Object.values(perDay)) {
      [...list].sort((a, b) => b.interest - a.interest).slice(0, cfgm.INTERESTING_PER_DAY)
        .forEach((x) => { if (x.interest >= 4.5 && !x.tabs.includes("interesting")) x.tabs.push("interesting"); });
    }
    const shown = cands.filter((x) => x.tabs.length).map(({ r, key, c, fam, pred, table, interest: it, tabs, extra, roundLabel }) => ({
      r, comp: key, compName: c.name, fam, pred, th: table[r[F.H]] || null, ta: table[r[F.A]] || null, interest: it, tabs, extra, roundLabel,
    }));
    await this.putJ("shown", shown);
    await this.putJ("plan_meta", { weekend: { label: w.label, from: new Date(w.start).toISOString(), to: new Date(w.end).toISOString() }, nations_league_rounds: nlRounds });
  }

  /** Second half of planning (split for the CPU budget): form, head-to-head, odds. */
  async step_entries() {
    const comps = cfgm.competitions(new Date(this.now()));
    const compNames = Object.fromEntries(Object.entries(comps).map(([k, c]) => [k, c.name]));
    const shown = await this.getJ("shown", []);
    const out = [];
    for (const fam of [...new Set(shown.map((x) => x.fam))]) {
      const d = await this.loadData(fam, { stats: true, odds: true });
      const idx = D.teamIndex(d.rows);
      for (const { r, comp, compName, pred, th, ta, interest: it, tabs, extra, roundLabel } of shown.filter((x) => x.fam === fam)) {
        out.push({
          id: r[F.ID], comp, competition: compName, round: roundLabel || r[F.R] || "", group: d.groups[r[F.ID]] || null, extra: Boolean(extra),
          kickoff: new Date(r[F.T]).toISOString(), status: r[F.ST], season: r[F.SE],
          home: { id: r[F.H], name: d.names[r[F.H]] || r[F.H], table: th },
          away: { id: r[F.A], name: d.names[r[F.A]] || r[F.A], table: ta },
          neutral: D.isNeutral(r), model: pred, final: pred, analyst: null, odds: oddsOf(d.odds[r[F.ID]]), injuries: [],
          form: { home: D.teamForm(r[F.H], idx, d.stats, d.names, compNames, r[F.T]), away: D.teamForm(r[F.A], idx, d.stats, d.names, compNames, r[F.T]) },
          h2h: D.headToHead(r[F.H], r[F.A], idx, d.names, r[F.T]), interest: it, tabs,
        });
      }
    }
    out.sort((a, b) => (a.kickoff < b.kickoff ? -1 : 1));
    await this.putJ("entries", out);
  }

  /** For /api/find-fixtures: upcoming matches whose team name matches. */
  async find(team) {
    const k = S.teamKey(team);
    if (k.length < 3) return [];
    const comps = cfgm.competitions(new Date(this.now()));
    return (await this.getJ("upcoming_index", []))
      .filter((x) => S.teamKey(x[3]).includes(k) || S.teamKey(x[4]).includes(k)).slice(0, 15)
      .map(([id, t, comp, h, a]) => ({ fixture_id: id, kickoff_utc: new Date(t).toISOString(), match: `${h} - ${a}`, competition: (comps[comp] || {}).name || comp }));
  }

  async step_analyst_plan(step, job) {
    if (!this.cfg.anthropicKey) { job.warnings.push("ANTHROPIC_API_KEY nie je nastavený: beží len štatistický model"); return; }
    const now = this.now();
    const entries = await this.getJ("entries", []);
    const state = await this.getJ("analysis", { matches: {}, rounds: {} });
    const prio = { weekend: 0, nations_league: 1, interesting: 2 };
    const cands = entries.filter((e) => Date.parse(e.kickoff) - now <= this.cfg.analystWindowHours * 3600e3)
      .sort((a, b) => Math.min(...a.tabs.map((t) => prio[t])) - Math.min(...b.tabs.map((t) => prio[t])) || (a.kickoff < b.kickoff ? -1 : 1));
    const insert = [];
    for (const e of cands) {
      const basis = analysisBasis(e);
      if (!needsAnalysis(state.matches[e.id], basis, now, this.cfg.analystMaxAgeHours * 3600e3)) continue;
      insert.push({ t: "analyst", id: e.id });
      if (insert.length >= this.cfg.analystMaxMatches) break;
    }
    insert.push({ t: "round", tab: "weekend" }, { t: "round", tab: "nations_league" });
    return { insert };
  }

  async step_analyst(step, job) {
    const e = (await this.getJ("entries", [])).find((x) => x.id === step.id);
    if (!e) return;
    const client = this.makeClient(this.cfg.anthropicKey);
    const res = await AN.analyseMatch(client, job.usage, this.cfg, dossier(e), new Date(this.now()).toISOString().slice(0, 10));
    const state = await this.getJ("analysis", { matches: {}, rounds: {} });
    state.matches[step.id] = { ...res, basis: analysisBasis(e), updated_at: new Date(this.now()).toISOString() };
    await this.putJ("analysis", state);
    job.analysed++;
  }

  async step_round(step, job) {
    const state = await this.getJ("analysis", { matches: {}, rounds: {} });
    const entries = applyAnalysis(await this.getJ("entries", []), state, this.now());
    const meta = await this.getJ("plan_meta", {});
    const es = entries.filter((e) => e.tabs.includes(step.tab) && e.analyst);
    if (!es.length) return;
    const items = es.map((e) => ({
      match_id: e.id, match: `${e.home.name} - ${e.away.name}`, kickoff: e.kickoff, pick: e.final.score,
      p: [e.final.p_home, e.final.p_draw, e.final.p_away].map((x) => Math.round(x * 100) / 100), analysis: e.analyst.summary,
      absences: e.analyst.absences.map((a) => `${a.player} (${a.status})`),
    }));
    const h = hashOf(items);
    if (state.rounds[step.tab] && state.rounds[step.tab].hash === h) return;
    const title = step.tab === "weekend" ? `Premier League + Bundesliga, víkend ${(meta.weekend || {}).label || ""}` : `Liga národov: ${(meta.nations_league_rounds || []).join(", ")}`;
    const res = await AN.summarizeRound(this.makeClient(this.cfg.anthropicKey), job.usage, this.cfg, title, items);
    state.rounds[step.tab] = { ...res, hash: h, title, updated_at: new Date(this.now()).toISOString() };
    await this.putJ("analysis", state);
  }

  async sourcesSummary() {
    const use = await this.getJ("fallback_use", {});
    const counts = await this.getJ("espn_counts", {});
    const out = {};
    for (const [key, c] of Object.entries(cfgm.competitions(new Date(this.now())))) {
      const espnRows = Object.values(counts[key] || {}).reduce((s, n) => s + n, 0);
      const fb = Object.entries(use[key] || {}).map(([s, src]) => `${SOURCE_LABEL[src]} (${s})`);
      out[c.name] = [espnRows ? `ESPN (${espnRows} zápasov)` : null, ...fb].filter(Boolean).join(" + ") || "bez dát";
    }
    return out;
  }

  async step_publish(step, job) {
    const now = this.now();
    const state = await this.getJ("analysis", { matches: {}, rounds: {} });
    const entries = applyAnalysis(await this.getJ("entries", []), state, now);
    for (const e of entries) {
      if (!e.odds) continue;
      const imp = e.odds.implied;
      e.odds.edge = { home: r4(e.final.p_home - imp.home), draw: r4(e.final.p_draw - imp.draw), away: r4(e.final.p_away - imp.away) };
    }
    const history = await this.getJ("history", {});
    T.updateHistory(history, entries, now);
    T.attachResults(history, await this.getJ("recent_results", {}));
    T.pruneHistory(history);
    const played = Object.values(history)
      .filter((h) => Date.parse(h.kickoff) <= now && now - Date.parse(h.kickoff) <= 4 * 864e5 && h.tabs && h.tabs.length)
      .sort((a, b) => (a.kickoff < b.kickoff ? 1 : -1));
    for (const [id, a] of Object.entries(state.matches)) if (now - Date.parse(a.updated_at) > 10 * 864e5) delete state.matches[id];
    const pc = await this.getJ("params:club", null), pn = await this.getJ("params:national", null);
    const meta = {
      generated_at: new Date(now).toISOString(), demo: false, run: { id: job.id, kind: job.kind, steps: job.steps.length },
      api: { calls: job.apiCalls, remaining_daily: job.remaining, plan_blocked: Boolean(job.planBlocked), espn_calls: job.espnCalls, fd_calls: job.fdCalls },
      sources: await this.sourcesSummary(),
      analyst: { enabled: Boolean(this.cfg.anthropicKey), model: this.cfg.analystModel, matches_analysed_this_run: job.analysed, usage: job.usage, est_cost_usd: AN.costUsd(job.usage, this.cfg.analystModel) },
      ...(await this.getJ("plan_meta", {})),
      model: {
        teams_club: pc ? Object.keys(pc.att).length : 0, teams_national: pn ? Object.keys(pn.att).length : 0,
        home_adv_club: pc ? r4(pc.homeAdv) : null, home_adv_national: pn ? r4(pn.homeAdv) : null,
        converged: { club: pc ? pc.converged : null, national: pn ? pn.converged : null },
      },
      warnings: job.warnings.slice(0, 40),
      round_summaries: state.rounds,
    };
    await this.putJ("history", history);
    await this.putJ("analysis", state);
    await this.storage.put("out:predictions", JSON.stringify({ generated_at: meta.generated_at, matches: entries, played }));
    await this.storage.put("out:meta", JSON.stringify(meta));
    await this.storage.put("out:track", JSON.stringify(T.summarize(history)));
  }
}

function interest(r, names, pred, table, comp) {
  let s = comp.weight;
  for (const id of [r[F.H], r[F.A]]) { const rk = table[id] && table[id].rank; if (rk) s += Math.max(0, (7 - rk) / 6); }
  s += 1 - Math.abs(pred.p_home - pred.p_away);
  s += 0.5 * Math.min(Math.max(pred.xg_home + pred.xg_away - 2.5, 0), 1.5);
  const ns = [String(names[r[F.H]] || "").toLowerCase(), String(names[r[F.A]] || "").toLowerCase()];
  if (cfgm.DERBIES.some((pair) => pair.every((d) => ns.some((n) => n.includes(d.toLowerCase()))))) s += 1;
  return Math.round(s * 1000) / 1000;
}

/** Bookmaker odds (decimal) -> object with margin-free implied probabilities. */
export function oddsOf(o) {
  if (!o || !o.home || !o.draw || !o.away) return null;
  const imp = M.impliedProbs(o.home, o.draw, o.away);
  return { ...o, implied: { home: r4(imp.home), draw: r4(imp.draw), away: r4(imp.away) }, margin: r4(imp.margin) };
}

export function dossier(e) {
  const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
  return {
    match: { id: e.id, competition: e.competition, round: e.round, kickoff_utc: e.kickoff, home: e.home.name, away: e.away.name, neutral_venue: e.neutral },
    league_position: { home: e.home.table, away: e.away.table },
    model: pick(e.model, ["xg_home", "xg_away", "p_home", "p_draw", "p_away", "p_over25", "p_btts", "score", "confidence"]),
    form_last5: e.form, head_to_head: e.h2h, injuries_from_data_feed: e.injuries,
    bookmaker_odds: e.odds ? pick(e.odds, ["bookmaker", "home", "draw", "away", "implied"]) : null,
  };
}

/** What an analysis was based on; a material change triggers a new analysis. */
export function analysisBasis(e) {
  return { p: [e.model.p_home, e.model.p_draw, e.model.p_away], inj: hashOf(e.injuries || []), kickoff: e.kickoff };
}

export function needsAnalysis(cur, basis, now, maxAgeMs) {
  if (!cur || !cur.basis) return true;
  if (now - Date.parse(cur.updated_at) >= maxAgeMs) return true;
  if (cur.basis.inj !== basis.inj || cur.basis.kickoff !== basis.kickoff) return true;
  return cur.basis.p.some((v, i) => Math.abs(v - basis.p[i]) > REANALYSE_DP);
}

export function applyAnalysis(entries, state, now) {
  for (const e of entries) {
    const a = state.matches[e.id];
    if (!a || Date.parse(e.kickoff) < now) continue;
    const nMin = Math.min(e.model.n_eff_home, e.model.n_eff_away);
    e.final = { ...M.summarize(e.model.xg_home * a.xg_mult_home, e.model.xg_away * a.xg_mult_away, nMin), n_eff_home: e.model.n_eff_home, n_eff_away: e.model.n_eff_away };
    const { basis: _b, ...rest } = a;
    e.analyst = { ...rest, stale: now - Date.parse(a.updated_at) > STALE_MS };
  }
  return entries;
}

export function brief(job) {
  const step = job.steps[job.i];
  return {
    id: job.id, kind: job.kind, started: new Date(job.started).toISOString(), step: job.i, steps: job.steps.length,
    current: step ? step.t : null, done: job.done, finished: job.finished ? new Date(job.finished).toISOString() : null,
    warnings: job.warnings.length, api_calls: job.apiCalls, analysed: job.analysed,
  };
}
