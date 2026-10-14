/**
 * WhatsApp Assistant, Phase 1 — against the running app and the real
 * database. Webhooks are signed exactly as Meta signs them (HMAC-SHA256 of the
 * raw body with WHATSAPP_APP_SECRET) and posted to /api/webhooks/whatsapp.
 *
 *   Handshake   GET answers Meta's subscription check only with our token
 *   Signature   unsigned or wrongly signed POSTs are refused, nothing stored
 *   Queue       the webhook acknowledges at once; the answer follows from the
 *               queue (waitUntil), and the job finishes
 *   Inbound     a message is stored once, the number encrypted, and answered
 *               (the reply really goes to Meta's Cloud API: with real
 *               credentials it is SENT; without, Meta's refusal is recorded)
 *   Dedupe      a redelivered webhook is recognised; no second reply
 *   Statuses    delivery statuses move forward, never back
 *   Opt-out     STOP is recorded; later messages are stored but not answered
 *
 * Run (app running with the same WHATSAPP_* values):
 *   VERIFY_BASE_URL=http://localhost:3001 pnpm verify:whatsapp
 * Set VERIFY_WHATSAPP_FROM to a real test number to receive the reply on a
 * phone (it must be allowed on the Meta app while in development mode).
 */
import { db } from '@/lib/db';
import { decrypt, keyedHash } from '@/lib/crypto';
import { signPayload } from '@/lib/whatsapp';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const SECRET = process.env.WHATSAPP_APP_SECRET ?? '';
const VERIFY = process.env.WHATSAPP_VERIFY_TOKEN ?? '';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const STAMP = Date.now();
// 555-01xx numbers are reserved for fiction; nothing real receives them.
const FROM = (process.env.VERIFY_WHATSAPP_FROM ?? `1555010${String(STAMP).slice(-4)}`).replace(/\D/g, '');

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function messageWebhook(wamid: string, text: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: PHONE_ID },
              contacts: [{ profile: { name: 'Verify Script' }, wa_id: FROM }],
              messages: [
                { from: FROM, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusWebhook(wamid: string, status: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: PHONE_ID },
              statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: FROM }],
            },
          },
        ],
      },
    ],
  };
}

