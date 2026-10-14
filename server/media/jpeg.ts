import sharp from 'sharp';

/**
 * Instagram's Content Publishing API takes JPEG images only, while Aura's
 * creatives and many uploads are PNG (or WebP). This re-encodes an image as a
 * baseline JPEG for the URL Instagram fetches — the stored asset is untouched.
 *
 * Transparency has no meaning in JPEG, so it is flattened onto white (the
 * colour a transparent PNG shows on Instagram's own light theme). Quality 90
 * keeps text and logos crisp; EXIF orientation is applied so nothing arrives
 * rotated.
 */
export async function toJpeg(data: Buffer): Promise<Buffer> {
  return sharp(data).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

/** Formats that must be converted before Instagram will take them. */
export const needsJpeg = (mimeType: string) => mimeType !== 'image/jpeg' && mimeType.startsWith('image/');
