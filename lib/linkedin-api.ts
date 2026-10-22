/**
 * The LinkedIn REST API version (`Linkedin-Version: YYYYMM`) — one place.
 *
 * LinkedIn publishes a version every month and supports each for at least
 * a year; a sunset version is refused with HTTP 426 NONEXISTENT_VERSION
 * ("Requested version … is not active"), which stops every post.
 * https://learn.microsoft.com/en-us/linkedin/marketing/versioning
 *
 * DEFAULT: 202610 (October 2026), LinkedIn's latest when checked on
 * 22 Oct 2026 — supported until at least October 2027. The Posts and Images
 * API request shapes Aura uses are unchanged from 202503 in this version.
 * Override with LINKEDIN_API_VERSION; move the default forward at least
 * once a year.
 */
export const LINKEDIN_DEFAULT_API_VERSION = '202610';

/** LinkedIn supports each version for at least this many months. */
export const LINKEDIN_VERSION_SUPPORT_MONTHS = 12;

const VERSION_RE = /^(\d{4})(0[1-9]|1[0-2])$/;

export function isValidLinkedInVersion(v: unknown): v is string {
  return typeof v === 'string' && VERSION_RE.test(v.trim());
}

/** The version to send: LINKEDIN_API_VERSION when well-formed, else the default. */
export function linkedInApiVersion(env: Record<string, string | undefined> = process.env): string {
  const v = env.LINKEDIN_API_VERSION?.trim();
  return v && isValidLinkedInVersion(v) ? v : LINKEDIN_DEFAULT_API_VERSION;
}

/** Whole months between a version (YYYYMM) and `now`. */
export function linkedInVersionAgeMonths(version: string, now: Date = new Date()): number {
  const m = VERSION_RE.exec(version.trim());
  if (!m) return Number.POSITIVE_INFINITY;
  return (now.getUTCFullYear() - Number(m[1])) * 12 + (now.getUTCMonth() + 1 - Number(m[2]));
}

/** Old enough that LinkedIn may have sunset it (its guarantee is one year). */
export function linkedInVersionMayBeSunset(version: string, now: Date = new Date()): boolean {
  return linkedInVersionAgeMonths(version, now) >= LINKEDIN_VERSION_SUPPORT_MONTHS;
}

/** HTTP 426 from LinkedIn: the version header is no longer active. */
export function linkedInVersionSunsetMessage(version: string): string {
  return `LinkedIn no longer accepts API version ${version} (HTTP 426). Set LINKEDIN_API_VERSION to a current version (YYYYMM, see LinkedIn's versioning page) and redeploy — nothing was posted.`;
}
