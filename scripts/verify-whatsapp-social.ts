/**
 * Social publishing from WhatsApp (Phase 7), against the running app, the
 * real database and Aura's real services. No live Meta or LinkedIn account
 * exists here, so no network accepts a post — this checks the conversation,
 * the confirmations, and that Aura never claims a publish that did not happen.
 *
 *   Ask        "a post for all my social media accounts" → which platforms?
 *              → networks typed → what about? → the post (real generator, or an
 *              honest failure) with each network's preview
 *   Publish    an approved post → Publish → networks → a confirmation naming
 *              exactly the ones that can go → the real one-click publishing →
 *              Meta refuses the stand-in token → "post it by hand", recorded;
 *              the post is NOT marked published
 *   Retry      "publish" again → only a person's retry, counted
 *
 * Run (app running with the same WHATSAPP_* values):
 *   VERIFY_BASE_URL=http://localhost:3001 pnpm verify:whatsapp-social
 */
import { resolveSentUrl } from './lib/wa-stub';
import bcrypt from 'bcryptjs';

import { db } from '@/lib/db';
import { encrypt, keyedHash } from '@/lib/crypto';
import { signPayload } from '@/lib/whatsapp';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const SECRET = process.env.WHATSAPP_APP_SECRET ?? '';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const STAMP = Date.now();
const PASSWORD = `Zz-wasocial-${STAMP}!`;
const NUMBER = `1555015${String(STAMP).slice(-4)}`;

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const note = (s: string) => console.log(`          ${s}`);

async function webConfirm(email: string, token: string): Promise<string> {
  const jar = new Map<string, string>();
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  keep(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  keep(
    await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: cookie() },
      body: new URLSearchParams({ csrfToken, email, password: PASSWORD, json: 'true' }),
    }),
  );
  const res = await fetch(`${BASE}/api/whatsapp/link/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE, cookie: cookie() },
    body: JSON.stringify({ token }),
  });
  return ((await res.json()) as { code: string }).code;
}

interface Reply {
  kind?: string;
  body: string;
  ids: string[];
  url?: string;
}

async function say(text: string, replyId?: string, timeoutMs = 150_000): Promise<Reply[]> {
  const id = `wamid.WASOC${STAMP}.${Math.random().toString(36).slice(2)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const message = replyId
    ? { from: NUMBER, id, timestamp: ts, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: replyId, title: text } } }
    : { from: NUMBER, id, timestamp: ts, type: 'text', text: { body: text } };
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: NUMBER, profile: { name: 'Verify' } }], messages: [message] } }] }],
  });
  const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signPayload(raw, SECRET) },
    body: raw,
  });
  if (res.status !== 200) throw new Error(`webhook answered ${res.status}`);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const job = await db.whatsAppJob.findFirst({ where: { message: { wamid: id } } });
    if (job?.status === 'DONE' || job?.status === 'DEAD') break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const inbound = await db.whatsAppMessage.findUnique({ where: { wamid: id } });
  const out = await db.whatsAppMessage.findMany({
    where: { conversationId: inbound!.conversationId, direction: 'OUTBOUND', createdAt: { gte: inbound!.createdAt } },
    orderBy: { createdAt: 'asc' },
  });
  const replies = out.map((m) => {
    const p = (m.payload ?? {}) as any;
    return {
      kind: p.kind,
      body: p.body ?? p.text ?? m.body ?? '',
      ids: [...(p.buttons ?? []).map((b: any) => b.id), ...(p.sections ?? []).flatMap((s: any) => s.rows.map((r: any) => r.id))],
      url: p.url,
    };
  });
  // Sent links are kept as "[sent]"; with the local stub, read them from what it received.
  for (const r of replies) if (r.url === '[sent]') r.url = await resolveSentUrl(NUMBER, r.url);
  return replies;
}
const last = (r: Reply[]) => r.at(-1) ?? { body: '', ids: [] };

