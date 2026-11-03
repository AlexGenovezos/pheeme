// Generates the full pheeme logo set into public/brand (SVG + PNG), plus
// favicons, app icons and the social preview image into public/.
// Usage: node scripts/build-brand.mjs        (needs ImageMagick `magick` for .ico)
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "public/brand");
const PUB = join(ROOT, "public");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const C = {
  blueHi: "#4A8DF2",
  blueLo: "#173C92",
  ink: "#16388A", // wordmark on light
  navyHi: "#14347F",
  navyLo: "#081944",
  goldLo: "#C08A35",
  goldMid: "#E8C579",
  goldHi: "#F8E6B4",
  white: "#FFFFFF",
  black: "#0A1430",
};

// ---------- geometry (mark space, 512 grid) ----------
const ENV = { x: 176, y: 214, w: 296, h: 204, r: 38 };
const FLAP = "M324 330 L452 236";
const FEATHERS = [
  "M330 326 C240 300 130 230 118 40 C168 140 220 230 330 326 Z",
  "M318 332 C220 316 100 270 66 128 C120 210 210 270 318 332 Z",
  "M312 334 C220 330 110 310 62 214 C120 270 210 300 312 334 Z",
];
const BOX = { x: 62, y: 40, w: 410, h: 378 }; // tight bounds of the mark

const WM = JSON.parse(readFileSync(join(ROOT, "brand-src/wordmark.json"), "utf8"));
// wordmark ink bounds in font units (baseline y=0)
const WMB = { x: 69, top: -740, bottom: 264, right: WM.width - 33 };

// ---------- builders ----------
let uid = 0;
/** Returns { defs, body } for the mark, drawn in mark space. */
function mark({ env, wing, flapGap = 16 }) {
  const id = `m${uid++}`;
  const defs = [];
  const fill = (spec, name) => {
    if (spec === "blue") {
      defs.push(`<linearGradient id="${id}${name}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.blueHi}"/><stop offset="1" stop-color="${C.blueLo}"/></linearGradient>`);
      return `url(#${id}${name})`;
    }
    if (spec === "gold") {
      defs.push(`<linearGradient id="${id}${name}" gradientUnits="userSpaceOnUse" x1="320" y1="330" x2="90" y2="60"><stop offset="0" stop-color="${C.goldLo}"/><stop offset=".5" stop-color="${C.goldMid}"/><stop offset="1" stop-color="${C.goldHi}"/></linearGradient>`);
      return `url(#${id}${name})`;
    }
    return spec;
  };
  const envFill = fill(env, "e");
  const wingFill = fill(wing, "w");
  const f = FEATHERS.map((d, i) => `<path id="${id}f${i}" d="${d}"/>`).join("");
  const knock = (ids, sw) =>
    `<g fill="#000" stroke="#000" stroke-width="${sw}" stroke-linejoin="round">${ids.map((i) => `<use href="#${id}f${i}"/>`).join("")}</g>`;
  defs.push(f);
  defs.push(`<mask id="${id}ke" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="#fff"/>${knock([0, 1, 2], 22)}<path d="${FLAP}" fill="none" stroke="#000" stroke-width="${flapGap}" stroke-linecap="round"/></mask>`);
  defs.push(`<mask id="${id}k1" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="#fff"/>${knock([0], 16)}</mask>`);
  defs.push(`<mask id="${id}k2" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="#fff"/>${knock([0, 1], 16)}</mask>`);
  const body =
    `<rect x="${ENV.x}" y="${ENV.y}" width="${ENV.w}" height="${ENV.h}" rx="${ENV.r}" fill="${envFill}" mask="url(#${id}ke)"/>` +
    `<g fill="${wingFill}"><use href="#${id}f0"/><use href="#${id}f1" mask="url(#${id}k1)"/><use href="#${id}f2" mask="url(#${id}k2)"/></g>`;
  return { defs: defs.join(""), body };
}

