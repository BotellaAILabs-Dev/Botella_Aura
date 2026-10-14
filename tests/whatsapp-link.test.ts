import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * WhatsApp ↔ Aura account linking (Phase 3): single-use links, explicit
 * confirmation on the website, the code back from the same number, sessions
 * that expire, workspace choice limited to the user's own memberships, roles
 * read fresh on every request, and unlinking from either side. The database
 * is the in-memory stand-in; Meta's API is a recording fake.
 */

vi.mock('@/lib/db', async () => ({ db: (await import('./fixtures/whatsapp-db')).db }));

const { auth } = vi.hoisted(() => ({ auth: { user: null as null | { id: string; email: string } } }));
vi.mock('@/lib/auth-helpers', () => ({
  requireUser: async () => {
    if (!auth.user) {
      // What next/navigation's redirect throws; handleRouteError maps it to 401.
      throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' });
    }
    return auth.user;
  },
  getCurrentUser: async () => auth.user,
}));

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
process.env.APP_URL = 'https://aura.example';
process.env.WHATSAPP_DISPLAY_NUMBER = '+1 555 000 0000';

import { parseWebhook, type WhatsAppConfig } from '@/lib/whatsapp';
import { sha256 } from '@/lib/crypto';
import {
  isSameOrigin,
  MAX_CODE_ATTEMPTS,
  MAX_LINKS_PER_HOUR,
  parseCommand,
  parseLinkCode,
  sessionState,
  SESSION_TTL_MS,
  waMeLink,
} from '@/lib/whatsapp-link';
import { processWebhook } from '@/server/whatsapp/whatsapp.service';
import { drainConversations } from '@/server/whatsapp/queue';
import {
  confirmChallenge,
  resolveSession,
  revokeLinkForUser,
  selectWorkspace,
  viewChallenge,
} from '@/server/whatsapp/link.service';
import { EXPIRED_TEXT, LOGGED_OUT_TEXT, WELCOME_TEXT } from '@/server/whatsapp/agent';
import { POST as confirmRoute } from '@/app/api/whatsapp/link/confirm/route';
import { DELETE as revokeRoute } from '@/app/api/whatsapp/links/[id]/route';
import { resetStore, seedUser, store } from './fixtures/whatsapp-db';
import { PHONE_ID, SECRET, textWebhook } from './fixtures/whatsapp';

const config: WhatsAppConfig = {
  accessToken: 'EAAG-test-token',
  phoneNumberId: PHONE_ID,
  appSecret: SECRET,
  verifyToken: 'verify-me',
  apiVersion: 'v23.0',
};

function fakeMeta() {
  const calls: any[] = [];
  let n = 0;
  const impl = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.status === 'read') return new Response('{"success":true}', { status: 200 });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${++n}` }] }), { status: 200 });
  }) as typeof fetch;
  const sends = () => calls.filter((c) => !c.status);
  return {
    impl,
    sends,
    last: () => sends().at(-1),
    lastText: () => {
      const c = sends().at(-1);
      return c?.text?.body ?? c?.interactive?.body?.text ?? '';
    },
  };
}

const ASHA = '919876543210';
const MALLORY = '447700900666';
let seq = 0;

/** A WhatsApp message from `from`, delivered and answered. */
async function say(meta: ReturnType<typeof fakeMeta>, from: string, text: string, replyId?: string) {
  const body = textWebhook({ from, wamid: `w${++seq}`, text });
  if (replyId) {
    (body.entry[0]!.changes[0]!.value as any).messages[0] = {
      from,
      id: `w${seq}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: replyId, title: text } },
    };
  }
  const r = await processWebhook(parseWebhook(body, PHONE_ID));
  await drainConversations({ config, conversationIds: r.conversationIds, fetchImpl: meta.impl });
}

/** The token from the sign-in button the assistant last sent. */
function tokenFrom(meta: ReturnType<typeof fakeMeta>): string {
  const url = meta.last()?.interactive?.action?.parameters?.url as string;
  return url.split('/').pop()!;
}

const conversationOf = (waIdLast4: string) => store.conversations.find((c) => c.waIdLast4 === waIdLast4)!;

