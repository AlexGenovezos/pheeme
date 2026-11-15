import { beforeEach, expect, test } from "vitest";
import type { ShownTiming } from "../lib/tauri";
import { createOpenTimer, IMAGE_POLL_MS, type Img } from "./openTiming";

/** A clock, a frame queue and an image list the test drives by hand. */
let clock = 0;
let frames: Array<() => void> = [];
let timers: Array<{ at: number; run: () => void }> = [];
let reported: ShownTiming[] = [];
let images: FakeImg[] = [];
let cached = new Set<string>();

/** No load/error events: WebKit runs no listeners inside the script-less email frame, so none are relied on. */
class FakeImg implements Img {
  complete = false;
  naturalWidth = 0;
  loading = "eager";
  constructor(public src = "https://example.com/a.png") {}
  settle(ok: boolean) {
    this.complete = true;
    this.naturalWidth = ok ? 10 : 0;
  }
}

const timer = () =>
  createOpenTimer({
    now: () => clock,
    frame: (fn) => void frames.push(fn),
    after: (ms, run) => {
      const t = { at: clock + ms, run };
      timers.push(t);
      return () => (timers = timers.filter((x) => x !== t));
    },
    isCached: (key) => cached.has(key),
    imagesIn: () => images,
    report: (t) => void reported.push(t),
  });

/** Run queued animation frames (each may queue the next). */
const paint = () => {
  for (let i = 0; i < 4 && frames.length; i++) for (const fn of frames.splice(0)) fn();
};
const advance = (ms: number) => {
  clock += ms;
  for (const t of timers.filter((t) => t.at <= clock)) {
    timers = timers.filter((x) => x !== t);
    t.run();
  }
};
const root = {} as Element;

beforeEach(() => {
  clock = 1000;
  frames = [];
  timers = [];
  reported = [];
  images = [];
  cached = new Set();
});

test("a conversation without images is reported once it has painted", () => {
  const t = timer();
  t.picked("a:1");
  advance(120);
  t.shown("a:1", root);
  advance(30);
  paint();
  expect(reported).toEqual([
    expect.objectContaining({
      outcome: "shown",
      fromMemory: false,
      dataMs: 120,
      paintMs: 150,
      imagesMs: null,
      images: 0,
      imagesFailed: 0,
      totalMs: 150,
    }),
  ]);
});

test("waits for every image to load or fail, and counts the failures", () => {
  images = [new FakeImg(), new FakeImg(), new FakeImg()];
  images[0]!.settle(true); // already in the cache
  cached.add("a:1");
  const t = timer();
  t.picked("a:1");
  t.shown("a:1", root);
  paint();
  expect(reported).toEqual([]);
  advance(4000);
  images[1]!.settle(false);
  advance(5000);
  images[2]!.settle(true);
  expect(reported).toEqual([]);
  advance(IMAGE_POLL_MS);
  expect(reported).toEqual([
    expect.objectContaining({
      outcome: "shown",
      fromMemory: true,
      dataMs: 0,
      paintMs: 0,
      imagesMs: 9000 + IMAGE_POLL_MS,
      images: 3,
      imagesFailed: 1,
      imagesFailedHttp: 0,
      imagesPending: 0,
      totalMs: 9000 + IMAGE_POLL_MS,
    }),
  ]);
});

test("lazy images are not waited for", () => {
  const lazy = new FakeImg();
  lazy.loading = "lazy";
  images = [lazy];
  const t = timer();
  t.picked("a:1");
  t.shown("a:1", root);
  paint();
  expect(reported).toEqual([expect.objectContaining({ outcome: "shown", images: 0 })]);
});

test("moving on before the conversation finishes reports how far it got", () => {
  const t = timer();
  t.picked("a:1");
  advance(2500);
  t.picked("a:2");
  expect(reported).toEqual([
    expect.objectContaining({ outcome: "left", dataMs: null, paintMs: null, totalMs: 2500 }),
  ]);
});

test("closing the conversation also ends its timing", () => {
  const t = timer();
  t.picked("a:1");
  advance(700);
  t.picked(null);
  expect(reported).toEqual([expect.objectContaining({ outcome: "left", totalMs: 700 })]);
});

test("gives up after 30 seconds, reporting the images still loading", () => {
  images = [new FakeImg(), new FakeImg()];
  const t = timer();
  t.picked("a:1");
  t.shown("a:1", root);
  paint();
  images[0]!.settle(true);
  advance(30_000);
  expect(reported).toEqual([
    expect.objectContaining({ outcome: "timed_out", images: 2, imagesPending: 1, imagesMs: null }),
  ]);
  images[1]!.settle(true);
  advance(IMAGE_POLL_MS);
  expect(reported).toHaveLength(1);
});

test("a frame rewritten while its images load is followed to the new document", () => {
  images = [new FakeImg()];
  const t = timer();
  t.picked("a:1");
  t.shown("a:1", root);
  paint();
  // The theme changed or the frame moved: its document was written again with new elements.
  const stale = images[0]!;
  images = [new FakeImg(), new FakeImg()];
  stale.settle(false); // a cancelled load in the old document
  advance(IMAGE_POLL_MS);
  expect(reported).toEqual([]);
  for (const img of images) img.settle(true);
  advance(IMAGE_POLL_MS);
  expect(reported).toEqual([
    expect.objectContaining({ outcome: "shown", images: 2, imagesFailed: 0 }),
  ]);
});

test("counts failed images served over plain http apart", () => {
  images = [
    new FakeImg("http://shop.example/a.jpg"),
    new FakeImg("HTTP://shop.example/b.jpg"),
    new FakeImg("https://cdn.example/c.jpg"),
    new FakeImg("http://shop.example/d.jpg"),
  ];
  images[0]!.settle(false);
  images[1]!.settle(false);
  images[2]!.settle(false);
  images[3]!.settle(true);
  const t = timer();
  t.picked("a:1");
  t.shown("a:1", root);
  paint();
  expect(reported).toEqual([
    expect.objectContaining({ outcome: "shown", imagesFailed: 3, imagesFailedHttp: 2 }),
  ]);
});

test("a second shown for the same open, or one for another thread, is ignored", () => {
  const t = timer();
  t.picked("a:1");
  t.shown("a:2", root);
  paint();
  expect(reported).toEqual([]);
  t.shown("a:1", root);
  t.shown("a:1", root);
  paint();
  expect(reported).toHaveLength(1);
});

test("re-picking the open conversation doesn't restart its timing", () => {
  const t = timer();
  t.picked("a:1");
  advance(500);
  t.picked("a:1");
  t.shown("a:1", root);
  paint();
  expect(reported).toEqual([expect.objectContaining({ dataMs: 500 })]);
});
