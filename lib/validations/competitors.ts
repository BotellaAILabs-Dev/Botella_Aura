import { z } from 'zod';

/**
 * Competitor management schemas (Sprint 4, Module 1). Single source of truth for
 * the /dashboard/competitors form, the API routes, and tests.
 */

// Accept a bare domain or full URL; normalize to include a protocol. Mirrors
// the website coercion used for Company in lib/validations/company.ts.
const optionalUrl = z
  .string()
  .trim()
  .max(300)
  .optional()
  .or(z.literal(''))
  .transform((v) => (v ? v : undefined))
  .refine(
    (v) =>
      v === undefined ||
      /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/[^\s]*)?$/i.test(v),
    { message: 'Enter a valid URL (e.g. example.com/pricing)' },
  )
  .transform((v) => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v));

// GitHub org/user login: letters, digits, hyphens (GitHub's own rule).
const githubOrg = z
  .string()
  .trim()
  .max(39)
  .optional()
  .or(z.literal(''))
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(v), {
    message: 'Enter a valid GitHub org/user (e.g. vercel)',
  });

export const createCompetitorSchema = z.object({
  name: z.string().trim().min(2, 'Competitor name is required').max(120),
  url: optionalUrl,
  pricingUrl: optionalUrl,
  linkedInUrl: optionalUrl,
  githubOrg,
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});

export const updateCompetitorSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  url: optionalUrl,
  pricingUrl: optionalUrl,
  linkedInUrl: optionalUrl,
  githubOrg,
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  trackingEnabled: z.boolean().optional(),
});

export type CreateCompetitorInput = z.infer<typeof createCompetitorSchema>;
export type UpdateCompetitorInput = z.infer<typeof updateCompetitorSchema>;
