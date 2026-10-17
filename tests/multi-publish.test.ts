import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * One-click publishing to Facebook, Instagram and LinkedIn (Phase 6): the
 * publication claim that makes double posting impossible, approval as part of
 * the action, each network independent (a failure keeps the successes), no
 * automatic republishing, and the per-network preview. The networks are
 * mocked; every call to them is counted.
 */

const s = vi.hoisted(() => ({
  pubs: [] as any[],
  audits: [] as any[],
  seq: 0,
  draft: null as any,
  media: [] as any[],
  meta: null as any,
  linkedin: null as any,
  intact: true,
}));
const m = vi.hoisted(() => ({
  publishTo: vi.fn(),
  runReviewAction: vi.fn(),
  markPublished: vi.fn(),
}));

const unique = () => new Prisma.PrismaClientKnownRequestError('Unique constraint', { code: 'P2002', clientVersion: 'test' });
const tick = () => new Date(Date.now() + ++s.seq);
const matches = (row: any, where: any) =>
  Object.entries(where).every(([k, v]: [string, any]) => (v instanceof Date ? row[k]?.getTime() === v.getTime() : row[k] === v));

vi.mock('@/lib/db', () => ({
  db: {
    contentPublication: {
      findUnique: async ({ where }: any) => {
        const k = where.contentDraftId_platform;
        const r = s.pubs.find((p) => p.contentDraftId === k.contentDraftId && p.platform === k.platform);
        return r ? { ...r } : null;
      },
      create: async ({ data }: any) => {
        await new Promise((r) => setTimeout(r, 1)); // let concurrent creates interleave
        if (s.pubs.some((p) => p.contentDraftId === data.contentDraftId && p.platform === data.platform)) throw unique();
        const row = { id: `pub_${++s.seq}`, url: null, publishedAt: null, message: null, createdAt: tick(), updatedAt: tick(), ...data };
        s.pubs.push(row);
        return { ...row };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = s.pubs.filter((p) => matches(p, where));
        rows.forEach((p) => Object.assign(p, data, { updatedAt: tick() }));
        return { count: rows.length };
      },
      findMany: async ({ where }: any) => s.pubs.filter((p) => p.companyId === where.companyId && p.contentDraftId === where.contentDraftId),
    },
    connection: { findUnique: async () => s.meta },
    contentMedia: { findMany: async () => s.media },
    auditLog: { create: async ({ data }: any) => s.audits.push(data) },
  },
}));
// Connection Manager gate (server/connections/health.service.ts) is tested on its own.
vi.mock('@/server/connections/health.service', () => ({
  connectionGate: async () => ({ allowed: true, noRecord: true, connectorId: null, health: null, reason: null, fix: null }),
  recordExecutionResult: async () => undefined,
}));
vi.mock('@/server/content/content.service', () => ({
  getDraft: async (companyId: string, id: string) => (s.draft && s.draft.id === id && s.draft.companyId === companyId ? { ...s.draft } : null),
  markPublished: m.markPublished,
}));
vi.mock('@/server/approval/approval.service', () => ({
  assertContentIntact: async () => {
    if (!s.intact) throw Object.assign(new Error('Changed since it was approved.'), { status: 409, code: 'changed_after_approval' });
  },
  contentHash: async () => 'HASH1',
}));
vi.mock('@/server/review/review-actions.service', () => ({ runReviewAction: m.runReviewAction }));
vi.mock('@/server/services/linkedin.service', () => ({ getPublishContext: async () => s.linkedin }));
vi.mock('@/server/content/render', () => ({
  renderForManual: (d: any) => d.body.text,
  renderLinkedInCommentary: (d: any) => `${d.body.text} (LinkedIn)`,
}));
vi.mock('@/server/content/publish.service', async (orig) => ({
  ...(await orig<typeof import('@/server/content/publish.service')>()),
  publishTo: m.publishTo,
}));

import { claimPublication, finishPublication, PUBLISH_LEASE_MS } from '@/server/content/publication-store';
import { previewPublishing, publishToPlatforms } from '@/server/content/multi-publish.service';

const OWNER = { companyId: 'co1', userId: 'u1', role: 'OWNER' as const, draftId: 'd1' };
const jpeg = { asset: { mimeType: 'image/jpeg', width: 1080, height: 1080, fileSize: 200_000 } };

