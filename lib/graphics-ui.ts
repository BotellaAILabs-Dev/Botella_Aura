import type { AspectRatioKey } from '@/lib/platforms';

/**
 * Client-safe presentation helpers for Graphic Generation.
 *
 * Mirrors lib/content-ui.ts: labels and formatting the UI needs, with no React
 * and no server imports, so both the studio components and any server component
 * can use the same strings.
 *
 * The style VOCABULARY lives here too, rather than in server/media/types.ts,
 * so a client component never has to import from `server/`. The art-direction
 * TEXT for each style stays server-side — it is prompt material the browser has
 * no use for.
 */

/** Art styles offered in the studio. */
export const IMAGE_STYLES = [
  'professional',
  'minimal',
  'cinematic',
  '3d',
  'illustration',
] as const;
export type ImageStyleKey = (typeof IMAGE_STYLES)[number];

export function isImageStyle(value: string): value is ImageStyleKey {
  return (IMAGE_STYLES as readonly string[]).includes(value);
}

export const STYLE_LABELS: Record<ImageStyleKey, string> = {
  professional: 'Professional',
  minimal: 'Minimal',
  cinematic: 'Cinematic',
  '3d': '3D',
  illustration: 'Illustration',
};

/** Format names the user picks from, rather than raw ratios. */
export const FORMAT_LABELS: Record<AspectRatioKey, string> = {
  '1:1': 'Square',
  '4:5': 'Portrait',
  '16:9': 'Landscape',
  '9:16': 'Story / Reel',
};

/**
 * The format selector's options, including Custom.
 *
 * Custom is a UI concept, not a ratio: the user types dimensions and the
 * backend maps them to the nearest shape the chosen provider can actually
 * draw. It is kept out of AspectRatioKey so nothing downstream has to handle
 * a "ratio" that has no fixed value.
 */
export const CUSTOM_FORMAT = 'custom' as const;
export type FormatChoice = AspectRatioKey | typeof CUSTOM_FORMAT;

/** Where each format is normally used — shown under the selector. */
export const FORMAT_HINTS: Record<AspectRatioKey, string> = {
  '1:1': 'Feed posts everywhere',
  '4:5': 'Tallest feed post — most screen space',
  '16:9': 'Link cards and wide banners',
  '9:16': 'Stories and Reels',
};

export const PROVIDER_LABELS: Record<string, string> = {
  OPENAI: 'OpenAI',
  GOOGLE: 'Google Imagen',
  STABILITY: 'Stability AI',
  REPLICATE: 'Replicate',
};

/** Human file size, e.g. "1.4 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Day heading for the graphic history ("Today", "Yesterday", then a date).
 *
 * Compares calendar days in local time rather than subtracting timestamps —
 * something generated at 11pm is "Yesterday" at 1am, not "2 hours ago".
 */
export function dayLabel(iso: string): string {
  const date = new Date(iso);
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  const days = Math.round(
    (startOfDay(new Date()) - startOfDay(date)) / 86_400_000,
  );
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

/** Group history entries under day headings, preserving newest-first order. */
export function groupByDay<T extends { createdAt: string }>(
  items: T[],
): Array<{ label: string; items: T[] }> {
  const groups: Array<{ label: string; items: T[] }> = [];
  for (const item of items) {
    const label = dayLabel(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** Tailwind aspect class for a preview tile. */
export function aspectClass(ratio: string): string {
  switch (ratio) {
    case '4:5':
      return 'aspect-[4/5]';
    case '16:9':
      return 'aspect-video';
    case '9:16':
      return 'aspect-[9/16]';
    default:
      return 'aspect-square';
  }
}
