import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * Social platform registry — the single source of truth for "what does this
 * network want", shared by the client and the server.
 *
 * This exists because image generation, media validation and publishing all
 * need the same three facts (which sizes are natural, which formats are
 * accepted, how big a file may be) and having each of them carry its own copy
 * is how they drift apart. It sits in `lib/` rather than `server/` because the
 * Graphic Studio UI needs the same list the publisher enforces — a UI that
 * offers a ratio the publisher rejects is worse than no UI at all.
 *
 * `lib/connectors.ts` stays the registry of INTEGRATIONS (what you can connect);
 * this is the registry of DESTINATIONS (what a post can be aimed at). They are
 * linked by `connectorId` below rather than duplicated.
 */
export const SOCIAL_PLATFORMS = [
  'LINKEDIN',
  'INSTAGRAM',
  'X',
  'FACEBOOK',
] as const;
export type SocialPlatformKey = (typeof SOCIAL_PLATFORMS)[number];

/** Aspect ratios the studio offers, in "W:H" form. */
export const ASPECT_RATIOS = ['1:1', '4:5', '16:9', '9:16'] as const;
export type AspectRatioKey = (typeof ASPECT_RATIOS)[number];

/**
 * Canonical size per ratio. Chosen to sit at or just above what the platforms
 * actually display, so nothing is upscaled on the way out.
 */
export const RATIO_DIMENSIONS: Record<AspectRatioKey, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '4:5': { width: 1024, height: 1280 },
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
};

export interface PlatformSpec {
  key: SocialPlatformKey;
  label: string;
  /** Matching entry in lib/connectors.ts, so the two registries stay linked. */
  connectorId: string;
  /** Brand accent, reused from the connector registry's colour. */
  color: string;
  /** Ratios this platform renders well, best-first. */
  ratios: AspectRatioKey[];
  /** The ratio used when the user expresses no preference. */
  defaultRatio: AspectRatioKey;
  /** MIME types the platform's own upload API accepts. */
  acceptedMimeTypes: string[];
  /** Hard upload ceiling in bytes, per the platform's published limits. */
  maxFileSizeBytes: number;
  /** Smallest edge the platform will accept without upscaling artefacts. */
  minDimension: number;
  /** Largest edge worth sending — anything bigger is re-encoded anyway. */
  maxDimension: number;
  /**
   * Art direction injected into the image prompt. Not decoration: a LinkedIn
   * graphic and an Instagram graphic that look the same are wrong for both.
   */
  artDirection: string;
  /** Whether a post on this platform can exist with no image at all. */
  requiresMedia: boolean;
}

export const PLATFORM_SPECS: Record<SocialPlatformKey, PlatformSpec> = {
  LINKEDIN: {
    key: 'LINKEDIN',
    label: 'LinkedIn',
    connectorId: 'linkedin',
    color: '#0A66C2',
    ratios: ['1:1', '4:5', '16:9'],
    defaultRatio: '1:1',
    // LinkedIn's image upload accepts PNG/JPEG/GIF; we generate PNG/JPEG/WEBP
    // and convert nothing, so WEBP is deliberately absent here.
    acceptedMimeTypes: ['image/png', 'image/jpeg'],
    maxFileSizeBytes: 10 * 1024 * 1024,
    minDimension: 200,
    maxDimension: 4000,
    artDirection:
      'Professional B2B visual language. Clean modern SaaS aesthetic, confident ' +
      'and understated rather than flashy. Strong visual hierarchy, generous ' +
      'whitespace, restrained brand-forward palette. Reads clearly as a thumbnail ' +
      'in a busy professional feed.',
    requiresMedia: false,
  },
  INSTAGRAM: {
    key: 'INSTAGRAM',
    label: 'Instagram',
    connectorId: 'meta',
    color: '#E1306C',
    ratios: ['1:1', '4:5', '9:16'],
    defaultRatio: '4:5',
    // The Instagram Graph API accepts JPEG for feed publishing. PNG is listed
    // so validation can explain the conversion rather than fail silently.
    acceptedMimeTypes: ['image/jpeg', 'image/png'],
    maxFileSizeBytes: 8 * 1024 * 1024,
    minDimension: 320,
    maxDimension: 1440,
    artDirection:
      'Visually arresting and scroll-stopping. Bold composition, rich colour, ' +
      'strong focal point that survives a small square crop. Editorial rather ' +
      'than corporate — it should feel designed, not templated.',
    // A feed post without an image is not a thing Instagram supports.
    requiresMedia: true,
  },
  X: {
    key: 'X',
    label: 'X (Twitter)',
    connectorId: 'x',
    color: '#111111',
    ratios: ['16:9', '1:1'],
    defaultRatio: '16:9',
    acceptedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    maxFileSizeBytes: 5 * 1024 * 1024,
    minDimension: 200,
    maxDimension: 4096,
    artDirection:
      'Punchy and immediate. One idea, high contrast, legible at the small ' +
      'inline size a timeline card gets. No fine detail that disappears when ' +
      'scaled down.',
    requiresMedia: false,
  },
  FACEBOOK: {
    key: 'FACEBOOK',
    label: 'Facebook',
    connectorId: 'meta',
    color: '#1877F2',
    ratios: ['1:1', '4:5', '16:9'],
    defaultRatio: '1:1',
    acceptedMimeTypes: ['image/png', 'image/jpeg'],
    maxFileSizeBytes: 8 * 1024 * 1024,
    minDimension: 200,
    maxDimension: 4000,
    artDirection:
      'Warm, approachable and human. Clear subject, friendly palette, avoids ' +
      'the cold corporate look. Legible on a phone at arm’s length.',
    requiresMedia: false,
  },
};

