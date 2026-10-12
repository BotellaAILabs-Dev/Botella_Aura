import type { ContentDraft } from '@prisma/client';

import { db } from '@/lib/db';
import {
  checkFacts,
  type FactCheckReport,
  type TrustedSource,
} from '@/lib/fact-check';
import { getContextSnapshot } from '@/server/business-context/snapshot.service';
import { renderForManual } from '@/server/content/render';

/**
 * The fact check for a draft (lib/fact-check.ts), against everything Aura
 * trusts about it, read now — so it is never stale after an edit, a rewrite
 * or a switch of version:
 *
 *   business profile   the current Business Context Snapshot's confirmed
 *                      facts (what the business does and sells, its
 *                      audience, goals, voice, recent topics)
 *   unconfirmed        the snapshot's assumptions — present, not confirmed
 *   evidence           the recommendation's evidence, with when it was seen
 *   own material       the knowledge passages the draft was written from
 *   brief              what the person asked for, in their words
 *
 * Competitor names (from Competitors) mark market claims.
 */
export async function factCheckDraft(
  draft: ContentDraft,
  body: unknown = draft.body,
  now: Date = new Date(),
): Promise<FactCheckReport> {
  const meta = (draft.aiMetadata ?? {}) as {
    knowledgeChunkIds?: unknown;
    source?: { brief?: string | null };
    brief?: {
      evidence?: {
        label?: string;
        detail?: string;
        url?: string | null;
        observedAt?: string | null;
      }[];
    } | null;
  };
  const chunkIds = Array.isArray(meta.knowledgeChunkIds)
    ? meta.knowledgeChunkIds
        .filter((x): x is string => typeof x === 'string')
        .slice(0, 20)
    : [];

  const [snap, chunks, competitors] = await Promise.all([
    getContextSnapshot(draft.companyId, { view: 'content', now }),
    chunkIds.length
      ? db.knowledgeChunk.findMany({
          where: { id: { in: chunkIds }, companyId: draft.companyId },
          select: { title: true, content: true, createdAt: true },
        })
      : [],
    db.competitorProfile.findMany({
      where: { companyId: draft.companyId },
      select: { name: true },
      take: 30,
    }),
  ]);

  const sources: TrustedSource[] = [];
  const s = snap?.snapshot;
  if (s) {
    const profile = [
      s.business &&
        `${s.business.name}. ${s.business.description ?? ''} ${s.business.website ?? ''}`,
      s.products?.offerings,
      ...(s.products?.highlights ?? []).map(
        (h) => `${h.title ?? ''} ${h.excerpt}`,
      ),
      s.audience?.description,
      s.goals?.current,
      ...(s.goals?.campaigns ?? []).map((c) => `${c.name} ${c.goal ?? ''}`),
      s.voice?.notes,
    ]
      .filter(Boolean)
      .join('\n');
    if (profile.trim()) {
      sources.push({
        label: 'your business profile',
        kind: 'business_profile',
        trusted: true,
        observedAt: s.generatedAt,
        // The snapshot's main sections hold only facts that are not stale.
        stale: false,
        text: profile,
      });
    }
    for (const a of s.assumptions) {
      sources.push({
        label: `an unconfirmed detail (${a.label})`,
        kind: 'assumption',
        trusted: false,
        observedAt: null,
        stale: /stale|out of date/i.test(a.reason),
        text: a.value,
      });
    }
  }
  for (const e of meta.brief?.evidence ?? []) {
    if (!e.label) continue;
    sources.push({
      label: `evidence: ${e.label}`,
      kind: 'evidence',
      trusted: true,
      observedAt: e.observedAt ?? null,
      stale: false,
      text: `${e.label}. ${e.detail ?? ''} ${e.url ?? ''}`,
    });
  }
  for (const c of chunks) {
    sources.push({
      label: `your material${c.title ? `: ${c.title}` : ''}`,
      kind: 'knowledge',
      trusted: true,
      // The business's own documents describe it; their date is not a claim's.
      observedAt: null,
      stale: false,
      text: c.content,
    });
  }
  if (meta.source?.brief?.trim()) {
    sources.push({
      label: 'your brief',
      kind: 'brief',
      trusted: true,
      observedAt: null,
      stale: false,
      text: meta.source.brief,
    });
  }

  return checkFacts({
    text: renderForManual({ ...draft, body } as ContentDraft),
    sources,
    competitors: competitors.map((c) => c.name),
    now,
  });
}
