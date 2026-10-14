import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Instagram carousels and Reels: reading a video's facts from its bytes
 * (lib/video.ts) and the Content Publishing API calls
 * (server/media/publishers/instagram.ts), against a fake Graph API that
 * records every call. No real Meta account is used.
 */

import { inspectVideo, isSupportedCodec, looksLikeVideo } from '@/lib/video';
import { validateForPlatform, validateMediaSet } from '@/server/media/validate';
import { continueInstagramPost, startInstagramPost } from '@/server/media/publishers/instagram';

// --- A tiny ISO-BMFF writer, enough for the boxes inspectVideo reads -------

const box = (type: string, ...payload: Buffer[]) => {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const u32 = (...n: number[]) => {
  const b = Buffer.alloc(4 * n.length);
  n.forEach((v, i) => b.writeUInt32BE(v, i * 4));
  return b;
};

function mp4(opts: { brand?: string; seconds?: number; width?: number; height?: number; codec?: string; withAudioFirst?: boolean } = {}) {
  const { brand = 'isom', seconds = 12.5, width = 1080, height = 1920, codec = 'avc1' } = opts;
  const mvhd = box('mvhd', u32(0, 0, 0, 1000, Math.round(seconds * 1000)), Buffer.alloc(80));
  const track = (handler: string, w: number, h: number, fourcc: string) => {
    const tkhd = box('tkhd', Buffer.alloc(76), u32(w * 65536, h * 65536));
    const hdlr = box('hdlr', u32(0, 0), Buffer.from(handler, 'latin1'), Buffer.alloc(13));
    const stsd = box('stsd', u32(0, 1), u32(16), Buffer.from(fourcc, 'latin1'), Buffer.alloc(8));
    return box('trak', tkhd, box('mdia', hdlr, box('minf', box('stbl', stsd))));
  };
  const tracks = [
    ...(opts.withAudioFirst ? [track('soun', 0, 0, 'mp4a')] : []),
    track('vide', width, height, codec),
  ];
  return Buffer.concat([
    box('ftyp', Buffer.from(brand, 'latin1'), u32(0), Buffer.from('isommp42', 'latin1')),
    box('mdat', Buffer.alloc(64)), // the index after the data, as many encoders write it
    box('moov', mvhd, ...tracks),
  ]);
}

describe('reading a video from its bytes', () => {
  it('MP4: format, size, length and codec', () => {
    expect(inspectVideo(mp4())).toEqual({ mimeType: 'video/mp4', width: 1080, height: 1920, durationSec: 12.5, codec: 'avc1' });
  });

  it('MOV (QuickTime brand), HEVC, the video track found past an audio track', () => {
    const v = inspectVideo(mp4({ brand: 'qt  ', codec: 'hvc1', withAudioFirst: true, width: 720, height: 1280 }));
    expect(v).toMatchObject({ mimeType: 'video/quicktime', width: 720, height: 1280, codec: 'hvc1' });
    expect(isSupportedCodec(v.codec)).toBe(true);
    expect(isSupportedCodec('mp4v')).toBe(false);
  });

  it('refuses what is not a video, whatever it is called', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    expect(looksLikeVideo(png)).toBe(false);
    expect(() => inspectVideo(png)).toThrow(/not an MP4 or MOV/);
    expect(() => inspectVideo(Buffer.from('<html>not found</html>'))).toThrow();
    // An MP4 with no index (moov) cannot be read.
    expect(() => inspectVideo(box('ftyp', Buffer.from('isom'), u32(0)))).toThrow(/no index/);
  });

  it('a truncated or lying box size does not crash or run past the end', () => {
    const good = mp4();
    const cut = good.subarray(0, good.length - 40);
    expect(() => inspectVideo(cut)).toThrow();
    const liar = Buffer.from(good);
    liar.writeUInt32BE(0x7fffffff, 0); // the first box claims 2 GB
    expect(() => inspectVideo(liar)).toThrow(/not an MP4 or MOV/);
  });
});

