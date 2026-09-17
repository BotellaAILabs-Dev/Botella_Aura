import { z } from 'zod';

import { MARKET_MODES } from '@/lib/validations/profile';

/**
 * Company / onboarding schemas. Shared by the onboarding wizard, the settings
 * page, and the API routes that persist them.
 */

// Accept a bare domain or a full URL; normalize to include a protocol.
const websiteSchema = z
  .string()
  .trim()
  .max(200)
  .optional()
  .or(z.literal(''))
  .transform((v) => (v ? v : undefined))
  .refine(
    (v) =>
      v === undefined ||
      /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/[^\s]*)?$/i.test(v),
    { message: 'Enter a valid website (e.g. acme.com)' },
  )
  .transform((v) =>
    v && !/^https?:\/\//i.test(v) ? `https://${v}` : v,
  );

/**
 * Step 1 — the business itself.
 *
 * `description` is required, and that is the point of this change. The old
 * wizard asked only for a name, a website and an OPTIONAL industry, so a
 * workspace could complete onboarding having told Aura nothing about what it
 * sells. Every downstream prompt then had to work from a company name alone,
 * which is what produced drafts about a business that does not exist.
 *
 * Industry stays optional here because the dashboard checklist no longer
 * treats it as the measure of a finished profile — see
 * server/onboarding/checklist.service.ts, which now reads `description`.
 */
export const companyStep1Schema = z.object({
  name: z.string().trim().min(2, 'Company name is required').max(80),
  website: websiteSchema,
  industry: z.string().trim().max(80).optional().or(z.literal('')),
  description: z
    .string()
    .trim()
    .min(20, 'Tell Aura what you do — a sentence or two is enough')
    .max(600, 'Keep this under 600 characters'),
  offerings: z.string().trim().max(400).optional().or(z.literal('')),
});

/**
 * Step 2 — who the marketing is for.
 *
 * `marketMode` is the single largest fork in how content is written (see
 * lib/validations/profile.ts), and onboarding never asked for it. Every new
 * workspace therefore fell through to the B2B default, so a consumer brand was
 * told to justify every sentence against revenue and cost until someone
 * happened to find Settings → Audience. Asking here costs one tap.
 */
export const companyAudienceSchema = z.object({
  marketMode: z.enum(MARKET_MODES),
  audience: z
    .string()
    .trim()
    .min(10, 'Describe who you are selling to')
    .max(600, 'Keep this under 600 characters'),
  goals: z.string().trim().max(600).optional().or(z.literal('')),
});

export const companyStep2Schema = z.object({
  brandVoiceNotes: z
    .string()
    .trim()
    .max(2000, 'Keep brand voice notes under 2000 characters')
    .optional()
    .or(z.literal('')),
});

/** Full payload the onboarding wizard submits to create a Company. */
export const createCompanySchema = companyStep1Schema
  .merge(companyStep2Schema)
  .merge(companyAudienceSchema);

/** Settings page can edit any of these fields. */
export const updateCompanySchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  website: websiteSchema,
  industry: z.string().trim().max(80).optional().or(z.literal('')),
  // Editable after onboarding, so a description that turns out to be too vague
  // can be sharpened — which is the actual fix when drafts come out generic.
  description: z.string().trim().max(600).optional().or(z.literal('')),
  offerings: z.string().trim().max(400).optional().or(z.literal('')),
  brandVoiceNotes: z.string().trim().max(2000).optional().or(z.literal('')),
  logoUrl: z.string().trim().url().optional().or(z.literal('')),
});

export type CompanyStep1Input = z.infer<typeof companyStep1Schema>;
export type CompanyAudienceInput = z.infer<typeof companyAudienceSchema>;
export type CompanyStep2Input = z.infer<typeof companyStep2Schema>;
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