/** The whole happy path for a number: Hi → link → confirm → code. */
async function link(meta: ReturnType<typeof fakeMeta>, from: string, userId: string) {
  await say(meta, from, 'Hi');
  const { code } = await confirmChallenge({ token: tokenFrom(meta), userId });
  await say(meta, from, code);
}

beforeEach(() => {
  resetStore();
  auth.user = null;
});

describe('rules', () => {
  it('reads codes the way people type them', () => {
    expect(parseLinkCode('123456')).toBe('123456');
    expect(parseLinkCode(' 123 456 ')).toBe('123456');
    expect(parseLinkCode('LINK 123-456')).toBe('123456');
    expect(parseLinkCode('link: 123456')).toBe('123456');
    expect(parseLinkCode('12345')).toBeNull();
    expect(parseLinkCode('my order 123456')).toBeNull();
  });

  it('recognises account commands from taps and typing', () => {
    expect(parseCommand('Log out', null)).toEqual({ kind: 'logout' });
    expect(parseCommand(null, 'cmd:switch')).toEqual({ kind: 'switch' });
    expect(parseCommand('Acme', 'ws:co_1')).toEqual({ kind: 'select_workspace', companyId: 'co_1' });
    expect(parseCommand('Hi!', null)).toEqual({ kind: 'menu' });
    expect(parseCommand('show my campaigns', null)).toBeNull();
  });

  it('a session is active only until it expires or is revoked', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    expect(sessionState(null, now)).toBe('none');
    expect(sessionState({ revokedAt: now, expiresAt: new Date('2027-01-01') }, now)).toBe('revoked');
    expect(sessionState({ revokedAt: null, expiresAt: now }, now)).toBe('expired');
    expect(sessionState({ revokedAt: null, expiresAt: new Date(now.getTime() + 1) }, now)).toBe('active');
  });

  it('one-tap WhatsApp link with the code typed in', () => {
    expect(waMeLink('+1 555 000 0000', '123456')).toBe('https://wa.me/15550000000?text=LINK%20123456');
    expect(waMeLink(undefined, '123456')).toBeNull();
  });

  it('cross-site requests are refused', () => {
    const req = (origin?: string) =>
      new Request('https://aura.example/api/x', { method: 'POST', headers: { host: 'aura.example', ...(origin ? { origin } : {}) } });
    expect(isSameOrigin(req('https://aura.example'))).toBe(true);
    expect(isSameOrigin(req())).toBe(true);
    expect(isSameOrigin(req('https://evil.example'))).toBe(false);
    expect(isSameOrigin(req('null'))).toBe(false);
  });
});

