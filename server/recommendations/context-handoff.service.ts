import { db } from '@/lib/db';
import {
  buildContextHandoff,
  type ContextHandoff,
} from '@/lib/recommendation-context-handoff';
import { getBusinessContext } from '@/server/business-context/business-context.service';

/**
 * The Recommendation Context Handoff for one recommendation
 * (lib/recommendation-context-handoff.ts): the recommendation itself, plus
 * the business, goals, audience, channels, brand voice and learned patterns
 * from the Business Context — the single source every workflow reads.
 *
 * Scoped to the workspace: another workspace's recommendation is null.
 */
export async function getContextHandoff(
  companyId: string,
  recommendationId: string,
  now: Date = new Date(),
): Promise<ContextHandoff | null> {
  const r = await db.recommendation.findFirst({
    where: { id: recommendationId, companyId },
    include: {
      evidence: {
        orderBy: { createdAt: 'asc' },
        select: { label: true, detail: true, url: true, observedAt: true },
      },
    },
  });
  if (!r) return null;

  const ctx = await getBusinessContext(companyId, {
    sections: ['targeting', 'plan', 'connections', 'memory'],
  });
  const voice = ctx?.voice.profile ?? null;

  return buildContextHandoff({
    recommendation: r,
    business: {
      name: ctx?.identity.name ?? '',
      description: ctx?.identity.description ?? null,
      offerings: ctx?.identity.offerings ?? null,
      industry: ctx?.identity.industry ?? null,
      website: ctx?.identity.website ?? null,
      goals: ctx?.objectives.goals ?? null,
      audience: ctx?.audience.stated ?? null,
      campaigns: (ctx?.objectives.campaigns ?? []).map((c) => ({
        name: c.name,
        goal: c.goal,
        audience: c.audience,
        themes: c.themes,
      })),
      connected: ctx?.channels.connected ?? [],
      voice:
        voice || ctx?.voice.summary
          ? {
              summary: voice?.summary || ctx?.voice.summary || null,
              tone: voice?.toneDescriptors ?? [],
              phrases: voice?.commonPhrases ?? [],
              avoid: voice?.topicsToAvoid ?? [],
              formatting: voice
                ? [
                    `emoji: ${voice.formatting.emojiUsage}`,
                    `hashtags: ${voice.formatting.hashtagStyle}`,
                    voice.formatting.notes,
                  ]
                    .filter(Boolean)
                    .join('; ')
                : null,
            }
          : null,
      memory: (ctx?.memory.insights ?? []).map((m) => ({
        insight: m.insight,
        type: m.type,
        confidence: m.confidence,
        freshness: m.freshness,
      })),
    },
    now,
  });
}
