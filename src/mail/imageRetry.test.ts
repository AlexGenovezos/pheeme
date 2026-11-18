import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IMAGE_RETRIES, imageRetrier, type RetryHost } from "./imageRetry";

/** The window's retries: each `new Image()` the retrier makes, answered by the test. */
class FakeImage {
  static made: FakeImage[] = [];
  referrerPolicy = "";
  src = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeImage.made.push(this);
  }
}

// The timer functions are looked up per call, so they are the fake ones `vi.useFakeTimers` installs.
const host = () =>
  ({
    Image: FakeImage,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  }) as unknown as RetryHost;

const img = (src: string | null) => {
  const image = document.createElement("img");
  if (src !== null) image.setAttribute("src", src);
  return image;
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeImage.made = [];
});
afterEach(() => vi.useRealTimers());

test("fetches a failed remote image again after a delay, then reloads it in the frame", () => {
  const recovered = vi.fn();
  const retrier = imageRetrier(host(), recovered, [2_000, 8_000]);
  const image = img("https://mcusercontent.com/a.png");
  const setAttribute = vi.spyOn(image, "setAttribute");

  retrier.failed(image);
  vi.advanceTimersByTime(1_999);
  expect(FakeImage.made).toHaveLength(0);
  vi.advanceTimersByTime(1);

  expect(FakeImage.made).toHaveLength(1);
  expect(FakeImage.made[0].src).toBe("https://mcusercontent.com/a.png");
  expect(FakeImage.made[0].referrerPolicy).toBe("no-referrer");
  expect(image.getAttribute(IMAGE_RETRIES)).toBe("1");

  FakeImage.made[0].onload?.();
  expect(setAttribute).toHaveBeenCalledWith("src", "https://mcusercontent.com/a.png");
  expect(recovered).toHaveBeenCalledWith(image);
});

test("a retry that fails waits longer and tries once more, then gives up", () => {
  const recovered = vi.fn();
  const retrier = imageRetrier(host(), recovered, [2_000, 8_000]);
  const image = img("https://example.com/a.png");

  retrier.failed(image);
  vi.advanceTimersByTime(2_000);
  FakeImage.made[0].onerror?.();
  vi.advanceTimersByTime(7_999);
  expect(FakeImage.made).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(FakeImage.made).toHaveLength(2);
  expect(image.getAttribute(IMAGE_RETRIES)).toBe("2");

  FakeImage.made[1].onerror?.();
  vi.advanceTimersByTime(60_000);
  expect(FakeImage.made).toHaveLength(2);
  // The frame's load reporting it broken again doesn't start a third.
  retrier.failed(image);
  vi.advanceTimersByTime(60_000);
  expect(FakeImage.made).toHaveLength(2);
  expect(recovered).not.toHaveBeenCalled();
});

test("an image reported failed twice while waiting is fetched once", () => {
  const retrier = imageRetrier(host(), vi.fn(), [2_000]);
  const image = img("https://example.com/a.png");
  retrier.failed(image);
  retrier.failed(image);
  vi.advanceTimersByTime(2_000);
  expect(FakeImage.made).toHaveLength(1);
});

test("leaves embedded, attachment and missing sources alone", () => {
  const retrier = imageRetrier(host(), vi.fn(), [2_000]);
  retrier.failed(img("data:image/png;base64,AAAA"));
  retrier.failed(img("pheeme-att://localhost/x"));
  retrier.failed(img(null));
  vi.advanceTimersByTime(10_000);
  expect(FakeImage.made).toHaveLength(0);
});

test("stop cancels waiting retries and ignores one already in flight", () => {
  const recovered = vi.fn();
  const retrier = imageRetrier(host(), recovered, [2_000]);
  const waiting = img("https://example.com/a.png");
  const inFlight = img("https://example.com/b.png");
  retrier.failed(inFlight);
  vi.advanceTimersByTime(2_000);
  retrier.failed(waiting);

  retrier.stop();
  vi.advanceTimersByTime(10_000);
  FakeImage.made[0].onload?.();

  expect(FakeImage.made).toHaveLength(1);
  expect(recovered).not.toHaveBeenCalled();
  expect(inFlight.getAttribute("src")).toBe("https://example.com/b.png");
});
