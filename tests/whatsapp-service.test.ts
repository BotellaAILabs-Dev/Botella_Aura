import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * WhatsApp Assistant — the server side, with Prisma replaced by an in-memory
 * store (unique keys enforced, as Postgres does) and Meta's API by a
 * recording fake. Covers the Cloud API client, storage and deduplication, the
 * queue (ordering, leases, retries, dead letters, recovery, concurrency),
 * replies, the 24-hour window, opt-out, statuses, send retries, interactive
 * and image messages, and the webhook route.
 */

vi.mock('@/lib/db', async () => ({ db: (await import('./fixtures/whatsapp-db')).db }));

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
process.env.APP_URL = 'https://aura.example';

import { signPayload, type WhatsAppConfig, parseWebhook } from '@/lib/whatsapp';
import { decrypt } from '@/lib/crypto';
import { sendTextMessage, WhatsAppApiError } from '@/server/whatsapp/client';
import {
  MAX_ATTEMPTS,
  processWebhook,
  retryDueMessages,
  sendContent,
  sendText,
} from '@/server/whatsapp/whatsapp.service';
import {
  drainConversation,
  drainConversations,
  MAX_JOB_ATTEMPTS,
  STALE_RUNNING_MS,
  sweepQueue,
} from '@/server/whatsapp/queue';
import { FALLBACK_TEXT } from '@/server/whatsapp/handler';
import { OPT_IN_TEXT, OPT_OUT_TEXT, WELCOME_TEXT } from '@/server/whatsapp/agent';
import { resetStore, store } from './fixtures/whatsapp-db';
import { PHONE_ID, SECRET, textWebhook } from './fixtures/whatsapp';

const config: WhatsAppConfig = {
  accessToken: 'EAAG-test-token',
  phoneNumberId: PHONE_ID,
  appSecret: SECRET,
  verifyToken: 'verify-me',
  apiVersion: 'v23.0',
};

interface Call {
  url: string;
  auth: string | null;
  body: any;
}

/** A fake Graph API: records calls and answers with what each test queues. */
function fakeMeta(responses: Array<{ status: number; body: any } | 'network'> = []) {
  const calls: Call[] = [];
  let n = 0;
  const impl = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), auth: init.headers.Authorization ?? null, body });
    // Read receipts always succeed and do not consume a queued response.
    if (body.status === 'read') return new Response(JSON.stringify({ success: true }), { status: 200 });
    const next = responses.shift() ?? { status: 200, body: { messages: [{ id: `wamid.OUT${++n}` }] } };
    if (next === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { impl, calls, sends: () => calls.filter((c) => c.body.type && c.body.type !== undefined && !c.body.status) };
}

/** What a webhook delivery does end to end: store, then the kick drains. */
async function deliver(body: unknown, meta: ReturnType<typeof fakeMeta>) {
  const r = await processWebhook(parseWebhook(body, PHONE_ID));
  const drains = await drainConversations({ config, conversationIds: r.conversationIds, fetchImpl: meta.impl });
  return { ...r, drains };
}

const outbound = () => store.messages.filter((m) => m.direction === 'OUTBOUND');
const inbound = () => store.messages.filter((m) => m.direction === 'INBOUND');
const texts = (meta: ReturnType<typeof fakeMeta>) =>
  meta.sends().map((c) => c.body.text?.body ?? c.body.interactive?.body?.text);

beforeEach(() => resetStore());

