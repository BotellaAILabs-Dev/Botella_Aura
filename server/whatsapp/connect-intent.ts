import crypto from 'node:crypto';

import { keyedHash } from '@/lib/crypto';

/**
 * "Connect LinkedIn / Facebook & Instagram" started from WhatsApp.
 *
 * The OAuth itself is Aura's existing flow, in the browser, on the provider's
 * official page — WhatsApp never sees a password or a token. What WhatsApp
 * adds is WHICH workspace and WHO: the link carries a signed, 15-minute
 * intent { user, workspace, provider }. The landing route
 * (app/whatsapp/connect/[intent]) requires the same user to be signed in to
 * Aura, re-checks their membership and permission, and only then starts the
 * provider's authorization for that workspace — so a browser that happens to
 * have another workspace selected cannot connect the wrong business.
 */

export const CONNECT_PROVIDERS = ['linkedin', 'meta'] as const;
export type ConnectProvider = (typeof CONNECT_PROVIDERS)[number];

const TTL_MS = 15 * 60_000;
const PURPOSE = 'whatsapp-connect-intent';

interface Intent {
  u: string;
  c: string;
  p: ConnectProvider;
  exp: number;
}

export function signIntent(args: { userId: string; companyId: string; provider: ConnectProvider }, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ u: args.userId, c: args.companyId, p: args.provider, exp: now + TTL_MS } satisfies Intent),
  ).toString('base64url');
  return `${payload}.${keyedHash(payload, PURPOSE)}`;
}

export function verifyIntent(
  raw: string,
  now = Date.now(),
): { userId: string; companyId: string; provider: ConnectProvider } | null {
  const [payload, sig] = raw.split('.');
  if (!payload || !sig || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const expected = keyedHash(payload, PURPOSE);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const i = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Intent;
    if (typeof i.exp !== 'number' || i.exp <= now) return null;
    if (!(CONNECT_PROVIDERS as readonly string[]).includes(i.p) || !i.u || !i.c) return null;
    return { userId: i.u, companyId: i.c, provider: i.p };
  } catch {
    return null;
  }
}
