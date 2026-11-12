// Entry point: password gate + routes + cron.
//   /data/*.json    -> pipeline output stored in the Durable Object
//   POST /api/run   -> start a run now        GET /api/status -> progress of the current/last run
//   everything else -> static files in ./site
// Cron triggers (wrangler.jsonc) start the daily run; the Durable Object then works step by step.

import { gate } from "./auth.js";
import { Pipeline } from "./pipeline.js";

export { Pipeline };

const pipeline = (env) => env.PIPELINE.get(env.PIPELINE.idFromName("main"));

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
      return pipeline(env).fetch(new Request(`https://pipeline/find?team=${encodeURIComponent(url.searchParams.get("team") || "")}`));
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
