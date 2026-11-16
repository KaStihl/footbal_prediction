import test from "node:test";
import assert from "node:assert/strict";
import { Runner } from "../src/runner.js";
import * as M from "../src/model.js";
import * as D from "../src/data.js";
import { FakeStorage, makeWorld, fakeClaude } from "./fake.mjs";

const NOW = Date.UTC(2026, 10, 11, 12, 0); // Wed 11 Nov 2026

async function runAll(runner, { measure = false } = {}) {
  const cpu = [];
  await runner.start("test");
  for (let i = 0; i < 1000; i++) {
    const job = await runner.storage.get("job");
    const t0 = process.cpuUsage();
    const d = await runner.tick();
    const u = process.cpuUsage(t0);
    if (measure) cpu.push({ step: job.steps[job.i].t, ms: (u.user + u.system) / 1000 });
    if (d === null) return cpu;
  }
  throw new Error("did not finish");
}

test("weekend window", () => {
  const w = D.weekendWindow(Date.UTC(2026, 10, 11, 12), "Europe/Bratislava");
  assert.equal(new Date(w.start).toISOString(), "2026-11-12T23:00:00.000Z"); // Fri 00:00 CET
  assert.equal(new Date(w.end).toISOString(), "2026-11-16T05:00:00.000Z");   // Mon 06:00 CET
  assert.equal(w.label, "13.–15. 11. 2026");
  const sat = D.weekendWindow(Date.UTC(2026, 10, 14, 9), "Europe/Bratislava");
  assert.equal(new Date(sat.start).toISOString(), "2026-11-12T23:00:00.000Z");
  const mon = D.weekendWindow(Date.UTC(2026, 10, 16, 9), "Europe/Bratislava");
  assert.equal(new Date(mon.start).toISOString(), "2026-11-19T23:00:00.000Z");
  const summer = D.weekendWindow(Date.UTC(2026, 6, 1, 9), "Europe/Bratislava");
  assert.equal(new Date(summer.start).toISOString(), "2026-07-02T22:00:00.000Z"); // CEST
});

test("model recovers synthetic strengths incrementally", () => {
  const r = ((s) => () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32))(3);
  const pois = (l) => { const L = Math.exp(-l); let k = 0, p = 1; for (;;) { p *= r(); if (p <= L) return k; k++; } };
  const att = {}, dfn = {};
  for (let t = 0; t < 12; t++) { att[t] = r() * 0.8 - 0.4; dfn[t] = r() * 0.8 - 0.4; }
  const rows = [];
  for (let k = 0; k < 12; k++) for (let h = 0; h < 12; h++) for (let a = 0; a < 12; a++) if (h !== a) {
    const lh = Math.exp(Math.log(1.3) + 0.25 + att[h] - dfn[a]), la = Math.exp(Math.log(1.3) + att[a] - dfn[h]);
    rows.push([h, a, pois(lh), pois(la), 1, 39, 0]);
  }
  let p = M.initParams(rows);
  for (let i = 0; i < 30 && !p.converged; i++) p = M.fitSweeps(rows, p, { maxSweeps: 10 });
  assert.ok(p.converged, "converges within 30 short steps");
  let err = 0, n = 0;
  for (let h = 0; h < 12; h++) for (let a = 0; a < 12; a++) if (h !== a) {
    const truth = Math.exp(Math.log(1.3) + 0.25 + att[h] - dfn[a]);
    err += Math.abs(M.lambdas(p, h, a, 39)[0] - truth) / truth; n++;
  }
  assert.ok(err / n < 0.12, `mean rel. error ${err / n}`);
  assert.ok(Math.abs(p.homeAdv - 0.25) < 0.12);
});

test("summaries are proper distributions", () => {
  const s = M.summarize(1.6, 1.1);
  assert.ok(Math.abs(s.p_home + s.p_draw + s.p_away - 1) < 0.002);
  assert.equal(s.pick, "1");
  const e = M.summarize(1.3, 1.3);
  assert.ok(Math.abs(e.p_home - e.p_away) < 1e-3);
});

