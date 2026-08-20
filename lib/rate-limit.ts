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

  // Stops the Map growing forever: once it's big, drop keys that went quiet.
  if (hits.size > 5000) {
    for (const [otherKey, timestamps] of hits) {
      if (timestamps.every((at) => at <= cutoff)) hits.delete(otherKey);
    }
  }

  return { allowed: true, retryAfterSeconds: 0 };
}
