import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * GET /whatsapp/connect/:intent — where a "connect" link from WhatsApp lands.
 * It must start the existing OAuth only for the user the intent was made
 * for, in the intent's workspace, with permission checked now.
 */

const s = vi.hoisted(() => ({ user: null as null | { id: string }, role: 'OWNER' as string | null }));

vi.mock('@/lib/auth-helpers', () => ({ getCurrentUser: async () => s.user }));
vi.mock('@/server/services/company.service', () => ({
  getMembership: async () => (s.role ? { role: s.role } : null),
}));
vi.mock('@/server/services/linkedin.service', () => ({ isLinkedInConfigured: () => true }));
vi.mock('@/server/connectors/providers', () => ({ providerReadiness: () => ({ connectable: true }) }));
vi.mock('@/server/connectors/preflight', () => ({ preflightConnector: () => ({ ok: true }) }));
vi.mock('@/server/connectors/oauth', () => ({
  buildAuthorizeUrl: ({ companyId, userId }: { companyId: string; userId: string }) => ({
    url: `https://www.facebook.com/v21.0/dialog/oauth?state=${companyId}.${userId}`,
    cookie: { name: 'aura_oauth_meta', value: 'sealed-binding' },
  }),
}));

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

import { GET } from '@/app/whatsapp/connect/[intent]/route';
import { signIntent } from '@/server/whatsapp/connect-intent';

const call = (intent: string) =>
  GET(new Request(`https://aura.example/whatsapp/connect/${intent}`), { params: { intent } });

beforeEach(() => {
  s.user = { id: 'u1' };
  s.role = 'OWNER';
});

describe('connect landing route', () => {
  it('signed out → Aura’s login, then back here', async () => {
    s.user = null;
    const intent = signIntent({ userId: 'u1', companyId: 'co_wa', provider: 'linkedin' });
    const res = await call(intent);
    expect(res.headers.get('location')).toBe(`https://aura.example/login?callbackUrl=${encodeURIComponent(`/whatsapp/connect/${intent}`)}`);
  });

  it('LinkedIn: the WhatsApp workspace becomes the active one, then the existing flow starts', async () => {
    const res = await call(signIntent({ userId: 'u1', companyId: 'co_wa', provider: 'linkedin' }));
    expect(res.headers.get('location')).toBe('https://aura.example/api/linkedin/connect');
    expect(res.headers.get('set-cookie')).toMatch(/aura\.activeCompany=co_wa/);
  });

  it('Meta: straight to Facebook’s authorization, bound to the intent’s workspace and user', async () => {
    const res = await call(signIntent({ userId: 'u1', companyId: 'co_wa', provider: 'meta' }));
    expect(res.headers.get('location')).toBe('https://www.facebook.com/v21.0/dialog/oauth?state=co_wa.u1');
    // Bound to this browser: the callback needs this cookie (lib/pkce.ts).
    expect(res.headers.get('set-cookie')).toMatch(/aura_oauth_meta=sealed-binding;.*HttpOnly/i);
  });

  it('signed in as someone else: refused', async () => {
    s.user = { id: 'u2' };
    const res = await call(signIntent({ userId: 'u1', companyId: 'co_wa', provider: 'meta' }));
    expect(res.headers.get('location')).toBe('https://aura.example/dashboard/settings/connections?error=wrong_account');
  });

  it('no longer a member, or not allowed: refused', async () => {
    s.role = null;
    expect((await call(signIntent({ userId: 'u1', companyId: 'co_wa', provider: 'meta' }))).headers.get('location')).toMatch(/error=forbidden/);
    s.role = 'MEMBER';
    expect((await call(signIntent({ userId: 'u1', companyId: 'co_wa', provider: 'linkedin' }))).headers.get('location')).toMatch(/error=forbidden/);
  });

  it('expired or forged intents: refused', async () => {
    const old = signIntent({ userId: 'u1', companyId: 'co_wa', provider: 'meta' }, Date.now() - 16 * 60_000);
    expect((await call(old)).headers.get('location')).toMatch(/error=link_expired/);
    expect((await call('abc.def')).headers.get('location')).toMatch(/error=link_expired/);
  });
});
