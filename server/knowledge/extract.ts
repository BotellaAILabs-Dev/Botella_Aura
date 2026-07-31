import { parse } from 'node-html-parser';
import { extractText as pdfExtractText, getDocumentProxy } from 'unpdf';

/**
 * Text extraction for the knowledge base. HTML → readable text (scripts, styles,
 * nav, and boilerplate stripped) and PDF → text (via unpdf — pure JS, no native
 * deps, serverless-safe). Never executes page JS; we only read what the site
 * itself serves as HTML.
 */

export function htmlToText(html: string): { title: string; text: string } {
  const root = parse(html, {
    blockTextElements: { script: false, style: false, noscript: false },
  });

  // Collect metadata BEFORE stripping. JavaScript-rendered sites (Framer,
  // Webflow, React/Next landing pages) ship almost no body text in the served
  // HTML — but their real marketing copy lives in <title>, meta description, and
  // Open Graph / JSON-LD tags for SEO. We read only served HTML (never execute
  // JS), so these tags are how we still capture the brand's voice.
  const metaContent = (sel: string) =>
    root.querySelector(sel)?.getAttribute('content')?.trim() || '';

  const title =
    root.querySelector('title')?.text?.trim() ||
    metaContent('meta[property="og:title"]') ||
    root.querySelector('h1')?.text?.trim() ||
    '';

  const metaBits = [
    metaContent('meta[name="description"]'),
    metaContent('meta[property="og:description"]'),
    metaContent('meta[name="twitter:description"]'),
    metaContent('meta[property="og:site_name"]'),
    metaContent('meta[name="keywords"]'),
  ];

  // JSON-LD structured data often carries rich org/product descriptions.
  const jsonLd: string[] = [];
  root
    .querySelectorAll('script[type="application/ld+json"]')
    .forEach((el) => {
      const t = collectJsonLdText(el.text);
      if (t) jsonLd.push(t);
    });

  // Now strip non-content elements and read the body text (may be empty on SPAs).
  root
    .querySelectorAll('script, style, noscript, nav, footer, header, svg, form')
    .forEach((el) => el.remove());
  const container =
    root.querySelector('main') ||
    root.querySelector('article') ||
    root.querySelector('body') ||
    root;
  const bodyText = container.text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

  // Combine title + meta + JSON-LD + body, de-duplicating repeated lines.
  const seen = new Set<string>();
  const text = [title, ...metaBits, ...jsonLd, bodyText]
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => {
      const key = p.slice(0, 140).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join('\n\n')
    .trim();

  return { title, text };
}

/** Pull human-readable string values out of a JSON-LD blob (bounded). */
function collectJsonLdText(raw: string): string {
  try {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') {
        const s = v.trim();
        if (s.length > 3 && !/^https?:\/\//.test(s) && !s.startsWith('{')) out.push(s);
      } else if (Array.isArray(v)) {
        v.forEach(walk);
      } else if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) if (!k.startsWith('@')) walk(val);
      }
    };
    walk(JSON.parse(raw));
    return out.join(' ').slice(0, 1500);
  } catch {
    return '';
  }
}

export async function pdfToText(buffer: ArrayBuffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await pdfExtractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join('\n') : text).trim();
}

/** Strip HTML tags from an RSS <description>/<content> blob into plain text. */
export function stripHtml(input: string): string {
  return parse(input).text.replace(/\s+/g, ' ').trim();
}
