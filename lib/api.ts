import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ForbiddenError } from '@/lib/rbac';
import { captureException } from '@/lib/monitoring';

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
export function handleRouteError(error: unknown) {
  if (error instanceof ZodError) {
    return jsonError('Validation failed', 422, error.flatten().fieldErrors);
  }
  if (error instanceof ForbiddenError) {
    return jsonError(error.message, 403);
  }
  // Errors we explicitly annotate with a numeric `status` are safe to surface.
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    'message' in error
  ) {
    const e = error as { status: number; message: string };
    return jsonError(e.message, e.status);
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
