import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The publishing scheduler (docs/SCHEDULER.md): authentication, which posts
 * it picks, its time budget and what it reports. The end-to-end proof —
 * real database, overlapping runs, retries, timezones — is
 * scripts/verify-scheduler.ts.
 */

const s = vi.hoisted(() => ({ findManyArgs: null as any, due: [] as any[], cancelled: new Set<string>() }));

vi.mock('@/lib/db', () => ({
  db: {
    contentDraft: {
      findMany: async (args: any) => {
        s.findManyArgs = args;
        return s.due;
      },
    },
  },
}));
vi.mock('@/server/execution/execution-actions.service', () => ({ cancelledFor: async () => s.cancelled }));

import { isCronAuthorized } from '@/lib/cron-auth';
import { runScheduledPublishes } from '@/server/content/publish.service';

const req = (auth?: string) => new Request('https://aura.example/api/cron/publish', { headers: auth ? { authorization: auth } : {} });

describe('CRON_SECRET authentication', () => {
  it('accepts exactly "Bearer <secret>" and nothing else', () => {
    expect(isCronAuthorized(req('Bearer s3cret-value'), 's3cret-value')).toBe(true);
    expect(isCronAuthorized(req('Bearer s3cret-valuX'), 's3cret-value')).toBe(false);
    expect(isCronAuthorized(req('s3cret-value'), 's3cret-value')).toBe(false);
    expect(isCronAuthorized(req('Bearer s3cret'), 's3cret-value')).toBe(false); // a prefix is not enough
    expect(isCronAuthorized(req(), 's3cret-value')).toBe(false);
  });

  it('is closed when CRON_SECRET is not set (never open by accident)', () => {
    expect(isCronAuthorized(req('Bearer '), '')).toBe(false);
    expect(isCronAuthorized(req('Bearer undefined'), undefined)).toBe(false);
  });
});

describe('which posts the scheduler picks', () => {
  beforeEach(() => {
    s.due = [];
    s.cancelled = new Set();
  });

  it('only approved, due, unpublished posts — oldest first — and not ones already in a person’s hands', async () => {
    const now = new Date('2026-10-22T03:30:00Z');
    await runScheduledPublishes(now, { publish: vi.fn() });
    const { where, orderBy, take } = s.findManyArgs;
    expect(where.status).toBe('APPROVED');
    expect(where.scheduledFor).toEqual({ lte: now }); // UTC instants: timezone-independent
    expect(where.publishedAt).toBeNull();
    // Failed / manual (a person retries), processing, published: never re-picked.
    expect(where.NOT).toEqual({ publications: { some: { status: { in: ['FAILED', 'MANUAL', 'PROCESSING', 'PUBLISHED'] } } } });
    expect(orderBy).toEqual([{ scheduledFor: 'asc' }, { id: 'asc' }]);
    expect(take).toBe(100);
  });

  it('each publish is automatic (the scheduler never retries a failed attempt itself)', async () => {
    s.due = [{ id: 'd1', companyId: 'c1', type: 'LINKEDIN_POST', platform: 'LINKEDIN' }];
    const publish = vi.fn(async () => ({ mode: 'published' as const, url: 'u' }));
    await runScheduledPublishes(new Date(), { publish });
    expect(publish).toHaveBeenCalledWith({ companyId: 'c1', userId: null, draftId: 'd1', automatic: true });
  });

  it('cancelled executions are skipped', async () => {
    s.due = [
      { id: 'd1', companyId: 'c1', type: 'LINKEDIN_POST', platform: 'LINKEDIN' },
      { id: 'd2', companyId: 'c1', type: 'LINKEDIN_POST', platform: 'LINKEDIN' },
    ];
    s.cancelled = new Set(['d1']);
    const publish = vi.fn(async () => ({ mode: 'published' as const, url: 'u' }));
    const r = await runScheduledPublishes(new Date(), { publish });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ attempted: 2, published: 1, skipped: 1, deferred: 0 });
  });

  it('stops starting publishes at its deadline; the rest are deferred to the next run', async () => {
    s.due = ['a', 'b', 'c'].map((id) => ({ id, companyId: 'c1', type: 'LINKEDIN_POST', platform: 'LINKEDIN' }));
    let clock = 0;
    const publish = vi.fn(async () => {
      clock += 1;
      if (clock === 1) await new Promise((r) => setTimeout(r, 30));
      return { mode: 'published' as const, url: 'u' };
    });
    const r = await runScheduledPublishes(new Date(), { publish, deadline: new Date(Date.now() + 15) });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ attempted: 1, published: 1, skipped: 0, deferred: 2 });
  });

  it('a post another run published first is not counted as this run’s publish', async () => {
    s.due = [{ id: 'd1', companyId: 'c1', type: 'LINKEDIN_POST', platform: 'LINKEDIN' }];
    const publish = vi.fn(async () => ({ mode: 'published' as const, url: 'u', alreadyPublished: true }));
    expect(await runScheduledPublishes(new Date(), { publish })).toEqual({ attempted: 1, published: 0, skipped: 1, deferred: 0 });
  });

  it('a publish that throws is counted and does not stop the run', async () => {
    s.due = ['a', 'b'].map((id) => ({ id, companyId: 'c1', type: 'LINKEDIN_POST', platform: 'LINKEDIN' }));
    const publish = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ mode: 'published', url: 'u' });
    expect(await runScheduledPublishes(new Date(), { publish })).toEqual({ attempted: 2, published: 1, skipped: 1, deferred: 0 });
  });
});