describe('platform rules for video and carousels', () => {
  const video = (seconds: number, size = 20 * 1024 * 1024) => ({
    kind: 'VIDEO', mimeType: 'video/mp4', width: 1080, height: 1920, fileSize: size, metadata: { durationSec: seconds },
  });
  const image = { kind: 'IMAGE', mimeType: 'image/jpeg', width: 1080, height: 1080, fileSize: 300_000 };

  it('Instagram takes 3 s – 15 min MP4/MOV; other networks: video is posted by hand', () => {
    expect(validateForPlatform(video(30), 'INSTAGRAM').ok).toBe(true);
    expect(validateForPlatform(video(2), 'INSTAGRAM').problems.join()).toMatch(/3 seconds to 15 minutes/);
    expect(validateForPlatform(video(16 * 60), 'INSTAGRAM').ok).toBe(false);
    expect(validateForPlatform(video(30, 400 * 1024 * 1024), 'INSTAGRAM').problems.join()).toMatch(/300 MB/);
    expect(validateForPlatform(video(30), 'FACEBOOK').problems.join()).toMatch(/Instagram only/);
    expect(validateForPlatform(video(30), 'LINKEDIN').ok).toBe(false);
  });

  it('a carousel holds at most 10 items; Instagram needs at least one', () => {
    expect(validateMediaSet([], 'INSTAGRAM').join()).toMatch(/need an image or a video/);
    expect(validateMediaSet(Array(10).fill(image), 'INSTAGRAM')).toEqual([]);
    expect(validateMediaSet(Array(11).fill(image), 'INSTAGRAM').join()).toMatch(/up to 10/);
    expect(validateMediaSet([], 'FACEBOOK')).toEqual([]);
  });
});

// --- A fake Graph API -------------------------------------------------------

