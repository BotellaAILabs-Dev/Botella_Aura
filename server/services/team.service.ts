import type { CompanyRole } from '@prisma/client';
import { db } from '@/lib/db';
import { generateToken, sha256 } from '@/lib/crypto';
import { sendInvitationEmail } from '@/lib/email';
import { recordAudit } from '@/server/services/audit.service';

/**
 * Team collaboration: invite members, accept invites, manage roles, remove.
 *
 * Roles (CompanyRole): OWNER (full control incl. billing), ADMIN (manage team +
 * settings + approve/publish), MEMBER (create/draft, no settings/publish).
 * Only OWNER may grant or change the OWNER role. The company can never be left
 * without an OWNER (enforced below).
 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class TeamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TeamError';
  }
}

/** Members + pending invitations for the Settings → Team UI. */
export async function getTeam(companyId: string) {
  const [members, invitations] = await Promise.all([
    db.companyMember.findMany({
      where: { companyId },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    db.companyInvitation.findMany({
      where: { companyId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return { members, invitations };
}

interface InviteArgs {
  companyId: string;
  companyName: string;
  inviterId: string;
  inviterRole: CompanyRole;
  email: string;
  role: CompanyRole;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}

/** Invite someone by email at a role. Emails a single-use accept link. */
export async function inviteMember({
  companyId,
  companyName,
  inviterId,
  inviterRole,
  email,
  role,
  requestMeta,
}: InviteArgs) {
  const normalized = email.trim().toLowerCase();
  if (role === 'OWNER' && inviterRole !== 'OWNER') {
    throw new TeamError('Only an owner can invite another owner.', 403);
  }

  // Already a member?
  const existingUser = await db.user.findUnique({
    where: { email: normalized },
    select: { id: true },
  });
  if (existingUser) {
    const membership = await db.companyMember.findUnique({
      where: { userId_companyId: { userId: existingUser.id, companyId } },
    });
    if (membership) {
      throw new TeamError('That person is already a member.', 409);
    }
  }

  const rawToken = generateToken(32);
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  // One active invite per (company, email) — re-inviting refreshes the token.
  await db.companyInvitation.upsert({
    where: { companyId_email: { companyId, email: normalized } },
    create: {
      companyId,
      email: normalized,
      role,
      tokenHash,
      invitedById: inviterId,
      expiresAt,
      status: 'PENDING',
    },
    update: {
      role,
      tokenHash,
      invitedById: inviterId,
      expiresAt,
      status: 'PENDING',
      acceptedAt: null,
    },
  });

  const base = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  await sendInvitationEmail(normalized, `${base}/invite/${rawToken}`, companyName);

  await recordAudit({
    action: 'COMPANY_MEMBER_INVITED',
    userId: inviterId,
    companyId,
    metadata: { email: normalized, role },
    ...requestMeta,
  });

  return { email: normalized, role };
}

/** Accept an invite. The accepting user's email must match the invite. */
export async function acceptInvitation(
  rawToken: string,
  userId: string,
  userEmail: string,
) {
  const tokenHash = sha256(rawToken);
  const invite = await db.companyInvitation.findUnique({ where: { tokenHash } });
  if (!invite || invite.status !== 'PENDING') {
    throw new TeamError('This invitation is invalid or already used.', 400);
  }
  if (invite.expiresAt < new Date()) {
    await db.companyInvitation.update({
      where: { id: invite.id },
      data: { status: 'EXPIRED' },
    });
    throw new TeamError('This invitation has expired.', 400);
  }
  if (invite.email.toLowerCase() !== userEmail.trim().toLowerCase()) {
    throw new TeamError(
      `This invite was sent to ${invite.email}. Log in with that email to accept.`,
      403,
    );
  }

  await db.$transaction(async (tx) => {
    await tx.companyMember.upsert({
      where: { userId_companyId: { userId, companyId: invite.companyId } },
      create: { userId, companyId: invite.companyId, role: invite.role },
      update: { role: invite.role },
    });
    await tx.companyInvitation.update({
      where: { id: invite.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
    await recordAudit(
      {
        action: 'COMPANY_MEMBER_ADDED',
        userId,
        companyId: invite.companyId,
        metadata: { via: 'invitation', role: invite.role },
      },
      tx,
    );
  });

  return { companyId: invite.companyId };
}

export async function revokeInvitation(
  companyId: string,
  invitationId: string,
  actorId: string,
) {
  const invite = await db.companyInvitation.findFirst({
    where: { id: invitationId, companyId },
  });
  if (!invite) throw new TeamError('Invitation not found.', 404);
  await db.companyInvitation.update({
    where: { id: invite.id },
    data: { status: 'REVOKED' },
  });
  await recordAudit({
    action: 'COMPANY_INVITATION_REVOKED',
    userId: actorId,
    companyId,
    metadata: { email: invite.email },
  });
}

/** Guard: the company must always keep at least one OWNER. */
async function assertNotLastOwner(companyId: string, targetUserId: string) {
  const owners = await db.companyMember.findMany({
    where: { companyId, role: 'OWNER' },
    select: { userId: true },
  });
  if (owners.length === 1 && owners[0]!.userId === targetUserId) {
    throw new TeamError(
      'This is the only owner. Assign another owner first.',
      409,
    );
  }
}

interface RoleArgs {
  companyId: string;
  actorId: string;
  actorRole: CompanyRole;
  targetUserId: string;
  role: CompanyRole;
}

export async function updateMemberRole({
  companyId,
  actorId,
  actorRole,
  targetUserId,
  role,
}: RoleArgs) {
  const target = await db.companyMember.findUnique({
    where: { userId_companyId: { userId: targetUserId, companyId } },
  });
  if (!target) throw new TeamError('Member not found.', 404);

  // Only an owner may grant OWNER or change an existing owner's role.
  if ((role === 'OWNER' || target.role === 'OWNER') && actorRole !== 'OWNER') {
    throw new TeamError('Only an owner can change owner roles.', 403);
  }
  // Demoting the last owner would leave the company owner-less.
  if (target.role === 'OWNER' && role !== 'OWNER') {
    await assertNotLastOwner(companyId, targetUserId);
  }

  await db.companyMember.update({
    where: { userId_companyId: { userId: targetUserId, companyId } },
    data: { role },
  });
  await recordAudit({
    action: 'COMPANY_MEMBER_ROLE_UPDATED',
    userId: actorId,
    companyId,
    metadata: { targetUserId, role },
  });
}

export async function removeMember({
  companyId,
  actorId,
  targetUserId,
}: {
  companyId: string;
  actorId: string;
  targetUserId: string;
}) {
  const target = await db.companyMember.findUnique({
    where: { userId_companyId: { userId: targetUserId, companyId } },
  });
  if (!target) throw new TeamError('Member not found.', 404);
  await assertNotLastOwner(companyId, targetUserId);

  await db.companyMember.delete({
    where: { userId_companyId: { userId: targetUserId, companyId } },
  });
  await recordAudit({
    action: 'COMPANY_MEMBER_REMOVED',
    userId: actorId,
    companyId,
    metadata: { targetUserId },
  });
}

export { TeamError };
