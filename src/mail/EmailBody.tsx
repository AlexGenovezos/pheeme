import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { Button } from "../components/ui/Button";
import { isEditableTarget, registry, type CommandRegistry } from "../keyboard/registry";
import { platform } from "../lib/platform";
import type { CommandError, MessageDetail, ThreadLoading as Loading } from "../lib/tauri";
import { useThemeStore } from "../theme/theme";
import { linkify, openLink } from "./linkify";
import { BROKEN_IMAGE, buildSrcdoc } from "./srcdoc";
import { ThreadLoading } from "./ThreadLoading";
import "./mail.css";

/**
 * A message body. Plain text renders in the main document (React-escaped, URLs linkified); HTML renders in
 * a script-less sandboxed iframe (Builder's calls 10–13) that the parent writes, sizes and opens links for.
 */
export function EmailBody({
  message,
  bodyError,
  loading,
  onRetry,
}: {
  message: MessageDetail;
  /** Why the body couldn't be fetched, when the backend knows. */
  bodyError?: CommandError | null;
  /** A fetch of the body is running: say what it waits on rather than the last failure. */
  loading?: Loading;
  onRetry?(): void;
}) {
  if (message.bodyHtml) {
    return (
      <HtmlBody key={message.id} html={message.bodyHtml} declaresDark={message.declaresDarkMode} />
    );
  }
  if (message.bodyText)
    return <div className="message-card__text selectable">{linkify(message.bodyText)}</div>;
  if (!message.bodyAvailable) {
    // Shown at once: the user asked for it (Try again), or the pane already showed the failure.
    if (loading)
      return <ThreadLoading loading={loading} delayMs={0} className="thread-loading--inline" />;
    return (
      <div className="message-card__unavailable">
        <p className="message-card__empty">
          {bodyError?.message ?? "Couldn't load this message — you may be offline."}
        </p>
        {onRetry && (
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  return <p className="message-card__empty">This message is empty.</p>;
}

interface HtmlBodyProps {
  html: string;
  declaresDark: boolean;
}

export function HtmlBody({ html, declaresDark }: HtmlBodyProps) {
  const dark = useThemeStore((s) => s.resolved === "dark");
  const wrapper = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const stopWatching = useRef<(() => void) | null>(null);
  const written = useRef<{ doc: Document; srcDoc: string } | null>(null);

  // The theme writes its tokens onto :root before the store changes, so they're current on re-render.
  const srcDoc = useMemo(() => {
    const tokens = getComputedStyle(document.documentElement);
    return buildSrcdoc(html, {
      // Bodies mount only when a message (or quoted original) is expanded. Opening it loads its images.
      allowRemote: true,
      dark,
      declaresDark,
      textColor: tokens.getPropertyValue("--color-foreground"),
      linkColor: tokens.getPropertyValue("--color-link"),
    });
  }, [html, dark, declaresDark]);

  const detach = useCallback(() => {
    stopWatching.current?.();
    stopWatching.current = null;
  }, []);

  // The document is written into the frame synchronously rather than set as `srcdoc`: WebKit loads a srcdoc
  // a task later, so the browser painted the frame at zero height first. Switching threads flashed the
  // reply bar up under the header, then the body popped in. Written here, it is measured before any paint.
  const show = useCallback(() => {
    const iframe = frame.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc || !wrapper.current) return;
    const current = written.current?.doc === doc && written.current.srcDoc === srcDoc;
    if (current && stopWatching.current) return;
    detach();
    if (!current) {
      doc.open();
      doc.write(srcDoc);
      doc.close();
      written.current = { doc, srcDoc };
    }
    stopWatching.current = watchFrame(iframe, wrapper.current, doc);
  }, [srcDoc, detach]);

  useLayoutEffect(() => {
    show();
    return detach;
  }, [show, detach]);

  // `onLoad`: a frame moved in the DOM starts over with a blank document and fires `load`; write it again.
  return (
    <div className="email-body" ref={wrapper}>
      <iframe
        ref={frame}
        className="email-body__frame"
        sandbox="allow-same-origin"
        title="Message body"
        referrerPolicy="no-referrer"
        onLoad={show}
      />
    </div>
  );
}

/** The email frame the user last clicked into, whose selection mod+c copies. */
let lastFocusedFrame: HTMLIFrameElement | null = null;

const OPENABLE = new Set(["http:", "https:", "mailto:"]);

/** An absolute http(s)/mailto URL, or null. Relative links would resolve against the app, so they don't open. */
function openableUrl(href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.trim());
    return OPENABLE.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Growth the frame caused itself (it got taller only because we made it taller: `100vh` boxes, percentage
 * heights) is allowed this many times in a row before the frame stops following its content.
 */
const MAX_SELF_GROWTH = 3;
/** Past this the frame stops growing however it got there; the rest of the body scrolls inside it. */
export const MAX_FRAME_HEIGHT = 30_000;

const LINK = "a[href], area[href]";

/** `closest` on a node from the frame's realm, where `instanceof Element` would be false. */
const closestLink = (target: EventTarget | null) => {
  const el = target as Element | null;
  return typeof el?.closest === "function" ? el.closest(LINK) : null;
};

/**
 * Follow a written frame document: size the iframe to its content, route link clicks to the OS and keys
 * to the app's shortcuts. The frame can't run scripts, so all of this runs in the parent against the
 * same-origin document. Returns a function that stops it.
 */
function watchFrame(
  iframe: HTMLIFrameElement,
  wrapper: HTMLElement,
  doc: Document,
  commands: CommandRegistry = registry,
): () => void {
  const root = doc.documentElement;
  const images = Array.from(doc.images, (image) => ({
    image,
    height: image.style.getPropertyValue("height"),
    priority: image.style.getPropertyPriority("height"),
  }));
  // Responsive emails reflow at the pane width. Older promotional emails often contain fixed-width
  // tables (including inline min-widths); scale that layout only when it still overflows at full size.
  const fitWidth = () => {
    root.style.setProperty("zoom", "1", "important");
    for (const { image, height, priority } of images) {
      // Restore the sender's height before checking the new width. A height-sized logo must keep its
      // dimensions; only an image actually shrunk by max-width needs its fixed height released.
      image.style.setProperty("height", height, priority);
      const constrained = image.getBoundingClientRect().width;
      const maxWidth = image.style.getPropertyValue("max-width");
      const maxPriority = image.style.getPropertyPriority("max-width");
      image.style.setProperty("max-width", "none", "important");
      const requested = image.getBoundingClientRect().width;
      image.style.setProperty("max-width", maxWidth, maxPriority);
      if (requested > constrained + 1) image.style.setProperty("height", "auto", "important");
    }
    const available = iframe.clientWidth;
    const content = Math.max(root.scrollWidth, doc.body?.scrollWidth ?? 0);
    if (available > 0 && content > available) {
      root.style.setProperty("zoom", String(available / content), "important");
    }
  };
  let applied = 0;
  // Growth since anything outside our own resizing (load, an image arriving, a new width) happened.
  let selfGrowth = 0;
  let external = true;
  // Once the content is found chasing the frame, or is enormous, the frame keeps its height and scrolls.
  let pinned = false;

  const setHeight = (height: number) => {
    applied = height;
    iframe.style.height = `${height}px`;
  };

  const measure = () => {
    if (pinned) return;
    const height = Math.ceil(root.scrollHeight);
    const change = height - applied;
    if (change === 0) {
      // Settled at the height we set: whatever grew it, it wasn't feeding on the frame.
      selfGrowth = 0;
      external = false;
      return;
    }
    selfGrowth = change > 0 && !external ? selfGrowth + 1 : 0;
    external = false;
    if (selfGrowth > MAX_SELF_GROWTH || height > MAX_FRAME_HEIGHT) {
      pinned = true;
      setHeight(
        height > MAX_FRAME_HEIGHT && selfGrowth <= MAX_SELF_GROWTH ? MAX_FRAME_HEIGHT : applied,
      );
      // The rest must stay reachable even if the email hides overflow: inline !important beats any
      // `overflow` rule (important or not) in the email's own stylesheets.
      for (const el of [root, doc.body]) el?.style.setProperty("overflow", "auto", "important");
      return;
    }
    setHeight(height);
  };

  // scrollHeight never reports less than the frame's own height, so to shrink (the pane got wider and the
  // text reflowed) collapse the frame and measure again. The wrapper holds its height meanwhile, so the
  // reading pane's scroll position isn't clamped; it all happens in one task, so nothing paints.
  const remeasureFromZero = () => {
    if (pinned) return;
    wrapper.style.minHeight = `${wrapper.offsetHeight}px`;
    iframe.style.height = "0px";
    fitWidth();
    applied = 0;
    external = true;
    measure();
    wrapper.style.minHeight = "";
  };

  let width = iframe.clientWidth;
  const onResize = () => {
    if (pinned) return;
    if (iframe.clientWidth !== width) {
      width = iframe.clientWidth;
      remeasureFromZero();
    } else {
      measure();
    }
  };

  // The dark theme flips images back from the inverted page; a failed one (blocked host, offline) would
  // flip its alt text too, leaving the light email's dark text color on the now dark page.
  const markBroken = () => {
    for (const image of Array.from(doc.images)) {
      if (image.complete) image.toggleAttribute(BROKEN_IMAGE, image.naturalWidth === 0);
    }
  };

  // Images don't bubble `load`, but capture sees them: their growth is the content's, not the frame's.
  const onContentLoad = () => {
    markBroken();
    external = true;
    remeasureFromZero();
  };

  // Chromium (Windows) runs this; WebKit (macOS, Linux) skips listeners in a script-less frame, so there a
  // clicked link becomes a navigation that the backend's navigation hook cancels and opens instead. That
  // needs `frame-src` in tauri.conf.json's CSP to allow the link's scheme, or WebKit refuses it first.
  const onClick = (event: MouseEvent) => {
    const link = closestLink(event.target);
    if (!link) return;
    event.preventDefault();
    if (event.type !== "click" || event.button !== 0) return; // middle-click etc.: blocked, nothing opens
    const url = openableUrl(link.getAttribute("href"));
    if (url) openLink(url);
  };

  // Keys typed with focus in the frame never reach the parent window's shortcut handler, so hand them over.
  // Enter/Space on a link stay native: they activate it, which arrives above as a click. Unbound keys
  // (mod+c, Tab) aren't touched, so copying, selecting and tabbing keep working.
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.key === "Enter" || event.key === " ") && closestLink(event.target)) return;
    commands.handleKeyDown(event);
  };

  doc.addEventListener("click", onClick, true);
  doc.addEventListener("auxclick", onClick, true);
  doc.addEventListener("keydown", onKeyDown);
  doc.addEventListener("load", onContentLoad, true);
  doc.addEventListener("error", onContentLoad, true);
  // The frame's own `load` (every image done) reaches the parent's listener in WebKit too.
  iframe.addEventListener("load", markBroken);

  // WebKit (the macOS app) runs none of the listeners on `doc` while the frame is sandboxed without scripts,
  // and a click into the email focuses the frame, after which no key reaches the app (Left, j/k, ...). There,
  // focus goes straight back to the reading pane; a selection made in the frame survives that.
  const host = iframe.ownerDocument;
  const pane = () => iframe.parentElement?.closest<HTMLElement>("[tabindex]");
  let listenersRun = false;
  const probe = () => (listenersRun = true);
  doc.addEventListener("pheeme-probe", probe);
  doc.dispatchEvent(new Event("pheeme-probe"));
  doc.removeEventListener("pheeme-probe", probe);
  const onHostBlur = () =>
    setTimeout(() => {
      if (host.activeElement !== iframe) return;
      lastFocusedFrame = iframe;
      pane()?.focus({ preventScroll: true });
    });
  // A press anywhere in the app is outside the frame (presses inside it never reach the app): the email is no
  // longer what the user last clicked, so its leftover selection isn't what mod+c should copy.
  const onHostPointerDown = () => {
    if (lastFocusedFrame === iframe) lastFocusedFrame = null;
  };
  // With focus out of the frame, the native copy reads the app's selection; copy the email's instead.
  const onHostKeyDown = (event: KeyboardEvent) => {
    if (lastFocusedFrame !== iframe || event.altKey || event.shiftKey) return;
    if (isEditableTarget(event.target)) return; // a text field's own selection
    // A conversation left behind stays mounted (inert); its old selection isn't what's being copied.
    if (iframe.closest("[inert]")) return;
    // Drag-selecting in the frame can leave nothing focused (macOS 27 WebKit takes focus off the pane), so the
    // page itself counts as still being in the email; focus somewhere else in the app (keys moved it) doesn't.
    const active = host.activeElement;
    if (active && active !== host.body && !pane()?.contains(active)) return;
    const mod = platform === "macos" ? event.metaKey : event.ctrlKey;
    if (!mod || event.key.toLowerCase() !== "c") return;
    if (doc.getSelection()?.isCollapsed !== false || host.getSelection()?.isCollapsed === false)
      return;
    if (doc.execCommand("copy")) event.preventDefault();
  };

  if (!listenersRun) {
    host.defaultView?.addEventListener("blur", onHostBlur);
    host.defaultView?.addEventListener("pointerdown", onHostPointerDown, true);
    host.defaultView?.addEventListener("keydown", onHostKeyDown, true);
  }

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(onResize);
    observer.observe(root);
    if (doc.body) observer.observe(doc.body);
    observer.observe(iframe);
  }
  markBroken();
  fitWidth();
  measure();

  return () => {
    iframe.removeEventListener("load", markBroken);
    observer?.disconnect();
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("auxclick", onClick, true);
    doc.removeEventListener("keydown", onKeyDown);
    host.defaultView?.removeEventListener("blur", onHostBlur);
    host.defaultView?.removeEventListener("pointerdown", onHostPointerDown, true);
    host.defaultView?.removeEventListener("keydown", onHostKeyDown, true);
    if (lastFocusedFrame === iframe) lastFocusedFrame = null;
    doc.removeEventListener("load", onContentLoad, true);
    doc.removeEventListener("error", onContentLoad, true);
  };
}
