// Daily pipeline logic, executed one small step per Durable Object alarm (see pipeline.js).
// Why steps: the Workers free plan allows ~10 ms CPU per invocation, so fetching,
// fitting, predicting and the analyst calls are split into many short invocations.
// Network waits (API-Football, Anthropic) do not count as CPU time.
// Large values are stored as JSON strings in compact array formats (cheap to load).

import * as cfgm from "./config.js";
import * as D from "./data.js";
import * as M from "./model.js";
import * as T from "./track.js";
import { ApiError, apiGet } from "./api.js";
import * as AN from "./analyst.js";

const { F } = D;

const MAX_ATTEMPTS = 2;
const FIT_SWEEPS = 6;
const MAX_FIT_STEPS = 40;
const STALE_MS = 40 * 3600e3; // analysis older than this is flagged in the UI
const REANALYSE_DP = 0.03;    // re-run the analyst when the model moved by > 3 p.p.

const r4 = (x) => Math.round(x * 1e4) / 1e4;

export function hashOf(obj) {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

export function initialSteps(now, cfg = {}) {
  const comps = cfgm.competitions(new Date(now));
  const cur = cfgm.currentClubSeason(new Date(now));
  const year = new Date(now).getUTCFullYear();
  const steps = [];
  for (const [key, c] of Object.entries(comps)) {
    for (const season of c.seasons) {
      const current = season >= (c.family === "club" ? cur : year);
      steps.push({ t: "fixtures", comp: key, league: c.id, season, ttlH: current ? 3 : 24 * 7 });
    }
  }
  if (cfg.extraFixtureIds && cfg.extraFixtureIds.length) steps.push({ t: "extras" });
  steps.push({ t: "stats", n: 0 });
  for (const fam of ["club", "national"]) steps.push({ t: "rows", fam }, { t: "fit", fam, n: 0 });
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
    const fresh = { id: now.toString(36), kind, started: now, steps: initialSteps(now, this.cfg), i: 0, attempt: 0, warnings: [], apiCalls: 0, remaining: null, usage: {}, analysed: 0, done: false };
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
    const label = `${step.t}${step.comp ? " " + step.comp + " " + step.season : ""}${step.fam ? " " + step.fam : ""}`;
    if (job.attempt > MAX_ATTEMPTS) {
      job.warnings.push(`krok ${label} preskočený po ${MAX_ATTEMPTS} pokusoch (limit CPU/čas?)`);
    } else {
      try {
        const res = (await this[`step_${step.t}`](step, job)) || {};
        delay = res.delay ?? 200;
        if (res.insert && res.insert.length) job.steps.splice(job.i + 1, 0, ...res.insert);
      } catch (e) {
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

  async api(job, path, params) {
    if (job.apiCalls >= this.cfg.apiMaxCalls) throw new ApiError(`limit ${this.cfg.apiMaxCalls} volaní API-Football na beh vyčerpaný`);
    if (job.remaining !== null && job.remaining <= 3) throw new ApiError(`denný limit API-Football takmer vyčerpaný (zostáva ${job.remaining})`);
    job.apiCalls++;
    const { response, remaining } = await apiGet(this.cfg.apiKey, path, params, this.fetch, this.cfg.apiBase);
    if (remaining !== null) job.remaining = remaining;
    return response;
  }

  // ---- data access ---------------------------------------------------------
  fixtureKeys(fam) {
    const keys = [];
    for (const c of Object.values(cfgm.competitions(new Date(this.now())))) if (!fam || c.family === fam) for (const s of c.seasons) keys.push(`fx:${c.id}:${s}`);
    keys.push(`fx:extra:${fam || "club"}`);
    return keys;
  }

  async loadRows(fam) {
    const keys = this.fixtureKeys(fam);
    const got = await this.storage.get(keys);
    const out = [];
    for (const k of keys) { const v = got.get(k); if (v) out.push(...JSON.parse(v).rows); }
    return out;
  }

  // ---- steps ---------------------------------------------------------------
  async step_fixtures(step, job) {
    const key = `fx:${step.league}:${step.season}`;
    const meta = await this.storage.get(`${key}:at`);
    if (meta && this.now() - meta < step.ttlH * 3600e3) return { delay: 20 };
    const resp = await this.api(job, "/fixtures", { league: step.league, season: step.season, timezone: "UTC" });
    const rows = resp.map(D.normFixture);
    if (!rows.length) job.warnings.push(`${step.comp} ${step.season}: API nevrátilo žiadne zápasy (sezóna/plán?)`);
    const names = await this.getJ("teams", {});
    for (const fx of resp) { names[fx.teams.home.id] = fx.teams.home.name; names[fx.teams.away.id] = fx.teams.away.name; }
    await this.putJ("teams", names);
    await this.putJ(key, { rows });
    await this.storage.put(`${key}:at`, this.now());
    // queue finished matches without statistics (newest first, last 150 days)
    const have = new Set(await this.getJ("stats_have", []));
    const todo = new Map(await this.getJ("stats_todo", []));
    const cutoff = this.now() - 150 * 864e5;
    for (const r of rows) if (D.isFinished(r) && !have.has(r[F.ID]) && r[F.T] > cutoff) todo.set(r[F.ID], r[F.T]);
    await this.putJ("stats_todo", [...todo.entries()].sort((a, b) => b[1] - a[1]));
    return { delay: this.gap };
  }

  /** Manually added fixtures (EXTRA_FIXTURE_IDS), stored per family. */
  async step_extras(step, job) {
    const at = await this.storage.get("fx:extra:at");
    if (at && this.now() - at < 3 * 3600e3 && (await this.storage.get("fx:extra:ids")) === this.cfg.extraFixtureIds.join(",")) return { delay: 20 };
    const comps = Object.values(cfgm.competitions(new Date(this.now())));
    const famOf = (league) => (comps.find((c) => c.id === league) || { family: "club" }).family;
    const out = { club: [], national: [] };
    const names = await this.getJ("teams", {});
    for (const id of this.cfg.extraFixtureIds) {
      const resp = await this.api(job, "/fixtures", { id, timezone: "UTC" });
      for (const fx of resp) {
        out[famOf(fx.league.id)].push(D.normFixture(fx));
        names[fx.teams.home.id] = fx.teams.home.name; names[fx.teams.away.id] = fx.teams.away.name;
        const ln = await this.getJ("extra_leagues", {});
        ln[fx.league.id] = fx.league.name;
        await this.putJ("extra_leagues", ln);
      }
      if (!resp.length) job.warnings.push(`ručne pridaný zápas ${id} sa v API nenašiel`);
    }
    await this.putJ("teams", names);
    await this.putJ("fx:extra:club", { rows: out.club });
    await this.putJ("fx:extra:national", { rows: out.national });
    await this.storage.put("fx:extra:at", this.now());
    await this.storage.put("fx:extra:ids", this.cfg.extraFixtureIds.join(","));
    return { delay: this.gap };
  }

  async step_stats(step, job) {
    let todo = await this.getJ("stats_todo", []); // [[id, t]] newest first
    if (!todo.length || step.n >= this.cfg.statsMaxCalls) return { delay: 20 };
    const ids = todo.slice(0, 20).map((x) => x[0]);
    const details = await this.api(job, "/fixtures", { ids: ids.join("-") });
    const got = new Map(details.map((d) => [d.fixture.id, d]));
    const stats = await this.getJ("stats", {});
    const have = await this.getJ("stats_have", []);
    for (const id of ids) {
      const s = got.has(id) ? D.extractStats(got.get(id)) : null;
      if (s) stats[id] = s;
      have.push(id);
    }
    todo = todo.slice(ids.length);
    await this.putJ("stats", stats);
    await this.putJ("stats_have", have);
    await this.putJ("stats_todo", todo);
    return { delay: this.gap, insert: todo.length ? [{ t: "stats", n: step.n + 1 }] : [] };
  }

  async step_rows(step) {
    const comps = cfgm.competitions(new Date(this.now()));
    const fitWeight = Object.fromEntries(Object.values(comps).map((c) => [c.id, c.fitWeight]));
    const rows = D.buildRows(await this.loadRows(step.fam), await this.getJ("stats", {}), step.fam, this.now(), fitWeight);
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

  async step_plan() {
    const now = this.now();
    const comps = cfgm.competitions(new Date(now));
    const byLeague = Object.fromEntries(Object.entries(comps).map(([k, c]) => [c.id, { key: k, ...c }]));
    const extras = new Set(this.cfg.extraFixtureIds);
    const extraLeagues = await this.getJ("extra_leagues", {});
    const leagueNames = Object.fromEntries(Object.values(comps).map((c) => [c.id, c.name]));
    const rows = { club: await this.loadRows("club"), national: await this.loadRows("national") };
    const stats = await this.getJ("stats", {});
    const names = await this.getJ("teams", {});
    const params = { club: await this.getJ("params:club", null), national: await this.getJ("params:national", null) };
    const horizon = now + cfgm.FIXTURE_WINDOW_DAYS * 864e5;

    const results = {};
    for (const fam of ["club", "national"]) for (const r of rows[fam]) if (D.isFinished(r) && now - r[F.T] < 14 * 864e5) results[r[F.ID]] = [r[F.HG], r[F.AG]];
    await this.putJ("recent_results", results);

    const cands = [];
    const tables = {};
    for (const fam of ["club", "national"]) {
      for (const r of rows[fam]) {
        const extra = extras.has(r[F.ID]);
        const c = byLeague[r[F.LG]] || (extra ? { key: "custom", name: extraLeagues[r[F.LG]] || "Iná súťaž", weight: 1.5, watch: true } : null);
        if (!c || !c.watch || !D.UPCOMING.has(r[F.ST]) || r[F.T] < now || r[F.T] > (extra ? now + 60 * 864e5 : horizon)) continue;
        const tk = `${r[F.LG]}:${r[F.SE]}`;
        if (!(tk in tables)) tables[tk] = fam === "club" ? D.leagueTable(rows.club.filter((x) => x[F.LG] === r[F.LG] && x[F.SE] === r[F.SE])) : {};
        const pr = M.predict(params[fam] || M.emptyParams(), r[F.H], r[F.A], r[F.LG], D.isNeutral(r));
        cands.push({ r, c, fam, pred: pr, table: tables[tk], interest: interest(r, names, pr, tables[tk], c), tabs: extra ? ["interesting"] : [], extra });
      }
    }
    cands.sort((a, b) => a.r[F.T] - b.r[F.T]);
    const w = D.weekendWindow(now, cfgm.TZ);
    for (const x of cands) if (cfgm.WEEKEND_COMPETITIONS.includes(x.c.key) && x.r[F.T] >= w.start && x.r[F.T] <= w.end) x.tabs.push("weekend");
    const nl = cands.filter((x) => x.c.key === cfgm.NATIONS_LEAGUE);
    const nlRounds = [...new Set(nl.map((x) => x.r[F.R]))].slice(0, 2);
    for (const x of nl) if (nlRounds.includes(x.r[F.R])) x.tabs.push("nations_league");
    const perDay = {};
    for (const x of cands) (perDay[D.localDate(x.r[F.T], cfgm.TZ)] ||= []).push(x);
    for (const list of Object.values(perDay)) {
      [...list].sort((a, b) => b.interest - a.interest).slice(0, cfgm.INTERESTING_PER_DAY).forEach((x) => { if (x.interest >= 4.5 && !x.tabs.includes("interesting")) x.tabs.push("interesting"); });
    }
    const shown = cands.filter((x) => x.tabs.length)
      .map(({ r, c, fam, pred, table, interest: it, tabs, extra }) => ({ r, comp: c.key, compName: c.name, fam, pred, th: table[r[F.H]] || null, ta: table[r[F.A]] || null, interest: it, tabs, extra }));
    await this.putJ("shown", shown);
    await this.putJ("plan_meta", { weekend: { label: w.label, from: new Date(w.start).toISOString(), to: new Date(w.end).toISOString() }, nations_league_rounds: nlRounds });
  }

  /** Second half of planning (split for the CPU budget): form, head-to-head, odds/injury steps. */
  async step_entries() {
    const now = this.now();
    const comps = cfgm.competitions(new Date(now));
    const leagueNames = Object.fromEntries(Object.values(comps).map((c) => [c.id, c.name]));
    const shown = await this.getJ("shown", []);
    const fams = [...new Set(shown.map((x) => x.fam))];
    const idx = {};
    for (const fam of fams) idx[fam] = D.teamIndex(await this.loadRows(fam));
    const stats = await this.getJ("stats", {});
    const names = await this.getJ("teams", {});
    const entries = shown.map(({ r, comp, compName, fam, pred, th, ta, interest: it, tabs, extra }) => ({
      id: r[F.ID], comp, competition: compName, round: r[F.R], extra: Boolean(extra), kickoff: new Date(r[F.T]).toISOString(), status: r[F.ST],
      league_id: r[F.LG], season: r[F.SE],
      home: { id: r[F.H], name: names[r[F.H]] || "?", table: th },
      away: { id: r[F.A], name: names[r[F.A]] || "?", table: ta },
      neutral: D.isNeutral(r), model: pred, final: pred, analyst: null, odds: null, injuries: [],
      form: { home: D.teamForm(r[F.H], idx[fam], stats, names, leagueNames, r[F.T]), away: D.teamForm(r[F.A], idx[fam], stats, names, leagueNames, r[F.T]) },
      h2h: D.headToHead(r[F.H], r[F.A], idx[fam], names, r[F.T]), interest: it, tabs,
    }));
    await this.putJ("entries", entries);

    // odds + injuries for shown matches, weekend / Nations League first
    const prio = (e) => (e.tabs.includes("weekend") ? 0 : e.tabs.includes("nations_league") ? 1 : 2);
    const insert = [];
    const injSeen = new Set();
    for (const e of [...entries].sort((a, b) => prio(a) - prio(b) || (a.kickoff < b.kickoff ? -1 : 1))) {
      const k = Date.parse(e.kickoff);
      if (k - now <= cfgm.ODDS_WINDOW_DAYS * 864e5) insert.push({ t: "odds", id: e.id });
      if (cfgm.INJURY_COMPETITIONS.has(e.comp) && k - now <= 3 * 864e5) {
        const date = e.kickoff.slice(0, 10), key = `${e.league_id}:${e.season}:${date}`;
        if (!injSeen.has(key)) { injSeen.add(key); insert.push({ t: "inj", league: e.league_id, season: e.season, date }); }
      }
    }
    return { insert };
  }

  async patchEntries(fn) {
    const entries = await this.getJ("entries", []);
    fn(entries);
    await this.putJ("entries", entries);
  }

  async step_odds(step, job) {
    const odds = parseOdds(await this.api(job, "/odds", { fixture: step.id, bookmaker: this.cfg.oddsBookmaker }));
    await this.patchEntries((es) => { const e = es.find((x) => x.id === step.id); if (e) e.odds = odds; });
    return { delay: this.gap };
  }

  async step_inj(step, job) {
    const resp = await this.api(job, "/injuries", { league: step.league, season: step.season, date: step.date });
    const by = {};
    for (const it of resp) {
      const fid = it.fixture && it.fixture.id;
      if (fid == null) continue;
      (by[fid] ||= []).push({ team_id: it.team.id, player: it.player.name, type: it.player.type, reason: it.player.reason });
    }
    await this.patchEntries((es) => { for (const e of es) if (by[e.id]) e.injuries = by[e.id]; });
    return { delay: this.gap };
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
      api: { calls: job.apiCalls, remaining_daily: job.remaining },
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

export function parseOdds(resp) {
  const bm = resp && resp[0] && resp[0].bookmakers && resp[0].bookmakers[0];
  if (!bm) return null;
  const out = { bookmaker: bm.name };
  for (const bet of bm.bets || []) {
    const vals = Object.fromEntries((bet.values || []).filter((v) => v.odd).map((v) => [v.value, Number(v.odd)]));
    if (bet.id === 1 && vals.Home && vals.Draw && vals.Away) Object.assign(out, { home: vals.Home, draw: vals.Draw, away: vals.Away });
    else if (bet.id === 5 && vals["Over 2.5"] && vals["Under 2.5"]) Object.assign(out, { over25: vals["Over 2.5"], under25: vals["Under 2.5"] });
  }
  if (!out.home) return null;
  const imp = M.impliedProbs(out.home, out.draw, out.away);
  out.implied = { home: r4(imp.home), draw: r4(imp.draw), away: r4(imp.away) };
  out.margin = r4(imp.margin);
  return out;
}

export function dossier(e) {
  const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
  return {
    match: { id: e.id, competition: e.competition, round: e.round, kickoff_utc: e.kickoff, home: e.home.name, away: e.away.name, neutral_venue: e.neutral },
    league_position: { home: e.home.table, away: e.away.table },
    model: pick(e.model, ["xg_home", "xg_away", "p_home", "p_draw", "p_away", "p_over25", "p_btts", "score", "confidence"]),
    form_last5: e.form, head_to_head: e.h2h, api_football_injuries: e.injuries,
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
