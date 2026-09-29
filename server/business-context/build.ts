import type { MaterialCategory, Prisma } from '@prisma/client';

import {
  BUSINESS_CONTEXT_VERSION,
  CHANNEL_CONNECTORS,
  contextField,
  CONTEXT_FIELDS,
  type BusinessContext,
  type ContextCompetitor,
  type ContextFieldPath,
  type ContextInsight,
  type ContextIssue,
  type ContextProvenance,
  type ContextSection,
  type ContextSource,
} from '@/lib/business-context';
import { MATERIAL_CATEGORIES } from '@/lib/materials';
import { CONTENT_CHANNELS } from '@/lib/validations/planner';
import { brandVoiceProfileSchema } from '@/lib/validations/content';
import {
  readBrandAssets,
  readBusinessProfile,
  readContentFormats,
  readMarketingProfile,
} from '@/server/company/profile.service';
import {
  composeAudienceProfile,
  type AudienceTargeting,
} from '@/server/content/audience';
import type { RetrievedChunk } from '@/server/knowledge/retrieve';

/**
 * Turning raw rows into a BusinessContext.
 *
 * Pure: the service loads rows, this maps and resolves them. Every mapping
 * rule and every conflict rule lives here, so it can be tested without a
 * database and cannot differ between callers.
 */

type Channel = (typeof CONTENT_CHANNELS)[number];

/** Everything the builder reads. Undefined means "section not loaded". */
export interface BusinessContextSources {
  company: {
    id: string;
    name: string;
    website: string | null;
    industry: string | null;
    brandVoiceNotes: string | null;
    brandVoiceProfile: unknown;
    preferences: unknown;
  };
  targeting?: {
    outreach: AudienceTargeting | null;
    discoveryProfiles: { criteria: unknown }[];
  };
  market?: {
    competitors: {
      name: string;
      url: string | null;
      trackingEnabled: boolean;
    }[];
    trendConfig: {
      keywords: string[];
      competitorNames: string[];
      geoCountry: string | null;
      geoRegion: string | null;
      geoCity: string | null;
      language: string;
    } | null;
  };
  plan?: { inputs: unknown } | null;
  connections?: { connectorIds: string[]; linkedInConnected: boolean };
  knowledge?: {
    chunkCounts: { category: MaterialCategory | null; chunks: number }[];
    websiteUrls: string[];
  };
  memory?: {
    id: string;
    insightType: string;
    insight: string;
    confidence: string;
    sampleSize: number;
    supportingDataSummary: unknown;
  }[];
  passages?: RetrievedChunk[];
}

// ---------------------------------------------------------------------------
// Resolution primitives
// ---------------------------------------------------------------------------

interface Candidate<T> {
  source: ContextSource;
  value: T | null | undefined;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Case, whitespace and trailing punctuation are not a disagreement. */
export function normaliseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!\s]+$/, '')
    .trim();
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return normaliseText(a) === normaliseText(b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const set = (xs: unknown[]) =>
      [...new Set(xs.map((x) => normaliseText(String(x))))].sort().join('|');
    return set(a) === set(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Candidates in the field's registered precedence order, empties dropped. */
function ordered<T>(path: ContextFieldPath, candidates: Candidate<T>[]) {
  const order = contextField(path).sources;
  return candidates
    .filter((c) => !isEmpty(c.value))
    .sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source)) as {
    source: ContextSource;
    value: T;
  }[];
}

class Resolver {
  readonly provenance: Record<string, ContextProvenance> = {};
  readonly issues: ContextIssue[] = [];

  /**
   * First non-empty source wins. A different value in a lower source is a
   * value_conflict, reported with both values so the user can see what was
   * ignored and fix the one that is wrong.
   */
  precedence<T>(
    path: ContextFieldPath,
    candidates: Candidate<T>[],
    options: {
      equals?: (a: T, b: T) => boolean;
      /** Why the winner won, in words a user would accept. */
      rule?: string;
    } = {},
  ): T | null {
    const present = ordered(path, candidates);
    const winner = present[0];
    if (!winner) return null;

    const def = contextField(path);
    const rest = present.slice(1);
    this.provenance[path] = {
      sources: present.map((c) => c.source),
      inferred: winner.source !== def.sources[0],
    };

    if (def.resolution !== 'layered') {
      const equals = options.equals ?? sameValue;
      const disagreeing = rest.filter((c) => !equals(winner.value, c.value));
      if (disagreeing.length > 0) {
        this.issues.push({
          field: path,
          kind: 'value_conflict',
          severity: 'info',
          message:
            options.rule ??
            `${def.label} differs between sources; using the ${winner.source.replace(/_/g, ' ')} value.`,
          chosen: { source: winner.source, value: winner.value },
          overridden: disagreeing.map((c) => ({
            source: c.source,
            value: c.value,
          })),
        });
      }
    }
    return winner.value;
  }

