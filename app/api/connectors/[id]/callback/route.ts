import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/auth-helpers';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { absoluteUrl } from '@/lib/app-url';
import { logger } from '@/lib/logger';
import { decodeState } from '@/server/connectors/oauth';
import { completeOAuth } from '@/server/connectors/connection.service';
import { getRequestMeta } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/connectors/:id/callback — OAuth redirect target.
 *
 * The connector is taken from the signed `state`, not from the path. Providers
 * that share one OAuth client across several connectors (Google: GA4 +
 * Search Console) therefore share one registered redirect URI, which is what
 * removes the `redirect_uri_mismatch` class of failure — there is a single URI
 * to register instead of one per connector. `state` is HMAC'd, so it is the
 * safer source of truth in any case.
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
    // The user pressed "Cancel", or the provider refused the request.
    const description =
      url.searchParams.get('error_description') ?? providerError;
    return back('denied', {
      connector: params.id,
      reason: /redirect_uri/i.test(description)
        ? `${description} — the redirect URI registered with the provider does not match this deployment. Copy the exact URI shown on the Connectors page into the provider's console.`
        : description,
    });
  }
  if (!code || !stateRaw) {
    return back('error', {
      connector: params.id,
      reason: 'The provider did not return an authorization code.',
    });
  }

  let connectorId = params.id;
  try {
    const state = decodeState(stateRaw);
    // Authoritative: the path may be a shared alias (e.g. "google").
    connectorId = state.connectorId;

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
        connector: connectorId,
        reason: 'You do not have permission to manage connectors for that workspace.',
      });
    }

    const connection = await completeOAuth({
      companyId: state.companyId,
      userId: user.id,
      connectorId,
      code,
      requestMeta: getRequestMeta(req),
    });

    return back('connected', {
      connector: connectorId,
      account: connection.accountLabel ?? connectorId,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('connectors: OAuth callback failed', {
      connectorId,
      error: reason,
    });
    return back('error', { connector: connectorId, reason });
  }
}
