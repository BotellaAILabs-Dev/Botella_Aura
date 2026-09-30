import { z } from 'zod';

import { CONTENT_CHANNELS } from '@/lib/validations/planner';
import {
  brandVoiceProfileSchema,
  CONTENT_TYPES,
} from '@/lib/validations/content';
import { MARKET_MODES } from '@/lib/validations/profile';

/**
 * The Business Context — one structure for everything Aura knows about a
 * workspace's business.
 *
 * WHY THIS EXISTS
 * ---------------
 * The same facts are stored in several places, written by different screens,
 * and read by each AI workflow in its own way:
 *
 *   · brand voice lives in `brandVoiceNotes`, `brandVoiceProfile` AND a
 *     marketing plan's `brandGuidelines`;
 *   · the audience lives in audience settings, outreach targeting, discovery
 *     profiles AND a plan's `audience` field;
 *   · competitors live in `CompetitorProfile` AND the trend watch list;
 *   · goals and channels live in audience settings AND every plan's inputs.
 *
 * Each workflow picked its own subset — lead scoring, for instance, described
 * the company to the model using the brand VOICE notes. This file defines the
 * single shape all of it resolves into, which source wins for each field, and
 * which fields a workspace must supply. `server/business-context` builds it;
 * docs/BUSINESS-CONTEXT-MODEL.md explains it for humans.
 *
 * This module is pure (no database) so client components can import the
 * field registry to show what is missing and where to fix it.
 */

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Every place business information is read from today. */
export const CONTEXT_SOURCES = [
  'workspace_profile',
  'brand_voice_profile',
  'onboarding_notes',
  'outreach_targeting',
  'discovery_profiles',
  'competitor_profiles',
  'trend_config',
  'marketing_plan',
  'connections',
  'knowledge_base',
  'marketing_memory',
] as const;

export type ContextSource = (typeof CONTEXT_SOURCES)[number];

/** Where each source is stored and who writes it — for provenance in the UI. */
export const CONTEXT_SOURCE_INFO: Record<
  ContextSource,
  { label: string; storage: string; writtenBy: string }
> = {
  workspace_profile: {
    label: 'Workspace profile',
    storage:
      'Company columns + Company.preferences (business, marketingProfile, brand, contentFormats)',
    writtenBy: 'Onboarding wizard and Settings pages',
  },
  brand_voice_profile: {
    label: 'Brand voice profile',
    storage: 'Company.brandVoiceProfile',
    writtenBy: 'AI-generated from notes + knowledge, then human-edited',
  },
  onboarding_notes: {
    label: 'Brand voice notes',
    storage: 'Company.brandVoiceNotes',
    writtenBy: 'Onboarding wizard and Settings',
  },
  outreach_targeting: {
    label: 'Outreach targeting',
    storage: 'OutreachConfig',
    writtenBy: 'Settings → Outreach',
  },
  discovery_profiles: {
    label: 'Lead discovery profiles',
    storage: 'DiscoveryProfile.criteria (active only)',
    writtenBy: 'Leads → Discover',
  },
  competitor_profiles: {
    label: 'Tracked competitors',
    storage: 'CompetitorProfile',
    writtenBy: 'Competitors page',
  },
  trend_config: {
    label: 'Trend settings',
    storage: 'CompanyTrendConfig',
    writtenBy: 'Settings → Trends (initially AI-seeded)',
  },
  marketing_plan: {
    label: 'Latest marketing plan',
    storage: 'MarketingPlan.inputs (most recent month)',
    writtenBy: 'Planner form',
  },
  connections: {
    label: 'Connected channels',
    storage: 'Connection + LinkedInConnection (CONNECTED only)',
    writtenBy: 'Settings → Connections',
  },
  knowledge_base: {
    label: 'Knowledge base',
    storage: 'KnowledgeSource + KnowledgeChunk',
    writtenBy: 'Knowledge base uploads and website sync',
  },
  marketing_memory: {
    label: 'Marketing memory',
    storage: 'MarketingMemory (active, with real data)',
    writtenBy: 'Memory analysis of real performance; user edits',
  },
};

// ---------------------------------------------------------------------------
// Fact metadata: source type, confidence, freshness
// ---------------------------------------------------------------------------