describe('Cloud API client', () => {
  it('sends a text through the official endpoint with the bearer token', async () => {
    const meta = fakeMeta([{ status: 200, body: { messages: [{ id: 'wamid.X' }] } }]);
    const id = await sendTextMessage(config, '919876543210', 'Hello', { replyTo: 'wamid.IN', fetchImpl: meta.impl });
    expect(id).toBe('wamid.X');
    expect(meta.calls[0]!.url).toBe(`https://graph.facebook.com/v23.0/${PHONE_ID}/messages`);
    expect(meta.calls[0]!.auth).toBe('Bearer EAAG-test-token');
    expect(meta.calls[0]!.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'text',
      text: { preview_url: false, body: 'Hello' },
      context: { message_id: 'wamid.IN' },
    });
  });

  it('classifies errors: rate limits, 5xx and network are retryable; a closed window is not', async () => {
    const cases: Array<[any, boolean, string]> = [
      [{ status: 400, body: { error: { code: 130429, message: 'Rate limit hit' } } }, true, '130429'],
      [{ status: 429, body: {} }, true, '429'],
      [{ status: 503, body: {} }, true, '503'],
      ['network', true, 'network'],
      [{ status: 400, body: { error: { code: 131047, message: 'Re-engagement' } } }, false, '131047'],
      [{ status: 401, body: { error: { code: 190, message: 'Invalid OAuth access token' } } }, false, '190'],
    ];
    for (const [response, retryable, code] of cases) {
      const meta = fakeMeta([response]);
      const err = await sendTextMessage(config, '1234567', 'x', { fetchImpl: meta.impl }).catch((e) => e);
      expect(err).toBeInstanceOf(WhatsAppApiError);
      expect([err.code, err.retryable]).toEqual([code, retryable]);
    }
  });

  it('never puts the access token in an error message', async () => {
    const meta = fakeMeta([{ status: 401, body: { error: { code: 190, message: 'bad token EAAG-test-token' } } }]);
    const err = await sendTextMessage(config, '1234567', 'x', { fetchImpl: meta.impl }).catch((e) => e);
    expect(err.message).not.toContain('EAAG-test-token');
    const echo = fakeMeta([{ status: 400, body: { error: { code: 999, message: 'token EAAG-test-token rejected' } } }]);
    const err2 = await sendTextMessage(config, '1234567', 'x', { fetchImpl: echo.impl }).catch((e) => e);
    expect(err2.message).toBe('token [redacted] rejected');
  });
});

describe('storing incoming messages', () => {
  it('stores the message and its job — nothing is sent by the webhook itself', async () => {
    const meta = fakeMeta();
    const r = await processWebhook(parseWebhook(textWebhook(), PHONE_ID));
    expect(r).toMatchObject({ received: 1, duplicates: 0, statuses: 0 });
    expect(r.conversationIds).toHaveLength(1);
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]).toMatchObject({ status: 'QUEUED', messageId: inbound()[0].id });
    expect(meta.calls).toHaveLength(0);

    const conv = store.conversations[0];
    expect(conv.waIdLast4).toBe('3210');
    expect(conv.waIdEncrypted).not.toContain('919876543210');
    expect(decrypt(conv.waIdEncrypted)).toBe('919876543210');
    expect(conv.waIdHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records the id of a menu option someone tapped', async () => {
    const body = textWebhook();
    (body.entry[0]!.changes[0]!.value as any).messages = [
      { from: '919876543210', id: 'w1', timestamp: '1', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'menu.content', title: 'Content Studio' } } },
    ];
    await processWebhook(parseWebhook(body, PHONE_ID));
    expect(inbound()[0]).toMatchObject({ body: 'Content Studio', payload: { replyId: 'menu.content' } });
  });

  it('a webhook Meta delivers twice is stored, queued and answered once', async () => {
    const meta = fakeMeta();
    await deliver(textWebhook(), meta);
    const again = await deliver(textWebhook(), meta);
    expect(again).toMatchObject({ received: 0, duplicates: 1, conversationIds: [] });
    expect(inbound()).toHaveLength(1);
    expect(store.jobs).toHaveLength(1);
    expect(meta.sends()).toHaveLength(1);
  });

  it('two concurrent deliveries of the same message: one stored, one job, one answer', async () => {
    const meta = fakeMeta();
    const [a, b] = await Promise.all([deliver(textWebhook(), meta), deliver(textWebhook(), meta)]);
    expect(a.received + b.received).toBe(1);
    expect(a.duplicates + b.duplicates).toBe(1);
    expect(inbound()).toHaveLength(1);
    expect(store.jobs).toHaveLength(1);
    expect(meta.sends()).toHaveLength(1);
  });
});

