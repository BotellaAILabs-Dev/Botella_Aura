import { NextResponse } from 'next/server';
import { verifyExtensionToken } from '@/server/extension/token.service';
import { getMembership } from '@/server/services/company.service';
import type { CompanyMember } from '@prisma/client';

/**
 * Cross-origin bearer auth for the Chrome Extension (Sprint 4, Module 2).
 *
 * The extension calls /api/extension/* from a `chrome-extension://<id>` origin
 * with `Authorization: Bearer aura_ext_...` and NO cookies. Because auth is
 * bearer-only (never a session cookie), CORS can safely allow extension origins
 * without credentials. Unpacked dev extensions get a random id each load, so we
 * allow any `chrome-extension://` origin by default; pin it in production via
 * EXTENSION_ALLOWED_ORIGIN.
 */
export class ExtensionAuthError extends Error {
  readonly status = 401;
  constructor(message = 'Invalid or missing extension token.') {
    super(message);
    this.name = 'ExtensionAuthError';
  }
}

function allowedOrigin(req: Request): string {
  const origin = req.headers.get('origin') ?? '';
  const pinned = process.env.EXTENSION_ALLOWED_ORIGIN;
  if (pinned) return origin === pinned ? origin : pinned;
  // Dev/default: allow any chrome/edge extension origin (bearer-only, no cookies).
  if (/^chrome-extension:\/\//.test(origin) || /^moz-extension:\/\//.test(origin)) {
    return origin;
  }
  return '*';
}

export function corsHeaders(req: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowedOrigin(req),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** CORS preflight response (return from an exported OPTIONS handler). */
export function handleOptions(req: Request): Response {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export interface ExtensionContext {
  tokenId: string;
  userId: string;
  companyId: string;
  membership: CompanyMember;
}

/**
 * Authenticate an extension request. Throws ExtensionAuthError (401) if the
 * bearer token is missing/invalid/revoked/expired or the user is no longer a
 * member of the token's company.
 */
export async function requireExtensionAuth(
  req: Request,
): Promise<ExtensionContext> {
  const header = req.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ExtensionAuthError();

  const verified = await verifyExtensionToken(match[1]!.trim());
  if (!verified) throw new ExtensionAuthError();

  const membership = await getMembership(verified.userId, verified.companyId);
  if (!membership) {
    throw new ExtensionAuthError('Extension is no longer authorized for this workspace.');
  }

  return { ...verified, membership };
}

/** JSON success response with CORS headers attached. */
export function extJson<T>(req: Request, data: T, status = 200): Response {
  return NextResponse.json(data, { status, headers: corsHeaders(req) });
}

/** JSON error response with CORS headers attached. */
export function extError(req: Request, message: string, status = 400): Response {
  return NextResponse.json({ error: message }, { status, headers: corsHeaders(req) });
}

/** Map a thrown error to a CORS-tagged JSON response for extension routes. */
export function handleExtensionError(req: Request, error: unknown): Response {
  if (error instanceof ExtensionAuthError) {
    return extError(req, error.message, error.status);
  }
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    'message' in error
  ) {
    const e = error as { status: number; message: string };
    return extError(req, e.message, e.status);
  }
  return extError(req, 'Something went wrong.', 500);
}
