// HTTP Basic password gate. The password is the SITE_PASSWORD secret; the username is ignored.
// Fails closed: without the secret nothing is served.

const REALM = 'Basic realm="Predikcie", charset="UTF-8"';
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// Constant-time comparison of the SHA-256 digests (equal length, no early exit).
async function safeEqual(a, b) {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

function passwordFrom(request) {
  const header = request.headers.get("Authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "basic" || !encoded) return null;
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
    const i = decoded.indexOf(":");
    return i < 0 ? null : decoded.slice(i + 1);
  } catch {
    return null;
  }
}

/** Returns a 401/503 Response when the request is not allowed, or null when it may pass. */
export async function gate(request, env) {
  if (!env.SITE_PASSWORD) {
    return new Response("Site is not configured (missing SITE_PASSWORD secret).", { status: 503, headers });
  }
  const given = passwordFrom(request);
  if (given === null || !(await safeEqual(given, env.SITE_PASSWORD))) {
    return new Response("Authentication required.", { status: 401, headers: { ...headers, "WWW-Authenticate": REALM } });
  }
  return null;
}