beforeEach(() => {
  s.pubs = [];
  s.audits = [];
  s.draft = { id: 'd1', companyId: 'co1', type: 'LINKEDIN_POST', platform: 'LINKEDIN', status: 'APPROVED', body: { text: 'Our weekend brunch is back.' } };
  s.media = [jpeg];
  s.meta = { status: 'CONNECTED', expiresAt: new Date(Date.now() + 30 * 86_400_000), metadata: { pageId: '1', igUserId: '2' } };
  s.linkedin = { scope: 'openid w_member_social', linkedInUserId: 'li1' };
  s.intact = true;
  m.publishTo.mockReset();
  m.runReviewAction.mockReset();
  m.markPublished.mockReset();
  m.publishTo.mockImplementation(async ({ platform }: any) => ({ mode: 'published', url: `https://${platform.toLowerCase()}.example/post` }));
  m.markPublished.mockResolvedValue({});
});

describe('the publication claim — never posted twice', () => {
  const claim = (extra: Record<string, unknown> = {}) =>
    claimPublication({ companyId: 'co1', draftId: 'd1', platform: 'FACEBOOK', contentHash: 'H', userId: 'u1', ...extra });

  it('the first attempt holds it; a second waits; once published it is never claimed again', async () => {
    const first = await claim();
    expect(first.claimed).toBe(true);
    expect(await claim()).toMatchObject({ claimed: false, reason: 'in_progress' });
    await finishPublication(first.publication!.id, { status: 'PUBLISHED', url: 'u' });
    expect(await claim()).toMatchObject({ claimed: false, reason: 'already_published' });
  });

  it('five simultaneous attempts: exactly one claims it', async () => {
    const all = await Promise.all(Array.from({ length: 5 }, () => claim()));
    expect(all.filter((c) => c.claimed)).toHaveLength(1);
    expect(s.pubs).toHaveLength(1);
  });

  it('a failure is retried by a person, never by the scheduler', async () => {
    const first = await claim();
    await finishPublication(first.publication!.id, { status: 'FAILED', message: 'Meta was down' });
    expect(await claim({ automatic: true })).toMatchObject({ claimed: false, reason: 'needs_person' });
    const retry = await claim();
    expect(retry).toMatchObject({ claimed: true, publication: { attempts: 2, status: 'PUBLISHING', message: null } });
  });

  it('an attempt that never finished is not silently re-posted: it becomes FAILED for a person to check', async () => {
    const first = await claim();
    const later = new Date(first.publication!.startedAt!.getTime() + PUBLISH_LEASE_MS + 1000);
    const r = await claim({ now: later });
    expect(r).toMatchObject({ claimed: false, reason: 'interrupted' });
    expect(s.pubs[0].status).toBe('FAILED');
    expect(s.pubs[0].message).toMatch(/Check the account for the post before retrying/);
  });

  it('only the attempt holding the claim records the outcome', async () => {
    const first = await claim();
    await finishPublication(first.publication!.id, { status: 'PUBLISHED', url: 'a' });
    await finishPublication(first.publication!.id, { status: 'FAILED', message: 'late' });
    expect(s.pubs[0]).toMatchObject({ status: 'PUBLISHED', url: 'a' });
  });
});

describe('the preview', () => {
  it('shows each network its exact text, and why it cannot go', async () => {
    s.linkedin = null;
    s.meta.metadata = { pageId: '1' }; // no Instagram linked
    const p = await previewPublishing('co1', s.draft);
    const by = Object.fromEntries(p.map((x) => [x.platform, x]));
    expect(by.FACEBOOK).toMatchObject({ ready: true, text: 'Our weekend brunch is back.' });
    expect(by.LINKEDIN!.ready).toBe(false);
    expect(by.LINKEDIN!.text).toBe('Our weekend brunch is back. (LinkedIn)');
    expect(by.LINKEDIN!.blockers.join()).toMatch(/LinkedIn isn’t connected/);
    expect(by.INSTAGRAM!.blockers.join()).toMatch(/No Instagram Business or Creator account/);
  });

  it('Instagram needs an image; LinkedIn’s API does not take every format', async () => {
    s.media = [];
    s.draft.type = 'TWEET_THREAD';
    const p = await previewPublishing('co1', s.draft);
    expect(p.find((x) => x.platform === 'INSTAGRAM')!.blockers.join()).toMatch(/need an image/);
    expect(p.find((x) => x.platform === 'LINKEDIN')!.blockers.join()).toMatch(/doesn’t take this format/);
  });
});

