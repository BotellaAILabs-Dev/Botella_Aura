import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Reels and carousels through Aura's publishing (server/content/publish.service.ts)
 * and the step that finishes what Instagram was still processing
 * (server/content/processing.service.ts): the right URLs go to Instagram, video
 * never goes to other networks, a processing post is not called published,
 * it is finished exactly once, the person is told, and a post edited
 * meanwhile is not published. The Graph API is a recording fake.
 */

const s = vi.hoisted(() => ({
  media: [] as any[],
  pubs: [] as any[],
  audits: [] as any[],
  draft: null as any,
  hash: 'HASH1',
  connected: true,
}));
const m = vi.hoisted(() => ({ notifyUser: vi.fn(), markPublished: vi.fn() }));

const where = (row: any, w: any): boolean =>
  Object.entries(w).every(([k, v]: [string, any]) => {
    if (k === 'OR') return v.some((x: any) => where(row, x));
    if (v && typeof v === 'object' && !(v instanceof Date) && 'lt' in v) return row[k] != null && row[k] < v.lt;
    if (v instanceof Date) return row[k]?.getTime() === v.getTime();
    return row[k] === v;
  });

vi.mock('@/lib/db', () => ({
  db: {
    contentMedia: { findMany: async () => s.media },
    contentPublication: {
      findMany: async ({ where: w, take }: any) => s.pubs.filter((p) => where(p, w)).slice(0, take ?? 99).map((p) => ({ ...p })),
      updateMany: async ({ where: w, data }: any) => {
        const rows = s.pubs.filter((p) => where(p, w));
        rows.forEach((p) => Object.assign(p, data, { updatedAt: new Date() }));
        return { count: rows.length };
      },
    },
    auditLog: { create: async ({ data }: any) => s.audits.push(data) },
  },
}));
// Connection Manager gate (server/connections/health.service.ts) is tested on its own.
vi.mock('@/server/connections/health.service', () => ({
  connectionGate: async () => ({ allowed: true, noRecord: true, connectorId: null, health: null, reason: null, fix: null }),
  recordExecutionResult: async () => undefined,
}));
vi.mock('@/server/connectors/connection.service', () => ({
  resolveCredential: async () => (s.connected ? { accessToken: 'IG-TOKEN', metadata: { igUserId: '17841400000', pageId: '1' } } : null),
}));
vi.mock('@/server/content/content.service', () => ({
  getDraft: async (companyId: string, id: string) => (s.draft && s.draft.id === id && s.draft.companyId === companyId ? { ...s.draft } : null),
  markPublished: m.markPublished,
  assertPublishable: () => undefined,
  DraftNotFoundError: class extends Error {},
}));
vi.mock('@/server/approval/approval.service', () => ({
  contentHash: async () => s.hash,
  assertContentIntact: async () => undefined,
}));
vi.mock('@/server/content/render', () => ({
  renderForManual: (d: any) => d.body.text,
  renderLinkedInCommentary: (d: any) => d.body.text,
}));
vi.mock('@/server/services/linkedin.service', () => ({ getPublishContext: async () => ({ scope: 'w_member_social' }) }));
vi.mock('@/server/whatsapp/notify', () => ({ notifyUser: m.notifyUser }));

process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
process.env.APP_URL = 'https://aura.example';

import { publishTo } from '@/server/content/publish.service';
import { advanceProcessing, PROCESSING_LEASE_MS } from '@/server/content/processing.service';

function fakeGraph(processing: Set<string>) {
  const calls: { method: string; path: string; params: Record<string, string> }[] = [];
  let next = 1000;
  const status = new Map<string, string>();
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const params = Object.fromEntries(method === 'POST' ? new URLSearchParams(String(init?.body)) : url.searchParams);
    delete params.access_token;
    calls.push({ method, path: url.pathname, params });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (method === 'POST' && url.pathname.endsWith('/media')) {
      const id = String(++next);
      status.set(id, processing.has(params.media_type ?? 'IMAGE') ? 'IN_PROGRESS' : 'FINISHED');
      return json({ id });
    }
    if (method === 'POST' && url.pathname.endsWith('/media_publish')) {
      status.set(params.creation_id!, 'PUBLISHED');
      return json({ id: `M${params.creation_id}` });
    }
    if (params.fields?.includes('status_code')) return json({ status_code: status.get(url.pathname.split('/').pop()!) });
    if (params.fields === 'permalink') return json({ permalink: `https://www.instagram.com/p/${url.pathname.split('/').pop()}/` });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { impl, calls, status, publishes: () => calls.filter((c) => c.path.endsWith('/media_publish')) };
}

