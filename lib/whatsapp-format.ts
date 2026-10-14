import { absoluteUrl } from '@/lib/app-url';

/**
 * Formatting Aura's results for WhatsApp: short, scannable, in WhatsApp's own
 * markup (*bold*, _italic_), with a link to the full page for detail.
 * Everything shown is taken from the record — nothing is summarised by a
 * model here, so nothing can be invented on the way out.
 */

/** At most `max` characters, on a word boundary, with an ellipsis. */
export function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\-–—]+$/, '')}…`;
}

/**
 * WhatsApp markup characters in data (a title with *stars* or _underscores_)
 * would turn into formatting. Swapped for look-alikes so text reads as written.
 */
export function plain(text: string | null | undefined): string {
  return (text ?? '').replace(/\*/g, '∗').replace(/_/g, '‗').replace(/~/g, '∼').replace(/`/g, 'ˋ');
}

export const bold = (s: string) => `*${plain(s)}*`;

/** A numbered list, one item per line. */
export function numbered(items: string[]): string {
  return items.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

/** "Open in Aura: https://…" for the page with the full detail. */
export function openInAura(path: string): string {
  return `Open in Aura: ${absoluteUrl(path)}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "in 3 days", "today", "2 days ago". */
export function relativeDay(date: Date, now: Date = new Date()): string {
  const day = 86_400_000;
  const d = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / day);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}
