/**
 * Links to the outside world, only when they are actually web links.
 *
 * Trend stories, competitor news, release notes and AI-cited evidence all
 * carry URLs that came from someone else's feed or page. React 18 renders a
 * `javascript:` URL into an href with only a console warning, so a hostile
 * feed item could put script behind a link a user clicks inside Aura. Every
 * third-party URL goes through this before it reaches an href: anything that
 * is not http(s) is dropped (and the caller renders no link).
 *
 * Client-safe.
 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** For validation: is this an http(s) URL? */
export function isWebUrl(raw: string): boolean {
  return safeExternalUrl(raw) !== null;
}

/**
 * A post-login redirect target, only when it stays on this site: a path that
 * starts with a single "/". Anything else — an absolute URL, a
 * protocol-relative "//host", a backslash trick, a control character — falls
 * back, so a crafted ?callbackUrl= can never send a freshly signed-in user to
 * another site (an open redirect).
 */
export function safeRedirectPath(raw: string | null | undefined, fallback: string): string {
  const v = raw?.trim() ?? '';
  if (!v.startsWith('/') || v.startsWith('//')) return fallback;
  // Browsers treat "\" like "/" ("/\host" is protocol-relative); control
  // characters can be stripped into the same thing.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(v)) return fallback;
  return v;
}
