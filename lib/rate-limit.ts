/**
 * Minimal in-memory, per-IP rate limiter.
 *
 * This exists because /api/generate is an unauthenticated endpoint that spends
 * money on every call. It is deliberately the cheapest thing that raises the
 * cost of casual abuse — it is NOT production-grade. See DECISIONS.md.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 10;

const hits = new Map<string, number[]>();

export function checkRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);

  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    hits.set(key, recent);
    const retryAfterSeconds = Math.ceil((recent[0] + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }

  recent.push(now);
  hits.set(key, recent);

  // Cheap bound on memory: drop keys that have gone quiet.
  if (hits.size > 5000) {
    for (const [otherKey, timestamps] of hits) {
      if (timestamps.every((at) => at <= cutoff)) hits.delete(otherKey);
    }
  }

  return { allowed: true, retryAfterSeconds: 0 };
}
