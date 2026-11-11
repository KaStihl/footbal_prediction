// Track record (port of pipeline/track.py): freeze the last pre-kickoff prediction, grade after full time.

import { HISTORY_KEEP } from "./config.js";
import { brier, logLoss } from "./model.js";

const outcome = (hg, ag) => (hg > ag ? 0 : hg === ag ? 1 : 2);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

export function updateHistory(history, entries, nowMs) {
  for (const e of entries) {
    if (Date.parse(e.kickoff) <= nowMs || !["NS", "TBD"].includes(e.status)) continue;
    const f = e.final, m = e.model;
    history[e.id] = {
      id: e.id, kickoff: e.kickoff, comp: e.comp, competition: e.competition, home: e.home.name, away: e.away.name,
      pred: { p_home: f.p_home, p_draw: f.p_draw, p_away: f.p_away, p_over25: f.p_over25, p_btts: f.p_btts, score: f.score, xg_home: f.xg_home, xg_away: f.xg_away },
      model_only: { p_home: m.p_home, p_draw: m.p_draw, p_away: m.p_away, score: m.score },
      had_analyst: Boolean(e.analyst), odds: e.odds ? e.odds.implied : null, tabs: e.tabs,
      frozen_at: new Date(nowMs).toISOString(), result: null,
    };
  }
  return history;
}

export function attachResults(history, results) {
  let n = 0;
  for (const [id, e] of Object.entries(history)) {
    if (!e.result && results[id]) { e.result = { hg: results[id][0], ag: results[id][1] }; n++; }
  }
  return n;
}

/** Keep pending predictions plus the newest HISTORY_KEEP graded ones. */
export function pruneHistory(history) {
  const graded = Object.values(history).filter((e) => e.result).sort((a, b) => (a.kickoff < b.kickoff ? 1 : -1));
  for (const e of graded.slice(HISTORY_KEEP)) delete history[e.id];
  return history;
}

function grade(entries) {
  const g = entries.filter((e) => e.result);
  const n = g.length;
  if (!n) return { n: 0 };
  let hit = 0, exact = 0, br = 0, ll = 0, brm = 0, nm = 0, brk = 0, llk = 0, hitk = 0;
  for (const e of g) {
    const o = outcome(e.result.hg, e.result.ag);
    const p = [e.pred.p_home, e.pred.p_draw, e.pred.p_away];
    if (p.indexOf(Math.max(...p)) === o) hit++;
    if (e.pred.score === `${e.result.hg}-${e.result.ag}`) exact++;
    br += brier(p, o); ll += logLoss(p, o);
    brm += brier([e.model_only.p_home, e.model_only.p_draw, e.model_only.p_away], o);
    if (e.odds) {
      const q = [e.odds.home, e.odds.draw, e.odds.away];
      nm++; brk += brier(q, o); llk += logLoss(q, o);
      if (q.indexOf(Math.max(...q)) === o) hitk++;
    }
  }
  const out = { n, hit_1x2: r4(hit / n), hit_exact: r4(exact / n), brier: r4(br / n), brier_model_only: r4(brm / n), log_loss: r4(ll / n) };
  if (nm) out.market = { n: nm, hit_1x2: r4(hitk / nm), brier: r4(brk / nm), log_loss: r4(llk / nm) };
  return out;
}

export function summarize(history) {
  const entries = Object.values(history);
  const comps = [...new Set(entries.map((e) => e.comp).filter(Boolean))].sort();
  const recent = entries.filter((e) => e.result).sort((a, b) => (a.kickoff < b.kickoff ? 1 : -1)).slice(0, 40);
  return {
    overall: grade(entries),
    by_competition: Object.fromEntries(comps.map((c) => [c, grade(entries.filter((e) => e.comp === c))])),
    pending: entries.filter((e) => !e.result).length,
    recent: recent.map((e) => ({
      id: e.id, kickoff: e.kickoff, competition: e.competition, home: e.home, away: e.away, pred_score: e.pred.score,
      p: [e.pred.p_home, e.pred.p_draw, e.pred.p_away], result: `${e.result.hg}-${e.result.ag}`,
    })),
  };
}
