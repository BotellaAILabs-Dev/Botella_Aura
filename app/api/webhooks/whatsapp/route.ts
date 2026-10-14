import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { ZodError } from 'zod';

import { logger } from '@/lib/logger';
import {
  missingConfig,
  parseWebhook,
  verifySignature,
  verifySubscription,
  whatsAppConfig,
} from '@/lib/whatsapp';
import { processWebhook } from '@/server/whatsapp/whatsapp.service';
import { drainConversations } from '@/server/whatsapp/queue';

/**
 * /api/webhooks/whatsapp — Meta WhatsApp Cloud API webhook for Botella's
 * central number.
 *
 *   GET   subscription handshake: echoes hub.challenge when hub.verify_token
 *         matches WHATSAPP_VERIFY_TOKEN
 *   POST  messages and statuses. Unauthenticated by design — Meta calls it —
 *         so the X-Hub-Signature-256 HMAC (WHATSAPP_APP_SECRET) over the raw
 *         body IS the authentication. Nothing is parsed or stored before it
 *         passes.
 *
 * Nothing slow happens before the response: each message is stored with a
 * queued job and Meta is answered at once. The answering (AI, Aura services,
 * sending) runs after the response, via waitUntil (server/whatsapp/queue.ts);
 * the cron sweep picks up anything that does not finish.
 *
 * Responses: 200 once stored; 401 for a bad signature; 500 only when storing
 * failed, so Meta redelivers; 503 (fail closed) when not configured.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** The response is immediate; this is the budget for the work after it. */
export const maxDuration = 60;

/** Meta's payloads are a few KB; anything far larger is not from Meta. */
const MAX_BODY_BYTES = 1_000_000;

function notConfigured() {
  logger.error('whatsapp webhook: not configured', { missing: missingConfig() });
  return NextResponse.json({ error: 'WhatsApp is not configured.' }, { status: 503 });
}

export async function GET(req: Request) {
  const config = whatsAppConfig();
  if (!config) return notConfigured();
  const challenge = verifySubscription(new URL(req.url).searchParams, config.verifyToken);
  if (challenge === null) {
    logger.warn('whatsapp webhook: subscription verification failed');
    return NextResponse.json({ error: 'Verification failed.' }, { status: 403 });
  }
  // Meta expects the challenge back verbatim, as plain text.
  return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

export async function POST(req: Request) {
  const config = whatsAppConfig();
  if (!config) return notConfigured();

  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large.' }, { status: 413 });
  }
  // The raw body, exactly as signed.
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large.' }, { status: 413 });
  }
  if (!verifySignature(raw, req.headers.get('x-hub-signature-256'), config.appSecret)) {
    logger.warn('whatsapp webhook: invalid signature');
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 401 });
  }

  let parsed;
  try {
    parsed = parseWebhook(JSON.parse(raw), config.phoneNumberId);
  } catch (err) {
    // Signed by Meta but not a shape we understand: acknowledge so Meta does
    // not redeliver it forever, and log it for investigation.
    logger.error('whatsapp webhook: unreadable payload', {
      error: err instanceof ZodError ? err.issues[0]?.message : err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ received: true, processed: false });
  }

  try {
    const { conversationIds, ...result } = await processWebhook(parsed);
    if (parsed.ignored) logger.info('whatsapp webhook: changes for another number ignored', { count: parsed.ignored });
    if (conversationIds.length) {
      // After the response: answer the new messages. On Vercel waitUntil keeps
      // the function alive for it; elsewhere the promise simply runs on.
      waitUntil(drainConversations({ config, conversationIds, budgetMs: 50_000 }));
    }
    return NextResponse.json({ ok: true, ...result, queued: conversationIds.length });
  } catch (err) {
    logger.error('whatsapp webhook: processing failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    // 500 so Meta redelivers; already-stored messages are recognised as duplicates.
    return NextResponse.json({ error: 'Processing failed.' }, { status: 500 });
  }
}
