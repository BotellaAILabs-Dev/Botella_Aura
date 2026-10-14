/**
 * Reading a video's facts from its BYTES (MP4 / QuickTime MOV — ISO base
 * media file format), the same rule images follow: never trust a filename or
 * a server's Content-Type. Only the header boxes are read; nothing is decoded.
 *
 *   ftyp   the file type → video/mp4 or video/quicktime
 *   mvhd   timescale + duration → seconds
 *   tkhd   width × height of the video track (16.16 fixed point)
 *   stsd   the video codec (avc1/avc3 = H.264, hvc1/hev1 = HEVC)
 */

export interface VideoFacts {
  mimeType: 'video/mp4' | 'video/quicktime';
  width: number;
  height: number;
  durationSec: number;
  /** The sample-entry fourcc of the video track, e.g. "avc1". */
  codec: string | null;
}

export class VideoReadError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'VideoReadError';
  }
}

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function boxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      const big = buf.readBigUInt64BE(at + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

const child = (buf: Buffer, b: Box, type: string) => boxes(buf, b.start, b.end).find((x) => x.type === type);

/** True when the bytes start like an ISO media file (an `ftyp` box first). */
export function looksLikeVideo(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp';
}

export function inspectVideo(buf: Buffer): VideoFacts {
  if (!looksLikeVideo(buf)) throw new VideoReadError('That file is not an MP4 or MOV video.');
  const top = boxes(buf, 0, buf.length);
  const ftyp = top.find((b) => b.type === 'ftyp');
  if (!ftyp) throw new VideoReadError('That file is not an MP4 or MOV video.');
  const brand = buf.toString('latin1', ftyp.start, ftyp.start + 4);
  const mimeType = brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';

  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new VideoReadError('That video has no index (moov box) — re-export it as a standard MP4 and try again.');

  // Duration (movie header).
  const mvhd = child(buf, moov, 'mvhd');
  if (!mvhd) throw new VideoReadError('That video’s length could not be read.');
  const v = buf.readUInt8(mvhd.start);
  const timescale = buf.readUInt32BE(mvhd.start + (v === 1 ? 20 : 12));
  const duration = v === 1 ? Number(buf.readBigUInt64BE(mvhd.start + 24)) : buf.readUInt32BE(mvhd.start + 16);
  if (!timescale) throw new VideoReadError('That video’s length could not be read.');
  const durationSec = Math.round((duration / timescale) * 100) / 100;

  // The video track: the one whose handler is "vide" (else the first with a size).
  let width = 0;
  let height = 0;
  let codec: string | null = null;
  for (const trak of boxes(buf, moov.start, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = child(buf, trak, 'mdia');
    const hdlr = mdia && child(buf, mdia, 'hdlr');
    const handler = hdlr ? buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) : null;
    if (handler && handler !== 'vide') continue;
    const tkhd = child(buf, trak, 'tkhd');
    if (!tkhd) continue;
    const tv = buf.readUInt8(tkhd.start);
    // version 0: 4 + 4+4+4+4+4 + 8 + 2+2+2+2 + 36 = 76 bytes before width
    const at = tkhd.start + (tv === 1 ? 88 : 76);
    if (at + 8 > tkhd.end) continue;
    const w = Math.round(buf.readUInt32BE(at) / 65536);
    const h = Math.round(buf.readUInt32BE(at + 4) / 65536);
    if (!w || !h) continue;
    width = w;
    height = h;
    const stsd = mdia && child(buf, mdia, 'minf') && (() => {
      const minf = child(buf, mdia, 'minf')!;
      const stbl = child(buf, minf, 'stbl');
      return stbl ? child(buf, stbl, 'stsd') : undefined;
    })();
    if (stsd && stsd.start + 16 <= stsd.end) codec = buf.toString('latin1', stsd.start + 12, stsd.start + 16);
    break;
  }
  if (!width || !height) throw new VideoReadError('That file has no video track.');
  return { mimeType, width, height, durationSec, codec };
}

/** H.264 or HEVC — what Instagram accepts. */
export const isSupportedCodec = (codec: string | null) => codec !== null && ['avc1', 'avc3', 'hvc1', 'hev1'].includes(codec);