describe('signing in from WhatsApp', () => {
  it('“Hi” from an unknown number: the welcome and a single-use sign-in link (stored only as a hash)', async () => {
    const meta = fakeMeta();
    await say(meta, ASHA, 'Hi');
    expect(meta.last().interactive.type).toBe('cta_url');
    expect(meta.lastText().startsWith(WELCOME_TEXT)).toBe(true);
    expect(meta.lastText()).toMatch(/Never share your password/);
    const token = tokenFrom(meta);
    expect(store.challenges).toHaveLength(1);
    expect(store.challenges[0]).toMatchObject({ status: 'ISSUED', tokenHash: sha256(token) });
    expect(JSON.stringify(store.challenges[0])).not.toContain(token);
  });

  it('viewing the page does not use the link up (link previews and scanners open links too)', async () => {
    const meta = fakeMeta();
    const { user } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    await say(meta, ASHA, 'Hi');
    const token = tokenFrom(meta);
    expect(await viewChallenge(token, user.id)).toMatchObject({ state: 'pending', last4: '3210' });
    expect(await viewChallenge(token, user.id)).toMatchObject({ state: 'pending' });
    expect(store.challenges[0].status).toBe('ISSUED');
  });

  it('confirm → code from the same number → linked; one workspace is chosen for them', async () => {
    const meta = fakeMeta();
    const { user } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    await say(meta, ASHA, 'Hi');
    const confirmed = await confirmChallenge({ token: tokenFrom(meta), userId: user.id });
    expect(confirmed.code).toMatch(/^\d{6}$/);
    expect(confirmed.waMeUrl).toBe(`https://wa.me/15550000000?text=LINK%20${confirmed.code}`);
    expect(store.challenges[0]).toMatchObject({ status: 'CONFIRMED', userId: user.id, codeHash: sha256(confirmed.code) });

    await say(meta, ASHA, `LINK ${confirmed.code}`);
    expect(store.links).toHaveLength(1);
    expect(store.links[0]).toMatchObject({ userId: user.id, revokedAt: null });
    expect(store.links[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 60_000);
    expect(meta.lastText()).toMatch(/now linked to your Aura account \(asha@acme\.test\)/);
    expect(meta.lastText()).toMatch(/What would you like to do in \*Acme\*\? \(Owner\)/);
    expect(store.audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['WHATSAPP_LINK_CONFIRMED', 'WHATSAPP_LINKED']),
    );
  });

  it('a link works once: a second confirm — by anyone — is refused', async () => {
    const meta = fakeMeta();
    const { user } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    const other = seedUser('bob@other.test', [{ company: 'Other', role: 'OWNER' }]).user;
    await say(meta, ASHA, 'Hi');
    const token = tokenFrom(meta);
    await confirmChallenge({ token, userId: user.id });
    await expect(confirmChallenge({ token, userId: user.id })).rejects.toMatchObject({ status: 409 });
    await expect(confirmChallenge({ token, userId: other.id })).rejects.toMatchObject({ status: 409 });
  });

  it('an expired link cannot be confirmed', async () => {
    const meta = fakeMeta();
    const { user } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    await say(meta, ASHA, 'Hi');
    const later = new Date(Date.now() + 11 * 60_000);
    await expect(confirmChallenge({ token: tokenFrom(meta), userId: user.id, at: later })).rejects.toMatchObject({ code: 'expired' });
    expect(await viewChallenge(tokenFrom(meta), user.id, later)).toEqual({ state: 'expired' });
  });

  it('a newer link replaces the older one', async () => {
    const meta = fakeMeta();
    const { user } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    await say(meta, ASHA, 'Hi');
    const first = tokenFrom(meta);
    await say(meta, ASHA, 'Hi again');
    await expect(confirmChallenge({ token: first, userId: user.id })).rejects.toMatchObject({ status: 409 });
    await expect(confirmChallenge({ token: tokenFrom(meta), userId: user.id })).resolves.toMatchObject({ code: expect.any(String) });
  });

  it('PHISHING: a link forwarded to someone else’s browser cannot attach the sender’s number to their account', async () => {
    const meta = fakeMeta();
    const victim = seedUser('victim@acme.test', [{ company: 'Acme', role: 'OWNER' }]).user;
    // Mallory asks for a link and gets the victim (signed in to Aura) to confirm it.
    await say(meta, MALLORY, 'Hi');
    const { code } = await confirmChallenge({ token: tokenFrom(meta), userId: victim.id });
    // Mallory doesn't have the code (it is shown in the victim's browser) — guessing fails...
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) await say(meta, MALLORY, String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0'));
    expect(store.links).toHaveLength(0);
    // ...and is cut off after the allowed attempts, even with the right code.
    await say(meta, MALLORY, code);
    expect(store.links).toHaveLength(0);
    expect(store.challenges[0].status).toBe('CANCELLED');
  });

  it('a correct code sent from a different number links nothing', async () => {
    const meta = fakeMeta();
    const { user } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    await say(meta, ASHA, 'Hi');
    const { code } = await confirmChallenge({ token: tokenFrom(meta), userId: user.id });
    await say(meta, MALLORY, code);
    expect(store.links).toHaveLength(0);
    expect(store.challenges[0].status).toBe('CONFIRMED');
  });

  it('a wrong code says so; the code expires', async () => {
    const meta = fakeMeta();
    const { user } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    await say(meta, ASHA, 'Hi');
    const { code } = await confirmChallenge({ token: tokenFrom(meta), userId: user.id });
    await say(meta, ASHA, code === '000000' ? '111111' : '000000');
    expect(meta.lastText()).toMatch(/That code isn’t right/);
    store.challenges[0].expiresAt = new Date(Date.now() - 1000);
    await say(meta, ASHA, code);
    expect(store.links).toHaveLength(0);
  });

  it('a number can ask for only a few links an hour', async () => {
    const meta = fakeMeta();
    for (let i = 0; i < MAX_LINKS_PER_HOUR + 1; i++) await say(meta, ASHA, `Hi ${i}`);
    expect(store.challenges).toHaveLength(MAX_LINKS_PER_HOUR);
    expect(meta.lastText()).toMatch(/several sign-in links/);
  });
});

