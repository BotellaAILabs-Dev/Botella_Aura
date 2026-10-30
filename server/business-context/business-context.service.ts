import { productLine } from '@/lib/products';
import type { InsightType } from '@prisma/client';

import { db } from '@/lib/db';
import { NOT_MIRRORED } from '@/lib/connection-manager';
import {
  contextField,
  CONTEXT_SECTIONS,
  SOURCE_TYPE_INFO,
  type BusinessContext,
  type BusinessFact,
  type ContextFieldPath,
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
import {
  buildBusinessContext,
  fieldPresence,
  isEvaluable,
  type BusinessContextSources,
} from './build';

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
    campaigns,
    history,
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
        updatedAt: true,
        logoUrl: true,
      },
    }),
    want.has('targeting') ? loadTargeting(companyId) : skip,
    want.has('market') ? loadMarket(companyId) : skip,
    want.has('plan')
      ? db.marketingPlan.findFirst({
          where: { companyId },
          orderBy: { month: 'desc' },
          select: { inputs: true, month: true, updatedAt: true },
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
    // Campaigns ride with the plan section: both describe current focus.
    want.has('plan')
      ? db.campaign.findMany({
          where: { companyId, status: { in: ['ACTIVE', 'PAUSED'] } },
          orderBy: { updatedAt: 'desc' },
          take: 5,
          select: {
            name: true,
            status: true,
            goal: true,
            targetAudience: true,
            themes: true,
            endDate: true,
            updatedAt: true,
          },
        })
      : skip,
    want.has('history') ? loadHistory(companyId) : skip,
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
    campaigns,
    history,
  };
  return buildBusinessContext(sources);
}

