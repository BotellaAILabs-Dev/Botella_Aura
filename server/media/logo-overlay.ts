import sharp from 'sharp';

import type { LogoPosition, LogoTint } from '@/lib/image-variants';

/**
 * Place the brand's EXACT logo file on an image.
 *
 * The logo is never generated, redrawn or reinterpreted: its own pixels are
 * scaled (proportions kept, transparency kept) and composited onto the corner
 * the image left clean for it.
 *
 * It may be RECOLOURED, and only in the way a brand guideline means by a
 * one-colour or reversed logo: every opaque pixel becomes one flat colour,
 * and the alpha channel — the mark's exact shape, including its anti-aliased
 * edges — is carried over untouched. A dark logo on a dark photograph is
 * invisible, and this is the standard answer to that. The default is still
 * the uploaded file, unchanged.
 */

/** Logo box as a share of the image: at most this wide / tall. */
const MAX_WIDTH = 0.2;
const MAX_HEIGHT = 0.12;
/** Gap from the edges, as a share of the shorter side. */
const MARGIN = 0.045;
/** Below this, a logo is too small to read — refused rather than placed. */
const MIN_LOGO_PX = 24;

export class LogoOverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogoOverlayError';
  }
}

export interface OverlayResult {
  data: Buffer;
  mimeType: 'image/png';
  width: number;
  height: number;
  /** Where the logo was placed, in pixels — kept for traceability. */
  box: { left: number; top: number; width: number; height: number };
  /** The flat colour the mark was recoloured to, or null for the original. */
  tintColor: string | null;
}

/** #rgb or #rrggbb → channel values. Null for anything else. */
export function parseHex(
  hex: string | null | undefined,
): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return null;
  const h = m[1]!.length === 3
    ? m[1]!
        .split('')
        .map((c) => c + c)
        .join('')
    : m[1]!;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** The flat colour a tint resolves to, or null to leave the logo alone. */
export function tintColorFor(
  tint: LogoTint | undefined,
  brandColor: string | null | undefined,
): string | null {
  if (tint === 'white') return '#ffffff';
  if (tint === 'black') return '#000000';
  if (tint === 'brand') {
    // No usable brand colour on the workspace means the logo stays as it is,
    // rather than being recoloured to a guess.
    return parseHex(brandColor) ? `#${(brandColor ?? '').replace(/^#/, '').toLowerCase()}` : null;
  }
  return null;
}

/**
 * Every opaque pixel of the logo in one flat colour, with its alpha channel
 * untouched.
 *
 * Done by extracting the alpha and using it as the mask for a solid colour
 * rather than by filtering the RGB: a brightness or saturation filter leaves
 * a dark multi-coloured logo muddy and uneven, while this gives the clean
 * single-colour mark a brand guideline actually specifies. Because the alpha
 * is reused as-is, the silhouette and its anti-aliased edges are exactly the
 * uploaded file's.
 *
 * A logo with no alpha channel is returned unchanged: it is a rectangle, so
 * recolouring it would produce a solid block, not a mark.
 */
async function recolour(logo: Buffer, hex: string): Promise<Buffer> {
  const rgb = parseHex(hex);
  if (!rgb) return logo;

  const img = sharp(logo).ensureAlpha();
  const meta = await img.metadata();
  if (!meta.hasAlpha) return logo;
  const { width, height } = meta;
  if (!width || !height) return logo;

  const alpha = await img.extractChannel('alpha').raw().toBuffer();
  // The canvas is created with THREE channels and the logo's alpha is joined
  // on as the fourth. Creating it with four (an RGBA canvas at alpha 1) and
  // joining the mask appends a fifth channel instead of replacing the alpha,
  // so the mark's transparency is ignored and the recoloured logo arrives as
  // a solid rectangle that paints over the photograph.
  return sharp({
    create: { width, height, channels: 3, background: rgb },
  })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

export async function overlayLogo(args: {
  image: Buffer;
  logo: Buffer;
  position: LogoPosition;
  /** 'original' (the default) leaves the uploaded file's own colours. */
  tint?: LogoTint;
  /** The workspace's primary colour, for tint 'brand'. */
  brandColor?: string | null;
}): Promise<OverlayResult> {
  const base = sharp(args.image).rotate();
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new LogoOverlayError('The image could not be read.');

  let logoMeta: sharp.Metadata;
  try {
    logoMeta = await sharp(args.logo).metadata();
  } catch {
    throw new LogoOverlayError('Your logo file could not be read. Upload it again as a PNG.');
  }
  if (!logoMeta.width || !logoMeta.height) throw new LogoOverlayError('Your logo file could not be read. Upload it again as a PNG.');

  // Fit inside the box, proportions untouched.
  const boxW = Math.round(width * MAX_WIDTH);
  const boxH = Math.round(height * MAX_HEIGHT);
  const scale = Math.min(boxW / logoMeta.width, boxH / logoMeta.height);
  const logoW = Math.max(1, Math.round(logoMeta.width * scale));
  const logoH = Math.max(1, Math.round(logoMeta.height * scale));
  if (Math.min(logoW, logoH) < MIN_LOGO_PX && Math.max(logoW, logoH) < MIN_LOGO_PX * 3) {
    throw new LogoOverlayError('The image is too small to place your logo legibly.');
  }

  const margin = Math.round(Math.min(width, height) * MARGIN);
  const left = args.position.endsWith('left') ? margin : width - logoW - margin;
  const top = args.position.startsWith('top') ? margin : height - logoH - margin;

  // Recolour BEFORE resizing, so the flat colour is applied to the full-size
  // alpha and the downscale does the anti-aliasing — recolouring after would
  // apply a hard colour to already-softened edges and leave them ragged.
  const tintColor = tintColorFor(args.tint, args.brandColor);
  const source = tintColor ? await recolour(args.logo, tintColor) : args.logo;

  const logo = await sharp(source)
    .resize({ width: logoW, height: logoH, fit: 'inside', kernel: 'lanczos3' })
    .png()
    .toBuffer();

  const data = await base
    .composite([{ input: logo, left, top, blend: 'over' }])
    .png()
    .toBuffer();

  return {
    data,
    mimeType: 'image/png',
    width,
    height,
    box: { left, top, width: logoW, height: logoH },
    tintColor,
  };
}
