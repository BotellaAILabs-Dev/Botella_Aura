#!/usr/bin/env node
/**
 * Package the companion Chrome extension into a downloadable .zip.
 *
 * Runs as part of `pnpm build`, so every deploy serves an installable build at
 * /downloads/botella-aura-extension.zip. That is what makes the extension
 * testable end-to-end without a Chrome Web Store listing: a reviewer downloads
 * the zip from Settings → Browser extension, unzips it, and loads it unpacked.
 *
 * Deliberately dependency-free and cross-platform (the previous packaging step
 * shelled out to PowerShell, so it only worked on Windows and never ran in CI).
 * Writes a STORED (uncompressed) zip — a few hundred KB of text, and Chrome
 * loads it exactly the same.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'extension');
const outDir = join(root, 'public', 'downloads');
const outFile = join(outDir, 'botella-aura-extension.zip');

/** Files that belong to the extension itself, not its tooling. */
const EXCLUDE = new Set(['package.json', 'node_modules', '.DS_Store']);
const EXCLUDE_EXT = new Set(['.zip', '.md']);

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collect(full));
      continue;
    }
    const dot = entry.lastIndexOf('.');
    if (dot > 0 && EXCLUDE_EXT.has(entry.slice(dot))) continue;
    out.push(full);
  }
  return out;
}

// --- CRC-32 (zip requires it; Node has no built-in) -------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

/**
 * Fixed DOS timestamp (1 Jan 2020, 00:00). A stable mtime keeps the zip
 * byte-identical between builds when the sources have not changed, so the
 * download URL can be cached and the checksum shown to users is meaningful.
 */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function localHeader(nameBuf, data, crc) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); // signature
  h.writeUInt16LE(20, 4); // version needed
  h.writeUInt16LE(0, 6); // flags
  h.writeUInt16LE(0, 8); // method: stored
  h.writeUInt16LE(DOS_TIME, 10);
  h.writeUInt16LE(DOS_DATE, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(data.length, 18); // compressed size
  h.writeUInt32LE(data.length, 22); // uncompressed size
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28); // extra length
  return h;
}

function centralHeader(nameBuf, data, crc, offset) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4); // version made by
  h.writeUInt16LE(20, 6); // version needed
  h.writeUInt16LE(0, 8);
  h.writeUInt16LE(0, 10); // stored
  h.writeUInt16LE(DOS_TIME, 12);
  h.writeUInt16LE(DOS_DATE, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(data.length, 20);
  h.writeUInt32LE(data.length, 24);
  h.writeUInt16LE(nameBuf.length, 28);
  h.writeUInt16LE(0, 30); // extra
  h.writeUInt16LE(0, 32); // comment
  h.writeUInt16LE(0, 34); // disk
  h.writeUInt16LE(0, 36); // internal attrs
  h.writeUInt32LE(0, 38); // external attrs
  h.writeUInt32LE(offset, 42);
  return h;
}

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = localHeader(nameBuf, data, crc);
    central.push(centralHeader(nameBuf, data, crc, offset));
    central.push(nameBuf);
    chunks.push(lh, nameBuf, data);
    offset += lh.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

function main() {
  let entries;
  try {
    entries = collect(sourceDir);
  } catch {
    console.warn('[package-extension] extension/ not found — skipping.');
    return;
  }
  if (entries.length === 0) {
    console.warn('[package-extension] no extension files found — skipping.');
    return;
  }

  const files = entries
    .map((full) => ({
      name: posix.join(...relative(sourceDir, full).split(/[\\/]/)),
      data: readFileSync(full),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const zip = buildZip(files);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, zip);

  const sha = createHash('sha256').update(zip).digest('hex').slice(0, 16);
  const manifest = JSON.parse(
    readFileSync(join(sourceDir, 'manifest.json'), 'utf8'),
  );
  writeFileSync(
    join(outDir, 'botella-aura-extension.json'),
    `${JSON.stringify(
      {
        version: manifest.version,
        files: files.length,
        bytes: zip.length,
        sha256Prefix: sha,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `[package-extension] wrote ${relative(root, outFile)} (v${manifest.version}, ${files.length} files, ${zip.length} bytes)`,
  );
}

main();
