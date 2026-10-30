import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * Publishing approved blogs to websites (server/websites/publish.service.ts),
 * end to end through the service with an in-memory database and a fake
 * platform adapter. These are the acceptance rules:
 *
 *   - only approved, unchanged blogs are published — by people or the scheduler
 *   - a blog is published once per site: concurrent clicks, a click racing the
 *     scheduler, and retries never create a second post
 *   - a retry updates the post the site already has; after an interrupted
 *     attempt it first asks the site
 *   - the scheduler starts first attempts only; failures wait for a person
 *   - refused credentials mark the site "reconnect required", notify once,
 *     and its scheduled blogs wait
 *   - recurring auto-publish queues each approved blog once per site
 */

const s = vi.hoisted(() => ({
  seq: 0,
  pubs: [] as any[],
  sites: [] as any[],
  drafts: [] as any[],
  schedules: [] as any[],
  audits: [] as any[],
  emails: [] as any[],
  intact: new Set<string>(),
  marked: [] as string[],
}));
const adapter = vi.hoisted(() => ({
  publish: vi.fn(),
  findExisting: vi.fn(),
}));

const unique = () => new Prisma.PrismaClientKnownRequestError('Unique constraint', { code: 'P2002', clientVersion: 'test' });
const tick = () => new Date(Date.UTC(2026, 9, 30, 12) + ++s.seq);

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === 'websitePublications') return !s.pubs.some((p) => p.contentDraftId === row.id && p.websiteConnectionId === v.none.websiteConnectionId);
    if (k === 'asset') return true;
    if (v instanceof Date) return row[k]?.getTime() === v.getTime();
    if (v && typeof v === 'object') {
      if ('in' in v) return v.in.includes(row[k]);
      if ('lte' in v) return row[k] != null && row[k].getTime() <= v.lte.getTime();
      if ('lt' in v) return row[k] != null && row[k].getTime() < v.lt.getTime();
      if ('not' in v) return row[k] !== v.not;
    }
    return row[k] === v;
  });
}
const withRefs = (p: any) => ({ ...p, websiteConnection: s.sites.find((w) => w.id === p.websiteConnectionId), contentDraft: s.drafts.find((d) => d.id === p.contentDraftId) });
const keyOf = (where: any) => where.contentDraftId_websiteConnectionId;

vi.mock('@/lib/db', () => ({
  db: {
    websitePublication: {
      findUnique: async ({ where, include }: any) => {
        const k = keyOf(where);
        const r = k ? s.pubs.find((p) => p.contentDraftId === k.contentDraftId && p.websiteConnectionId === k.websiteConnectionId) : s.pubs.find((p) => p.id === where.id);
        return r ? (include ? withRefs(r) : { ...r }) : null;
      },
      findUniqueOrThrow: async ({ where, include }: any) => {
        const r = s.pubs.find((p) => p.id === where.id);
        if (!r) throw new Error('not found');
        return include ? withRefs(r) : { ...r };
      },
      findFirst: async ({ where }: any) => {
        const r = s.pubs.find((p) => matches(p, where));
        return r ? { ...r } : null;
      },
      findMany: async ({ where, include, take }: any) =>
        s.pubs
          .filter((p) => matches(p, where))
          .sort((a, b) => (a.scheduledFor?.getTime() ?? 0) - (b.scheduledFor?.getTime() ?? 0))
          .slice(0, take ?? 999)
          .map((p) => (include ? withRefs(p) : { ...p })),
      create: async ({ data }: any) => {
        await new Promise((r) => setTimeout(r, 1)); // let concurrent creates interleave
        if (s.pubs.some((p) => p.contentDraftId === data.contentDraftId && p.websiteConnectionId === data.websiteConnectionId)) throw unique();
        const row = {
          id: `pub_${++s.seq}`, attempts: 0, mode: 'publish', options: {}, seoReport: {}, remoteState: {}, log: [], externalId: null, externalUrl: null,
          scheduledFor: null, startedAt: null, publishedAt: null, errorCode: null, errorMessage: null, viaSchedule: false, createdAt: tick(), updatedAt: tick(), ...data,
        };
        s.pubs.push(row);
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        const r = s.pubs.find((p) => p.id === where.id)!;
        Object.assign(r, data, { updatedAt: tick() });
        return { ...r };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = s.pubs.filter((p) => matches(p, where));
        rows.forEach((p) => Object.assign(p, data, { updatedAt: tick() }));
        return { count: rows.length };
      },
    },
    websiteConnection: {
      findUniqueOrThrow: async ({ where }: any) => ({ ...s.sites.find((w) => w.id === where.id) }),
      findFirst: async ({ where }: any) => {
        const r = s.sites.find((w) => matches(w, where));
        return r ? { ...r } : null;
      },
      findMany: async ({ where }: any) => s.sites.filter((w) => matches(w, where)).map((w) => ({ ...w })),
      update: async ({ where, data }: any) => {
        const r = s.sites.find((w) => w.id === where.id)!;
        Object.assign(r, data);
        return { ...r };
      },
    },
    contentDraft: {
      findMany: async ({ where, take }: any) => s.drafts.filter((d) => matches(d, where)).slice(0, take ?? 999),
    },
    contentMedia: { findMany: async () => [], findFirst: async () => null },
    websitePublishSchedule: {
      findMany: async ({ where }: any) =>
        s.schedules.filter((x) => matches(x, where)).map((x) => ({ ...x, websiteConnection: s.sites.find((w) => w.id === x.websiteConnectionId), company: { timezone: 'UTC' } })),
      updateMany: async ({ where, data }: any) => {
        const rows = s.schedules.filter((x) => matches(x, where));
        rows.forEach((x) => Object.assign(x, data));
        return { count: rows.length };
      },
    },
    companyMember: { findMany: async () => [{ user: { id: 'u_admin', email: 'admin@example.com' } }] },
    auditLog: { create: async ({ data }: any) => s.audits.push(data) },
  },
}));