async function main() {
  if (!SECRET || !PHONE_ID) {
    console.error('Set WHATSAPP_APP_SECRET and WHATSAPP_PHONE_NUMBER_ID (the values the app runs with).');
    process.exit(2);
  }
  const owner = await db.user.create({ data: { email: `zzverify-wasocial-${STAMP}@example.test`, passwordHash: await bcrypt.hash(PASSWORD, 10) } });
  const company = await db.company.create({ data: { name: `zzverify Social Cafe ${STAMP}`, slug: `zzverify-wasocial-${STAMP}`, industry: 'Cafe' } });
  await db.companyMember.create({ data: { userId: owner.id, companyId: company.id, role: 'OWNER' } });
  const approved = await db.contentDraft.create({
    data: {
      companyId: company.id,
      type: 'IMAGE_POST',
      platform: 'FACEBOOK',
      status: 'APPROVED',
      title: 'Cold brew',
      body: { caption: 'Our cold brew is back for the summer. Smooth, slow-steeped, and ready when you are.', cta: 'Stop by this weekend.', hashtags: ['coldbrew'], altText: '' },
    },
  });
  // A Facebook connection whose token Meta will refuse.
  await db.connection.create({
    data: {
      companyId: company.id,
      connectorId: 'meta',
      kind: 'OAUTH',
      status: 'CONNECTED',
      accessTokenEnc: encrypt('NOT_A_REAL_TOKEN'),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      accountLabel: 'Test Page',
      metadata: { pageId: '111', pageName: 'Test Page', pages: [{ id: '111', name: 'Test Page', ig: null }] },
    },
  });

  try {
    const hi = await say('Hi');
    const code = await webConfirm(owner.email, last(hi).url!.split('/').pop()!);
    await say(code);

    console.log('Ask');
    const ask = await say('Create a marketing post for all my social media accounts');
    check('“all my social media accounts” → which platforms?', last(ask).body.startsWith('Which platforms?') && last(ask).ids.includes('plat:FACEBOOK,INSTAGRAM,LINKEDIN'), last(ask).body.slice(0, 80));
    const typed = await say('Facebook and LinkedIn');
    check('networks typed → what about?', last(typed).body === 'What should the post for Facebook and LinkedIn be about?', last(typed).body);
    const t0 = Date.now();
    const made = await say('our cold brew coming back for summer', undefined, 180_000);
    const secs = Math.round((Date.now() - t0) / 1000);
    const preview = last(made);
    if (preview.body.includes('How it will look')) {
      check(`the real generator wrote it (${secs}s), with each network’s preview`, /\*Facebook\* — ✅ ready/.test(preview.body) && /\*LinkedIn\* — ⚠️ LinkedIn isn’t connected/.test(preview.body), preview.body.slice(0, 300));
      check('and the owner can approve & publish from there', preview.ids.includes('pub:go'), preview.ids.join());
    } else {
      check(`no post, and an honest message instead (${secs}s)`, /^I couldn’t write that/.test(preview.body), preview.body);
      note(`Aura said: ${preview.body}`);
    }

    console.log('Publish');
    const opened = await say('open', `draft:${approved.id}`);
    check('an approved post offers Publish', last(opened).ids[0] === `act:publish:${approved.id}`, last(opened).ids.join());
    const which = await say('Publish', `act:publish:${approved.id}`);
    check('→ which platforms?', last(which).body.startsWith('Publish to which platforms?'), last(which).body.slice(0, 60));
    const confirm = await say('Facebook + LinkedIn', 'plat:FACEBOOK,LINKEDIN');
    const c = last(confirm);
    check('the confirmation names exactly the network that can go', c.body.startsWith('Publish this post to *Facebook* now?'), c.body.slice(0, 80));
    check('and says why LinkedIn is not included', /Not included:\n• LinkedIn — LinkedIn isn’t connected/.test(c.body), c.body);
    check('nothing published before the yes', (await db.contentPublication.count({ where: { contentDraftId: approved.id } })) === 0);
    const yes = await say('Yes, publish', c.ids[0]);
    const pub = await db.contentPublication.findUnique({ where: { contentDraftId_platform: { contentDraftId: approved.id, platform: 'FACEBOOK' } } });
    check('the real publishing ran; Meta refused → “post it by hand”, with the reason', /⚠️ Facebook — post it by hand/.test(last(yes).body) && pub?.status === 'MANUAL', `${pub?.status} | ${last(yes).body.slice(0, 160)}`);
    check('the post is NOT marked published', (await db.contentDraft.findUnique({ where: { id: approved.id } }))?.status === 'APPROVED');
    const again = await say('Yes, publish', c.ids[0]);
    check('the confirmation cannot be used twice', /no longer valid/.test(last(again).body), last(again).body);

    console.log('Retry');
    const retryAsk = await say('publish');
    const retry = await say('Yes, publish', last(retryAsk).ids[0]);
    const after = await db.contentPublication.findUnique({ where: { contentDraftId_platform: { contentDraftId: approved.id, platform: 'FACEBOOK' } } });
    check('a person’s retry tries again, counted', after?.attempts === 2 && /Facebook/.test(last(retry).body), `attempts ${after?.attempts}`);
  } finally {
    const conv = await db.whatsAppConversation.findUnique({ where: { waIdHash: keyedHash(NUMBER, 'whatsapp-wa-id') } });
    if (conv) {
      await db.auditLog.deleteMany({ where: { metadata: { path: ['conversationId'], equals: conv.id } } });
      await db.whatsAppConversation.delete({ where: { id: conv.id } });
    }
    await db.auditLog.deleteMany({ where: { OR: [{ companyId: company.id }, { userId: owner.id }] } });
    await db.generationJob.deleteMany({ where: { companyId: company.id } });
    await db.company.delete({ where: { id: company.id } });
    await db.user.delete({ where: { id: owner.id } });
    console.log('  ok      cleanup: throwaway user, workspace, drafts, publications, conversation and audit entries removed');
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll WhatsApp social publishing checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
