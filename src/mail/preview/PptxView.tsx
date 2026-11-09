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
 * file: external media is blocked, and links and click actions are swallowed.
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
    let viewer: PptxViewer | null = null;
    setState("loading");
    // The viewer may keep the buffer it's given; keep the cached one intact.
    PptxViewer.open(data.slice(0), root, {
      signal: stop.signal,
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      externalMedia: "block",
      // Its PDF fallback for EMF pictures needs blob: workers, which the app's CSP refuses.
      pdfjs: false,
      lazyMedia: true,
      lazySlides: true,
      scrollContainer,
      listOptions: { windowed: true, initialSlides: 3, batchSize: 4 },
      // Links can't go anywhere from a preview; keep their text only.
      onSlideRendered: (_, el) => {
        for (const link of el.querySelectorAll("[href]")) link.removeAttribute("href");
      },
    })
      .then((v) => {
        if (stop.signal.aborted) return v.destroy();
        viewer = v;
        setState("ready");
      })
      .catch(() => !stop.signal.aborted && setState("failed"));
    return () => {
      stop.abort();
      viewer?.destroy();
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