vi.mock('@/lib/crypto', () => ({ encrypt: (v: string) => v, decrypt: (v: string) => v }));
vi.mock('@/lib/email', () => ({ sendEmail: async (m: any) => (s.emails.push(m), { delivered: true }) }));
vi.mock('@/server/whatsapp/notify', () => ({ notifyUser: async () => 0 }));
vi.mock('@/server/media/asset.service', () => ({ getAsset: async () => ({}), readAssetBytes: async () => null }));
vi.mock('@/server/media/asset-url', () => ({ signedAssetUrl: () => ({ url: 'https://aura.example/img' }) }));
vi.mock('@/server/scheduling/schedule-input', () => ({ workspaceTimeZone: async () => 'UTC' }));
vi.mock('@/server/approval/approval.service', () => ({
  contentHash: async (d: any) => `hash_${d.id}`,
  assertContentIntact: async (d: any) => {
    if (!s.intact.has(d.id)) throw Object.assign(new Error('This content changed after it was approved.'), { status: 409 });
  },
}));
vi.mock('@/server/content/content.service', () => ({
  getDraft: async (_c: string, id: string) => s.drafts.find((d) => d.id === id) ?? null,
  markPublished: async ({ draftId }: any) => {
    s.marked.push(draftId);
    const d = s.drafts.find((x) => x.id === draftId)!;
    d.status = 'PUBLISHED';
  },
}));
vi.mock('@/server/websites/registry', () => ({
  getAdapter: (p: string) => (p === 'wordpress' ? { id: 'wordpress', publish: adapter.publish, findExisting: adapter.findExisting } : null),
}));

import {
  claimWebsitePublication,
  requestWebsitePublish,
  retryWebsitePublication,
  runDueWebsitePublishing,
  WEBSITE_PUBLISH_LEASE_MS,
} from '@/server/websites/publish.service';
import { WebsitePublishError } from '@/server/websites/types';

const blogBody = { headline: 'Brew Better', subtitle: '', sections: [{ heading: 'A', body: 'a' }, { heading: 'B', body: 'b' }], tags: ['coffee'] };

function draft(id: string, status = 'APPROVED', updatedAt = new Date('2026-10-01')) {
  const d = { id, companyId: 'c1', type: 'BLOG', status, title: null, body: blogBody, platform: null, aiMetadata: {}, updatedAt };
  s.drafts.push(d);
  if (status === 'APPROVED' || status === 'PUBLISHED') s.intact.add(id);
  return d;
}

function site(id = 'w1', over: Record<string, unknown> = {}) {
  const w = { id, companyId: 'c1', platform: 'wordpress', name: `Site ${id}`, siteUrl: `https://${id}.example`, status: 'CONNECTED', authKind: 'app_password', credentialsEnc: '{"username":"ed","appPassword":"x"}', settings: {}, capabilities: {}, lastError: null, accountLabel: 'Ed', createdAt: new Date(), ...over };
  s.sites.push(w);
  return w;
}

const owner = { companyId: 'c1', userId: 'u1', role: 'OWNER' as const };
const now = () => ({ kind: 'now' as const });

