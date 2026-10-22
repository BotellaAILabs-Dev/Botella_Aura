import crypto from 'node:crypto';

import type { ContentDraft } from '@prisma/client';

import { httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { resolvePlatform } from '@/lib/platforms';
import type { ContentTypeKey } from '@/lib/validations/content';
import { validateImageBytes } from '@/server/media/validate';
import { putImage, putVideo } from '@/server/media/storage';
import { inspectVideo, isSupportedCodec, VideoReadError } from '@/lib/video';
import { createAsset, toAssetView, type AssetView } from '@/server/media/asset.service';
import { closestRatioFor } from '@/server/media/aspect';

/**
 * User-supplied graphics: a file from their machine, or a remote image URL.
 *
 * This deliberately reuses the generation pipeline rather than paralleling it —
 * validate bytes, store, persist, attach, validate per platform, publish. A
 * supplied image and a generated one differ only in where the bytes came from,
 * so everything downstream (the composer, the queue, the LinkedIn upload, the
 * Instagram fetch, the extension) already works with no changes at all.
 *
 * The MIME type and dimensions are read from the BYTES, never from the upload's
 * filename or the remote server's Content-Type header. A browser will happily
 * label anything, and a `.png` that is actually an HTML error page must not
 * become a broken post days later.
 */

/** Ceiling for a fetched remote image, before it is even validated. */
const MAX_REMOTE_BYTES = 15 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 20_000;
/**
 * Ceiling for a video (Instagram itself takes up to 300 MB; this keeps one
 * download and upload well inside a 60-second function).
 */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const VIDEO_TIMEOUT_MS = 45_000;
/** Redirect hops followed when downloading a remote image or video. */
const MAX_REDIRECTS = 3;

export class MediaFetchError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
    this.name = 'MediaFetchError';
  }
}

interface IngestArgs {
  draft: ContentDraft;
  userId: string;
  data: Buffer;
  /** Where it came from, for the audit trail. */
  origin: 'upload' | 'url';
  /** The remote URL, when origin is 'url'. Kept for traceability. */
  sourceUrl?: string;
  /** Original filename, when origin is 'upload'. */
  filename?: string;
}

/**
 * Validate and store a supplied image against a draft.
 *
 * Returns the same AssetView shape the generator produces, so the studio's
 * gallery, selection and attachment code needs no special case.
 */
export async function ingestImage(args: IngestArgs): Promise<AssetView> {
  const { draft, userId, data, origin, sourceUrl, filename } = args;

  // Dimensions are unknown up front for a supplied image, so the "claimed"
  // values are zero — validateImageBytes reads the real ones from the header
  // and only falls back to the claim when the header cannot be parsed.
  const validated = validateImageBytes(data, { width: 0, height: 0 });
  if (validated.width === 0 || validated.height === 0) {
    throw new MediaFetchError(
      'That image’s dimensions could not be read. Re-save it as a standard PNG or JPEG and try again.',
    );
  }

  const platform = resolvePlatform(draft.type as ContentTypeKey, draft.platform);
  const assetId = `c${Date.now().toString(36)}${crypto
    .randomBytes(9)
    .toString('base64url')
    .toLowerCase()}`;

  const stored = await putImage({
    companyId: draft.companyId,
    assetId,
    data,
    mimeType: validated.mimeType,
  });

  const asset = await createAsset({
    id: assetId,
    companyId: draft.companyId,
    contentDraftId: draft.id,
    createdById: userId,
    provider: 'UPLOAD',
    // No model produced this. Recording how it arrived keeps the history
    // readable ("uploaded" / "from URL") without pretending a model was used.
    model: origin === 'url' ? 'remote-url' : 'upload',
    kind: 'IMAGE',
    prompt: filename ? `Uploaded: ${filename}` : `Added from URL`,
    aspectRatio: closestRatioFor(validated.width, validated.height),
    width: validated.width,
    height: validated.height,
    mimeType: validated.mimeType,
    fileSize: validated.fileSize,
    storage: stored.storage,
    data: stored.data ?? null,
    storageUrl: stored.storageUrl ?? null,
    sourceUrl: sourceUrl ?? null,
    platform,
    metadata: {
      origin,
      ...(filename ? { filename } : {}),
    },
  });

  await recordAudit({
    action: 'GRAPHIC_GENERATED',
    userId,
    companyId: draft.companyId,
    metadata: {
      draftId: draft.id,
      origin,
      assetId: asset.id,
      mimeType: validated.mimeType,
      fileSize: validated.fileSize,
    },
  });

  return toAssetView(asset);
}

/**
 * Validate and store a supplied VIDEO against a draft (for Instagram Reels
 * and carousels). The format, size, length and codec are read from the bytes
 * (lib/video.ts); it is kept in the bucket only (server/media/storage.ts).
 */
