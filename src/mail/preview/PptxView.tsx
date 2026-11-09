import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer";
import { useEffect, useRef, useState } from "react";
import { PreviewMessage } from "./PreviewMessage";

/**
 * A PowerPoint deck, slide after slide down the panel, drawn as HTML and SVG by pptx-renderer.
 * Slides parse and mount as they scroll into view, so a long deck opens as fast as a short one.
 *
 * The renderer writes slide text as text (never as markup) and builds its own elements, so it
 * runs in the app's document rather than a sandboxed frame (a frame would cut it off from the
 * deck's embedded fonts, which it registers on this document). Nothing loads from outside the
 * file: external media is blocked, and links and click actions are swallowed. Charts take no
 * pointer input (see preview.css): their tooltips would insert the deck's text as markup.
 */
export default function PptxView({ data, name }: { data: ArrayBuffer; name: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const slides = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const root = slides.current;
    const scrollContainer = scroller.current;
    if (!root || !scrollContainer) return;
    const stop = new AbortController();
    setState("loading");
    // Made before opening so cleanup can always destroy it: an aborted open throws before
    // the static `PptxViewer.open` would hand the viewer back.
    const viewer = new PptxViewer(root, {
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      externalMedia: "block",
      // Its PDF fallback for EMF pictures needs blob: workers, which the app's CSP refuses.
      pdfjs: false,
      lazyMedia: true,
      lazySlides: true,
      scrollContainer,
      // Links can't go anywhere from a preview; keep their text only. (Just links: SVG
      // elements such as WordArt's <textPath> use href for references within the slide.)
      onSlideRendered: (_, el) => {
        for (const link of el.querySelectorAll("a[href]")) link.removeAttribute("href");
      },
    });
    // The viewer may keep the buffer it's given; keep the cached one intact.
    viewer
      .open(data.slice(0), {
        signal: stop.signal,
        listOptions: { windowed: true, initialSlides: 3, batchSize: 4 },
      })
      .then(() => !stop.signal.aborted && setState("ready"))
      .catch(() => !stop.signal.aborted && setState("failed"));
    return () => {
      stop.abort();
      viewer.destroy();
    };
  }, [data]);

  // Slides react to clicks (hyperlinks, jumps between slides); a preview stays put.
  useEffect(() => {
    const root = slides.current;
    if (!root) return;
    const swallow = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    root.addEventListener("click", swallow, true);
    root.addEventListener("auxclick", swallow, true);
    return () => {
      root.removeEventListener("click", swallow, true);
      root.removeEventListener("auxclick", swallow, true);
    };
  }, []);

  // The slides stay laid out (just invisible) while loading: the viewer sizes them to its box.
  return (
    <>
      <div
        ref={scroller}
        className="file-preview__slides selectable"
        data-state={state}
        aria-label={name}
        aria-hidden={state !== "ready"}
      >
        <div ref={slides} className="file-preview__deck" />
      </div>
      {state !== "ready" && (
        <div className="file-preview__over">
          {state === "loading" ? (
            <PreviewMessage busy>Opening…</PreviewMessage>
          ) : (
            <PreviewMessage>Couldn't read “{name}” as a PowerPoint presentation.</PreviewMessage>
          )}
        </div>
      )}
    </>
  );
}
