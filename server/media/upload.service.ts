import crypto from 'node:crypto';

import type { ContentDraft } from '@prisma/client';

import { httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { resolvePlatform } from '@/lib/platforms';
import type { ContentTypeKey } from '@/lib/validations/content';
import { validateImageBytes } from '@/server/media/validate';
import { putImage } from '@/server/media/storage';
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
 * Fetch a remote image so it can be stored locally.
 *
 * Storing a copy rather than referencing the URL is the whole point: a post
 * scheduled for next week cannot depend on somebody else's server still
 * serving that file, and LinkedIn needs the bytes to upload anyway.
 */
export async function fetchRemoteImage(rawUrl: string): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MediaFetchError('That is not a valid URL.', 400);
  }

  // Only real web URLs. This also blocks file: and data: schemes, which would
  // otherwise let a URL field read from the server itself.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MediaFetchError('Only http(s) image URLs are supported.', 400);
  }
  if (isPrivateHost(url.hostname)) {
    // SSRF guard: without this, an image URL is a request the server makes on
    // the caller's behalf to anywhere, including internal metadata endpoints.
    throw new MediaFetchError('That host is not reachable from here.', 400);
  }

  let res: Response;
  try {
    res = await httpRequest(url.toString(), {
      timeoutMs: REMOTE_TIMEOUT_MS,
      retries: 1,
      headers: { accept: 'image/*' },
    });
  } catch (err) {
    logger.warn('media: remote image fetch failed', {
      host: url.hostname,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new MediaFetchError('That image could not be downloaded.');
  }

  if (!res.ok) {
    throw new MediaFetchError(
      `That URL returned HTTP ${res.status} instead of an image.`,
    );
  }

  // Trust the header enough to reject early, but the bytes are what decide.
  const declaredLength = Number(res.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_REMOTE_BYTES) {
    throw new MediaFetchError('That image is too large (over 15 MB).');
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_REMOTE_BYTES) {
    throw new MediaFetchError('That image is too large (over 15 MB).');
  }
  return buffer;
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
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
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
