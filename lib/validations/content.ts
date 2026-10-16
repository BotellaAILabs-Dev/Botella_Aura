import { z } from 'zod';

import { SOCIAL_PLATFORMS } from '@/lib/platforms';

/**
 * Content Studio schemas — the single source of truth for every content type's
 * structure. Claude generation output is validated against these (retry-once on
 * failure), the API stores the validated body, and the UI renders from them.
 * A generation that doesn't produce a body matching one of these is a bug, not
 * saved content (NON-NEGOTIABLE #4).
 */

export const CONTENT_TYPES = [
  'LINKEDIN_POST',
  'IMAGE_POST',
  'CAROUSEL',
  'TWEET_THREAD',
  'BLOG',
  'EMAIL',
  'AD',
  'CAMPAIGN_COPY',
  'PROMO',
] as const;
export type ContentTypeKey = (typeof CONTENT_TYPES)[number];

/**
 * Types that are written in Aura but sent from somewhere else — an email from
 * the business's email tool, an ad from the ad platform. They are copied out,
 * never published to a social network.
 */
export const COPY_ONLY_TYPES: readonly ContentTypeKey[] = [
  'EMAIL',
  'AD',
  'CAMPAIGN_COPY',
  'PROMO',
];
export function isCopyOnlyType(type: ContentTypeKey): boolean {
  return COPY_ONLY_TYPES.includes(type);
}

/**
 * The call to action, as its own field.
 *
 * It used to live inside the last paragraph or caption, so nothing could
 * check there was one, the UI could not show it, and "rewrite the CTA" meant
 * rewriting the whole post. Optional with an empty default, so every draft
 * written before it existed still loads unchanged.
 */
const ctaField = z.string().max(300).default('');

// ---- Per-type body schemas -------------------------------------------------

export const linkedInPostSchema = z.object({
  hook: z.string().min(1).max(300),
  paragraphs: z.array(z.string().min(1).max(1200)).min(3).max(5),
  cta: ctaField,
  hashtags: z.array(z.string().max(40)).max(8).default([]),
});

/**
 * A caption plus one image.
 *
 * `caption` is the whole post, not a hook plus body: single-image posts read as
 * one block on every network, and splitting them into paragraphs the way
 * LINKEDIN_POST does would produce copy shaped for a format this is not.
 */
export const imagePostSchema = z.object({
  caption: z.string().min(1).max(2200),
  cta: ctaField,
  hashtags: z.array(z.string().max(40)).max(12).default([]),
  /** Accessibility text for the graphic. Empty until an image is attached. */
  altText: z.string().max(420).default(''),
});

export const carouselSlideSchema = z.object({
  headline: z.string().min(1).max(120),
  body: z.string().max(400).default(''),
});
export const carouselSchema = z.object({
  title: z.string().min(1).max(160),
  slides: z.array(carouselSlideSchema).min(5).max(8),
  cta: ctaField,
  hashtags: z.array(z.string().max(40)).max(8).default([]),
});

export const threadSchema = z.object({
  // First tweet is the hook. 280-char guidance enforced by the model + here.
  tweets: z.array(z.string().min(1).max(280)).min(2).max(12),
  /** Used sparingly on X: one or two, carried in the last tweet. */
  hashtags: z.array(z.string().max(40)).max(3).default([]),
});

export const blogSectionSchema = z.object({
  heading: z.string().min(1).max(160),
  body: z.string().min(1).max(4000),
});
export const blogSchema = z.object({
  headline: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional().default(''),
  sections: z.array(blogSectionSchema).min(2).max(10),
  tags: z.array(z.string().max(40)).max(10).default([]),
});

/** A marketing email, sent from the business's own email tool. */
export const emailSchema = z.object({
  subjectLine: z.string().min(1).max(120),
  /** The inbox preview line after the subject. */
  previewText: z.string().max(160).default(''),
  greeting: z.string().max(80).default(''),
  paragraphs: z.array(z.string().min(1).max(1500)).min(1).max(6),
  /** The button or link text — one clear action. */
  cta: ctaField,
  signOff: z.string().max(160).default(''),
});

