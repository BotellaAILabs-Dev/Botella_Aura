import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LinkedIn publishing, checked against LinkedIn's documented API (Posts and
 * Images, version 202610 — learn.microsoft.com/linkedin/marketing). LinkedIn
 * itself is replaced by a recorder: every request Aura would send is checked
 * for its URL, headers and body. Nothing is posted anywhere.
 */

const s = vi.hoisted(() => ({
  ctx: null as null | { token: string; scope: string | null; linkedInUserId: string | null },
  media: [] as any[],
}));

vi.mock('@/lib/db', () => ({ db: { contentMedia: { findMany: async () => s.media } } }));
vi.mock('@/server/services/linkedin.service', () => ({ getPublishContext: async () => s.ctx }));
vi.mock('@/server/media/asset.service', () => ({
  getAsset: async (_c: string, id: string) => ({ id, mimeType: 'image/png' }),
  readAssetBytes: async () => Buffer.from('PNGBYTES'),
}));
vi.mock('@/server/execution/routing.service', () => ({ routeExecution: async () => ({ ok: true }) }));
vi.mock('@/server/execution/engine.service', () => ({ recordRoute: async () => undefined, syncFromPublication: async () => null, syncFromHandoff: async () => null }));
vi.mock('@/server/connections/health.service', () => ({ recordExecutionResult: async () => undefined }));

import { publishTo } from '@/server/content/publish.service';
import {
  isValidLinkedInVersion,
  LINKEDIN_DEFAULT_API_VERSION,
  linkedInApiVersion,
  linkedInVersionAgeMonths,
  linkedInVersionMayBeSunset,
} from '@/lib/linkedin-api';
import { checkEnv } from '@/lib/env-check';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
let answer: (c: Call) => Response;

const draft = (type = 'LINKEDIN_POST') =>
  ({
    id: 'd1',
    companyId: 'c1',
    type,
    platform: 'LINKEDIN',
    status: 'APPROVED',
    body: { hook: 'Fresh bread at seven.', paragraphs: ['Baked overnight.', 'Still warm.', 'See you soon.'], cta: 'Visit us.', hashtags: ['bakery'] },
    scheduledFor: null,
  }) as never;
const image = { assetId: 'a1', altText: 'Loaves on a shelf', asset: { kind: 'IMAGE', mimeType: 'image/png', width: 1200, height: 627, fileSize: 120_000, metadata: {}, storageUrl: null } };
const posts = () => calls.filter((c) => c.url === 'https://api.linkedin.com/rest/posts');

