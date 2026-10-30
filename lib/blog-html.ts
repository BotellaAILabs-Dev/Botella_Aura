import type { BlogBody } from '@/lib/validations/content';
import { detailsOf, renderDetails } from '@/lib/post-details';

/**
 * A blog draft as the HTML a CMS stores — the same function renders the
 * preview, so what the person checks is what the site receives.
 *
 * Section bodies are plain text with light markdown (paragraphs, "-"/"1."
 * lists, "###" sub-headings, "> " quotes, **bold**, *italic*, `code`,
 * [links](https://…)). Everything is HTML-escaped before markup is applied,
 * so text from the draft can never become markup it did not ask for, and a
 * link is only kept when it is http(s), mailto, an anchor, or a path on the
 * person's own site (made absolute against it — an internal link).
 *
 * Client-safe: no server imports.
 */

export interface BlogImage {
  url: string;
  alt: string;
}

export interface RelatedLink {
  title: string;
  url: string;
}

export interface BlogHtmlInput {
  body: BlogBody;
  /** Images to place in the body (the featured image is NOT one of these). */
  inlineImages?: BlogImage[];
  /** The site's origin; relative links become absolute against it. */
  siteUrl?: string | null;
  /** Internal links the person chose, added as "Related reading". */
  relatedLinks?: RelatedLink[];
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** A link target worth keeping, made absolute when it points at the site. */
export function resolveHref(raw: string, siteUrl?: string | null): string | null {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href)) {
    try {
      return new URL(href).href;
    } catch {
      return null;
    }
  }
  if (/^mailto:[^\s]+@[^\s]+$/i.test(href)) return href;
  if (href.startsWith('#')) return href;
  if (href.startsWith('/') && !href.startsWith('//')) {
    if (!siteUrl) return href;
    try {
      return new URL(href, siteUrl).href;
    } catch {
      return null;
    }
  }
  return null;
}

/** Bold / italic on already-escaped text. */
function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+?)_(?![\w])/g, '$1<em>$2</em>');
}

// The target may hold one level of parentheses (Wikipedia-style URLs).
const LINK_RE = /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;

/** Inline markdown → HTML: code spans, links, emphasis. */
export function inlineHtml(text: string, siteUrl?: string | null): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part) => {
      if (/^`[^`\n]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      let out = '';
      let last = 0;
      for (const m of part.matchAll(LINK_RE)) {
        out += emphasis(escapeHtml(part.slice(last, m.index)));
        const href = resolveHref(m[2]!, siteUrl);
        const label = emphasis(escapeHtml(m[1]!));
        out += href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
        last = m.index! + m[0].length;
      }
      return out + emphasis(escapeHtml(part.slice(last)));
    })
    .join('');
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'h'; level: 3 | 4; text: string };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{2,4})\s+(.+)$/.exec(line.trim());
    if (heading) {
      flush();
      blocks.push({ kind: 'h', level: heading[1]!.length >= 4 ? 4 : 3, text: heading[2]! });
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    const c = current as Block | null;
    if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      const item = (bullet ?? numbered)![1]!;
      if (c && c.kind === kind) c.items.push(item);
      else {
        flush();
        current = { kind, items: [item] };
      }
      continue;
    }
    if (quote) {
      if (c && c.kind === 'quote') c.lines.push(quote[1]!);
      else {
        flush();
        current = { kind: 'quote', lines: [quote[1]!] };
      }
      continue;
    }
    // A continuation line of a list item stays with it.
    if (c && (c.kind === 'ul' || c.kind === 'ol') && /^\s{2,}\S/.test(rawLine)) {
      c.items[c.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (c && c.kind === 'p') c.lines.push(line.trim());
    else {
      flush();
      current = { kind: 'p', lines: [line.trim()] };
    }
  }
  flush();
  return blocks;
}

/** One section body (light markdown) → HTML blocks. */
export function sectionHtml(text: string, siteUrl?: string | null): string {
  return parseBlocks(text)
    .map((b) => {
      switch (b.kind) {
        case 'h':
          return `<h${b.level}>${inlineHtml(b.text, siteUrl)}</h${b.level}>`;
        case 'ul':
        case 'ol':
          return `<${b.kind}>${b.items.map((i) => `<li>${inlineHtml(i, siteUrl)}</li>`).join('')}</${b.kind}>`;
        case 'quote':
          return `<blockquote><p>${b.lines.map((l) => inlineHtml(l, siteUrl)).join('<br>')}</p></blockquote>`;
        case 'p':
          return `<p>${b.lines.map((l) => inlineHtml(l, siteUrl)).join('<br>')}</p>`;
      }
    })
    .join('\n');
}

