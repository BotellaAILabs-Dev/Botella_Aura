import robotsParser from 'robots-parser';
import { getText } from '@/lib/http';
import { logger } from '@/lib/logger';

/**
 * robots.txt compliance for knowledge ingestion (NON-NEGOTIABLE #3). We fetch
 * and cache each origin's robots.txt, honour Disallow rules for our user-agent,
 * and throttle between requests. We only ever read publicly-served pages — no
 * auth bypass, no unofficial endpoints.
 */
export const KB_USER_AGENT = 'BotellaAuraBot/0.1 (+https://botella.ai/bot)';
const THROTTLE_MS = 1200; // polite delay between requests to the same host

// origin -> robots checker (per process; short-lived, fine to cache in memory).
const cache = new Map<string, ReturnType<typeof robotsParser> | null>();

async function getRobots(origin: string) {
  if (cache.has(origin)) return cache.get(origin)!;
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const body = await getText(robotsUrl, {
      timeoutMs: 6000,
      retries: 0,
      headers: { 'user-agent': KB_USER_AGENT },
    });
    const parser = robotsParser(robotsUrl, body);
    cache.set(origin, parser);
    return parser;
  } catch {
    // No robots.txt (or unreachable) → treat as allowed, standard convention.
    cache.set(origin, null);
    return null;
  }
}

/** Whether we're permitted to fetch `url` per its site's robots.txt. */
export async function isAllowed(url: string): Promise<boolean> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  const robots = await getRobots(origin);
  if (!robots) return true;
  const allowed = robots.isAllowed(url, KB_USER_AGENT);
  // robots-parser returns undefined when no rule matches → allowed.
  return allowed !== false;
}

/** Fetch a page's HTML only if robots.txt permits; throttled. Returns null if disallowed/failed. */
export async function politeFetchHtml(url: string): Promise<string | null> {
  if (!(await isAllowed(url))) {
    logger.info('knowledge: skipped by robots.txt', { url });
    return null;
  }
  await delay(THROTTLE_MS);
  try {
    return await getText(url, {
      timeoutMs: 10_000,
      retries: 1,
      headers: { 'user-agent': KB_USER_AGENT, accept: 'text/html' },
    });
  } catch (err) {
    logger.info('knowledge: fetch failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