describe('answering (the queue)', () => {
  it('answers, threaded to their message, marks it read, and finishes the job', async () => {
    const meta = fakeMeta();
    await deliver(textWebhook(), meta);
    expect(outbound()[0]).toMatchObject({ status: 'SENT', wamid: 'wamid.OUT1', replyToId: inbound()[0].id });
    expect(meta.sends()[0]!.body.context).toEqual({ message_id: 'wamid.IN1' });
    expect(meta.calls.some((c) => c.body.status === 'read' && c.body.message_id === 'wamid.IN1')).toBe(true);
    expect(store.jobs[0]).toMatchObject({ status: 'DONE', attempts: 1 });
    expect(store.conversations[0].leaseUntil).toBeNull();
  });

  it('one person’s messages are answered in the order they were sent', async () => {
    const meta = fakeMeta();
    const order: string[] = [];
    for (const [w, t] of [['w1', 'first'], ['w2', 'second'], ['w3', 'third']]) {
      await processWebhook(parseWebhook(textWebhook({ wamid: w, text: t }), PHONE_ID));
    }
    await drainConversation({
      config,
      conversationId: store.conversations[0].id,
      fetchImpl: meta.impl,
      handler: async ({ messageId }) => {
        order.push(store.messages.find((m) => m.id === messageId).body);
        return 'answered';
      },
    });
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('two workers on one conversation: only one holds it; nothing is handled twice', async () => {
    const meta = fakeMeta();
    for (const w of ['w1', 'w2', 'w3']) await processWebhook(parseWebhook(textWebhook({ wamid: w }), PHONE_ID));
    const handled: string[] = [];
    const handler = async ({ messageId }: { messageId: string }) => {
      handled.push(messageId);
      await new Promise((r) => setTimeout(r, 5));
      return 'answered' as const;
    };
    const id = store.conversations[0].id;
    const [a, b] = await Promise.all([
      drainConversation({ config, conversationId: id, handler, fetchImpl: meta.impl }),
      drainConversation({ config, conversationId: id, handler, fetchImpl: meta.impl }),
    ]);
    expect([a.leased, b.leased].filter(Boolean)).toHaveLength(1);
    expect(handled).toHaveLength(3);
    expect(new Set(handled).size).toBe(3);
  });

  it('200 people at once: every reply goes to the right person, nothing mixed up', async () => {
    const meta = fakeMeta();
    const people = Array.from({ length: 200 }, (_, i) => `4477009${String(i).padStart(5, '0')}`);
    await Promise.all(
      people.map((from, i) => deliver(textWebhook({ wamid: `w${i}`, from, name: `P${i}` }), meta)),
    );
    expect(store.conversations).toHaveLength(200);
    expect(store.jobs.every((j) => j.status === 'DONE')).toBe(true);
    // Each reply went to the number of the person whose message it answers.
    for (const reply of outbound()) {
      const asked = store.messages.find((m) => m.id === reply.replyToId);
      const conv = store.conversations.find((c) => c.id === asked.conversationId);
      expect(reply.conversationId).toBe(conv.id);
    }
    const sentTo = meta.sends().map((c) => c.body.to).sort();
    expect(sentTo).toEqual([...people].sort());
  });

  it('one process works on at most 48 conversations at once; the rest wait their turn, none dropped', async () => {
    const meta = fakeMeta();
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const r = await processWebhook(parseWebhook(textWebhook({ wamid: `c${i}`, from: `4477009${String(i).padStart(5, '0')}` }), PHONE_ID));
      ids.push(...r.conversationIds);
    }
    let now = 0;
    let max = 0;
    const handler = async () => {
      max = Math.max(max, ++now);
      await new Promise((r) => setTimeout(r, 5));
      now--;
      return 'answered' as const;
    };
    const results = await drainConversations({ config, conversationIds: ids, handler, fetchImpl: meta.impl });
    expect(max).toBeLessThanOrEqual(48);
    expect(max).toBeGreaterThan(1);
    expect(results.filter((r) => r.done === 1)).toHaveLength(100);
  });

  it('a failed job backs off and holds the messages behind it; then both are answered in order', async () => {
    const meta = fakeMeta();
    for (const [w, t] of [['w1', 'first'], ['w2', 'second']]) {
      await processWebhook(parseWebhook(textWebhook({ wamid: w, text: t }), PHONE_ID));
    }
    let failOnce = true;
    const order: string[] = [];
    const handler = async ({ messageId }: { messageId: string }) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('database blip');
      }
      order.push(store.messages.find((m) => m.id === messageId).body);
      return 'answered' as const;
    };
    const id = store.conversations[0].id;
    const r = await drainConversation({ config, conversationId: id, handler, fetchImpl: meta.impl });
    expect(r).toMatchObject({ retried: 1, done: 0 });
    expect(store.jobs.map((j) => j.status)).toEqual(['QUEUED', 'QUEUED']);
    expect(store.jobs[0].lastError).toBe('database blip');

    // Not due yet: the sweep leaves it.
    expect((await sweepQueue({ config, handler, fetchImpl: meta.impl })).done).toBe(0);
    // Due: both answered, oldest first.
    const later = () => new Date(Date.now() + 60_000);
    const s = await sweepQueue({ config, handler, fetchImpl: meta.impl, now: later });
    expect(s.done).toBe(2);
    expect(order).toEqual(['first', 'second']);
  });

  it('after the last attempt a job is dead-lettered, the person gets an apology, and the queue moves on', async () => {
    const meta = fakeMeta();
    for (const w of ['w1', 'w2']) await processWebhook(parseWebhook(textWebhook({ wamid: w }), PHONE_ID));
    const handler = async ({ messageId }: { messageId: string }) => {
      if (store.messages.find((m) => m.id === messageId).wamid === 'w1') throw new Error('always broken');
      return 'answered' as const;
    };
    let t = Date.now();
    for (let i = 0; i < MAX_JOB_ATTEMPTS + 1; i++) {
      t += 10 * 60_000;
      const at = new Date(t);
      await sweepQueue({ config, handler, fetchImpl: meta.impl, now: () => at });
    }
    expect(store.jobs[0]).toMatchObject({ status: 'DEAD', attempts: MAX_JOB_ATTEMPTS, lastError: 'always broken' });
    expect(store.jobs[1].status).toBe('DONE');
    expect(texts(meta)).toContain(FALLBACK_TEXT);
  });

  it('a job left RUNNING by a worker that died is retried by the sweep', async () => {
    const meta = fakeMeta();
    await processWebhook(parseWebhook(textWebhook(), PHONE_ID));
    Object.assign(store.jobs[0], { status: 'RUNNING', attempts: 1, startedAt: new Date(Date.now() - STALE_RUNNING_MS - 1000) });
    store.conversations[0].leaseUntil = new Date(Date.now() - 1000); // its lease ran out
    const s = await sweepQueue({ config, fetchImpl: meta.impl });
    expect(s.done).toBe(1);
    expect(store.jobs[0]).toMatchObject({ status: 'DONE', attempts: 2 });
    expect(meta.sends()).toHaveLength(1);
  });

  it('a retried job that had already replied does not reply again', async () => {
    const meta = fakeMeta();
    await deliver(textWebhook(), meta);
    Object.assign(store.jobs[0], { status: 'QUEUED' });
    await drainConversation({ config, conversationId: store.conversations[0].id, fetchImpl: meta.impl });
    expect(meta.sends()).toHaveLength(1);
  });

  it('someone not signed in gets the welcome and a sign-in button — never a password prompt', async () => {
    const meta = fakeMeta();
    await deliver(textWebhook({ text: 'Hi' }), meta);
    const call = meta.sends()[0]!;
    expect(call.body.interactive.type).toBe('cta_url');
    expect(call.body.interactive.body.text.startsWith(WELCOME_TEXT)).toBe(true);
    expect(call.body.interactive.action.parameters.display_text).toBe('Log in to Aura');
    expect(call.body.interactive.action.parameters.url).toMatch(/^https:\/\/aura\.example\/whatsapp\/link\/[A-Za-z0-9_-]{43}$/);
    // The stored history keeps the message, not the single-use link.
    expect(outbound()[0].body).not.toContain('/whatsapp/link/');
  });
});