function figure(img: BlogImage): string {
  return `<figure><img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt)}" loading="lazy"></figure>`;
}

/**
 * The post body as HTML. The headline is not included — every CMS shows the
 * title itself — and neither is the featured image, which the CMS places.
 * Extra images are spread between sections, each with its alt text.
 */
export function blogToHtml(input: BlogHtmlInput): string {
  const { body, siteUrl } = input;
  const images = input.inlineImages ?? [];
  const sections = body.sections;
  // Image i goes after section round((i+1) * n / (images+1)) - 1: evenly spaced.
  const after = new Map<number, BlogImage[]>();
  images.forEach((img, i) => {
    const at = Math.max(0, Math.min(sections.length - 1, Math.round(((i + 1) * sections.length) / (images.length + 1)) - 1));
    after.set(at, [...(after.get(at) ?? []), img]);
  });

  const parts: string[] = [];
  if (body.subtitle?.trim()) parts.push(`<p><em>${inlineHtml(body.subtitle.trim(), siteUrl)}</em></p>`);
  sections.forEach((s, i) => {
    parts.push(`<h2>${inlineHtml(s.heading, siteUrl)}</h2>`);
    parts.push(sectionHtml(s.body, siteUrl));
    for (const img of after.get(i) ?? []) parts.push(figure(img));
  });

  const info = renderDetails(detailsOf(body));
  if (info.length) parts.push(`<p>${info.map((l) => inlineHtml(l, siteUrl)).join('<br>')}</p>`);

  const related = (input.relatedLinks ?? [])
    .map((l) => ({ title: l.title, href: resolveHref(l.url, siteUrl) }))
    .filter((l): l is { title: string; href: string } => Boolean(l.href));
  if (related.length) {
    parts.push('<h2>Related reading</h2>');
    parts.push(`<ul>${related.map((l) => `<li><a href="${escapeHtml(l.href)}">${escapeHtml(l.title)}</a></li>`).join('')}</ul>`);
  }
  return parts.filter(Boolean).join('\n');
}

/** Markdown-ish text → plain text (for meta descriptions). */
export function plainText(text: string): string {
  return text
    .replace(LINK_RE, '$1')
    .replace(/[`*_>#]/g, '')
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cut at a word boundary, at most `max` characters. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  // A single word longer than max is the only case cut mid-word.
  return (space > 0 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s,;:.-]+$/, '');
}

/** "Ten Ways to Brew Better Coffee!" → "ten-ways-to-brew-better-coffee". */
export function slugify(text: string, max = 80): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const dash = cut.lastIndexOf('-');
  return dash > max * 0.5 ? cut.slice(0, dash) : cut;
}

/** What a publication sends besides the body. Edited at publish time, per site. */
export interface PublishOptions {
  title: string;
  slug: string;
  seoTitle: string;
  metaDescription: string;
  focusKeyword: string;
  canonicalUrl: string;
  categories: string[];
  tags: string[];
  /** Platform author id (WordPress user id, Ghost author email) or name (Shopify). */
  author: string;
  /** Shopify: which blog. */
  blogId: string;
  featuredImageAlt: string;
  relatedLinks: RelatedLink[];
}

export const META_DESCRIPTION_MAX = 160;
export const SEO_TITLE_MAX = 60;

/** Sensible defaults from the draft, so most blogs publish without edits. */
export function defaultPublishOptions(
  body: BlogBody,
  opts: { featuredAlt?: string | null; site?: { categories?: string[]; author?: string; blogId?: string } } = {},
): PublishOptions {
  const subtitle = plainText(body.subtitle ?? '');
  const lead = subtitle.length >= 50 ? subtitle : plainText(body.sections[0]?.body ?? subtitle);
  return {
    title: body.headline.trim(),
    slug: slugify(body.headline),
    seoTitle: body.headline.trim(),
    metaDescription: clip(lead, META_DESCRIPTION_MAX),
    focusKeyword: body.tags[0]?.replace(/^#/, '') ?? '',
    canonicalUrl: '',
    categories: opts.site?.categories ?? [],
    tags: body.tags.map((t) => t.replace(/^#/, '').trim()).filter(Boolean),
    author: opts.site?.author ?? '',
    blogId: opts.site?.blogId ?? '',
    featuredImageAlt: opts.featuredAlt?.trim() || body.headline.trim(),
    relatedLinks: [],
  };
}
