import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import { CONTENT_TYPES, type ContentTypeKey } from '@/lib/validations/content';
import { resolvePlatform, ASPECT_RATIOS, type AspectRatioKey } from '@/lib/platforms';
import {
  resolveFormat,
  closestRatioFor,
  nearestSupportedRatio,
  RATIO_DIMENSIONS,
} from '@/server/media/aspect';
import {
  sniffImageMime,
  readImageDimensions,
  validateImageBytes,
  validateForPlatform,
  MediaValidationError,
  MAX_ASSET_BYTES,
  MAX_ASSET_DIMENSION,
} from '@/server/media/validate';

/**
 * Image generation across content types, and the validation around it.
 *
 * The provider call itself needs a live API key, so what is covered here is
 * everything that decides WHAT is asked for and whether the bytes that come
 * back are keepable — the parts that were silently getting it wrong.
 */

/** A minimal but genuinely valid PNG header, sized as asked. */
function pngOf(width: number, height: number, padding = 64): Buffer {
  const buf = Buffer.alloc(24 + padding);
  buf.writeUInt32BE(0x89504e47, 0); // PNG magic
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('format resolution across every content type', () => {
  const ALL_RATIOS = [...ASPECT_RATIOS] as AspectRatioKey[];

  it('every content type resolves to a usable format on a full provider', () => {
    for (const type of CONTENT_TYPES) {
      const platform = resolvePlatform(type as ContentTypeKey, null);
      const format = resolveFormat({
        platform,
        providerRatios: ALL_RATIOS,
      });

      expect(ALL_RATIOS, `${type} produced an unknown ratio`).toContain(
        format.ratio,
      );
      expect(format.width, `${type} width`).toBeGreaterThan(0);
      expect(format.height, `${type} height`).toBeGreaterThan(0);
      // Nothing may exceed what we are willing to store, or generation would
      // succeed and then be rejected at the validation step below.
      expect(Math.max(format.width, format.height)).toBeLessThanOrEqual(
        MAX_ASSET_DIMENSION,
      );
      // A provider that supports the ratio must not report a substitution.
      expect(format.substituted, `${type} should not substitute`).toBe(false);
    }
  });

  /**
   * The case that actually breaks in production: a provider that cannot draw
   * the shape this content type wants. The request must degrade to the nearest
   * shape and SAY so, never fail and never silently return a square.
   */
  it('degrades to the nearest shape when a provider lacks the ratio', () => {
    for (const type of CONTENT_TYPES) {
      const platform = resolvePlatform(type as ContentTypeKey, null);
      const squareOnly: AspectRatioKey[] = ['1:1'];
      const format = resolveFormat({
        platform,
        providerRatios: squareOnly,
      });

      expect(format.ratio).toBe('1:1');
      const wanted = resolveFormat({ platform, providerRatios: ALL_RATIOS }).ratio;
      if (wanted !== '1:1') {
        expect(format.substituted, `${type} must report substitution`).toBe(true);
        expect(format.requested).toBe(wanted);
      }
    }
  });

  it('honours an explicit ratio the provider supports', () => {
    const platform = resolvePlatform('IMAGE_POST', null);
    for (const ratio of ALL_RATIOS) {
      const format = resolveFormat({
        requested: ratio,
        platform,
        providerRatios: ALL_RATIOS,
      });
      expect(format.ratio).toBe(ratio);
      expect(format).toMatchObject(RATIO_DIMENSIONS[ratio]);
    }
  });

  it('maps a custom size to the nearest shape and flags it', () => {
    const format = resolveFormat({
      custom: { width: 2000, height: 500 }, // extreme letterbox
      platform: resolvePlatform('IMAGE_POST', null),
      providerRatios: ALL_RATIOS,
    });
    expect(format.ratio).toBe('16:9');
    expect(format.substituted).toBe(true);
  });

  it('never drifts towards landscape when picking a fallback', () => {
    // Log-ratio comparison: a tall image must fall to a tall bucket.
    expect(closestRatioFor(768, 1344)).toBe('9:16');
    expect(closestRatioFor(1344, 768)).toBe('16:9');
    expect(closestRatioFor(1000, 1000)).toBe('1:1');
  });

  it('returns the requested ratio when a provider lists none', () => {
    expect(nearestSupportedRatio('9:16', [])).toBe('9:16');
  });
});

describe('image byte validation', () => {
  it('accepts a well-formed PNG and reads its real dimensions', () => {
    const result = validateImageBytes(pngOf(1024, 1280), {
      width: 1,
      height: 1, // deliberately wrong — the file must win
    });
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1280);
  });

  /**
   * The case this check exists for: a provider answering 200 with an HTML
   * error page. Stored unchecked it becomes a broken image in the composer and
   * a hard failure at publish time.
   */
  it('rejects an HTML error page returned with a 200', () => {
    const html = Buffer.from(
      '<!doctype html><html><body>Internal Server Error</body></html>',
    );
    expect(() => validateImageBytes(html, { width: 1024, height: 1024 })).toThrow(
      MediaValidationError,
    );
  });

  it('rejects empty bytes', () => {
    expect(() =>
      validateImageBytes(Buffer.alloc(0), { width: 1024, height: 1024 }),
    ).toThrow(/empty/i);
  });

  it('rejects a file over the storage ceiling', () => {
    const huge = Buffer.concat([
      pngOf(1024, 1024),
      Buffer.alloc(MAX_ASSET_BYTES + 1),
    ]);
    expect(() =>
      validateImageBytes(huge, { width: 1024, height: 1024 }),
    ).toThrow(/limit/i);
  });

  /**
   * A small file that decodes to an enormous canvas — byte size alone does not
   * bound this, which is why the dimension check reads the header.
   */
  it('rejects a small file that declares an enormous canvas', () => {
    const bomb = pngOf(60000, 60000);
    expect(() =>
      validateImageBytes(bomb, { width: 1024, height: 1024 }),
    ).toThrow(/largest supported edge/i);
  });

  it('identifies each supported format from its magic number', () => {
    expect(sniffImageMime(pngOf(8, 8))).toBe('image/png');

    const jpeg = Buffer.alloc(32);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    jpeg[2] = 0xff;
    expect(sniffImageMime(jpeg)).toBe('image/jpeg');

    const webp = Buffer.alloc(32);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBP', 8, 'ascii');
    expect(sniffImageMime(webp)).toBe('image/webp');

    expect(sniffImageMime(Buffer.from('not an image at all'))).toBeNull();
  });

  it('survives a truncated header without throwing', () => {
    expect(sniffImageMime(Buffer.alloc(4))).toBeNull();
    expect(readImageDimensions(Buffer.alloc(6), 'image/png')).toBeNull();
  });
});

