import type { InsightType } from '@prisma/client';

import { db } from '@/lib/db';
import {
  CONTEXT_SECTIONS,
  type BusinessContext,
  type ContextSection,
} from '@/lib/business-context';
import {
  audienceToPrompt,
  businessToPrompt,
  contentRulesFor,
  type AudienceProfile,
} from '@/server/content/audience';
import { brandVoiceToPrompt } from '@/server/content/brand-voice.service';
import { chunksToContext, retrieve } from '@/server/knowledge/retrieve';
import { buildBusinessContext, type BusinessContextSources } from './build';

/**
 * The one way an AI workflow asks "what do we know about this business?".
 *
 *   const ctx = await getBusinessContext(companyId, { query: topic });
 *   const preamble = businessContextToPrompt(ctx, 'content');
 *
 * getBusinessContext loads every source in parallel and resolves it through
 * server/business-context/build.ts; businessContextToPrompt renders it with a
 * per-workflow preset, so no call site decides for itself which fragments of
 * the business to mention.
 */

export interface BusinessContextOptions {
  /**
   * Optional sections to load. Defaults to all of them. Identity, audience
   * settings, objectives, preferred channels and voice always load — they are
   * on the Company row.
   */
  sections?: readonly ContextSection[];
  /** Retrieve knowledge passages about this. Omitted = no retrieval. */
  query?: string;
  knowledgeLimit?: number;
}

export async function getBusinessContext(
  companyId: string,
  options: BusinessContextOptions = {},
): Promise<BusinessContext | null> {
  const want = new Set(options.sections ?? CONTEXT_SECTIONS);
  const skip = Promise.resolve(undefined);

  const [
    company,
    targeting,
    market,
    plan,
    connections,
    knowledge,
    memory,
    passages,
  ] = await Promise.all([
    db.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        website: true,
        industry: true,
        brandVoiceNotes: true,
        brandVoiceProfile: true,
        preferences: true,
      },
    }),
    want.has('targeting') ? loadTargeting(companyId) : skip,
    want.has('market') ? loadMarket(companyId) : skip,
    want.has('plan')
      ? db.marketingPlan.findFirst({
          where: { companyId },
          orderBy: { month: 'desc' },
          select: { inputs: true },
        })
      : skip,
    want.has('connections') ? loadConnections(companyId) : skip,
    want.has('knowledge') ? loadKnowledge(companyId) : skip,
    want.has('memory')
      ? db.marketingMemory.findMany({
          where: { companyId, isActive: true },
          orderBy: { generatedAt: 'desc' },
          take: 50,
        })
      : skip,
    options.query
      ? retrieve(companyId, options.query, {
          limit: options.knowledgeLimit ?? 6,
        })
      : skip,
  ]);
  if (!company) return null;

  const sources: BusinessContextSources = {
    company,
    targeting,
    market,
    // `null` (no plan yet) still counts as "plan section loaded".
    plan: want.has('plan') ? (plan ?? null) : undefined,
    connections,
    knowledge,
    memory,
    passages,
  };
  return buildBusinessContext(sources);
}

