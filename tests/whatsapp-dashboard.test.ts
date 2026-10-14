import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The WhatsApp Assistant page is per workspace. These tests record the
 * queries it makes and check that every query for message activity is
 * limited to the active workspace, and that members who are not owners or
 * admins get no activity at all (no message queries are even run).
 */

const { calls } = vi.hoisted(() => ({ calls: [] as { model: string; op: string; args: any }[] }));

vi.mock('@/lib/db', () => {
  const rec = (model: string, op: string, result: (args: any) => unknown) => async (args: any) => {
    calls.push({ model, op, args });
    return result(args);
  };
  const now = new Date();
  return {
    db: {
      company: {
        findUniqueOrThrow: rec('company', 'findUniqueOrThrow', () => ({ preferences: null })),
        findMany: rec('company', 'findMany', () => [{ id: 'co_A', name: 'Acme' }]),
      },
      whatsAppAccountLink: {
        findMany: rec('whatsAppAccountLink', 'findMany', (a) =>
          a.where.userId
            ? [{ id: 'l1', userId: 'u1', activeCompanyId: 'co_A', linkedAt: now, lastUsedAt: now, expiresAt: new Date(now.getTime() + 1e9), revokedAt: null, conversation: { waIdLast4: '3210', profileName: 'Asha' } }]
            : [{ lastUsedAt: now, expiresAt: new Date(now.getTime() + 1e9), revokedAt: null, user: { name: 'Asha', email: 'a@acme.test', memberships: [{ role: 'OWNER' }] }, conversation: { waIdLast4: '3210' } }],
        ),
      },
      whatsAppMessage: {
        groupBy: rec('whatsAppMessage', 'groupBy', () => [
          { direction: 'INBOUND', status: 'RECEIVED', _count: { _all: 3 } },
          { direction: 'OUTBOUND', status: 'DELIVERED', _count: { _all: 2 } },
          { direction: 'OUTBOUND', status: 'FAILED', _count: { _all: 1 } },
        ]),
        findMany: rec('whatsAppMessage', 'findMany', (a) =>
          a.where.status === 'FAILED'
            ? [{ createdAt: now, errorCode: '131047', errorMessage: 'window closed', body: 'x' }]
            : [
                { conversationId: 'c1', direction: 'OUTBOUND', body: 'Here are your drafts', status: 'DELIVERED', createdAt: new Date(now.getTime() + 2), errorMessage: null },
                { conversationId: 'c1', direction: 'INBOUND', body: 'show drafts', status: 'RECEIVED', createdAt: new Date(now.getTime() + 1), errorMessage: null },
              ],
        ),
      },
      whatsAppJob: { findMany: rec('whatsAppJob', 'findMany', () => []) },
      whatsAppConversation: {
        findMany: rec('whatsAppConversation', 'findMany', () => [{ id: 'c1', waIdLast4: '3210', link: { user: { name: 'Asha', email: 'a@acme.test', memberships: [{ role: 'OWNER' }] } } }]),
      },
    },
  };
});

import { getWhatsAppDashboard, listWorkspaceConversations } from '@/server/whatsapp/dashboard.service';

beforeEach(() => {
  calls.length = 0;
});

describe('the WhatsApp Assistant page', () => {
  it('owners and admins: every activity query is limited to the active workspace', async () => {
    const d = await getWhatsAppDashboard({ companyId: 'co_A', userId: 'u1', role: 'OWNER' });
    const activity = calls.filter((c) => c.model === 'whatsAppMessage' || c.model === 'whatsAppJob');
    expect(activity.length).toBe(4);
    for (const c of activity) {
      const where = c.args.where;
      expect(where.companyId ?? where.message?.companyId).toBe('co_A');
    }
    const members = calls.find((c) => c.model === 'whatsAppAccountLink' && !c.args.where.userId)!;
    expect(members.args.where).toMatchObject({ activeCompanyId: 'co_A', revokedAt: null, user: { memberships: { some: { companyId: 'co_A' } } } });
    // Conversations are looked up only by the ids found in this workspace's messages.
    expect(calls.find((c) => c.model === 'whatsAppConversation')!.args.where).toEqual({ id: { in: ['c1'] } });

    expect(d.team!.week).toEqual({ inbound: 3, outbound: 3, byStatus: { DELIVERED: 2, FAILED: 1 } });
    expect(d.team!.conversations[0]!.messages.map((m) => m.direction)).toEqual(['INBOUND', 'OUTBOUND']);
    expect(d.team!.failures[0]).toMatchObject({ code: '131047' });
  });

  it('members and viewers: their own numbers only, no activity queried', async () => {
    for (const role of ['MEMBER', 'VIEWER'] as const) {
      calls.length = 0;
      const d = await getWhatsAppDashboard({ companyId: 'co_A', userId: 'u1', role });
      expect(d.canManage).toBe(false);
      expect(d.team).toBeNull();
      expect(d.myLinks).toHaveLength(1);
      expect(calls.some((c) => c.model === 'whatsAppMessage' || c.model === 'whatsAppJob' || c.model === 'whatsAppConversation')).toBe(false);
      expect(calls.filter((c) => c.model === 'whatsAppAccountLink').every((c) => c.args.where.userId === 'u1')).toBe(true);
    }
  });

  it('shows which settings are missing by name, never their values', async () => {
    const saved = process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    process.env.WHATSAPP_APP_SECRET = 'super-secret-value';
    const d = await getWhatsAppDashboard({ companyId: 'co_A', userId: 'u1', role: 'OWNER' });
    expect(d.integration.configured).toBe(false);
    expect(d.integration.missing).toContain('WHATSAPP_ACCESS_TOKEN');
    expect(JSON.stringify(d)).not.toContain('super-secret-value');
    if (saved !== undefined) process.env.WHATSAPP_ACCESS_TOKEN = saved;
    delete process.env.WHATSAPP_APP_SECRET;
  });
});

describe('GET /api/whatsapp/conversations (listWorkspaceConversations)', () => {
  it('owners/admins: the workspace; everyone else: their own number only — and always only this workspace', async () => {
    await listWorkspaceConversations({ companyId: 'co_A' });
    const all = calls.find((c) => c.model === 'whatsAppMessage')!;
    expect(all.args.where).toEqual({ companyId: 'co_A' });

    calls.length = 0;
    await listWorkspaceConversations({ companyId: 'co_A', userId: 'u_member' });
    const mine = calls.find((c) => c.model === 'whatsAppMessage')!;
    expect(mine.args.where).toEqual({ companyId: 'co_A', conversation: { link: { is: { userId: 'u_member' } } } });
  });

  it('limits are clamped (no unbounded reads from a query string)', async () => {
    await listWorkspaceConversations({ companyId: 'co_A', limit: 10_000, messagesEach: 10_000 });
    expect(calls.find((c) => c.model === 'whatsAppMessage')!.args.take).toBe(50 * 50);
  });
});
