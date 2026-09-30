import { z } from 'zod';

import { CONTENT_CHANNELS } from '@/lib/validations/planner';
import { CONTENT_TYPES, type ContentTypeKey } from '@/lib/validations/content';

/**
 * The workspace's own description of itself: its brand assets and who it is
 * marketing to.
 *
 * Both live in `Company.preferences`, the extensible JSON bag the schema
 * already keeps for exactly this (autopilot settings use it the same way). No
 * migration, and nothing here is required — every consumer degrades to the
 * behaviour it had before these fields existed.
 */

/** A CSS hex colour. Stored normalised to lowercase `#rrggbb`. */
export const hexColor = z
  .string()
  .trim()
  .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex colour like #1d4ed8')
  .transform((v) => {
    const raw = v.replace('#', '').toLowerCase();
    // Expand the #abc shorthand so consumers never have to handle both forms.
    const full =
      raw.length === 3
        ? raw
            .split('')
            .map((c) => c + c)
            .join('')
        : raw;
    return `#${full}`;
  });

const optionalHex = hexColor.optional().or(z.literal('')).transform((v) => v || undefined);

export const brandAssetsSchema = z.object({
  /**
   * A logo uploaded through /api/company/logo, stored as a GeneratedAsset.
   * Kept as an id rather than a URL so the asset route can keep enforcing
   * company ownership on every read.
   */
  logoAssetId: z.string().trim().max(64).optional().or(z.literal('')).transform((v) => v || undefined),
  primaryColor: optionalHex,
  secondaryColor: optionalHex,
  accentColor: optionalHex,
});

export type BrandAssets = z.infer<typeof brandAssetsSchema>;

/**
 * Who the buyer is: a business, or a person spending their own money.
 *
 * This is the single largest fork in how marketing is written, and Aura had it
 * hard-coded to B2B — "connect every claim to revenue, cost or risk" is right
 * for a procurement decision and actively destructive for a consumer brand,
 * where the reason someone buys is how it tastes, looks, or makes them feel.
 *
 * A company can be both. SIPN is the case in point: SIPN Bourbon sells bottles
 * to drinkers, SIPN Enterprises sells to distributors and venues. Those are two
 * workspaces, each with its own mode — not one workspace trying to average two
 * opposite voices.
 */
/**
 * What the business actually does, in one or two sentences.
 *
 * This was the largest hole in the workspace profile. The generator's system
 * prompt opened with `You are the content writer for ${company.name}.` and,
 * if an industry happened to be set, `They operate in: ${industry}.` — which
 * is a name and a category, not a business. Asked to write a post on that, a
 * model has no choice but to invent the product, the customer and the claim.
 * That is the mechanism behind generic, off-target drafts: not a weak prompt,
 * but an empty one.
 *
 * Deliberately prose, not structured fields. "We rent out serviced offices to
 * startups in Hyderabad and handle the fit-out" steers a model far harder than
 * any set of tags, for the same reason `audience` below is free text.
 */
export const businessProfileSchema = z.object({
  description: z
    .string()
    .trim()
    .max(600)
    .optional()
    .or(z.literal(''))
    .transform((v) => v || undefined),
  /** What they sell, when it is worth naming separately from the description. */
  offerings: z
    .string()
    .trim()
    .max(400)
    .optional()
    .or(z.literal(''))
    .transform((v) => v || undefined),
});

export type BusinessProfile = z.infer<typeof businessProfileSchema>;

/** True once the workspace has said what it does in its own words. */
export function hasBusinessProfile(profile: BusinessProfile | null): boolean {
  return Boolean(profile?.description);
}

export const MARKET_MODES = ['B2C', 'B2B'] as const;
export type MarketMode = (typeof MARKET_MODES)[number];

/**
 * Field limits, exported so the form can show a counter against the SAME
 * number the schema enforces.
 *
 * They were previously inline magic numbers known only to the schema, so the
 * textarea had no maxLength and no counter. A user writing the detailed answer
 * the placeholder explicitly asks for would sail past 600, press Save, and get
 * back "Validation failed" with no field named and no hint that length was the
 * problem — with every word they had typed still sitting in the box.
 */
