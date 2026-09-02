import { describe, it, expect } from 'vitest';

import {
  MAX_ASSET_BYTES,
  MediaValidationError,
  readImageDimensions,
  sniffImageMime,
  validateForPlatform,
  validateImageBytes,
} from '@/server/media/validate';

/**
 * Media validation. This is the layer that stops a provider's HTML error page
 * becoming a row in the database, and stops an oversized graphic becoming a
 * rejected post — so both the sniffing and the platform rules are pinned.
 */

/** A minimal but structurally real PNG header with IHDR width/height. */
function pngWith(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(64);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** A JPEG whose SOF0 segment declares the given size. */
function jpegWith(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(32);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff; // start of the segment we want found
  buffer[3] = 0xc0; // SOF0
  buffer.writeUInt16BE(17, 4); // segment length
  buffer[6] = 8; // precision
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

describe('sniffImageMime', () => {
  it('identifies PNG from its magic number', () => {
    expect(sniffImageMime(pngWith(10, 10))).toBe('image/png');
  });

  it('identifies JPEG from its magic number', () => {
    expect(sniffImageMime(jpegWith(10, 10))).toBe('image/jpeg');
  });

  it('identifies WEBP from the RIFF/WEBP pair', () => {
    const webp = Buffer.alloc(32);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBP', 8, 'ascii');
    expect(sniffImageMime(webp)).toBe('image/webp');
  });

  it('rejects an HTML error page a provider returned with a 200', () => {
    // The real failure this guards against: a provider answering 200 with an
    // error document. Trusting Content-Type would store it as an image.
    const html = Buffer.from('<!DOCTYPE html><html><body>error</body></html>');
    expect(sniffImageMime(html)).toBeNull();
  });

  it('rejects a buffer too short to identify', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe('readImageDimensions', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(readImageDimensions(pngWith(1024, 1280), 'image/png')).toEqual({
      width: 1024,
      height: 1280,
    });
  });

  it('reads JPEG dimensions from the start-of-frame marker', () => {
    expect(readImageDimensions(jpegWith(800, 600), 'image/jpeg')).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('returns null rather than throwing on a truncated file', () => {
    expect(readImageDimensions(Buffer.alloc(4), 'image/png')).toBeNull();
  });
});

describe('validateImageBytes', () => {
  it('prefers the real dimensions over what the provider claimed', () => {
    // Providers report the size they were ASKED for, not always what they sent.
    const result = validateImageBytes(pngWith(1024, 1280), {
      width: 9999,
      height: 9999,
    });
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1280);
    expect(result.mimeType).toBe('image/png');
  });

  it('falls back to the claimed size when the header cannot be parsed', () => {
    const almostPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
    const result = validateImageBytes(almostPng, { width: 512, height: 512 });
    expect(result.width).toBe(512);
  });

  it('rejects an empty response', () => {
    expect(() =>
      validateImageBytes(Buffer.alloc(0), { width: 1, height: 1 }),
    ).toThrow(MediaValidationError);
  });

  it('rejects anything that is not a supported image', () => {
    expect(() =>
      validateImageBytes(Buffer.from('not an image at all, really'), {
        width: 1,
        height: 1,
      }),
    ).toThrow(MediaValidationError);
  });

  it('rejects an image over the storage ceiling', () => {
    const huge = Buffer.concat([
      pngWith(10, 10),
      Buffer.alloc(MAX_ASSET_BYTES + 1),
    ]);
    expect(() => validateImageBytes(huge, { width: 10, height: 10 })).toThrow(
      MediaValidationError,
    );
  });
});

describe('validateForPlatform', () => {
  const ok = {
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    fileSize: 1_500_000,
  };

  it('accepts a normal square PNG on LinkedIn', () => {
    expect(validateForPlatform(ok, 'LINKEDIN')).toEqual({
      ok: true,
      problems: [],
    });
  });

  it('rejects WEBP on LinkedIn, which does not accept it', () => {
    const result = validateForPlatform({ ...ok, mimeType: 'image/webp' }, 'LINKEDIN');
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('image/webp');
  });

  it('rejects an image over the long-edge cap for Instagram', () => {
    const result = validateForPlatform(
      { ...ok, width: 2048, height: 2048 },
      'INSTAGRAM',
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('long edge');
  });

  it('reports every problem at once rather than only the first', () => {
    const result = validateForPlatform(
      { mimeType: 'image/webp', width: 50, height: 50, fileSize: 20_000_000 },
      'INSTAGRAM',
    );
    expect(result.problems.length).toBeGreaterThanOrEqual(3);
  });
});
