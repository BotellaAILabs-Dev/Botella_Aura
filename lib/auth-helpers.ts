import { cache } from 'react';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import type { CompanyRole } from '@prisma/client';

import { authOptions } from '@/lib/auth';
import { getMembership } from '@/server/services/company.service';
import { ForbiddenError } from '@/lib/rbac';

/**
 * Server-side auth helpers for use in Server Components, layouts, and route
 * handlers. Complements the edge middleware (middleware.ts): middleware does
 * the cheap redirect for unauthenticated users; these helpers give typed
 * access to the session and enforce company-scoped RBAC where data is loaded.
 */

/**
 * Deduplicated per request via React `cache`.
 *
 * A single dashboard navigation resolves the session in the layout, again in
 * the page, and again in any route handler it triggers. Decoding the JWT is
 * cheap, but `getServerSession` is not free — and on the paths where the jwt
 * callback backfills a role it hits the database. Memoising for the request
 * makes every extra call after the first cost nothing.
 */
export const getSession = cache(async function getSession() {
  return getServerSession(authOptions);
});

/** Session user or null. */
export async function getCurrentUser() {
  const session = await getSession();
  return session?.user ?? null;
}

/**
 * Per-request memoised membership lookup.
 *
 * `requireCompanyMembership`, `requireActiveCompany` and `requireCompanyRole`
 * all funnel through here, and a single request commonly calls two of them.
 * Same key, same request, one query.
 */
const cachedMembership = cache(async function cachedMembership(
  userId: string,
  companyId: string,
) {
  return getMembership(userId, companyId);
});

/**
 * Require an authenticated user in a Server Component. Redirects to /login if
 * absent (belt-and-suspenders with middleware).
 */
export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * Require that the current user is a member of `companyId`. Returns their
 * membership (with role) so callers can do RBAC. Throws ForbiddenError if not
 * a member — surface as a 403 in route handlers.
 */
export async function requireCompanyMembership(companyId: string) {
  const user = await requireUser();
  const membership = await cachedMembership(user.id, companyId);
  if (!membership) {
    throw new ForbiddenError('You do not have access to this company.');
  }
  return { user, membership };
}

/**
 * Resolve the current user + their active company + membership in one call.
 * Throws ForbiddenError if there's no active company or the user isn't a member.
 * Convenience for the many company-scoped API routes (Content Studio, trends).
 */
export async function requireActiveCompany() {
  const user = await requireUser();
  // Imported lazily to avoid a server-only (next/headers) import in the edge
  // middleware bundle that also pulls this module.
  const { resolveActiveCompany } = await import('@/lib/active-company');
  const { active } = await resolveActiveCompany(user.id);
  if (!active) throw new ForbiddenError('No active company.');
  const membership = await cachedMembership(user.id, active.id);
  if (!membership) throw new ForbiddenError('You do not have access to this company.');
  return { user, company: active, membership };
}

/** Require a minimum company role (OWNER > ADMIN > MEMBER not assumed — exact set). */
export async function requireCompanyRole(
  companyId: string,
  allowed: CompanyRole[],
) {
  const { user, membership } = await requireCompanyMembership(companyId);
  if (!allowed.includes(membership.role)) {
    throw new ForbiddenError(
      `This action requires one of: ${allowed.join(', ')}.`,
    );
  }
  return { user, membership };
}
