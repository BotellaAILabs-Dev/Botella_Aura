import { getStripe } from '@/lib/stripe';
import { handleStripeEvent } from '@/server/billing/subscription.service';
import { logger } from '@/lib/logger';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/stripe — Stripe webhook receiver (Sprint 6, Module 3).
 *
 * NON-NEGOTIABLE #4: the signature is verified with STRIPE_WEBHOOK_SECRET before
 * we trust ANY payload. An unverified/tampered request is rejected with 400 and
 * never touches the database. This route is intentionally unauthenticated (Stripe
 * calls it) — the signature IS the auth.
 */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('stripe webhook: STRIPE_WEBHOOK_SECRET not configured');
    return NextResponse.json({ error: 'Webhooks not configured.' }, { status: 503 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing signature.' }, { status: 400 });
  }

  // Raw body is required for signature verification.
  const body = await req.text();

  let event;
  try {
    event = getStripe().webhooks.constructEvent(body, signature, secret);
  } catch (err) {
    logger.warn('stripe webhook: signature verification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 });
  }

  try {
    const result = await handleStripeEvent(event);
    logger.info('stripe webhook: handled', { type: event.type, ...result });
    return NextResponse.json({ received: true });
  } catch (err) {
    logger.error('stripe webhook: handler error', {
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
    // Return 500 so Stripe retries.
    return NextResponse.json({ error: 'Handler error.' }, { status: 500 });
  }
}
