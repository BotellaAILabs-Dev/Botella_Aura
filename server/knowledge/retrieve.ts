import type { KnowledgeChunk } from '@prisma/client';
import { db } from '@/lib/db';

/**
 * Knowledge retrieval — selects the most relevant chunks to ground a generation
 * request. This sprint ships a KEYWORD + RECENCY heuristic (TF-style term
 * overlap, boosted by source type and recency). It's dependency-free, cheap,
 * and deterministic.
 *
 * FUTURE UPGRADE (flagged in BACKLOG): semantic/vector search via embeddings for
 * better recall on paraphrased queries. That's the natural home for a small
 * Python ML service (pgvector / vector DB) — the interface here (`retrieve`)
 * stays the same, so callers won't change.
 */

const STOPWORDS = new Set(
  'the a an and or but of to in on for with at by from as is are was were be been being this that these those it its our your their we you they i our'.split(
    ' ',
  ),
);

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

// Recent, first-party posts are the strongest voice signal.
const SOURCE_WEIGHT: Record<string, number> = {
  PAST_POST: 1.25,
  BLOG: 1.15,
  UPLOAD: 1.1,
  WEBSITE: 1.0,
};

function scoreChunk(chunk: KnowledgeChunk, queryTerms: string[], now: number): number {
  const haystack = `${chunk.title ?? ''} ${chunk.content}`.toLowerCase();
  let overlap = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) overlap += 1;
  }
  if (overlap === 0) return 0;

  const relevance = overlap / Math.max(1, queryTerms.length); // 0..1
  const ageDays = Math.max(
    0,
    (now - new Date(chunk.createdAt).getTime()) / 86_400_000,
  );
  const recency = 0.5 ** (ageDays / 30); // 30-day half-life
  const sourceBoost = SOURCE_WEIGHT[chunk.sourceType] ?? 1;

  return relevance * sourceBoost * (0.7 + 0.3 * recency);
}

export interface RetrievedChunk {
  id: string;
  title: string | null;
  content: string;
  sourceType: string;
  score: number;
}

/**
 * Return the top-`limit` chunks for `query` within a company's knowledge base.
 * When the KB has content but nothing matches the query, we fall back to the
 * most recent chunks so generation is still grounded in the company's material.
 */
export async function retrieve(
  companyId: string,
  query: string,
  options: { limit?: number; now?: number } = {},
): Promise<RetrievedChunk[]> {
  const { limit = 6, now = Date.now() } = options;
  const chunks = await db.knowledgeChunk.findMany({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
    take: 400, // cap scan; KB is bounded per company
  });
  if (chunks.length === 0) return [];

  const queryTerms = terms(query);
  const scored = chunks
    .map((c) => ({ chunk: c, score: scoreChunk(c, queryTerms, now) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const chosen = (scored.length > 0
    ? scored.slice(0, limit).map((s) => ({ chunk: s.chunk, score: s.score }))
    : chunks.slice(0, limit).map((c) => ({ chunk: c, score: 0 }))
  ).map(({ chunk, score }) => ({
    id: chunk.id,
    title: chunk.title,
    content: chunk.content,
    sourceType: chunk.sourceType,
    score: Math.round(score * 1000) / 1000,
  }));

  return chosen;
}

/** Compact context block injected into generation prompts. */
export function chunksToContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '(No company knowledge base content available.)';
  return chunks
    .map(
      (c, i) =>
        `[${i + 1}] ${c.title ? c.title + ' — ' : ''}${c.content.slice(0, 800)}`,
    )
    .join('\n\n');
}