const svg = (vb, defs, body, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"${extra}><defs>${defs}</defs>${body}</svg>\n`;

const wordmark = (color) => `<path fill="${color}" d="${WM.d}"/>`;

// palettes for each colorway
const WAYS = {
  color: { env: "blue", wing: "gold", text: C.ink }, // on light backgrounds
  "color-dark": { env: "blue", wing: "gold", text: C.white }, // on dark backgrounds
  white: { env: C.white, wing: C.white, text: C.white },
  black: { env: C.black, wing: C.black, text: C.black },
  navy: { env: C.ink, wing: C.ink, text: C.ink },
};

const files = [];
function write(name, content) {
  writeFileSync(join(OUT, name), content);
  files.push(name);
}

// --- 1. mark only (square, centered, 6% padding)
for (const [way, p] of Object.entries(WAYS)) {
  if (way === "color-dark") continue; // mark itself is identical to "color"
  const m = mark(p);
  const pad = 24;
  const side = Math.max(BOX.w, BOX.h) + pad * 2;
  const vx = BOX.x + BOX.w / 2 - side / 2;
  const vy = BOX.y + BOX.h / 2 - side / 2;
  write(`pheeme-mark-${way}.svg`, svg(`${vx} ${vy} ${side} ${side}`, m.defs, m.body));
}

// --- 2. wordmark only
for (const [way, p] of Object.entries(WAYS)) {
  if (way === "color-dark" || way === "navy") continue; // same as white / color
  const pad = 40;
  const vb = `${WMB.x - pad} ${WMB.top - pad} ${WMB.right - WMB.x + pad * 2} ${WMB.bottom - WMB.top + pad * 2}`;
  write(`pheeme-wordmark-${way}.svg`, svg(vb, "", wordmark(p.text)));
}

// --- 3. horizontal lockup: baseline on envelope bottom, x-height ≈ 0.74 env height
const S = 150 / 563; // font units -> mark units
const GAP = 64;
for (const [way, p] of Object.entries(WAYS)) {
  const m = mark(p);
  const tx = BOX.x + BOX.w + GAP - WMB.x * S;
  const ty = ENV.y + ENV.h; // baseline
  const right = tx + WMB.right * S;
  const top = Math.min(BOX.y, ty + WMB.top * S);
  const bottom = Math.max(BOX.y + BOX.h, ty + WMB.bottom * S);
  const pad = 24;
  const vb = `${BOX.x - pad} ${top - pad} ${right - BOX.x + pad * 2} ${bottom - top + pad * 2}`;
  write(
    `pheeme-logo-horizontal-${way}.svg`,
    svg(vb, m.defs, m.body + `<g transform="translate(${tx} ${ty}) scale(${S})">${wordmark(p.text)}</g>`),
  );
}

// --- 4. stacked lockup: mark centered over wordmark
const SS = 0.155;
for (const [way, p] of Object.entries(WAYS)) {
  const m = mark(p);
  const wmW = (WMB.right - WMB.x) * SS;
  const cx = BOX.x + BOX.w / 2;
  const tx = cx - wmW / 2 - WMB.x * SS;
  const ty = BOX.y + BOX.h + 44 - WMB.top * SS; // ascender top sits 44 below the mark
  const left = Math.min(BOX.x, tx + WMB.x * SS);
  const right = Math.max(BOX.x + BOX.w, tx + WMB.right * SS);
  const bottom = ty + WMB.bottom * SS;
  const pad = 32;
  const vb = `${left - pad} ${BOX.y - pad} ${right - left + pad * 2} ${bottom - BOX.y + pad * 2}`;
  write(
    `pheeme-logo-stacked-${way}.svg`,
    svg(vb, m.defs, m.body + `<g transform="translate(${tx} ${ty}) scale(${SS})">${wordmark(p.text)}</g>`),
  );
}

// --- 5. app icon: navy squircle, white envelope, gold wing
function appIcon({ rounded = true, scale = 0.74, radius = 114 } = {}) {
  const id = `a${uid++}`;
  const m = mark({ env: C.white, wing: "gold" });
  const side = 512;
  const s = (side * scale) / Math.max(BOX.w, BOX.h);
  const tx = side / 2 - (BOX.x + BOX.w / 2) * s;
  const ty = side / 2 - (BOX.y + BOX.h / 2) * s;
  const bgDefs = `<linearGradient id="${id}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.navyHi}"/><stop offset="1" stop-color="${C.navyLo}"/></linearGradient>`;
  const bg = rounded
    ? `<rect width="512" height="512" rx="${radius}" fill="url(#${id}bg)"/>`
    : `<rect width="512" height="512" fill="url(#${id}bg)"/>`;
  return svg("0 0 512 512", bgDefs + m.defs, bg + `<g transform="translate(${tx} ${ty}) scale(${s})">${m.body}</g>`);
}
write("pheeme-app-icon.svg", appIcon());
write("pheeme-app-icon-square.svg", appIcon({ rounded: false })); // for iOS/Android, which mask it themselves
write("pheeme-app-icon-maskable.svg", appIcon({ rounded: false, scale: 0.58 })); // safe zone for Android adaptive icons

// Desktop app icon for the Tauri app (../src-tauri/app-icon.svg). macOS draws Dock icons
// as an 824 px squircle on a 1024 canvas, so pad the squircle to that grid (512 / (824/1024)
// = 636). `npm run icons` in the repo root turns it into every platform size.
writeFileSync(
  join(ROOT, "../src-tauri/app-icon.svg"),
  appIcon().replace('viewBox="0 0 512 512"', 'viewBox="-62 -62 636 636"'),
);

// ---------- rasterize ----------
const render = (input, output, w, h = w, bg) =>
  execFileSync("node", [join(ROOT, "scripts/render.mjs"), input, output, String(w), String(h), ...(bg ? [bg] : [])], { stdio: "ignore" });

const PNG_WIDTHS = { mark: [512, 1024], logo: [1200, 2400], wordmark: [1200], app: [512, 1024] };
for (const f of files) {
  const src = join(OUT, f);
  const vb = readFileSync(src, "utf8").match(/viewBox="([^"]+)"/)[1].split(" ").map(Number);
  const ratio = vb[3] / vb[2];
  const kind = f.includes("-mark-") ? "mark" : f.includes("-logo-") ? "logo" : f.includes("wordmark") ? "wordmark" : "app";
  for (const w of PNG_WIDTHS[kind]) {
    const h = Math.round(w * ratio);
    render(src, join(OUT, f.replace(".svg", `@${w}.png`)), w, h);
  }
}

