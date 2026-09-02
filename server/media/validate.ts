import type { SocialPlatformKey } from '@/lib/platforms';
import { platformSpec } from '@/lib/platforms';

/**
 * Media validation — what we will store, and what a platform will accept.
 *
 * Two separate questions, deliberately separate functions. Storage validation
 * runs at generation time and protects the database; platform validation runs
 * before publishing and protects the user from a rejection they would otherwise
 * only discover as a failed post.
 *
 * The MIME type is SNIFFED from the bytes rather than trusted from the
 * provider's Content-Type header. A provider that mislabels a JPEG as PNG is a
 * mild annoyance here and a hard publish failure at LinkedIn, so the header is
 * treated as a hint and the magic number as the truth.
 */

/** Formats we accept, generate and publish. */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;
export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

/**
 * Ceiling for a single stored asset.
 *
 * With DATABASE storage every byte lives in a Postgres row, so this is a real
 * database-health limit, not a formality. A 1024x1280 PNG lands around 1.5-2 MB;
 * 12 MB leaves generous headroom without letting one pathological generation
 * bloat a table.
 */
export const MAX_ASSET_BYTES = 12 * 1024 * 1024;

/**
 * Largest edge we will store, in pixels.
 *
 * 4096 is the most generous ceiling any supported platform has (X); every other
 * one is lower. Since there is no image resizing in this stack, storing
 * something larger would only defer the rejection to publish time — so it is
 * refused here, where the message can tell the user to export it smaller.
 *
 * Generated images are unaffected: the largest canonical size is 1344px.
 */
export const MAX_ASSET_DIMENSION = 4096;

export class MediaValidationError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

/**
 * Identify an image from its magic number.
 *
 * PNG: 89 50 4E 47. JPEG: FF D8 FF. WEBP: "RIFF" .... "WEBP".
 * Returns null for anything else — including an HTML error page a provider
 * handed back with a 200, which is exactly the case this catches.
 */
export function sniffImageMime(data: Buffer): SupportedImageMime | null {
  if (data.length < 12) return null;

  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Read the real pixel dimensions out of the file header.
 *
 * Providers report the size they were ASKED for, which is not always the size
 * they returned. Since the stored width/height drive platform validation and
 * the UI's aspect boxes, they need to come from the file itself. Returns null
 * when the header cannot be parsed, in which case the caller keeps the
 * provider's claim rather than failing the generation.
 */
export function readImageDimensions(
  data: Buffer,
  mime: SupportedImageMime,
): { width: number; height: number } | null {
  try {
    if (mime === 'image/png') {
      // IHDR is always the first chunk: width/height are big-endian at 16/20.
      if (data.length < 24) return null;
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    if (mime === 'image/webp') {
      // Simple lossy VP8 ("VP8 ") and lossless VP8L differ in layout.
      const format = data.toString('ascii', 12, 16);
      if (format === 'VP8X' && data.length >= 30) {
        // 24-bit little-endian, stored as (dimension - 1).
        const width = 1 + (data[24]! | (data[25]! << 8) | (data[26]! << 16));
        const height = 1 + (data[27]! | (data[28]! << 8) | (data[29]! << 16));
        return { width, height };
      }
      if (format === 'VP8 ' && data.length >= 30) {
        return {
          width: data.readUInt16LE(26) & 0x3fff,
          height: data.readUInt16LE(28) & 0x3fff,
        };
      }
      if (format === 'VP8L' && data.length >= 25) {
        const bits =
          data[21]! | (data[22]! << 8) | (data[23]! << 16) | (data[24]! << 24);
        return {
          width: 1 + (bits & 0x3fff),
          height: 1 + ((bits >> 14) & 0x3fff),
        };
      }
      return null;
    }

    // JPEG: walk the segment markers to the start-of-frame, which carries size.
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = data[offset + 1]!;
      // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 all carry dimensions.
      const isStartOfFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isStartOfFrame) {
        return {
          height: data.readUInt16BE(offset + 5),
          width: data.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + data.readUInt16BE(offset + 2);
    }
    return null;
  } catch {
    // A truncated or unusual file is not worth failing a generation over.
    return null;
  }
}

export interface ValidatedImage {
  mimeType: SupportedImageMime;
  width: number;
  height: number;
  fileSize: number;
}

/**
 * Validate bytes before they are stored. Throws MediaValidationError (422) with
 * a message safe to show the user.
 */
export function validateImageBytes(
  data: Buffer,
  claimed: { width: number; height: number },
): ValidatedImage {
  // Wording stays source-neutral: this same function validates images from a
  // provider AND images the user supplied, and "the provider returned…" is
  // confusing when the user just dragged in their own file.
  if (data.byteLength === 0) {
    throw new MediaValidationError('That image is empty.');
  }
  if (data.byteLength > MAX_ASSET_BYTES) {
    throw new MediaValidationError(
      `That image is ${(data.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${
        MAX_ASSET_BYTES / 1024 / 1024
      } MB limit. Generate at a smaller format.`,
    );
  }

  const mimeType = sniffImageMime(data);
  if (!mimeType) {
    throw new MediaValidationError(
      'That file is not a PNG, JPEG or WEBP image.',
    );
  }

  const real = readImageDimensions(data, mimeType);
  const width = real?.width ?? claimed.width;
  const height = real?.height ?? claimed.height;

  // Checked on the REAL dimensions, so a small file that decodes to an enormous
  // canvas is caught too — byte size alone does not bound this.
  const longestEdge = Math.max(width, height);
  if (longestEdge > MAX_ASSET_DIMENSION) {
    throw new MediaValidationError(
      `That image is ${width}x${height}. The largest supported edge is ${MAX_ASSET_DIMENSION}px — export it smaller and try again.`,
    );
  }

  return { mimeType, width, height, fileSize: data.byteLength };
}

export interface PlatformMediaCheck {
  ok: boolean;
  /** Everything wrong, so the user fixes it in one pass rather than three. */
  problems: string[];
}

/**
 * Check a stored asset against a platform's published requirements.
 *
 * Called before publishing so a mismatch surfaces as an explanation in the
 * composer, not as a rejected post an hour after it was scheduled.
 */
export function validateForPlatform(
  asset: { mimeType: string; width: number; height: number; fileSize: number },
  platform: SocialPlatformKey,
): PlatformMediaCheck {
  const spec = platformSpec(platform);
  const problems: string[] = [];

  if (!spec.acceptedMimeTypes.includes(asset.mimeType)) {
    problems.push(
      `${spec.label} does not accept ${asset.mimeType} (it takes ${spec.acceptedMimeTypes.join(', ')}).`,
    );
  }
  if (asset.fileSize > spec.maxFileSizeBytes) {
    problems.push(
      `The image is ${(asset.fileSize / 1024 / 1024).toFixed(1)} MB; ${spec.label} allows up to ${(
        spec.maxFileSizeBytes /
        1024 /
        1024
      ).toFixed(0)} MB.`,
    );
  }
  const smallest = Math.min(asset.width, asset.height);
  const largest = Math.max(asset.width, asset.height);
  if (smallest < spec.minDimension) {
    problems.push(
      `The image is ${asset.width}x${asset.height}; ${spec.label} wants at least ${spec.minDimension}px on the short edge.`,
    );
  }
  if (largest > spec.maxDimension) {
    problems.push(
      `The image is ${asset.width}x${asset.height}; ${spec.label} caps the long edge at ${spec.maxDimension}px.`,
    );
  }

  return { ok: problems.length === 0, problems };
}
