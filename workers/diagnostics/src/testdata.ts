import { crc32 } from "./bundle";

// A real bundle written by the app's own code (`support::bundle::build` with two screenshots from
// `support::screenshot::clean`: an 8×6 RGB one and a 5×4 one with see-through pixels), so the
// Worker's check is tested against what the app actually sends. Regenerate it when the app
// changes what it writes.
export const APP_BUNDLE_BASE64 = [
  "UEsDBBQAAAAIAAAAIQCHhkiwRQAAAEcAAAAMAAAAc3VtbWFyeS5qc29uHYsxCoAwEAT7vOLYWsTaH9j7hUPE41YuURHx7yYy",
  "3QzzJBE4i2IUTEWM3LJcQV/QtRa62z2zZj/MfnVq5JXejqGvIL0fUEsDBBQAAAAIAAAAIQCFT/XrIQAAACIAAAAPAAAAbG9n",
  "cy9waGVlbWUubG9nMzIwMtM1NNQ1NAsxNLAyAKEoBU8/N3+F4pLEopLUFC4AUEsDBBQAAAAIAAAAIQApu0wNBAAAAAIAAAAR",
  "AAAAZW1haWwvdGhyZWFkLmpzb26LjgUAUEsDBBQAAAAIAAAAIQCsKpPYBAAAAAIAAAARAAAAZW1haWwvbTEvYm9keS50eHTL",
  "yAQAUEsDBAoAAAAAAAAAIQCTbdCbXAAAAFwAAAARAAAAc2NyZWVuc2hvdHMvMS5wbmeJUE5HDQoaCgAAAA1JSERSAAAACAAA",
  "AAYIAgAAAHFnSKwAAAAjSURBVHjavckhEQAACMDAF+RA0z8FsQgAmt3cB53sQzn7gAElGwJ7USK+pwAAAABJRU5ErkJgglBL",
  "AwQKAAAAAAAAACEAZ//bdFsAAABbAAAAEQAAAHNjcmVlbnNob3RzLzIucG5niVBORw0KGgoAAAANSUhEUgAAAAUAAAAECAYA",
  "AABGM/VAAAAAIklEQVR42o3IoQ0AAAwCQdJ0IvYfDoFBILjkzT+M2aHYpwA5UADTPC6LxwAAAABJRU5ErkJgglBLAQIUAxQA",
  "AAAIAAAAIQCHhkiwRQAAAEcAAAAMAAAAAAAAAAAAAACkgQAAAABzdW1tYXJ5Lmpzb25QSwECFAMUAAAACAAAACEAhU/16yEA",
  "AAAiAAAADwAAAAAAAAAAAAAApIFvAAAAbG9ncy9waGVlbWUubG9nUEsBAhQDFAAAAAgAAAAhACm7TA0EAAAAAgAAABEAAAAA",
  "AAAAAAAAAKSBvQAAAGVtYWlsL3RocmVhZC5qc29uUEsBAhQDFAAAAAgAAAAhAKwqk9gEAAAAAgAAABEAAAAAAAAAAAAAAKSB",
  "8AAAAGVtYWlsL20xL2JvZHkudHh0UEsBAgoDCgAAAAAAAAAhAJNt0JtcAAAAXAAAABEAAAAAAAAAAAAAAKSBIwEAAHNjcmVl",
  "bnNob3RzLzEucG5nUEsBAgoDCgAAAAAAAAAhAGf/23RbAAAAWwAAABEAAAAAAAAAAAAAAKSBrgEAAHNjcmVlbnNob3RzLzIu",
  "cG5nUEsFBgAAAAAGAAYAcwEAADgCAAAAAA==",
].join("");

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** A zip of `entries`, each stored (or marked deflated, its bytes as given) with its CRC. */
export function zipOf(
  /** `size` overrides the unpacked size the directory claims (a deflated entry's real size). */
  entries: { name: string; data: Uint8Array; method?: number; crc?: number; size?: number }[],
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = encoder.encode(e.name);
    const crc = e.crc ?? crc32(e.data);
    const method = e.method ?? 0;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.size ?? e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, e.data);
    centrals.push(central);
    offset += local.length + e.data.length;
  }
  const dirSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A PNG made of `chunks` with good checksums (the IDAT bytes aren't real pixels: nothing inflates them). */
export function pngOf(chunks: [string, Uint8Array][]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)];
  for (const [kind, data] of chunks) {
    const typed = new Uint8Array(4 + data.length);
    typed.set(encoder.encode(kind));
    typed.set(data, 4);
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, data.length);
    const tail = new Uint8Array(4);
    new DataView(tail.buffer).setUint32(0, crc32(typed));
    parts.push(head, typed, tail);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An IHDR body: 8-bit RGB unless told otherwise. */
export function ihdr(width: number, height: number, depth = 8, colour = 2): Uint8Array {
  const body = new Uint8Array(13);
  const view = new DataView(body.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  body.set([depth, colour, 0, 0, 0], 8);
  return body;
}

export const goodPng = (width = 10, height = 10) =>
  pngOf([
    ["IHDR", ihdr(width, height)],
    ["IDAT", Uint8Array.of(1, 2, 3)],
    ["IEND", new Uint8Array()],
  ]);
