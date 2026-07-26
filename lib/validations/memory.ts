import { z } from 'zod';

/** Marketing Memory schemas (Sprint 5, Module 2). */

const nonNegInt = z.number().int().min(0);

/**
 * Metrics the EXTENSION reads from the user's own post DOM and syncs back.
 * At least one real metric must be present — we never store an empty snapshot
 * (NON-NEGOTIABLE #2, no fabricated numbers).
 */
export const extensionMetricsSchema = z
  .object({
    postUrl: z.string().url(),
    likes: nonNegInt.optional(),
    comments: nonNegInt.optional(),
    reposts: nonNegInt.optional(),
    impressions: nonNegInt.optional(),
  })
  .refine(
    (m) =>
      m.likes !== undefined ||
      m.comments !== undefined ||
      m.reposts !== undefined ||
      m.impressions !== undefined,
    { message: 'At least one metric is required.' },
  );

/** The manual outreach "did it work" toggle. */
export const outreachOutcomeSchema = z
  .object({
    connectionAccepted: z.boolean().optional(),
    replyReceived: z.boolean().optional(),
  })
  .refine((o) => o.connectionAccepted !== undefined || o.replyReceived !== undefined, {
    message: 'Provide at least one outcome flag.',
  });

/** The AI pattern-extraction output contract (validated). */
export const extractedInsightsSchema = z.object({
  insights: z
    .array(
      z.object({
        insightType: z.enum([
          'CONTENT_FORMAT',
          'CONTENT_LENGTH',
          'TIMING',
          'TOPIC',
          'HASHTAG',
          'OUTREACH_APPROACH',
          'OTHER',
        ]),
        insight: z.string().min(1).max(400),
        basis: z.string().min(1).max(300),
      }),
    )
    .max(8),
});

export type ExtensionMetricsInput = z.infer<typeof extensionMetricsSchema>;
export type OutreachOutcomeInput = z.infer<typeof outreachOutcomeSchema>;
