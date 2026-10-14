import crypto from 'node:crypto';
import type { CompanyRole, WhatsAppAccountLink, WhatsAppLinkChallenge } from '@prisma/client';

import { db } from '@/lib/db';
import { absoluteUrl } from '@/lib/app-url';
import { generateToken, sha256 } from '@/lib/crypto';
import {
  CODE_TTL_MS,
  LINK_TTL_MS,
  MAX_CODE_ATTEMPTS,
  MAX_LINKS_PER_HOUR,
  SESSION_TTL_MS,
  sessionState,
  waMeLink,
} from '@/lib/whatsapp-link';
import { getCompaniesForUser, getMembership } from '@/server/services/company.service';
import { recordAudit } from '@/server/services/audit.service';
import { enabledWorkspaces } from '@/server/whatsapp/settings';
import type { CompanySummary } from '@/types';

/**
 * WhatsApp ↔ Aura account linking, and the per-request session check
 * (rules and the reasoning in lib/whatsapp-link.ts).
 *
 *   issueChallenge     a single-use link for an unknown (or signed-out) number
 *   confirmChallenge   a signed-in Aura user confirms on the website → a code
 *   completeWithCode   the code arrives from the same number → linked
 *   resolveSession     on EVERY private request: is this number linked, is the
 *                      link current, and what is the user's membership and
 *                      role in the active workspace — read fresh, never cached
 *   selectWorkspace    only among the user's own memberships
 *   unlink             from WhatsApp or from the website
 *
 * Tokens and codes are stored only as SHA-256 hashes; every state change is
 * a compare-and-swap, so a link or a code can be used once.
 */

export class LinkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LinkError';
  }
}

const now = () => new Date();

// ---------------------------------------------------------------------------
// 1. The link sent to WhatsApp
// ---------------------------------------------------------------------------

/**
 * A fresh single-use link for this conversation. Earlier unfinished links are
 * cancelled, so only the newest one works.
 */
export async function issueChallenge(
  conversationId: string,
  at: Date = now(),
): Promise<{ url: string; expiresAt: Date } | { rateLimited: true }> {
  const recent = await db.whatsAppLinkChallenge.count({
    where: { conversationId, createdAt: { gt: new Date(at.getTime() - 60 * 60_000) } },
  });
  if (recent >= MAX_LINKS_PER_HOUR) return { rateLimited: true };

  const token = generateToken(32);
  const expiresAt = new Date(at.getTime() + LINK_TTL_MS);
  await db.$transaction(async (tx) => {
    await tx.whatsAppLinkChallenge.updateMany({
      where: { conversationId, status: { in: ['ISSUED', 'CONFIRMED'] } },
      data: { status: 'CANCELLED' },
    });
    await tx.whatsAppLinkChallenge.create({
      data: { conversationId, tokenHash: sha256(token), expiresAt },
    });
  });
  return { url: absoluteUrl(`/whatsapp/link/${token}`), expiresAt };
}

// ---------------------------------------------------------------------------
// 2. Confirming on the website
// ---------------------------------------------------------------------------

export type ChallengeView =
  | { state: 'invalid' }
  | { state: 'expired' }
  | { state: 'used' }
  | { state: 'pending'; last4: string; profileName: string | null; expiresAt: Date }
  | { state: 'confirmed_by_you'; last4: string; expiresAt: Date }
  | { state: 'confirmed_by_other' };

/** What the confirmation page shows for a token (read-only — a GET never consumes it). */
export async function viewChallenge(token: string, userId: string, at: Date = now()): Promise<ChallengeView> {
  const c = await db.whatsAppLinkChallenge.findUnique({
    where: { tokenHash: sha256(token) },
    include: { conversation: { select: { waIdLast4: true, profileName: true } } },
  });
  if (!c) return { state: 'invalid' };
  if (c.status === 'COMPLETED' || c.status === 'CANCELLED') return { state: 'used' };
  if (c.expiresAt <= at) return { state: 'expired' };
  if (c.status === 'CONFIRMED') {
    return c.userId === userId
      ? { state: 'confirmed_by_you', last4: c.conversation.waIdLast4, expiresAt: c.expiresAt }
      : { state: 'confirmed_by_other' };
  }
  return { state: 'pending', last4: c.conversation.waIdLast4, profileName: c.conversation.profileName, expiresAt: c.expiresAt };
}

function newCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * The signed-in user says "this WhatsApp number is mine". Returns the code
 * they must send from it (shown once, stored hashed). Single use: a second
 * confirm, by anyone, is refused.
 */
export async function confirmChallenge(args: {
  token: string;
  userId: string;
  at?: Date;
}): Promise<{ code: string; expiresAt: Date; last4: string; waMeUrl: string | null }> {
  const at = args.at ?? now();
  const tokenHash = sha256(args.token);
  const c = await db.whatsAppLinkChallenge.findUnique({
    where: { tokenHash },
    include: { conversation: { select: { waIdLast4: true } } },
  });
  if (!c) throw new LinkError('This link is not valid.', 404, 'invalid');
  const code = newCode();
  const expiresAt = new Date(at.getTime() + CODE_TTL_MS);
  const claimed = await db.whatsAppLinkChallenge.updateMany({
    where: { id: c.id, status: 'ISSUED', expiresAt: { gt: at } },
    data: {
      status: 'CONFIRMED',
      userId: args.userId,
      codeHash: sha256(code),
      codeAttempts: 0,
      confirmedAt: at,
      expiresAt,
    },
  });
  if (claimed.count !== 1) {
    throw new LinkError(
      c.expiresAt <= at ? 'This link has expired. Send “Hi” on WhatsApp for a new one.' : 'This link has already been used.',
      409,
      c.expiresAt <= at ? 'expired' : 'used',
    );
  }
  await recordAudit({
    action: 'WHATSAPP_LINK_CONFIRMED',
    userId: args.userId,
    metadata: { conversationId: c.conversationId, challengeId: c.id },
  });
  return {
    code,
    expiresAt,
    last4: c.conversation.waIdLast4,
    waMeUrl: waMeLink(process.env.WHATSAPP_DISPLAY_NUMBER, code),
  };
}

/** "This isn't me" — the link stops working. */
export async function cancelChallenge(args: { token: string; userId: string }): Promise<void> {
  await db.whatsAppLinkChallenge.updateMany({
    where: {
      tokenHash: sha256(args.token),
      OR: [{ status: 'ISSUED' }, { status: 'CONFIRMED', userId: args.userId }],
    },
    data: { status: 'CANCELLED' },
  });
}

// ---------------------------------------------------------------------------
// 3. The code, back from WhatsApp
// ---------------------------------------------------------------------------

export type CodeOutcome =
  | { ok: true; link: WhatsAppAccountLink; email: string }
  | { ok: false; reason: 'no_pending' | 'expired' | 'wrong' | 'locked' };

