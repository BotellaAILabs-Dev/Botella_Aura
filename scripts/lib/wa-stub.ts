/**
 * Verify-suite helper for the local Meta stub (scripts/load/meta-stub.ts).
 *
 * Once the app has sent a one-time link (sign-in, connect), it keeps only
 * "[sent]" in its stored history, so the link is not in the database. When
 * the app is pointed at the stub (WHATSAPP_GRAPH_BASE_URL), the suites read
 * the link from what the stub received instead. Against real Meta the send
 * fails without real credentials and the stored link is still there.
 */
const STUB = process.env.WHATSAPP_GRAPH_BASE_URL?.replace(/\/$/, '');

function ctaUrl(body: unknown): string | null {
  const b = body as { interactive?: { action?: { parameters?: { url?: string } } } };
  return b?.interactive?.action?.parameters?.url ?? null;
}

/** The real URL behind a stored "[sent]", from the stub; otherwise the URL as given. */
export async function resolveSentUrl(to: string, url: string | undefined | null): Promise<string | undefined> {
  if (url !== '[sent]' || !STUB) return url ?? undefined;
  const res = await fetch(`${STUB}/sent?to=${encodeURIComponent(to.replace(/\D/g, ''))}`);
  const { messages } = (await res.json()) as { messages: { body: unknown }[] };
  return messages.map((m) => ctaUrl(m.body)).filter(Boolean).at(-1) ?? url;
}