  /** Merge every source's list; the earliest source's spelling survives. */
  union(
    path: ContextFieldPath,
    candidates: Candidate<string[]>[],
    cap?: number,
  ): string[] {
    const present = ordered(path, candidates);
    const seen = new Map<string, string>();
    for (const c of present) {
      for (const raw of c.value) {
        const v = raw.trim();
        if (!v) continue;
        const key = normaliseText(v);
        if (!seen.has(key)) seen.set(key, v);
      }
    }
    if (present.length > 0) {
      this.provenance[path] = {
        sources: present.map((c) => c.source),
        inferred: false,
      };
    }
    const all = [...seen.values()];
    return cap === undefined ? all : all.slice(0, cap);
  }

  note(issue: ContextIssue) {
    this.issues.push(issue);
  }
}

// ---------------------------------------------------------------------------
// Source mappers
// ---------------------------------------------------------------------------

/**
 * The fields of a MarketingPlan's inputs that duplicate workspace settings.
 *
 * Read field by field rather than through planInputsSchema: a plan saved by an
 * older build must still contribute what it can, and one bad field must not
 * discard the rest.
 */
export function readPlanDuplicates(inputs: unknown): {
  audience?: string;
  goals?: string;
  channels?: Channel[];
  brandGuidelines?: string;
} {
  if (!inputs || typeof inputs !== 'object') return {};
  const raw = inputs as Record<string, unknown>;
  const text = (v: unknown) =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const channels = Array.isArray(raw.channels)
    ? raw.channels.filter((c): c is Channel =>
        (CONTENT_CHANNELS as readonly unknown[]).includes(c),
      )
    : undefined;
  return {
    audience: text(raw.audience),
    goals: text(raw.businessGoals),
    channels: channels?.length ? channels : undefined,
    brandGuidelines: text(raw.brandGuidelines),
  };
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  } catch {
    return null;
  }
}

const CONFIDENCE_RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * Memory insights, in the order a workflow should trust them.
 *
 * Insights the user corrected come first — they are the closest thing memory
 * has to a stated fact. Then confidence, then sample size. The honest
 * "not enough data yet" note is dropped: it is a dashboard message, not a
 * pattern to apply. Near-identical insights of the same type collapse to one.
 */
