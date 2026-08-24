import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/auth-helpers';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { absoluteUrl } from '@/lib/app-url';
import { logger } from '@/lib/logger';
import { decodeState, InvalidOAuthStateError } from '@/server/connectors/oauth';
import { completeOAuth } from '@/server/connectors/connection.service';
import { getRequestMeta } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/connectors/:id/callback — OAuth redirect target.
 *
 * Always redirects back to the Connectors page with a human-readable outcome in
 * the query string; the user never sees a raw JSON error at the end of an OAuth
 * dance.
 */
function back(status: string, extra?: Record<string, string>) {
  const url = new URL(absoluteUrl('/dashboard/connectors'));
  url.searchParams.set('status', status);
  for (const [k, v] of Object.entries(extra ?? {})) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');

  if (providerError) {
    // The user pressed "Cancel", or the provider refused the scopes.
    return back('denied', {
      connector: params.id,
      reason: url.searchParams.get('error_description') ?? providerError,
    });
  }
  if (!code || !stateRaw) {
    return back('error', {
      connector: params.id,
      reason: 'The provider did not return an authorization code.',
    });
  }

  try {
    const state = decodeState(stateRaw);
    if (state.connectorId !== params.id) {
      throw new InvalidOAuthStateError();
    }

    // Re-authenticate: the state proves the request came from us, the session
    // proves who is completing it, and membership proves they may.
    const user = await requireUser();
    if (user.id !== state.userId) {
      return back('error', {
        connector: params.id,
        reason: 'Finish the connection in the same account that started it.',
      });
    }
    const membership = await getMembership(user.id, state.companyId);
    if (!membership || !can(membership.role, 'company:update')) {
      return back('error', {
        connector: params.id,
        reason: 'You do not have permission to manage connectors for that workspace.',
      });
    }

    const connection = await completeOAuth({
      companyId: state.companyId,
      userId: user.id,
      connectorId: params.id,
      code,
      requestMeta: getRequestMeta(req),
    });

    return back('connected', {
      connector: params.id,
      account: connection.accountLabel ?? params.id,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('connectors: OAuth callback failed', {
      connectorId: params.id,
      error: reason,
    });
    return back('error', { connector: params.id, reason });
  }
}
