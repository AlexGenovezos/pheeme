// Warm the HTTP cache with the remote images of preloaded conversations, so they paint with the body.
// Images a server marks no-store can't be warmed this way; ThreadView keeps the nearest conversations
// rendered for those.
import type { ThreadDetail } from "../lib/tauri";
import { useReadingSettings } from "../settings/readingSettings";
import { useMailStore } from "../store/mailStore";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";

/** At most this many image URLs per window: enough for ~20 newsletters, without warming whole mailboxes. */
export const MAX_WARM_IMAGES = 256;
/** Downloads at once, leaving the webview's connections free for the email on screen. */
const CONCURRENT = 4;

const parsed = new WeakMap<ThreadDetail, string[]>();

/** A CSS background's image. Only backgrounds: fonts and imports are blocked in the email frame, so never fetched. */
const CSS_BACKGROUND = /background(?:-image)?\s*:[^;}]*?url\(\s*["']?(https?:\/\/[^"')\s]+)/gi;

/** The http(s) images a conversation's HTML bodies show: `img` src and srcset, `background` attributes, CSS backgrounds. */
function imageUrls(detail: ThreadDetail): string[] {
  const urls = new Set<string>();
  const add = (raw: string | null) => {
    if (raw && /^https?:\/\//i.test(raw.trim())) urls.add(raw.trim());
  };
  for (const message of detail.messages) {
    if (!message.bodyHtml) continue;
    const doc = new DOMParser().parseFromString(message.bodyHtml, "text/html");
    doc.querySelectorAll("img[src]").forEach((el) => add(el.getAttribute("src")));
    doc.querySelectorAll("[background]").forEach((el) => add(el.getAttribute("background")));
    doc.querySelectorAll("[style], style").forEach((el) => {
      const css = el.tagName === "STYLE" ? el.textContent : el.getAttribute("style");
      for (const match of (css ?? "").matchAll(CSS_BACKGROUND)) add(match[1]);
    });
    doc.querySelectorAll("img[srcset], source[srcset]").forEach((el) => {
      for (const candidate of el.getAttribute("srcset")!.split(/,\s+/))
        add(candidate.trim().split(/\s+/)[0]);
    });
  }
  return [...urls];
}

export function startImagePreloading() {
  let keys: string[] = [];
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Requested and still in the window, so each URL is fetched once. */
  const requested = new Set<string>();
  /** In flight. Held so a download isn't collected before it lands in the cache. */
  const loading = new Set<HTMLImageElement>();

  const schedule = () => {
    if (!stopped && timer === undefined) timer = setTimeout(run, 0);
  };
  const run = () => {
    timer = undefined;
    if (stopped || !useReadingSettings.getState().preloadImages) return;
    // The list and the open conversation come first.
    const open = useUiStore.getState().openThread;
    const { details } = useThreadStore.getState();
    if (useMailStore.getState().loading || (open && !details.has(open))) return;

    const wanted: string[] = [];
    let partial = false;
    for (const key of keys) {
      const detail = details.get(key);
      if (!detail) continue;
      let urls = parsed.get(detail);
      if (!urls) {
        parsed.set(detail, (urls = imageUrls(detail)));
        // Parsing is the costly part: one conversation per task keeps arrow presses responsive.
        partial = true;
        schedule();
      }
      wanted.push(...urls);
      if (partial || wanted.length >= MAX_WARM_IMAGES) break;
    }
    const inWindow = new Set(wanted.slice(0, MAX_WARM_IMAGES));
    // Forget what slid out of the window, so the set stays bounded.
    if (!partial) for (const url of requested) if (!inWindow.has(url)) requested.delete(url);
    for (const url of inWindow) {
      if (loading.size >= CONCURRENT) return;
      if (requested.has(url)) continue;
      requested.add(url);
      const image = new Image();
      image.referrerPolicy = "no-referrer";
      image.onload = image.onerror = () => {
        loading.delete(image);
        schedule();
      };
      loading.add(image);
      image.src = url;
    }
  };

  const unsubscribes = [
    useMailStore.subscribe(schedule),
    useUiStore.subscribe(schedule),
    useThreadStore.subscribe(schedule),
    useReadingSettings.subscribe(schedule),
  ];
  return {
    /** The conversations to warm, most important first. */
    update(next: string[]) {
      keys = next;
      schedule();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
  };
}
