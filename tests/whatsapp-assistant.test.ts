import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Production hardening (Phase 9): messages are recorded against the workspace
 * they were handled in, a workspace can turn WhatsApp off, old personal data
 * is deleted, and only owners/admins can change the setting. The database is
 * the in-memory stand-in; Meta's API is a recording fake.
 */

vi.mock('@/lib/db', async () => ({ db: (await import('./fixtures/whatsapp-db')).db }));

const { auth } = vi.hoisted(() => ({
  auth: { user: null as null | { id: string; email: string }, activeId: null as null | string },
}));
vi.mock('@/lib/auth-helpers', () => ({
  requireUser: async () => {
    if (!auth.user) throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' });
    return auth.user;
  },
  getCurrentUser: async () => auth.user,
  requireActiveCompany: async () => {
    if (!auth.user) throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' });
    const { store } = await import('./fixtures/whatsapp-db');
    const company = store.companies.find((c: any) => c.id === auth.activeId);
    const membership = store.members.find((m: any) => m.userId === auth.user!.id && m.companyId === auth.activeId);
    if (!company || !membership) throw Object.assign(new Error('No active company.'), { status: 403 });
    return { user: auth.user, company, membership };
  },
}));
vi.mock('@/lib/active-company', () => ({
  resolveActiveCompany: async () => ({ active: auth.activeId ? { id: auth.activeId, name: 'x' } : null }),
}));

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
process.env.APP_URL = 'https://aura.example';
process.env.WHATSAPP_DISPLAY_NUMBER = '+1 555 000 0000';

import { parseWebhook, type WhatsAppConfig } from '@/lib/whatsapp';
import { processWebhook } from '@/server/whatsapp/whatsapp.service';
import { applyRetention, drainConversations } from '@/server/whatsapp/queue';
import { confirmChallenge, resolveSession, selectWorkspace } from '@/server/whatsapp/link.service';
import { enabledWorkspaces, setWhatsAppEnabled, whatsAppEnabledIn } from '@/server/whatsapp/settings';
import { PATCH as settingsRoute } from '@/app/api/whatsapp/settings/route';
import { POST as sendRoute } from '@/app/api/whatsapp/send/route';
import { GET as featuresRoute } from '@/app/api/whatsapp/features/route';
import { whatsAppFeatures } from '@/server/whatsapp/features';
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
    last: () => sends().at(-1),
    lastText: () => {
      const c = sends().at(-1);
      return c?.text?.body ?? c?.interactive?.body?.text ?? '';
    },
  };
}

const ASHA = '919876543210';
let seq = 0;

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

async function link(meta: ReturnType<typeof fakeMeta>, from: string, userId: string) {
  await say(meta, from, 'Hi');
  const url = meta.last()?.interactive?.action?.parameters?.url as string;
  const { code } = await confirmChallenge({ token: url.split('/').pop()!, userId });
  await say(meta, from, code);
}

const patch = (body: unknown, origin = 'https://aura.example') =>
  settingsRoute(
    new Request('https://aura.example/api/whatsapp/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', origin },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  resetStore();
  auth.user = null;
  auth.activeId = null;
});

describe('messages are recorded against their workspace', () => {
  it('a linked person’s messages and replies carry the workspace; sign-in chatter carries none', async () => {
    const meta = fakeMeta();
    const { user, companies } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    await link(meta, ASHA, user.id);
    const before = store.messages.length;
    await say(meta, ASHA, 'menu');
    const fresh = store.messages.slice(before);
    expect(fresh.length).toBeGreaterThanOrEqual(2);
    expect(fresh.every((m) => m.companyId === companies[0]!.id)).toBe(true);
    // "Hi" and the sign-in link were before any workspace was in play.
    expect(store.messages[0].companyId ?? null).toBeNull();
  });
});

