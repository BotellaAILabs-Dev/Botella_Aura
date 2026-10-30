import { db } from '@/lib/db';
import { NOT_MIRRORED } from '@/lib/connection-manager';
import {
  CHANNEL_CONNECTORS,
  type BusinessContext,
} from '@/lib/business-context';
import { brandVoiceProfileSchema } from '@/lib/validations/content';
import { getBusinessContext } from './business-context.service';
import { normaliseText, readPlanDuplicates } from './build';

/**
 * Proof that connecting Aura's existing sources to the Business Context layer
 * lost nothing.
 *
 * For one workspace, every stored business value that HAS data is checked
 * against the resolved context:
 *
 *   reachable    — the value is in the context;
 *   superseded   — a higher-precedence source holds a different value, and
 *                  the difference is recorded as a conflict (nothing silent);
 *   intentional  — deliberately not mapped, with the reason (operational
 *                  settings, AI-generated reports, legacy seed-only keys);
 *   LOST         — has data, is none of the above. This is the failure the
 *                  check exists to catch.
 *
 * `checkCoverage` is pure; `auditContextCoverage` loads the rows. Run it for
 * every workspace with `pnpm verify:context-sources`.
 */

export type CoverageStatus =
  'reachable' | 'superseded' | 'intentional' | 'lost';

export interface CoverageCheck {
  source: string;
  field: string;
  status: CoverageStatus;
  /** Where it lives in the context, or why it does not. */
  detail: string;
}

export interface CoverageReport {
  companyId: string;
  checks: CoverageCheck[];
  lost: CoverageCheck[];
}

/** The raw rows the check compares against the context. */
export interface RawSources {
  company: {
    name: string;
    website: string | null;
    industry: string | null;
    logoUrl: string | null;
    brandVoiceNotes: string | null;
    brandVoiceProfile: unknown;
    preferences: unknown;
  };
  outreach: {
    roleTitles: string[];
    industries: string[];
    companyStages: string[];
  } | null;
  /** Active discovery profiles, newest first. */
  discovery: { name: string; criteria: unknown }[];
  competitors: { name: string; notes: string | null }[];
  trend: {
    keywords: string[];
    competitorNames: string[];
    subreddits: string[];
    rssFeeds: string[];
  } | null;
  latestPlanInputs: unknown;
  activeCampaigns: { name: string }[];
  connectorIds: string[];
  linkedInActive: boolean;
  knowledgeChunks: number;
  realMemories: number;
  recentContentTitles: string[];
  hasAnalytics: boolean;
}

/** Preference keys the context maps, and keys deliberately left out. */
const MAPPED_PREFERENCE_KEYS = new Set([
  'business',
  'marketingProfile',
  'brand',
  'contentFormats',
  'factMeta',
]);
const INTENTIONAL_PREFERENCE_KEYS: Record<string, string> = {
  autopilot: 'Automation settings, not a fact about the business.',
  tone: 'Legacy key written only by the seed scripts; tone lives in brand voice notes and the voice profile.',
  emojiUsage:
    'Legacy key written only by the seed scripts; emoji style lives in the voice profile.',
};

const bag = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const text = (v: unknown) =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
const has = (list: string[], value: string) =>
  list.some((x) => normaliseText(x) === normaliseText(value));