/**
 * Ad copy for a social placement (Meta, LinkedIn, X ads). Field names follow
 * the ad managers', so it pastes straight in.
 */
export const adSchema = z.object({
  headline: z.string().min(1).max(80),
  primaryText: z.string().min(1).max(1000),
  description: z.string().max(120).default(''),
  /** The button label, e.g. "Shop now", "Learn more". */
  cta: z.string().max(40).default('Learn more'),
});

/**
 * Campaign copy: the messaging kit a campaign runs on — one line to remember,
 * the message it carries, a short and a long version to adapt to any channel,
 * proof points, and the action. Copied into whatever the campaign uses.
 */
export const campaignCopySchema = z.object({
  tagline: z.string().min(1).max(80),
  keyMessage: z.string().min(1).max(300),
  /** Fits a social post, an ad or a banner. */
  shortCopy: z.string().min(1).max(280),
  /** Fits an email, a landing page section or a longer post. */
  longCopy: z.string().min(1).max(1200),
  /** Only what the evidence or the business's material supports. */
  proofPoints: z.array(z.string().min(1).max(200)).max(4).default([]),
  cta: ctaField,
});

/**
 * Promotional copy: an offer, announced — for a site banner, a newsletter
 * block, a shop window or a post. Never invents a price, discount or date.
 */
export const promoSchema = z.object({
  headline: z.string().min(1).max(80),
  /** What is on offer, in the business's own terms. */
  offer: z.string().min(1).max(200),
  body: z.string().min(1).max(800),
  /** Conditions the business stated; empty when none were given. */
  terms: z.string().max(300).default(''),
  /** A real deadline or limit; empty when there is none. */
  urgency: z.string().max(120).default(''),
  cta: ctaField,
});

// ---- Brand Voice Profile ---------------------------------------------------

export const brandVoiceProfileSchema = z.object({
  toneDescriptors: z.array(z.string().max(40)).max(10).default([]),
  sentenceLength: z
    .enum(['short', 'medium', 'long', 'varied'])
    .default('varied'),
  vocabulary: z.array(z.string().max(60)).max(20).default([]),
  commonPhrases: z.array(z.string().max(120)).max(15).default([]),
  topicsToAvoid: z.array(z.string().max(80)).max(15).default([]),
  formatting: z
    .object({
      emojiUsage: z.string().max(60).default('minimal'),
      hashtagStyle: z.string().max(80).default('a few relevant hashtags'),
      notes: z.string().max(300).default(''),
    })
    .default({ emojiUsage: 'minimal', hashtagStyle: 'a few relevant hashtags', notes: '' }),
  summary: z.string().max(600).default(''),
});
export type BrandVoiceProfile = z.infer<typeof brandVoiceProfileSchema>;

export type LinkedInPostBody = z.infer<typeof linkedInPostSchema>;
export type ImagePostBody = z.infer<typeof imagePostSchema>;
export type CarouselBody = z.infer<typeof carouselSchema>;
export type ThreadBody = z.infer<typeof threadSchema>;
export type BlogBody = z.infer<typeof blogSchema>;
export type EmailBody = z.infer<typeof emailSchema>;
export type AdBody = z.infer<typeof adSchema>;
export type CampaignCopyBody = z.infer<typeof campaignCopySchema>;
export type PromoBody = z.infer<typeof promoSchema>;
export type ContentBody =
  | LinkedInPostBody
  | ImagePostBody
  | CarouselBody
  | ThreadBody
  | BlogBody
  | EmailBody
  | AdBody
  | CampaignCopyBody
  | PromoBody;