/** What was recently published or approved, and the latest analytics period. */
async function loadHistory(companyId: string) {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const [recentContent, analytics] = await Promise.all([
    db.contentDraft.findMany({
      where: {
        companyId,
        status: { in: ['PUBLISHED', 'APPROVED'] }, // scheduled = APPROVED + scheduledFor
        updatedAt: { gte: since },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: {
        title: true,
        type: true,
        status: true,
        publishedAt: true,
        scheduledFor: true,
        updatedAt: true,
      },
    }),
    db.analyticsReport.findFirst({
      where: { companyId },
      orderBy: { periodStart: 'desc' },
      select: {
        periodStart: true,
        periodEnd: true,
        metrics: true,
        generatedAt: true,
      },
    }),
  ]);
  return { recentContent, analytics };
}

async function loadTargeting(companyId: string) {
  const [outreach, discoveryProfiles] = await Promise.all([
    db.outreachConfig.findUnique({
      where: { companyId },
      select: {
        roleTitles: true,
        industries: true,
        companyStages: true,
        updatedAt: true,
      },
    }),
    // Same filter getAudienceProfile uses, so both see the same buyers.
    db.discoveryProfile.findMany({
      where: { companyId, isActive: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { criteria: true, updatedAt: true },
    }),
  ]);
  return { outreach, discoveryProfiles };
}

async function loadMarket(companyId: string) {
  const [competitors, trendConfig, trendEdits] = await Promise.all([
    db.competitorProfile.findMany({
      where: { companyId },
      orderBy: { createdAt: 'asc' },
      select: {
        name: true,
        url: true,
        trackingEnabled: true,
        updatedAt: true,
        notes: true,
      },
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
        updatedAt: true,
        defaultsSeeded: true,
      },
    }),
    // AI seeding logs AI_SUGGESTION_GENERATED; only a person saving the
    // settings logs this. It is what separates their list from a model's guess.
    db.auditLog.count({
      where: { companyId, action: 'TREND_CONFIG_UPDATED' },
    }),
  ]);
  return { competitors, trendConfig, trendEditedByUser: trendEdits > 0 };
}

async function loadConnections(companyId: string) {
  const [connections, linkedIn, websites] = await Promise.all([
    db.connection.findMany({
      where: { companyId, status: 'CONNECTED', ...NOT_MIRRORED },
      select: { connectorId: true, lastSyncedAt: true, updatedAt: true },
    }),
    db.linkedInConnection.findFirst({
      where: { companyId, status: 'ACTIVE' },
      select: { updatedAt: true },
    }),
    // Connected websites (server/websites) publish the Blog channel.
    db.websiteConnection.findMany({
      where: { companyId, status: 'CONNECTED' },
      select: { platform: true, lastCheckedAt: true, updatedAt: true },
    }),
  ]);
  const synced = [
    ...connections.map((c) => c.lastSyncedAt ?? c.updatedAt),
    ...(linkedIn ? [linkedIn.updatedAt] : []),
    ...websites.map((w) => w.lastCheckedAt ?? w.updatedAt),
  ];
  return {
    connectorIds: [...new Set([...connections.map((c) => c.connectorId), ...websites.map((w) => w.platform)])],
    linkedInConnected: Boolean(linkedIn),
    lastSyncedAt: synced.length
      ? new Date(Math.max(...synced.map((d) => d.getTime())))
      : null,
  };
}

async function loadKnowledge(companyId: string) {
  const [groups, sites] = await Promise.all([
    db.knowledgeChunk.groupBy({
      by: ['category', 'sourceType'],
      where: { companyId },
      _count: { _all: true },
      _max: { createdAt: true },
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
      sourceType: g.sourceType,
      newestAt: g._max.createdAt,
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
  /** Running campaigns: their goals, audiences and themes. */
  campaigns?: boolean;
  /** Recently published content and the latest activity numbers. */
  history?: boolean;
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
    campaigns: true,
    history: true,
    knowledge: true,
    memory: true,
  },
  advisor: {
    identity: true,
    audience: true,
    voice: true,
    channels: true,
    market: true,
    campaigns: true,
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
  /**
   * Finding marketing opportunities: what the business is, who it sells to,
   * where it can act, what the market is doing and what has worked. No voice —
   * an opportunity is a decision about WHAT to do, not copy.
   */
  opportunity: {
    identity: true,
    audience: true,
    channels: true,
    market: true,
    campaigns: true,
    history: true,
    knowledge: true,
    memory: true,
  },
  /** Recommending specific next actions, which may include wording. */
  recommendation: {
    identity: true,
    audience: true,
    voice: true,
    channels: true,
    market: true,
    campaigns: true,
    history: true,
    knowledge: true,
    memory: true,
  },
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
  if (ctx.voice.profile) {
    const fact = ctx.meta.facts['voice.summary'];
    if (fact?.source === 'brand_voice_profile' && !fact.trusted) {
      // An AI draft nobody has reviewed is style guidance, not the company's
      // stated voice — and where the company did say something itself, that
      // goes alongside it so the verified source is never lost.
      return [
        brandVoiceToPrompt(ctx.voice.profile).replace(
          'BRAND VOICE — write exactly in this voice:',
          'BRAND VOICE — drafted by AI from their content and not yet reviewed by the company. Use it as style guidance:',
        ),
        ctx.voice.notes ? `In the company's own words: ${ctx.voice.notes}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    return brandVoiceToPrompt(ctx.voice.profile);
  }
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
  // A stale pattern describes an audience and an algorithm that have moved
  // on; it is left out rather than applied with a caveat.
  const insights = ctx.memory.insights.filter(
    (m) =>
      m.freshness !== 'stale' &&
      (filter === true || (filter as readonly string[]).includes(m.type)),
  );
  if (insights.length === 0) return '';
  return [
    'WHAT WE HAVE LEARNED WORKS FOR THIS ACCOUNT (apply where it genuinely fits;',
    'these are data-backed patterns from real past performance):',
    ...insights
      .slice(0, 12)
      .map(
        (m) =>
          `- [${m.type}] ${m.insight} (confidence: ${m.confidence}${
            m.editedByUser
              ? ', confirmed by the company'
              : m.confidence === 'LOW'
                ? ', tentative — small sample'
                : ''
          })`,
      ),
    // The resolution rule for memory, stated to the model: learned patterns
    // are advice, never a reason to break what the business has told us.
    'These patterns never override the brand voice, the stated audience, or topics to avoid.',
  ].join('\n');
}

/** Fields each prompt block puts in front of the model. */
const BLOCK_FIELDS: Partial<
  Record<keyof ContextPromptOptions, ContextFieldPath[]>
> = {
  identity: [
    'identity.description',
    'identity.offerings',
    'identity.products',
    'identity.industry',
  ],
  audience: [
    'audience.marketMode',
    'audience.stated',
    'audience.roleTitles',
    'audience.industries',
    'objectives.goals',
  ],
  buyer: [
    'audience.marketMode',
    'audience.stated',
    'audience.roleTitles',
    'audience.industries',
    'audience.companyStages',
  ],
  voice: ['voice.summary'],
  channels: ['channels.preferred', 'channels.connected'],
  market: ['market.competitors', 'market.keywords'],
  campaigns: ['objectives.campaigns'],
  history: ['history.recentContent', 'history.performance'],
};

/** Every context field a set of prompt options puts in front of the model. */
export function fieldsUsedBy(options: ContextPromptOptions): Set<ContextFieldPath> {
  const paths = new Set<ContextFieldPath>();
  for (const [flag, fields] of Object.entries(BLOCK_FIELDS)) {
    if (options[flag as keyof ContextPromptOptions]) fields?.forEach((f) => paths.add(f));
  }
  if (options.voice) paths.add('voice.summary');
  return paths;
}

/**
 * What the model must be told it does NOT know.
 *
 * A required or recommended field this workflow uses, with no value at all.
 * Without saying so, a model fills the hole with the most plausible-sounding
 * guess — "your audience prefers Instagram" for a business that never said who
 * its audience is. Stating the gap is what turns a confident invention into
 * "I don't know that yet".
 */
export function unknownFields(
  ctx: BusinessContext,
  options: ContextPromptOptions,
): ContextFieldPath[] {
  return [...fieldsUsedBy(options)].filter(
    (path) =>
      !ctx.meta.facts[path] &&
      contextField(path).requirement !== 'optional' &&
      // A business that says what it sells in a sentence has told Aura; a
      // catalogue sharpens that, its absence is not an unknown.
      !(path === 'identity.products' && ctx.meta.facts['identity.offerings']),
  );
}

/**
 * Labelled inline where they are rendered, so not repeated as a caveat: the AI
 * voice draft, AI-suggested competitors and keywords, and memory (whose stale
 * patterns are dropped and thin ones marked tentative).
 */
function labelledInline(path: string, fact: BusinessFact): boolean {
  if (path === 'voice.summary' && fact.source === 'brand_voice_profile')
    return true;
  if (
    (path === 'market.competitors' || path === 'market.keywords') &&
    fact.sourceType === 'ai_derived'
  )
    return true;
  return false;
}

export interface ContextCaveat {
  field: ContextFieldPath;
  label: string;
  reason: string;
}

/**
 * Facts a workflow will use that are not trusted or not current.
 *
 * A workflow uses this to tell the user what its output rests on; the prompt
 * renderer uses the same list, so the model and the user are warned about the
 * same things.
 */
export function contextCaveats(
  ctx: BusinessContext,
  options: ContextPromptOptions,
): ContextCaveat[] {
  const paths = new Set<ContextFieldPath>();
  for (const [flag, fields] of Object.entries(BLOCK_FIELDS)) {
    if (options[flag as keyof ContextPromptOptions])
      fields?.forEach((f) => paths.add(f));
  }
  const caveats: ContextCaveat[] = [];
  for (const path of paths) {
    const fact = ctx.meta.facts[path];
    if (!fact || labelledInline(path, fact)) continue;
    const reasons: string[] = [];
    if (!fact.trusted) {
      reasons.push(
        fact.note ??
          `comes from ${SOURCE_TYPE_INFO[fact.sourceType].label.toLowerCase()}, not confirmed by the company`,
      );
    }
    if (fact.freshness === 'stale') {
      reasons.push(
        fact.ageDays !== null
          ? `last updated ${fact.ageDays} days ago and may be out of date`
          : 'may be out of date',
      );
    }
    if (reasons.length) {
      caveats.push({
        field: path,
        label: contextField(path).label,
        reason: reasons.join('; '),
      });
    }
  }
  return caveats;
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
    if (ctx.identity.products.length) {
      blocks.push(
        [
          'PRODUCTS — what each is, who it is for and why people choose it, in the company’s own words. Name a product only as described here:',
          ...ctx.identity.products
            .slice(0, 12)
            .map((p) => `- ${productLine(p)}${p.featured ? ' [lead product]' : ''}`),
        ].join('\n'),
      );
    }
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
    const known = ctx.market.competitors.filter(
      (c) => c.confidence !== 'unverified',
    );
    const guessed = ctx.market.competitors.filter(
      (c) => c.confidence === 'unverified',
    );
    if (known.length) {
      lines.push(
        `Competitors: ${known.map((c) => c.name).join(', ')}.`,
        ...known
          .filter((c) => c.notes)
          .map((c) => `- Their notes on ${c.name}: ${c.notes}`),
        'Position against them with a differentiated angle; never copy their claims.',
      );
    }
    if (guessed.length) {
      lines.push(
        `Possibly competitors (suggested by AI, never confirmed by the company): ${guessed
          .map((c) => c.name)
          .join(
            ', ',
          )}. Use only as background; never name them as competitors in output.`,
      );
    }
    if (ctx.market.keywords.length) {
      const unverified = ctx.meta.facts['market.keywords']?.trusted === false;
      lines.push(
        unverified
          ? `Topics that may matter to them (suggested by AI, unconfirmed): ${ctx.market.keywords.slice(0, 12).join(', ')}.`
          : `Market topics they follow: ${ctx.market.keywords.slice(0, 12).join(', ')}.`,
      );
    }
    if (lines.length) blocks.push(['MARKET:', ...lines].join('\n'));
  }

  if (o.campaigns && ctx.objectives.campaigns.length) {
    blocks.push(
      [
        'RUNNING CAMPAIGNS:',
        ...ctx.objectives.campaigns.map((c) =>
          [
            `- ${c.name}${c.status === 'PAUSED' ? ' (paused)' : ''}`,
            c.goal ? ` — goal: ${c.goal}` : '',
            c.audience ? `; audience: ${c.audience}` : '',
            c.themes.length ? `; themes: ${c.themes.join(', ')}` : '',
          ].join(''),
        ),
        'Work should support these where it fits, not compete with them.',
      ].join('\n'),
    );
  }

  if (o.history) {
    const h = ctx.history;
    const lines: string[] = [];
    if (h.recentContent.length) {
      lines.push(
        'Already published or scheduled recently — do not repeat these topics:',
        ...h.recentContent.map((c) => `- ${c.title}`),
      );
    }
    if (h.performance) {
      const m = Object.entries(h.performance.metrics)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      lines.push(
        `Recorded activity ${h.performance.periodStart.slice(0, 10)} to ${h.performance.periodEnd.slice(0, 10)}: ${m}.`,
      );
    }
    if (lines.length) blocks.push(['RECENT HISTORY:', ...lines].join('\n'));
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

  const unknown = unknownFields(ctx, o);
  if (unknown.length) {
    blocks.push(
      [
        `NOT YET KNOWN — the company has not told Aura its: ${unknown
          .map((p) => contextField(p).label.toLowerCase())
          .join('; ')}.`,
        'Do not guess, assume or state anything about these as fact. If the work depends on one, say plainly that it is not known yet rather than filling the gap.',
      ].join('\n'),
    );
  }

  const caveats = contextCaveats(ctx, o);
  if (caveats.length) {
    blocks.push(
      [
        'RELIABILITY NOTES:',
        ...caveats.map((c) => `- ${c.label}: ${c.reason}`),
        'Treat these as working assumptions. Use them to guide the work, but never state them as verified facts about the company.',
      ].join('\n'),
    );
  }

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

// ---------------------------------------------------------------------------
// Workflow retrieval interface
// ---------------------------------------------------------------------------

/**
 * What each workflow loads and what it cannot run without.
 *
 * `sections` keeps each workflow's query cost to what its preset renders.
 * `requires` is the minimum for output worth showing: an opportunity for a
 * business nobody described is invented, so the workflow should say what is
 * missing instead of running.
 */
export const WORKFLOW_REQUIREMENTS: Record<
  ContextWorkflow,
  { sections: ContextSection[]; requires: ContextFieldPath[] }
> = {
  content: {
    sections: ['targeting', 'memory'],
    requires: ['identity.description'],
  },
  planning: {
    sections: [
      'targeting',
      'market',
      'connections',
      'memory',
      'plan',
      'history',
    ],
    requires: ['identity.description'],
  },
  advisor: {
    sections: ['targeting', 'market', 'connections', 'memory', 'plan'],
    requires: ['identity.description'],
  },
  outreach: { sections: ['memory'], requires: ['identity.description'] },
  engagement: { sections: [], requires: [] },
  image: { sections: ['targeting'], requires: [] },
  qualification: { sections: ['targeting'], requires: [] },
  opportunity: {
    sections: [
      'targeting',
      'market',
      'connections',
      'knowledge',
      'memory',
      'plan',
      'history',
    ],
    requires: [
      'identity.description',
      'audience.marketMode',
      'audience.stated',
    ],
  },
  recommendation: {
    sections: [
      'targeting',
      'market',
      'connections',
      'knowledge',
      'memory',
      'plan',
      'history',
    ],
    requires: [
      'identity.description',
      'audience.marketMode',
      'audience.stated',
    ],
  },
};

export interface WorkflowContext {
  context: BusinessContext;
  /** The rendered preamble for this workflow. */
  prompt: string;
  /** False when a field this workflow requires is missing. */
  ready: boolean;
  /** Required-but-missing fields, with where the user fixes each one. */
  missing: { field: ContextFieldPath; label: string; href?: string }[];
  /**
   * Facts this workflow uses that are unconfirmed or stale. Show them next to
   * the output so a user can see what it rests on.
   */
  caveats: ContextCaveat[];
}

/**
 * The entry point for an AI workflow.
 *
 *   const wf = await getWorkflowContext(companyId, 'opportunity');
 *   if (!wf.ready) return emptyState(wf.missing);
 *   await model({ system: wf.prompt, ... });
 *
 * One call returns the context, the rendered preamble and whether the
 * workflow has enough to run, so a new workflow cannot forget any of the three.
 */
export async function getWorkflowContext(
  companyId: string,
  workflow: ContextWorkflow,
  options: Pick<BusinessContextOptions, 'query' | 'knowledgeLimit'> = {},
): Promise<WorkflowContext | null> {
  const req = WORKFLOW_REQUIREMENTS[workflow];
  const context = await getBusinessContext(companyId, {
    sections: req.sections,
    query: options.query,
    knowledgeLimit: options.knowledgeLimit,
  });
  if (!context) return null;

  const present = fieldPresence(context);
  const missing = req.requires
    .filter((path) => isEvaluable(context, path) && !present[path])
    .map((path) => {
      const def = contextField(path);
      return { field: path, label: def.label, href: def.href };
    });

  return {
    context,
    prompt: businessContextToPrompt(context, workflow),
    caveats: contextCaveats(context, WORKFLOW_PRESETS[workflow]),
    ready: missing.length === 0,
    missing,
  };
}