// favicons + platform icons (favicon uses a tighter crop so the wing survives at 16px)
const icon = join(OUT, "pheeme-app-icon.svg");
const fav = join(OUT, "favicon.svg");
writeFileSync(fav, appIcon({ scale: 0.9, radius: 96 }));
writeFileSync(join(PUB, "favicon.svg"), readFileSync(fav));
// The desktop app (repo root) uses the same favicon and the color mark.
writeFileSync(join(ROOT, "../public/favicon.svg"), readFileSync(fav));
writeFileSync(join(ROOT, "../public/pheeme-mark.svg"), readFileSync(join(OUT, "pheeme-mark-color.svg")));
for (const s of [16, 32, 48]) render(fav, join(OUT, `favicon-${s}.png`), s);
execFileSync("magick", [16, 32, 48].map((s) => join(OUT, `favicon-${s}.png`)).concat(join(PUB, "favicon.ico")));
render(join(OUT, "pheeme-app-icon-square.svg"), join(PUB, "apple-touch-icon.png"), 180);
render(icon, join(PUB, "icon-192.png"), 192);
render(icon, join(PUB, "icon-512.png"), 512);
render(join(OUT, "pheeme-app-icon-maskable.svg"), join(PUB, "icon-maskable-512.png"), 512);

// social preview (1200x630) rendered from an HTML template
render(join(ROOT, "brand-src/og.html"), join(PUB, "og.png"), 1200, 630);

// one-click download of the whole set (SVG + PNG)
execFileSync("zip", ["-q", "-r", "pheeme-brand.zip", "."], { cwd: OUT });

console.log(`wrote ${files.length} SVGs + PNGs to public/brand`);