const ESPN_ONLY = { ANTHROPIC_API_KEY: "a", ANALYST_MAX_MATCHES: "100" };

test("ESPN-only run: tabs, stats, odds, analyst clamp, cache, track record", async () => {
  const world = makeWorld(NOW);
  const counter = { n: 0 };
  const storage = new FakeStorage();
  const runner = new Runner(storage, ESPN_ONLY, { fetch: world.fetchImpl, makeClient: () => fakeClaude(counter), now: () => NOW });
  await runAll(runner);
  const pred = JSON.parse(await storage.get("out:predictions"));
  const meta = JSON.parse(await storage.get("out:meta"));
  const tabs = new Set(pred.matches.flatMap((m) => m.tabs));
  for (const t of ["weekend", "nations_league", "interesting"]) assert.ok(tabs.has(t), `tab ${t}; warnings: ${meta.warnings}`);
  assert.ok(meta.model.converged.club, "club fit converged");
  assert.match(meta.sources["Premier League"], /ESPN/);
  assert.ok(pred.matches.some((m) => m.form.home.sot != null), "shots from ESPN statistics");
  assert.ok(pred.matches.some((m) => m.odds && m.odds.implied), "odds from ESPN");
  const nl = pred.matches.filter((m) => m.tabs.includes("nations_league"));
  assert.ok(nl.every((m) => /^Kolo /.test(m.round) && m.group), "NL rounds + groups");
  for (const m of pred.matches) {
    const f = m.final;
    assert.ok(Math.abs(f.p_home + f.p_draw + f.p_away - 1) < 0.01);
    if (m.analyst) {
      assert.equal(m.analyst.xg_mult_home, 1.15); // 1.5 clamped
      assert.equal(m.analyst.absences[0].source_url, ""); // javascript: URL dropped
    }
  }
  assert.ok(pred.matches.some((m) => m.analyst), "some matches analysed");
  assert.ok(pred.matches.every((m) => Array.isArray(m.news)) && pred.matches.some((m) => m.news.length), "competition headlines attached");
  assert.ok(meta.analyst.est_cost_usd > 0);
  const found = await runner.find(pred.matches[0].home.name);
  assert.ok(found.length > 0 && found[0].fixture_id, "find-fixtures helper");
  // second run: old months cached, no re-analysis
  const before = world.calls.length, analysed = counter.n;
  await runAll(runner);
  assert.equal(counter.n - analysed, 0, "cached analyses reused");
  assert.ok(world.calls.length - before < 30, `mostly cached: ${world.calls.length - before} calls`);
  assert.ok(Object.keys(await storage.get("history") ? JSON.parse(await storage.get("history")) : {}).length > 0);
});

test("ESPN down for a league -> football-data.org fallback", async () => {
  const world = makeWorld(NOW);
  world.limits.espnDown.add("ger.1");
  const storage = new FakeStorage();
  const runner = new Runner(storage, { FOOTBALL_DATA_KEY: "fd" }, { fetch: world.fetchImpl, now: () => NOW });
  await runAll(runner);
  const meta = JSON.parse(await storage.get("out:meta"));
  const pred = JSON.parse(await storage.get("out:predictions"));
  assert.match(meta.sources.Bundesliga, /football-data\.org/);
  assert.ok(pred.matches.some((m) => m.comp === "bundesliga" && m.tabs.includes("weekend")), "Bundesliga still in weekend tab");
  assert.ok(world.calls.some((c) => c.startsWith("api.football-data.org/v4/competitions/BL1")));
});

