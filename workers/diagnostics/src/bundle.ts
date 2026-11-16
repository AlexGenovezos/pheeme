// Checks what is inside an uploaded bundle before it is stored. The upload URL is public, so
// anything could arrive: only the files the app writes are accepted, and each screenshot must be
// exactly the kind of PNG the app produces (`src-tauri/src/support/screenshot.rs`): stored
// uncompressed, 8-bit RGB or RGBA, only IHDR, IDAT and IEND chunks with good checksums, and
// nothing after IEND. That refuses renamed programs, files that parse as two formats, and
// payloads appended to an image. Reading the zip's directory and the PNG chunk structure needs
// no decompression. The pixel data itself (IDAT) isn't inflated here, to stay inside a Worker's
// CPU time; `pheeme-diag.py` inflates and checks it before a screenshot is opened.
//
// A file name the app starts writing must be added to `ALLOWED` here, and this Worker deployed,
// before that app version ships.

const ALLOWED = [
  /^summary\.json$/,
  /^logs\/pheeme\.log$/,
  /^email\/thread\.json$/,
  /^email\/[A-Za-z0-9_]{1,64}\/(original\.html|shown\.html|body\.txt)$/,
];
const SCREENSHOT = /^screenshots\/[1-3]\.png$/;
/** Matches `MAX_PNG_BYTES` and `MAX_SIDE` in `screenshot.rs`. */
export const MAX_SCREENSHOT_BYTES = 1_000_000;
export const MAX_SCREENSHOT_SIDE = 2560;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Null when the bundle holds only what the app writes; otherwise why it was refused. */
export function checkBundle(zip: Uint8Array): string | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = findEndOfDirectory(view);
  if (eocd < 0) return "Bundle is not a readable zip";
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
    return "Bundle is not a readable zip";
  }
  const count = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirStart = view.getUint32(eocd + 16, true);
  if (view.getUint16(eocd + 8, true) !== count || dirStart + dirSize !== eocd) {
    return "Bundle is not a readable zip";
  }

  const names = new Set<string>();
  let at = dirStart;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== CENTRAL_SIG) {
      return "Bundle is not a readable zip";
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) return "Bundle is not a readable zip";
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    at = next;

    if (flags & 1) return "Bundle is encrypted";
    if (names.has(name)) return "Bundle repeats a file";
    names.add(name);
    if (SCREENSHOT.test(name)) {
      if (method !== STORED || packed !== size) return "Screenshot is compressed";
      const data = entryData(view, local, packed, dirStart);
      if (!data) return "Bundle is not a readable zip";
      if (crc32(data) !== crc) return "Screenshot is damaged";
      const problem = checkPng(data);
      if (problem) return `${name}: ${problem}`;
    } else if (!ALLOWED.some((re) => re.test(name))) {
      return "Bundle has an unexpected file";
    } else if (method !== STORED && method !== DEFLATED) {
      return "Bundle is not a readable zip";
    }
  }
  // Every entry was read: none hides past a count lowered to skip it.
  return at === eocd ? null : "Bundle is not a readable zip";
}

/** The end-of-directory record, which must close the file (a comment may sit inside it). */
function findEndOfDirectory(view: DataView): number {
  const last = view.byteLength - 22;
  for (let at = last; at >= 0 && at >= last - 0xffff; at--) {
    if (view.getUint32(at, true) !== EOCD_SIG) continue;
    if (at + 22 + view.getUint16(at + 20, true) === view.byteLength) return at;
  }
  return -1;
}

/** An entry's bytes, from its local header; null when they don't fit before the directory. */
function entryData(view: DataView, local: number, length: number, end: number): Uint8Array | null {
  if (local + 30 > end || view.getUint32(local, true) !== LOCAL_SIG) return null;
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  if (start + length > end) return null;
  return new Uint8Array(view.buffer, view.byteOffset + start, length);
}

/** Null when `png` is a PNG of the shape the app writes; otherwise what is wrong with it. */
export function checkPng(png: Uint8Array): string | null {
  if (png.byteLength > MAX_SCREENSHOT_BYTES) return "too large";
  if (png.byteLength < PNG_SIGNATURE.length || PNG_SIGNATURE.some((b, i) => png[i] !== b)) {
    return "not a PNG";
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = PNG_SIGNATURE.length;
  let seen: "start" | "header" | "data" = "start";
  while (at + 12 <= png.byteLength) {
    const length = view.getUint32(at);
    if (at + 12 + length > png.byteLength) return "cut short";
    const kind = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (crc32(png.subarray(at + 4, at + 8 + length)) !== view.getUint32(at + 8 + length)) {
      return "damaged";
    }
    at += 12 + length;
    if (kind === "IHDR" && seen === "start") {
      const problem = checkHeader(body);
      if (problem) return problem;
      seen = "header";
    } else if (kind === "IDAT" && seen !== "start") {
      seen = "data";
    } else if (kind === "IEND" && seen === "data" && length === 0) {
      return at === png.byteLength ? null : "has data after the image";
    } else {
      return `unexpected ${JSON.stringify(kind)} chunk`;
    }
  }
  return "cut short";
}

function checkHeader(ihdr: Uint8Array): string | null {
  if (ihdr.byteLength !== 13) return "bad header";
  const view = new DataView(ihdr.buffer, ihdr.byteOffset, 13);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  if (width < 1 || height < 1 || width > MAX_SCREENSHOT_SIDE || height > MAX_SCREENSHOT_SIDE) {
    return "wrong size";
  }
  const [depth, colour, compression, filter, interlace] = ihdr.subarray(8);
  if (depth !== 8 || (colour !== 2 && colour !== 6) || compression || filter || interlace) {
    return "unexpected pixel format";
  }
  return null;
}

let table: Uint32Array | null = null;

/** CRC-32 (IEEE), as zip entries and PNG chunks use it. */
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