/** Map a content type to its body schema. */
export function bodySchemaFor(type: ContentTypeKey) {
  switch (type) {
    case 'LINKEDIN_POST':
      return linkedInPostSchema;
    case 'IMAGE_POST':
      return imagePostSchema;
    case 'CAROUSEL':
      return carouselSchema;
    case 'TWEET_THREAD':
      return threadSchema;
    case 'BLOG':
      return blogSchema;
    case 'EMAIL':
      return emailSchema;
    case 'AD':
      return adSchema;
    case 'CAMPAIGN_COPY':
      return campaignCopySchema;
    case 'PROMO':
      return promoSchema;
  }
}

// ---- Generation / mutation input schemas -----------------------------------

/** What a piece is generated from. `ref` is a trendId or campaignId. */
export const generationSourceSchema = z.object({
  kind: z.enum(['TREND', 'BRIEF', 'CAMPAIGN']),
  ref: z.string().optional(),
  brief: z.string().trim().max(2000).optional(),
});

/** Tones a draft can be rewritten in (the "Change tone" action). */
export const CONTENT_TONES = [
  'professional',
  'friendly',
  'playful',
  'bold',
  'warm',
  'concise',
] as const;
export type ContentTone = (typeof CONTENT_TONES)[number];

export const generateContentSchema = z.object({
  type: z.enum(CONTENT_TYPES),
  source: generationSourceSchema,
  campaignId: z.string().optional(),
  /**
   * Where it will run. The copy is written for this platform's conventions
   * and limits (lib/content-playbook.ts); without it, the type's default.
   */
  platform: z.enum(SOCIAL_PLATFORMS).optional(),
  /** Creative variations to write (different angles); the first is the draft. */
  variations: z.number().int().min(1).max(3).default(1),
  /** Optional tone for this piece, on top of the brand voice. */
  tone: z.enum(CONTENT_TONES).optional(),
  /**
   * Written for one of Aura's recommendations (`?rec=` in Content Studio).
   * Checked against the workspace on the server, remembered on the draft and
   * recorded in the recommendation's history.
   */
  recommendationId: z.string().min(1).max(64).optional(),
  /**
   * One per open form: a retry of the same request (after a timeout, a lost
   * response, a second click) returns the draft already written instead of
   * writing — and paying for — a second one.
   */
  idempotencyKey: z.string().min(8).max(64).optional(),
});

/** The one-click editing actions on a draft. */
export const REFINE_ACTIONS = [
  'regenerate',
  'shorten',
  'expand',
  'tone',
  'improve',
  'custom',
  /** Regenerate to fix what the AI Reviewer found (lib/content-review.ts). */
  'fix_review',
] as const;
export type RefineAction = (typeof REFINE_ACTIONS)[number];

/**
 * Refine a draft. `{ feedback }` alone still works (a custom instruction),
 * so existing callers are unaffected.
 */
export const refineContentSchema = z
  .object({
    action: z.enum(REFINE_ACTIONS).default('custom'),
    tone: z.enum(CONTENT_TONES).optional(),
    feedback: z.string().trim().max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'custom' && (!v.feedback || v.feedback.length < 1)) {
      ctx.addIssue({ code: 'custom', path: ['feedback'], message: 'Add a note on what to change' });
    }
    if (v.action === 'tone' && !v.tone) {
      ctx.addIssue({ code: 'custom', path: ['tone'], message: 'Pick a tone' });
    }
  });

/** Manual edits saved from the detail editor. Body is validated per type. */
export const updateDraftSchema = z.object({
  title: z.string().trim().max(200).optional(),
  body: z.unknown(), // validated against bodySchemaFor(type) in the service
  /** The version the edit was made on — a changed draft is a 409, not overwritten. */
  baseUpdatedAt: z.string().datetime().optional(),
});

export const rejectDraftSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const scheduleDraftSchema = z.object({
  scheduledFor: z
    .string()
    .datetime()
    .refine((v) => new Date(v).getTime() > Date.now(), {
      message: 'Pick a time in the future',
    }),
});

export type GenerateContentInput = z.infer<typeof generateContentSchema>;
export type RefineContentInput = z.infer<typeof refineContentSchema>;
export type GenerationSource = z.infer<typeof generationSourceSchema>;