let created = 0;
function sitePublishes(opts: { delayMs?: number } = {}) {
  adapter.publish.mockImplementation(async (_ctx: any, payload: any, existing: any, _state: any, checkpoint: any) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    let externalId = existing?.externalId;
    if (!externalId) {
      externalId = `post_${++created}`;
      await checkpoint({ externalId });
    }
    return { externalId, url: `https://w1.example/${payload.options.slug}`, status: payload.mode === 'draft' ? 'drafted' : 'published', seoReport: { slug: { outcome: 'applied' } } };
  });
}

beforeEach(() => {
  Object.assign(s, { seq: 0, pubs: [], sites: [], drafts: [], schedules: [], audits: [], emails: [], intact: new Set(), marked: [] });
  created = 0;
  adapter.publish.mockReset();
  adapter.findExisting.mockReset().mockResolvedValue(null);
  sitePublishes();
});

describe('approval gate', () => {
  it('refuses a blog that is not approved', async () => {
    draft('d1', 'PENDING_APPROVAL');
    site();
    await expect(requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: now() })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Approve this blog first/) });
    expect(adapter.publish).not.toHaveBeenCalled();
  });

  it('refuses a blog changed after it was approved', async () => {
    draft('d1');
    s.intact.delete('d1');
    site();
    await expect(requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: now() })).rejects.toMatchObject({ status: 409 });
    expect(adapter.publish).not.toHaveBeenCalled();
  });

  it('refuses people who may not publish', async () => {
    draft('d1');
    site();
    await expect(requestWebsitePublish({ ...owner, role: 'MEMBER', draftId: 'd1', websiteId: 'w1', mode: 'publish', when: now() })).rejects.toMatchObject({ status: 403 });
  });
});

describe('publishing now', () => {
  it('publishes, records the post, and marks the blog published', async () => {
    draft('d1');
    site();
    const v = await requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: now() });
    expect(v).toMatchObject({ state: 'published', externalUrl: 'https://w1.example/brew-better', attempts: 1 });
    expect(s.pubs[0]).toMatchObject({ externalId: 'post_1', status: 'PUBLISHED', startedAt: null });
    expect(s.marked).toEqual(['d1']);
    expect(s.audits.map((a) => a.action)).toContain('WEBSITE_PUBLISHED');
  });

  it('saves as a draft on the site without marking the blog published', async () => {
    draft('d1');
    site();
    const v = await requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'draft', when: now() });
    expect(v.state).toBe('drafted');
    expect(s.marked).toEqual([]);
    // Publishing it afterwards updates that same post — it goes live, no second post.
    const live = await requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: now() });
    expect(live.state).toBe('published');
    expect(created).toBe(1);
    expect(adapter.publish.mock.calls[1]![2]).toEqual({ externalId: 'post_1' });
  });

  it('two simultaneous clicks publish once', async () => {
    draft('d1');
    site();
    sitePublishes({ delayMs: 20 });
    const results = await Promise.allSettled([
      requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: now() }),
      requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: now() }),
    ]);
    expect(created).toBe(1);
    expect(adapter.publish).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message).toMatch(/being published right now/);
  });

  it('publishes the same blog to two websites independently (multi-site)', async () => {
    draft('d1');
    site('w1');
    site('w2');
    await requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: now() });
    await requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w2', mode: 'publish', when: now() });
    expect(s.pubs.map((p) => [p.websiteConnectionId, p.status])).toEqual([
      ['w1', 'PUBLISHED'],
      ['w2', 'PUBLISHED'],
    ]);
  });
});

