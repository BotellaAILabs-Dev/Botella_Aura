/**
 * The WhatsApp assistant, end to end, entirely on this machine.
 *
 * There are two things people call "the WhatsApp sandbox", and they are not
 * the same:
 *
 *   1. META'S TEST ENVIRONMENT — real WhatsApp, on a real phone, through
 *      Meta's free test number. Needs the four WHATSAPP_* secrets from the
 *      Meta dashboard and a public HTTPS address Meta can reach.
 *      That is `npm run demo:whatsapp`, not this script.
 *
 *   2. THIS — a local stand-in. `scripts/load/meta-stub.ts` answers on
 *      localhost exactly as Meta's Cloud API does, and this script plays the
 *      part of the phone: it signs an inbound message the way Meta signs one,
 *      posts it to Aura's own webhook, drains the worker, and reads back what
 *      Aura replied by asking the stub what it was told to send.
 *
 * So the whole conversation is real — the signature check, the queue, the
 * worker, the agent, the tools, the reply — and the only fake part is Meta
 * itself. No Meta account, no tunnel, no phone, nothing leaves the machine.
 *
 * What it proves: a message arrives, Aura understands it, and Aura answers.
 * What it cannot prove: that Meta accepts our traffic. Only #1 does that.
 *
 * Run (three terminals, or let --serve do the middle one):
 *   1. npx tsx scripts/load/meta-stub.ts
 *   2. a dev server started with WHATSAPP_GRAPH_BASE_URL pointing at the stub
 *   3. npx tsx scripts/demo-whatsapp-local.ts
 *
 * Useful flags:
 *   --say "write a linkedin post about our new release"   send one message
 *   --script          run the demo conversation from docs/WHATSAPP-DEMO.md
 *   --unlinked        send from an unknown number (shows the sign-in path)
 *   --keep            leave the seeded link in place for the next run
 */
import { db } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { signPayload, whatsAppConfig } from '@/lib/whatsapp';
import { waIdKey } from '@/server/whatsapp/whatsapp.service';

const APP = (process.env.DEMO_APP_URL ?? 'http://localhost:3003').replace(/\/$/, '');
const STUB = (process.env.STUB_URL ?? 'http://localhost:4010').replace(/\/$/, '');
/** The number that plays the part of the presenter's phone. */
const PHONE = process.env.DEMO_PHONE ?? '15550000001';
const PROFILE = process.env.DEMO_PROFILE ?? 'Demo phone';
const EMAIL = process.env.DEMO_EMAIL ?? 'demo@botella.ai';

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueOf = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
};

/** The conversation in docs/WHATSAPP-DEMO.md, in order. */
const SCRIPT = [
  'hi',
  'what is waiting on me?',
  'write a linkedin post about our new single barrel release',
  'show the draft',
];

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? 'ok    ' : 'BROKEN'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * An inbound message in exactly the shape Meta posts, signed with the app
 * secret the way Meta signs it. If the signature is wrong the webhook answers
 * 401 and stores nothing, so this is the part that proves the real check runs.
 */
