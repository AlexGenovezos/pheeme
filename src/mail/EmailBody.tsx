import { ImageOff } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { registry, type CommandRegistry } from "../keyboard/registry";
import type { MessageDetail } from "../lib/tauri";
import { useThemeStore } from "../theme/theme";
import { linkify, openLink } from "./linkify";
import { buildSrcdoc } from "./srcdoc";
import "./mail.css";

/**
 * A message body. Plain text renders in the main document (React-escaped, URLs linkified); HTML renders in
 * a script-less sandboxed iframe (Builder's calls 10–13) that the parent sizes and whose links it opens.
 */
export function EmailBody({ message, onRetry }: { message: MessageDetail; onRetry?(): void }) {
  if (message.bodyHtml) {
    return (
      <HtmlBody key={message.id} html={message.bodyHtml} hasRemoteContent={message.hasRemoteContent} declaresDark={message.declaresDarkMode} />
    );
  }
  if (message.bodyText) return <div className="message-card__text selectable">{linkify(message.bodyText)}</div>;
  if (!message.bodyAvailable) {
    return (
      <div className="message-card__unavailable">
        <p className="message-card__empty">Couldn't load this message — you may be offline.</p>
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
  hasRemoteContent: boolean;
  declaresDark: boolean;
}

function HtmlBody({ html, hasRemoteContent, declaresDark }: HtmlBodyProps) {
  const [allowRemote, setAllowRemote] = useState(false);
  const dark = useThemeStore((s) => s.resolved === "dark");
  const wrapper = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const stopWatching = useRef<(() => void) | null>(null);

  // The theme writes its tokens onto :root before the store changes, so they're current on re-render.
  const srcDoc = useMemo(() => {
    const tokens = getComputedStyle(document.documentElement);
    return buildSrcdoc(html, {
      allowRemote,
      dark,
      declaresDark,
      textColor: tokens.getPropertyValue("--color-foreground"),
      linkColor: tokens.getPropertyValue("--color-link"),
    });
  }, [html, allowRemote, dark, declaresDark]);

  const detach = useCallback(() => {
    stopWatching.current?.();
    stopWatching.current = null;
  }, []);

  // A new srcdoc replaces the document: let go of the old one now, not when the new one loads.
  useLayoutEffect(() => detach, [srcDoc, detach]);

  const onLoad = useCallback(() => {
    detach();
    const iframe = frame.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !wrapper.current || !doc?.documentElement) return;
    stopWatching.current = watchFrame(iframe, wrapper.current, doc);
  }, [detach]);

  return (
    <div className="email-body" ref={wrapper}>
      {hasRemoteContent && !allowRemote && (
        <div className="email-body__images">
          <ImageOff aria-hidden="true" className="email-body__images-icon" />
          <span className="email-body__images-text">Images from the web are hidden.</span>
          <Button size="sm" variant="ghost" onClick={() => setAllowRemote(true)}>
            Load images
          </Button>
        </div>
      )}
      <iframe
        ref={frame}
        className="email-body__frame"
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        title="Message body"
        referrerPolicy="no-referrer"
        onLoad={onLoad}
      />
    </div>
  );
}

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
 * Follow a loaded frame document: size the iframe to its content, route link clicks to the OS and keys
 * to the app's shortcuts. The frame can't run scripts, so all of this runs in the parent against the
 * same-origin document. Returns a function that stops it.
 */
function watchFrame(iframe: HTMLIFrameElement, wrapper: HTMLElement, doc: Document, commands: CommandRegistry = registry): () => void {
  const root = doc.documentElement;
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
      setHeight(height > MAX_FRAME_HEIGHT && selfGrowth <= MAX_SELF_GROWTH ? MAX_FRAME_HEIGHT : applied);
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
    wrapper.style.minHeight = `${wrapper.offsetHeight}px`;
    iframe.style.height = "0px";
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

  // Images don't bubble `load`, but capture sees them: their growth is the content's, not the frame's.
  const onContentLoad = () => {
    external = true;
  };

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
  // (mod+c, arrows, Tab) aren't touched, so copying, selecting and tabbing keep working.
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.key === "Enter" || event.key === " ") && closestLink(event.target)) return;
    commands.handleKeyDown(event);
  };

  doc.addEventListener("click", onClick, true);
  doc.addEventListener("auxclick", onClick, true);
  doc.addEventListener("keydown", onKeyDown);
  doc.addEventListener("load", onContentLoad, true);
  doc.addEventListener("error", onContentLoad, true);

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(onResize);
    observer.observe(root);
    if (doc.body) observer.observe(doc.body);
    observer.observe(iframe);
  }
  measure();

  return () => {
    observer?.disconnect();
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("auxclick", onClick, true);
    doc.removeEventListener("keydown", onKeyDown);
    doc.removeEventListener("load", onContentLoad, true);
    doc.removeEventListener("error", onContentLoad, true);
  };
}