async function post(body: unknown, signature: string | null = 'sign') {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature === 'sign') headers['x-hub-signature-256'] = signPayload(raw, SECRET);
  else if (signature) headers['x-hub-signature-256'] = signature;
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/webhooks/whatsapp`, { method: 'POST', headers, body: raw });
  const ms = Date.now() - t0;
  return { status: res.status, ms, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** The answer comes from the queue, after the response: wait for it. */
async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let v = await read();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 250));
    v = await read();
  }
  return v;
}

async function main() {
  if (!SECRET || !VERIFY || !PHONE_ID) {
    console.error('Set WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN and WHATSAPP_PHONE_NUMBER_ID (the same values the app runs with).');
    process.exit(2);
  }
  const waIdHash = keyedHash(FROM, 'whatsapp-wa-id');
  const conversation = () =>
    db.whatsAppConversation.findUnique({ where: { waIdHash }, include: { messages: { orderBy: { createdAt: 'asc' } } } });

  try {
    console.log('Handshake');
    const ok = await fetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY)}&hub.challenge=${STAMP}`);
    check('GET with our verify token echoes the challenge', ok.status === 200 && (await ok.text()) === String(STAMP));
    const bad = await fetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1`);
    check('GET with any other token is refused', bad.status === 403, `HTTP ${bad.status}`);

    console.log('Signature');
    const wamid = `wamid.VERIFY${STAMP}`;
    const unsigned = await post(messageWebhook(wamid, 'hello'), null);
    const forged = await post(messageWebhook(wamid, 'hello'), signPayload('{}', 'not-the-secret'));
    check('unsigned and forged POSTs are refused (401)', unsigned.status === 401 && forged.status === 401, `${unsigned.status}/${forged.status}`);
    check('nothing was stored for them', !(await conversation()));

    console.log('Queue');
    // Warm the route once so the timing below is not the dev server compiling it.
    await post({ object: 'whatsapp_business_account', entry: [] });
    const first = await post(messageWebhook(wamid, 'What time does ABC Store open?'));
    check('a signed message is accepted (200)', first.status === 200, JSON.stringify(first.json));
    check('it is stored and queued', first.json.received === 1 && first.json.queued === 1, JSON.stringify(first.json));
    check(`Meta is acknowledged without waiting for the answer (${first.ms} ms)`, first.ms < 2000, `${first.ms} ms`);
    let conv = await waitFor(conversation, (c) => Boolean(c?.messages.some((m) => m.direction === 'OUTBOUND' && m.status !== 'PENDING')));
    const job = await db.whatsAppJob.findFirst({ where: { message: { wamid } } });
    check('the queued job finished', job?.status === 'DONE', `${job?.status} ${job?.lastError ?? ''}`);
    check('the conversation lease was released', conv?.leaseUntil === null);

    console.log('Inbound');
    check('one conversation, looked up by keyed hash', Boolean(conv));
    check(
      'the number is stored encrypted, only the last four in clear',
      Boolean(conv) && !conv!.waIdEncrypted.includes(FROM) && decrypt(conv!.waIdEncrypted) === FROM && conv!.waIdLast4 === FROM.slice(-4),
    );
    const inMsg = conv?.messages.find((m) => m.direction === 'INBOUND');
    check('the message is stored with its text', inMsg?.wamid === wamid && inMsg.body === 'What time does ABC Store open?');
    const reply = conv?.messages.find((m) => m.direction === 'OUTBOUND');
    check('a reply was created, threaded to their message', reply?.replyToId === inMsg?.id);
    if (reply?.status === 'SENT') {
      check('Meta accepted the reply (real credentials)', Boolean(reply.wamid), reply.wamid ?? '');
    } else {
      check(
        'Meta’s answer is recorded on the reply (no live credentials here)',
        Boolean(reply?.errorCode) && (reply?.status === 'FAILED' || reply?.status === 'PENDING'),
        `${reply?.status} ${reply?.errorCode} ${reply?.errorMessage}`,
      );
      console.log(`          Meta said: [${reply?.errorCode}] ${reply?.errorMessage} → ${reply?.status}`);
    }

    console.log('Dedupe');
    const again = await post(messageWebhook(wamid, 'What time does ABC Store open?'));
    check('a redelivery is recognised as a duplicate', again.json.duplicates === 1 && again.json.received === 0, JSON.stringify(again.json));
    conv = await conversation();
    check('still one inbound message and one reply', conv!.messages.filter((m) => m.direction === 'INBOUND').length === 1 && conv!.messages.filter((m) => m.direction === 'OUTBOUND').length === 1);

    console.log('Statuses');
    // A reply Meta accepted, so statuses have something to land on (works
    // with or without live credentials).
    const outWamid = reply?.wamid ?? `wamid.OUTVERIFY${STAMP}`;
    if (!reply?.wamid) {
      await db.whatsAppMessage.create({
        data: { conversationId: conv!.id, direction: 'OUTBOUND', type: 'text', body: 'status probe', status: 'SENT', wamid: outWamid, sentAt: new Date() },
      });
    }
    await post(statusWebhook(outWamid, 'read'));
    await post(statusWebhook(outWamid, 'delivered'));
    const probed = await db.whatsAppMessage.findUnique({ where: { wamid: outWamid } });
    check('read then a late "delivered": stays READ, both times recorded', probed?.status === 'READ' && Boolean(probed.readAt) && Boolean(probed.deliveredAt), probed?.status);

    console.log('Opt-out');
    await post(messageWebhook(`wamid.VERIFYSTOP${STAMP}`, 'STOP'));
    conv = await waitFor(conversation, (c) => c?.optedOut === true);
    check('STOP is recorded on the conversation', conv?.optedOut === true);
    // Count only once STOP is fully handled (its confirmation is sent after
    // the opt-out is recorded).
    await waitFor(
      () => db.whatsAppJob.findFirst({ where: { message: { wamid: `wamid.VERIFYSTOP${STAMP}` } } }),
      (j) => j?.status === 'DONE',
    );
    conv = await conversation();
    const before = conv!.messages.filter((m) => m.direction === 'OUTBOUND').length;
    await post(messageWebhook(`wamid.VERIFYAFTER${STAMP}`, 'are you there?'));
    await waitFor(
      () => db.whatsAppJob.findFirst({ where: { message: { wamid: `wamid.VERIFYAFTER${STAMP}` } } }),
      (j) => j?.status === 'DONE',
    );
    conv = await conversation();
    check('a later message is stored', conv!.messages.some((m) => m.wamid === `wamid.VERIFYAFTER${STAMP}`));
    check('but not answered', conv!.messages.filter((m) => m.direction === 'OUTBOUND').length === before);
    const audits = await db.auditLog.findMany({ where: { action: 'WHATSAPP_OPTED_OUT', metadata: { path: ['conversationId'], equals: conv!.id } } });
    check('the opt-out is audited', audits.length === 1);
  } finally {
    const conv = await db.whatsAppConversation.findUnique({ where: { waIdHash } });
    if (conv) {
      await db.auditLog.deleteMany({ where: { metadata: { path: ['conversationId'], equals: conv.id } } });
      await db.whatsAppConversation.delete({ where: { id: conv.id } }); // messages cascade
      console.log('  ok      cleanup: test conversation, messages and audit entries removed');
    }
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll WhatsApp checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