export async function ingestVideo(args: IngestArgs): Promise<AssetView> {
  const { draft, userId, data, origin, sourceUrl, filename } = args;
  if (data.byteLength > MAX_VIDEO_BYTES) {
    throw new MediaFetchError(`That video is over ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`, 413);
  }
  let facts;
  try {
    facts = inspectVideo(data);
  } catch (err) {
    if (err instanceof VideoReadError) throw new MediaFetchError(err.message);
    throw err;
  }
  if (!isSupportedCodec(facts.codec)) {
    throw new MediaFetchError(
      `That video is encoded as ${facts.codec ?? 'an unknown format'}; Instagram takes H.264 or HEVC. Re-export it as a standard MP4.`,
    );
  }

  const platform = resolvePlatform(draft.type as ContentTypeKey, draft.platform);
  const assetId = `c${Date.now().toString(36)}${crypto.randomBytes(9).toString('base64url').toLowerCase()}`;
  let stored;
  try {
    stored = await putVideo({ companyId: draft.companyId, assetId, data, mimeType: facts.mimeType });
  } catch (err) {
    const noBucket = err instanceof Error && /ASSET_S3/.test(err.message);
    logger.error('media: video storage failed', { error: err instanceof Error ? err.message : String(err) });
    throw new MediaFetchError(
      noBucket ? 'Videos need file storage, which isn’t set up on this deployment yet.' : 'The video could not be stored. Try again.',
      noBucket ? 409 : 502,
    );
  }

  const asset = await createAsset({
    id: assetId,
    companyId: draft.companyId,
    contentDraftId: draft.id,
    createdById: userId,
    provider: 'UPLOAD',
    model: origin === 'url' ? 'remote-url' : 'upload',
    kind: 'VIDEO',
    prompt: filename ? `Uploaded: ${filename}` : 'Added from URL',
    aspectRatio: closestRatioFor(facts.width, facts.height),
    width: facts.width,
    height: facts.height,
    mimeType: facts.mimeType,
    fileSize: data.byteLength,
    storage: stored.storage,
    data: null,
    storageUrl: stored.storageUrl ?? null,
    sourceUrl: sourceUrl ?? null,
    platform,
    metadata: {
      origin,
      durationSec: facts.durationSec,
      codec: facts.codec,
      ...(filename ? { filename } : {}),
    },
  });

  await recordAudit({
    action: 'GRAPHIC_GENERATED',
    userId,
    companyId: draft.companyId,
    metadata: {
      draftId: draft.id,
      origin,
      assetId: asset.id,
      kind: 'VIDEO',
      mimeType: facts.mimeType,
      fileSize: data.byteLength,
      durationSec: facts.durationSec,
    },
  });
  return toAssetView(asset);
}

/** Fetch a remote video to store (same guards as images, larger cap). */
export async function fetchRemoteVideo(rawUrl: string): Promise<Buffer> {
  return fetchRemote(rawUrl, { maxBytes: MAX_VIDEO_BYTES, accept: 'video/*', timeoutMs: VIDEO_TIMEOUT_MS, noun: 'video' });
}

/**
 * Fetch a remote image so it can be stored locally.
 *
 * Storing a copy rather than referencing the URL is the whole point: a post
 * scheduled for next week cannot depend on somebody else's server still
 * serving that file, and LinkedIn needs the bytes to upload anyway.
 */
export async function fetchRemoteImage(rawUrl: string): Promise<Buffer> {
  return fetchRemote(rawUrl, { maxBytes: MAX_REMOTE_BYTES, accept: 'image/*', timeoutMs: REMOTE_TIMEOUT_MS, noun: 'image' });
}

async function fetchRemote(
  rawUrl: string,
  opts: { maxBytes: number; accept: string; timeoutMs: number; noun: 'image' | 'video' },
): Promise<Buffer> {
  const tooLarge = `That ${opts.noun} is too large (over ${Math.round(opts.maxBytes / 1024 / 1024)} MB).`;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MediaFetchError('That is not a valid URL.', 400);
  }

  // Only real web URLs. This also blocks file: and data: schemes, which would
  // otherwise let a URL field read from the server itself.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MediaFetchError(`Only http(s) ${opts.noun} URLs are supported.`, 400);
  }
  if (isPrivateHost(url.hostname)) {
    // SSRF guard: without this, an image URL is a request the server makes on
    // the caller's behalf to anywhere, including internal metadata endpoints.
    throw new MediaFetchError('That host is not reachable from here.', 400);
  }

  let res: Response;
  try {
    // Redirects are followed here, not by fetch, so every hop gets the same
    // scheme and host checks — otherwise a public URL could redirect the
    // server to an internal address.
    for (let hop = 0; ; hop++) {
      res = await httpRequest(url.toString(), {
        timeoutMs: opts.timeoutMs,
        retries: 1,
        headers: { accept: opts.accept },
        redirect: 'manual',
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) throw new MediaFetchError(`That ${opts.noun} URL redirects too many times.`);
      url = new URL(location, url);
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || isPrivateHost(url.hostname)) {
        throw new MediaFetchError('That host is not reachable from here.', 400);
      }
    }
  } catch (err) {
    if (err instanceof MediaFetchError) throw err;
    logger.warn(`media: remote ${opts.noun} fetch failed`, {
      host: url.hostname,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new MediaFetchError(`That ${opts.noun} could not be downloaded.`);
  }

  if (!res.ok) {
    throw new MediaFetchError(
      `That URL returned HTTP ${res.status} instead of ${opts.noun === 'image' ? 'an image' : 'a video'}.`,
    );
  }

  // Trust the header enough to reject early, but the bytes are what decide.
  const declaredLength = Number(res.headers.get('content-length') ?? 0);
  if (declaredLength > opts.maxBytes) {
    throw new MediaFetchError(tooLarge, 413);
  }

  // Read with a running total, so a server that lies about (or omits) its
  // length cannot make us hold more than the cap in memory.
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MediaFetchError(tooLarge, 413);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Reject hosts that are not on the public internet.
 *
 * Covers loopback, link-local (including the cloud metadata address), and the
 * RFC1918 private ranges. Hostnames that are not literal IPs are allowed
 * through — resolving them here would be a TOCTOU race anyway, and the
 * platform's egress rules are the right place for that depth of control.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // ::ffff:… is an IPv4 address in IPv6 form (e.g. [::ffff:127.0.0.1]).
  if (host === '::' || host === '::1' || host.startsWith('::ffff:') || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