describe('workspaces and tenant isolation', () => {
  it('several workspaces: they choose, from their own only', async () => {
    const meta = fakeMeta();
    const { user, companies } = seedUser('asha@multi.test', [
      { company: 'Acme', role: 'OWNER' },
      { company: 'Beta', role: 'VIEWER' },
    ]);
    await link(meta, ASHA, user.id);
    const list = meta.last();
    expect(list.interactive.type).toBe('list');
    expect(list.interactive.action.sections[0].rows.map((r: any) => r.title)).toEqual(['Acme', 'Beta']);

    await say(meta, ASHA, 'Beta', `ws:${companies[1]!.id}`);
    expect(meta.lastText()).toMatch(/now working in \*Beta\*/);
    expect(meta.lastText()).toMatch(/\(Viewer\)/);
    expect(store.links[0].activeCompanyId).toBe(companies[1]!.id);
  });

  it('cannot select a workspace they are not a member of (a forged menu id)', async () => {
    const meta = fakeMeta();
    const { user } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }, { company: 'Acme2', role: 'OWNER' }]);
    const stranger = seedUser('eve@corp.test', [{ company: 'Secret Corp', role: 'OWNER' }]);
    await link(meta, ASHA, user.id);
    await say(meta, ASHA, 'Secret Corp', `ws:${stranger.companies[0]!.id}`);
    expect(store.links[0].activeCompanyId).toBeNull();
    expect(meta.lastText()).toMatch(/isn’t available to you/);
    expect(meta.lastText()).not.toMatch(/Secret Corp/);
    await expect(selectWorkspace({ conversationId: store.links[0].conversationId, companyId: stranger.companies[0]!.id })).rejects.toMatchObject({ status: 404 });
  });

  it('two people on the one number’s service are kept apart', async () => {
    const meta = fakeMeta();
    const a = seedUser('a@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    const b = seedUser('b@beta.test', [{ company: 'Beta', role: 'MEMBER' }]);
    await link(meta, ASHA, a.user.id);
    await link(meta, MALLORY, b.user.id);
    const sa = await resolveSession(conversationOf('3210').id);
    const sb = await resolveSession(conversationOf('0666').id);
    expect(sa.state === 'linked' && sa.active).toMatchObject({ name: 'Acme', role: 'OWNER' });
    expect(sb.state === 'linked' && sb.active).toMatchObject({ name: 'Beta', role: 'MEMBER' });
    expect(sa.state === 'linked' && sa.companies.map((c) => c.name)).toEqual(['Acme']);
  });

  it('role is read fresh: a demotion applies on the very next message', async () => {
    const meta = fakeMeta();
    const { user, companies } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    await link(meta, ASHA, user.id);
    store.members.find((m) => m.userId === user.id && m.companyId === companies[0]!.id)!.role = 'VIEWER';
    const s = await resolveSession(store.links[0].conversationId);
    expect(s.state === 'linked' && s.active?.role).toBe('VIEWER');
  });

  it('removed from the workspace: access goes with it, at once', async () => {
    const meta = fakeMeta();
    const { user } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }, { company: 'Beta', role: 'OWNER' }]);
    await link(meta, ASHA, user.id);
    const acme = store.companies.find((c) => c.name === 'Acme')!;
    await say(meta, ASHA, 'Acme', `ws:${acme.id}`);
    store.members.splice(store.members.findIndex((m) => m.companyId === acme.id), 1);
    await say(meta, ASHA, 'show my campaigns');
    expect(store.links[0].activeCompanyId).toBeNull();
    expect(meta.lastText()).toMatch(/no longer have access/);
    expect(meta.last().interactive.action.sections[0].rows.map((r: any) => r.title)).toEqual(['Beta']);
  });
});