test("ESPN + football-data down -> API-Football for allowed seasons, warning otherwise", async () => {
  const world = makeWorld(NOW);
  world.limits.espnDown.add("uefa.nations");
  world.limits.rateLimitNext = 1;
  const storage = new FakeStorage();
  const runner = new Runner(storage, { API_FOOTBALL_KEY: "k" }, { fetch: world.fetchImpl, now: () => NOW });
  const delays = [];
  await runner.start("t");
  for (let i = 0; i < 2000; i++) { const d = await runner.tick(); if (d === null) break; delays.push(d); }
  const meta = JSON.parse(await storage.get("out:meta"));
  assert.match(meta.sources["UEFA Nations League"], /API-Football \(2024\)/);
  assert.ok(meta.warnings.some((w) => w.includes("UEFA Nations League 2026")), "2026 not available on free plan -> warning");
  assert.equal(delays.filter((d) => d === 61000).length, 1, "rate limit -> retry after a minute");
});

test("pinned fixture far in the future is predicted and shown", async () => {
  const world = makeWorld(NOW);
  const future = world.leagues["39:2026"].filter((f) => Date.parse(f.fixture.date) > NOW + 30 * 864e5 && Date.parse(f.fixture.date) < NOW + 55 * 864e5)[0];
  assert.ok(future, "fake has a fixture 30-55 days ahead");
  const storage = new FakeStorage();
  const runner = new Runner(storage, { EXTRA_FIXTURE_IDS: String(future.fixture.id) }, { fetch: world.fetchImpl, now: () => NOW });
  await runAll(runner);
  const pred = JSON.parse(await storage.get("out:predictions"));
  const m = pred.matches.find((x) => x.id === future.fixture.id);
  assert.ok(m && m.extra && m.tabs.includes("interesting"));
});

test("international break: weekend tab moves to the next weekend with PL/BL matches", async () => {
  const world = makeWorld(NOW);
  const fri = Date.UTC(2026, 10, 12, 23), mon = Date.UTC(2026, 10, 16, 5);
  for (const k of ["39:2026", "78:2026"]) world.leagues[k] = world.leagues[k].filter((f) => { const t = Date.parse(f.fixture.date); return t < fri || t > mon; });
  const storage = new FakeStorage();
  const runner = new Runner(storage, {}, { fetch: world.fetchImpl, now: () => NOW });
  await runAll(runner);
  const pred = JSON.parse(await storage.get("out:predictions"));
  const meta = JSON.parse(await storage.get("out:meta"));
  assert.equal(meta.weekend.label, "20.–22. 11. 2026");
  assert.ok(pred.matches.some((m) => m.tabs.includes("weekend")));
});

test("automatic runs: Fri-Mon only, 1-2 h before the first PL/BL kick-off, once per day; NL not analysed", async () => {
  const world = makeWorld(NOW);
  // first PL/BL match on Saturday 14 Nov (local)
  const sat = [...world.leagues["39:2026"], ...world.leagues["78:2026"]]
    .map((f) => Date.parse(f.fixture.date)).filter((t) => D.localDate(t, "Europe/Bratislava") === "2026-11-14").sort((a, b) => a - b)[0];
  assert.ok(sat, "fake has PL/BL matches on Saturday");
  let now = NOW; // Wednesday
  const storage = new FakeStorage();
  const counter = { n: 0, nl: 0 };
  const client = () => {
    const c = fakeClaude(counter);
    const f = async (p) => { if (/UEFA Nations League/.test(p.messages[0].content)) counter.nl++; return c.messages.create(p); };
    return { beta: { messages: { create: f } }, messages: { create: f } };
  };
  const runner = new Runner(storage, { ANTHROPIC_API_KEY: "a", ANALYST_MAX_MATCHES: "100" }, { fetch: world.fetchImpl, makeClient: client, now: () => now });
  assert.equal((await runner.autoCheck()).started, false, "Wednesday: no automatic run");
  now = sat - 3 * 3600e3;
  assert.equal((await runner.autoCheck()).started, false, "3 h before: too early");
  now = sat - 100 * 60e3;
  const res = await runner.autoCheck();
  assert.equal(res.started, true, JSON.stringify(res));
  for (let i = 0; i < 2000; i++) if ((await runner.tick()) === null) break;
  const job = await storage.get("job");
  assert.equal(job.kind, "auto");
  assert.equal(counter.nl, 0, "Nations League not analysed automatically");
  assert.ok(counter.n > 0, "weekend matches analysed");
  now = sat - 70 * 60e3;
  assert.equal((await runner.autoCheck()).started, false, "only once per day");
});