beforeEach(() => {
  calls = [];
  s.media = [];
  s.ctx = { token: 'TOKEN-123', scope: 'openid profile email w_member_social', linkedInUserId: 'abc123' };
  delete process.env.LINKEDIN_API_VERSION;
  delete process.env.LINKEDIN_ORG_URN;
  answer = (c) => {
    if (c.url.includes('/rest/images?action=initializeUpload')) {
      return new Response(JSON.stringify({ value: { uploadUrl: 'https://www.linkedin.com/dms-uploads/IMG1/uploaded-image/0', image: 'urn:li:image:IMG1', uploadUrlExpiresAt: 1 } }), { status: 200 });
    }
    if (c.url.startsWith('https://www.linkedin.com/dms-uploads/')) return new Response(null, { status: 201 });
    // A member token can't GET versioned /rest/images (w_member_social is write-only).
    if (c.url.startsWith('https://api.linkedin.com/rest/images/')) return new Response('{"status":403}', { status: 403 });
    if (c.url === 'https://api.linkedin.com/rest/posts') return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:7000000000000000001' } });
    return new Response('unexpected', { status: 500 });
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const raw = init?.body;
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers,
      body: typeof raw === 'string' ? (raw.startsWith('{') ? JSON.parse(raw) : raw) : raw ? 'binary' : undefined,
    };
    calls.push(call);
    return answer(call);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('API version', () => {
  it('defaults to 202610 (LinkedIn’s latest when checked); a well-formed override wins, a malformed one is ignored', () => {
    expect(LINKEDIN_DEFAULT_API_VERSION).toBe('202610');
    expect(linkedInApiVersion({})).toBe('202610');
    expect(linkedInApiVersion({ LINKEDIN_API_VERSION: '202609' })).toBe('202609');
    expect(linkedInApiVersion({ LINKEDIN_API_VERSION: '2026-09' })).toBe('202610');
    expect(linkedInApiVersion({ LINKEDIN_API_VERSION: '202613' })).toBe('202610');
    expect(isValidLinkedInVersion('202503')).toBe(true);
  });

  it('knows when a version is old enough to be sunset (LinkedIn guarantees one year)', () => {
    const now = new Date('2026-10-22T00:00:00Z');
    expect(linkedInVersionAgeMonths('202503', now)).toBe(19);
    expect(linkedInVersionMayBeSunset('202503', now)).toBe(true); // the old default
    expect(linkedInVersionMayBeSunset('202511', now)).toBe(false);
    expect(linkedInVersionMayBeSunset('202610', now)).toBe(false);
  });

  it('the environment check warns about a stale or malformed override', () => {
    const base = { DATABASE_URL: 'x', DIRECT_URL: 'x', NEXTAUTH_SECRET: 'x', NEXTAUTH_URL: 'https://a.example', ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') };
    expect(checkEnv({ ...base, LINKEDIN_API_VERSION: '202503' }).warnings.join(' ')).toMatch(/202503 is a year old or more/);
    expect(checkEnv({ ...base, LINKEDIN_API_VERSION: 'latest' }).warnings.join(' ')).toMatch(/must be YYYYMM/);
    expect(checkEnv({ ...base }).warnings.join(' ')).not.toMatch(/LinkedIn/);
  });
});

describe('creating a post (Posts API)', () => {
  it('a text post: POST /rest/posts with the documented headers and body; the post id from x-restli-id', async () => {
    const r = await publishTo({ companyId: 'c1', userId: 'u1', draft: draft(), platform: 'LINKEDIN' });
    expect(r).toMatchObject({ mode: 'published', url: 'https://www.linkedin.com/feed/update/urn:li:share:7000000000000000001' });
    expect(posts()).toHaveLength(1);
    const [p] = posts();
    expect(p!.method).toBe('POST');
    expect(p!.headers).toMatchObject({ authorization: 'Bearer TOKEN-123', 'linkedin-version': '202610', 'x-restli-protocol-version': '2.0.0', 'content-type': 'application/json' });
    expect(p!.body).toMatchObject({
      author: 'urn:li:person:abc123',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
    expect(typeof (p!.body as { commentary: string }).commentary).toBe('string');
    expect('content' in (p!.body as object)).toBe(false); // LinkedIn rejects an empty content object
  });

  it('LINKEDIN_API_VERSION, when set, is the version sent', async () => {
    process.env.LINKEDIN_API_VERSION = '202609';
    await publishTo({ companyId: 'c1', userId: 'u1', draft: draft(), platform: 'LINKEDIN' });
    expect(posts()[0]!.headers['linkedin-version']).toBe('202609');
  });
});

describe('publishing with an image (Images API)', () => {
  it('initializeUpload owned by the post’s author → PUT the bytes (no versioned headers) → post references the image URN', async () => {
    s.media = [image];
    const r = await publishTo({ companyId: 'c1', userId: 'u1', draft: draft('IMAGE_POST'), platform: 'LINKEDIN' });
    expect(r.mode).toBe('published');
    const init = calls.find((c) => c.url.endsWith('/rest/images?action=initializeUpload'))!;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'linkedin-version': '202610', 'x-restli-protocol-version': '2.0.0' });
    expect(init.body).toEqual({ initializeUploadRequest: { owner: 'urn:li:person:abc123' } });
    const put = calls.find((c) => c.url.startsWith('https://www.linkedin.com/dms-uploads/'))!;
    expect(put.method).toBe('PUT');
    expect(put.headers.authorization).toBe('Bearer TOKEN-123');
    expect(put.headers['linkedin-version']).toBeUndefined();
    // The status check is refused for a member token — not fatal; the post still goes.
    expect(posts()[0]!.body).toMatchObject({ content: { media: { id: 'urn:li:image:IMG1', altText: 'Loaves on a shelf' } } });
  });

  it('an image LinkedIn could not process stops the post with a reason (nothing posted)', async () => {
    s.media = [image];
    const base = answer;
    answer = (c) => (c.url.startsWith('https://api.linkedin.com/rest/images/') ? new Response(JSON.stringify({ status: 'PROCESSING_FAILED' }), { status: 200 }) : base(c));
    const r = await publishTo({ companyId: 'c1', userId: 'u1', draft: draft('IMAGE_POST'), platform: 'LINKEDIN' });
    expect(r).toMatchObject({ mode: 'manual' });
    expect((r as { reason: string }).reason).toMatch(/could not process that image/);
    expect(posts()).toHaveLength(0);
  });
});

describe('organisation (Company Page) publishing', () => {
  it('with w_organization_social and LINKEDIN_ORG_URN: the Page is the author and owns the image', async () => {
    process.env.LINKEDIN_ORG_URN = 'urn:li:organization:5515715';
    s.ctx = { token: 'TOKEN-123', scope: 'openid w_member_social w_organization_social', linkedInUserId: 'abc123' };
    s.media = [image];
    await publishTo({ companyId: 'c1', userId: 'u1', draft: draft('IMAGE_POST'), platform: 'LINKEDIN' });
    expect(calls.find((c) => c.url.includes('initializeUpload'))!.body).toEqual({ initializeUploadRequest: { owner: 'urn:li:organization:5515715' } });
    expect(posts()[0]!.body).toMatchObject({ author: 'urn:li:organization:5515715' });
  });

  it('without w_organization_social the member posts, even when an organisation is configured', async () => {
    process.env.LINKEDIN_ORG_URN = 'urn:li:organization:5515715';
    await publishTo({ companyId: 'c1', userId: 'u1', draft: draft(), platform: 'LINKEDIN' });
    expect(posts()[0]!.body).toMatchObject({ author: 'urn:li:person:abc123' });
  });

  it('no posting permission at all: copied for manual posting, LinkedIn not called', async () => {
    s.ctx = { token: 'TOKEN-123', scope: 'openid profile email', linkedInUserId: 'abc123' };
    const r = await publishTo({ companyId: 'c1', userId: 'u1', draft: draft(), platform: 'LINKEDIN' });
    expect(r.mode).toBe('manual');
    expect((r as { reason: string }).reason).toMatch(/wasn't granted posting permission/);
    expect(calls).toHaveLength(0);
  });
});

describe('expiry, revocation and LinkedIn errors', () => {
  it('expired or missing connection: reconnect, LinkedIn not called', async () => {
    s.ctx = null; // getPublishContext returns null once the token expired
    const r = await publishTo({ companyId: 'c1', userId: 'u1', draft: draft(), platform: 'LINKEDIN' });
    expect(r).toMatchObject({ mode: 'reconnect' });
    expect(calls).toHaveLength(0);
  });

  it('a refused token (401): says reconnect, and carries the status so the connection is marked', async () => {
    answer = () => new Response('{"status":401,"code":"EMPTY_ACCESS_TOKEN"}', { status: 401 });
    const err = await publishTo({ companyId: 'c1', userId: 'u1', draft: draft(), platform: 'LINKEDIN' }).catch((e) => e);
    expect(err.message).toMatch(/refused the stored credentials\. Reconnect LinkedIn/);
    expect(err.providerStatus).toBe(401);
  });

  it('a sunset version (426 NONEXISTENT_VERSION): says exactly what to change', async () => {
    answer = () => new Response('{"status":426,"code":"NONEXISTENT_VERSION","message":"Requested version 202503 is not active"}', { status: 426 });
    const err = await publishTo({ companyId: 'c1', userId: 'u1', draft: draft(), platform: 'LINKEDIN' }).catch((e) => e);
    expect(err.message).toBe('LinkedIn no longer accepts API version 202610 (HTTP 426). Set LINKEDIN_API_VERSION to a current version (YYYYMM, see LinkedIn\'s versioning page) and redeploy — nothing was posted.');
  });

  it('a sunset version during the image upload says the same', async () => {
    s.media = [image];
    answer = () => new Response('{"status":426}', { status: 426 });
    const r = await publishTo({ companyId: 'c1', userId: 'u1', draft: draft('IMAGE_POST'), platform: 'LINKEDIN' });
    expect((r as { reason: string }).reason).toMatch(/no longer accepts API version 202610 \(HTTP 426\)/);
  });

  it('rate limit (429): recognised as such (retried automatically by the execution engine)', async () => {
    answer = () => new Response('{"status":429}', { status: 429 });
    const err = await publishTo({ companyId: 'c1', userId: 'u1', draft: draft(), platform: 'LINKEDIN' }).catch((e) => e);
    expect(err.message).toMatch(/rate-limiting/);
  });
});

describe('LinkedIn "little" text (commentary)', () => {
  it('escapes every reserved character, keeps #hashtags live', async () => {
    const { escapeLittleText } = await import('@/lib/linkedin-little');
    expect(escapeLittleText('Fresh bread (still warm)')).toBe(String.raw`Fresh bread \(still warm\)`);
    expect(escapeLittleText('a|b {c} @d [e] <f> *g* _h_ ~i~')).toBe(String.raw`a\|b \{c\} \@d \[e\] \<f\> \*g\* \_h\_ \~i\~`);
    // A backslash itself is escaped (one becomes two).
    expect(escapeLittleText(String.raw`C:\path`)).toBe(String.raw`C:\\path`);
    expect(escapeLittleText('Come by #bakery #Sourdough2026')).toBe('Come by #bakery #Sourdough2026');
    expect(escapeLittleText('Ranked # 1 and #')).toBe(String.raw`Ranked \# 1 and \#`);
    expect(escapeLittleText('Plain text, no markup.')).toBe('Plain text, no markup.');
  });

  it('an image post (caption, CTA, hashtags) publishes with that text — not "post it by hand"', async () => {
    s.media = [image];
    const imageDraft = {
      id: 'd2', companyId: 'c1', type: 'IMAGE_POST', platform: 'LINKEDIN', status: 'APPROVED', scheduledFor: null,
      body: { caption: 'Sourdough (still warm) is back.', cta: 'Visit us.', hashtags: ['bakery'], altText: 'Loaves' },
    } as never;
    const r = await publishTo({ companyId: 'c1', userId: 'u1', draft: imageDraft, platform: 'LINKEDIN' });
    expect(r.mode).toBe('published');
    const commentary = (posts()[0]!.body as { commentary: string }).commentary;
    expect(commentary).toContain(String.raw`Sourdough \(still warm\) is back.`);
    expect(commentary).toContain('Visit us.');
    expect(commentary).toContain('#bakery');
  });
});
