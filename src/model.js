// Statistical core (port of pipeline/model.py): time-weighted, ridge-shrunk Poisson
// attack/defence strengths + Dixon-Coles scoreline matrix. Fitting is incremental:
// `fitSweeps` continues from previous parameters, so the work can be split across
// several short invocations (Workers free plan: ~10 ms CPU per invocation).

import { DC_RHO, MAX_GOALS, RIDGE } from "./config.js";

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// rows: [home, away, yh, ya, w, comp, neutral(0|1)]
export function emptyParams() {
  return { att: {}, dfn: {}, mu: {}, muDefault: Math.log(1.3), homeAdv: 0.2, nEff: {}, nGames: {}, sweeps: 0, converged: false, lastStep: null };
}

export function initParams(rows, prev) {
  const p = prev ? structuredClone(prev) : emptyParams();
  let tw = 0, ty = 0;
  const nEff = {}, nGames = {};
  for (const r of rows) {
    tw += r[4];
    ty += r[4] * (r[2] + r[3]);
    for (const t of [r[0], r[1]]) {
      nEff[t] = (nEff[t] || 0) + r[4];
      nGames[t] = (nGames[t] || 0) + 1;
    }
    if (!(r[0] in p.att)) { p.att[r[0]] = 0; p.dfn[r[0]] = 0; }
    if (!(r[1] in p.att)) { p.att[r[1]] = 0; p.dfn[r[1]] = 0; }
  }
  const mean = tw ? Math.max(ty / (2 * tw), 0.2) : 1.3;
  if (!prev) p.muDefault = Math.log(mean);
  for (const r of rows) if (!(r[5] in p.mu)) p.mu[r[5]] = Math.log(mean);
  p.nEff = nEff;
  p.nGames = nGames;
  p.converged = false;
  return p;
}

/** Run up to `maxSweeps` block coordinate Newton sweeps in place. Returns params. */
export function fitSweeps(rows, p, { maxSweeps = 12, ridge = RIDGE, tol = 1e-4 } = {}) {
  if (!rows.length) { p.converged = true; return p; }
  const teams = Object.keys(p.att);
  const ti = new Map(teams.map((t, i) => [String(t), i]));
  const comps = Object.keys(p.mu);
  const ci = new Map(comps.map((c, i) => [String(c), i]));
  const n = rows.length;
  const H = new Int32Array(n), A = new Int32Array(n), C = new Int32Array(n), N = new Uint8Array(n);
  const YH = new Float64Array(n), YA = new Float64Array(n), W = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const r = rows[k];
    H[k] = ti.get(String(r[0])); A[k] = ti.get(String(r[1])); C[k] = ci.get(String(r[5]));
    YH[k] = r[2]; YA[k] = r[3]; W[k] = r[4]; N[k] = r[6] ? 1 : 0;
  }
  const att = Float64Array.from(teams, (t) => p.att[t]);
  const dfn = Float64Array.from(teams, (t) => p.dfn[t]);
  const mu = Float64Array.from(comps, (c) => p.mu[c]);
  let ha = p.homeAdv;
  const T = teams.length, K = comps.length;
  const g = new Float64Array(Math.max(T, K)), h = new Float64Array(Math.max(T, K));

  // Expected goals are recomputed inline in every pass (no allocations: this is the hot loop).
  let maxStep = Infinity;
  let s = 0;
  for (; s < maxSweeps && maxStep > tol; s++) {
    maxStep = 0;
    // attack
    g.fill(0); h.fill(0);
    for (let k = 0; k < n; k++) {
      const hi = H[k], ai = A[k], base = mu[C[k]];
      const lh = Math.exp(base + (N[k] ? 0 : ha) + att[hi] - dfn[ai]);
      const la = Math.exp(base + att[ai] - dfn[hi]);
      const w = W[k];
      g[hi] += w * (YH[k] - lh); h[hi] += w * lh;
      g[ai] += w * (YA[k] - la); h[ai] += w * la;
    }
    for (let t = 0; t < T; t++) {
      const step = clamp((g[t] - ridge * att[t]) / (h[t] + ridge), -0.5, 0.5);
      att[t] += step; if (Math.abs(step) > maxStep) maxStep = Math.abs(step);
    }
    // defence (positive = strong)
    g.fill(0); h.fill(0);
    for (let k = 0; k < n; k++) {
      const hi = H[k], ai = A[k], base = mu[C[k]];
      const lh = Math.exp(base + (N[k] ? 0 : ha) + att[hi] - dfn[ai]);
      const la = Math.exp(base + att[ai] - dfn[hi]);
      const w = W[k];
      g[hi] += w * (la - YA[k]); h[hi] += w * la;
      g[ai] += w * (lh - YH[k]); h[ai] += w * lh;
    }
    for (let t = 0; t < T; t++) {
      const step = clamp((g[t] - ridge * dfn[t]) / (h[t] + ridge), -0.5, 0.5);
      dfn[t] += step; if (Math.abs(step) > maxStep) maxStep = Math.abs(step);
    }
    // competition baselines + home advantage
    g.fill(0); h.fill(0);
    let gh = 0, hh = 1e-6;
    for (let k = 0; k < n; k++) {
      const hi = H[k], ai = A[k], c = C[k], base = mu[c];
      const lh = Math.exp(base + (N[k] ? 0 : ha) + att[hi] - dfn[ai]);
      const la = Math.exp(base + att[ai] - dfn[hi]);
      const w = W[k];
      g[c] += w * (YH[k] - lh + YA[k] - la); h[c] += w * (lh + la);
      if (!N[k]) { gh += w * (YH[k] - lh); hh += w * lh; }
    }
    for (let c = 0; c < K; c++) {
      if (h[c] <= 0) continue;
      const step = clamp(g[c] / (h[c] + 1e-6), -0.3, 0.3);
      mu[c] += step; if (Math.abs(step) > maxStep) maxStep = Math.abs(step);
    }
    const sh = clamp(gh / hh, -0.3, 0.3);
    ha += sh; if (Math.abs(sh) > maxStep) maxStep = Math.abs(sh);
  }
  // centre so that an average team is 0 and mu keeps its meaning
  const ma = att.reduce((a, b) => a + b, 0) / T;
  const md = dfn.reduce((a, b) => a + b, 0) / T;
  teams.forEach((t, i) => { p.att[t] = att[i] - ma; p.dfn[t] = dfn[i] - md; });
  comps.forEach((c, i) => { p.mu[c] = mu[i] + ma - md; });
  p.muDefault += ma - md;
  p.homeAdv = ha;
  p.sweeps += s;
  p.lastStep = maxStep;
  p.converged = maxStep <= tol;
  return p;
}

