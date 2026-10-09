import { z } from 'zod';

/**
 * AI Marketing Planner — the explicit brief the monthly calendar is generated
 * from. Everything the client asked to be able to state up front (business
 * goals, campaign objectives, topics, brand guidelines) is a first-class,
 * validated field rather than a free-text afterthought.
 */
const trimmed = (max: number) => z.string().trim().max(max);

const stringList = z
  .array(z.string().trim().min(1).max(80))
  .max(30)
  .transform((arr) => Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean))));

export const CONTENT_CHANNELS = [
  'LinkedIn',
  'Blog',
  'Newsletter',
  'X',
  'Instagram',
  'YouTube',
] as const;

export const planInputsSchema = z.object({
  /** First day of the plan month, "YYYY-MM". */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Pick a month (YYYY-MM)'),
  businessGoals: trimmed(1500).min(
    10,
    'Describe the business goal this month should move (at least a sentence).',
  ),
  campaignObjectives: trimmed(1500).min(
    5,
    'What should the campaign achieve? e.g. "book 15 demos", "grow followers 10%".',
  ),
  topics: stringList.default([]),
  brandGuidelines: trimmed(2000).optional().or(z.literal('')),
  audience: trimmed(400).optional().or(z.literal('')),
  channels: z
    .array(z.enum(CONTENT_CHANNELS))
    .min(1, 'Pick at least one channel')
    .max(6),
  postsPerWeek: z.number().int().min(1).max(14),
  /** Optional campaign to file the generated drafts under. */
  campaignId: z.string().optional().or(z.literal('')),
  /** Planned for an Aura recommendation: the plan is linked back to it. */
  recommendationId: z.string().max(64).optional(),
});

export type PlanInputs = z.infer<typeof planInputsSchema>;

/** One scheduled item in the generated calendar. */
export const planItemSchema = z.object({
  /** ISO date (YYYY-MM-DD) within the plan month. */
  date: z.string(),
  week: z.number().int().min(1).max(6),
  channel: z.string().max(40),
  contentType: z.enum(['LINKEDIN_POST', 'CAROUSEL', 'TWEET_THREAD', 'BLOG']),
  theme: z.string().max(120),
  title: z.string().max(200),
  hook: z.string().max(400),
  /** The brief a writer (or Content Studio) works from. */
  brief: z.string().max(1200),
  cta: z.string().max(200),
  hashtags: z.array(z.string().max(40)).max(8),
  /** Which stated objective this item serves. */
  objective: z.string().max(200),
});

export const planWeekSchema = z.object({
  week: z.number().int().min(1).max(6),
  theme: z.string().max(160),
  goal: z.string().max(300),
});

export const planPayloadSchema = z.object({
  summary: z.string().max(1500),
  weeks: z.array(planWeekSchema).max(6),
  items: z.array(planItemSchema).max(60),
});

export type PlanItem = z.infer<typeof planItemSchema>;
export type PlanWeek = z.infer<typeof planWeekSchema>;
export type PlanPayloadBody = z.infer<typeof planPayloadSchema>;
