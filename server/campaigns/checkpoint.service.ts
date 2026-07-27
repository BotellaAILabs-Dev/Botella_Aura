import type { Campaign } from '@prisma/client';
import { db } from '@/lib/db';
import {
  complete,
  isClaudeConfigured,
} from '@/server/ai/claude';
import { logger } from '@/lib/logger';

/**
 * Weekly campaign review checkpoint (Sprint 6, Module 1). Produces a short,
 * data-grounded "here's what landed, what's working, what's next" summary using
 * REAL campaign progress + Sprint 5 performance data. Honest: it reports actual
 * counts, and only mentions performance where data exists.
 */
export async function generateCheckpointSummary(args: {
  campaign: Campaign;
  weekNumber: number;
}): Promise<string> {
  const { campaign, weekNumber } = args;

  const [generated, approved, published, drafts] = await Promise.all([
    db.campaignTask.count({ where: { campaignId: campaign.id, status: 'GENERATED' } }),
    db.campaignTask.count({ where: { campaignId: campaign.id, status: 'APPROVED' } }),
    db.contentDraft.count({ where: { campaignId: campaign.id, status: 'PUBLISHED' } }),
    db.contentDraft.count({ where: { campaignId: campaign.id } }),
  ]);

  const facts =
    `Campaign "${campaign.name}" — week ${weekNumber}. Goal: ${campaign.goal ?? 'n/a'}. ` +
    `Progress: ${drafts} content drafts created, ${published} published, ` +
    `${generated} campaign tasks produced output, ${approved} approved.`;

  if (!isClaudeConfigured()) {
    return (
      `Week ${weekNumber} check-in. ${facts} ` +
      `${published > 0 ? 'Keep reviewing the queue to publish on cadence.' : 'Nothing published yet — approve pending drafts to keep momentum.'} ` +
      `Next week continues the planned schedule.`
    );
  }

  try {
    return await complete({
      system:
        'You are an AI marketing employee giving your founder a short weekly ' +
        'campaign update (3-4 sentences). Use ONLY the facts provided — do not ' +
        'invent metrics. Warm, concise, action-oriented.',
      prompt: `${facts}\nWrite the week ${weekNumber} update.`,
      maxTokens: 300,
      effort: 'low',
    });
  } catch (err) {
    logger.info('campaign checkpoint: AI summary failed, using facts', {
      campaignId: campaign.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return `Week ${weekNumber} check-in. ${facts}`;
  }
}