describe('opt-out (Meta policy)', () => {
  it('STOP is recorded, confirmed once, audited; later messages get no reply until START', async () => {
    const meta = fakeMeta();
    await deliver(textWebhook({ wamid: 'w1', text: 'STOP' }), meta);
    expect(store.conversations[0].optedOut).toBe(true);
    expect(texts(meta)).toEqual([OPT_OUT_TEXT]);
    expect(store.audits.map((a) => a.action)).toContain('WHATSAPP_OPTED_OUT');

    await deliver(textWebhook({ wamid: 'w2', text: 'hello?' }), meta);
    expect(meta.sends()).toHaveLength(1);
    expect(inbound()).toHaveLength(2);

    await deliver(textWebhook({ wamid: 'w3', text: 'START' }), meta);
    expect(store.conversations[0].optedOut).toBe(false);
    expect(meta.sends()).toHaveLength(2);
    expect(texts(meta)[1]).toBe(OPT_IN_TEXT);
    expect(store.audits.map((a) => a.action)).toContain('WHATSAPP_OPTED_IN');
  });
});

describe('the 24-hour window', () => {
  it('no free-form message outside it, and nothing is stored or sent', async () => {
    const meta = fakeMeta();
    await deliver(textWebhook(), meta);
    const conv = { ...store.conversations[0] };
    const later = new Date(conv.lastInboundAt.getTime() + 25 * 60 * 60 * 1000);
    const r = await sendText({ config, conversation: conv, text: 'A new offer!', fetchImpl: meta.impl, now: later });
    expect(r.status).toBe('failed');
    expect(meta.sends()).toHaveLength(1);
    expect(outbound()).toHaveLength(1);
  });

  it('an old message delivered late does not reopen the window', async () => {
    const meta = fakeMeta();
    const now = Math.floor(Date.now() / 1000);
    await deliver(textWebhook({ wamid: 'w1', timestamp: now }), meta);
    await deliver(textWebhook({ wamid: 'w0', timestamp: now - 3600 }), meta);
    expect(store.conversations[0].lastInboundAt.getTime()).toBe(now * 1000);
  });
});

