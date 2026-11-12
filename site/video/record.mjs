// Records the product video from the built site: serves site/dist (with the
// demo app) plus this folder, plays scenes.mjs on the stage in Chromium,
// captures the frames, and encodes them with ffmpeg.
//
//   npm run build:site && npm run video:site
//
// Writes site/dist/video/pheeme-tour.{mp4,jpg,vtt}, or to --out <dir>.

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { Director } from "./director.mjs";
import tour from "./scenes.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = fileURLToPath(new URL("../dist/", import.meta.url));

const { values: opts } = parseArgs({
  options: {
    out: { type: "string", default: join(dist, "video") },
    // Watch it record in a window instead of headless.
    headed: { type: "boolean", default: false },
    // Keep the captured frames (and print where) to debug a recording.
    "keep-frames": { type: "boolean", default: false },
  },
});

const W = 1920;
const H = 1080;
const FPS = 30;
// The video's "now": a Wednesday morning, so "Friday" lands in the week shown
// and every recording shows the same dates.
const NOW = "2026-11-11T09:41:00-05:00";
const TIMEZONE = "America/New_York";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
};

async function serve() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const [root, rel] = path.startsWith("/__video/")
      ? [here, path.slice("/__video/".length)]
      : [dist, path.slice(1)];
    let file = normalize(join(root, rel));
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      await stat(file);
    } catch {
      return void res.writeHead(404).end();
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

const vttTime = (ms) => new Date(ms).toISOString().slice(11, 23);

try {
  await stat(join(dist, "demo", "index.html"));
} catch {
  throw new Error("site/dist/demo is missing: run `npm run build:site` first.");
}

const { server, origin } = await serve();
const frames = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pheeme-video-"));
const browser = await chromium.launch({ headless: !opts.headed });
try {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    // Rendered at 2x so zoomed-in shots stay sharp, then scaled to 1080p.
    deviceScaleFactor: 2,
    timezoneId: TIMEZONE,
    locale: "en-US",
    colorScheme: "light",
    // macOS shortcut labels (⌘) in the app.
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.install({ time: new Date(NOW) });
  await page.goto(`${origin}/__video/stage.html`);
  await page.evaluate(() => document.fonts.ready);

  const app = page.frame({ url: /\/demo\// });
  if (!app) throw new Error("The demo app didn't load in the stage.");
  const list = app.getByRole("listbox", { name: /conversations$/ });
  await list.getByRole("option").first().waitFor();
  // Answer the first-run prompts before the camera rolls, with the window in view.
  await page.evaluate(() => window.stage.shot("wide", 0));
  const notNow = app.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible()) await notNow.click();
  await list.evaluate((el) => el.focus({ preventScroll: true }));
  await page.evaluate(() => window.stage.shot("below", 0));
  await page.waitForTimeout(500);

  let count = 0;
  const times = [];
  const writes = [];
  await page.screencast.start({
    size: { width: W, height: H },
    quality: 92,
    fps: FPS,
    onFrame: ({ data }) => {
      const name = join(frames, `${String(count++).padStart(6, "0")}.jpg`);
      times.push(performance.now());
      writes.push(writeFile(name, data));
    },
  });
  // Chrome takes a moment to send the first frames; the video starts after that.
  const asked = performance.now();
  while (count === 0) {
    if (performance.now() - asked > 15_000) throw new Error("No frames came from the screencast.");
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);
  const start = performance.now();
  console.log(`First frame after ${Math.round(times[0] - asked)} ms.`);
  const director = new Director(page, app);
  try {
    await tour(director);
  } catch (error) {
    // Show what the stage looked like when a scene couldn't find its way.
    await mkdir(opts.out, { recursive: true });
    await page.screenshot({ path: join(opts.out, "failure.png"), scale: "css" });
    console.error(`The storyboard stopped; the stage at that moment: ${join(opts.out, "failure.png")}`);
    throw error;
  }
  const end = performance.now();
  await page.screencast.stop();
  await Promise.all(writes);
  if (errors.length) throw new Error(`The page threw while recording:\n${errors.join("\n")}`);
  if (count < 10) throw new Error(`Only ${count} frames were captured.`);

  // Frames arrive when the page changes, so each one lasts until the next.
  // Each image is read at the output rate: the default (25) would round frame times to 40 ms.
  const image = (i) => [`file ${String(i).padStart(6, "0")}.jpg`, `option framerate ${FPS}`];
  // The video starts with the last frame from before the storyboard began.
  const first = Math.max(0, times.findLastIndex((t) => t <= start));
  const lines = ["ffconcat version 1.0"];
  for (let i = first; i < count; i++) {
    const from = Math.max(times[i], start);
    const next = i + 1 < count ? times[i + 1] : end;
    lines.push(...image(i), `duration ${((next - from) / 1000).toFixed(4)}`);
  }
  lines.push(...image(count - 1));
  await writeFile(join(frames, "frames.txt"), lines.join("\n"));

  await mkdir(opts.out, { recursive: true });
  const mp4 = join(opts.out, "pheeme-tour.mp4");
  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", join(frames, "frames.txt"),
    "-vf", `scale=${W}:${H}:flags=lanczos,fps=${FPS},format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-tune", "animation",
    "-movflags", "+faststart", "-an",
    mp4,
  ]);
  // index.html links the video, its poster and its description track.
  if (!director.poster) throw new Error("The storyboard never called takePoster().");
  await writeFile(join(opts.out, "pheeme-tour.jpg"), director.poster);

  // What each part of the video says, for screen readers (a descriptions track).
  const recorded = end - start;
  const cues = director.chapters.map((c, i) => {
    const next = director.chapters[i + 1]?.at ?? recorded;
    return `${i + 1}\n${vttTime(c.at)} --> ${vttTime(next)}\n${c.text}`;
  });
  await writeFile(join(opts.out, "pheeme-tour.vtt"), `WEBVTT\n\n${cues.join("\n\n")}\n`);

  const size = (await stat(mp4)).size;
  console.log(`${mp4}: ${(recorded / 1000).toFixed(1)} s, ${count} frames, ${(size / 1e6).toFixed(1)} MB`);
} finally {
  await browser.close();
  server.close();
  if (opts["keep-frames"]) console.log(`Frames kept in ${frames}`);
  else await rm(frames, { recursive: true, force: true });
}
