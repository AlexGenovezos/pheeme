import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ThreadDetail } from "../lib/tauri";
import { useReadingSettings } from "../settings/readingSettings";
import { useMailStore } from "../store/mailStore";
import { __resetThreadStoreForTests, useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { startImagePreloading } from "./preloadImages";

const detail = (html: string) => ({ messages: [{ bodyHtml: html }] }) as ThreadDetail;
let created: HTMLImageElement[];
let warm: ReturnType<typeof startImagePreloading>;

beforeEach(() => {
  vi.useFakeTimers();
  created = [];
  __resetThreadStoreForTests();
  useReadingSettings.setState({ preloadImages: true });
  useMailStore.setState({ loading: false });
  useUiStore.setState({ openThread: null });
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    created.push(image);
    return image;
  });
  warm = startImagePreloading();
});
afterEach(() => {
  warm.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const settle = () => vi.advanceTimersByTimeAsync(10);
const cache = (entries: Record<string, ThreadDetail>) =>
  useThreadStore.setState({ details: new Map(Object.entries(entries)) });
const sources = () => created.map((image) => image.getAttribute("src"));
const finish = async (image: HTMLImageElement) => {
  image.onload?.(new Event("load"));
  await settle();
};

test("warms the http(s) images of cached conversations in window order, four at a time", async () => {
  cache({
    "a:1": detail(
      `<img src="https://x/1.png"><img src="data:image/png;base64,AA=="><img src="pheeme-att://localhost/a/m/c?t=s">
       <img srcset="https://x/2.png 1x, https://x/3.png 2x"><table background="http://x/4.png"></table>`,
    ),
    "a:2": detail(
      `<img src="https://x/5.png"><img src="https://x/1.png">
       <div style="background-image: url('https://x/6.png')"></div>
       <style>.a { background: #fff url(https://x/7.png) } @font-face { src: url(https://x/font.woff) }</style>`,
    ),
  });
  warm.update(["a:1", "a:2"]);
  await settle();
  expect(sources()).toEqual([
    "https://x/1.png",
    "http://x/4.png",
    "https://x/2.png",
    "https://x/3.png",
  ]);
  expect(created[0].referrerPolicy).toBe("no-referrer");

  for (const image of created.slice(0, 4)) await finish(image);
  // Each URL once; CSS backgrounds but never fonts.
  expect(sources().slice(4)).toEqual(["https://x/5.png", "https://x/6.png", "https://x/7.png"]);
});

test("waits for the list and the open conversation before warming", async () => {
  cache({ "a:1": detail(`<img src="https://x/1.png">`) });
  useMailStore.setState({ loading: true });
  useUiStore.setState({ openThread: "a:9" });
  warm.update(["a:1"]);
  await settle();
  expect(created).toHaveLength(0);

  useMailStore.setState({ loading: false });
  await settle();
  expect(created).toHaveLength(0);

  cache({ "a:1": detail(`<img src="https://x/1.png">`), "a:9": detail("") });
  await settle();
  expect(sources()).toEqual(["https://x/1.png"]);
});

test("with Preload images off, nothing is requested", async () => {
  useReadingSettings.setState({ preloadImages: false });
  cache({ "a:1": detail(`<img src="https://x/1.png">`) });
  warm.update(["a:1"]);
  await settle();
  expect(created).toHaveLength(0);

  useReadingSettings.setState({ preloadImages: true });
  await settle();
  expect(created).toHaveLength(1);
});
