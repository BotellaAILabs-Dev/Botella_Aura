import type { MarketingMemory } from '@prisma/client';
import { db } from '@/lib/db';

/**
 * Marketing Memory retrieval + prompt injection (Sprint 5, Module 2). This is
 * the "gets smarter every week" mechanism: active insights are injected into
 * the content + outreach generators alongside brand voice + knowledge.
 */

/** Active, real insights for a company (excludes the "insufficient data" note). */
export async function getActiveMemories(companyId: string): Promise<MarketingMemory[]> {
  const memories = await db.marketingMemory.findMany({
    where: { companyId, isActive: true },
    orderBy: { generatedAt: 'desc' },
  });
  return memories.filter((m) => !isInsufficient(m));
}

/** All active memories incl. the honest "not enough data" note (for the dashboard). */
export async function listMemories(companyId: string): Promise<MarketingMemory[]> {
  return db.marketingMemory.findMany({
    where: { companyId, isActive: true },
    orderBy: [{ insightType: 'asc' }, { generatedAt: 'desc' }],
  });
}

export function isInsufficient(m: MarketingMemory): boolean {
  const s = (m.supportingDataSummary ?? {}) as { status?: string };
  return s.status === 'insufficient';
}

/**
 * Render active insights into the instruction block injected into generation
 * prompts. Returns '' when there are no real insights yet — so a fresh company's
 * output is unchanged (no fabricated guidance). Optionally filter by relevance.
 */
export function memoriesToPrompt(
  memories: MarketingMemory[],
  opts?: { types?: string[] },
): string {
  const relevant = memories
    .filter((m) => !isInsufficient(m))
    .filter((m) => !opts?.types || opts.types.includes(m.insightType));
  if (relevant.length === 0) return '';

  const lines = relevant.map(
    (m) => `- [${m.insightType}] ${m.insight} (confidence: ${m.confidence})`,
  );
  return [
    'WHAT WE HAVE LEARNED WORKS FOR THIS ACCOUNT (apply where it genuinely fits;',
    'these are data-backed patterns from real past performance):',
    ...lines,
  ].join('\n');
}
