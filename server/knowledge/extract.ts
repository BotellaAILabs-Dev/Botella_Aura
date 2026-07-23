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
  root
    .querySelectorAll('script, style, noscript, nav, footer, header, svg, form')
    .forEach((el) => el.remove());

  const title =
    root.querySelector('title')?.text?.trim() ||
    root.querySelector('h1')?.text?.trim() ||
    '';

  // Prefer <main>/<article> when present; fall back to <body>.
  const container =
    root.querySelector('main') ||
    root.querySelector('article') ||
    root.querySelector('body') ||
    root;

  const text = container.text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

  return { title, text };
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
