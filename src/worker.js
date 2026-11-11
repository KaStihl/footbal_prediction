// Entry point: password gate + routes + cron.
//   /data/*.json    -> pipeline output stored in the Durable Object
//   POST /api/run   -> start a run now        GET /api/status -> progress of the current/last run
//   everything else -> static files in ./site
// Cron triggers (wrangler.jsonc) start the daily run; the Durable Object then works step by step.

import { gate } from "./auth.js";
import { ApiError, apiGet } from "./api.js";
import { settings } from "./config.js";
import { Pipeline } from "./pipeline.js";

export { Pipeline };

const pipeline = (env) => env.PIPELINE.get(env.PIPELINE.idFromName("main"));

/** Helper for EXTRA_FIXTURE_IDS: next fixtures of a team found by name (2 API-Football calls). */
async function findFixtures(team, env) {
  const cfg = settings(env);
  const json = (o, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  if (team.trim().length < 3) return json({ error: "použi ?team=Názov (aspoň 3 znaky), napr. /api/find-fixtures?team=Slovakia" }, 400);
  try {
    const teams = (await apiGet(cfg.apiKey, "/teams", { search: team.trim() }, fetch, cfg.apiBase)).response;
    if (!teams.length) return json({ error: "tím sa nenašiel" }, 404);
    const t = teams[0].team;
    const fx = (await apiGet(cfg.apiKey, "/fixtures", { team: t.id, next: 10, timezone: "UTC" }, fetch, cfg.apiBase)).response;
    return json({
      team: { id: t.id, name: t.name, country: t.country }, other_matches: teams.slice(1, 5).map((x) => x.team.name),
      hint: "ID zápasu (fixture_id) pridaj do premennej EXTRA_FIXTURE_IDS vo Workeri (čiarkami oddelené).",
      fixtures: fx.map((f) => ({ fixture_id: f.fixture.id, kickoff_utc: f.fixture.date, match: `${f.teams.home.name} - ${f.teams.away.name}`, competition: f.league.name })),
    });
  } catch (e) {
    return json({ error: e instanceof ApiError ? e.message : "chyba" }, 502);
  }
}

export default {
  async fetch(request, env) {
    const denied = await gate(request, env);
    if (denied) return denied;
    const url = new URL(request.url);
    if (/^\/data\/(predictions|meta|track)\.json$/.test(url.pathname)) {
      return pipeline(env).fetch(new Request(`https://pipeline${url.pathname}`));
    }
    if (url.pathname === "/api/run" && request.method === "POST") {
      return pipeline(env).fetch(new Request("https://pipeline/start", { method: "POST", body: JSON.stringify({ kind: "manual" }) }));
    }
    if (url.pathname === "/api/find-fixtures") {
      return findFixtures(url.searchParams.get("team") || "", env);
    }
    if (url.pathname === "/api/status") {
      return pipeline(env).fetch(new Request("https://pipeline/status"));
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pipeline(env).fetch(new Request("https://pipeline/start", { method: "POST", body: JSON.stringify({ kind: "cron" }) })));
  },
};