describe('interactive menus and images', () => {
  async function conversation(meta: ReturnType<typeof fakeMeta>) {
    await deliver(textWebhook(), meta);
    return { ...store.conversations[0] };
  }

  it('a button menu is sent in the Cloud API’s shape and stored for an exact retry', async () => {
    const meta = fakeMeta();
    const conv = await conversation(meta);
    await sendContent({
      config,
      conversation: conv,
      content: { kind: 'buttons', body: 'What next?', buttons: [{ id: 'a', title: 'Content Studio' }, { id: 'b', title: 'Campaigns' }] },
      fetchImpl: meta.impl,
    });
    const call = meta.sends().at(-1)!;
    expect(call.body).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'What next?' },
        action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'Content Studio' } }, { type: 'reply', reply: { id: 'b', title: 'Campaigns' } }] },
      },
    });
    expect(outbound().at(-1)).toMatchObject({ type: 'interactive', payload: { kind: 'buttons' }, status: 'SENT' });
    expect(outbound().at(-1).body).toBe('What next?\n[Content Studio] [Campaigns]');
  });

  it('an image is sent with a signed link — a fresh one on every attempt', async () => {
    const meta = fakeMeta([{ status: 503, body: {} }]);
    await deliver(textWebhook(), meta); // consumes nothing: the 503 is for the image below
    meta.calls.length = 0;
    const conv = { ...store.conversations[0] };
    const first = await sendContent({ config, conversation: conv, content: { kind: 'image', assetId: 'asset_1', caption: 'Your post' }, fetchImpl: meta.impl });
    // The greeting reply took the queued 503; the image went out on its first try.
    const sends = meta.sends();
    const imageCalls = sends.filter((c) => c.body.type === 'image');
    expect(imageCalls.length).toBeGreaterThan(0);
    const link = imageCalls[0]!.body.image.link as string;
    expect(link).toMatch(/^https:\/\/aura\.example\/api\/content\/graphics\/asset_1\/file\?exp=\d+&sig=/);
    expect(imageCalls[0]!.body.image.caption).toBe('Your post');
    expect(outbound().find((m) => m.id === first.messageId)).toMatchObject({ type: 'image', payload: { kind: 'image', assetId: 'asset_1' } });
  });

  it('a retried image is re-signed, not re-sent with the old link', async () => {
    const meta = fakeMeta();
    await deliver(textWebhook(), meta);
    const conv = { ...store.conversations[0] };
    const failing = fakeMeta([{ status: 503, body: {} }]);
    const r = await sendContent({ config, conversation: conv, content: { kind: 'image', assetId: 'asset_9' }, fetchImpl: failing.impl });
    expect(r.status).toBe('scheduled');
    const due = new Date(outbound().find((m) => m.id === r.messageId).nextAttemptAt.getTime() + 60_000 * 20);
    const retry = fakeMeta();
    // The retry happens later — the real clock too, as it would in production.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(due);
    try {
      await retryDueMessages({ config, fetchImpl: retry.impl, now: due });
    } finally {
      vi.useRealTimers();
    }
    const [firstLink, secondLink] = [failing.sends()[0]!.body.image.link, retry.sends()[0]!.body.image.link];
    expect(firstLink).not.toBe(secondLink);
    expect(Number(new URL(secondLink).searchParams.get('exp'))).toBeGreaterThan(Number(new URL(firstLink).searchParams.get('exp')));
  });

  it('content that cannot be sent is refused before anything is stored', async () => {
    const meta = fakeMeta();
    const conv = await conversation(meta);
    const before = outbound().length;
    await expect(
      sendContent({ config, conversation: conv, content: { kind: 'buttons', body: 'x', buttons: [] }, fetchImpl: meta.impl }),
    ).rejects.toThrow(/at least one button/);
    expect(outbound()).toHaveLength(before);
  });
});

