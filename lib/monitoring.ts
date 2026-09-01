import { logger } from '@/lib/logger';

/**
 * Lightweight error monitoring (Sprint 6, Module 4). Always structured-logs the
 * error (so it's visible in platform logs); if SENTRY_DSN is configured, it also
 * fires a best-effort event to Sentry's Store API. Kept dependency-free — swap
 * in `@sentry/nextjs` later behind this same `captureException()` seam without
 * touching call sites.
 */
export function captureException(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  // Log the stack too, not just the message. A one-word message like
  // "unusable" says nothing about where it came from, and without a Sentry DSN
  // this log line is the ONLY record — which turned a one-line bug into a hunt.
  logger.error('captured exception', {
    message,
    ...(stack ? { stack } : {}),
    ...(context ?? {}),
  });

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  // Fire-and-forget; never let monitoring break the request.
  void sendToSentry(dsn, { message, stack, context }).catch(() => {});
}

async function sendToSentry(
  dsn: string,
  payload: { message: string; stack?: string; context?: Record<string, unknown> },
): Promise<void> {
  // DSN format: https://<publicKey>@<host>/<projectId>
  const m = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(.+)$/);
  if (!m) return;
  const [, publicKey, host, projectId] = m;
  const url = `https://${host}/api/${projectId}/store/?sentry_key=${publicKey}&sentry_version=7`;

  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: payload.message,
      level: 'error',
      platform: 'node',
      timestamp: Date.now() / 1000,
      extra: { stack: payload.stack, ...(payload.context ?? {}) },
    }),
  });
}