describe('failures and retries', () => {
  it('explains a failure, and the retry updates the post the site already has', async () => {
    draft('d1');
    site();
    // The post is created, then the site errors (e.g. while setting meta).
    adapter.publish.mockImplementationOnce(async (_c: any, _p: any, _e: any, _s: any, checkpoint: any) => {
      await checkpoint({ externalId: 'post_77' });
      throw new WebsitePublishError('network', 'blog.example had a server error (HTTP 502).');
    });
    const failed = await requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: now() });
    expect(failed).toMatchObject({ state: 'failed', errorCode: 'network', retryable: true });
    expect(failed.errorMessage).toMatch(/HTTP 502.*press Retry/);
    expect(s.sites[0].status).toBe('ERROR');

    const retried = await retryWebsitePublication({ ...owner, publicationId: failed.id });
    expect(retried.state).toBe('published');
    expect(adapter.publish.mock.calls[1]![2]).toEqual({ externalId: 'post_77' });
    expect(created).toBe(0); // never a second post
    expect(s.sites[0].status).toBe('CONNECTED'); // a success clears the error
  });

  it('after an attempt that never reported back, asks the site before creating anything', async () => {
    draft('d1');
    site();
    // A publication stuck mid-attempt (the function was stopped), no id recorded.
    s.pubs.push({ id: 'pub_x', companyId: 'c1', contentDraftId: 'd1', websiteConnectionId: 'w1', status: 'PUBLISHING', mode: 'publish', options: {}, remoteState: {}, log: [], attempts: 1, externalId: null, startedAt: new Date(Date.now() - WEBSITE_PUBLISH_LEASE_MS - 1000), createdAt: new Date(), updatedAt: new Date() });
    adapter.findExisting.mockResolvedValue({ externalId: 'post_found' });
    const v = await retryWebsitePublication({ ...owner, publicationId: 'pub_x' });
    expect(adapter.findExisting).toHaveBeenCalledTimes(1);
    expect(adapter.publish.mock.calls[0]![2]).toEqual({ externalId: 'post_found' });
    expect(v.state).toBe('published');
    expect(created).toBe(0);
  });

  it('refused credentials: reconnect required, admins told once, and retry refused until reconnected', async () => {
    draft('d1');
    draft('d2');
    site();
    adapter.publish.mockRejectedValue(new WebsitePublishError('auth', 'blog.example rejected the Application Password.'));
    const v = await requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: now() });
    expect(v.errorMessage).toMatch(/Reconnect Site w1/);
    expect(s.sites[0].status).toBe('REAUTH_REQUIRED');
    expect(s.emails).toHaveLength(1);
    expect(s.emails[0].subject).toMatch(/Reconnect Site w1/);
    expect(s.audits.filter((a) => a.action === 'WEBSITE_REAUTH_REQUIRED')).toHaveLength(1);

    await expect(retryWebsitePublication({ ...owner, publicationId: v.id })).rejects.toMatchObject({ status: 409 });
    await expect(requestWebsitePublish({ ...owner, draftId: 'd2', websiteId: 'w1', mode: 'publish', when: now() })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Reconnect/) });
    expect(s.emails).toHaveLength(1); // told once, not per failure
  });
});

