import { z } from 'zod';

import { ASPECT_RATIOS, SOCIAL_PLATFORMS } from '@/lib/platforms';
import { IMAGE_STYLES } from '@/lib/graphics-ui';

/**
 * Graphic Generation input schemas.
 *
 * Mirrors lib/validations/content.ts: one place where the shape of every
 * request is defined, so routes stay thin and the client and server agree on
 * what is acceptable without either restating it.
 */

export const IMAGE_PROVIDERS = [
  'OPENAI',
  'GOOGLE',
  'STABILITY',
  'REPLICATE',
] as const;

/** Ask the AI to write an image prompt from the draft's content. */
export const generateImagePromptSchema = z.object({
  /** Optional steer, e.g. "lean industrial, not office". */
  guidance: z.string().trim().max(500).optional(),
  style: z.enum(IMAGE_STYLES).default('professional'),
  platform: z.enum(SOCIAL_PLATFORMS).optional(),
});

/** Generate images from a (possibly hand-edited) prompt. */
export const generateGraphicSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(20, 'The image prompt needs a bit more to work with.')
    .max(1500),
  negativePrompt: z.string().trim().max(400).optional(),
  /** Retained so the row records both what the AI wrote and what was sent. */
  originalPrompt: z.string().trim().max(1500).optional(),
  provider: z.enum(IMAGE_PROVIDERS).optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  /**
   * The studio's "Custom" format.
   *
   * Bounded on both ends: below 256 the result is unusable on every platform,
   * and above 4096 it is larger than anything a feed displays — an unbounded
   * box here is a way to ask a provider for something expensive by accident.
   */
  customWidth: z.number().int().min(256).max(4096).optional(),
  customHeight: z.number().int().min(256).max(4096).optional(),
  style: z.enum(IMAGE_STYLES).default('professional'),
  // Capped here as well as in the service: cost control belongs at every layer
  // that can be reached from outside.
  variations: z.number().int().min(1).max(4).default(1),
});

/** Attach an image the user supplies by URL rather than generating one. */
export const importImageUrlSchema = z.object({
  url: z.string().url('That is not a valid URL.').max(2000),
});

/**
 * What a queued IMAGE_GENERATION job carries.
 *
 * Re-validated inside the runner rather than trusted, matching how the planner
 * treats its own stored inputs: a job may have been queued by an older build
 * whose shape differed, and a retry must not execute a payload nothing has
 * checked.
 */
export const imageJobInputsSchema = z.object({
  draftId: z.string().min(1),
  prompt: z.string().min(20).max(1500),
  negativePrompt: z.string().max(400).optional(),
  originalPrompt: z.string().max(1500).optional(),
  provider: z.enum(IMAGE_PROVIDERS).optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  customWidth: z.number().int().min(256).max(4096).optional(),
  customHeight: z.number().int().min(256).max(4096).optional(),
  style: z.enum(IMAGE_STYLES).default('professional'),
  variations: z.number().int().min(1).max(4).default(1),
});

export const attachGraphicSchema = z.object({
  draftId: z.string().min(1),
  altText: z.string().trim().max(300).optional(),
  /**
   * False appends to a carousel instead of swapping the single image. Defaults
   * to replacing, because "use this image" on a normal post means instead of,
   * not as well as.
   */
  replace: z.boolean().default(true),
});

export const detachGraphicSchema = z.object({
  draftId: z.string().min(1),
});

/** Push a composed post (content + media + platform + time) into the queue. */
export const queueDraftSchema = z.object({
  platform: z.enum(SOCIAL_PLATFORMS).optional(),
  scheduledFor: z
    .string()
    .datetime()
    .refine((value) => new Date(value).getTime() > Date.now(), {
      message: 'Pick a time in the future',
    })
    .optional(),
});

export type GenerateImagePromptInput = z.infer<typeof generateImagePromptSchema>;
export type GenerateGraphicInput = z.infer<typeof generateGraphicSchema>;
export type AttachGraphicInput = z.infer<typeof attachGraphicSchema>;
export type QueueDraftInput = z.infer<typeof queueDraftSchema>;
