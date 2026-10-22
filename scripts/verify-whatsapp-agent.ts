/**
 * WhatsApp agent (Phase 4), against the running app, the real database and
 * Aura's real services. A throwaway owner and viewer link their numbers the
 * real way (website confirmation + code); messages are signed webhooks.
 *
 *   Menu        the feature menu after sign-in, by category
 *   Read        campaigns and the approvals queue from the real services
 *   Draft       opening a draft shows it with the owner's actions
 *   Approve     "Approve" only asks; the yes runs the real approval (which
 *               needs the AI review — reported honestly if the AI is down)
 *   Generate    a post written by the real generator (AI) — or an honest
 *               failure message, never a fake draft
 *   Viewer      cannot write; told why
 *   Tenant      another business's draft id shows nothing
 *   Connect     "connect linkedin" → a button; the link, opened by the signed-in
 *               user, lands on the existing OAuth start (or says not configured)
 *
 * Run (app running with the same WHATSAPP_* values):
 *   VERIFY_BASE_URL=http://localhost:3001 pnpm verify:whatsapp-agent
 */
import { resolveSentUrl } from './lib/wa-stub';
import bcrypt from 'bcryptjs';

import { db } from '@/lib/db';
import { keyedHash } from '@/lib/crypto';
import { signPayload } from '@/lib/whatsapp';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const SECRET = process.env.WHATSAPP_APP_SECRET ?? '';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const STAMP = Date.now();
const PASSWORD = `Zz-waagent-${STAMP}!`;
const OWNER_NO = `1555013${String(STAMP).slice(-4)}`;
const VIEWER_NO = `1555014${String(STAMP).slice(-4)}`;

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const note = (s: string) => console.log(`          ${s}`);

class Web {
  private jar = new Map<string, string>();
  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      this.jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      headers: { Origin: BASE, cookie: this.cookie(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.keep(res);
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* page */
    }
    return { status: res.status, json, location: res.headers.get('location') };
  }
  async signIn(email: string) {
    const csrf = await this.req('GET', '/api/auth/csrf');
    const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: this.cookie() },
      body: new URLSearchParams({ csrfToken: csrf.json.csrfToken, email, password: PASSWORD, json: 'true' }),
    });
    this.keep(res);
  }
}

interface Reply {
  kind?: string;
  body: string;
  ids: string[];
  url?: string;
}

