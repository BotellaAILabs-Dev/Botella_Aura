import sharp from 'sharp';

import type { LogoPosition } from '@/lib/image-variants';

/**
 * Place the brand's EXACT logo file on an image.
 *
 * The logo is never generated, redrawn, recoloured or reinterpreted: its own
 * pixels are scaled (proportions kept, transparency kept) and composited onto
 * the corner the image left clean for it. The only change to the logo is its
 * size.
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
}

export async function overlayLogo(args: {
  image: Buffer;
  logo: Buffer;
  position: LogoPosition;
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

  const logo = await sharp(args.logo)
    .resize({ width: logoW, height: logoH, fit: 'inside', kernel: 'lanczos3' })
    .png()
    .toBuffer();

  const data = await base
    .composite([{ input: logo, left, top, blend: 'over' }])
    .png()
    .toBuffer();

  return { data, mimeType: 'image/png', width, height, box: { left, top, width: logoW, height: logoH } };
}
