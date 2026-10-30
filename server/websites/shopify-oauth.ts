import crypto from 'node:crypto';

import { absoluteUrl } from '@/lib/app-url';
import { createVerifier, sealBinding } from '@/lib/pkce';
import { bindingCookieName, encodeState } from '@/server/connectors/oauth';
import { safeFetch } from '@/server/websites/safe-fetch';
import { normaliseShop, SHOPIFY_SCOPES } from '@/server/websites/adapters/shopify';
import { WebsitePublishError } from '@/server/websites/types';

/**
 * Shopify OAuth (authorization code grant) for website publishing.
 *
 * Reuses the connectors' signed state and browser binding
 * (server/connectors/oauth.ts, lib/pkce.ts): the state is HMAC'd and
 * time-limited, and the callback refuses a code from a browser without the
 * cookie set here. On top of that Shopify signs its redirect: every query
 * parameter is HMAC'd with the app secret, which is what makes the `shop`
 * parameter trustworthy.
 *
 * Register this redirect URL in the Shopify app: /api/websites/shopify/callback
 */

export const SHOPIFY_STATE_ID = 'website-shopify';
export const SHOPIFY_REDIRECT_PATH = '/api/websites/shopify/callback';

function appCredentials() {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new WebsitePublishError(
      'validation',
      'Shopify OAuth isn’t set up on this deployment (SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET). Paste an Admin API token from an existing custom app instead, or ask an admin to configure it.',
    );
  }
  return { clientId, clientSecret };
}

export function shopifyAuthorizeUrl(args: { shop: string; companyId: string; userId: string }) {
  const { clientId } = appCredentials();
  const shop = normaliseShop(args.shop);
  const nonce = crypto.randomBytes(12).toString('base64url');
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', SHOPIFY_SCOPES.join(','));
  url.searchParams.set('redirect_uri', absoluteUrl(SHOPIFY_REDIRECT_PATH));
  url.searchParams.set('state', encodeState({ companyId: args.companyId, connectorId: SHOPIFY_STATE_ID, userId: args.userId }, nonce));
  return {
    url: url.toString(),
    cookie: { name: bindingCookieName(SHOPIFY_STATE_ID), value: sealBinding(nonce, createVerifier()) },
  };
}

/** Shopify's redirect signature: HMAC-SHA256 of the sorted query, minus hmac. */
export function verifyShopifyHmac(params: URLSearchParams, secret = process.env.SHOPIFY_CLIENT_SECRET ?? ''): boolean {
  const given = params.get('hmac');
  if (!given || !secret) return false;
  const message = [...params.entries()]
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Exchange the code for an offline access token, and check the scopes. */
export async function exchangeShopifyCode(shopRaw: string, code: string): Promise<{ shop: string; accessToken: string }> {
  const { clientId, clientSecret } = appCredentials();
  const shop = normaliseShop(shopRaw);
  const res = await safeFetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const text = await res.text();
  if (!res.ok) throw new WebsitePublishError('auth', `Shopify refused the authorization (HTTP ${res.status}). Start again from Website publishing.`);
  const data = JSON.parse(text) as { access_token?: string; scope?: string };
  if (!data.access_token) throw new WebsitePublishError('auth', 'Shopify did not return an access token.');
  const granted = (data.scope ?? '').split(',').map((s) => s.trim());
  // write_X implies read_X in Shopify's scope model.
  if (!granted.includes('write_content')) {
    throw new WebsitePublishError('auth', 'Shopify did not grant blog-content access (write_content). Reconnect and approve it.');
  }
  return { shop, accessToken: data.access_token };
}