export function checkCoverage(
  raw: RawSources,
  ctx: BusinessContext,
): CoverageCheck[] {
  const checks: CoverageCheck[] = [];
  const add = (
    source: string,
    field: string,
    status: CoverageStatus,
    detail: string,
  ) => checks.push({ source, field, status, detail });
  const conflictOn = (path: string) =>
    ctx.meta.issues.some(
      (i) => i.field === path && i.kind === 'value_conflict',
    );

  /** A single value that should be the context's value at `path`. */
  const same = (
    source: string,
    field: string,
    value: string | null,
    actual: string | null | undefined,
    path: string,
  ) => {
    if (!value) return;
    if (actual && normaliseText(actual) === normaliseText(value)) {
      add(source, field, 'reachable', path);
    } else if (actual && conflictOn(path)) {
      add(
        source,
        field,
        'superseded',
        `${path} (a higher-precedence source wins; recorded as a conflict)`,
      );
    } else {
      add(source, field, 'lost', `has a value, but ${path} does not carry it`);
    }
  };

  /** Every item of a list should be in the context list (or the list is capped). */
  const all = (
    source: string,
    field: string,
    values: string[],
    actual: string[],
    path: string,
    cap?: number,
  ) => {
    const present = values.filter((v) => v.trim());
    if (!present.length) return;
    const missing = present.filter((v) => !has(actual, v));
    if (!missing.length) add(source, field, 'reachable', path);
    else if (cap !== undefined && actual.length >= cap) {
      add(
        source,
        field,
        'reachable',
        `${path} (capped at ${cap}; ${missing.length} not shown to models)`,
      );
    } else
      add(source, field, 'lost', `${path} is missing: ${missing.join(', ')}`);
  };

  // --- Company row and preferences (onboarding + settings) ---------------------
  const c = raw.company;
  const prefs = bag(c.preferences);
  const business = bag(prefs.business);
  const marketing = bag(prefs.marketingProfile);
  const brand = bag(prefs.brand);

  same('Company', 'name', text(c.name), ctx.identity.name, 'identity.name');
  if (text(c.website)) {
    same(
      'Company',
      'website',
      c.website,
      ctx.identity.website,
      'identity.website',
    );
  }
  same(
    'Company',
    'industry',
    text(c.industry),
    ctx.identity.industry,
    'identity.industry',
  );
  same(
    'preferences.business',
    'description',
    text(business.description),
    ctx.identity.description,
    'identity.description',
  );
  same(
    'preferences.business',
    'offerings',
    text(business.offerings),
    ctx.identity.offerings,
    'identity.offerings',
  );
  same(
    'preferences.marketingProfile',
    'marketMode',
    text(marketing.marketMode),
    ctx.audience.marketMode,
    'audience.marketMode',
  );
  same(
    'preferences.marketingProfile',
    'audience',
    text(marketing.audience),
    ctx.audience.stated,
    'audience.stated',
  );
  same(
    'preferences.marketingProfile',
    'goals',
    text(marketing.goals),
    ctx.objectives.goals,
    'objectives.goals',
  );
  if (Array.isArray(marketing.channels)) {
    all(
      'preferences.marketingProfile',
      'channels',
      marketing.channels as string[],
      ctx.channels.preferred,
      'channels.preferred',
    );
  }
  for (const key of [
    'logoAssetId',
    'primaryColor',
    'secondaryColor',
    'accentColor',
  ] as const) {
    const v = text(brand[key]);
    if (v)
      same(
        'preferences.brand',
        key,
        v,
        ctx.identity.visual?.[key] ?? null,
        `identity.visual.${key}`,
      );
  }
  const formats = bag(prefs.contentFormats).enabled;
  if (Array.isArray(formats) && formats.length) {
    all(
      'preferences.contentFormats',
      'enabled',
      formats as string[],
      ctx.objectives.contentFormats,
      'objectives.contentFormats',
    );
  }
  if (text(c.logoUrl)) {
    same(
      'Company',
      'logoUrl',
      c.logoUrl,
      ctx.identity.visual?.logoUrl ?? null,
      'identity.visual.logoUrl',
    );
  }
  same(
    'Company',
    'brandVoiceNotes',
    text(c.brandVoiceNotes),
    ctx.voice.notes,
    'voice.notes',
  );
  if (c.brandVoiceProfile) {
    const parsed = brandVoiceProfileSchema.safeParse(c.brandVoiceProfile);
    add(
      'Company',
      'brandVoiceProfile',
      parsed.success && ctx.voice.profile ? 'reachable' : 'lost',
      parsed.success
        ? 'voice.profile'
        : 'stored profile does not parse, so no workflow can use it',
    );
  }
  for (const key of Object.keys(prefs)) {
    if (MAPPED_PREFERENCE_KEYS.has(key)) continue;
    const reason = INTENTIONAL_PREFERENCE_KEYS[key];
    add(
      'preferences',
      key,
      reason ? 'intentional' : 'lost',
      reason ?? 'unknown preferences key — not mapped and not explained',
    );
  }

  // --- Targeting --------------------------------------------------------------------
  if (raw.outreach) {
    all(
      'OutreachConfig',
      'roleTitles',
      raw.outreach.roleTitles,
      ctx.audience.roleTitles,
      'audience.roleTitles',
      8,
    );
    all(
      'OutreachConfig',
      'industries',
      raw.outreach.industries,
      ctx.audience.industries,
      'audience.industries',
      8,
    );
    all(
      'OutreachConfig',
      'companyStages',
      raw.outreach.companyStages,
      ctx.audience.companyStages,
      'audience.companyStages',
      5,
    );
  }

  // The context reads the three newest active discovery profiles — the same
  // rule getAudienceProfile has always used. Older ones are reported, not
  // passed off as covered.
  raw.discovery.forEach((profile, i) => {
    const criteria = bag(profile.criteria);
    const list = (k: string) =>
      Array.isArray(criteria[k])
        ? (criteria[k] as unknown[]).filter(
            (v): v is string => typeof v === 'string',
          )
        : [];
    const roles = list('roleTitles');
    const industries = [...list('industries'), ...list('keywords')];
    if (!roles.length && !industries.length) return;
    if (i >= 3) {
      add(
        'DiscoveryProfile',
        `criteria (${profile.name})`,
        'intentional',
        'Only the 3 newest active profiles describe the audience; this one still drives lead discovery.',
      );
      return;
    }
    all(
      'DiscoveryProfile',
      `roleTitles (${profile.name})`,
      roles,
      ctx.audience.roleTitles,
      'audience.roleTitles',
      8,
    );
    all(
      'DiscoveryProfile',
      `industries/keywords (${profile.name})`,
      industries,
      ctx.audience.industries,
      'audience.industries',
      8,
    );
  });

  // --- Market -----------------------------------------------------------------------
  const competitorNames = ctx.market.competitors.map((x) => x.name);
  all(
    'CompetitorProfile',
    'name',
    raw.competitors.map((x) => x.name),
    competitorNames,
    'market.competitors',
  );
  for (const comp of raw.competitors) {
    if (!text(comp.notes)) continue;
    const mapped = ctx.market.competitors.find(
      (x) => normaliseText(x.name) === normaliseText(comp.name),
    );
    add(
      'CompetitorProfile',
      `notes (${comp.name})`,
      mapped?.notes ? 'reachable' : 'lost',
      'market.competitors[].notes',
    );
  }
  if (raw.trend) {
    all(
      'CompanyTrendConfig',
      'keywords',
      raw.trend.keywords,
      ctx.market.keywords,
      'market.keywords',
    );
    all(
      'CompanyTrendConfig',
      'competitorNames',
      raw.trend.competitorNames,
      competitorNames,
      'market.competitors',
    );
    if (raw.trend.subreddits.length || raw.trend.rssFeeds.length) {
      add(
        'CompanyTrendConfig',
        'subreddits / rssFeeds',
        'intentional',
        'Where the trend job fetches from — operational settings, not facts about the business.',
      );
    }
  }

  // --- Plan & campaigns -----------------------------------------------------------
  const plan = readPlanDuplicates(raw.latestPlanInputs);
  same(
    'MarketingPlan',
    'audience',
    plan.audience ?? null,
    ctx.audience.stated,
    'audience.stated',
  );
  same(
    'MarketingPlan',
    'businessGoals',
    plan.goals ?? null,
    ctx.objectives.goals,
    'objectives.goals',
  );
  if (plan.brandGuidelines) {
    add(
      'MarketingPlan',
      'brandGuidelines',
      ctx.voice.planGuidelines ? 'reachable' : 'lost',
      'voice.planGuidelines (and the last fallback for voice.summary)',
    );
  }
  all(
    'Campaign',
    'name (active/paused)',
    raw.activeCampaigns.map((x) => x.name),
    ctx.objectives.campaigns.map((x) => x.name),
    'objectives.campaigns',
    5,
  );

  // --- Channels ---------------------------------------------------------------------
  const channelConnectors = new Set(Object.values(CHANNEL_CONNECTORS).flat());
  for (const id of raw.connectorIds) {
    if (channelConnectors.has(id)) {
      add(
        'Connection',
        id,
        ctx.channels.connected.length ? 'reachable' : 'lost',
        'channels.connected',
      );
    } else {
      add(
        'Connection',
        id,
        'intentional',
        'Not a publishing channel (analytics, CRM, storage or design tool).',
      );
    }
  }
  if (raw.linkedInActive) {
    add(
      'LinkedInConnection',
      'ACTIVE',
      ctx.channels.connected.includes('LinkedIn') ? 'reachable' : 'lost',
      'channels.connected',
    );
  }

  // --- Knowledge, memory, history -----------------------------------------------------
  if (raw.knowledgeChunks) {
    add(
      'KnowledgeChunk',
      `${raw.knowledgeChunks} chunks`,
      ctx.knowledge.totalChunks === raw.knowledgeChunks ? 'reachable' : 'lost',
      'knowledge.coverage; passages via retrieval',
    );
  }
  if (raw.realMemories) {
    add(
      'MarketingMemory',
      `${raw.realMemories} active insights`,
      ctx.memory.insights.length ? 'reachable' : 'lost',
      'memory.insights',
    );
  }
  all(
    'ContentDraft',
    'recent published/approved titles',
    raw.recentContentTitles,
    ctx.history.recentContent.map((x) => x.title),
    'history.recentContent',
    10,
  );
  if (raw.hasAnalytics) {
    add(
      'AnalyticsReport',
      'latest metrics',
      ctx.history.performance ? 'reachable' : 'lost',
      'history.performance',
    );
  }
  return checks;
}

