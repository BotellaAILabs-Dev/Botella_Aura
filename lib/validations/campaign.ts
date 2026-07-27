import { z } from 'zod';
import { CONTENT_TYPES } from '@/lib/validations/content';

/**
 * Campaign Orchestrator schemas (Sprint 6, Module 1). The plan schema is the
 * strict contract the AI planner output is validated against before any
 * CampaignTask rows are created.
 */
export const campaignModulesSchema = z.object({
  content: z.boolean().default(true),
  outreach: z.boolean().default(false),
  engagement: z.boolean().default(false),
  discovery: z.boolean().default(false),
});

export const createCampaignSchema = z.object({
  name: z.string().trim().min(2, 'Campaign name is required').max(120),
  goal: z.string().trim().min(4, 'Describe the goal').max(2000),
  durationDays: z.number().int().min(3).max(60).default(30),
  modules: campaignModulesSchema,
  targetAudience: z.string().trim().max(1000).optional().or(z.literal('')),
  themes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
});

/** A single planned day. `contentType: null` = no content that day. */
export const campaignPlanDaySchema = z.object({
  day: z.number().int().min(1).max(60),
  contentType: z.enum(CONTENT_TYPES).nullable().default(null),
  topic: z.string().max(300).optional(),
  outreach: z.boolean().default(false),
  discovery: z.boolean().default(false),
  rationale: z.string().max(400).optional(),
});

/** The full planner output — validated before task generation. */
export const campaignPlanSchema = z.object({
  overview: z.string().min(1).max(1200),
  days: z.array(campaignPlanDaySchema).min(1).max(60),
});

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type CampaignPlan = z.infer<typeof campaignPlanSchema>;
export type CampaignPlanDay = z.infer<typeof campaignPlanDaySchema>;
