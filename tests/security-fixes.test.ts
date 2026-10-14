import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Fixes for gaps found in the WhatsApp / social-publishing audit:
 *   1. post-login redirects stay on this site (no open redirect)
 *   2. the extension cannot mark content published without content:publish
 *   3. VIEWERs cannot create campaigns
 */

const { state } = vi.hoisted(() => ({
  state: { draft: null as any, campaigns: [] as any[], membershipRole: 'OWNER' },
}));

vi.mock('@/lib/db', () => ({
  db: {
    contentDraft: { findFirst: async () => state.draft },
    campaign: {
      create: async ({ data }: any) => {
        state.campaigns.push(data);
        return { id: 'c1', ...data, status: 'DRAFT' };
      },
    },
    auditLog: { create: async () => ({}) },
  },
}));

vi.mock('@/lib/auth-helpers', () => ({
  requireActiveCompany: async () => ({
    user: { id: 'u1' },
    company: { id: 'co1' },
    membership: { role: state.membershipRole },
  }),
}));

import { safeRedirectPath } from '@/lib/safe-url';
import { completeAction } from '@/server/extension/action.service';
import { POST as createCampaign } from '@/app/api/campaigns/route';

beforeEach(() => {
  state.draft = null;
  state.campaigns.length = 0;
  state.membershipRole = 'OWNER';
});

describe('post-login redirect', () => {
  it('keeps same-site paths', () => {
    expect(safeRedirectPath('/dashboard/content', '/dashboard')).toBe('/dashboard/content');
    expect(safeRedirectPath('/invite/abc?x=1', '/dashboard')).toBe('/invite/abc?x=1');
  });

  it('refuses anything that could leave the site', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      '/foo\\bar',
      '/ok\u0000',
      ' https://evil.example',
      '',
      null,
      undefined,
    ]) {
      expect(safeRedirectPath(bad as string, '/dashboard')).toBe('/dashboard');
    }
  });
});

describe('extension: marking content published', () => {
  const ctx = (role: string) => ({
    tokenId: 't1',
    userId: 'u1',
    companyId: 'co1',
    membership: { role } as any,
  });

  it('a MEMBER or VIEWER token is refused before the draft is touched', async () => {
    state.draft = { id: 'd1', companyId: 'co1', status: 'APPROVED' };
    for (const role of ['MEMBER', 'VIEWER']) {
      const err = await completeAction({ ctx: ctx(role), itemType: 'content_draft', itemId: 'd1' }).catch((e) => e);
      expect(err.status).toBe(403);
    }
  });

  it('an OWNER passes the permission check (and reaches the normal draft checks)', async () => {
    state.draft = null; // not found → 404, i.e. past the permission gate
    const err = await completeAction({ ctx: ctx('OWNER'), itemType: 'content_draft', itemId: 'nope' }).catch((e) => e);
    expect(err.status).toBe(404);
  });
});

describe('campaign creation', () => {
  const req = () =>
    new Request('http://x/api/campaigns', { method: 'POST', body: JSON.stringify({ name: 'Diwali' }) });

  it('a VIEWER cannot create one', async () => {
    state.membershipRole = 'VIEWER';
    const res = await createCampaign(req());
    expect(res.status).toBe(403);
    expect(state.campaigns).toHaveLength(0);
  });

  it('a MEMBER can', async () => {
    state.membershipRole = 'MEMBER';
    const res = await createCampaign(req());
    expect(res.status).toBe(201);
    expect(state.campaigns).toHaveLength(1);
  });
});
