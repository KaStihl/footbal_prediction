// Password gate in front of the static site (free alternative to Cloudflare Access).
// Every request must carry HTTP Basic credentials whose password equals the
// SITE_PASSWORD secret. If the secret is not configured the site stays closed.
// The username is ignored. Static files are served through the ASSETS binding.

const REALM = 'Basic realm="Predikcie", charset="UTF-8"';

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

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

export default {
  async fetch(request, env) {
    if (!env.SITE_PASSWORD) {
      return new Response("Site is not configured (missing SITE_PASSWORD secret).", { status: 503, headers });
    }
    const given = passwordFrom(request);
    if (given === null || !(await safeEqual(given, env.SITE_PASSWORD))) {
      return new Response("Authentication required.", { status: 401, headers: { ...headers, "WWW-Authenticate": REALM } });
    }
    return env.ASSETS.fetch(request);
  },
};