describe('a workspace can turn WhatsApp off', () => {
  it('on by default; the setting merges into preferences and is audited', async () => {
    const { user, companies } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    const acme = companies[0]!;
    acme.preferences = { brand: { tone: 'warm' } };
    expect(whatsAppEnabledIn(acme.preferences)).toBe(true);
    await setWhatsAppEnabled({ companyId: acme.id, userId: user.id, enabled: false });
    expect(acme.preferences).toEqual({ brand: { tone: 'warm' }, whatsappAssistant: { enabled: false } });
    expect((await enabledWorkspaces([acme.id])).size).toBe(0);
    expect(store.audits.at(-1)).toMatchObject({ action: 'WHATSAPP_SETTINGS_UPDATED', metadata: { enabled: false } });
  });

  it('turned off: not offered, cannot be chosen, and anyone using it loses it on the next message', async () => {
    const meta = fakeMeta();
    const { user, companies } = seedUser('asha@multi.test', [
      { company: 'Acme', role: 'OWNER' },
      { company: 'Beta', role: 'OWNER' },
    ]);
    const [acme, beta] = companies as [any, any];
    await link(meta, ASHA, user.id);
    await say(meta, ASHA, 'Acme', `ws:${acme.id}`);
    expect(store.links[0].activeCompanyId).toBe(acme.id);

    await setWhatsAppEnabled({ companyId: acme.id, userId: user.id, enabled: false });
    await say(meta, ASHA, 'menu');
    expect(store.links[0].activeCompanyId).toBeNull();
    expect(meta.lastText()).toMatch(/turned off for the workspace/);
    expect(meta.last().interactive.action.sections[0].rows.map((r: any) => r.title)).toEqual(['Beta']);
    await expect(selectWorkspace({ conversationId: store.links[0].conversationId, companyId: acme.id })).rejects.toMatchObject({ status: 404 });

    await setWhatsAppEnabled({ companyId: acme.id, userId: user.id, enabled: true });
    const s = await resolveSession(store.links[0].conversationId);
    expect(s.state === 'linked' && s.companies.map((c) => c.name)).toEqual(['Acme', 'Beta']);
    expect(beta.id).toBeTruthy();
  });

  it('the setting route: owners and admins only, same-site only', async () => {
    const owner = seedUser('o@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    const viewer = seedUser('v@acme.test', [{ company: 'Acme', role: 'VIEWER' }]);
    const acme = owner.companies[0]!;
    auth.activeId = acme.id;

    expect((await patch({ enabled: false })).status).toBe(401);

    auth.user = viewer.user;
    expect((await patch({ enabled: false })).status).toBe(403);
    expect(whatsAppEnabledIn(acme.preferences)).toBe(true);

    auth.user = owner.user;
    expect((await patch({ enabled: false }, 'https://evil.example')).status).toBe(403);
    expect((await patch({ enabled: 'no' })).status).toBe(400);
    expect(whatsAppEnabledIn(acme.preferences)).toBe(true);

    const ok = await patch({ enabled: false });
    expect(ok.status).toBe(200);
    expect(whatsAppEnabledIn(acme.preferences)).toBe(false);
  });
});

describe('retention', () => {
  it('deletes old message text and abandoned numbers; keeps linked conversations', async () => {
    const meta = fakeMeta();
    const { user } = seedUser('asha@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    await link(meta, ASHA, user.id);
    await say(meta, '447700900666', 'Hi'); // never links
    const linkedConv = store.links[0].conversationId;
    const strangerConv = store.conversations.find((c) => c.id !== linkedConv)!;
    const total = store.messages.length;

    // Nothing is old yet.
    expect(await applyRetention(new Date())).toEqual({ messages: 0, conversations: 0, challenges: 0 });

    // 91 days later (default 90): everything written so far is old.
    const later = new Date(Date.now() + 91 * 86_400_000);
    const r = await applyRetention(later);
    expect(r.messages).toBe(total);
    expect(r.conversations).toBe(1);
    expect(store.messages).toHaveLength(0);
    expect(store.conversations.map((c) => c.id)).toEqual([linkedConv]);
    expect(store.conversations.some((c) => c.id === strangerConv.id)).toBe(false);
    expect(store.links).toHaveLength(1);
  });
});

describe('security hardening', () => {
  it('a sent sign-in button does not keep its link token', async () => {
    const meta = fakeMeta();
    await say(meta, ASHA, 'Hi');
    const sent = store.messages.find((m) => m.direction === 'OUTBOUND' && m.payload?.kind === 'cta');
    expect(sent.status).toBe('SENT');
    expect(sent.payload.url).toBe('[sent]');
    expect(JSON.stringify(sent)).not.toMatch(/whatsapp\/link\//);
  });

  it('URLs are logged without credentials', async () => {
    const { redactUrl, HttpError } = await import('@/lib/http');
    const url = 'https://graph.facebook.com/v23.0/me/accounts?fields=id&access_token=EAAsecret123&client_secret=s3';
    expect(redactUrl(url)).toBe('https://graph.facebook.com/v23.0/me/accounts?fields=id&access_token=[redacted]&client_secret=[redacted]');
    expect(new HttpError(500, url).message).not.toMatch(/EAAsecret123|s3$/);
  });
});

describe('GET /api/whatsapp/features', () => {
  const ids = (role: any) => whatsAppFeatures(role).flatMap((c) => c.tools.map((t) => t.id));

  it('lists only what the role may do, from the same registry the assistant runs', () => {
    const owner = ids('OWNER');
    const viewer = ids('VIEWER');
    expect(owner).toEqual(expect.arrayContaining(['approve_draft', 'publish_draft', 'generate_post', 'connect_account', 'opportunities']));
    expect(viewer).toEqual(expect.arrayContaining(['opportunities', 'campaigns']));
    for (const t of ['approve_draft', 'reject_draft', 'publish_draft', 'generate_post', 'connect_account']) expect(viewer).not.toContain(t);
    const approve = whatsAppFeatures('OWNER').flatMap((c) => c.tools).find((t) => t.id === 'approve_draft')!;
    expect(approve).toMatchObject({ needsConfirmation: true });
  });

  it('the route: signed-in, active workspace, role-shaped; no setting values', async () => {
    const { user, companies } = seedUser('v@acme.test', [{ company: 'Acme', role: 'VIEWER' }]);
    expect((await featuresRoute()).status).toBe(401);
    auth.user = user;
    auth.activeId = companies[0]!.id;
    process.env.WHATSAPP_APP_SECRET = 'secret-value-never-shown';
    const res = await featuresRoute();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ workspace: { name: 'Acme' }, role: 'VIEWER', enabled: true });
    expect(body.commands.map((c: any) => c.word)).toEqual(['MENU', 'SWITCH', 'LOGOUT', 'STOP']);
    expect(JSON.stringify(body)).not.toContain('secret-value-never-shown');
    expect(JSON.stringify(body)).not.toContain('approve_draft');
    delete process.env.WHATSAPP_APP_SECRET;
  });
});

describe('POST /api/whatsapp/send (owners/admins to a member, on WhatsApp)', () => {
  const send = (body: unknown, origin = 'https://aura.example') =>
    sendRoute(
      new Request('https://aura.example/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin },
        body: JSON.stringify(body),
      }),
    );
  const ENV = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'];

  async function setup() {
    const meta = fakeMeta();
    const owner = seedUser('o@acme.test', [{ company: 'Acme', role: 'OWNER' }]);
    const acme = owner.companies[0]!;
    const member = seedUser('m@acme.test', [{ company: 'Acme', role: 'MEMBER' }]);
    await link(meta, ASHA, member.user.id);
    for (const k of ENV) process.env[k] = k === 'WHATSAPP_PHONE_NUMBER_ID' ? PHONE_ID : `test-${k}`;
    vi.stubGlobal('fetch', meta.impl);
    auth.user = { ...owner.user, name: 'Olu' } as any;
    auth.activeId = acme.id;
    return { meta, owner, member, acme };
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV) delete process.env[k];
  });

  it('sends a signed text to the member, recorded against the workspace and audited (text not in the audit)', async () => {
    const { meta, member, acme } = await setup();
    const before = store.messages.length;
    const res = await send({ userId: member.user.id, text: 'Can you check the brunch post?' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, skipped: [] });
    expect(meta.lastText()).toBe('💬 Olu (Acme), via Aura:\n\nCan you check the brunch post?');
    const out = store.messages.slice(before).find((m) => m.direction === 'OUTBOUND')!;
    expect(out.companyId).toBe(acme.id);
    expect(store.audits.at(-1)).toMatchObject({ action: 'WHATSAPP_ADMIN_MESSAGE_SENT', metadata: { recipientUserId: member.user.id, sent: 1 } });
    expect(JSON.stringify(store.audits.at(-1))).not.toContain('brunch post');
  });

  it('refused: cross-site, someone outside the workspace, bad input, and non-admins', async () => {
    const { member } = await setup();
    expect((await send({ userId: member.user.id, text: 'hi' }, 'https://evil.example')).status).toBe(403);
    const stranger = seedUser('x@other.test', [{ company: 'Other', role: 'OWNER' }]);
    expect((await send({ userId: stranger.user.id, text: 'hi' })).status).toBe(404);
    expect((await send({ userId: member.user.id, text: '' })).status).toBe(400);
    expect((await send({ userId: member.user.id, text: 'x'.repeat(1001) })).status).toBe(400);
    auth.user = member.user;
    expect((await send({ userId: member.user.id, text: 'hi' })).status).toBe(403);
  });

  it('never outside the 24-hour window, never after STOP', async () => {
    const { meta, member } = await setup();
    const conv = store.conversations.find((c) => c.id === store.links[0].conversationId)!;
    const lastBefore = meta.last();
    conv.lastInboundAt = new Date(Date.now() - 25 * 3_600_000);
    expect(await (await send({ userId: member.user.id, text: 'hi' })).json()).toEqual({
      sent: 0,
      skipped: [{ last4: '3210', reason: 'outside_24h_window' }],
    });
    conv.lastInboundAt = new Date();
    conv.optedOut = true;
    expect(await (await send({ userId: member.user.id, text: 'hi' })).json()).toMatchObject({ sent: 0, skipped: [{ reason: 'opted_out' }] });
    expect(meta.last()).toBe(lastBefore);
  });
});

describe('processing results on WhatsApp', () => {
  it('a Reel still processing is reported as such, not as published', async () => {
    const { resultsMessage } = await import('@/server/whatsapp/tools/social');
    const r = resultsMessage([{ platform: 'INSTAGRAM', status: 'processing', message: 'x' } as any], 'd1');
    const body = (r.contents[0] as any).text as string;
    expect(body).toMatch(/Instagram — processing the video/);
    expect(body).not.toMatch(/published/);
  });
});