async function loadTargeting(companyId: string) {
  const [outreach, discoveryProfiles] = await Promise.all([
    db.outreachConfig.findUnique({
      where: { companyId },
      select: { roleTitles: true, industries: true, companyStages: true },
    }),
    // Same filter getAudienceProfile uses, so both see the same buyers.
    db.discoveryProfile.findMany({
      where: { companyId, isActive: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { criteria: true },
    }),
  ]);
  return { outreach, discoveryProfiles };
}

async function loadMarket(companyId: string) {
  const [competitors, trendConfig] = await Promise.all([
    db.competitorProfile.findMany({
      where: { companyId },
      orderBy: { createdAt: 'asc' },
      select: { name: true, url: true, trackingEnabled: true },
    }),
    db.companyTrendConfig.findUnique({
      where: { companyId },
      select: {
        keywords: true,
        competitorNames: true,
        geoCountry: true,
        geoRegion: true,
        geoCity: true,
        language: true,
      },
    }),
  ]);
  return { competitors, trendConfig };
}

async function loadConnections(companyId: string) {
  const [connections, linkedIn] = await Promise.all([
    db.connection.findMany({
      where: { companyId, status: 'CONNECTED' },
      select: { connectorId: true },
    }),
    db.linkedInConnection.count({ where: { companyId, status: 'ACTIVE' } }),
  ]);
  return {
    connectorIds: connections.map((c) => c.connectorId),
    linkedInConnected: linkedIn > 0,
  };
}

async function loadKnowledge(companyId: string) {
  const [groups, sites] = await Promise.all([
    db.knowledgeChunk.groupBy({
      by: ['category'],
      where: { companyId },
      _count: { _all: true },
    }),
    db.knowledgeSource.findMany({
      where: { companyId, type: 'WEBSITE', url: { not: null } },
      select: { url: true },
    }),
  ]);
  return {
    chunkCounts: groups.map((g) => ({
      category: g.category,
      chunks: g._count._all,
    })),
    websiteUrls: sites.map((s) => s.url).filter((u): u is string => Boolean(u)),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Which parts of the business each workflow is told about.
 *
 * Kept as data so the choice is visible in one place and reviewable, rather
 * than spread across ten prompt builders. The reasoning for the less obvious
 * omissions:
 *
 *   · outreach and engagement leave out the audience block: they address one
 *     named person or reply to someone else's post, and the workspace's buyer
 *     persona would fight the specific reader in the prompt;
 *   · planning workflows leave out writing rules: they decide what to write,
 *     not how;
 *   · image briefs leave out voice: tone of prose does not steer a picture,
 *     brand colours do.
 */
export interface ContextPromptOptions {
  identity?: boolean;
  /** The buyer as writing instructions ("write TO this person"). */
  audience?: boolean;
  /** The buyer as plain facts, for workflows that judge rather than write. */
  buyer?: boolean;
  voice?: boolean;
  writingRules?: boolean;
  channels?: boolean;
  market?: boolean;
  visual?: boolean;
  knowledge?: boolean;
  /** Insight types to include. `true` = all, `false` = none. */
  memory?: boolean | InsightType[];
}

export const WORKFLOW_PRESETS = {
  content: {
    identity: true,
    audience: true,
    voice: true,
    writingRules: true,
    knowledge: true,
    memory: ['CONTENT_FORMAT', 'CONTENT_LENGTH', 'TIMING', 'TOPIC', 'HASHTAG'],
  },
  planning: {
    identity: true,
    audience: true,
    voice: true,
    channels: true,
    market: true,
    knowledge: true,
    memory: true,
  },
  advisor: {
    identity: true,
    audience: true,
    voice: true,
    channels: true,
    market: true,
    memory: true,
  },
  outreach: {
    identity: true,
    voice: true,
    knowledge: true,
    memory: ['OUTREACH_APPROACH', 'TIMING'],
  },
  engagement: { identity: true, voice: true },
  image: { identity: true, audience: true, visual: true },
  qualification: { identity: true, buyer: true },
} as const satisfies Record<string, ContextPromptOptions>;

export type ContextWorkflow = keyof typeof WORKFLOW_PRESETS;

/** The context's audience in the shape the existing prompt helpers take. */
export function toAudienceProfile(
  ctx: BusinessContext,
): AudienceProfile | null {
  const a = ctx.audience;
  const goals = ctx.objectives.goals;
  if (
    !a.stated &&
    !goals &&
    !a.marketMode &&
    a.roleTitles.length === 0 &&
    a.industries.length === 0 &&
    a.companyStages.length === 0
  ) {
    return null;
  }
  const sources = new Set<string>();
  for (const path of ['audience.roleTitles', 'audience.industries']) {
    for (const s of ctx.meta.provenance[path]?.sources ?? []) {
      sources.add(
        s === 'outreach_targeting'
          ? 'outreach targeting'
          : 'lead discovery profiles',
      );
    }
  }
  if (a.stated || goals) sources.add('audience settings');
  return {
    roleTitles: a.roleTitles,
    industries: a.industries,
    companyStages: a.companyStages,
    ...(a.stated ? { stated: a.stated } : {}),
    ...(goals ? { goals } : {}),
    ...(a.marketMode ? { mode: a.marketMode } : {}),
    sources: [...sources],
  };
}

function buyerBlock(ctx: BusinessContext): string {
  const a = ctx.audience;
  const lines = [
    a.marketMode === 'B2C'
      ? 'Sells to: consumers'
      : a.marketMode === 'B2B'
        ? 'Sells to: businesses'
        : '',
    a.stated ? `Ideal customer, in the company's own words: ${a.stated}` : '',
    a.roleTitles.length ? `Buyer roles: ${a.roleTitles.join(', ')}` : '',
    a.industries.length ? `Buyer industries: ${a.industries.join(', ')}` : '',
    a.companyStages.length
      ? `Buyer company stages: ${a.companyStages.join(', ')}`
      : '',
  ].filter(Boolean);
  return lines.length ? ['TARGET BUYER:', ...lines].join('\n') : '';
}

function voiceBlock(ctx: BusinessContext): string {
  if (ctx.voice.profile) return brandVoiceToPrompt(ctx.voice.profile);
  // No structured profile yet: the user's own words beat no voice at all.
  if (ctx.voice.summary) {
    return [
      "BRAND VOICE — in the company's own words:",
      ctx.voice.summary,
    ].join('\n');
  }
  return '';
}

function memoryBlock(
  ctx: BusinessContext,
  filter: ContextPromptOptions['memory'],
): string {
  if (!filter) return '';
  const insights = ctx.memory.insights.filter(
    (m) => filter === true || (filter as readonly string[]).includes(m.type),
  );
  if (insights.length === 0) return '';
  return [
    'WHAT WE HAVE LEARNED WORKS FOR THIS ACCOUNT (apply where it genuinely fits;',
    'these are data-backed patterns from real past performance):',
    ...insights
      .slice(0, 12)
      .map((m) => `- [${m.type}] ${m.insight} (confidence: ${m.confidence})`),
    // The resolution rule for memory, stated to the model: learned patterns
    // are advice, never a reason to break what the business has told us.
    'These patterns never override the brand voice, the stated audience, or topics to avoid.',
  ].join('\n');
}

/**
 * Render the context as the shared preamble for an AI workflow.
 *
 * Order is identity → audience → voice → rules → channels/market → memory →
 * knowledge: what the company is, who it talks to, how it sounds, then what it
 * may draw on. Every block renders to nothing when the workspace has not
 * supplied it, so an empty workspace gets a short prompt rather than invented
 * claims.
 */
export function businessContextToPrompt(
  ctx: BusinessContext | null,
  workflow: ContextWorkflow | ContextPromptOptions,
): string {
  if (!ctx) return '';
  const o: ContextPromptOptions =
    typeof workflow === 'string' ? WORKFLOW_PRESETS[workflow] : workflow;
  const audience = toAudienceProfile(ctx);
  const blocks: string[] = [];

  if (o.identity) {
    blocks.push(
      businessToPrompt(
        {
          description: ctx.identity.description ?? undefined,
          offerings: ctx.identity.offerings ?? undefined,
        },
        ctx.identity.industry,
      ),
    );
  }
  if (o.audience) blocks.push(audienceToPrompt(audience));
  if (o.buyer) blocks.push(buyerBlock(ctx));
  if (o.voice) blocks.push(voiceBlock(ctx));
  if (o.writingRules) blocks.push(contentRulesFor(ctx.audience.marketMode));

  if (o.channels && ctx.channels.preferred.length) {
    const unconnected = ctx.channels.preferred.filter(
      (c) => !ctx.channels.connected.includes(c),
    );
    blocks.push(
      [
        `CHANNELS: the company publishes on ${ctx.channels.preferred.join(', ')}.`,
        ctx.meta.sections.includes('connections') && unconnected.length
          ? `Not connected (plan for them, but Aura cannot publish there): ${unconnected.join(', ')}.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (o.market) {
    const lines: string[] = [];
    if (ctx.market.competitors.length) {
      lines.push(
        `Competitors: ${ctx.market.competitors.map((c) => c.name).join(', ')}.`,
        'Position against them with a differentiated angle; never copy their claims.',
      );
    }
    if (ctx.market.keywords.length) {
      lines.push(
        `Market topics they follow: ${ctx.market.keywords.slice(0, 12).join(', ')}.`,
      );
    }
    if (lines.length) blocks.push(['MARKET:', ...lines].join('\n'));
  }

  if (o.visual && ctx.identity.visual) {
    const v = ctx.identity.visual;
    const colours = [
      v.primaryColor && `primary ${v.primaryColor}`,
      v.secondaryColor && `secondary ${v.secondaryColor}`,
      v.accentColor && `accent ${v.accentColor}`,
    ].filter(Boolean);
    if (colours.length) blocks.push(`BRAND COLOURS: ${colours.join(', ')}.`);
  }

  blocks.push(memoryBlock(ctx, o.memory));

  if (o.knowledge && ctx.knowledge.passages.length) {
    blocks.push(
      [
        'COMPANY KNOWLEDGE — the only facts you may state as this company:',
        chunksToContext(ctx.knowledge.passages),
        'Do not invent product names, customers, numbers or claims beyond this.',
      ].join('\n'),
    );
  }

  return blocks.filter(Boolean).join('\n\n');
}
