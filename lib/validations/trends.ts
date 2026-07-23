import { z } from 'zod';

/**
 * Trend Intelligence config validation. Shared by the settings/trends form,
 * the API route, and tests. Arrays are trimmed, de-duplicated, and bounded so a
 * single company can't blow through third-party rate limits.
 */
const stringList = (max: number) =>
  z
    .array(z.string().trim().min(1).max(80))
    .max(max)
    .transform((arr) => Array.from(new Set(arr.map((s) => s.trim()))).filter(Boolean));

// Subreddit names: strip a leading "r/", allow letters/numbers/underscore.
const subredditList = z
  .array(
    z
      .string()
      .trim()
      .transform((s) => s.replace(/^\/?r\//i, '').trim())
      .refine((s) => /^[A-Za-z0-9_]{2,50}$/.test(s), {
        message: 'Use a valid subreddit name (letters, numbers, underscore)',
      }),
  )
  .max(15)
  .transform((arr) => Array.from(new Set(arr)));

export const enabledSourcesSchema = z.object({
  reddit: z.boolean(),
  hackernews: z.boolean(),
  news: z.boolean(),
  twitter: z.boolean(),
});

export const updateTrendConfigSchema = z.object({
  keywords: stringList(25),
  subreddits: subredditList,
  rssFeeds: z
    .array(z.string().trim().url('Enter a valid feed URL'))
    .max(10)
    .transform((arr) => Array.from(new Set(arr))),
  competitorNames: stringList(25),
  enabledSources: enabledSourcesSchema,
});

export type UpdateTrendConfigInput = z.infer<typeof updateTrendConfigSchema>;
export type EnabledSourcesInput = z.infer<typeof enabledSourcesSchema>;
