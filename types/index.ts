import type { CompanyRole } from '@prisma/client';

/** A company as surfaced to the client, plus the caller's role within it. */
export interface CompanySummary {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  role: CompanyRole;
}

/** Shape returned by GET /api/companies (topbar switcher, guards, etc.). */
export interface CompaniesResponse {
  companies: CompanySummary[];
  activeCompanyId: string | null;
}

/** Standard JSON error envelope returned by API routes. */
export interface ApiError {
  error: string;
  /** Field-level Zod issues, when applicable. */
  details?: Record<string, string[] | undefined>;
}