export function mapMemory(
  rows: NonNullable<BusinessContextSources['memory']>,
): ContextInsight[] {
  const mapped = rows
    .map((m) => {
      const summary = (m.supportingDataSummary ?? {}) as Record<
        string,
        unknown
      >;
      return { row: m, summary };
    })
    .filter(({ summary }) => summary.status !== 'insufficient')
    .map(({ row, summary }) => ({
      id: row.id,
      type: row.insightType as ContextInsight['type'],
      insight: row.insight.trim(),
      confidence: (row.confidence in CONFIDENCE_RANK
        ? row.confidence
        : 'LOW') as ContextInsight['confidence'],
      sampleSize: row.sampleSize,
      editedByUser: summary.editedByUser === true,
    }))
    .filter((m) => m.insight);

  mapped.sort(
    (a, b) =>
      Number(b.editedByUser) - Number(a.editedByUser) ||
      (CONFIDENCE_RANK[b.confidence] ?? 0) -
        (CONFIDENCE_RANK[a.confidence] ?? 0) ||
      b.sampleSize - a.sampleSize,
  );

  const seen = new Set<string>();
  return mapped.filter((m) => {
    const key = `${m.type}:${normaliseText(m.insight)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Competitors from both places they are kept.
 *
 * CompetitorProfile is the system of record; the trend watch list is a
 * lightweight name list, often AI-seeded when trends were first set up. A name
 * on both is one competitor. A name only on the watch list is kept (trends
 * still check for mentions of it) but marked untracked, and reported so the
 * user can either track it properly or remove a guess.
 */
function mapCompetitors(
  market: NonNullable<BusinessContextSources['market']>,
  resolver: Resolver,
): ContextCompetitor[] {
  const byName = new Map<string, ContextCompetitor>();
  for (const c of market.competitors) {
    const key = normaliseText(c.name);
    if (!key || byName.has(key)) continue;
    byName.set(key, {
      name: c.name.trim(),
      url: c.url,
      tracked: c.trackingEnabled,
      source: 'competitor_profiles',
    });
  }
  const watchOnly: string[] = [];
  for (const name of market.trendConfig?.competitorNames ?? []) {
    const key = normaliseText(name);
    if (!key || byName.has(key)) continue;
    byName.set(key, {
      name: name.trim(),
      url: null,
      tracked: false,
      source: 'trend_config',
    });
    watchOnly.push(name.trim());
  }

  const sources: ContextSource[] = [];
  if (market.competitors.length) sources.push('competitor_profiles');
  if (watchOnly.length) sources.push('trend_config');
  if (sources.length) {
    resolver.provenance['market.competitors'] = { sources, inferred: false };
  }
  if (watchOnly.length) {
    resolver.note({
      field: 'market.competitors',
      kind: 'consistency',
      severity: 'info',
      message: `On the trend watch list but not tracked as competitors: ${watchOnly.join(', ')}.`,
    });
  }
  return [...byName.values()];
}

function connectedChannels(
  connections: NonNullable<BusinessContextSources['connections']>,
): Channel[] {
  const ids = new Set(connections.connectorIds);
  return CONTENT_CHANNELS.filter(
    (channel) =>
      CHANNEL_CONNECTORS[channel].some((id) => ids.has(id)) ||
      (channel === 'LinkedIn' && connections.linkedInConnected),
  );
}

/** Material categories worth asking for. OTHER is a fallback, not a goal. */
const PROMPTED_CATEGORIES = MATERIAL_CATEGORIES.filter(
  (c) => c.id !== 'OTHER',
).map((c) => c.id);

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export function buildBusinessContext(
  src: BusinessContextSources,
  now: Date = new Date(),
): BusinessContext {
  const resolver = new Resolver();
  const { company } = src;
  const sections: ContextSection[] = [];
  if (src.targeting) sections.push('targeting');
  if (src.market) sections.push('market');
  if (src.plan !== undefined) sections.push('plan');
  if (src.connections) sections.push('connections');
  if (src.knowledge) sections.push('knowledge');
  if (src.memory) sections.push('memory');

  const prefs = {
    preferences: (company.preferences ?? {}) as Prisma.JsonValue,
  };
  const business = readBusinessProfile(prefs);
  const marketing = readMarketingProfile(prefs);
  const brand = readBrandAssets(prefs);
  const formats = readContentFormats(prefs);
  const plan = src.plan ? readPlanDuplicates(src.plan.inputs) : {};

  // --- Identity -----------------------------------------------------------
  const name = resolver.precedence('identity.name', [
    { source: 'workspace_profile', value: company.name },
  ]);
  const description = resolver.precedence('identity.description', [
    { source: 'workspace_profile', value: business?.description },
  ]);
  const offerings = resolver.precedence('identity.offerings', [
    { source: 'workspace_profile', value: business?.offerings },
  ]);
  const industry = resolver.precedence('identity.industry', [
    { source: 'workspace_profile', value: company.industry },
  ]);
  // The knowledge base's crawled site is only a fallback, and only a single
  // one — with several crawled sites there is no basis to call one "ours".
  const kbSites = src.knowledge?.websiteUrls ?? [];
  const website = resolver.precedence(
    'identity.website',
    [
      { source: 'workspace_profile', value: company.website },
      {
        source: 'knowledge_base',
        value: kbSites.length === 1 ? kbSites[0] : null,
      },
    ],
    {
      equals: (a, b) => hostOf(a) === hostOf(b),
      rule: 'The website in settings is on a different domain from the site synced into the knowledge base. Settings wins; check which one is current.',
    },
  );
  const hasVisual = Boolean(
    brand &&
    (brand.logoAssetId ||
      brand.primaryColor ||
      brand.secondaryColor ||
      brand.accentColor),
  );
  const visual = hasVisual ? brand : null;
  if (visual)
    resolver.provenance['identity.visual'] = {
      sources: ['workspace_profile'],
      inferred: false,
    };

  // --- Audience -----------------------------------------------------------
  const marketMode = resolver.precedence('audience.marketMode', [
    { source: 'workspace_profile', value: marketing?.marketMode },
  ]);
  const stated = resolver.precedence(
    'audience.stated',
    [
      { source: 'workspace_profile', value: marketing?.audience },
      { source: 'marketing_plan', value: plan.audience },
    ],
    {
      rule: 'Your latest marketing plan describes a different audience from Settings → Audience. Settings is used everywhere else; update it if the plan is right.',
    },
  );
  const goals = resolver.precedence(
    'objectives.goals',
    [
      { source: 'workspace_profile', value: marketing?.goals },
      { source: 'marketing_plan', value: plan.goals },
    ],
    {
      rule: "Your latest plan's business goal differs from the goal in Settings → Audience. Settings is used outside the planner.",
    },
  );

  // The tag lists go through the same merge getAudienceProfile uses, so the
  // two can never describe different buyers.
  const composed = composeAudienceProfile({
    marketing: marketing
      ? {
          ...marketing,
          audience: stated ?? undefined,
          goals: goals ?? undefined,
        }
      : null,
    outreach: src.targeting?.outreach ?? null,
    profiles: src.targeting?.discoveryProfiles ?? [],
  });
  const outreach = src.targeting?.outreach;
  const discoveryTags = (key: 'roleTitles' | 'industries') =>
    (src.targeting?.discoveryProfiles ?? []).flatMap((p) => {
      const criteria = (p.criteria ?? {}) as Record<string, unknown>;
      const keys =
        key === 'roleTitles' ? ['roleTitles'] : ['industries', 'keywords'];
      return keys.flatMap((k) =>
        Array.isArray(criteria[k])
          ? (criteria[k] as unknown[]).filter(
              (v): v is string => typeof v === 'string',
            )
          : [],
      );
    });
  // Recorded for provenance; the values themselves come from `composed`.
  resolver.union('audience.roleTitles', [
    { source: 'outreach_targeting', value: outreach?.roleTitles },
    { source: 'discovery_profiles', value: discoveryTags('roleTitles') },
  ]);
  resolver.union('audience.industries', [
    { source: 'outreach_targeting', value: outreach?.industries },
    { source: 'discovery_profiles', value: discoveryTags('industries') },
  ]);
  resolver.union('audience.companyStages', [
    { source: 'outreach_targeting', value: outreach?.companyStages },
  ]);

  if (marketMode === 'B2C' && (outreach?.roleTitles.length ?? 0) > 0) {
    resolver.note({
      field: 'audience.marketMode',
      kind: 'consistency',
      severity: 'info',
      message:
        'The workspace sells to consumers, but outreach targets business roles. That is fine for distributor or venue outreach; content keeps consumer writing rules either way.',
    });
  }

  // --- Objectives & channels ---------------------------------------------
  const contentFormats = formats?.enabled ?? [];
  if (contentFormats.length) {
    resolver.provenance['objectives.contentFormats'] = {
      sources: ['workspace_profile'],
      inferred: false,
    };
  }
  const preferred =
    resolver.precedence<Channel[]>(
      'channels.preferred',
      [
        { source: 'workspace_profile', value: marketing?.channels },
        { source: 'marketing_plan', value: plan.channels },
      ],
      {
        rule: 'Your latest plan publishes to different channels from the ones in Settings. Settings is the default for new plans.',
      },
    ) ?? [];
  const connected = src.connections ? connectedChannels(src.connections) : [];
  if (connected.length)
    resolver.provenance['channels.connected'] = {
      sources: ['connections'],
      inferred: false,
    };
  if (src.connections) {
    const unconnected = preferred.filter((c) => !connected.includes(c));
    if (unconnected.length) {
      resolver.note({
        field: 'channels.connected',
        kind: 'consistency',
        severity: 'info',
        message: `You publish on ${unconnected.join(', ')} but ${unconnected.length === 1 ? 'it is' : 'they are'} not connected, so Aura can plan for ${unconnected.length === 1 ? 'it' : 'them'} but not publish or measure there.`,
      });
    }
  }

  // --- Voice --------------------------------------------------------------
  const parsedVoice = company.brandVoiceProfile
    ? brandVoiceProfileSchema.safeParse(company.brandVoiceProfile)
    : null;
  const profile = parsedVoice?.success ? parsedVoice.data : null;
  const notes = company.brandVoiceNotes?.trim() || null;
  // Layered: the profile was written FROM the notes, so its summary is the
  // better statement of the same thing, not a competing one.
  const voiceSummary = resolver.precedence('voice.summary', [
    { source: 'brand_voice_profile', value: profile?.summary },
    { source: 'onboarding_notes', value: notes },
    { source: 'marketing_plan', value: plan.brandGuidelines },
  ]);
  if (notes && !profile) {
    resolver.note({
      field: 'voice.summary',
      kind: 'consistency',
      severity: 'info',
      message:
        'Brand voice notes exist but no voice profile has been generated, so workflows get the raw notes instead of a structured voice.',
    });
  }

  // --- Market -------------------------------------------------------------
  const competitors = src.market ? mapCompetitors(src.market, resolver) : [];
  const keywords = src.market
    ? resolver.union('market.keywords', [
        { source: 'trend_config', value: src.market.trendConfig?.keywords },
      ])
    : [];
  const trend = src.market?.trendConfig;
  if (trend && (trend.geoCountry || trend.geoRegion || trend.geoCity)) {
    resolver.provenance['market.geo'] = {
      sources: ['trend_config'],
      inferred: false,
    };
  }

  // --- Knowledge ----------------------------------------------------------
  const counts = new Map<MaterialCategory | null, number>();
  for (const row of src.knowledge?.chunkCounts ?? []) {
    counts.set(row.category, (counts.get(row.category) ?? 0) + row.chunks);
  }
  const totalChunks = [...counts.values()].reduce((a, b) => a + b, 0);
  const covered = PROMPTED_CATEGORIES.filter((id) => (counts.get(id) ?? 0) > 0);
  if (totalChunks > 0)
    resolver.provenance['knowledge.coverage'] = {
      sources: ['knowledge_base'],
      inferred: false,
    };

  // --- Memory -------------------------------------------------------------
  const insights = src.memory ? mapMemory(src.memory) : [];
  if (insights.length)
    resolver.provenance['memory.insights'] = {
      sources: ['marketing_memory'],
      inferred: false,
    };

  // --- Completeness -------------------------------------------------------
  const present: Record<ContextFieldPath, boolean> = {
    'identity.name': Boolean(name),
    'identity.description': Boolean(description),
    'identity.offerings': Boolean(offerings),
    'identity.industry': Boolean(industry),
    'identity.website': Boolean(website),
    'identity.visual': Boolean(visual),
    'audience.marketMode': Boolean(marketMode),
    'audience.stated': Boolean(stated),
    'audience.roleTitles': composed?.roleTitles.length ? true : false,
    'audience.industries': composed?.industries.length ? true : false,
    'audience.companyStages': composed?.companyStages.length ? true : false,
    'objectives.goals': Boolean(goals),
    'objectives.contentFormats': contentFormats.length > 0,
    'channels.preferred': preferred.length > 0,
    'channels.connected': connected.length > 0,
    'voice.summary': Boolean(voiceSummary),
    'market.competitors': competitors.length > 0,
    'market.keywords': keywords.length > 0,
    'market.geo': Boolean(
      trend?.geoCountry || trend?.geoRegion || trend?.geoCity,
    ),
    'knowledge.coverage': totalChunks > 0,
    'memory.insights': insights.length > 0,
  };
  // A field in a section that was not loaded is unknown, not missing.
  const evaluable = CONTEXT_FIELDS.filter(
    (f) => !('section' in f) || sections.includes(f.section),
  );
  const missing = (req: string) =>
    evaluable
      .filter((f) => f.requirement === req && !present[f.path])
      .map((f) => f.path as string);
  const missingRequired = missing('required');
  const missingRecommended = missing('recommended');
  const weightOf = (req: string) =>
    req === 'required' ? 2 : req === 'recommended' ? 1 : 0;
  const possible = evaluable.reduce(
    (sum, f) => sum + weightOf(f.requirement),
    0,
  );
  const earned = evaluable.reduce(
    (sum, f) => sum + (present[f.path] ? weightOf(f.requirement) : 0),
    0,
  );

  return {
    version: BUSINESS_CONTEXT_VERSION,
    identity: {
      companyId: company.id,
      name: name ?? company.name,
      website,
      industry,
      description,
      offerings,
      visual,
    },
    audience: {
      marketMode,
      stated,
      roleTitles: composed?.roleTitles ?? [],
      industries: composed?.industries ?? [],
      companyStages: composed?.companyStages ?? [],
    },
    objectives: { goals, contentFormats },
    channels: { preferred, connected },
    voice: {
      profile,
      notes,
      planGuidelines: plan.brandGuidelines ?? null,
      summary: voiceSummary,
    },
    market: {
      competitors,
      keywords,
      geo: {
        country: trend?.geoCountry ?? null,
        region: trend?.geoRegion ?? null,
        city: trend?.geoCity ?? null,
        language: trend?.language ?? 'en',
      },
    },
    knowledge: {
      totalChunks,
      covered,
      missing: src.knowledge
        ? PROMPTED_CATEGORIES.filter((id) => !covered.includes(id))
        : [],
      uncategorisedChunks: counts.get(null) ?? 0,
      websiteUrls: kbSites,
      passages: src.passages ?? [],
    },
    memory: { insights },
    meta: {
      generatedAt: now.toISOString(),
      sections,
      provenance: resolver.provenance,
      issues: resolver.issues,
      completeness: {
        complete: missingRequired.length === 0,
        missingRequired,
        missingRecommended,
        score: possible === 0 ? 0 : Math.round((earned / possible) * 100),
      },
    },
  };
}