const asset = (kind: 'IMAGE' | 'VIDEO', n: number) => ({
  assetId: `a${n}`,
  altText: null,
  asset:
    kind === 'VIDEO'
      ? { id: `a${n}`, kind, mimeType: 'video/mp4', width: 1080, height: 1920, fileSize: 9_000_000, metadata: { durationSec: 20 }, storageUrl: `https://bucket.example/videos/co1/a${n}.mp4` }
      : { id: `a${n}`, kind, mimeType: 'image/jpeg', width: 1080, height: 1080, fileSize: 300_000, metadata: {}, storageUrl: null },
});

beforeEach(() => {
  s.media = [];
  s.pubs = [];
  s.audits = [];
  s.hash = 'HASH1';
  s.connected = true;
  s.draft = { id: 'd1', companyId: 'co1', type: 'IMAGE_POST', platform: 'INSTAGRAM', status: 'APPROVED', body: { text: 'Behind the counter at 6am' } };
  m.notifyUser.mockReset();
  m.markPublished.mockReset();
  m.markPublished.mockResolvedValue({});
});
afterEach(() => vi.unstubAllGlobals());

describe('publishing to Instagram from Aura', () => {
  it('a video goes as a Reel from the bucket URL (never through the app); an image by its signed link', async () => {
    const g = fakeGraph(new Set());
    vi.stubGlobal('fetch', g.impl);
    s.media = [asset('VIDEO', 1)];
    const r = await publishTo({ companyId: 'co1', userId: 'u1', draft: s.draft, platform: 'INSTAGRAM' });
    expect(r).toEqual({ mode: 'published', url: 'https://www.instagram.com/p/M1001/' });
    expect(g.calls[0]!.params).toMatchObject({ media_type: 'REELS', video_url: 'https://bucket.example/videos/co1/a1.mp4' });

    const g2 = fakeGraph(new Set());
    vi.stubGlobal('fetch', g2.impl);
    s.media = [asset('IMAGE', 1), asset('IMAGE', 2)];
    await publishTo({ companyId: 'co1', userId: 'u1', draft: s.draft, platform: 'INSTAGRAM' });
    const items = g2.calls.filter((c) => c.params.is_carousel_item === 'true');
    expect(items).toHaveLength(2);
    expect(items[0]!.params.image_url).toMatch(/^https:\/\/aura\.example\/api\/content\/graphics\/a1\/file\?exp=\d+&sig=/);
    // JPEG already: sent as stored.
    expect(items[0]!.params.image_url).not.toMatch(/format=jpeg/);

    const g3 = fakeGraph(new Set());
    vi.stubGlobal('fetch', g3.impl);
    s.media = [{ ...asset('IMAGE', 5), asset: { ...asset('IMAGE', 5).asset, mimeType: 'image/png' } }];
    await publishTo({ companyId: 'co1', userId: 'u1', draft: s.draft, platform: 'INSTAGRAM' });
    // PNG: Instagram is given the JPEG rendition (it takes JPEG only).
    expect(g3.calls[0]!.params.image_url).toMatch(/&format=jpeg$/);
  });

  it('still processing: the result says so — it is not reported as published', async () => {
    vi.stubGlobal('fetch', fakeGraph(new Set(['REELS'])).impl);
    s.media = [asset('VIDEO', 1)];
    // The publish waits ~30 s for Instagram before answering "processing":
    // run that wait on a fake clock.
    vi.useFakeTimers();
    try {
      let result: unknown;
      const pending = publishTo({ companyId: 'co1', userId: 'u1', draft: s.draft, platform: 'INSTAGRAM' }).then((r) => (result = r));
      for (let i = 0; i < 30 && result === undefined; i++) await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      expect(result).toMatchObject({ mode: 'processing', externalId: 'container:1001' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('video to Facebook or LinkedIn: not attempted, a plain reason instead', async () => {
    const g = fakeGraph(new Set());
    vi.stubGlobal('fetch', g.impl);
    s.media = [asset('VIDEO', 1)];
    for (const platform of ['FACEBOOK', 'LINKEDIN'] as const) {
      const r = await publishTo({ companyId: 'co1', userId: 'u1', draft: { ...s.draft, platform }, platform });
      expect(r).toMatchObject({ mode: 'manual', reason: expect.stringMatching(/Instagram only/) });
    }
    expect(g.calls).toHaveLength(0);
  });

  it('11 items: refused before any call', async () => {
    const g = fakeGraph(new Set());
    vi.stubGlobal('fetch', g.impl);
    s.media = Array.from({ length: 11 }, (_, i) => asset('IMAGE', i));
    const r = await publishTo({ companyId: 'co1', userId: 'u1', draft: s.draft, platform: 'INSTAGRAM' });
    expect(r).toMatchObject({ mode: 'manual', reason: expect.stringMatching(/up to 10/) });
    expect(g.calls).toHaveLength(0);
  });
});

describe('finishing what Instagram was processing', () => {
  const processingRow = (extra: Record<string, unknown> = {}) => ({
    id: 'pub1',
    companyId: 'co1',
    contentDraftId: 'd1',
    platform: 'INSTAGRAM',
    status: 'PROCESSING',
    contentHash: 'HASH1',
    externalId: 'container:1001',
    startedAt: null,
    requestedById: 'u1',
    url: null,
    message: 'processing',
    updatedAt: new Date(),
    ...extra,
  });

  it('still processing → left as it is; ready → published once, the draft marked, the person told on WhatsApp', async () => {
    const g = fakeGraph(new Set());
    g.status.set('1001', 'IN_PROGRESS');
    vi.stubGlobal('fetch', g.impl);
    s.pubs = [processingRow()];

    expect(await advanceProcessing()).toMatchObject({ checked: 1, stillProcessing: 1, published: 0 });
    expect(s.pubs[0]).toMatchObject({ status: 'PROCESSING', startedAt: null });
    expect(g.publishes()).toHaveLength(0);

    g.status.set('1001', 'FINISHED');
    expect(await advanceProcessing()).toMatchObject({ published: 1 });
    expect(s.pubs[0]).toMatchObject({ status: 'PUBLISHED', url: 'https://www.instagram.com/p/M1001/', externalId: null });
    expect(m.markPublished).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'd1', publishedUrl: 'https://www.instagram.com/p/M1001/' }));
    expect(m.notifyUser).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', companyId: 'co1', text: expect.stringMatching(/live on Instagram/) }));

    // Nothing left to do: never published twice.
    expect(await advanceProcessing()).toMatchObject({ checked: 0 });
    expect(g.publishes()).toHaveLength(1);
  });

  it('edited (or approval withdrawn) while processing: NOT published, FAILED with the reason, person told', async () => {
    const g = fakeGraph(new Set());
    g.status.set('1001', 'FINISHED');
    vi.stubGlobal('fetch', g.impl);
    s.pubs = [processingRow()];
    s.hash = 'HASH2'; // the text changed since it was approved
    expect(await advanceProcessing()).toMatchObject({ failed: 1 });
    expect(g.publishes()).toHaveLength(0);
    expect(s.pubs[0]).toMatchObject({ status: 'FAILED', message: expect.stringMatching(/changed/) });
    expect(s.audits.at(-1)).toMatchObject({ action: 'CONTENT_PUBLISH_FAILED' });
    expect(m.notifyUser).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/didn’t publish/) }));

    s.hash = 'HASH1';
    s.pubs = [processingRow()];
    s.draft.status = 'PENDING_APPROVAL';
    expect(await advanceProcessing()).toMatchObject({ failed: 1 });
    expect(g.publishes()).toHaveLength(0);
  });

  it('a run already holding it (lease) is not joined; a dead run’s lease expires', async () => {
    const g = fakeGraph(new Set());
    g.status.set('1001', 'FINISHED');
    vi.stubGlobal('fetch', g.impl);
    const now = new Date();
    s.pubs = [processingRow({ startedAt: new Date(now.getTime() - 10_000) })];
    expect(await advanceProcessing({ now })).toMatchObject({ checked: 0 });
    expect(g.publishes()).toHaveLength(0);
    s.pubs[0].startedAt = new Date(now.getTime() - PROCESSING_LEASE_MS - 1);
    expect(await advanceProcessing({ now })).toMatchObject({ published: 1 });
  });

  it('Instagram reports an error, or Meta was disconnected: FAILED, nothing published', async () => {
    const g = fakeGraph(new Set());
    g.status.set('1001', 'ERROR');
    vi.stubGlobal('fetch', g.impl);
    s.pubs = [processingRow()];
    expect(await advanceProcessing()).toMatchObject({ failed: 1 });
    expect(s.pubs[0].message).toMatch(/could not process the video/);

    s.pubs = [processingRow()];
    s.connected = false;
    expect(await advanceProcessing()).toMatchObject({ failed: 1 });
    expect(s.pubs[0].message).toMatch(/disconnected/);
    expect(g.publishes()).toHaveLength(0);
  });

  it('scoped to a workspace and a draft when asked (the draft page)', async () => {
    vi.stubGlobal('fetch', fakeGraph(new Set()).impl);
    s.pubs = [processingRow({ id: 'p1', companyId: 'co2', contentDraftId: 'x' })];
    expect(await advanceProcessing({ companyId: 'co1', draftId: 'd1' })).toMatchObject({ checked: 0 });
    expect(s.pubs[0].status).toBe('PROCESSING');
  });
});
