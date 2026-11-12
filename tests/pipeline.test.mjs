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

test("end-to-end run with fakes: tabs, analyst clamp, cache, track record", async () => {
  const world = makeWorld(NOW);
  const counter = { n: 0 };
  const storage = new FakeStorage();
  const env = { API_FOOTBALL_KEY: "k", ANTHROPIC_API_KEY: "a", API_FOOTBALL_MAX_CALLS: "400", STATS_MAX_CALLS: "50", ANALYST_MAX_MATCHES: "100" };
  const runner = new Runner(storage, env, { fetch: world.fetchImpl, makeClient: () => fakeClaude(counter), now: () => NOW });
  await runAll(runner);
  const pred = JSON.parse(await storage.get("out:predictions"));
  const meta = JSON.parse(await storage.get("out:meta"));
  const tabs = new Set(pred.matches.flatMap((m) => m.tabs));
  for (const t of ["weekend", "nations_league", "interesting"]) assert.ok(tabs.has(t), `tab ${t}; warnings: ${meta.warnings}`);
  assert.ok(meta.model.converged.club, "club fit converged");
  for (const m of pred.matches) {
    const f = m.final;
    assert.ok(Math.abs(f.p_home + f.p_draw + f.p_away - 1) < 0.01);
    if (m.analyst) {
      assert.equal(m.analyst.xg_mult_home, 1.15); // 1.5 clamped
      assert.equal(m.analyst.absences[0].source_url, ""); // javascript: URL dropped
    }
    if (m.odds) assert.ok(m.odds.edge);
  }
  assert.ok(pred.matches.some((m) => m.analyst), "some matches analysed");
  assert.ok(meta.analyst.est_cost_usd > 0);
  const firstCalls = counter.n;
  // second run: inputs unchanged -> no re-analysis, fixtures cached (ttl)
  const apiBefore = world.calls.length;
  await runAll(runner);
  const analystCalls = counter.n - firstCalls;
  assert.equal(analystCalls, 0, "cached analyses reused");
  assert.equal(world.calls.slice(apiBefore).filter((c) => c.startsWith("/fixtures?league")).length, 0, "fixtures served from storage within ttl");
  const history = await storage.get("history");
  assert.ok(Object.keys(history).length > 0);
});

test("manually added fixture far in the future is predicted and shown", async () => {
  const world = makeWorld(NOW);
  const future = world.leagues[`39:2026`].filter((f) => Date.parse(f.fixture.date) > NOW + 30 * 864e5)[0];
  assert.ok(future, "fake has a fixture > 30 days ahead");
  const storage = new FakeStorage();
  const runner = new Runner(storage, { API_FOOTBALL_KEY: "k", API_FOOTBALL_MAX_CALLS: "400", EXTRA_FIXTURE_IDS: String(future.fixture.id) },
    { fetch: world.fetchImpl, now: () => NOW });
  await runAll(runner);
  const pred = JSON.parse(await storage.get("out:predictions"));
  const m = pred.matches.find((x) => x.id === future.fixture.id);
  assert.ok(m, "extra fixture present");
  assert.ok(m.extra && m.tabs.includes("interesting"));
});

test("rate limit retries the same step; plan block is reported", async () => {
  const world = makeWorld(NOW);
  world.limits.rateLimitNext = 2;
  world.limits.planBlockedSeasons.add(2025);
  const storage = new FakeStorage();
  const runner = new Runner(storage, { API_FOOTBALL_KEY: "k", API_FOOTBALL_MAX_CALLS: "400" }, { fetch: world.fetchImpl, now: () => NOW });
  const delays = [];
  await runner.start("t");
  for (let i = 0; i < 1000; i++) { const d = await runner.tick(); if (d === null) break; delays.push(d); }
  assert.equal(delays.filter((d) => d === 61000).length, 2, "two one-minute pauses");
  const meta = JSON.parse(await storage.get("out:meta"));
  assert.ok(!meta.warnings.some((w) => w.includes("rateLimit")), "rate-limited step was not skipped");
  assert.equal(meta.api.plan_blocked, true);
});

test("budget guard and failing API do not crash the run", async () => {
  const world = makeWorld(NOW);
  const storage = new FakeStorage();
  const runner = new Runner(storage, { API_FOOTBALL_KEY: "k", API_FOOTBALL_MAX_CALLS: "3" }, { fetch: world.fetchImpl, now: () => NOW });
  await runAll(runner);
  const meta = JSON.parse(await storage.get("out:meta"));
  assert.ok(meta.warnings.some((w) => w.includes("vyčerpaný")));
  assert.ok(meta.warnings.some((w) => w.includes("ANTHROPIC_API_KEY")));
  assert.ok(world.calls.length <= 3);
});

test("CPU per step stays small at realistic data size (free plan ~10 ms)", async () => {
  const world = makeWorld(NOW, { heavy: true });
  const storage = new FakeStorage();
  const env = { API_FOOTBALL_KEY: "k", ANTHROPIC_API_KEY: "a", API_FOOTBALL_MAX_CALLS: "400", STATS_MAX_CALLS: "8" };
  const runner = new Runner(storage, env, { fetch: world.fetchImpl, makeClient: () => fakeClaude(), now: () => NOW });
  await runAll(runner); // warm-up (JIT) + fills caches
  const cpu = await runAll(runner, { measure: true });
  const worst = {};
  for (const c of cpu) worst[c.step] = Math.max(worst[c.step] || 0, Math.round(c.ms * 10) / 10);
  console.log("max CPU ms per step type:", JSON.stringify(worst));
  // Node CPU time includes the fakes' JSON serialisation; only guard against regressions here.
  assert.ok(Math.max(...Object.values(worst)) < 60);
});
