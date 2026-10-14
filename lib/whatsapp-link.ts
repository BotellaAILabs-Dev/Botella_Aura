/**
 * Linking a WhatsApp number to an Aura account — the pure rules (no database,
 * no network), so all of them are unit-tested.
 *
 *   1. An unknown number writes in. Aura replies with a single-use link
 *      (10 minutes) to its own website — never asking for a password here.
 *   2. They sign in to Aura as usual and explicitly confirm "link •••• 3210",
 *      and are shown a 6-digit code.
 *   3. They send the code back from that WhatsApp number. Only then is the
 *      number linked.
 *
 * The code closes the gap a link alone leaves open: a link forwarded to (or
 * phished onto) someone else's signed-in browser cannot attach the sender's
 * number to that person's account, because the code is shown in that
 * browser, and only a code sent from the original number counts.
 */

/** How long the link in the message works. */
export const LINK_TTL_MS = 10 * 60_000;
/** How long the code shown after confirming works. */
export const CODE_TTL_MS = 10 * 60_000;
/** A linked number signs in again after this. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** Wrong codes allowed before the attempt is void. */
export const MAX_CODE_ATTEMPTS = 5;
/** Links one number can ask for per hour. */
export const MAX_LINKS_PER_HOUR = 5;

/** A 6-digit code as people type it: "123456", "123 456", "LINK 123-456". */
export function parseLinkCode(text: string | null): string | null {
  const m = (text ?? '').trim().match(/^(?:link\s*:?\s*)?(\d{3})[\s-]?(\d{3})$/i);
  return m ? `${m[1]}${m[2]}` : null;
}

export type Command =
  | { kind: 'logout' }
  | { kind: 'switch' }
  | { kind: 'select_workspace'; companyId: string }
  | { kind: 'menu' };

/** Menu option ids the assistant sends, and reads back. */
export const REPLY_IDS = {
  switchWorkspace: 'cmd:switch',
  logout: 'cmd:logout',
  workspacePrefix: 'ws:',
} as const;

/**
 * The account commands, from a tapped option or typed text. Anything else
 * is for the assistant itself (Phase 4).
 */
export function parseCommand(text: string | null, replyId: string | null): Command | null {
  if (replyId?.startsWith(REPLY_IDS.workspacePrefix)) {
    const companyId = replyId.slice(REPLY_IDS.workspacePrefix.length);
    return companyId ? { kind: 'select_workspace', companyId } : null;
  }
  if (replyId === REPLY_IDS.switchWorkspace) return { kind: 'switch' };
  if (replyId === REPLY_IDS.logout) return { kind: 'logout' };
  const t = (text ?? '').trim().toLowerCase().replace(/[.!?]+$/, '');
  if (['logout', 'log out', 'sign out', 'signout', 'unlink', 'disconnect'].includes(t)) return { kind: 'logout' };
  if (['switch', 'switch workspace', 'change workspace', 'workspace', 'workspaces', 'switch business', 'change business'].includes(t)) {
    return { kind: 'switch' };
  }
  if (['hi', 'hii', 'hello', 'hey', 'menu', 'help', 'home', 'namaste'].includes(t)) return { kind: 'menu' };
  return null;
}

export type SessionState = 'none' | 'revoked' | 'expired' | 'active';

/** Whether a link may act for its user right now. */
export function sessionState(
  link: { revokedAt: Date | null; expiresAt: Date } | null,
  now: Date = new Date(),
): SessionState {
  if (!link) return 'none';
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/**
 * A one-tap link that opens WhatsApp with the code typed in, for the
 * confirmation page. Null without the central number's display number.
 */
export function waMeLink(displayNumber: string | null | undefined, code: string): string | null {
  const digits = (displayNumber ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(`LINK ${code}`)}`;
}

/**
 * A browser request from our own site. Requests without an Origin header
 * (same-origin GETs, non-browser clients) pass — they still need the session
 * cookie, which NextAuth sets SameSite=Lax — but a cross-site Origin never
 * does. Defence in depth for the endpoints that change a link.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Readable role names, for messages. */
export const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};