/**
 * What KIND of origin a fact has.
 *
 * `ContextSource` above says which table a value was read from; this says how
 * far it can be trusted. The same table can hold both: a trend keyword the
 * user typed is user-provided, the same column filled by the AI seeder is
 * AI-derived — and only one of them is a business fact.
 */
export const SOURCE_TYPES = [
  'user_provided',
  'onboarding',
  'connected_platform',
  'uploaded_document',
  'knowledge_base',
  'marketing_memory',
  'system_generated',
  'ai_derived',
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * How reliable a fact is.
 *
 * confirmed  — the business stated it (typed it, or reviewed and confirmed it).
 * high       — read from a system of record or the business's own documents.
 * medium     — reasonable evidence, or a stated value used outside its scope
 *              (e.g. last month's plan standing in for settings).
 * low        — thin evidence (small-sample performance patterns).
 * unverified — AI-derived and never confirmed by a person. An assumption, not
 *              a fact, and never presented as one.
 */
export const CONFIDENCE_LEVELS = [
  'confirmed',
  'high',
  'medium',
  'low',
  'unverified',
] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  confirmed: 4,
  high: 3,
  medium: 2,
  low: 1,
  unverified: 0,
};

/** The lower of two confidence levels. */
export function capConfidence(
  a: ConfidenceLevel,
  cap: ConfidenceLevel,
): ConfidenceLevel {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[cap] ? a : cap;
}

export const SOURCE_TYPE_INFO: Record<
  SourceType,
  {
    label: string;
    trusted: boolean;
    confidence: ConfidenceLevel;
    description: string;
  }
> = {
  user_provided: {
    label: 'User-provided',
    trusted: true,
    confidence: 'confirmed',
    description:
      'Typed or confirmed by someone in the workspace after onboarding.',
  },
  onboarding: {
    label: 'Onboarding',
    trusted: true,
    confidence: 'confirmed',
    description: 'Answered in the onboarding wizard.',
  },
  connected_platform: {
    label: 'Connected platform',
    trusted: true,
    confidence: 'high',
    description:
      'Read from a connected account (LinkedIn, analytics, email, …).',
  },
  uploaded_document: {
    label: 'Uploaded document',
    trusted: true,
    confidence: 'high',
    description: "The business's own uploaded material.",
  },
  knowledge_base: {
    label: 'Knowledge base',
    trusted: false,
    confidence: 'medium',
    description: 'Crawled from a website or blog. Evidence, not a statement.',
  },
  marketing_memory: {
    label: 'Marketing memory',
    trusted: false,
    confidence: 'medium',
    description:
      'Patterns learned from real performance data; strength depends on sample size.',
  },
  system_generated: {
    label: 'System-generated',
    trusted: true,
    confidence: 'high',
    description: 'Computed deterministically by Aura (counts, coverage).',
  },
  ai_derived: {
    label: 'AI-derived',
    trusted: false,
    confidence: 'unverified',
    description: 'Suggested by a model and not yet confirmed by a person.',
  },
};

/**
 * fresh   — within 75% of the field's maximum age.
 * aging   — past 75%; worth a review soon.
 * stale   — past its maximum age, or its scope has ended (a past month's plan).
 * unknown — no capture date (written before dates were recorded).
 */
export const FRESHNESS_STATES = ['fresh', 'aging', 'stale', 'unknown'] as const;

export type Freshness = (typeof FRESHNESS_STATES)[number];

// ---------------------------------------------------------------------------
// Aura modules that consume the context
// ---------------------------------------------------------------------------

export const AURA_MODULES = [
  'onboarding',
  'content',
  'media',
  'planner',
  'campaigns',
  'advisor',
  'outreach',
  'engagement',
  'lead_discovery',
  'trends',
  'competitors',
  'intelligence',
  'memory',
  'briefing',
] as const;

export type AuraModule = (typeof AURA_MODULES)[number];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const nullableText = z.string().nullable();

export const INSIGHT_TYPES = [
  'CONTENT_FORMAT',
  'CONTENT_LENGTH',
  'TIMING',
  'TOPIC',
  'HASHTAG',
  'OUTREACH_APPROACH',
  'OTHER',
] as const;

export const MATERIAL_CATEGORY_IDS = [
  'COMPANY_INFO',
  'PITCH_DECK',
  'BRAND_GUIDELINES',
  'AUDIENCE_ICP',
  'PRODUCT_DOCS',
  'DIFFERENTIATORS',
  'PAST_CAMPAIGN',
  'COMPETITOR_INTEL',
  'OTHER',
] as const;

/** Who the business is. */
export const identitySchema = z.object({
  companyId: z.string(),
  name: z.string(),
  website: nullableText,
  industry: nullableText,
  /** What the business does, in its own words. */
  description: nullableText,
  /** What it sells, when named separately from the description. */
  offerings: nullableText,
  /** Logo and colours, for anything visual. */
  visual: z
    .object({
      logoAssetId: z.string().optional(),
      primaryColor: z.string().optional(),
      secondaryColor: z.string().optional(),
      accentColor: z.string().optional(),
    })
    .nullable(),
});

/** Who the business sells to. */
export const audienceSchema = z.object({
  marketMode: z.enum(MARKET_MODES).nullable(),
  /** The buyer, described in the workspace's own words. */
  stated: nullableText,
  roleTitles: z.array(z.string()),
  industries: z.array(z.string()),
  companyStages: z.array(z.string()),
});

/** What the business is trying to achieve, and in which formats. */
export const objectivesSchema = z.object({
  goals: nullableText,
  /** Formats the workspace has enabled. Empty means "all formats". */
  contentFormats: z.array(z.enum(CONTENT_TYPES)),
});

/** Where the business publishes. */
export const channelsSchema = z.object({
  /** Where it says it publishes. Drives planning. */
  preferred: z.array(z.enum(CONTENT_CHANNELS)),
  /** Where Aura can actually publish or measure. Drives execution. */
  connected: z.array(z.enum(CONTENT_CHANNELS)),
});

/** How the business sounds. */
export const voiceSchema = z.object({
  /** The structured, human-editable voice profile. */
  profile: brandVoiceProfileSchema.nullable(),
  /** Raw onboarding notes about tone. */
  notes: nullableText,
  /** Brand guidelines typed into the most recent plan. */
  planGuidelines: nullableText,
  /** One line a workflow can use when it cannot take the full profile. */
  summary: nullableText,
});

/** The market around the business. */
export const marketSchema = z.object({
  competitors: z.array(
    z.object({
      name: z.string(),
      url: nullableText,
      /** True when it is a tracked CompetitorProfile, not only a watch-list name. */
      tracked: z.boolean(),
      source: z.enum(CONTEXT_SOURCES),
      sourceType: z.enum(SOURCE_TYPES),
      confidence: z.enum(CONFIDENCE_LEVELS),
      capturedAt: z.string().nullable(),
    }),
  ),
  keywords: z.array(z.string()),
  geo: z.object({
    country: nullableText,
    region: nullableText,
    city: nullableText,
    language: z.string(),
  }),
});

/** What the knowledge base covers. Passages are fetched per query, not stored. */
export const knowledgeSchema = z.object({
  totalChunks: z.number().int(),
  covered: z.array(z.enum(MATERIAL_CATEGORY_IDS)),
  missing: z.array(z.enum(MATERIAL_CATEGORY_IDS)),
  uncategorisedChunks: z.number().int(),
  websiteUrls: z.array(z.string()),
  /** Retrieved grounding passages — present only when a query was given. */
  passages: z.array(
    z.object({
      id: z.string(),
      title: nullableText,
      content: z.string(),
      sourceType: z.string(),
      category: z.enum(MATERIAL_CATEGORY_IDS).nullable(),
      score: z.number(),
    }),
  ),
});

/** What Aura has learned from real performance. */
export const memorySchema = z.object({
  insights: z.array(
    z.object({
      id: z.string(),
      type: z.enum(INSIGHT_TYPES),
      insight: z.string(),
      confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
      sampleSize: z.number().int(),
      editedByUser: z.boolean(),
      capturedAt: z.string().nullable(),
      freshness: z.enum(FRESHNESS_STATES),
    }),
  ),
});

export const provenanceSchema = z.object({
  /** Every source that supplied a value, winner first. */
  sources: z.array(z.enum(CONTEXT_SOURCES)),
  /**
   * True when the value came from a fallback source rather than the field's
   * primary one — e.g. an audience taken from last month's plan because
   * settings were never filled in.
   */
  inferred: z.boolean(),
});

/** Where one business fact came from, how reliable it is, and how current. */
export const factSchema = z.object({
  /** The table the winning value was read from. */
  source: z.enum(CONTEXT_SOURCES),
  sourceType: z.enum(SOURCE_TYPES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  /** A business fact Aura may state as true: trusted source, not a fallback. */
  trusted: z.boolean(),
  /** Taken from a fallback source because the primary one was empty. */
  inferred: z.boolean(),
  /** When the value was captured. Null when it predates capture dates. */
  capturedAt: z.string().nullable(),
  ageDays: z.number().int().nullable(),
  freshness: z.enum(FRESHNESS_STATES),
  /** Another source holds a different value (see meta.issues). */
  conflicted: z.boolean(),
  /** Why the fact has the confidence or freshness it has, when not obvious. */
  note: z.string().optional(),
});

export type BusinessFact = z.infer<typeof factSchema>;

export const contextIssueSchema = z.object({
  field: z.string(),
  /**
   * value_conflict — two sources hold different values for the same fact.
   * consistency    — each value is valid, but together they do not add up.
   */
  kind: z.enum(['value_conflict', 'consistency', 'stale', 'unverified']),
  severity: z.enum(['info', 'warning']),
  message: z.string(),
  chosen: z
    .object({ source: z.enum(CONTEXT_SOURCES), value: z.unknown() })
    .optional(),
  overridden: z
    .array(z.object({ source: z.enum(CONTEXT_SOURCES), value: z.unknown() }))
    .optional(),
});

export const BUSINESS_CONTEXT_VERSION = 1;

export const businessContextSchema = z.object({
  version: z.literal(BUSINESS_CONTEXT_VERSION),
  identity: identitySchema,
  audience: audienceSchema,
  objectives: objectivesSchema,
  channels: channelsSchema,
  voice: voiceSchema,
  market: marketSchema,
  knowledge: knowledgeSchema,
  memory: memorySchema,
  meta: z.object({
    generatedAt: z.string(),
    /**
     * When the workspace's stored business information last changed. Pass it
     * back as `expectedRevision` on an update to refuse stale overwrites.
     */
    revision: z.string().nullable(),
    /** Optional sections actually loaded. Unloaded sections hold empty defaults. */
    sections: z.array(z.string()),
    provenance: z.record(provenanceSchema),
    /** Source, confidence and freshness for every field that has a value. */
    facts: z.record(factSchema),
    issues: z.array(contextIssueSchema),
    completeness: z.object({
      /** Every required field is present. */
      complete: z.boolean(),
      missingRequired: z.array(z.string()),
      missingRecommended: z.array(z.string()),
      /** 0–100, required fields weighted double. */
      score: z.number().int().min(0).max(100),
    }),
  }),
});

export type BusinessContext = z.infer<typeof businessContextSchema>;
export type ContextIssue = z.infer<typeof contextIssueSchema>;
export type ContextProvenance = z.infer<typeof provenanceSchema>;
export type ContextInsight = BusinessContext['memory']['insights'][number];
export type ContextCompetitor =
  BusinessContext['market']['competitors'][number];

/**
 * Optional sections a caller can skip to save queries. Identity, audience
 * (settings half), objectives, preferred channels and voice come from the
 * Company row and are always loaded.
 */
export const CONTEXT_SECTIONS = [
  'targeting',
  'market',
  'plan',
  'connections',
  'knowledge',
  'memory',
] as const;

export type ContextSection = (typeof CONTEXT_SECTIONS)[number];

// ---------------------------------------------------------------------------
// Field registry: requirement, precedence and consumers
// ---------------------------------------------------------------------------

/**
 * required    — onboarding will not finish without it. Workflows still run
 *               when it is missing (older workspaces), but the context
 *               reports itself incomplete.
 * recommended — noticeably better output; surfaced in the setup checklist.
 * optional    — used when present, never asked for.
 */
export type FieldRequirement = 'required' | 'recommended' | 'optional';

/**
 * precedence — the first source in `sources` with a value wins. Different
 *              values in lower sources are reported as a value_conflict.
 * union      — values from every source are merged and de-duplicated
 *              case-insensitively; the earlier source's spelling is kept.
 * layered    — later sources are only a fallback because the earlier one was
 *              derived from them (the voice profile is written FROM the notes),
 *              so a difference is expected and is not reported.
 */
export type ResolutionStrategy = 'precedence' | 'union' | 'layered';

export interface ContextFieldDef {
  path: string;
  label: string;
  requirement: FieldRequirement;
  /** In precedence order: the first source is the field's primary home. */
  sources: ContextSource[];
  resolution: ResolutionStrategy;
  /** The Aura modules that read this field. */
  consumers: AuraModule[];
  /** Section that must be loaded for this field to be evaluated. */
  section?: ContextSection;
  /** Where the user fixes it. */
  href?: string;
}

const ALL_WRITERS: AuraModule[] = [
  'content',
  'media',
  'planner',
  'campaigns',
  'advisor',
  'outreach',
  'engagement',
  'lead_discovery',
];

export const CONTEXT_FIELDS = [
  {
    path: 'identity.name',
    label: 'Company name',
    requirement: 'required',
    sources: ['workspace_profile'],
    resolution: 'precedence',
    consumers: [
      ...ALL_WRITERS,
      'trends',
      'competitors',
      'intelligence',
      'briefing',
    ],
    href: '/dashboard/settings',
  },
  {
    path: 'identity.description',
    label: 'What the business does',
    requirement: 'required',
    sources: ['workspace_profile'],
    resolution: 'precedence',
    consumers: ALL_WRITERS,
    href: '/dashboard/settings',
  },
  {
    path: 'identity.offerings',
    label: 'What it sells',
    requirement: 'recommended',
    sources: ['workspace_profile'],
    resolution: 'precedence',
    consumers: ALL_WRITERS,
    href: '/dashboard/settings',
  },
  {
    path: 'identity.industry',
    label: 'Industry',
    requirement: 'recommended',
    sources: ['workspace_profile'],
    resolution: 'precedence',
    consumers: [...ALL_WRITERS, 'trends'],
    href: '/dashboard/settings',
  },
  {
    path: 'identity.website',
    label: 'Website',
    requirement: 'recommended',
    sources: ['workspace_profile', 'knowledge_base'],
    resolution: 'precedence',
    consumers: ['content', 'competitors', 'onboarding'],
    href: '/dashboard/settings',
  },
  {
    path: 'identity.visual',
    label: 'Logo and brand colours',
    requirement: 'optional',
    sources: ['workspace_profile'],
    resolution: 'precedence',
    consumers: ['media'],
    href: '/dashboard/settings/brand',
  },
  {
    path: 'audience.marketMode',
    label: 'Business or consumer buyers',
    requirement: 'required',
    sources: ['workspace_profile'],
    resolution: 'precedence',
    consumers: ['content', 'media', 'planner', 'campaigns', 'advisor'],
    href: '/dashboard/settings/audience',
  },
  {
    path: 'audience.stated',
    label: 'Who the buyer is',
    requirement: 'required',
    sources: ['workspace_profile', 'marketing_plan'],
    resolution: 'precedence',
    consumers: ['content', 'media', 'planner', 'campaigns', 'advisor'],
    href: '/dashboard/settings/audience',
  },
  {
    path: 'audience.roleTitles',
    label: 'Buyer role titles',
    requirement: 'optional',
    sources: ['outreach_targeting', 'discovery_profiles'],
    resolution: 'union',
    consumers: ['content', 'outreach', 'lead_discovery', 'advisor'],
    section: 'targeting',
    href: '/dashboard/settings/outreach',
  },
  {
    path: 'audience.industries',
    label: 'Buyer industries',
    requirement: 'optional',
    sources: ['outreach_targeting', 'discovery_profiles'],
    resolution: 'union',
    consumers: ['content', 'outreach', 'lead_discovery', 'advisor'],
    section: 'targeting',
    href: '/dashboard/settings/outreach',
  },
  {
    path: 'audience.companyStages',
    label: 'Buyer company stages',
    requirement: 'optional',
    sources: ['outreach_targeting'],
    resolution: 'union',
    consumers: ['content', 'outreach', 'lead_discovery'],
    section: 'targeting',
    href: '/dashboard/settings/outreach',
  },
  {
    path: 'objectives.goals',
    label: 'Business goals',
    requirement: 'recommended',
    sources: ['workspace_profile', 'marketing_plan'],
    resolution: 'precedence',
    consumers: ['content', 'planner', 'campaigns', 'advisor', 'briefing'],
    href: '/dashboard/settings/audience',
  },
  {
    path: 'objectives.contentFormats',
    label: 'Content formats in use',
    requirement: 'optional',
    sources: ['workspace_profile'],
    resolution: 'precedence',
    consumers: ['content', 'planner', 'campaigns'],
    href: '/dashboard/settings/formats',
  },
  {
    path: 'channels.preferred',
    label: 'Publishing channels',
    requirement: 'recommended',
    sources: ['workspace_profile', 'marketing_plan'],
    resolution: 'precedence',
    consumers: ['planner', 'campaigns', 'advisor'],
    href: '/dashboard/settings/audience',
  },
  {
    path: 'channels.connected',
    label: 'Connected channels',
    requirement: 'optional',
    sources: ['connections'],
    resolution: 'union',
    consumers: ['content', 'intelligence', 'briefing'],
    section: 'connections',
    href: '/dashboard/settings/connections',
  },
  {
    path: 'voice.summary',
    label: 'Brand voice',
    requirement: 'recommended',
    sources: ['brand_voice_profile', 'onboarding_notes', 'marketing_plan'],
    resolution: 'layered',
    consumers: [...ALL_WRITERS, 'trends'],
    href: '/dashboard/settings/knowledge-base',
  },
  {
    path: 'market.competitors',
    label: 'Competitors',
    requirement: 'optional',
    sources: ['competitor_profiles', 'trend_config'],
    resolution: 'union',
    consumers: ['advisor', 'competitors', 'trends', 'planner'],
    section: 'market',
    href: '/dashboard/competitors',
  },
  {
    path: 'market.keywords',
    label: 'Market keywords',
    requirement: 'optional',
    sources: ['trend_config'],
    resolution: 'precedence',
    consumers: ['trends', 'advisor'],
    section: 'market',
    href: '/dashboard/settings/trends',
  },
  {
    path: 'market.geo',
    label: 'Market location and language',
    requirement: 'optional',
    sources: ['trend_config'],
    resolution: 'precedence',
    consumers: ['trends'],
    section: 'market',
    href: '/dashboard/settings/trends',
  },
  {
    path: 'knowledge.coverage',
    label: 'Business materials',
    requirement: 'recommended',
    sources: ['knowledge_base'],
    resolution: 'union',
    consumers: [...ALL_WRITERS],
    section: 'knowledge',
    href: '/dashboard/settings/knowledge-base',
  },
  {
    path: 'memory.insights',
    label: 'Learned performance patterns',
    requirement: 'optional',
    sources: ['marketing_memory'],
    resolution: 'union',
    consumers: ['content', 'outreach', 'campaigns', 'planner', 'advisor'],
    section: 'memory',
    href: '/dashboard/memory',
  },
] as const satisfies readonly ContextFieldDef[];

export type ContextFieldPath = (typeof CONTEXT_FIELDS)[number]['path'];

export function contextField(path: ContextFieldPath): ContextFieldDef {
  const def = CONTEXT_FIELDS.find((f) => f.path === path);
  // The path type makes this unreachable; kept so a registry edit that drops a
  // field fails loudly instead of resolving everything as "no sources".
  if (!def) throw new Error(`Unknown business context field: ${path}`);
  return def;
}

export const REQUIRED_FIELDS = CONTEXT_FIELDS.filter(
  (f) => f.requirement === 'required',
).map((f) => f.path);

export const RECOMMENDED_FIELDS = CONTEXT_FIELDS.filter(
  (f) => f.requirement === 'recommended',
).map((f) => f.path);

/**
 * Which connectors let Aura act on a stated channel.
 *
 * Newsletter has three, because any one of them is somewhere a newsletter can
 * be sent from; LinkedIn also counts the dedicated LinkedInConnection table.
 */
export const CHANNEL_CONNECTORS: Record<
  (typeof CONTENT_CHANNELS)[number],
  string[]
> = {
  LinkedIn: ['linkedin'],
  X: ['x'],
  Instagram: ['meta'],
  YouTube: ['youtube'],
  Blog: ['wordpress'],
  Newsletter: ['mailchimp', 'klaviyo', 'hubspot'],
};

// ---------------------------------------------------------------------------
// Freshness rules
// ---------------------------------------------------------------------------

/**
 * How long each fact stays current before it should be reviewed.
 *
 * Null means it does not go stale on its own (a company name). Set per field
 * from how fast that kind of fact actually changes: goals are quarterly,
 * learned performance patterns decay within a couple of months, positioning
 * lasts about a year.
 */
export const FRESHNESS_RULES: Record<
  ContextFieldPath,
  { maxAgeDays: number | null; why: string }
> = {
  'identity.name': { maxAgeDays: null, why: 'Changes only with a rebrand.' },
  'identity.description': {
    maxAgeDays: 365,
    why: 'Positioning should be reviewed yearly.',
  },
  'identity.offerings': {
    maxAgeDays: 180,
    why: 'Products and pricing change within a year.',
  },
  'identity.industry': { maxAgeDays: null, why: 'Rarely changes.' },
  'identity.website': {
    maxAgeDays: 365,
    why: 'Domains change rarely; review yearly.',
  },
  'identity.visual': {
    maxAgeDays: 730,
    why: 'Brand assets change with a rebrand.',
  },
  'audience.marketMode': {
    maxAgeDays: null,
    why: 'Changes only with a business-model change.',
  },
  'audience.stated': {
    maxAgeDays: 180,
    why: 'Target buyers drift; review twice a year.',
  },
  'audience.roleTitles': { maxAgeDays: 180, why: 'Prospecting targets drift.' },
  'audience.industries': { maxAgeDays: 180, why: 'Prospecting targets drift.' },
  'audience.companyStages': {
    maxAgeDays: 180,
    why: 'Prospecting targets drift.',
  },
  'objectives.goals': { maxAgeDays: 90, why: 'Goals are set per quarter.' },
  'objectives.contentFormats': {
    maxAgeDays: null,
    why: 'A standing preference.',
  },
  'channels.preferred': {
    maxAgeDays: 365,
    why: 'Channel mix is reviewed yearly.',
  },
  'channels.connected': {
    maxAgeDays: 30,
    why: 'A connection that has not synced in a month may be broken.',
  },
  'voice.summary': { maxAgeDays: 365, why: 'Voice should be reviewed yearly.' },
  'market.competitors': { maxAgeDays: 180, why: 'The competitive set shifts.' },
  'market.keywords': { maxAgeDays: 180, why: 'Market topics shift.' },
  'market.geo': { maxAgeDays: null, why: 'A standing preference.' },
  'knowledge.coverage': {
    maxAgeDays: 365,
    why: 'Materials older than a year may describe an old business.',
  },
  'memory.insights': {
    maxAgeDays: 60,
    why: 'Performance patterns decay as audiences and algorithms change.',
  },
};

/** Freshness of an individual memory insight. */
export const INSIGHT_MAX_AGE_DAYS = 60;

/** Freshness from an age and a maximum age. */
export function freshnessOf(
  ageDays: number | null,
  maxAgeDays: number | null,
): Freshness {
  if (ageDays === null) return maxAgeDays === null ? 'fresh' : 'unknown';
  if (maxAgeDays === null) return 'fresh';
  if (ageDays >= maxAgeDays) return 'stale';
  if (ageDays >= maxAgeDays * 0.75) return 'aging';
  return 'fresh';
}

/**
 * Per-field capture metadata, stored in `Company.preferences.factMeta` by the
 * Business Context write service. Keyed by the written path
 * (`identity.description`, `identity.visual.primaryColor`, `voice.profile`).
 */
export const storedFactMetaSchema = z.object({
  sourceType: z.enum(SOURCE_TYPES),
  capturedAt: z.string(),
  /** Set when a person reviewed the value without changing it. */
  confirmedAt: z.string().optional(),
});

export type StoredFactMeta = z.infer<typeof storedFactMetaSchema>;
