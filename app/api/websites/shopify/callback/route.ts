import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/auth-helpers';
import { absoluteUrl } from '@/lib/app-url';
import { getRequestMeta } from '@/lib/api';
import { logger } from '@/lib/logger';
import { can } from '@/lib/rbac';
import { bindingCookieName, decodeState, InvalidOAuthStateError, verifyBinding } from '@/server/connectors/oauth';
import { getMembership } from '@/server/services/company.service';
import { connectWebsite } from '@/server/websites/connection.service';
import { exchangeShopifyCode, SHOPIFY_STATE_ID, verifyShopifyHmac } from '@/server/websites/shopify-oauth';

/**
 * GET /api/websites/shopify/callback — Shopify's OAuth redirect.
 *
 * Checked in order: Shopify's HMAC over the query (proves the `shop` and
 * `code` came from Shopify), Aura's signed state (proves Aura started it,
 * for whom), the browser binding cookie (proves this browser started it),
 * the signed-in user and their role. Always lands back on Website
 * publishing with a readable outcome.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function back(params: Record<string, string>) {
  const url = new URL(absoluteUrl('/dashboard/settings/websites'));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;
  if (params.get('error')) return back({ status: 'error', reason: params.get('error_description') ?? 'Shopify did not authorize the connection.' });

  const code = params.get('code');
  const shop = params.get('shop');
  const stateRaw = params.get('state');
  if (!code || !shop || !stateRaw) return back({ status: 'error', reason: 'Shopify’s response was incomplete. Start again.' });
  if (!verifyShopifyHmac(params)) return back({ status: 'error', reason: 'Shopify’s response could not be verified. Start again.' });

  try {
    const state = decodeState(stateRaw);
    if (state.connectorId !== SHOPIFY_STATE_ID) throw new InvalidOAuthStateError();
    const cookieName = bindingCookieName(SHOPIFY_STATE_ID);
    verifyBinding(state, cookies().get(cookieName)?.value);
    cookies().delete(cookieName);

    const user = await requireUser();
    if (user.id !== state.userId) return back({ status: 'error', reason: 'Finish connecting while signed in as the person who started it.' });
    const membership = await getMembership(user.id, state.companyId);
    if (!membership || !can(membership.role, 'company:update')) return back({ status: 'error', reason: 'Only owners and admins can connect websites.' });

    const token = await exchangeShopifyCode(shop, code);
    const website = await connectWebsite({
      companyId: state.companyId,
      userId: user.id,
      platform: 'shopify',
      input: { shop: token.shop, accessToken: token.accessToken, authKind: 'oauth' },
      requestMeta: getRequestMeta(req),
    });
    return back({ status: 'connected', site: website.name });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('websites: Shopify OAuth callback failed', { shop, error: reason.slice(0, 300) });
    return back({ status: 'error', reason: err instanceof InvalidOAuthStateError ? err.message : reason.slice(0, 300) });
  }
}
