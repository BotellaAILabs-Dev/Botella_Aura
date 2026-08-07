import type { CompanyRole } from '@prisma/client';

/**
 * Role-based access control scaffold.
 *
 * Sprint 1 establishes the PATTERN (a single source of truth for
 * "can this company-role do X"). Later sprints add permissions here and call
 * `can()` / `assertCan()` at the boundaries that need them (billing, member
 * management, publishing). Keeping this centralized means access rules never
 * get scattered across route handlers.
 */
export type Permission =
  | 'company:update'
  | 'company:delete'
  | 'company:manageBilling'
  | 'members:invite'
  | 'members:remove'
  | 'linkedin:connect' // Sprint 2
  | 'content:create' // create/generate content, leads, etc. (denied to VIEWER)
  | 'content:approve' // Sprint 3 — the human-in-the-loop gate
  | 'content:publish'; // Sprint 3

/**
 * Role -> permissions matrix.
 *   OWNER  — full control incl. billing + delete.
 *   ADMIN  — manage team/settings/connections + create/approve/publish.
 *   MEMBER — create & draft content (no settings/approve/publish).
 *   VIEWER — READ-ONLY. No create/approve/publish/settings. (Explicit empty set.)
 */
const ROLE_PERMISSIONS: Record<CompanyRole, Permission[]> = {
  OWNER: [
    'company:update',
    'company:delete',
    'company:manageBilling',
    'members:invite',
    'members:remove',
    'linkedin:connect',
    'content:create',
    'content:approve',
    'content:publish',
  ],
  ADMIN: [
    'company:update',
    'members:invite',
    'members:remove',
    'linkedin:connect',
    'content:create',
    'content:approve',
    'content:publish',
  ],
  MEMBER: [
    // Can create/draft content, but not approve/publish or change settings.
    'content:create',
  ],
  VIEWER: [
    // Read-only: no permissions. Can view dashboards but not act.
  ],
};

export function can(role: CompanyRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** Throws an Error whose message is safe to surface as a 403. */
export function assertCan(role: CompanyRole, permission: Permission): void {
  if (!can(role, permission)) {
    throw new ForbiddenError(
      `Your role (${role}) is not permitted to: ${permission}`,
    );
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}
