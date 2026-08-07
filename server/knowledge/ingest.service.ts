import type { KnowledgeSourceType, Prisma } from '@prisma/client';
import { XMLParser } from 'fast-xml-parser';
import { parse as parseHtml } from 'node-html-parser';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getText } from '@/lib/http';
import { recordAudit } from '@/server/services/audit.service';
import { politeFetchHtml, KB_USER_AGENT } from '@/server/knowledge/robots';
import { htmlToText, pdfToText, stripHtml } from '@/server/knowledge/extract';
import { chunkText, estimateTokens } from '@/server/knowledge/chunk';

/**
 * Knowledge-base ingestion. Turns a company's own public content into
 * retrievable KnowledgeChunk rows. Idempotent per source: re-syncing a source
 * replaces its chunks rather than duplicating them.
 */
const WEBSITE_PATHS = ['', '/about', '/about-us', '/company', '/blog'];
const MAX_BLOG_ITEMS = 12;

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/** Replace all chunks for one (company, sourceType, sourceUrl) atomically. */
async function replaceChunks(
  companyId: string,
  sourceType: KnowledgeSourceType,
  sourceUrl: string | null,
  pieces: Array<{ title: string | null; content: string }>,
): Promise<number> {
  const rows: Prisma.KnowledgeChunkCreateManyInput[] = [];
  for (const p of pieces) {
    for (const content of chunkText(p.content)) {
      rows.push({
        companyId,
        sourceType,
        sourceUrl,
        title: p.title,
        content,
        tokenCount: estimateTokens(content),
      });
    }
  }
  await db.$transaction([
    db.knowledgeChunk.deleteMany({
      where: { companyId, sourceType, sourceUrl },
    }),
    ...(rows.length ? [db.knowledgeChunk.createMany({ data: rows })] : []),
  ]);
  return rows.length;
}

async function upsertSource(
  companyId: string,
  type: KnowledgeSourceType,
  url: string,
  label: string,
  patch: Partial<{ status: 'PENDING' | 'SYNCING' | 'SYNCED' | 'ERROR'; error: string | null; lastSyncedAt: Date }>,
) {
  return db.knowledgeSource.upsert({
    where: { companyId_type_url: { companyId, type, url } },
    create: { companyId, type, url, label, ...patch },
    update: { label, ...patch },
  });
}

// ---- Website ---------------------------------------------------------------

