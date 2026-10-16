import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Extension tokens act with their holder's role: marking outreach sent or a
 * comment posted is an owner's/admin's action, as on the website; a MEMBER's
 * or VIEWER's token cannot do it.
 */

const s = vi.hoisted(() => ({ message: null as any, comment: null as any, updates: [] as any[] }));

vi.mock('@/lib/db', () => {
  const tx = {
    outreachMessage: { update: async (a: any) => void s.updates.push(['message', a]) },
    lead: { update: async (a: any) => void s.updates.push(['lead', a]) },
    engagementComment: { update: async (a: any) => void s.updates.push(['comment', a]), updateMany: async (a: any) => (s.updates.push(['comment', a]), { count: 1 }) },
    auditLog: { create: async () => ({}) },
  };
  return {
    db: {
      ...tx,
      $transaction: async (fn: any) => fn(tx),
      outreachMessage: { ...tx.outreachMessage, findFirst: async () => s.message },
      engagementComment: { ...tx.engagementComment, findFirst: async () => s.comment },
    },
  };
});

import { completeAction } from '@/server/extension/action.service';
import { outreachMetaAfter } from '@/server/approval/approval.service';

const ctx = (role: string) => ({ tokenId: 't', userId: 'u1', companyId: 'co1', membership: { role } as any });

beforeEach(() => {
  s.updates = [];
  const base = { id: 'm1', companyId: 'co1', leadId: 'l1', type: 'CONNECTION_NOTE', status: 'DRAFT', draftText: 'Hi', updatedAt: new Date(), aiMetadata: {} as any };
  s.message = { ...base, status: 'APPROVED', aiMetadata: outreachMetaAfter(base as any, { action: 'approved', by: 'u0', nextStatus: 'APPROVED', approve: true }) };
  s.comment = { id: 'c1', companyId: 'co1', status: 'APPROVED', draftText: 'Nice post' };
});

describe('extension writes follow the website’s roles', () => {
  it.each(['MEMBER', 'VIEWER'])('a %s token cannot mark outreach sent or a comment posted', async (role) => {
    await expect(completeAction({ ctx: ctx(role), itemType: 'outreach_message', itemId: 'm1' })).rejects.toMatchObject({ status: 403 });
    await expect(completeAction({ ctx: ctx(role), itemType: 'engagement_comment', itemId: 'c1' })).rejects.toMatchObject({ status: 403 });
    expect(s.updates).toHaveLength(0);
  });

  it('an admin token can mark approved outreach sent', async () => {
    await expect(completeAction({ ctx: ctx('ADMIN'), itemType: 'outreach_message', itemId: 'm1' })).resolves.toMatchObject({ ok: true });
    expect(s.updates.some(([k]) => k === 'message')).toBe(true);
  });

  it('another workspace’s item is not found, whatever the role', async () => {
    s.message = null;
    await expect(completeAction({ ctx: ctx('OWNER'), itemType: 'outreach_message', itemId: 'mX' })).rejects.toMatchObject({ status: 404 });
  });
});
