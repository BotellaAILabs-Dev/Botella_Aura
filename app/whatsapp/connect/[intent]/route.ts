import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { ACTIVE_COMPANY_COOKIE } from '@/lib/cookies';
import { buildAuthorizeUrl } from '@/server/connectors/oauth';
import { bindingCookieOptions } from '@/lib/pkce';
import { preflightConnector } from '@/server/connectors/preflight';
import { providerReadiness } from '@/server/connectors/providers';
import { getMembership } from '@/server/services/company.service';
import { isLinkedInConfigured } from '@/server/services/linkedin.service';
import { verifyIntent } from '@/server/whatsapp/connect-intent';

/**
 * GET /whatsapp/connect/:intent — a "connect" link sent on WhatsApp
 * (server/whatsapp/connect-intent.ts). Starts Aura's EXISTING OAuth flow for
 * the workspace named in the signed intent, after checking that the signed-in
 * user is the one it was made for and may still manage connections there.
 */
export const dynamic = 'force-dynamic';

function settings(req: Request, error?: string) {
  const url = new URL('/dashboard/settings/connections', req.url);
  if (error) url.searchParams.set('error', error);
  const res = NextResponse.redirect(url);
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

export async function GET(req: Request, { params }: { params: { intent: string } }) {
  const user = await getCurrentUser();
  if (!user) {
    const back = `/whatsapp/connect/${params.intent}`;
    return NextResponse.redirect(new URL(`/login?callbackUrl=${encodeURIComponent(back)}`, req.url));
  }
  const intent = verifyIntent(params.intent);
  if (!intent) return settings(req, 'link_expired');
  // Made for someone else: signed in as the wrong account.
  if (intent.userId !== user.id) return settings(req, 'wrong_account');
  const membership = await getMembership(user.id, intent.companyId);
  if (!membership) return settings(req, 'forbidden');

  if (intent.provider === 'linkedin') {
    if (!can(membership.role, 'linkedin:connect')) return settings(req, 'forbidden');
    if (!isLinkedInConfigured()) return settings(req, 'not_configured');
    // LinkedIn's start route connects the browser's active workspace: make
    // that the workspace from WhatsApp, then hand over.
    const res = NextResponse.redirect(new URL('/api/linkedin/connect', req.url));
    res.cookies.set(ACTIVE_COMPANY_COOKIE, intent.companyId, { path: '/', maxAge: 31_536_000, sameSite: 'lax' });
    res.headers.set('Referrer-Policy', 'no-referrer');
    return res;
  }

  // Meta (Facebook & Instagram): the generic connector flow, whose signed
  // OAuth state already names the workspace and the user.
  if (!can(membership.role, 'company:update')) return settings(req, 'forbidden');
  if (!providerReadiness('meta').connectable || !preflightConnector('meta').ok) return settings(req, 'not_configured');
  const start = buildAuthorizeUrl({ connectorId: 'meta', companyId: intent.companyId, userId: user.id });
  const res = NextResponse.redirect(start.url);
  res.cookies.set(start.cookie.name, start.cookie.value, bindingCookieOptions);
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}
