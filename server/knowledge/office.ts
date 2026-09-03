import zlib from 'node:zlib';

/**
 * Text extraction from Word (.docx) and PowerPoint (.pptx) files.
 *
 * These are the two formats real business material actually arrives in — a
 * pitch deck is a .pptx and brand guidelines are usually a .docx — and until
 * now both were rejected at the upload route, which meant the single most
 * valuable document a company owns could not be given to Aura at all.
 *
 * Both are ZIP archives of XML. Rather than take a dependency for that, this
 * reads the archive directly: Node's zlib already does the only hard part
 * (inflate), and the ZIP central directory is a well-specified structure. The
 * same reasoning the S3 client in server/media/storage.ts follows — a small,
 * readable implementation of a stable format beats a transitive dependency
 * tree for one call.
 *
 * Scope is deliberately narrow. No ZIP64 (the upload cap is 4 MB, far below the
 * 4 GB threshold where it starts), no encryption, no macros. Anything outside
 * that throws a message the user can act on rather than failing obscurely.
 */
export class OfficeParseError extends Error {}

// ---- Minimal ZIP reader ----------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end-of-central-directory record may be followed by a comment this long. */
const MAX_COMMENT = 0xffff;

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/**
 * Locate the end-of-central-directory record.
 *
 * It lives at the end of the file but is not necessarily the last bytes: a
 * trailing comment of up to 64 KB may follow it, so the signature has to be
 * scanned for backwards rather than read at a fixed offset.
 */
function findEndOfCentralDirectory(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - MAX_COMMENT - 22);
  for (let i = buf.length - 22; i >= earliest; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new OfficeParseError('This file is not a valid Word or PowerPoint document.');
}

function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const directoryOffset = buf.readUInt32LE(eocd + 16);

  if (directoryOffset === 0xffffffff) {
    throw new OfficeParseError(
      'This document uses the ZIP64 format, which is not supported. Re-save it from Word or PowerPoint and try again.',
    );
  }

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      // A truncated or rewritten archive. Whatever was read so far is still
      // usable, so stop rather than discard a partly readable document.
      break;
    }
    const compression = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    entries.push({ name, compression, compressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Decompress one entry.
 *
 * The compressed size is taken from the central directory rather than the local
 * header: the local header may carry zeros when the archive was written in
 * streaming mode (bit 3 of the general-purpose flags), which is common in files
 * produced by non-Microsoft tools.
 */
function readEntry(buf: Buffer, entry: ZipEntry): string {
  const header = entry.localHeaderOffset;
  if (header + 30 > buf.length || buf.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new OfficeParseError('This document appears to be damaged.');
  }
  const nameLength = buf.readUInt16LE(header + 26);
  const extraLength = buf.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const body = buf.subarray(start, start + entry.compressedSize);

  if (entry.compression === 0) return body.toString('utf8');
  if (entry.compression === 8) return zlib.inflateRawSync(body).toString('utf8');
  throw new OfficeParseError(
    'This document uses an unsupported compression method. Re-save it from Word or PowerPoint and try again.',
  );
}

// ---- OOXML to text ---------------------------------------------------------

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&#34;': '"',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|apos|#39|#34);/g, (m) => XML_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/**
 * Turn one OOXML part into readable text.
 *
 * Paragraph and line-break elements become newlines BEFORE tags are stripped —
 * otherwise every slide collapses into one run-on line, which destroys the
 * structure that makes a deck readable ("Problem", "Solution", "Traction" are
 * headings, not a sentence).
 *
 * Word and PowerPoint use different namespaces for the same concepts (`w:` and
 * `a:`), so both are handled here rather than in two near-identical functions.
 */
function ooxmlToText(xml: string): string {
  return decodeEntities(
    xml
      // Tab and explicit line break.
      .replace(/<(?:w|a):tab\b[^>]*\/?>/g, '\t')
      .replace(/<(?:w|a):br\b[^>]*\/?>/g, '\n')
      // End of a paragraph, and end of a PowerPoint shape or table row.
      .replace(/<\/(?:w|a):p>/g, '\n')
      .replace(/<\/(?:p:sp|a:tr|w:tr)>/g, '\n')
      // Everything else is markup.
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Slides sort numerically: slide2 comes before slide10, not after it. */
function slideNumber(name: string): number {
  const match = /(\d+)\.xml$/.exec(name);
  return match?.[1] ? Number(match[1]) : 0;
}

/**
 * Extract the readable text of a .docx or .pptx.
 *
 * Speaker notes are included for decks. In a real pitch deck the slide carries
 * three words and the notes carry the actual argument, so dropping them would
 * discard most of what makes the document worth ingesting.
 */
export function officeToText(
  data: ArrayBuffer | Buffer,
  kind: 'docx' | 'pptx',
): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries = readCentralDirectory(buf);

  const parts: { name: string; order: number }[] = [];
  if (kind === 'docx') {
    for (const entry of entries) {
      // The body, plus headers and footers where brand rules often live.
      if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(entry.name)) {
        parts.push({ name: entry.name, order: entry.name === 'word/document.xml' ? -1 : 0 });
      }
    }
  } else {
    for (const entry of entries) {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(entry.name)) {
        parts.push({ name: entry.name, order: slideNumber(entry.name) * 2 });
      } else if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.name)) {
        // Notes sort immediately after the slide they belong to.
        parts.push({ name: entry.name, order: slideNumber(entry.name) * 2 + 1 });
      }
    }
  }

  if (parts.length === 0) {
    throw new OfficeParseError(
      kind === 'docx'
        ? 'No document content found. If this is an older .doc file, save it as .docx first.'
        : 'No slides found. If this is an older .ppt file, save it as .pptx first.',
    );
  }

  parts.sort((a, b) => a.order - b.order);
  const byName = new Map(entries.map((e) => [e.name, e]));

  const sections: string[] = [];
  for (const part of parts) {
    const entry = byName.get(part.name);
    if (!entry) continue;
    let text: string;
    try {
      text = ooxmlToText(readEntry(buf, entry));
    } catch {
      // One unreadable slide must not lose the other twenty.
      continue;
    }
    if (!text) continue;

    // Label slides. A deck read as one wall of text loses the boundaries that
    // tell a model where one idea ends and the next begins.
    if (kind === 'pptx' && part.name.includes('/slides/')) {
      sections.push(`Slide ${slideNumber(part.name)}\n${text}`);
    } else if (kind === 'pptx') {
      sections.push(`Speaker notes (slide ${slideNumber(part.name)})\n${text}`);
    } else {
      sections.push(text);
    }
  }

  const combined = sections.join('\n\n').trim();
  if (!combined) {
    throw new OfficeParseError(
      'No readable text found — this file may contain only images. Export a text-based version, or paste the key points directly.',
    );
  }
  return combined;
}