function inboundBody(text: string, phoneNumberId: string, messageId: string) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'demo-waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: PHONE, phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: PROFILE }, wa_id: PHONE }],
              messages: [
                {
                  from: PHONE,
                  id: messageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

/** One outgoing WhatsApp message, in the shape the Cloud API takes. */
interface OutgoingBody {
  type?: string;
  text?: { body?: string };
  image?: { link?: string; caption?: string };
  interactive?: {
    body?: { text?: string };
    footer?: { text?: string };
    action?: {
      button?: string;
      buttons?: { reply?: { title?: string } }[];
      sections?: { rows?: { title?: string; description?: string }[] }[];
    };
  };
}

/**
 * A sent message as a human would read it.
 *
 * Aura's menus are real WhatsApp *interactive* messages — a body plus a list
 * of rows, which is what a phone renders as a tappable menu. Printing only
 * `text.body` showed them as "(interactive)", which hides the most convincing
 * part of the demo, so the rows are spelled out here as a phone would show
 * them.
 */
function readable(body: OutgoingBody | undefined): string {
  if (!body) return '(empty)';
  if (body.text?.body) return body.text.body;
  if (body.image) {
    return `[image] ${body.image.caption ?? body.image.link ?? ''}`.trim();
  }
  const i = body.interactive;
  if (i) {
    const rows = (i.action?.sections ?? [])
      .flatMap((s) => s.rows ?? [])
      .map((r) => `   • ${r.title}${r.description ? ` — ${r.description}` : ''}`);
    const buttons = (i.action?.buttons ?? [])
      .map((b) => `   [ ${b.reply?.title ?? ''} ]`)
      .filter((b) => b.trim() !== '[  ]');
    return [
      i.body?.text ?? '',
      rows.length ? `\n  ${i.action?.button ?? 'Menu'}:` : '',
      ...rows,
      ...buttons,
      i.footer?.text ? `\n  ${i.footer.text}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return `(${body.type ?? 'unknown'} message)`;
}

/** Everything the stub was asked to send to our number, newest last. */
async function sentToPhone(): Promise<string[]> {
  const res = await fetch(`${STUB}/sent?to=${PHONE}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return [];
  const { messages } = (await res.json()) as { messages: { body: OutgoingBody }[] };
  return messages.map((m) => readable(m.body));
}

/** Link our demo number to the demo user, so the assistant knows who it is. */
async function seedLink(): Promise<{ conversationId: string; cleanup: () => Promise<void> }> {
  const user = await db.user.findUnique({ where: { email: EMAIL } });
  if (!user) throw new Error(`No user ${EMAIL}. Run: pnpm db:seed:demo`);
  const membership = await db.companyMember.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });
  if (!membership) throw new Error(`${EMAIL} is not in a workspace. Run: pnpm db:seed:demo`);

  const waIdHash = waIdKey(PHONE);
  const conversation = await db.whatsAppConversation.upsert({
    where: { waIdHash },
    create: {
      waIdHash,
      waIdEncrypted: encrypt(PHONE),
      waIdLast4: PHONE.slice(-4),
      profileName: PROFILE,
      lastInboundAt: new Date(),
    },
    update: { lastInboundAt: new Date(), leaseUntil: null },
  });

  await db.whatsAppAccountLink.upsert({
    where: { conversationId: conversation.id },
    create: {
      conversationId: conversation.id,
      userId: user.id,
      activeCompanyId: membership.companyId,
      // Comfortably past the demo; a real link is issued by the sign-in flow.
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    },
    update: {
      userId: user.id,
      activeCompanyId: membership.companyId,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      revokedAt: null,
      revokedReason: null,
    },
  });

  return {
    conversationId: conversation.id,
    cleanup: async () => {
      await db.whatsAppConversation.delete({ where: { id: conversation.id } }).catch(() => {});
    },
  };
}

/** Kick the worker that drains the queue, the way the cron does. */
async function drain(): Promise<void> {
  const secret = process.env.CRON_SECRET;
  await fetch(`${APP}/api/cron/whatsapp`, {
    method: 'POST',
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    signal: AbortSignal.timeout(120_000),
  }).catch(() => {});
}

/** Send one message and wait for Aura's reply to reach the stub. */
async function say(text: string, phoneNumberId: string, secret: string): Promise<string[]> {
  const before = (await sentToPhone()).length;
  const body = inboundBody(text, phoneNumberId, `wamid.demo.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`);

  const res = await fetch(`${APP}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signPayload(body, secret),
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status !== 200) {
    throw new Error(`webhook answered ${res.status} — ${(await res.text()).slice(0, 160)}`);
  }

  // The webhook only queues; the worker does the slow part. Kick it, then wait
  // for a new reply to show up at the stub.
  const deadline = Date.now() + 150_000;
  let kicked = 0;
  while (Date.now() < deadline) {
    const now = await sentToPhone();
    if (now.length > before) return now.slice(before);
    // Re-kick occasionally: a job can be queued a moment after we asked.
    if (kicked % 6 === 0) await drain();
    kicked++;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return [];
}

async function main() {
  console.log('\nWhatsApp assistant — local loop (no Meta account, nothing leaves this machine)\n');

  console.log('1. The pieces');
  const config = whatsAppConfig();
  check('the four WHATSAPP_* values are set', config !== null,
    'set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN (any strings for this script)');
  if (!config) process.exit(1);

  const override = process.env.WHATSAPP_GRAPH_BASE_URL?.trim();
  check(`the app sends to the stub, not Meta (${override || 'NOT SET'})`, Boolean(override),
    'start the dev server with WHATSAPP_GRAPH_BASE_URL=http://localhost:4010');
  if (!override) process.exit(1);

  check(`the stub is up at ${STUB}`, await reachable(`${STUB}/stats`),
    'run: npx tsx scripts/load/meta-stub.ts');
  check(`Aura is up at ${APP}`, await reachable(`${APP}/api/auth/csrf`),
    `start a dev server on ${APP} with the WhatsApp env above`);
  if (failures) process.exit(1);

  // The handshake Meta performs before it will deliver anything.
  const token = encodeURIComponent(config.verifyToken);
  const handshake = await fetch(
    `${APP}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=demo-challenge-42`,
    { signal: AbortSignal.timeout(10_000) },
  );
  const echoed = handshake.ok ? (await handshake.text()).trim() : '';
  check('the webhook completes Meta’s verification handshake', echoed === 'demo-challenge-42',
    `got ${handshake.status} ${echoed.slice(0, 40)}`);

  const wrong = await fetch(
    `${APP}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=definitely-wrong&hub.challenge=x`,
    { signal: AbortSignal.timeout(10_000) },
  );
  check('and refuses the wrong verify token', wrong.status === 403, `got ${wrong.status}`);

  // An unsigned message must be rejected outright: this is the check that
  // stops anyone who finds the URL from talking to the assistant.
  const unsigned = await fetch(`${APP}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: inboundBody('hi', config.phoneNumberId, `wamid.unsigned.${Date.now()}`),
    signal: AbortSignal.timeout(10_000),
  });
  check('an unsigned message is refused (401) and nothing is stored', unsigned.status === 401,
    `got ${unsigned.status}`);

  console.log('\n2. Who is on the other end');
  let cleanup: (() => Promise<void>) | null = null;
  if (has('--unlinked')) {
    console.log(`  +${PHONE} is deliberately NOT linked — this shows the sign-in path.`);
  } else {
    const seeded = await seedLink();
    cleanup = has('--keep') ? null : seeded.cleanup;
    console.log(`  +${PHONE} linked to ${EMAIL}${has('--keep') ? ' (kept for next run)' : ''}`);
  }

  console.log('\n3. The conversation');
  const messages = has('--script')
    ? SCRIPT
    : [valueOf('--say') ?? 'hi'];

  try {
    for (const text of messages) {
      console.log(`\n  → you:  ${text}`);
      const replies = await say(text, config.phoneNumberId, config.appSecret);
      if (!replies.length) {
        check(`a reply to "${text.slice(0, 40)}"`, false, 'nothing reached the stub within 150s');
        continue;
      }
      for (const reply of replies) {
        const shown = reply.length > 700 ? `${reply.slice(0, 700)}\n         …` : reply;
        console.log(`  ← aura: ${shown.replace(/\n/g, '\n         ')}`);
      }
      check(`Aura answered "${text.slice(0, 40)}"`, true);
    }
  } finally {
    if (cleanup) await cleanup();
  }

  const stats = await fetch(`${STUB}/stats`).then((r) => r.json()).catch(() => null);
  if (stats) {
    console.log(`\n4. What the stub saw: ${stats.sends} sends, ${stats.rateLimited} rate-limited, ${stats.inboundAnsweredMoreThanOnce} answered twice`);
    check('no message was answered more than once', stats.inboundAnsweredMoreThanOnce === 0);
  }

  console.log(
    failures === 0
      ? '\nThe local WhatsApp loop works: signed inbound → queue → worker → agent → reply.\nThis does not prove Meta accepts our traffic. For that, use: npm run demo:whatsapp\n'
      : `\n${failures} check(s) failed.\n`,
  );
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\n✗', err instanceof Error ? err.message : String(err), '\n');
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
