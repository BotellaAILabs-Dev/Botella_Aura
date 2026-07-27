/**
 * Lightweight in-memory sliding-window rate limiter (Sprint 6, Module 4).
 * Applied to public/auth endpoints to blunt brute-force + abuse.
 *
 * NOTE: this is per-instance memory. It's effective for a single node and for
 * dev; behind multiple serverless instances it's best-effort. The documented
 * production upgrade is a shared store (Upstash/Redis) behind the same
 * `rateLimit()` interface — call sites won't change.
 */
const buckets = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): RateLimitResult {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < opts.windowMs);

  if (hits.length >= opts.limit) {
    buckets.set(key, hits);
    const retryAfterSeconds = Math.max(1, Math.ceil((opts.windowMs - (now - hits[0]!)) / 1000));
    return { allowed: false, retryAfterSeconds, remaining: 0 };
  }

  hits.push(now);
  buckets.set(key, hits);
  // Opportunistic cleanup so the map doesn't grow unbounded.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => now - t >= opts.windowMs)) buckets.delete(k);
    }
  }
  return { allowed: true, retryAfterSeconds: 0, remaining: opts.limit - hits.length };
}

/** Client IP for keying, from proxy headers (best-effort). */
export function clientIp(req: Request): string {
  const h = req.headers;
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    h.get('x-real-ip') ??
    'unknown'
  );
}