/**
 * The platform a content type targets when the draft has none set.
 *
 * Pre-existing drafts have `platform = null`, and this is what keeps them
 * behaving exactly as they did before platform targeting existed: a
 * LINKEDIN_POST still goes to LinkedIn, a TWEET_THREAD still goes to X.
 */
export function defaultPlatformFor(type: ContentTypeKey): SocialPlatformKey {
  switch (type) {
    case 'TWEET_THREAD':
      return 'X';
    // A single image is the native unit on Instagram, and the format is most
    // often reached for by consumer brands — so it opens there rather than
    // defaulting everything to the B2B network.
    case 'IMAGE_POST':
      return 'INSTAGRAM';
    case 'LINKEDIN_POST':
    case 'CAROUSEL':
    case 'BLOG':
      return 'LINKEDIN';
    // Ads are written for the placement they run in; Meta's is the common one.
    case 'AD':
      return 'FACEBOOK';
    // An email is never published to a network (it is copy-only, and
    // publishing refuses it). The platform only decides the format of a
    // header image, and LinkedIn's landscape-friendly specs suit an email
    // header best.
    case 'EMAIL':
      return 'LINKEDIN';
    // Copied out like an email: the platform only shapes an optional image.
    case 'CAMPAIGN_COPY':
      return 'LINKEDIN';
    case 'PROMO':
      return 'INSTAGRAM';
  }
}

/** Resolve a draft's effective platform (explicit choice, else the default). */
export function resolvePlatform(
  type: ContentTypeKey,
  platform: SocialPlatformKey | null | undefined,
): SocialPlatformKey {
  return platform ?? defaultPlatformFor(type);
}

export function platformSpec(platform: SocialPlatformKey): PlatformSpec {
  return PLATFORM_SPECS[platform];
}

/**
 * Platforms a given content type can sensibly be aimed at.
 *
 * A blog draft on Instagram is not a product decision anyone wants to make by
 * accident, so the choice is narrowed here rather than in the UI.
 */
export function platformsForType(type: ContentTypeKey): SocialPlatformKey[] {
  switch (type) {
    case 'LINKEDIN_POST':
      return ['LINKEDIN', 'FACEBOOK'];
    // The one format every network takes: a caption and a picture. Listing all
    // four is the point of the type — it is what you reach for when you want
    // the same post everywhere, rather than a network-shaped one.
    case 'IMAGE_POST':
      return ['INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'X'];
    case 'CAROUSEL':
      return ['LINKEDIN', 'INSTAGRAM', 'FACEBOOK'];
    case 'TWEET_THREAD':
      return ['X'];
    case 'BLOG':
      return ['LINKEDIN'];
    // The placement the ad copy is shaped for.
    case 'AD':
      return ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'X'];
    // Not aimed at a network at all.
    case 'EMAIL':
    case 'CAMPAIGN_COPY':
    case 'PROMO':
      return [];
  }
}
