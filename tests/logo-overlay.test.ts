import { describe, it, expect } from 'vitest';
import sharp from 'sharp';

import {
  overlayLogo,
  parseHex,
  tintColorFor,
} from '@/server/media/logo-overlay';

/**
 * Placing the brand logo, and colouring it.
 *
 * These assert on actual pixels rather than on the code's own report, because
 * the whole promise of this module is that the logo on the image IS the
 * uploaded file: its shape, its transparency, and either its own colours or
 * one flat colour. A function that returns the right metadata while writing
 * the wrong pixels would pass any lighter test.
 */

/** A logo: an opaque red square in the middle of a transparent canvas. */
async function testLogo(): Promise<Buffer> {
  const mark = await sharp({
    create: {
      width: 50,
      height: 50,
      channels: 4,
      background: { r: 220, g: 30, b: 30, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: 100,
      height: 100,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: mark, left: 25, top: 25 }])
    .png()
    .toBuffer();
}

/** A dark "photograph" — the case a dark logo disappears into. */
const photo = () =>
  sharp({
    create: {
      width: 1000,
      height: 1000,
      channels: 3,
      background: { r: 20, g: 20, b: 25 },
    },
  })
    .png()
    .toBuffer();

/** The pixel at (x, y) as [r, g, b]. */
async function pixel(
  image: Buffer,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  const raw = await sharp(image)
    .removeAlpha()
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer();
  return [raw[0]!, raw[1]!, raw[2]!];
}

/** Channels within `tolerance` of each other (lanczos resampling is lossy). */
function near(
  got: [number, number, number],
  want: [number, number, number],
  tolerance = 12,
): boolean {
  return got.every((c, i) => Math.abs(c - want[i]!) <= tolerance);
}

describe('hex parsing', () => {
  it('reads both short and long form, and refuses anything else', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('ABCDEF')).toEqual({ r: 171, g: 205, b: 239 });
    expect(parseHex('#1a73e8')).toEqual({ r: 26, g: 115, b: 232 });
    for (const bad of ['', '  ', 'not-a-hex', '#12345', 'rgb(1,2,3)', null]) {
      expect(parseHex(bad)).toBeNull();
    }
  });
});

describe('which colour a tint resolves to', () => {
  it('maps the fixed tints and leaves the original alone', () => {
    expect(tintColorFor('white', null)).toBe('#ffffff');
    expect(tintColorFor('black', null)).toBe('#000000');
    expect(tintColorFor('original', '#1a73e8')).toBeNull();
    expect(tintColorFor(undefined, '#1a73e8')).toBeNull();
  });

  it('uses the brand colour, and falls back to the logo as uploaded without one', () => {
    expect(tintColorFor('brand', '#1a73e8')).toBe('#1a73e8');
    expect(tintColorFor('brand', '1A73E8')).toBe('#1a73e8');
    // No usable brand colour must mean "leave the logo as it is", never a
    // guessed colour — a wrong brand colour on a logo is worse than none.
    expect(tintColorFor('brand', null)).toBeNull();
    expect(tintColorFor('brand', 'navy')).toBeNull();
  });
});

describe('placing the logo', () => {
  it('keeps the uploaded colours by default', async () => {
    const out = await overlayLogo({
      image: await photo(),
      logo: await testLogo(),
      position: 'bottom-right',
    });
    expect(out.tintColor).toBeNull();
    const centre = await pixel(
      out.data,
      Math.round(out.box.left + out.box.width / 2),
      Math.round(out.box.top + out.box.height / 2),
    );
    expect(near(centre, [220, 30, 30])).toBe(true);
  });

  it('recolours the mark to one flat colour, keeping the image around it', async () => {
    for (const [tint, want] of [
      ['white', [255, 255, 255]],
      ['black', [0, 0, 0]],
      ['brand', [26, 115, 232]],
    ] as const) {
      const out = await overlayLogo({
        image: await photo(),
        logo: await testLogo(),
        position: 'bottom-right',
        tint,
        brandColor: '#1a73e8',
      });
      const centre = await pixel(
        out.data,
        Math.round(out.box.left + out.box.width / 2),
        Math.round(out.box.top + out.box.height / 2),
      );
      expect(near(centre, want as unknown as [number, number, number])).toBe(
        true,
      );

      // The transparent part of the logo's own box must still be the
      // photograph: recolouring must not fill the mark's bounding box.
      const around = await pixel(out.data, out.box.left + 2, out.box.top + 2);
      expect(near(around, [20, 20, 25])).toBe(true);
    }
  });

  it('reports the colour it used, and null when brand had none to use', async () => {
    const withColor = await overlayLogo({
      image: await photo(),
      logo: await testLogo(),
      position: 'top-left',
      tint: 'brand',
      brandColor: '#1a73e8',
    });
    expect(withColor.tintColor).toBe('#1a73e8');

    const without = await overlayLogo({
      image: await photo(),
      logo: await testLogo(),
      position: 'top-left',
      tint: 'brand',
      brandColor: null,
    });
    expect(without.tintColor).toBeNull();
    // ...and the logo kept its own colours rather than being recoloured.
    const centre = await pixel(
      without.data,
      Math.round(without.box.left + without.box.width / 2),
      Math.round(without.box.top + without.box.height / 2),
    );
    expect(near(centre, [220, 30, 30])).toBe(true);
  });

  it('leaves a logo with no transparency alone — it is a rectangle, not a mark', async () => {
    const flat = await sharp({
      create: {
        width: 100,
        height: 40,
        channels: 3,
        background: { r: 10, g: 200, b: 10 },
      },
    })
      .png()
      .toBuffer();
    const out = await overlayLogo({
      image: await photo(),
      logo: flat,
      position: 'top-left',
      tint: 'white',
    });
    // Recolouring this would paint a solid white block over the photograph.
    const centre = await pixel(
      out.data,
      Math.round(out.box.left + out.box.width / 2),
      Math.round(out.box.top + out.box.height / 2),
    );
    expect(near(centre, [10, 200, 10])).toBe(true);
  });

  it('puts the logo in the corner asked for', async () => {
    const image = await photo();
    const logo = await testLogo();
    const corners = {
      'top-left': (b: { left: number; top: number }) => b.left < 500 && b.top < 500,
      'top-right': (b: { left: number; top: number }) => b.left > 500 && b.top < 500,
      'bottom-left': (b: { left: number; top: number }) => b.left < 500 && b.top > 500,
      'bottom-right': (b: { left: number; top: number }) => b.left > 500 && b.top > 500,
    } as const;
    for (const [position, inCorner] of Object.entries(corners)) {
      const out = await overlayLogo({
        image,
        logo,
        position: position as keyof typeof corners,
      });
      expect(inCorner(out.box)).toBe(true);
    }
  });

  it('does not change the image’s size', async () => {
    const out = await overlayLogo({
      image: await photo(),
      logo: await testLogo(),
      position: 'bottom-right',
      tint: 'white',
    });
    expect([out.width, out.height]).toEqual([1000, 1000]);
    const meta = await sharp(out.data).metadata();
    expect([meta.width, meta.height]).toEqual([1000, 1000]);
  });
});
