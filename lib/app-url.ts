import { headers } from 'next/headers';

/**
 * Canonical public base URL for links we put in emails.
 *
 * Getting this wrong is invisible until an invite lands in someone's inbox
 * pointing at http://localhost:3000 — so resolve it from the most reliable
 * source available, in order:
 *
 *   1. APP_URL / NEXTAUTH_URL — explicit, and what NextAuth already uses.
 *   2. VERCEL_PROJECT_PRODUCTION_URL / VERCEL_URL — set automatically on Vercel.
 *   3. URL / DEPLOY_PRIME_URL — set automatically on Netlify.
 *   4. The current request's own Host header (works everywhere, incl. Railway).
 *   5. http://localhost:3000 — local dev only.
 */
function fromEnv(): string | null {
  const explicit = process.env.APP_URL || process.env.NEXTAUTH_URL;
  if (explicit) return explicit.replace(/\/+$/, '');

  const vercel =
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;

  const netlify = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (netlify) return netlify.replace(/\/+$/, '');

  return null;
}

/** Base URL derived from the incoming request (server components / handlers). */
function fromRequest(): string | null {
  try {
    const h = headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');
    if (!host) return null;
    const proto =
      h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
    return `${proto}://${host}`.replace(/\/+$/, '');
  } catch {
    // Outside a request scope (cron, scripts) — env is the only source.
    return null;
  }
}

export function getAppUrl(): string {
  return fromEnv() ?? fromRequest() ?? 'http://localhost:3000';
}

/** Absolute URL for an app-relative path, e.g. `/invite/abc`. */
export function absoluteUrl(path: string): string {
  const base = getAppUrl();
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Whether the resolved base URL would produce a link nobody outside this
 * machine can open. Used to warn admins before they wonder why an invite
 * "arrived but doesn't work".
 */
export function isLocalAppUrl(url = getAppUrl()): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
}