test("no analyst key -> model only, with a warning", async () => {
  const world = makeWorld(NOW);
  const storage = new FakeStorage();
  const runner = new Runner(storage, {}, { fetch: world.fetchImpl, now: () => NOW });
  await runAll(runner);
  const meta = JSON.parse(await storage.get("out:meta"));
  assert.ok(meta.warnings.some((w) => w.includes("ANTHROPIC_API_KEY")));
  assert.equal(meta.analyst.enabled, false);
});

test("CPU per step stays small at realistic data size (free plan ~10 ms)", async () => {
  const world = makeWorld(NOW, { heavy: true });
  const storage = new FakeStorage();
  const runner = new Runner(storage, ESPN_ONLY, { fetch: world.fetchImpl, makeClient: () => fakeClaude(), now: () => NOW });
  await runAll(runner); // warm-up (JIT) + fills storage
  const cpu = await runAll(runner, { measure: true });
  const worst = {};
  for (const c of cpu) worst[c.step] = Math.max(worst[c.step] || 0, Math.round(c.ms * 10) / 10);
  console.log("max CPU ms per step type:", JSON.stringify(worst));
  assert.ok(Math.max(...Object.values(worst)) < 60);
});

test("analyst system prompt lists the preferred sources (configurable)", async () => {
  const { settings } = await import("../src/config.js");
  const AN = await import("../src/analyst.js");
  const seen = [];
  const tools = [];
  const client = { beta: { messages: { create: async (p) => { seen.push(p.system[0].text); tools.push(p.tools.map((x) => x.name)); return { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: JSON.stringify({ xg_mult_home: 1, xg_mult_away: 1, summary: "", key_factors: [], absences: [], lineups_confirmed: false, data_gaps: [] }) }] }; } } } };
  await AN.analyseMatch(client, {}, settings({}), { match: {} }, "2026-11-15");
  assert.match(seen[0], /uefa\.com/);
  assert.deepEqual(tools[0], ["web_search", "web_fetch"]);
  assert.match(seen[0], /footballwebpages\.co\.uk/);
  assert.doesNotMatch(seen[0], /notjustok|krisyotam/);
  await AN.analyseMatch(client, {}, settings({ ANALYST_PREFERRED_SOURCES: "example.org" }), { match: {} }, "2026-11-15");
  assert.match(seen[1], /example\.org/);
});

test("score tip agrees with the most likely outcome; market blend reproduces target probabilities", () => {
  const s = M.summarize(1.1, 1.45); // away favourite, overall modal score is 1-1
  assert.equal(s.pick, "2");
  const [h, a] = s.score.split("-").map(Number);
  assert.ok(a > h, `tip ${s.score} must be an away win`);
  const target = [0.24, 0.26, 0.5];
  const [lh, la] = M.fitToProbs(target, 1.3, 1.3);
  const p = M.outcomeProbs(lh, la);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(p[k] - target[k]) < 0.01, `${p} vs ${target}`);
  const pred = { ...M.summarize(1.6, 1.0), n_eff_home: 20, n_eff_away: 20 };
  const b = M.blendWithMarket(pred, { home: 0.3, draw: 0.3, away: 0.4 }, 0.35);
  const want = 0.35 * pred.p_home + 0.65 * 0.3;
  assert.ok(Math.abs(b.p_home - want) < 0.01, `${b.p_home} vs ${want}`);
});
