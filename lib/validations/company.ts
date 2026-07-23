import { z } from 'zod';

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

export const companyStep1Schema = z.object({
  name: z.string().trim().min(2, 'Company name is required').max(80),
  website: websiteSchema,
  industry: z.string().trim().max(80).optional().or(z.literal('')),
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
export const createCompanySchema = companyStep1Schema.merge(companyStep2Schema);

/** Settings page can edit any of these fields. */
export const updateCompanySchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  website: websiteSchema,
  industry: z.string().trim().max(80).optional().or(z.literal('')),
  brandVoiceNotes: z.string().trim().max(2000).optional().or(z.literal('')),
  logoUrl: z.string().trim().url().optional().or(z.literal('')),
});

export type CompanyStep1Input = z.infer<typeof companyStep1Schema>;
export type CompanyStep2Input = z.infer<typeof companyStep2Schema>;
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
