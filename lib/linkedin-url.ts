/**
 * LinkedIn URL validation + person-vs-page classification. Client- and
 * server-safe (no imports). We never fetch these URLs — this only checks shape
 * so the UI can validate input and tell a personal profile (/in/) apart from a
 * company/organization page (/company/, /school/, /showcase/).
 */
export type LinkedInUrlKind = 'person' | 'company' | 'unknown';

export interface LinkedInUrlInfo {
  valid: boolean;
  kind: LinkedInUrlKind;
  /** A normalized https URL when valid, else the trimmed input. */
  normalized: string;
}

export function classifyLinkedInUrl(input: string): LinkedInUrlInfo {
  const raw = (input ?? '').trim();
  if (!raw) return { valid: false, kind: 'unknown', normalized: raw };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { valid: false, kind: 'unknown', normalized: raw };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const isLinkedIn = host === 'linkedin.com' || host.endsWith('.linkedin.com');
  if (!isLinkedIn) return { valid: false, kind: 'unknown', normalized: raw };

  const path = url.pathname.toLowerCase();
  const normalized = `https://www.linkedin.com${url.pathname.replace(/\/+$/, '')}`;

  if (/^\/in\/[^/]+/.test(path)) {
    return { valid: true, kind: 'person', normalized };
  }
  if (/^\/(company|school|showcase)\/[^/]+/.test(path)) {
    return { valid: true, kind: 'company', normalized };
  }
  // A LinkedIn URL we can't classify (e.g. a post/feed link) — still on-domain.
  return { valid: false, kind: 'unknown', normalized };
}
