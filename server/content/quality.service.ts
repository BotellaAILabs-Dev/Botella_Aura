import type { Campaign, Company, ContentDraft } from '@prisma/client';

import { db } from '@/lib/db';
import type { BusinessContext } from '@/lib/business-context';
import { HUMAN_WRITING_RULES, playbookFor } from '@/lib/content-playbook';
import {
  applySafeFixes,
  checkQuality,
  isAlcoholBusiness,
  type QualityContext,
  type QualityReport,
} from '@/lib/content-quality';
import { resolvePlatform, type SocialPlatformKey } from '@/lib/platforms';
import type { ContentTypeKey } from '@/lib/validations/content';
import {
  businessContextToPrompt,
  getBusinessContext,
  WORKFLOW_PRESETS,
} from '@/server/business-context/business-context.service';

/**
 * What every piece of Content Studio copy is written from and checked
 * against — one place, so the first draft, every rewrite and every manual
 * edit are held to the same Business Context, writing rules and compliance.
 */

export interface WritingContext {
  company: Company;
  context: BusinessContext | null;
  campaign: Campaign | null;
  /** Alcohol rules apply. */
  alcohol: boolean;
  /** Topics the brand never mentions. */
  avoid: string[];
  /** The system prompt: business, audience, voice, campaign, rules. */
  system: string;
}

/** Alcohol marketing rules, for the prompt (lib/content-quality.ts checks them). */
const ALCOHOL_PROMPT = [
  'ALCOHOL MARKETING RULES (this is an alcohol brand — these are not optional):',
  '- Speak only to adults of legal drinking age. Never mention or appeal to children, teens or students, and no cartoon or youth-culture framing.',
  '- Never encourage excessive, rapid or irresponsible drinking (no "chug", "binge", "bottomless", "get wasted").',
  '- No health, therapeutic, energy or mood claims ("healthy", "relieves stress", "good for you").',
  '- Never suggest drinking brings social, sexual or professional success, or confidence.',
  '- Never connect drinking with driving, sport, work or anything needing alertness.',
  '- Celebrate the craft, taste, occasion and people — and include a responsible-drinking line (e.g. "Please enjoy responsibly.").',
].join('\n');

export async function loadWritingContext(
  companyId: string,
  options: { campaignId?: string | null } = {},
): Promise<WritingContext> {
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error('Company not found');
  const [context, campaign] = await Promise.all([
    // 'plan' adds recent content (so nothing is repeated) and campaigns.
    getBusinessContext(companyId, {
      sections: ['targeting', 'memory', 'plan'],
    }),
    options.campaignId
      ? db.campaign.findFirst({ where: { id: options.campaignId, companyId } })
      : null,
  ]);

  const alcohol = isAlcoholBusiness([
    company.name,
    company.industry,
    context?.identity.industry,
    context?.identity.description,
    context?.identity.offerings,
  ]);
  const avoid = context?.voice.profile?.topicsToAvoid ?? [];

  const campaignBlock = campaign
    ? [
        `THIS PIECE IS FOR THE CAMPAIGN “${campaign.name}”:`,
        campaign.goal ? `- Goal: ${campaign.goal}` : '',
        campaign.targetAudience ? `- Audience: ${campaign.targetAudience}` : '',
        campaign.themes.length ? `- Themes: ${campaign.themes.join(', ')}` : '',
        campaign.startDate || campaign.endDate
          ? `- Runs: ${campaign.startDate?.toISOString().slice(0, 10) ?? '?'} to ${campaign.endDate?.toISOString().slice(0, 10) ?? '?'}`
          : '',
        'Serve this campaign’s goal and audience; stay on its themes.',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const system = [
    `You are the senior copywriter for ${company.name}. You know the business inside out and write copy its own team would be proud to publish.`,
    businessContextToPrompt(context, {
      ...WORKFLOW_PRESETS.content,
      knowledge: false,
      // Recent content, so a new piece does not repeat a recent one.
      history: true,
    }),
    campaignBlock,
    '',
    'HOW TO WRITE:',
    ...HUMAN_WRITING_RULES.map((r) => `- ${r}`),
    alcohol ? `\n${ALCOHOL_PROMPT}` : '',
    '',
    'Ground every fact in the business context and company knowledge provided. Do not invent product names, prices, awards or claims.',
    'Respond with ONLY valid JSON matching the requested shape. No markdown, no prose.',
  ]
    .filter((l) => l !== '')
    .join('\n');

  return { company, context, campaign, alcohol, avoid, system };
}

/** The platform copy is written for: none for email (it is not on a network). */
export function writingPlatform(
  type: ContentTypeKey,
  platform: SocialPlatformKey | null | undefined,
): SocialPlatformKey | null {
  if (type === 'EMAIL') return null;
  return resolvePlatform(type, platform ?? null);
}

/** The quality context for a piece, given what it may draw facts from. */
export function qualityContextFor(
  type: ContentTypeKey,
  platform: SocialPlatformKey | null,
  w: WritingContext,
  sources: string[],
): QualityContext {
  return {
    limits: playbookFor(type, platform).limits,
    sources: [w.system, ...sources].join('\n'),
    avoid: w.avoid,
    alcohol: w.alcohol,
  };
}

/** Apply the safe fixes, then check. */
export function finalizeBody(
  type: ContentTypeKey,
  body: unknown,
  qc: QualityContext,
): { body: unknown; quality: QualityReport } {
  const fixed = applySafeFixes(type, body, qc);
  const report = checkQuality(type, fixed.body, qc);
  return { body: fixed.body, quality: { ...report, fixes: fixed.fixes } };
}

/** Text of the knowledge chunks a draft was written from. */
export async function chunkText(
  companyId: string,
  ids: unknown,
): Promise<string> {
  const list = Array.isArray(ids)
    ? ids.filter((x): x is string => typeof x === 'string')
    : [];
  if (!list.length) return '';
  const rows = await db.knowledgeChunk.findMany({
    where: { companyId, id: { in: list.slice(0, 12) } },
    select: { content: true },
  });
  return rows.map((r) => r.content).join('\n');
}

/**
 * Re-check a draft as it now stands (after a manual edit): same rules, same
 * material it was written from. Safe fixes are not applied — a person's edit
 * is theirs.
 */
export async function assessDraft(
  draft: ContentDraft,
  body: unknown,
): Promise<QualityReport> {
  const type = draft.type as ContentTypeKey;
  const w = await loadWritingContext(draft.companyId, {
    campaignId: draft.campaignId,
  });
  const meta = (draft.aiMetadata ?? {}) as Record<string, unknown>;
  const src = (meta.source ?? {}) as { brief?: string | null };
  const qc = qualityContextFor(type, writingPlatform(type, draft.platform), w, [
    src.brief ?? '',
    await chunkText(draft.companyId, meta.knowledgeChunkIds),
  ]);
  return { ...checkQuality(type, body, qc), fixes: [] };
}

