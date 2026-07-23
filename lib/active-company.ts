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

export async function resolveActiveCompany(userId: string): Promise<{
  active: CompanySummary | null;
  companies: CompanySummary[];
}> {
  const companies = await getCompaniesForUser(userId);
  if (companies.length === 0) return { active: null, companies };

  const cookieId = cookies().get(ACTIVE_COMPANY_COOKIE)?.value;
  const active =
    companies.find((c) => c.id === cookieId) ?? companies[0]!;
  return { active, companies };
}
