/**
 * Public LinkedIn Company Page posts — INTENTIONALLY STUBBED (Sprint 4).
 *
 * There is no official LinkedIn API scope available to us that returns an
 * arbitrary company page's public post feed. Per the product's core safety
 * principle (NON-NEGOTIABLE #2/#5), we do NOT scrape linkedin.com from the
 * server, and we do NOT fake data. So this source reports itself as "pending
 * API access" and contributes nothing until an official scope is granted
 * (Marketing Developer Platform / Community Management approval).
 *
 * When such access lands, implement fetching here behind that official scope —
 * the tracking pipeline already accounts for this source in its `skipped` list.
 */
export interface LinkedInCompanySignalResult {
  available: false;
  reason: string;
}

export function fetchLinkedInCompanySignal(
  _linkedInUrl: string,
): LinkedInCompanySignalResult {
  return {
    available: false,
    reason:
      'LinkedIn Company Page posts require an official API scope we do not yet ' +
      'have (no scraping). Pending Marketing Developer Platform access.',
  };
}