describe('delivery statuses', () => {
  const statusWebhook = (wamid: string, status: string, extra: any = {}) => ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, statuses: [{ id: wamid, status, timestamp: '1760000000', ...extra }] } }] }],
  });

  it('moves forward, never back; unknown messages are ignored', async () => {
    const meta = fakeMeta();
    await deliver(textWebhook(), meta);
    await processWebhook(parseWebhook(statusWebhook('wamid.OUT1', 'read'), PHONE_ID));
    await processWebhook(parseWebhook(statusWebhook('wamid.OUT1', 'delivered'), PHONE_ID));
    expect(outbound()[0]).toMatchObject({ status: 'READ' });
    expect(outbound()[0].readAt).toBeInstanceOf(Date);
    expect(outbound()[0].deliveredAt).toBeInstanceOf(Date);
    const r = await processWebhook(parseWebhook(statusWebhook('wamid.NOPE', 'delivered'), PHONE_ID));
    expect(r.statuses).toBe(0);
  });

  it('a delivery failure is recorded with Meta’s reason and audited', async () => {
    const meta = fakeMeta();
    await deliver(textWebhook(), meta);
    await processWebhook(
      parseWebhook(statusWebhook('wamid.OUT1', 'failed', { errors: [{ code: 131026, title: 'Undeliverable' }] }), PHONE_ID),
    );
    expect(outbound()[0]).toMatchObject({ status: 'FAILED', errorCode: '131026', errorMessage: 'Undeliverable' });
    expect(store.audits.some((a) => a.action === 'WHATSAPP_SEND_FAILED')).toBe(true);
  });
});