export const AUDIENCE_MAX = 600;
export const GOALS_MAX = 600;

export const marketingProfileSchema = z.object({
  /**
   * Undefined means "never chosen", which is treated as B2B downstream —
   * exactly the behaviour every existing workspace already has, so adding this
   * field changes nothing until someone actually picks.
   */
  marketMode: z.enum(MARKET_MODES).optional(),
  /**
   * Who the marketing is for, in the user's own words.
   *
   * Free text rather than structured fields because a marketer describes a
   * buyer in a sentence ("ops leads at 50-200 person logistics firms who still
   * run everything in spreadsheets"), and that sentence steers a model far
   * better than three tag lists would.
   */
  audience: z
    .string()
    .trim()
    .max(AUDIENCE_MAX, `Keep this under ${AUDIENCE_MAX} characters`)
    .optional()
    .or(z.literal(''))
    .transform((v) => v || undefined),
  /** What the business is trying to achieve over the next quarter. */
  goals: z
    .string()
    .trim()
    .max(GOALS_MAX, `Keep this under ${GOALS_MAX} characters`)
    .optional()
    .or(z.literal(''))
    .transform((v) => v || undefined),
  /** Where they publish. Drives the planner's default channel selection. */
  channels: z.array(z.enum(CONTENT_CHANNELS)).max(6).optional(),
});

export type MarketingProfile = z.infer<typeof marketingProfileSchema>;

// ---- Content formats -------------------------------------------------------

/**
 * Which content formats this workspace actually uses.
 *
 * Every workspace was offered all five, which is wrong in both directions: a
 * consumer brand does not write blog drafts or hook-first LinkedIn essays, and
 * a B2B one rarely wants an Instagram-shaped single image. Offering formats a
 * team will never pick is not neutral — it is five choices to re-reject every
 * time someone opens the composer.
 *
 * An EMPTY list means "all of them". That is deliberate: it is what every
 * existing workspace has today, so this field changes nothing until someone
 * opens the settings page and narrows it.
 */
export const contentFormatsSchema = z.object({
  enabled: z.array(z.enum(CONTENT_TYPES)).max(CONTENT_TYPES.length).default([]),
});

export type ContentFormats = z.infer<typeof contentFormatsSchema>;

/**
 * The formats worth offering a workspace that has said what market it sells to.
 *
 * A suggestion the settings page seeds a fresh choice from — never applied
 * behind anyone's back, because a workspace that has been publishing blogs
 * should not silently lose the option on the day it ticks "B2C".
 */
export function recommendedFormatsFor(
  mode: MarketMode | undefined,
): ContentTypeKey[] {
  if (mode === 'B2C') {
    // Consumer attention is visual and short. The long-form written formats
    // are the ones a consumer brand reliably never reaches for.
    return ['IMAGE_POST', 'CAROUSEL', 'TWEET_THREAD'];
  }
  if (mode === 'B2B') {
    return ['LINKEDIN_POST', 'BLOG', 'CAROUSEL', 'IMAGE_POST'];
  }
  return [...CONTENT_TYPES];
}

/**
 * The formats a workspace may actually create, resolved for use.
 *
 * Falls back to everything on an empty or unparseable list, so a bad value in
 * the preferences bag can never leave someone unable to create content at all.
 */
export function resolveEnabledFormats(
  formats: ContentFormats | null,
): ContentTypeKey[] {
  const enabled = formats?.enabled ?? [];
  return enabled.length > 0 ? enabled : [...CONTENT_TYPES];
}

/** True once the workspace has said something usable about its buyers or aims. */
export function hasMarketingProfile(profile: MarketingProfile | null): boolean {
  if (!profile) return false;
  return Boolean(profile.audience || profile.goals);
}

/** True once at least one brand asset has been supplied. */
export function hasBrandAssets(assets: BrandAssets | null): boolean {
  if (!assets) return false;
  return Boolean(
    assets.logoAssetId || assets.primaryColor || assets.secondaryColor || assets.accentColor,
  );
}