/** Not business context: outputs Aura generates, or per-record working data. */
export const INTENTIONALLY_UNMAPPED_TABLES: Record<string, string> = {
  TrendDigest:
    'An AI-written output built FROM the context; feeding it back in would be circular.',
  CompetitorSnapshot:
    'Raw change-tracking data; the competitor report summarises it.',
  CompetitorReport:
    'An AI-written output; the advisor reads it as evidence directly.',
  AdvisorReport: 'An AI-written output built from the context.',
  IntelligenceSnapshot:
    'A score computed from the context and activity, not an input to it.',
  WorkspaceBriefing: 'A weekly AI-written summary, built from the context.',
  Lead: 'Individual prospects. Who to target is in audience targeting; leads are records, not facts about the business.',
  OutreachMessage:
    'Individual messages; patterns that work reach the context through marketing memory.',
  EngagementTarget:
    'Accounts to engage with — a work queue, not a fact about the business.',
  PerformanceSnapshot:
    'Raw metrics per post; marketing memory and analytics reports summarise them.',
  GeneratedAsset: 'Images. The brand logo is mapped via identity.visual.',
  Subscription: 'Billing state.',
};

export async function auditContextCoverage(
  companyId: string,
): Promise<CoverageReport | null> {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const [
    company,
    outreach,
    discovery,
    competitors,
    trend,
    plan,
    campaigns,
    connections,
    linkedIn,
    chunks,
    memories,
    drafts,
    analytics,
    ctx,
  ] = await Promise.all([
    db.company.findUnique({
      where: { id: companyId },
      select: {
        name: true,
        website: true,
        industry: true,
        logoUrl: true,
        brandVoiceNotes: true,
        brandVoiceProfile: true,
        preferences: true,
      },
    }),
    db.outreachConfig.findUnique({
      where: { companyId },
      select: { roleTitles: true, industries: true, companyStages: true },
    }),
    db.discoveryProfile.findMany({
      where: { companyId, isActive: true },
      orderBy: { createdAt: 'desc' },
      select: { name: true, criteria: true },
    }),
    db.competitorProfile.findMany({
      where: { companyId },
      select: { name: true, notes: true },
    }),
    db.companyTrendConfig.findUnique({
      where: { companyId },
      select: {
        keywords: true,
        competitorNames: true,
        subreddits: true,
        rssFeeds: true,
      },
    }),
    db.marketingPlan.findFirst({
      where: { companyId },
      orderBy: { month: 'desc' },
      select: { inputs: true },
    }),
    db.campaign.findMany({
      where: { companyId, status: { in: ['ACTIVE', 'PAUSED'] } },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: { name: true },
    }),
    db.connection.findMany({
      where: { companyId, status: 'CONNECTED', ...NOT_MIRRORED },
      select: { connectorId: true },
    }),
    db.linkedInConnection.count({ where: { companyId, status: 'ACTIVE' } }),
    db.knowledgeChunk.count({ where: { companyId } }),
    db.marketingMemory.findMany({
      where: { companyId, isActive: true },
      select: { supportingDataSummary: true },
    }),
    db.contentDraft.findMany({
      where: {
        companyId,
        status: { in: ['PUBLISHED', 'APPROVED'] },
        updatedAt: { gte: since },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { title: true },
    }),
    db.analyticsReport.count({ where: { companyId } }),
    getBusinessContext(companyId),
  ]);
  if (!company || !ctx) return null;

  // Connected websites publish the Blog channel (server/websites).
  const websites = await db.websiteConnection.findMany({
    where: { companyId, status: 'CONNECTED' },
    select: { platform: true },
  });
  const checks = checkCoverage(
    {
      company,
      outreach,
      discovery,
      competitors,
      trend,
      latestPlanInputs: plan?.inputs ?? null,
      activeCampaigns: campaigns,
      connectorIds: [...new Set([...connections.map((x) => x.connectorId), ...websites.map((w) => w.platform)])],
      linkedInActive: linkedIn > 0,
      knowledgeChunks: chunks,
      realMemories: memories.filter(
        (m) => bag(m.supportingDataSummary).status !== 'insufficient',
      ).length,
      recentContentTitles: drafts
        .map((d) => d.title)
        .filter((t): t is string => Boolean(t?.trim())),
      hasAnalytics: analytics > 0,
    },
    ctx,
  );
  return { companyId, checks, lost: checks.filter((x) => x.status === 'lost') };
}