const sameHash = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Whether this conversation has a confirmed link waiting for its code. */
export async function pendingCodeChallenge(conversationId: string, at: Date = now()): Promise<WhatsAppLinkChallenge | null> {
  return db.whatsAppLinkChallenge.findFirst({
    where: { conversationId, status: 'CONFIRMED', expiresAt: { gt: at } },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * A code sent from WhatsApp. Only a challenge for THIS conversation counts,
 * so a code from any other number does nothing. Wrong codes are counted; the
 * fifth voids the attempt.
 */
export async function completeWithCode(args: {
  conversationId: string;
  code: string;
  at?: Date;
}): Promise<CodeOutcome> {
  const at = args.at ?? now();
  const c = await db.whatsAppLinkChallenge.findFirst({
    where: { conversationId: args.conversationId, status: 'CONFIRMED' },
    orderBy: { createdAt: 'desc' },
  });
  if (!c || !c.userId || !c.codeHash) return { ok: false, reason: 'no_pending' };
  if (c.expiresAt <= at) return { ok: false, reason: 'expired' };
  if (c.codeAttempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: 'locked' };

  if (!sameHash(sha256(args.code), c.codeHash)) {
    const attempts = c.codeAttempts + 1;
    await db.whatsAppLinkChallenge.updateMany({
      where: { id: c.id, status: 'CONFIRMED' },
      data: { codeAttempts: attempts, ...(attempts >= MAX_CODE_ATTEMPTS ? { status: 'CANCELLED' } : {}) },
    });
    return { ok: false, reason: attempts >= MAX_CODE_ATTEMPTS ? 'locked' : 'wrong' };
  }

  const userId = c.userId;
  const link = await db.$transaction(async (tx) => {
    const done = await tx.whatsAppLinkChallenge.updateMany({
      where: { id: c.id, status: 'CONFIRMED', codeAttempts: c.codeAttempts },
      data: { status: 'COMPLETED', completedAt: at },
    });
    if (done.count !== 1) return null; // a concurrent message used it first
    const previous = await tx.whatsAppAccountLink.findUnique({ where: { conversationId: args.conversationId } });
    const data = {
      userId,
      activeCompanyId: null,
      linkedAt: at,
      lastUsedAt: at,
      expiresAt: new Date(at.getTime() + SESSION_TTL_MS),
      revokedAt: null,
      revokedReason: null,
      // A new session starts with no context from the old one.
      state: {},
    };
    const l = previous
      ? await tx.whatsAppAccountLink.update({ where: { id: previous.id }, data })
      : await tx.whatsAppAccountLink.create({ data: { conversationId: args.conversationId, ...data } });
    return { link: l, replaced: previous && previous.userId !== userId && !previous.revokedAt ? previous.userId : null };
  });
  if (!link) return { ok: false, reason: 'no_pending' };

  if (link.replaced) {
    await recordAudit({
      action: 'WHATSAPP_UNLINKED',
      userId: link.replaced,
      metadata: { conversationId: args.conversationId, reason: 'replaced' },
    });
  }
  await recordAudit({
    action: 'WHATSAPP_LINKED',
    userId,
    metadata: { conversationId: args.conversationId, linkId: link.link.id, challengeId: c.id },
  });
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  return { ok: true, link: link.link, email: user.email };
}

// ---------------------------------------------------------------------------
// 4. The session — checked on every private request
// ---------------------------------------------------------------------------

export type Session =
  | { state: 'unlinked' }
  | { state: 'expired' }
  | {
      state: 'linked';
      link: WhatsAppAccountLink;
      user: { id: string; email: string; name: string | null };
      companies: CompanySummary[];
      /** The active workspace and the user's CURRENT role in it, or null. */
      active: { companyId: string; name: string; role: CompanyRole } | null;
      /**
       * The workspace they were using can no longer be used here: they were
       * removed from it, or it turned WhatsApp access off.
       */
      lostAccess: false | 'removed' | 'turned_off';
    };

/**
 * Who this WhatsApp number acts as, right now. Membership and role are read
 * from CompanyMember on every call, so a user removed from a workspace — or
 * demoted — loses that access on their very next message, not when a session
 * expires.
 */
export async function resolveSession(conversationId: string, at: Date = now()): Promise<Session> {
  const link = await db.whatsAppAccountLink.findUnique({
    where: { conversationId },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  const state = sessionState(link, at);
  if (state === 'none' || state === 'revoked') return { state: 'unlinked' };
  if (state === 'expired') return { state: 'expired' };

  const { user, ...bare } = link!;
  const memberOf = await getCompaniesForUser(user.id);
  // Only workspaces that allow WhatsApp (server/whatsapp/settings.ts).
  const allowed = await enabledWorkspaces(memberOf.map((c) => c.id));
  const companies = memberOf.filter((c) => allowed.has(c.id));
  let active: { companyId: string; name: string; role: CompanyRole } | null = null;
  let lostAccess: false | 'removed' | 'turned_off' = false;
  let activeCompanyId = bare.activeCompanyId;

  if (activeCompanyId) {
    const membership = await getMembership(user.id, activeCompanyId);
    const company = companies.find((c) => c.id === activeCompanyId);
    if (membership && company) {
      active = { companyId: company.id, name: company.name, role: membership.role };
    } else {
      lostAccess = membership && memberOf.some((c) => c.id === activeCompanyId) ? 'turned_off' : 'removed';
      activeCompanyId = null;
    }
  }
  // One workspace: no question to ask.
  if (!activeCompanyId && !lostAccess && companies.length === 1) {
    const only = companies[0]!;
    const membership = await getMembership(user.id, only.id);
    if (membership) {
      activeCompanyId = only.id;
      active = { companyId: only.id, name: only.name, role: membership.role };
    }
  }

  const updated = await db.whatsAppAccountLink.update({
    where: { id: bare.id },
    data: { lastUsedAt: at, activeCompanyId },
  });
  return { state: 'linked', link: updated, user, companies, active, lostAccess };
}

/** Choose the workspace — only one the user is currently a member of. */
export async function selectWorkspace(args: {
  conversationId: string;
  companyId: string;
}): Promise<{ companyId: string; name: string; role: CompanyRole }> {
  const link = await db.whatsAppAccountLink.findUnique({ where: { conversationId: args.conversationId } });
  if (sessionState(link) !== 'active') throw new LinkError('Not signed in.', 401, 'unlinked');
  const membership = await getMembership(link!.userId, args.companyId);
  // Same answer for "not a member", "no such workspace" and "WhatsApp is off
  // there": nothing to learn.
  if (!membership || !(await enabledWorkspaces([args.companyId])).has(args.companyId)) {
    throw new LinkError('That workspace isn’t available to you here.', 404, 'not_member');
  }
  const company = await db.company.findUniqueOrThrow({ where: { id: args.companyId }, select: { id: true, name: true } });
  await db.whatsAppAccountLink.update({ where: { id: link!.id }, data: { activeCompanyId: company.id } });
  await recordAudit({
    action: 'WHATSAPP_WORKSPACE_SELECTED',
    userId: link!.userId,
    companyId: company.id,
    metadata: { conversationId: args.conversationId },
  });
  return { companyId: company.id, name: company.name, role: membership.role };
}

// ---------------------------------------------------------------------------
// 5. Unlinking
// ---------------------------------------------------------------------------

/** From WhatsApp: "log out". */
export async function unlinkConversation(conversationId: string): Promise<boolean> {
  const link = await db.whatsAppAccountLink.findUnique({ where: { conversationId } });
  if (!link || link.revokedAt) return false;
  await db.whatsAppAccountLink.update({
    where: { id: link.id },
    data: { revokedAt: now(), revokedReason: 'unlinked_on_whatsapp', activeCompanyId: null, state: {} },
  });
  await recordAudit({ action: 'WHATSAPP_UNLINKED', userId: link.userId, metadata: { conversationId, reason: 'unlinked_on_whatsapp' } });
  return true;
}

export interface LinkView {
  id: string;
  last4: string;
  profileName: string | null;
  activeCompanyId: string | null;
  linkedAt: string;
  lastUsedAt: string;
  expiresAt: string;
  state: ReturnType<typeof sessionState>;
}

/** The signed-in user's own WhatsApp links (the website's list). */
export async function listLinksForUser(userId: string): Promise<LinkView[]> {
  const links = await db.whatsAppAccountLink.findMany({
    where: { userId, revokedAt: null },
    include: { conversation: { select: { waIdLast4: true, profileName: true } } },
    orderBy: { linkedAt: 'desc' },
  });
  return links.map((l) => ({
    id: l.id,
    last4: l.conversation.waIdLast4,
    profileName: l.conversation.profileName,
    activeCompanyId: l.activeCompanyId,
    linkedAt: l.linkedAt.toISOString(),
    lastUsedAt: l.lastUsedAt.toISOString(),
    expiresAt: l.expiresAt.toISOString(),
    state: sessionState(l),
  }));
}

/** From the website: only the link's own user can revoke it. */
export async function revokeLinkForUser(userId: string, linkId: string): Promise<void> {
  const r = await db.whatsAppAccountLink.updateMany({
    where: { id: linkId, userId, revokedAt: null },
    data: { revokedAt: now(), revokedReason: 'unlinked_on_web', activeCompanyId: null, state: {} },
  });
  // Someone else's link, or no such link: the same 404.
  if (r.count !== 1) throw new LinkError('Link not found.', 404, 'not_found');
  const link = await db.whatsAppAccountLink.findUniqueOrThrow({ where: { id: linkId }, select: { conversationId: true } });
  await recordAudit({ action: 'WHATSAPP_UNLINKED', userId, metadata: { conversationId: link.conversationId, reason: 'unlinked_on_web' } });
}
