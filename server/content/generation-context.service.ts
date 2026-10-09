import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { playbookFor } from '@/lib/content-playbook';
import { draftSnippet } from '@/lib/content-ui';
import type { ContentBrief } from '@/lib/content-brief';
import {
  assembleGenerationContext,
  type GenerationContext,
  type KnowledgePassage,
  type PreviousPiece,
} from '@/lib/generation-context';
import { platformSpec, type SocialPlatformKey } from '@/lib/platforms';
import type { ContentTypeKey } from '@/lib/validations/content';
import { getContextSnapshot } from '@/server/business-context/snapshot.service';
import { retrieve } from '@/server/knowledge/retrieve';

/**
 * Gathers what a draft's generation context is assembled from
 * (lib/generation-context.ts holds the rules):
 *
 *   the CURRENT Business Context Snapshot — content view, served only after
 *   its source stamp is checked, so it is rebuilt if anything it is built
 *   from has changed since it was stored;
 *   the business's own material, retrieved for this topic;
 *   earlier approved or published posts, for "do not repeat";
 *   the campaign this piece is for.
 *
 * Nothing about leads, contacts, connections or credentials is read here.
 */

/** How far back earlier posts are considered. */
const PREVIOUS_WINDOW_DAYS = 120;

export async function assembleDraftContext(args: {
  companyId: string;
  type: ContentTypeKey;
  platform: SocialPlatformKey | null;
  /** The person's brief text. */
  brief: string;
  /** What to retrieve material for. */
  query: string;
  contentBrief: ContentBrief | null;
  campaignId: string | null;
  reference: { url: string; text: string }[];
  now?: Date;
}): Promise<GenerationContext> {
  const now = args.now ?? new Date();
  const since = new Date(now.getTime() - PREVIOUS_WINDOW_DAYS * 86_400_000);
  const query = [
    args.query,
    args.contentBrief?.keyMessage?.value,
    args.contentBrief?.recommendation.title,
  ]
    .filter(Boolean)
    .join(' ');

  const [snap, knowledge, previous, campaign] = await Promise.all([
    getContextSnapshot(args.companyId, { view: 'content', now }),
    retrieve(args.companyId, query, { limit: 8 }).catch((err: unknown) => {
      logger.warn(
        'generation-context: knowledge retrieval failed (non-fatal)',
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return [];
    }),
    db.contentDraft.findMany({
      where: {
        companyId: args.companyId,
        status: { in: ['APPROVED', 'PUBLISHED'] },
        updatedAt: { gte: since },
      },
      orderBy: { updatedAt: 'desc' },
      take: 40,
      select: {
        id: true,
        title: true,
        type: true,
        body: true,
        platform: true,
        updatedAt: true,
      },
    }),
    args.campaignId
      ? db.campaign.findFirst({
          where: { id: args.campaignId, companyId: args.companyId },
          select: {
            id: true,
            name: true,
            goal: true,
            targetAudience: true,
            themes: true,
          },
        })
      : null,
  ]);
  if (!snap) throw new Error('Company not found');

  const passages: KnowledgePassage[] = knowledge.map((k) => ({
    id: k.id,
    title: k.title,
    content: k.content,
    score: k.score,
  }));
  const pieces: PreviousPiece[] = previous.map((d) => ({
    id: d.id,
    title: d.title,
    excerpt: draftSnippet(d.type as ContentTypeKey, d.body).slice(0, 300),
    channel: d.platform ? platformSpec(d.platform).label : null,
    at: d.updatedAt.toISOString(),
  }));
  const playbook = playbookFor(args.type, args.platform);

  return assembleGenerationContext({
    brief: args.brief,
    contentBrief: args.contentBrief,
    snapshot: snap.snapshot,
    snapshotStatus: snap.status,
    playbook: { label: playbook.label, rules: playbook.rules },
    format: {
      type: args.type,
      channel: args.platform ? platformSpec(args.platform).label : null,
    },
    campaign: campaign
      ? {
          id: campaign.id,
          name: campaign.name,
          goal: campaign.goal,
          audience: campaign.targetAudience,
          themes: campaign.themes,
        }
      : null,
    knowledge: passages,
    reference: args.reference,
    previous: pieces,
    now,
  });
}
