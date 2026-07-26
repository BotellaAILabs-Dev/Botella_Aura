import { politeFetchHtml } from '@/server/knowledge/robots';
import { htmlToText } from '@/server/knowledge/extract';

/**
 * Website change-detection source. Fetches a competitor's homepage / pricing
 * page ONLY when robots.txt permits (reuses the polite, throttled fetcher from
 * the knowledge pipeline), extracts readable text, and returns it bounded for
 * hashing + diffing. No headless browser, no auth bypass — public pages only.
 */
const MAX_TEXT_CHARS = 20_000;

export interface PageCapture {
  ok: boolean;
  text: string | null;
  /** Reason a fetch produced no text (robots-disallowed, unreachable, empty). */
  reason?: string;
}

export async function capturePage(url: string): Promise<PageCapture> {
  const html = await politeFetchHtml(url);
  if (html == null) {
    return { ok: false, text: null, reason: 'not fetched (robots.txt or unreachable)' };
  }
  const { text } = htmlToText(html);
  const trimmed = text.trim().slice(0, MAX_TEXT_CHARS);
  if (!trimmed) return { ok: false, text: null, reason: 'no readable text' };
  return { ok: true, text: trimmed };
}