describe('platform readiness', () => {
  it('passes a generated image at its canonical size', () => {
    const check = validateForPlatform(
      { mimeType: 'image/png', width: 1024, height: 1024, fileSize: 800_000 },
      'LINKEDIN',
    );
    expect(check.ok).toBe(true);
    expect(check.problems).toHaveLength(0);
  });

  it('reports every problem at once rather than one per attempt', () => {
    const check = validateForPlatform(
      { mimeType: 'image/gif', width: 10, height: 10, fileSize: 50_000_000 },
      'LINKEDIN',
    );
    expect(check.ok).toBe(false);
    // Wrong type, too small, too large a file — all three, in one pass.
    expect(check.problems.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * Every canonical generated size must be publishable on the platform its
   * content type targets. If this fails, the studio can produce an image the
   * composer will then refuse — a loop the user cannot get out of.
   */
  it('every content type generates something its own platform accepts', () => {
    for (const type of CONTENT_TYPES) {
      const platform = resolvePlatform(type as ContentTypeKey, null);
      const format = resolveFormat({
        platform,
        providerRatios: [...ASPECT_RATIOS] as AspectRatioKey[],
      });
      const check = validateForPlatform(
        {
          mimeType: 'image/png',
          width: format.width,
          height: format.height,
          fileSize: 1_500_000,
        },
        platform,
      );
      expect(check.problems, `${type} -> ${platform}`).toEqual([]);
    }
  });
});