describe('send retries', () => {
  beforeEach(() => {
    process.env.WHATSAPP_QUICK_RETRY_MS = '1';
  });

  it('a throttled send (Meta 130429) is retried once at once — usually that is enough', async () => {
    const meta = fakeMeta([{ status: 400, body: { error: { code: 130429 } } }]);
    await deliver(textWebhook(), meta);
    expect(outbound()[0]).toMatchObject({ status: 'SENT', attempts: 1 });
    expect(meta.sends()).toHaveLength(2);
  });

  it('still throttled: scheduled, then sent by the sweep, still threaded', async () => {
    const meta = fakeMeta([
      { status: 400, body: { error: { code: 130429 } } },
      { status: 400, body: { error: { code: 130429 } } },
    ]);
    await deliver(textWebhook(), meta);
    const m = outbound()[0];
    expect(m).toMatchObject({ status: 'PENDING', attempts: 1, errorCode: '130429' });
    expect(store.jobs[0].status).toBe('DONE'); // answered; the send is retried separately
    expect(await retryDueMessages({ config, fetchImpl: meta.impl })).toEqual({ sent: 0, scheduled: 0, failed: 0 });
    const later = new Date(m.nextAttemptAt.getTime() + 1000);
    expect(await retryDueMessages({ config, fetchImpl: meta.impl, now: later })).toEqual({ sent: 1, scheduled: 0, failed: 0 });
    expect(outbound()[0]).toMatchObject({ status: 'SENT', attempts: 2, errorCode: null });
    expect(meta.sends()[2]!.body.context).toEqual({ message_id: 'wamid.IN1' });
  });

  it('a non-throttle failure is not retried at once', async () => {
    const meta = fakeMeta([{ status: 503, body: {} }]);
    await deliver(textWebhook(), meta);
    expect(outbound()[0]).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(meta.sends()).toHaveLength(1);
  });

  it('a final failure is not retried, and is audited', async () => {
    const meta = fakeMeta([{ status: 401, body: { error: { code: 190 } } }]);
    await deliver(textWebhook(), meta);
    expect(outbound()[0]).toMatchObject({ status: 'FAILED', errorCode: '190', nextAttemptAt: null });
    expect(store.audits.some((a) => a.action === 'WHATSAPP_SEND_FAILED')).toBe(true);
  });

  it('gives up after the attempt budget', async () => {
    const meta = fakeMeta(Array.from({ length: 10 }, () => ({ status: 503, body: {} })));
    await deliver(textWebhook(), meta);
    let t = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      t += 4 * 60 * 60 * 1000;
      await retryDueMessages({ config, fetchImpl: meta.impl, now: new Date(Math.min(t, store.conversations[0].lastInboundAt.getTime() + 23 * 3600_000)) });
    }
    expect(outbound()[0].attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
    expect(outbound()[0].status).toBe('FAILED');
  });

  it('a message whose window closed is failed, not sent', async () => {
    const meta = fakeMeta([{ status: 503, body: {} }]);
    await deliver(textWebhook(), meta);
    const late = new Date(store.conversations[0].lastInboundAt.getTime() + 25 * 3600_000);
    expect(await retryDueMessages({ config, fetchImpl: meta.impl, now: late })).toEqual({ sent: 0, scheduled: 0, failed: 1 });
    expect(outbound()[0]).toMatchObject({ status: 'FAILED', errorCode: 'blocked' });
    expect(meta.sends()).toHaveLength(1);
  });

  it('two sweeps at once send a due message only once', async () => {
    const meta = fakeMeta([{ status: 503, body: {} }]);
    await deliver(textWebhook(), meta);
    const later = new Date(outbound()[0].nextAttemptAt.getTime() + 1000);
    const [a, b] = await Promise.all([
      retryDueMessages({ config, fetchImpl: meta.impl, now: later }),
      retryDueMessages({ config, fetchImpl: meta.impl, now: later }),
    ]);
    expect(a.sent + b.sent).toBe(1);
    expect(meta.sends()).toHaveLength(2);
  });
});

