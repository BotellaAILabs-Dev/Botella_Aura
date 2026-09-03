import { cache } from 'react';
import { cookies } from 'next/headers';
import { getCompaniesForUser } from '@/server/services/company.service';
import { ACTIVE_COMPANY_COOKIE } from '@/lib/cookies';
import type { CompanySummary } from '@/types';

/**
 * Resolves the "active" company for the current request from a cookie, falling
 * back to the user's first company. The company switcher (client) writes this
 * cookie; server components read it here so the whole shell stays in sync
 * across a full multi-tenant membership list.
 */
export { ACTIVE_COMPANY_COOKIE };

/**
 * Deduplicated per request via React `cache`.
 *
 * The dashboard layout resolves the active company to render the switcher, and
 * then every page under it resolves the same thing again to scope its queries —
 * so a single navigation used to run `getCompaniesForUser` (a join returning
 * full company rows) two or three times over. Locally, against Postgres on
 * localhost, that is invisible. On Vercel, where each roundtrip is a network
 * hop to a managed database, it is the difference between one latency unit and
 * three before the page's real data has even started loading.
 *
 * `cache` memoises for the lifetime of one request only, so a mutation in a
 * later request always sees fresh data.
 */
export const resolveActiveCompany = cache(async function resolveActiveCompany(
  userId: string,
): Promise<{
  active: CompanySummary | null;
  companies: CompanySummary[];
}> {
  const companies = await getCompaniesForUser(userId);
  if (companies.length === 0) return { active: null, companies };

  const cookieId = cookies().get(ACTIVE_COMPANY_COOKIE)?.value;
  const active =
    companies.find((c) => c.id === cookieId) ?? companies[0]!;
  return { active, companies };
});
