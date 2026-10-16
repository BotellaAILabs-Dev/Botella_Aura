import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ForbiddenError } from '@/lib/rbac';
import { captureException } from '@/lib/monitoring';
import { logger } from '@/lib/logger';
import { aiFailureMessage } from '@/server/ai/claude';

/**
 * Consistent JSON responses for API route handlers. Centralizes the error
 * envelope shape ({ error, details? }) and maps known error types to status
 * codes, so route handlers stay thin and never leak internals.
 */

export function jsonOk<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function jsonError(
  message: string,
  status = 400,
  details?: Record<string, string[] | undefined>,
) {
  return NextResponse.json({ error: message, ...(details && { details }) }, {
    status,
  });
}

/** Turn any thrown error into a safe JSON response. */
/**
 * Is this Next's internal "redirect()" control-flow signal?
 *
 * `requireUser()` calls `redirect('/login')`, which works by throwing. That is
 * right for a page, but in a route handler it fell through to the catch-all
 * below and answered 500 — so an expired session read as a server fault, both
 * to the caller and to monitoring. Detected by the `digest` marker Next sets,
 * since the error class itself is not exported.
 */
function isNextRedirect(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'digest' in error &&
    typeof (error as { digest: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

export function handleRouteError(error: unknown) {
  if (error instanceof ZodError) {
    return jsonError('Validation failed', 422, error.flatten().fieldErrors);
  }
  if (error instanceof ForbiddenError) {
    return jsonError(error.message, 403);
  }
  // An unauthenticated API call is a 401, not a server error. Worth being
  // exact about: the job indicator polls continuously, so a lapsed session
  // would otherwise fill the logs with phantom 500s.
  if (isNextRedirect(error)) {
    return jsonError('Not signed in. Sign in again — your work on this page is kept.', 401);
  }
  // The AI provider failed (quota, outage): never its raw text — one plain
  // message, and logged so it is not invisible to us.
  const ai = aiFailureMessage(error);
  if (ai) {
    captureException(error, { scope: 'route', kind: 'ai_provider' });
    return jsonError(ai, 503);
  }
  // Errors we explicitly annotate with a numeric `status` are safe to surface.
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    'message' in error
  ) {
    const e = error as {
      status: number;
      message: string;
      details?: Record<string, string[] | undefined>;
    };
    // Per-field messages (e.g. BusinessContextUpdateError) travel in the same
    // `details` shape a ZodError produces, so forms need only one reader.
    const details =
      e.details && typeof e.details === 'object' ? e.details : undefined;
    // A server-side failure that carried its own status is still a failure:
    // logged, like the unknown ones below.
    if (e.status >= 500) captureException(error, { scope: 'route', status: e.status });
    // A refusal with a reason code (a failed review, claims to check, a
    // concurrent change, a duplicate approval) is logged, so refusals are visible.
    const code = (error as { code?: unknown }).code;
    if (e.status === 409 && typeof code === 'string') logger.info('route: refused', { code, message: e.message.slice(0, 200) });
    return jsonError(e.message, e.status, details);
  }

  // Unknown, unexpected error → capture for monitoring (Sprint 6) + return 500.
  captureException(error, { scope: 'route' });
  return jsonError('Something went wrong. Please try again.', 500);
}

/** Best-effort client metadata for audit logging. */
export function getRequestMeta(req: Request) {
  const h = req.headers;
  return {
    ipAddress:
      h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      h.get('x-real-ip') ??
      null,
    userAgent: h.get('user-agent'),
  };
}
