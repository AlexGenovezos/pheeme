/**
 * Fetches a remote email image again after it failed. A brief network drop left a newsletter with 25 of its 30
 * images blank (a diagnostics report, v0.28), although every one of them loaded fine moments later.
 *
 * The retry is fetched by the app's own window (a detached `Image`, no referrer) rather than inside the email
 * frame: WebKit runs no listeners in the script-less frame, so only the window can hear whether it worked. Once
 * it has, the frame's `<img>` is pointed at the same URL again and takes it from the memory cache. An image
 * still failing is left broken, so nothing in the frame changes until there is something to show.
 */

/** How long after each failure the image is fetched again; one retry per entry. */
export const IMAGE_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000];

/** Set on an image the app fetched again: how many times. Send diagnostics reports it. */
export const IMAGE_RETRIES = "data-pheeme-retries";

const REMOTE = /^https?:/i;

export interface ImageRetrier {
  /** `image` failed: fetch it again later, if it is remote and has retries left. */
  failed(image: HTMLImageElement): void;
  /** Cancel every retry not yet sent (the frame was rewritten or unmounted). */
  stop(): void;
}

/**
 * `host` is the app's window, which sends the retries. `recovered` runs once the frame's image has been
 * pointed at a URL that loaded.
 */
/** What the retrier uses of the app's window. */
export type RetryHost = Pick<Window, "setTimeout" | "clearTimeout"> & { Image: typeof Image };

export function imageRetrier(
  host: RetryHost,
  recovered: (image: HTMLImageElement) => void,
  delays: readonly number[] = IMAGE_RETRY_DELAYS_MS,
): ImageRetrier {
  let stopped = false;
  const timers = new Set<number>();
  const waiting = new WeakSet<HTMLImageElement>();

  const failed = (image: HTMLImageElement) => {
    const src = image.getAttribute("src");
    if (stopped || !src || !REMOTE.test(src) || waiting.has(image)) return;
    const tries = Number(image.getAttribute(IMAGE_RETRIES)) || 0;
    if (tries >= delays.length) return;
    waiting.add(image);
    const timer = host.setTimeout(() => {
      timers.delete(timer);
      image.setAttribute(IMAGE_RETRIES, String(tries + 1));
      const probe = new host.Image();
      probe.referrerPolicy = "no-referrer";
      probe.onload = () => {
        waiting.delete(image);
        if (stopped) return;
        // Removed and set again in one task: WebKit and Chromium both load it anew, from the cache.
        image.removeAttribute("src");
        image.setAttribute("src", src);
        recovered(image);
      };
      probe.onerror = () => {
        waiting.delete(image);
        failed(image);
      };
      probe.src = src;
    }, delays[tries]);
    timers.add(timer);
  };

  return {
    failed,
    stop() {
      stopped = true;
      for (const timer of timers) host.clearTimeout(timer);
      timers.clear();
    },
  };
}