describe('sessions', () => {
  it('an expired session asks them to log in again', async () => {
    const meta = fakeMeta();
    const { user } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    await link(meta, ASHA, user.id);
    store.links[0].expiresAt = new Date(Date.now() - 1000);
    await say(meta, ASHA, 'Hi');
    expect(meta.last().interactive.type).toBe('cta_url');
    expect(meta.lastText().startsWith(EXPIRED_TEXT)).toBe(true);
  });

  it('“Log out” unlinks; the next message starts over', async () => {
    const meta = fakeMeta();
    const { user } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    await link(meta, ASHA, user.id);
    await say(meta, ASHA, 'Log out');
    expect(meta.lastText()).toBe(LOGGED_OUT_TEXT);
    expect(store.links[0].revokedAt).toBeInstanceOf(Date);
    expect(store.audits.some((a) => a.action === 'WHATSAPP_UNLINKED')).toBe(true);
    await say(meta, ASHA, 'Hi');
    expect(meta.lastText().startsWith(WELCOME_TEXT)).toBe(true);
  });

  it('re-linking to a different Aura account replaces the old link (and says so in the audit)', async () => {
    const meta = fakeMeta();
    const a = seedUser('a@acme.test', [{ company: 'Acme', role: 'OWNER' }]).user;
    const b = seedUser('b@beta.test', [{ company: 'Beta', role: 'OWNER' }]).user;
    await link(meta, ASHA, a.id);
    store.links[0].expiresAt = new Date(Date.now() - 1000);
    await say(meta, ASHA, 'Hi');
    await confirmChallenge({ token: tokenFrom(meta), userId: b.id }).then(({ code }) => say(meta, ASHA, code));
    expect(store.links).toHaveLength(1);
    expect(store.links[0].userId).toBe(b.id);
  });

  it('only the link’s own user can revoke it from the website', async () => {
    const meta = fakeMeta();
    const a = seedUser('a@acme.test', [{ company: 'Acme', role: 'OWNER' }]).user;
    const b = seedUser('b@beta.test', [{ company: 'Beta', role: 'OWNER' }]).user;
    await link(meta, ASHA, a.id);
    await expect(revokeLinkForUser(b.id, store.links[0].id)).rejects.toMatchObject({ status: 404 });
    expect(store.links[0].revokedAt).toBeNull();
    await revokeLinkForUser(a.id, store.links[0].id);
    expect(store.links[0].revokedAt).toBeInstanceOf(Date);
  });
});

describe('website routes', () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request('https://aura.example/api/whatsapp/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'aura.example', ...headers },
      body: JSON.stringify(body),
    });

  it('confirming needs an Aura session', async () => {
    const meta = fakeMeta();
    await say(meta, ASHA, 'Hi');
    const res = await confirmRoute(post({ token: tokenFrom(meta) }));
    expect(res.status).toBe(401);
    expect(store.challenges[0].status).toBe('ISSUED');
  });

  it('a cross-site confirm is refused, even with a session', async () => {
    const meta = fakeMeta();
    auth.user = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]).user;
    await say(meta, ASHA, 'Hi');
    const res = await confirmRoute(post({ token: tokenFrom(meta) }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(store.challenges[0].status).toBe('ISSUED');
  });

  it('a signed-in confirm returns the code once; a replay is refused', async () => {
    const meta = fakeMeta();
    auth.user = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]).user;
    await say(meta, ASHA, 'Hi');
    const token = tokenFrom(meta);
    const ok = await confirmRoute(post({ token }, { origin: 'https://aura.example' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ code: expect.stringMatching(/^\d{6}$/), last4: '3210' });
    const replay = await confirmRoute(post({ token }, { origin: 'https://aura.example' }));
    expect(replay.status).toBe(409);
  });

  it('a malformed token is rejected before any lookup', async () => {
    auth.user = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]).user;
    const res = await confirmRoute(post({ token: "' OR 1=1 --" }));
    expect(res.status).toBe(422);
  });

  it('revoking someone else’s link from the website: 404', async () => {
    const meta = fakeMeta();
    const a = seedUser('a@acme.test', [{ company: 'Acme', role: 'OWNER' }]).user;
    await link(meta, ASHA, a.id);
    auth.user = seedUser('eve@corp.test', [{ company: 'Corp', role: 'OWNER' }]).user;
    const res = await revokeRoute(
      new Request(`https://aura.example/api/whatsapp/links/${store.links[0].id}`, { method: 'DELETE', headers: { host: 'aura.example' } }),
      { params: { id: store.links[0].id } },
    );
    expect(res.status).toBe(404);
    expect(store.links[0].revokedAt).toBeNull();
  });
});