export function lambdas(p, home, away, comp, neutral = false) {
  const mu = p.mu[comp] ?? p.muDefault;
  const ha = neutral ? 0 : p.homeAdv;
  return [
    Math.exp(mu + ha + (p.att[home] || 0) - (p.dfn[away] || 0)),
    Math.exp(mu + (p.att[away] || 0) - (p.dfn[home] || 0)),
  ];
}

function poissonPmf(lam, kmax) {
  const out = [Math.exp(-lam)];
  for (let k = 1; k <= kmax; k++) out.push((out[k - 1] * lam) / k);
  return out;
}

function tau(i, j, lh, la, rho) {
  if (i === 0 && j === 0) return 1 - lh * la * rho;
  if (i === 0 && j === 1) return 1 + lh * rho;
  if (i === 1 && j === 0) return 1 + la * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

export function scoreMatrix(lh, la, rho = DC_RHO, kmax = MAX_GOALS) {
  const ph = poissonPmf(lh, kmax), pa = poissonPmf(la, kmax);
  const m = [];
  let total = 0;
  for (let i = 0; i <= kmax; i++) {
    m.push([]);
    for (let j = 0; j <= kmax; j++) {
      const v = ph[i] * pa[j] * Math.max(tau(i, j, lh, la, rho), 0);
      m[i].push(v);
      total += v;
    }
  }
  return m.map((row) => row.map((v) => v / total));
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;

export function summarize(lh, la, nMin = 10) {
  const m = scoreMatrix(lh, la);
  const k = m.length;
  let ph = 0, pd = 0, pa = 0, over = 0, btts = 0;
  const cells = [];
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const v = m[i][j];
      if (i > j) ph += v; else if (i === j) pd += v; else pa += v;
      if (i + j >= 3) over += v;
      if (i >= 1 && j >= 1) btts += v;
      cells.push([v, i, j]);
    }
  }
  cells.sort((a, b) => b[0] - a[0]);
  const maxp = Math.max(ph, pd, pa);
  const confidence = nMin < 4 || maxp < 0.42 ? "low" : maxp >= 0.6 && nMin >= 8 ? "high" : "medium";
  return {
    xg_home: Math.round(lh * 1000) / 1000, xg_away: Math.round(la * 1000) / 1000,
    p_home: r4(ph), p_draw: r4(pd), p_away: r4(pa), p_over25: r4(over), p_btts: r4(btts),
    score: `${cells[0][1]}-${cells[0][2]}`,
    top_scores: cells.slice(0, 3).map(([v, i, j]) => ({ score: `${i}-${j}`, p: r4(v) })),
    pick: ph >= Math.max(pd, pa) ? "1" : pd >= pa ? "X" : "2",
    confidence,
  };
}

export function predict(p, home, away, comp, neutral = false) {
  const [lh, la] = lambdas(p, home, away, comp, neutral);
  const nh = p.nEff[home] || 0, na = p.nEff[away] || 0;
  return { ...summarize(lh, la, Math.min(nh, na)), n_eff_home: Math.round(nh * 10) / 10, n_eff_away: Math.round(na * 10) / 10 };
}

export function impliedProbs(oh, od, oa) {
  const raw = [1 / oh, 1 / od, 1 / oa];
  const total = raw[0] + raw[1] + raw[2];
  return { home: raw[0] / total, draw: raw[1] / total, away: raw[2] / total, margin: total - 1 };
}

export const brier = (p, o) => p.reduce((s, v, k) => s + (v - (k === o ? 1 : 0)) ** 2, 0);
export const logLoss = (p, o) => -Math.log(Math.max(p[o], 1e-9));