describe('scheduling', () => {
  it('schedules a blog, and the scheduler publishes it once its time has come', async () => {
    draft('d1');
    site();
    const at = new Date(Date.now() + 2 * 3600_000);
    const v = await requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: { kind: 'later', at } });
    expect(v).toMatchObject({ state: 'scheduled', scheduledFor: at.toISOString(), cancellable: true });

    expect((await runDueWebsitePublishing(new Date())).attempted).toBe(0); // not yet
    const r = await runDueWebsitePublishing(new Date(at.getTime() + 1000));
    expect(r).toMatchObject({ attempted: 1, published: 1 });
    expect(s.pubs[0].status).toBe('PUBLISHED');
    // Run again: nothing more.
    expect((await runDueWebsitePublishing(new Date(at.getTime() + 60_000))).attempted).toBe(0);
    expect(created).toBe(1);
  });

  it('refuses a time in the past', async () => {
    draft('d1');
    site();
    await expect(requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: { kind: 'later', at: new Date(Date.now() - 60_000) } })).rejects.toMatchObject({ status: 422 });
  });

  it('never publishes a scheduled blog that changed after approval', async () => {
    draft('d1');
    site();
    const at = new Date(Date.now() + 3600_000);
    await requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: { kind: 'later', at } });
    s.intact.delete('d1'); // edited since
    const r = await runDueWebsitePublishing(new Date(at.getTime() + 1000));
    expect(r.failed).toBe(1);
    expect(adapter.publish).not.toHaveBeenCalled();
    expect(s.pubs[0]).toMatchObject({ status: 'FAILED', errorCode: 'validation' });
    expect(s.pubs[0].errorMessage).toMatch(/changed after it was approved/);
  });

  it('does not retry a failure on its own', async () => {
    draft('d1');
    site();
    const at = new Date(Date.now() + 3600_000);
    await requestWebsitePublish({ ...owner, draftId: 'd1', websiteId: 'w1', mode: 'publish', when: { kind: 'later', at } });
    adapter.publish.mockRejectedValueOnce(new WebsitePublishError('rate_limit', 'Slow down.'));
    await runDueWebsitePublishing(new Date(at.getTime() + 1000));
    await runDueWebsitePublishing(new Date(at.getTime() + 600_000));
    expect(adapter.publish).toHaveBeenCalledTimes(1);
    expect(s.pubs[0].status).toBe('FAILED');
  });

  it('holds scheduled blogs for a site that needs reconnecting', async () => {
    draft('d1');
    site('w1', { status: 'REAUTH_REQUIRED' });
    s.pubs.push({ id: 'p1', companyId: 'c1', contentDraftId: 'd1', websiteConnectionId: 'w1', status: 'SCHEDULED', scheduledFor: new Date(Date.now() - 1000), mode: 'publish', options: {}, remoteState: {}, log: [], attempts: 0, createdAt: new Date(), updatedAt: new Date() });
    const r = await runDueWebsitePublishing(new Date());
    expect(r).toMatchObject({ waiting: 1, attempted: 0 });
    expect(s.pubs[0].status).toBe('SCHEDULED');
  });

  it('marks an interrupted attempt failed for a person — never re-runs it itself', async () => {
    draft('d1');
    site();
    s.pubs.push({ id: 'p1', companyId: 'c1', contentDraftId: 'd1', websiteConnectionId: 'w1', status: 'PUBLISHING', startedAt: new Date(Date.now() - WEBSITE_PUBLISH_LEASE_MS - 5000), mode: 'publish', options: {}, remoteState: {}, log: [], attempts: 1, createdAt: new Date(), updatedAt: new Date() });
    const r = await runDueWebsitePublishing(new Date());
    expect(r.interrupted).toBe(1);
    expect(adapter.publish).not.toHaveBeenCalled();
    expect(s.pubs[0].status).toBe('FAILED');
    expect(s.pubs[0].errorMessage).toMatch(/checks the site for the post first/);
  });

  it('the scheduler cannot take over a publish a person is running', async () => {
    draft('d1');
    site();
    s.pubs.push({ id: 'p1', companyId: 'c1', contentDraftId: 'd1', websiteConnectionId: 'w1', status: 'PUBLISHING', startedAt: new Date(), scheduledFor: new Date(Date.now() - 1000), mode: 'publish', options: {}, remoteState: {}, log: [], attempts: 1, createdAt: new Date(), updatedAt: new Date() });
    const claim = await claimWebsitePublication({ companyId: 'c1', draftId: 'd1', websiteId: 'w1', userId: null, automatic: true });
    expect(claim).toMatchObject({ claimed: false, reason: 'in_progress' });
  });
});

describe('recurring auto-publish', () => {
  it('queues approved blogs only, oldest approval first, one per slot, each once per site', async () => {
    draft('old', 'APPROVED', new Date('2026-09-01'));
    draft('new', 'APPROVED', new Date('2026-10-01'));
    draft('pending', 'PENDING_APPROVAL', new Date('2026-08-01'));
    draft('rejected', 'REJECTED', new Date('2026-08-01'));
    site();
    const slot = new Date(Date.UTC(2026, 10, 2, 9)); // Mon 09:00
    s.schedules.push({ id: 'sch', companyId: 'c1', websiteConnectionId: 'w1', enabled: true, weekdays: [1, 3], timeOfDay: '09:00', mode: 'publish', postsPerSlot: 1, nextRunAt: slot });

    const first = await runDueWebsitePublishing(new Date(slot.getTime() + 1000));
    expect(first).toMatchObject({ queued: 1, published: 1 });
    expect(s.pubs.map((p) => [p.contentDraftId, p.viaSchedule])).toEqual([['old', true]]);
    // The slot moved on to Wednesday 09:00.
    expect(s.schedules[0].nextRunAt.toISOString()).toBe('2026-11-04T09:00:00.000Z');

    // Same instant again (an overlapping cron run): nothing new.
    expect((await runDueWebsitePublishing(new Date(slot.getTime() + 2000))).queued).toBe(0);

    const second = await runDueWebsitePublishing(new Date(Date.UTC(2026, 10, 4, 9, 0, 1)));
    expect(second.queued).toBe(1);
    expect(s.pubs.map((p) => p.contentDraftId)).toEqual(['old', 'new']);

    // Nothing approved is left: later slots queue nothing, and never the unapproved ones.
    const third = await runDueWebsitePublishing(new Date(Date.UTC(2026, 10, 9, 9, 0, 1)));
    expect(third.queued).toBe(0);
    expect(s.pubs.some((p) => p.contentDraftId === 'pending' || p.contentDraftId === 'rejected')).toBe(false);
  });
});
