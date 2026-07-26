import { z } from 'zod';

/** Outreach schemas — shared by settings form, lead/message APIs, and tests. */

const stringList = z
  .array(z.string().trim().min(1).max(80))
  .max(40)
  .transform((arr) => Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean))));

export const outreachConfigSchema = z.object({
  industries: stringList.default([]),
  roleTitles: stringList.default([]),
  companyStages: stringList.default([]),
  enabledSources: z
    .object({
      crunchbase: z.boolean(),
      github: z.boolean(),
      jobs: z.boolean(),
      news: z.boolean(),
    })
    .default({ crunchbase: false, github: true, jobs: true, news: true }),
});

const optionalUrl = z
  .string()
  .trim()
  .max(300)
  .optional()
  .or(z.literal(''))
  .transform((v) => (v ? v : undefined))
  .refine(
    (v) => v === undefined || /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/[^\s]*)?$/i.test(v),
    { message: 'Enter a valid URL' },
  )
  .transform((v) => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v));

export const createLeadSchema = z.object({
  companyName: z.string().trim().min(1, 'Company name is required').max(160),
  name: z.string().trim().max(120).optional().or(z.literal('')),
  title: z.string().trim().max(120).optional().or(z.literal('')),
  linkedInProfileUrl: optionalUrl,
  sourceUrl: optionalUrl,
});

export const updateLeadSchema = z.object({
  name: z.string().trim().max(120).optional().or(z.literal('')),
  title: z.string().trim().max(120).optional().or(z.literal('')),
  companyName: z.string().trim().min(1).max(160).optional(),
  linkedInProfileUrl: optionalUrl,
  status: z
    .enum(['NEW', 'QUALIFIED', 'DRAFTED', 'CONTACTED', 'ARCHIVED'])
    .optional(),
});

export const updateOutreachMessageSchema = z.object({
  draftText: z.string().trim().min(1).max(3000),
});

export const outreachStatusActionSchema = z.object({
  action: z.enum(['submit', 'approve', 'reject', 'request_changes']),
  reason: z.string().trim().max(500).optional(),
});

export type OutreachConfigInput = z.infer<typeof outreachConfigSchema>;
export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