describe('Approve & Publish to Selected Platforms', () => {
  it('publishes to each chosen network; the piece is marked published once', async () => {
    const r = await publishToPlatforms({ ...OWNER, platforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'] });
    expect(r.results.map((x) => [x.platform, x.status])).toEqual([
      ['FACEBOOK', 'published'],
      ['INSTAGRAM', 'published'],
      ['LINKEDIN', 'published'],
    ]);
    expect(m.publishTo).toHaveBeenCalledTimes(3);
    expect(m.markPublished).toHaveBeenCalledTimes(1);
    expect(s.pubs.every((p) => p.status === 'PUBLISHED' && p.contentHash === 'HASH1')).toBe(true);
    expect(s.audits.find((a) => a.action === 'CONTENT_PUBLISH_REQUESTED').metadata.platforms).toEqual(['FACEBOOK', 'INSTAGRAM', 'LINKEDIN']);
  });

  it('one network failing keeps the others’ successes', async () => {
    m.publishTo.mockImplementation(async ({ platform }: any) => {
      if (platform === 'INSTAGRAM') throw new Error('Instagram is down');
      return { mode: 'published', url: `https://${platform}.example` };
    });
    const r = await publishToPlatforms({ ...OWNER, platforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'] });
    const status = Object.fromEntries(r.results.map((x) => [x.platform, x.status]));
    expect(status).toEqual({ FACEBOOK: 'published', INSTAGRAM: 'failed', LINKEDIN: 'published' });
    expect(s.pubs.find((p) => p.platform === 'INSTAGRAM')).toMatchObject({ status: 'FAILED', message: 'Instagram is down' });
    expect(s.audits.some((a) => a.action === 'CONTENT_PUBLISH_FAILED' && a.metadata.platform === 'INSTAGRAM')).toBe(true);
  });

  it('a retry posts only what failed — successes are never republished', async () => {
    m.publishTo.mockImplementationOnce(async () => ({ mode: 'published', url: 'fb' })).mockImplementationOnce(async () => {
      throw new Error('Instagram is down');
    });
    await publishToPlatforms({ ...OWNER, platforms: ['FACEBOOK', 'INSTAGRAM'] });
    s.draft.status = 'PUBLISHED';
    m.publishTo.mockClear();
    m.publishTo.mockImplementation(async () => ({ mode: 'published', url: 'ig' }));
    const r = await publishToPlatforms({ ...OWNER, platforms: ['FACEBOOK', 'INSTAGRAM'] });
    expect(m.publishTo).toHaveBeenCalledTimes(1);
    expect(m.publishTo).toHaveBeenCalledWith(expect.objectContaining({ platform: 'INSTAGRAM' }));
    expect(r.results.find((x) => x.platform === 'FACEBOOK')).toMatchObject({ status: 'skipped', message: 'Already published here — not posted again.' });
  });

  it('a double click (two requests at once) posts each network once', async () => {
    m.publishTo.mockImplementation(async ({ platform }: any) => {
      await new Promise((r) => setTimeout(r, 5));
      return { mode: 'published', url: platform };
    });
    await Promise.all([
      publishToPlatforms({ ...OWNER, platforms: ['FACEBOOK', 'LINKEDIN'] }),
      publishToPlatforms({ ...OWNER, platforms: ['FACEBOOK', 'LINKEDIN'] }),
    ]);
    const calls = m.publishTo.mock.calls.map((c) => c[0].platform).sort();
    expect(calls).toEqual(['FACEBOOK', 'LINKEDIN']);
  });

  it('not yet approved: it is approved first, by the review screen’s own approval', async () => {
    s.draft.status = 'PENDING_APPROVAL';
    m.runReviewAction.mockImplementation(async () => {
      s.draft.status = 'APPROVED';
      return { status: 'APPROVED', message: 'Approved.' };
    });
    const r = await publishToPlatforms({ ...OWNER, platforms: ['FACEBOOK'] });
    expect(m.runReviewAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1', role: 'OWNER', input: { action: 'approve', confirmed: false } }));
    expect(r.approvedNow).toBe(true);
  });

  it('when the approval needs a person to vouch, nothing is published', async () => {
    s.draft.status = 'PENDING_APPROVAL';
    m.runReviewAction.mockRejectedValue(Object.assign(new Error('1 claim could not be verified.'), { status: 409, code: 'facts_need_review' }));
    await expect(publishToPlatforms({ ...OWNER, platforms: ['FACEBOOK'] })).rejects.toMatchObject({ code: 'facts_need_review' });
    expect(m.publishTo).not.toHaveBeenCalled();
    m.runReviewAction.mockReset().mockImplementation(async () => {
      s.draft.status = 'APPROVED';
      return {};
    });
    await publishToPlatforms({ ...OWNER, platforms: ['FACEBOOK'], acknowledged: true });
    expect(m.runReviewAction).toHaveBeenCalledWith(expect.objectContaining({ input: { action: 'approve', confirmed: true } }));
  });

  it('members and viewers cannot publish; content changed since approval is refused', async () => {
    for (const role of ['MEMBER', 'VIEWER'] as const) {
      await expect(publishToPlatforms({ ...OWNER, role, platforms: ['FACEBOOK'] })).rejects.toMatchObject({ status: 403 });
    }
    s.intact = false;
    await expect(publishToPlatforms({ ...OWNER, platforms: ['FACEBOOK'] })).rejects.toMatchObject({ code: 'changed_after_approval' });
    expect(m.publishTo).not.toHaveBeenCalled();
  });

  it('a network that cannot go is skipped with its reason; the others go', async () => {
    s.linkedin = null;
    const r = await publishToPlatforms({ ...OWNER, platforms: ['LINKEDIN', 'FACEBOOK'] });
    expect(r.results[0]).toMatchObject({ platform: 'LINKEDIN', status: 'skipped' });
    expect(r.results[1]).toMatchObject({ platform: 'FACEBOOK', status: 'published' });
    expect(m.publishTo).toHaveBeenCalledTimes(1);
  });

  it('another business’s draft is not found', async () => {
    await expect(publishToPlatforms({ ...OWNER, companyId: 'co_other', platforms: ['FACEBOOK'] })).rejects.toMatchObject({ status: 404 });
  });
});

describe('Instagram still processing (Reels)', () => {
  it('a processing post is not claimed again (no second upload) and the preview says why', async () => {
    const first = await claimPublication({ companyId: 'co1', draftId: 'd1', platform: 'INSTAGRAM', contentHash: 'H', userId: 'u1' });
    await finishPublication(first.publication!.id, { status: 'PROCESSING', externalId: 'container:1', message: 'processing' });
    expect(s.pubs[0]).toMatchObject({ status: 'PROCESSING', externalId: 'container:1', startedAt: null });
    expect(await claimPublication({ companyId: 'co1', draftId: 'd1', platform: 'INSTAGRAM', contentHash: 'H', userId: 'u1' })).toMatchObject({
      claimed: false,
      reason: 'in_progress',
    });
    const ig = (await previewPublishing('co1', s.draft)).find((p) => p.platform === 'INSTAGRAM')!;
    expect(ig.ready).toBe(false);
    expect(ig.blockers.join(' ')).toMatch(/still processing/);
  });

  it('one click: Instagram “processing” is reported as such, never as published', async () => {
    m.publishTo.mockImplementation(async ({ platform }: any) =>
      platform === 'INSTAGRAM'
        ? { mode: 'processing', externalId: 'container:9', message: 'Instagram is processing the video.' }
        : { mode: 'published', url: 'https://facebook.example/post' },
    );
    const r = await publishToPlatforms({ ...OWNER, platforms: ['FACEBOOK', 'INSTAGRAM'] });
    expect(r.results).toEqual([
      { platform: 'FACEBOOK', status: 'published', url: 'https://facebook.example/post' },
      { platform: 'INSTAGRAM', status: 'processing', message: 'Instagram is processing the video.' },
    ]);
    expect(s.pubs.find((p) => p.platform === 'INSTAGRAM')).toMatchObject({ status: 'PROCESSING', externalId: 'container:9' });
  });
});

describe('posts published before per-network tracking', () => {
  it('a draft already PUBLISHED on its own network (no record) is not offered there again', async () => {
    s.draft = { ...s.draft, status: 'PUBLISHED' };
    const pv = await previewPublishing('co1', s.draft);
    const li = pv.find((p) => p.platform === 'LINKEDIN')!;
    expect(li.ready).toBe(false);
    expect(li.blockers).toContain('Already published here.');
    expect(pv.find((p) => p.platform === 'FACEBOOK')!.blockers).not.toContain('Already published here.');
  });
});
