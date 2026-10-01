import { z } from 'zod';

import {
  CONFIDENCE_LEVELS,
  FRESHNESS_STATES,
  INSIGHT_TYPES,
  MATERIAL_CATEGORY_IDS,
  SOURCE_TYPES,
} from '@/lib/business-context';
import { CONTENT_CHANNELS } from '@/lib/validations/planner';
import { MARKET_MODES } from '@/lib/validations/profile';

/**
 * The Business Context Snapshot: what an AI workflow is handed.
 *
 * The full Business Context (lib/business-context.ts) is built for
 * resolution and audit — every source, every conflict, provenance for every
 * field. A model needs the opposite: a short, current statement of what is
 * TRUE about the business, kept apart from what is merely assumed.
 *
 * The snapshot is that statement:
 *
 *   · ONE OBJECT — business, products, audience, goals, voice, channels,
 *     learning and market, so no workflow queries the sources itself;
 *   · TRUSTED ONLY in its main sections — a fact appears there only if it is
 *     trusted and not stale. Everything else is either listed under
 *     `assumptions` with the reason, or (in strict mode) left out entirely;
 *   · RELEVANT — each workflow takes a view with only the sections it uses;
 *   · BOUNDED — lists are capped and excerpts trimmed, so its size is
 *     predictable inside a prompt;
 *   · CURRENT — stored, stamped with the version of every source it was built
 *     from, and rebuilt when any of them changes (see snapshot.service.ts).
 */

export const SNAPSHOT_VERSION = 1;

/** A stored snapshot older than this is rebuilt: freshness depends on the date. */
export const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

export const SNAPSHOT_SECTIONS = [
  'business',
  'products',
  'audience',
  'goals',
  'voice',
  'channels',
  'learning',
  'market',
] as const;

export type SnapshotSection = (typeof SNAPSHOT_SECTIONS)[number];

/**
 * Which sections each workflow receives.
 *
 * Outreach and engagement leave out the audience: they address one named
 * person or reply to someone else's post. Content leaves out the market: a
 * post should not be written about competitors.
 */
export const SNAPSHOT_VIEWS = {
  full: [...SNAPSHOT_SECTIONS],
  content: [
    'business',
    'products',
    'audience',
    'goals',
    'voice',
    'channels',
    'learning',
  ],
  recommendation: [...SNAPSHOT_SECTIONS],
  opportunity: [
    'business',
    'products',
    'audience',
    'goals',
    'channels',
    'learning',
    'market',
  ],
  planning: [...SNAPSHOT_SECTIONS],
  outreach: ['business', 'products', 'voice', 'learning'],
  engagement: ['business', 'voice'],
} as const satisfies Record<string, readonly SnapshotSection[]>;

export type SnapshotView = keyof typeof SNAPSHOT_VIEWS;

export const SNAPSHOT_VIEW_NAMES = Object.keys(
  SNAPSHOT_VIEWS,
) as SnapshotView[];

/** Context fields each section is built from — for trust and assumption filtering. */
export const SECTION_FIELDS: Record<SnapshotSection, string[]> = {
  business: [
    'identity.name',
    'identity.description',
    'identity.industry',
    'identity.website',
  ],
  products: ['identity.offerings', 'knowledge.coverage'],
  audience: [
    'audience.marketMode',
    'audience.stated',
    'audience.roleTitles',
    'audience.industries',
    'audience.companyStages',
  ],
  goals: ['objectives.goals'],
  voice: ['voice.summary'],
  channels: ['channels.preferred', 'channels.connected'],
  learning: ['memory.insights'],
  market: ['market.competitors', 'market.keywords'],
};

/** Caps that keep the snapshot a predictable size in a prompt. */
export const SNAPSHOT_LIMITS = {
  tags: 6,
  stages: 4,
  insights: 8,
  competitors: 8,
  keywords: 10,
  highlights: 3,
  excerptChars: 280,
  voiceList: 6,
} as const;

const trustSchema = z.object({
  sourceType: z.enum(SOURCE_TYPES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  capturedAt: z.string().nullable(),
  freshness: z.enum(FRESHNESS_STATES),
});

export const snapshotSchema = z.object({
  version: z.literal(SNAPSHOT_VERSION),
  companyId: z.string(),
  /** Hash of the full snapshot's content. Record it with any AI output. */
  fingerprint: z.string(),
  /** The context revision it was built from (Company.updatedAt). */
  revision: z.string().nullable(),
  generatedAt: z.string(),
  view: z.enum(SNAPSHOT_VIEW_NAMES as [SnapshotView, ...SnapshotView[]]),
  /** Strict: assumptions are left out instead of listed. */
  strict: z.boolean(),

  business: z
    .object({
      name: z.string(),
      description: z.string().nullable(),
      industry: z.string().nullable(),
      website: z.string().nullable(),
    })
    .nullable(),
  products: z
    .object({
      offerings: z.string().nullable(),
      /** Passages from the business's own uploaded material about what it sells. */
      highlights: z.array(
        z.object({
          title: z.string().nullable(),
          category: z.enum(MATERIAL_CATEGORY_IDS).nullable(),
          excerpt: z.string(),
        }),
      ),
    })
    .nullable(),
  audience: z
    .object({
      marketMode: z.enum(MARKET_MODES).nullable(),
      description: z.string().nullable(),
      roles: z.array(z.string()),
      industries: z.array(z.string()),
      stages: z.array(z.string()),
    })
    .nullable(),
  goals: z.object({ current: z.string() }).nullable(),
  voice: z
    .object({
      summary: z.string().nullable(),
      tone: z.array(z.string()),
      avoid: z.array(z.string()),
      vocabulary: z.array(z.string()),
      emoji: z.string().nullable(),
      hashtags: z.string().nullable(),
      /** The business's own words about its voice. */
      notes: z.string().nullable(),
    })
    .nullable(),
  channels: z
    .object({
      publishesOn: z.array(z.enum(CONTENT_CHANNELS)),
      connected: z.array(z.enum(CONTENT_CHANNELS)),
    })
    .nullable(),
  learning: z
    .object({
      insights: z.array(
        z.object({
          type: z.enum(INSIGHT_TYPES),
          insight: z.string(),
          confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
          sampleSize: z.number().int(),
          confirmedByUser: z.boolean(),
          capturedAt: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  market: z
    .object({
      competitors: z.array(z.string()),
      keywords: z.array(z.string()),
    })
    .nullable(),

  /** Source and confidence for every fact included above. */
  trust: z.record(trustSchema),
  /** Present but not trusted or not current — usable as context, never as fact. */
  assumptions: z.array(
    z.object({
      field: z.string(),
      label: z.string(),
      value: z.string(),
      reason: z.string(),
    }),
  ),
  /** Left out, and why. */
  omitted: z.array(z.object({ field: z.string(), reason: z.string() })),
  /** Required information the business has not supplied. */
  gaps: z.array(
    z.object({
      field: z.string(),
      label: z.string(),
      href: z.string().optional(),
    }),
  ),

  meta: z.object({
    sections: z.array(z.enum(SNAPSHOT_SECTIONS)),
    /** Rough size of the rendered prompt text (characters / 4). */
    estimatedTokens: z.number().int(),
  }),
});

export type BusinessContextSnapshot = z.infer<typeof snapshotSchema>;

/** Why a stored snapshot was rebuilt on read. */
export const REFRESH_REASONS = [
  'missing',
  'version',
  'sources_changed',
  'expired',
  'invalidated',
  'forced',
] as const;

export type RefreshReason = (typeof REFRESH_REASONS)[number];
