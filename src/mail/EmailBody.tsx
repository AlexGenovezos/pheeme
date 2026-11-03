import { ImageOff } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import type { MessageDetail } from "../lib/tauri";
import { useThemeStore } from "../theme/theme";
import { linkify, openLink } from "./linkify";
import { buildSrcdoc } from "./srcdoc";
import "./mail.css";

/**
 * A message body. Plain text renders in the main document (React-escaped, URLs linkified); HTML renders in
 * a script-less sandboxed iframe (Builder's calls 10–13) that the parent sizes and whose links it opens.
 */
export function EmailBody({ message }: { message: MessageDetail }) {
  if (message.bodyHtml) {
    return (
      <HtmlBody key={message.id} html={message.bodyHtml} hasRemoteContent={message.hasRemoteContent} declaresDark={message.declaresDarkMode} />
    );
  }
  if (message.bodyText) return <div className="message-card__text selectable">{linkify(message.bodyText)}</div>;
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

/** Identical growth this many times in a row means the content is sized by the frame itself (`100vh`). */
const MAX_REPEATED_GROWTH = 2;

/**
 * Follow a loaded frame document: size the iframe to its content and route link clicks to the OS. The
 * frame can't run scripts, so all of this runs in the parent against the same-origin document. Returns
 * a function that stops it.
 */
function watchFrame(iframe: HTMLIFrameElement, wrapper: HTMLElement, doc: Document): () => void {
  const root = doc.documentElement;
  let applied = 0;
  let lastGrowth = 0;
  let repeats = 0;
  let width = iframe.clientWidth;

  const measure = () => {
    const height = Math.ceil(root.scrollHeight);
    const change = height - applied;
    if (change === 0) return;
    if (change > 0 && change === lastGrowth) {
      // Each resize made the content taller by the same amount: it's chasing the frame. Stop following.
      if (repeats >= MAX_REPEATED_GROWTH) return;
      repeats += 1;
    } else {
      repeats = 0;
    }
    lastGrowth = change;
    applied = height;
    iframe.style.height = `${height}px`;
  };

  // scrollHeight never reports less than the frame's own height, so to shrink (the pane got wider and the
  // text reflowed) collapse the frame and measure again. The wrapper holds its height meanwhile, so the
  // reading pane's scroll position isn't clamped; it all happens in one task, so nothing paints.
  const remeasureFromZero = () => {
    wrapper.style.minHeight = `${wrapper.offsetHeight}px`;
    iframe.style.height = "0px";
    applied = 0;
    lastGrowth = 0;
    repeats = 0;
    measure();
    wrapper.style.minHeight = "";
  };

  const onResize = () => {
    if (iframe.clientWidth !== width) {
      width = iframe.clientWidth;
      remeasureFromZero();
    } else {
      measure();
    }
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target as Element | null;
    // The target belongs to the frame's realm, so `instanceof Element` would be false here.
    const link = typeof target?.closest === "function" ? target.closest("a[href], area[href]") : null;
    if (!link) return;
    event.preventDefault();
    if (event.type !== "click" || event.button !== 0) return; // middle-click etc.: blocked, nothing opens
    const url = openableUrl(link.getAttribute("href"));
    if (url) openLink(url);
  };

  doc.addEventListener("click", onClick, true);
  doc.addEventListener("auxclick", onClick, true);

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
  };
}