function fakeGraph(opts: { processing?: Set<string>; errors?: Set<string> } = {}) {
  const calls: { method: string; path: string; params: Record<string, string> }[] = [];
  let next = 1000;
  const status = new Map<string, string>();
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const params = Object.fromEntries(
      method === 'POST' ? new URLSearchParams(String(init?.body)) : url.searchParams,
    );
    delete params.access_token;
    calls.push({ method, path: url.pathname.replace(/^\/v[\d.]+/, ''), params });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (method === 'POST' && url.pathname.endsWith('/media')) {
      const id = String(++next);
      const label = params.media_type ?? (params.is_carousel_item ? 'ITEM' : 'IMAGE');
      status.set(id, opts.errors?.has(label) ? 'ERROR' : opts.processing?.has(label) ? 'IN_PROGRESS' : 'FINISHED');
      return json({ id });
    }
    if (method === 'POST' && url.pathname.endsWith('/media_publish')) {
      status.set(params.creation_id!, 'PUBLISHED');
      return json({ id: `M${params.creation_id}` });
    }
    if (params.fields?.includes('status_code')) {
      const id = url.pathname.split('/').pop()!;
      return json({ status_code: status.get(id) ?? 'ERROR', status: status.get(id) === 'ERROR' ? 'Error: media could not be fetched' : undefined });
    }
    if (params.fields === 'permalink') return json({ permalink: `https://www.instagram.com/p/${url.pathname.split('/').pop()}/` });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { impl, calls, status, creates: () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/media')), publishes: () => calls.filter((c) => c.path.endsWith('/media_publish')) };
}

const context = { accessToken: 'IG-TOKEN', igUserId: '17841400000' };
const img = (n: number) => ({ kind: 'IMAGE' as const, url: `https://aura.example/api/content/graphics/a${n}/file?exp=1&sig=x` });
const vid = (n: number) => ({ kind: 'VIDEO' as const, url: `https://bucket.example/videos/co1/v${n}.mp4` });

afterEach(() => vi.unstubAllGlobals());

describe('Instagram carousels', () => {
  let g: ReturnType<typeof fakeGraph>;
  beforeEach(() => {
    g = fakeGraph();
    vi.stubGlobal('fetch', g.impl);
  });

  it('2–10 items: one container per item, in order, then the carousel, then one publish', async () => {
    const r = await startInstagramPost({ context, items: [img(1), vid(2), img(3)], caption: 'Brunch is back' });
    const creates = g.creates();
    expect(creates.map((c) => c.params)).toEqual([
      { image_url: img(1).url, is_carousel_item: 'true' },
      { media_type: 'VIDEO', video_url: vid(2).url, is_carousel_item: 'true' },
      { image_url: img(3).url, is_carousel_item: 'true' },
      { media_type: 'CAROUSEL', children: '1001,1002,1003', caption: 'Brunch is back' },
    ]);
    expect(creates[0]!.path).toBe(`/${context.igUserId}/media`);
    expect(g.publishes()).toHaveLength(1);
    expect(g.publishes()[0]!.params.creation_id).toBe('1004');
    expect(r).toEqual({ state: 'published', url: 'https://www.instagram.com/p/M1004/' });
    // The caption goes on the carousel only, never on the items.
    expect(creates.slice(0, 3).some((c) => 'caption' in c.params)).toBe(false);
  });

  it('more than 10 items is refused before any call', async () => {
    await expect(startInstagramPost({ context, items: Array.from({ length: 11 }, (_, i) => img(i)), caption: 'x' })).rejects.toThrow(/up to 10/);
    expect(g.calls).toHaveLength(0);
  });

  it('an item Instagram cannot fetch: nothing is published, and the reason is plain', async () => {
    g = fakeGraph({ errors: new Set(['ITEM']) });
    vi.stubGlobal('fetch', g.impl);
    await expect(startInstagramPost({ context, items: [img(1), img(2)], caption: 'x' })).rejects.toThrow(/could not fetch one of the carousel items/);
    expect(g.publishes()).toHaveLength(0);
  });
});

describe('Instagram Reels', () => {
  it('one video: a REELS container (shared to the feed), published when ready', async () => {
    const g = fakeGraph();
    vi.stubGlobal('fetch', g.impl);
    const r = await startInstagramPost({ context, items: [vid(1)], caption: 'Behind the counter' });
    expect(g.creates()[0]!.params).toEqual({ media_type: 'REELS', video_url: vid(1).url, caption: 'Behind the counter', share_to_feed: 'true' });
    expect(r.state).toBe('published');
  });

  it('still processing when the request must end: "processing", NOT published — then finished later', async () => {
    const g = fakeGraph({ processing: new Set(['REELS']) });
    vi.stubGlobal('fetch', g.impl);
    const r = await startInstagramPost({ context, items: [vid(1)], caption: 'x', waitMs: 0 });
    expect(r).toEqual({ state: 'processing', externalId: 'container:1001' });
    expect(g.publishes()).toHaveLength(0);

    // Later (the sweep): still processing → unchanged; finished → published once.
    expect(await continueInstagramPost({ context, externalId: 'container:1001', caption: 'x' })).toEqual({ state: 'processing', externalId: 'container:1001' });
    g.status.set('1001', 'FINISHED');
    const done = await continueInstagramPost({ context, externalId: 'container:1001', caption: 'x' });
    expect(done).toEqual({ state: 'published', url: 'https://www.instagram.com/p/M1001/' });
    expect(g.publishes()).toHaveLength(1);
    // Already published by an attempt that could not record it: live, not re-posted.
    expect(await continueInstagramPost({ context, externalId: 'container:1001', caption: 'x' })).toEqual({ state: 'published', url: null });
    expect(g.publishes()).toHaveLength(1);
  });

  it('a carousel whose videos are processing finishes in two stages', async () => {
    const g = fakeGraph({ processing: new Set(['VIDEO']) });
    vi.stubGlobal('fetch', g.impl);
    const r = await startInstagramPost({ context, items: [img(1), vid(2)], caption: 'Two', waitMs: 0 });
    expect(r).toEqual({ state: 'processing', externalId: 'children:1001,1002' });
    g.status.set('1002', 'FINISHED');
    const done = await continueInstagramPost({ context, externalId: 'children:1001,1002', caption: 'Two' });
    expect(done.state).toBe('published');
    expect(g.creates().at(-1)!.params).toEqual({ media_type: 'CAROUSEL', children: '1001,1002', caption: 'Two' });
  });

  it('Instagram rejects the video, or it expires: a clear error, nothing published', async () => {
    const g = fakeGraph({ errors: new Set(['REELS']) });
    vi.stubGlobal('fetch', g.impl);
    await expect(startInstagramPost({ context, items: [vid(1)], caption: 'x' })).rejects.toThrow(/could not process the video/);
    g.status.set('1001', 'EXPIRED');
    await expect(continueInstagramPost({ context, externalId: 'container:1001', caption: 'x' })).rejects.toThrow(/expired/);
    expect(g.publishes()).toHaveLength(0);
  });

  it('a malformed pending id is refused (never sent to the Graph API)', async () => {
    const g = fakeGraph();
    vi.stubGlobal('fetch', g.impl);
    await expect(continueInstagramPost({ context, externalId: 'container:../me/accounts', caption: 'x' })).rejects.toThrow(/could not be found/);
    await expect(continueInstagramPost({ context, externalId: 'nonsense', caption: 'x' })).rejects.toThrow();
    expect(g.calls).toHaveLength(0);
  });
});