/** Try to discover an RSS/Atom feed link in a homepage's HTML. */
function discoverFeed(html: string, baseUrl: string): string | null {
  try {
    const root = parseHtml(html);
    const link = root.querySelector(
      'link[type="application/rss+xml"], link[type="application/atom+xml"]',
    );
    const href = link?.getAttribute('href');
    if (!href) return null;
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

export async function ingestWebsite(companyId: string, website: string) {
  let base: URL;
  try {
    base = new URL(website.startsWith('http') ? website : `https://${website}`);
  } catch {
    return { chunks: 0, feed: null as string | null };
  }
  const rootUrl = base.origin;
  await upsertSource(companyId, 'WEBSITE', rootUrl, base.hostname, {
    status: 'SYNCING',
    error: null,
  });

  const pieces: Array<{ title: string | null; content: string }> = [];
  let feed: string | null = null;

  // De-dupe across an SPA's shared HTML shell (client-routed sites return the
  // same served HTML for /about, /company, etc.).
  const seenContent = new Set<string>();
  for (const path of WEBSITE_PATHS) {
    const url = `${rootUrl}${path}`;
    const html = await politeFetchHtml(url);
    if (!html) continue;
    if (!feed && path === '') feed = discoverFeed(html, rootUrl);
    const { title, text } = htmlToText(html);
    // Lowered from 200 so JS-rendered sites (meta/OG copy only) still count.
    if (text.length <= 60) continue;
    const key = text.slice(0, 200);
    if (seenContent.has(key)) continue;
    seenContent.add(key);
    pieces.push({ title: title || url, content: text });
  }

  const chunks = await replaceChunks(companyId, 'WEBSITE', rootUrl, pieces);
  await upsertSource(companyId, 'WEBSITE', rootUrl, base.hostname, {
    status: 'SYNCED',
    lastSyncedAt: new Date(),
    error: pieces.length ? null : 'No readable pages found',
  });
  await recordAudit({
    action: 'KNOWLEDGE_SOURCE_SYNCED',
    companyId,
    metadata: { type: 'WEBSITE', url: rootUrl, chunks },
  });
  return { chunks, feed };
}

// ---- Blog / RSS ------------------------------------------------------------

interface FeedEntry {
  title?: string;
  description?: string;
  'content:encoded'?: string;
  content?: string | { '#text'?: string };
  summary?: string | { '#text'?: string };
  link?: string | { '@_href'?: string };
}

function entryText(e: FeedEntry): string {
  const raw =
    e['content:encoded'] ||
    (typeof e.content === 'string' ? e.content : e.content?.['#text']) ||
    e.description ||
    (typeof e.summary === 'string' ? e.summary : e.summary?.['#text']) ||
    '';
  return stripHtml(String(raw));
}

export async function ingestBlog(companyId: string, feedUrl: string) {
  await upsertSource(companyId, 'BLOG', feedUrl, 'Blog feed', {
    status: 'SYNCING',
    error: null,
  });
  let body: string;
  try {
    body = await getText(feedUrl, {
      timeoutMs: 10_000,
      headers: { 'user-agent': KB_USER_AGENT },
    });
  } catch (err) {
    await upsertSource(companyId, 'BLOG', feedUrl, 'Blog feed', {
      status: 'ERROR',
      error: err instanceof Error ? err.message : 'Feed fetch failed',
    });
    return { chunks: 0 };
  }

  const parsed = xml.parse(body) as {
    rss?: { channel?: { item?: FeedEntry | FeedEntry[] } };
    feed?: { entry?: FeedEntry | FeedEntry[] };
  };
  const rawEntries = ([] as FeedEntry[])
    .concat(parsed.rss?.channel?.item ?? [])
    .concat(parsed.feed?.entry ?? [])
    .slice(0, MAX_BLOG_ITEMS);

  const pieces = rawEntries
    .map((e) => ({
      title: e.title ? String(e.title) : null,
      content: `${e.title ?? ''}\n\n${entryText(e)}`.trim(),
    }))
    .filter((p) => p.content.length > 120);

  const chunks = await replaceChunks(companyId, 'BLOG', feedUrl, pieces);
  await upsertSource(companyId, 'BLOG', feedUrl, 'Blog feed', {
    status: 'SYNCED',
    lastSyncedAt: new Date(),
    error: null,
  });
  await recordAudit({
    action: 'KNOWLEDGE_SOURCE_SYNCED',
    companyId,
    metadata: { type: 'BLOG', url: feedUrl, chunks },
  });
  return { chunks };
}

// ---- Manual upload ---------------------------------------------------------

interface UploadInput {
  companyId: string;
  userId: string;
  filename: string;
  mime: string;
  data: ArrayBuffer;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export async function ingestUpload({
  companyId,
  userId,
  filename,
  mime,
  data,
}: UploadInput): Promise<{ chunks: number }> {
  if (data.byteLength > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error('File too large (max 10 MB).'), { status: 413 });
  }

  const isPdf =
    mime === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
  let text: string;
  if (isPdf) {
    try {
      text = await pdfToText(data);
    } catch (err) {
      // unpdf can throw on encrypted/corrupt/unusual PDFs — surface a clear,
      // actionable 422 instead of a generic 500 that reads as "upload failed".
      logger.warn('ingestUpload: PDF parse failed', {
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
      throw Object.assign(
        new Error(
          'Could not read this PDF. If it is scanned, image-based, or password-protected, export a text-based PDF or paste the text directly instead.',
        ),
        { status: 422 },
      );
    }
  } else {
    text = new TextDecoder().decode(data);
  }
  if (text.trim().length < 20) {
    throw Object.assign(
      new Error(
        isPdf
          ? 'No selectable text found in this PDF — it looks scanned or image-based. Export a text-based PDF, or paste the text directly.'
          : 'Could not extract readable text from this file.',
      ),
      { status: 422 },
    );
  }

  // Each upload is its own source (keyed by filename) so re-uploading replaces it.
  const chunks = await replaceChunks(companyId, 'UPLOAD', filename, [
    { title: filename, content: text },
  ]);
  await recordAudit({
    action: 'KNOWLEDGE_DOCUMENT_UPLOADED',
    userId,
    companyId,
    metadata: { filename, chunks },
  });
  return { chunks };
}

// ---- Re-sync + status ------------------------------------------------------

/** Re-sync a company's website (+ discovered blog feed) end to end. */
export async function resyncCompany(
  company: { id: string; website: string | null },
): Promise<{ chunks: number }> {
  let total = 0;
  if (company.website) {
    const { chunks, feed } = await ingestWebsite(company.id, company.website);
    total += chunks;
    if (feed) {
      const r = await ingestBlog(company.id, feed).catch((err) => {
        logger.warn('resync: blog ingest failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { chunks: 0 };
      });
      total += r.chunks;
    }
  }
  return { chunks: total };
}

export interface KnowledgeStatus {
  sources: Array<{
    id: string;
    type: KnowledgeSourceType;
    label: string;
    url: string | null;
    status: string;
    lastSyncedAt: Date | null;
    error: string | null;
    chunkCount: number;
  }>;
  uploads: Array<{ filename: string; chunkCount: number }>;
  totalChunks: number;
}

export async function getKnowledgeStatus(
  companyId: string,
): Promise<KnowledgeStatus> {
  const [sources, chunkGroups, uploadGroups, total] = await Promise.all([
    db.knowledgeSource.findMany({
      where: { companyId },
      orderBy: { createdAt: 'asc' },
    }),
    db.knowledgeChunk.groupBy({
      by: ['sourceType', 'sourceUrl'],
      where: { companyId },
      _count: { _all: true },
    }),
    db.knowledgeChunk.groupBy({
      by: ['sourceUrl'],
      where: { companyId, sourceType: 'UPLOAD' },
      _count: { _all: true },
    }),
    db.knowledgeChunk.count({ where: { companyId } }),
  ]);

  const countFor = (type: KnowledgeSourceType, url: string | null) =>
    chunkGroups.find((g) => g.sourceType === type && g.sourceUrl === url)?._count
      ._all ?? 0;

  return {
    sources: sources.map((s) => ({
      id: s.id,
      type: s.type,
      label: s.label,
      url: s.url,
      status: s.status,
      lastSyncedAt: s.lastSyncedAt,
      error: s.error,
      chunkCount: countFor(s.type, s.url),
    })),
    uploads: uploadGroups.map((g) => ({
      filename: g.sourceUrl ?? 'document',
      chunkCount: g._count._all,
    })),
    totalChunks: total,
  };
}
