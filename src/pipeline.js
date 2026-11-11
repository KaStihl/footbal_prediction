// Durable Object wrapper around Runner: strongly consistent state + alarms that drive the steps.

import { DurableObject } from "cloudflare:workers";
import { Runner, brief } from "./runner.js";

export class Pipeline extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.runner = new Runner(ctx.storage, env);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    const m = url.pathname.match(/^\/data\/(predictions|meta|track)\.json$/);
    if (m) {
      const body = await this.ctx.storage.get(`out:${m[1]}`);
      return body ? new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }) : json({ error: "no data yet" }, 404);
    }
    if (url.pathname === "/start" && request.method === "POST") {
      const { kind = "manual" } = await request.json().catch(() => ({}));
      const res = await this.runner.start(kind);
      if (res.started) await this.ctx.storage.setAlarm(Date.now() + 100);
      return json(res);
    }
    if (url.pathname === "/status") {
      const job = await this.ctx.storage.get("job");
      return json(job ? { ...brief(job), last_warnings: job.warnings.slice(-10) } : { job: null });
    }
    return json({ error: "not found" }, 404);
  }

  async alarm() {
    const delay = await this.runner.tick();
    if (delay !== null) await this.ctx.storage.setAlarm(Date.now() + delay);
  }
}
