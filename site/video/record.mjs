// Records the product video from the built site: serves site/dist (with the
// demo app) plus this folder, plays scenes.mjs on the stage in Chromium a
// frame at a time, and encodes the frames with ffmpeg.
//
// Nothing runs in real time while filming. Each frame moves the page's clock
// (timers, requestAnimationFrame, Date) and every CSS animation and transition
// on by exactly 1/30 s, then takes a screenshot, so motion is smooth however
// slow the machine is.
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
const FRAME_MS = 1000 / FPS;
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
  // The demo's sample mail is dated from when it loads. Setup runs on a flowing
  // clock; filming pauses it a moment later.
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
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  // From here the stage's CSS animations and transitions only move when a frame says so.
  await page.evaluate(() => {
    const born = new WeakMap();
    window.__film = (t) => {
      const docs = [document, ...[...document.querySelectorAll("iframe")].map((f) => f.contentDocument)];
      for (const doc of docs) {
        if (!doc) continue;
        for (const a of doc.getAnimations()) {
          // An animation first seen at this frame starts at this frame.
          if (!born.has(a)) {
            born.set(a, t);
            a.pause();
          }
          a.currentTime = t - born.get(a);
        }
      }
    };
    window.__film(0);
  });

  const cdp = await context.newCDPSession(page);
  let frame = 0;
  const writes = [];
  const film = {
    frame: FRAME_MS,
    now: () => frame * FRAME_MS,
    /** Films frames until `ms` more of the video has passed. */
    async advance(ms) {
      const last = Math.round((frame * FRAME_MS + ms) / FRAME_MS);
      while (frame < last) {
        const ran = Math.round(frame * FRAME_MS);
        frame++;
        const t = frame * FRAME_MS;
        await page.clock.runFor(Math.round(t) - ran);
        await page.evaluate((at) => window.__film(at), t);
        const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
        writes.push(writeFile(join(frames, `${String(frame).padStart(6, "0")}.jpg`), data, "base64"));
        if (frame % (FPS * 5) === 0) {
          await Promise.all(writes.splice(0));
          console.log(`  ${(t / 1000).toFixed(0)} s filmed`);
        }
      }
    },
  };
  const started = performance.now();
  const director = new Director(page, app, film);
  try {
    await tour(director);
  } catch (error) {
    // Show what the stage looked like when a scene couldn't find its way.
    await mkdir(opts.out, { recursive: true });
    await page.screenshot({ path: join(opts.out, "failure.png"), scale: "css" });
    console.error(`The storyboard stopped; the stage at that moment: ${join(opts.out, "failure.png")}`);
    throw error;
  }
  await Promise.all(writes);
  if (errors.length) throw new Error(`The page threw while recording:\n${errors.join("\n")}`);
  if (frame < 10) throw new Error(`Only ${frame} frames were filmed.`);
  console.log(`Filmed ${frame} frames in ${((performance.now() - started) / 1000).toFixed(0)} s.`);

  await mkdir(opts.out, { recursive: true });
  const mp4 = join(opts.out, "pheeme-tour.mp4");
  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-framerate", String(FPS), "-start_number", "1", "-i", join(frames, "%06d.jpg"),
    "-vf", `scale=${W}:${H}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-tune", "animation",
    "-movflags", "+faststart", "-an",
    mp4,
  ]);
  // index.html links the video, its poster and its description track.
  if (!director.poster) throw new Error("The storyboard never called takePoster().");
  await writeFile(join(opts.out, "pheeme-tour.jpg"), director.poster);

  // What each part of the video says, for screen readers (a descriptions track).
  const recorded = film.now();
  const cues = director.chapters.map((c, i) => {
    const next = director.chapters[i + 1]?.at ?? recorded;
    return `${i + 1}\n${vttTime(c.at)} --> ${vttTime(next)}\n${c.text}`;
  });
  await writeFile(join(opts.out, "pheeme-tour.vtt"), `WEBVTT\n\n${cues.join("\n\n")}\n`);

  const size = (await stat(mp4)).size;
  console.log(`${mp4}: ${(recorded / 1000).toFixed(1)} s, ${frame} frames, ${(size / 1e6).toFixed(1)} MB`);
} finally {
  await browser.close();
  server.close();
  if (opts["keep-frames"]) console.log(`Frames kept in ${frames}`);
  else await rm(frames, { recursive: true, force: true });
}