/** Send a signed WhatsApp message; wait for the queue to answer; return all replies to it. */
async function say(from: string, text: string, replyId?: string, timeoutMs = 120_000): Promise<Reply[]> {
  const id = `wamid.WAAGENT${STAMP}.${Math.random().toString(36).slice(2)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const message = replyId
    ? { from, id, timestamp: ts, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: replyId, title: text } } }
    : { from, id, timestamp: ts, type: 'text', text: { body: text } };
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: from, profile: { name: 'Verify' } }], messages: [message] } }] }],
  });
  const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signPayload(raw, SECRET) },
    body: raw,
  });
  if (res.status !== 200) throw new Error(`webhook answered ${res.status}`);
  const end = Date.now() + timeoutMs;
  let job = null;
  while (Date.now() < end) {
    job = await db.whatsAppJob.findFirst({ where: { message: { wamid: id } } });
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
    const ids = [
      ...(p.buttons ?? []).map((b: any) => b.id),
      ...(p.sections ?? []).flatMap((s: any) => s.rows.map((r: any) => r.id)),
    ];
    return { kind: p.kind, body: p.body ?? p.text ?? m.body ?? '', ids, url: p.url };
  });
  // Sent links are kept as "[sent]"; with the local stub, read them from what it received.
  for (const r of replies) if (r.url === '[sent]') r.url = await resolveSentUrl(from, r.url);
  return replies;
}
const last = (r: Reply[]) => r.at(-1) ?? { body: '', ids: [] };

async function link(web: Web, email: string, number: string) {
  const hi = await say(number, 'Hi');
  const token = last(hi).url!.split('/').pop()!;
  await web.signIn(email);
  const confirm = await web.req('POST', '/api/whatsapp/link/confirm', { token });
  return say(number, confirm.json.code);
}

async function main() {
  if (!SECRET || !PHONE_ID) {
    console.error('Set WHATSAPP_APP_SECRET and WHATSAPP_PHONE_NUMBER_ID (the values the app runs with).');
    process.exit(2);
  }
  const hash = await bcrypt.hash(PASSWORD, 10);
  const owner = await db.user.create({ data: { email: `zzverify-waagent-o-${STAMP}@example.test`, passwordHash: hash } });
  const viewer = await db.user.create({ data: { email: `zzverify-waagent-v-${STAMP}@example.test`, passwordHash: hash } });
  const company = await db.company.create({
    data: { name: `zzverify Agent Cafe ${STAMP}`, slug: `zzverify-waagent-${STAMP}`, industry: 'Cafe', website: 'https://cafe.example' },
  });
  const other = await db.company.create({ data: { name: `zzverify Other ${STAMP}`, slug: `zzverify-waagent-x-${STAMP}` } });
  await db.companyMember.createMany({
    data: [
      { userId: owner.id, companyId: company.id, role: 'OWNER' },
      { userId: viewer.id, companyId: company.id, role: 'VIEWER' },
    ],
  });
  const campaign = await db.campaign.create({ data: { companyId: company.id, name: `Diwali push ${STAMP}`, status: 'ACTIVE' } });
  const pending = await db.contentDraft.create({
    data: {
      companyId: company.id,
      type: 'LINKEDIN_POST',
      platform: 'LINKEDIN',
      status: 'PENDING_APPROVAL',
      title: 'Weekend brunch',
      body: {
        hook: 'Our weekend brunch is back.',
        paragraphs: ['Fresh pastries from our own oven every Saturday morning.', 'Slow coffee, brewed to order.', 'And a table by the window, if you come early.'],
        cta: 'Book a table for this weekend.',
        hashtags: ['brunch'],
      },
    },
  });
  const foreign = await db.contentDraft.create({
    data: { companyId: other.id, type: 'LINKEDIN_POST', status: 'DRAFT', title: 'Secret', body: { hook: 'OTHER BUSINESS SECRET', paragraphs: ['a', 'b', 'c'], cta: '', hashtags: [] } },
  });
  const ownerWeb = new Web();
  const viewerWeb = new Web();

  try {
    console.log('Menu');
    const linked = await link(ownerWeb, owner.email, OWNER_NO);
    check('after sign-in, the feature menu', last(linked).kind === 'list' && last(linked).ids.includes('cat:content'), JSON.stringify(last(linked).ids));
    const content = await say(OWNER_NO, 'Content Studio', 'cat:content');
    check('a category opens its actions', last(content).ids.join() === 'tool:drafts,tool:generate_post,tool:plan_social_post', last(content).ids.join());

    console.log('Read');
    const camps = await say(OWNER_NO, 'Show my active campaigns');
    check('campaigns, from the real service', last(camps).body.includes(`Diwali push ${STAMP}`), last(camps).body.slice(0, 200));
    const queue = await say(OWNER_NO, 'What content is awaiting approval?');
    check('the approvals queue lists the waiting draft', last(queue).ids.includes(`draft:${pending.id}`), JSON.stringify(last(queue).ids));

    console.log('Draft');
    const opened = await say(OWNER_NO, 'Weekend brunch', `draft:${pending.id}`);
    check('opening it shows the post', last(opened).body.includes('Our weekend brunch is back'), last(opened).body.slice(0, 200));
    check('with the owner’s actions', last(opened).ids.includes(`act:approve:${pending.id}`) && last(opened).ids.includes(`act:reject:${pending.id}`), last(opened).ids.join());

    console.log('Approve');
    const ask = await say(OWNER_NO, 'Approve', `act:approve:${pending.id}`);
    const confirmId = last(ask).ids.find((i) => i.startsWith('confirm:'));
    check('“Approve” asks for a yes first', Boolean(confirmId) && last(ask).body.startsWith('Approve this'), last(ask).body.slice(0, 120));
    check('nothing approved yet', (await db.contentDraft.findUnique({ where: { id: pending.id } }))?.status === 'PENDING_APPROVAL');
    let yes = await say(OWNER_NO, 'Yes, approve', confirmId);
    if (last(yes).body.startsWith('Before approving')) {
      // Aura asked a person to vouch for a claim: the second, explicit yes.
      check('Aura’s fact check asked for a second, explicit yes', last(yes).ids.some((i) => i.startsWith('confirm:')), last(yes).body);
      note(`Aura said: ${last(yes).body.split('\n')[0]}`);
      yes = await say(OWNER_NO, 'I’ve checked — approve', last(yes).ids.find((i) => i.startsWith('confirm:')));
    }
    const after = await db.contentDraft.findUnique({ where: { id: pending.id } });
    const answer = last(yes).body;
    if (after?.status === 'APPROVED') {
      check('the yes ran the real approval', answer.startsWith('✅ Approved'), answer);
    } else {
      check('the approval was refused with Aura’s own reason (not faked)', /^(Not approved:|Before approving:)|couldn|can’t/i.test(answer), answer);
      note(`Aura said: ${answer.split('\n')[0]}`);
    }
    const again = await say(OWNER_NO, 'Yes, approve', confirmId);
    check('the same confirmation cannot be used twice', /no longer valid/.test(last(again).body), last(again).body);

    console.log('Generate');
    const t0 = Date.now();
    const gen = await say(OWNER_NO, 'Generate a LinkedIn post about our new cold brew', undefined, 180_000);
    const secs = Math.round((Date.now() - t0) / 1000);
    check('a progress note goes out first', gen.some((r) => r.body.startsWith('✍️ Writing your LinkedIn post')), gen.map((r) => r.body.slice(0, 40)).join(' | '));
    const made = await db.contentDraft.findFirst({ where: { companyId: company.id, id: { not: pending.id } }, orderBy: { createdAt: 'desc' } });
    if (made) {
      check(`the real generator wrote and saved a draft (${secs}s)`, last(gen).body.includes('Saved as a draft'), last(gen).body.slice(0, 120));
    } else {
      check(`no draft, and an honest message instead (${secs}s)`, /^I couldn’t write that/.test(last(gen).body), last(gen).body);
      note(`Aura said: ${last(gen).body}`);
    }

    console.log('Image');
    // The post just written, else the one approved above (an image on an
    // approved post must send it back for approval).
    const target = made ?? (await db.contentDraft.findUnique({ where: { id: pending.id } }));
    if (target) {
      await say(OWNER_NO, 'open', `draft:${target.id}`);
      const t1 = Date.now();
      const img = await say(OWNER_NO, 'Generate a realistic marketing image for this post', undefined, 180_000);
      const isecs = Math.round((Date.now() - t1) / 1000);
      const asset = await db.generatedAsset.findFirst({ where: { companyId: company.id, contentDraftId: target.id } });
      const sentImage = img.find((r) => r.kind === 'image');
      if (asset) {
        check(`the real image pipeline made an image for that post (${isecs}s)`, Boolean(sentImage), img.map((r) => r.kind).join(','));
        const use = await say(OWNER_NO, 'Use this image', `act:useimage:${target.id}`);
        const media = await db.contentMedia.findFirst({ where: { contentDraftId: target.id, assetId: asset.id } });
        check('“Use this image” attaches it to the post', Boolean(media) && last(use).body.startsWith('✅ Image attached'), last(use).body.slice(0, 80));
        if (target.status === 'APPROVED') {
          const reopened = await db.contentDraft.findUnique({ where: { id: target.id } });
          check('a new image on approved content sends it back for approval', reopened?.status !== 'APPROVED', reopened?.status);
        }
      } else {
        check(`no image, and an honest message instead (${isecs}s)`, /couldn’t create the image|isn’t configured|returned nothing|plan/.test(last(img).body), last(img).body);
        note(`Aura said: ${last(img).body}`);
      }
    } else {
      note('skipped: no draft to put an image on');
    }

    console.log('Viewer');
    await link(viewerWeb, viewer.email, VIEWER_NO);
    const refused = await say(VIEWER_NO, 'write a LinkedIn post about our brunch');
    check('a viewer cannot write, and is told why', /As Viewer in this workspace you can’t do that/.test(last(refused).body), last(refused).body);
    // Every read-only feature, from the real services, as the viewer.
    const reads: [string, RegExp][] = [
      ['Summarize my marketing activities', /— today/],
      ['Show my latest opportunities', /opportunities/i],
      ['What recommendations has Aura generated?', /(Aura suggests|No suggestions)/],
      ['business context', /zzverify Agent Cafe/],
      ['content calendar', /(Next two weeks|Nothing is scheduled)/],
      ['What is my latest campaign performance?', /(Last 30 days|No results)/],
      ['connected accounts', /Connected accounts/],
      ['account', /Signed in as zzverify-waagent-v-/],
    ];
    for (const [ask, expect] of reads) {
      const r = last(await say(VIEWER_NO, ask));
      check(`“${ask}” answers from the real service`, expect.test(r.body), r.body.slice(0, 120));
    }

    console.log('Tenant');
    const peek = await say(OWNER_NO, 'Secret', `draft:${foreign.id}`);
    check('another business’s draft shows nothing', !last(peek).body.includes('OTHER BUSINESS SECRET') && /Which post do you mean/.test(last(peek).body), last(peek).body.slice(0, 120));

    console.log('Connect');
    const conn = await say(OWNER_NO, 'Connect LinkedIn');
    const c = last(conn);
    if (c.kind === 'cta') {
      check('“connect linkedin” → a button to Aura', Boolean(c.url?.startsWith(`${BASE}/whatsapp/connect/`)), c.url);
      const landed = await ownerWeb.req('GET', new URL(c.url!).pathname);
      check(
        'opened by the signed-in owner, it hands over to the existing LinkedIn flow',
        landed.status === 307 && Boolean(landed.location?.endsWith('/api/linkedin/connect')),
        `${landed.status} ${landed.location}`,
      );
      const wrong = await viewerWeb.req('GET', new URL(c.url!).pathname);
      check('opened by anyone else, it is refused', Boolean(wrong.location?.includes('error=wrong_account')), `${wrong.status} ${wrong.location}`);
    } else {
      check('LinkedIn not configured here: said plainly', /isn’t set up on this Aura server/.test(c.body), c.body);
    }
  } finally {
    for (const n of [OWNER_NO, VIEWER_NO]) {
      const conv = await db.whatsAppConversation.findUnique({ where: { waIdHash: keyedHash(n, 'whatsapp-wa-id') } });
      if (conv) {
        await db.auditLog.deleteMany({ where: { metadata: { path: ['conversationId'], equals: conv.id } } });
        await db.whatsAppConversation.delete({ where: { id: conv.id } });
      }
    }
    await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: [owner.id, viewer.id] } }, { companyId: { in: [company.id, other.id] } }] } });
    await db.generationJob.deleteMany({ where: { companyId: { in: [company.id, other.id] } } });
    await db.company.deleteMany({ where: { id: { in: [company.id, other.id] } } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, viewer.id] } } });
    void campaign;
    console.log('  ok      cleanup: throwaway users, workspaces, drafts, conversations and audit entries removed');
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll WhatsApp agent checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
