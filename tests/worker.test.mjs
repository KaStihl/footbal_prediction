import test from "node:test";
import assert from "node:assert/strict";
import { gate } from "../src/auth.js";

const assets = { fetch: async () => new Response("<html>ok</html>", { status: 200 }) };
const auth = (pw, user = "x") => ({ Authorization: "Basic " + Buffer.from(`${user}:${pw}`).toString("base64") });
const call = async (headers = {}, env = { SITE_PASSWORD: "s3cret!", ASSETS: assets }) => {
  const req = new Request("https://example.test/data/predictions.json", { headers });
  return (await gate(req, env)) || env.ASSETS.fetch(req);
};

test("no credentials -> 401 with challenge", async () => {
  const r = await call();
  assert.equal(r.status, 401);
  assert.match(r.headers.get("WWW-Authenticate"), /^Basic/);
});

test("wrong password -> 401", async () => {
  assert.equal((await call(auth("nope"))).status, 401);
});

test("correct password (any username, colon in password) -> assets", async () => {
  assert.equal((await call(auth("s3cret!", "anyone"))).status, 200);
  const env = { SITE_PASSWORD: "a:b:c", ASSETS: assets };
  assert.equal((await call(auth("a:b:c"), env)).status, 200);
});

test("malformed header -> 401, not an exception", async () => {
  assert.equal((await call({ Authorization: "Basic %%%not-base64" })).status, 401);
  assert.equal((await call({ Authorization: "Bearer abc" })).status, 401);
});

test("missing secret fails closed", async () => {
  const r = await call(auth(""), { ASSETS: assets });
  assert.equal(r.status, 503);
  const r2 = await call(auth("anything"), { SITE_PASSWORD: "", ASSETS: assets });
  assert.equal(r2.status, 503);
});
