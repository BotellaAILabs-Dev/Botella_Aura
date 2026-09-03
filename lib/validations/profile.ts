import { z } from 'zod';

import { CONTENT_CHANNELS } from '@/lib/validations/planner';

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
const hexColor = z
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
export const MARKET_MODES = ['B2C', 'B2B'] as const;
export type MarketMode = (typeof MARKET_MODES)[number];

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
  audience: z.string().trim().max(600).optional().or(z.literal('')).transform((v) => v || undefined),
  /** What the business is trying to achieve over the next quarter. */
  goals: z.string().trim().max(600).optional().or(z.literal('')).transform((v) => v || undefined),
  /** Where they publish. Drives the planner's default channel selection. */
  channels: z.array(z.enum(CONTENT_CHANNELS)).max(6).optional(),
});

export type MarketingProfile = z.infer<typeof marketingProfileSchema>;

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