describe('routes', () => {
  const env = {
    WHATSAPP_ACCESS_TOKEN: config.accessToken,
    WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
    WHATSAPP_APP_SECRET: SECRET,
    WHATSAPP_VERIFY_TOKEN: 'verify-me',
    CRON_SECRET: 'cron-secret',
  };
  async function webhook() {
    Object.assign(process.env, env);
    return import('@/app/api/webhooks/whatsapp/route');
  }
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('GET answers Meta’s handshake only with our verify token', async () => {
    const { GET } = await webhook();
    const ok = await GET(new Request('http://x/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42'));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('42');
    const bad = await GET(new Request('http://x/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=42'));
    expect(bad.status).toBe(403);
  });

  it('POST rejects an unsigned or wrongly signed body before storing anything', async () => {
    const { POST } = await webhook();
    const raw = JSON.stringify(textWebhook());
    const none = await POST(new Request('http://x', { method: 'POST', body: raw }));
    const wrong = await POST(
      new Request('http://x', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': signPayload(raw, 'not-the-secret') } }),
    );
    expect([none.status, wrong.status]).toEqual([401, 401]);
    expect(store.messages).toHaveLength(0);
  });

  it('POST acknowledges once stored; the answer follows after the response; a redelivery is a duplicate', async () => {
    const meta = fakeMeta();
    vi.stubGlobal('fetch', meta.impl);
    try {
      const { POST } = await webhook();
      const raw = JSON.stringify(textWebhook());
      const req = () => new Request('http://x', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': signPayload(raw, SECRET) } });
      const first = await POST(req());
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ ok: true, received: 1, queued: 1 });
      await until(() => meta.sends().length === 1);
      expect(meta.sends()).toHaveLength(1);
      const second = await POST(req());
      expect(await second.json()).toMatchObject({ ok: true, received: 0, duplicates: 1, queued: 0 });
      await new Promise((r) => setTimeout(r, 30));
      expect(meta.sends()).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed when not configured', async () => {
    const { POST, GET } = await webhook();
    const saved = process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_APP_SECRET;
    try {
      expect((await POST(new Request('http://x', { method: 'POST', body: '{}' }))).status).toBe(503);
      expect((await GET(new Request('http://x?hub.mode=subscribe'))).status).toBe(503);
    } finally {
      process.env.WHATSAPP_APP_SECRET = saved;
    }
  });

  it('the sweep answers GET (Vercel Cron) with the cron secret, and nothing without it', async () => {
    Object.assign(process.env, env);
    const { GET, POST } = await import('@/app/api/cron/whatsapp/route');
    expect(GET).toBe(POST);
    expect((await GET(new Request('http://x/api/cron/whatsapp'))).status).toBe(401);
    const meta = fakeMeta();
    vi.stubGlobal('fetch', meta.impl);
    try {
      await processWebhook(parseWebhook(textWebhook(), PHONE_ID));
      store.jobs[0].runAfter = new Date(Date.now() - 1000);
      const res = await GET(new Request('http://x/api/cron/whatsapp', { headers: { authorization: 'Bearer cron-secret' } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ done: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
