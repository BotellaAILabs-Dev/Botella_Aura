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

export async function getSession() {
  return getServerSession(authOptions);
}

/** Session user or null. */
export async function getCurrentUser() {
  const session = await getSession();
  return session?.user ?? null;
}

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
  const membership = await getMembership(user.id, companyId);
  if (!membership) {
    throw new ForbiddenError('You do not have access to this company.');
  }
  return { user, membership };
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
