// Minimal API-Football v3 client for Workers. Docs: https://www.api-football.com/documentation-v3

export const API_BASE = "https://v3.football.api-sports.io";

export class ApiError extends Error {}
export class PlanError extends ApiError {}
/** Per-minute limit hit: retry the same request after a pause. */
export class RateLimitError extends ApiError {}

export async function apiGet(key, path, params, fetchImpl = fetch, base = API_BASE) {
  if (!key) throw new ApiError("API_FOOTBALL_KEY is not set");
  const url = `${base}${path}?${new URLSearchParams(params)}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let resp;
    try {
      resp = await fetchImpl(url, { headers: { "x-apisports-key": key, Accept: "application/json" } });
    } catch (e) {
      lastErr = new ApiError(`network error for ${path}: ${e.message}`);
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) {
      lastErr = new ApiError(`HTTP ${resp.status} for ${path}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!resp.ok) throw new ApiError(`HTTP ${resp.status} for ${path}`);
    const remaining = parseInt(resp.headers.get("x-ratelimit-requests-remaining"), 10);
    const payload = await resp.json();
    const errors = payload.errors;
    const hasErrors = errors && (Array.isArray(errors) ? errors.length : Object.keys(errors).length);
    if (hasErrors) {
      const text = JSON.stringify(errors);
      if (!Array.isArray(errors) && errors.rateLimit) throw new RateLimitError(`${path}: ${text}`);
      if (!Array.isArray(errors) && (errors.plan || errors.access || errors.requests || errors.token)) throw new PlanError(`${path}: ${text}`);
      throw new ApiError(`${path}: ${text}`);
    }
    return { response: payload.response || [], remaining: Number.isFinite(remaining) ? remaining : null };
  }
  throw lastErr || new ApiError(`giving up on ${path}`);
}
