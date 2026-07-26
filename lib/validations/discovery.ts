import { z } from 'zod';

/** Lead Discovery schemas (Sprint 5, Module 1). */

const stringList = z
  .array(z.string().trim().min(1).max(80))
  .max(40)
  .transform((arr) => Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean))));

/** The structured search profile — who the company wants to reach. */
export const discoveryCriteriaSchema = z.object({
  industries: stringList.default([]),
  companyStages: stringList.default([]),
  roleTitles: stringList.default([]),
  geographies: stringList.default([]),
  keywords: stringList.default([]),
});

export const createDiscoveryProfileSchema = z.object({
  name: z.string().trim().min(2, 'Give this profile a name').max(120),
  criteria: discoveryCriteriaSchema,
  autoRun: z.boolean().default(false),
});

export const updateDiscoveryProfileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  criteria: discoveryCriteriaSchema.optional(),
  isActive: z.boolean().optional(),
  autoRun: z.boolean().optional(),
});

export type DiscoveryCriteriaInput = z.infer<typeof discoveryCriteriaSchema>;
export type CreateDiscoveryProfileInput = z.infer<
  typeof createDiscoveryProfileSchema
>;
export type UpdateDiscoveryProfileInput = z.infer<
  typeof updateDiscoveryProfileSchema
>;

/** AI fit-scoring output contract (validated when Claude scores a lead). */
export const fitScoreSchema = z.object({
  fitScore: z.number().int().min(0).max(100),
  fitRationale: z.string().min(1).max(600),
});
export type FitScore = z.infer<typeof fitScoreSchema>;
