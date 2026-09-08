import { z } from 'zod';

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
] as const;
export type ContentTypeKey = (typeof CONTENT_TYPES)[number];

// ---- Per-type body schemas -------------------------------------------------

export const linkedInPostSchema = z.object({
  hook: z.string().min(1).max(300),
  paragraphs: z.array(z.string().min(1).max(1200)).min(3).max(5),
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
  hashtags: z.array(z.string().max(40)).max(8).default([]),
});

export const threadSchema = z.object({
  // First tweet is the hook. 280-char guidance enforced by the model + here.
  tweets: z.array(z.string().min(1).max(280)).min(2).max(12),
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
export type ContentBody =
  | LinkedInPostBody
  | ImagePostBody
  | CarouselBody
  | ThreadBody
  | BlogBody;

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
  }
}

// ---- Generation / mutation input schemas -----------------------------------

/** What a piece is generated from. `ref` is a trendId or campaignId. */
export const generationSourceSchema = z.object({
  kind: z.enum(['TREND', 'BRIEF', 'CAMPAIGN']),
  ref: z.string().optional(),
  brief: z.string().trim().max(2000).optional(),
});

export const generateContentSchema = z.object({
  type: z.enum(CONTENT_TYPES),
  source: generationSourceSchema,
  campaignId: z.string().optional(),
});

export const refineContentSchema = z.object({
  feedback: z.string().trim().min(1, 'Add a note on what to change').max(1000),
});

/** Manual edits saved from the detail editor. Body is validated per type. */
export const updateDraftSchema = z.object({
  title: z.string().trim().max(200).optional(),
  body: z.unknown(), // validated against bodySchemaFor(type) in the service
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
