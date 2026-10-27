/**
 * Where Graph API calls go, and the one rule that keeps a sandbox a sandbox.
 *
 * Aura talks to Meta over `graph.facebook.com` for three products — WhatsApp,
 * Facebook Pages and Instagram — and every one of those requests carries an
 * access token. A sandbox needs that host pointed somewhere local; a mistake
 * in the same setting would post as the business, or hand its token to
 * whatever host was named. So the override is accepted only when it resolves
 * to this machine. Anything else is ignored in favour of Meta, silently and
 * deliberately: refusing to start would be worse (a deployment that will not
 * boot over a stray variable), and honouring it would be worse still.
 *
 * The rule lived twice, once in the WhatsApp client and once nowhere at all —
 * lib/meta.ts had no override, which is why Facebook and Instagram could not
 * be exercised without a real Meta app. One implementation, three products.
 */
export const META_GRAPH_HOST = 'https://graph.facebook.com';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Whether a base URL points at this machine, and so may replace Meta's. */
export function isLoopbackBase(value: string): boolean {
  try {
    return LOOPBACK.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * The Graph host to use: the override when it is loopback, else Meta's.
 * `envValue` is the raw environment string, which may be undefined or junk.
 */
export function graphBaseFrom(envValue: string | undefined): string {
  const override = envValue?.trim();
  if (!override) return META_GRAPH_HOST;
  return isLoopbackBase(override) ? override.replace(/\/+$/, '') : META_GRAPH_HOST;
}

/**
 * True when this process is wired to a local stand-in rather than Meta.
 * Used to say so out loud — in `env:check`, and on the Connections screen —
 * because a sandbox that looks like production is how a demo gets mistaken
 * for a working integration.
 */
export function usingGraphStub(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return [env.META_GRAPH_BASE_URL, env.WHATSAPP_GRAPH_BASE_URL].some(
    (v) => Boolean(v?.trim()) && isLoopbackBase(v!.trim()),
  );
}
