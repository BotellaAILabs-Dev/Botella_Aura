import { z } from 'zod';

/** Engagement Copilot schemas (Sprint 4, Module 4). */

const profileUrl = z
  .string()
  .trim()
  .min(1, 'Profile URL is required')
  .max(300)
  .refine((v) => /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/[^\s]*)?$/i.test(v), {
    message: 'Enter a valid URL',
  })
  .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`));

export const createTargetSchema = z.object({
  label: z.string().trim().min(1, 'Label is required').max(120),
  profileUrl,
});

/**
 * Payload the EXTENSION sends to draft a comment. `postText` is captured
 * client-side from the DOM the user is already viewing — the backend never
 * fetches LinkedIn content itself.
 */
export const draftCommentSchema = z.object({
  postUrl: z.string().url(),
  postText: z.string().trim().min(1).max(6000),
  author: z.string().trim().max(160).optional(),
});

export type CreateTargetInput = z.infer<typeof createTargetSchema>;
export type DraftCommentInput = z.infer<typeof draftCommentSchema>;
