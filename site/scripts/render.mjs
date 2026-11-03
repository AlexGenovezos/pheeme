// Rasterize an SVG (or HTML page) to PNG with headless Chromium. No npm deps.
// Usage: node scripts/render.mjs <in.svg|in.html> <out.png> <width> [height] [bg]
//   bg: CSS color for the page background (default transparent)
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { findChrome } from "./chrome.mjs";

const [input, output, w, h = w, bg = "transparent"] = process.argv.slice(2);
if (!input || !output || !w) {
  console.error("usage: render.mjs <in> <out.png> <width> [height] [bg]");
  process.exit(1);
}

const abs = resolve(input);
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "render-"));
let url;
if (abs.endsWith(".svg")) {
  const page = join(tmp, "page.html");
  writeFileSync(
    page,
    `<!doctype html><html><body style="margin:0;background:${bg}">` +
      `<img src="file://${abs}" style="display:block;width:${w}px;height:${h}px;object-fit:contain"></body></html>`,
  );
  url = "file://" + page;
} else {
  url = "file://" + abs;
}
execFileSync(findChrome(), [
  "--headless",
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--default-background-color=00000000",
  `--window-size=${w},${h}`,
  `--screenshot=${resolve(output)}`,
  "--virtual-time-budget=2000",
  url,
], { stdio: "ignore" });
rmSync(tmp, { recursive: true, force: true });
console.log(`${output} ${w}x${h}`);
