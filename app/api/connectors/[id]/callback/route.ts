import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/auth-helpers';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { absoluteUrl } from '@/lib/app-url';
import { logger } from '@/lib/logger';
import { bindingCookieName, decodeState, verifyBinding } from '@/server/connectors/oauth';
import { completeOAuth } from '@/server/connectors/connection.service';
import { getRequestMeta } from '@/lib/api';
import { notifyUser } from '@/server/whatsapp/notify';
import { describeAuthFailure } from '@/lib/connection-errors';
import { CONNECTORS } from '@/lib/connectors';

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

/** A failed connection, explained (lib/connection-errors.ts) with a stable code. */
function failed(status: 'denied' | 'error', connector: string, code: string, description?: string | null) {
  const name = CONNECTORS.find((c) => c.id === connector)?.name ?? connector;
  const f = describeAuthFailure(code, name, description);
  return back(status, { connector, code: f.code, reason: f.message });
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
    const description = url.searchParams.get('error_description');
    return failed(providerError === 'access_denied' ? 'denied' : 'error', params.id, providerError, description);
  }
  if (!code || !stateRaw) {
    return failed('error', params.id, 'missing_code');
  }

  let connectorId = params.id;
  try {
    const state = decodeState(stateRaw);
    // Authoritative: the path may be a shared alias (e.g. "google").
    connectorId = state.connectorId;
    // This browser started the flow (and holds the PKCE verifier). Single use.
    const cookieName = bindingCookieName(connectorId);
    const verifier = verifyBinding(state, cookies().get(cookieName)?.value);
    cookies().delete(cookieName);

    // Re-authenticate: the state proves the request came from us, the session
    // proves who is completing it, and membership proves they may.
    const user = await requireUser();
    if (user.id !== state.userId) {
      return failed('error', connectorId, 'wrong_user');
    }
    const membership = await getMembership(user.id, state.companyId);
    if (!membership || !can(membership.role, 'company:update')) {
      return failed('error', connectorId, 'forbidden');
    }

    const connection = await completeOAuth({
      companyId: state.companyId,
      userId: user.id,
      connectorId,
      code,
      verifier,
      requestMeta: getRequestMeta(req),
    });
    // Started from WhatsApp? Confirm there (best effort, never fails this).
    await notifyUser({
      userId: user.id,
      companyId: state.companyId,
      text: `✅ ${connectorId === 'meta' ? 'Facebook & Instagram' : connectorId} connected${connection.accountLabel ? ` (${connection.accountLabel})` : ''}.${
        connection.setupStage === 'CONFIRMED' ? '' : ' Open Aura to choose and confirm the account it should use.'
      }`,
    });

    // Steps 4–5 (select account/page, confirm) when there is something to confirm.
    if (connection.setupStage !== 'CONFIRMED') {
      const setup = new URL(absoluteUrl(`/dashboard/connections/${connectorId}/setup`));
      setup.searchParams.set('status', 'authorized');
      return NextResponse.redirect(setup);
    }
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
    const code = /state|binding|expired/i.test(reason) ? 'bad_state' : /manages no Pages/i.test(reason) ? 'no_accounts' : 'exchange_failed';
    return failed('error', connectorId, code, code === 'exchange_failed' ? reason : null);
  }
}
