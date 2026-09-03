import { z } from 'zod';

import { SOCIAL_PLATFORMS } from '@/lib/platforms';
import { CONTENT_TYPES } from '@/lib/validations/content';

/**
 * The weekly briefing payload — what "an AI marketing employee" hands you.
 *
 * Shaped around the question a person actually opens the app with: *what did
 * you do, and what needs me?* So it leads with the week's calendar and the
 * content that is ready, not with scores.
 *
 * Every section is independently optional and independently empty-able. A
 * workspace with no competitors tracked gets a briefing with no competitor
 * section — not a fabricated one. `coverage` records what was genuinely
 * unavailable and why, which is what lets the UI say "no competitors tracked
 * yet" instead of quietly showing nothing.
 */

/** One planned or produced piece of content in the week. */
export const briefingCalendarItemSchema = z.object({
  /** YYYY-MM-DD. */
  date: z.string(),
  contentType: z.enum(CONTENT_TYPES),
  platform: z.enum(SOCIAL_PLATFORMS),
  title: z.string().max(200),
  /** The angle, in one line. */
  theme: z.string().max(200).default(''),
  /** Set once the agent has actually written it. */
  draftId: z.string().nullable().default(null),
  status: z
    .enum(['PLANNED', 'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'REJECTED'])
    .default('PLANNED'),
  hasGraphic: z.boolean().default(false),
  /** Thumbnail for the attached graphic, when there is one. */
  graphicUrl: z.string().nullable().default(null),
});

/** A post the agent has already written and that is waiting on the human. */
export const briefingContentItemSchema = z.object({
  draftId: z.string(),
  title: z.string().max(200),
  snippet: z.string().max(400),
  contentType: z.enum(CONTENT_TYPES),
  platform: z.enum(SOCIAL_PLATFORMS),
  status: z.string().max(40),
  hasGraphic: z.boolean().default(false),
  graphicUrl: z.string().nullable().default(null),
  scheduledFor: z.string().nullable().default(null),
});

/** Something a tracked competitor did, worth knowing about. */
export const briefingCompetitorMoveSchema = z.object({
  competitor: z.string().max(120),
  summary: z.string().max(600),
  takeaway: z.string().max(400).default(''),
  sourceUrl: z.string().nullable().default(null),
});

/** A recommendation with somewhere to act on it. */
export const briefingRecommendationSchema = z.object({
  title: z.string().max(200),
  /** Why this, why now — the evidence, not a slogan. */
  why: z.string().max(600),
  /** The concrete next step. */
  action: z.string().max(200),
  href: z.string().max(300),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
});

/** A single number worth showing, with what it means. */
export const briefingInsightSchema = z.object({
  label: z.string().max(80),
  value: z.string().max(40),
  /** Movement vs the previous period, when there is a previous period. */
  delta: z.string().nullable().default(null),
  note: z.string().max(300).default(''),
});

/** Something waiting on the human, with a link straight to it. */
export const briefingAttentionSchema = z.object({
  label: z.string().max(120),
  count: z.number().int().min(0),
  href: z.string().max(300),
});

/**
 * What the briefing could and could not draw on.
 *
 * The honesty mechanism. Without it, a workspace that has never added a
 * competitor and one whose competitor tracking failed produce the same empty
 * section, and the user cannot tell which.
 */
export const briefingCoverageSchema = z.object({
  /** Sources that contributed, e.g. "trends", "competitors". */
  used: z.array(z.string().max(40)).default([]),
  /** Sources skipped, with the reason — shown to the user verbatim. */
  skipped: z
    .array(
      z.object({
        source: z.string().max(40),
        reason: z.string().max(200),
      }),
    )
    .default([]),
});

export const briefingPayloadSchema = z.object({
  /** One line: what this week is about. Plain, never breathless. */
  headline: z.string().max(300).default(''),
  /** 2-4 sentences summarising the week. */
  summary: z.string().max(1500).default(''),
  calendar: z.array(briefingCalendarItemSchema).max(30).default([]),
  readyContent: z.array(briefingContentItemSchema).max(30).default([]),
  competitorMoves: z.array(briefingCompetitorMoveSchema).max(15).default([]),
  recommendations: z.array(briefingRecommendationSchema).max(10).default([]),
  insights: z.array(briefingInsightSchema).max(8).default([]),
  attention: z.array(briefingAttentionSchema).max(10).default([]),
  coverage: briefingCoverageSchema.default({ used: [], skipped: [] }),
});

/**
 * What the autonomous cycle actually did — the agent's own work log.
 *
 * Separate from the payload because this is a record of ACTIONS (and spend),
 * and it must stay readable even if the briefing's presentation shape changes.
 */
export const briefingActivitySchema = z.object({
  draftsWritten: z.number().int().min(0).default(0),
  graphicsGenerated: z.number().int().min(0).default(0),
  /** Posts Aura put on the calendar at a recommended time. */
  scheduled: z.number().int().min(0).default(0),
  /** Of those, how many it also approved to go out on its own. */
  autoPublishScheduled: z.number().int().min(0).default(0),
  /** Things the agent deliberately did not do, and why. Shown to the user. */
  skipped: z.array(z.string().max(300)).default([]),
  /** Non-fatal failures during the run. */
  errors: z.array(z.string().max(300)).default([]),
  startedAt: z.string().default(''),
  finishedAt: z.string().default(''),
});

export type BriefingPayload = z.infer<typeof briefingPayloadSchema>;
export type BriefingActivity = z.infer<typeof briefingActivitySchema>;
export type BriefingCalendarItem = z.infer<typeof briefingCalendarItemSchema>;
export type BriefingContentItem = z.infer<typeof briefingContentItemSchema>;
export type BriefingRecommendation = z.infer<typeof briefingRecommendationSchema>;
export type BriefingInsight = z.infer<typeof briefingInsightSchema>;

/**
 * Parse a stored payload without ever throwing.
 *
 * A briefing written by an older build must still render — the alternative is
 * a home page that crashes because last week's snapshot predates a field.
 */
export function readBriefingPayload(raw: unknown): BriefingPayload {
  const parsed = briefingPayloadSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : briefingPayloadSchema.parse({});
}

export function readBriefingActivity(raw: unknown): BriefingActivity {
  const parsed = briefingActivitySchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : briefingActivitySchema.parse({});
}
