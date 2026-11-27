// Before pdf.js: it calls built-ins older Macs' WebKit lacks.
import "./pdfjsPolyfills";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "./pdf.worker?worker&url";
import { useEffect, useRef, useState } from "react";
import { PreviewMessage } from "./PreviewMessage";
import { isBlankCanvas, type PreviewTrace, usePreviewTrace } from "./trace";

GlobalWorkerOptions.workerSrc = workerUrl;

interface PageSize {
  width: number;
  height: number;
}

/** Every page of a PDF, stacked and fitted to the panel's width. Pages draw as they scroll into view. */
export default function PdfView({ data, name }: { data: ArrayBuffer; name: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [failed, setFailed] = useState(false);
  const trace = usePreviewTrace();

  useEffect(() => {
    const stop = new AbortController();
    // pdf.js takes ownership of (detaches) the buffer it's given; keep the cached one intact.
    const task = getDocument({ data: new Uint8Array(data.slice(0)) });
    task.promise
      .then(async (pdf) => {
        const pages = await Promise.all(
          Array.from({ length: pdf.numPages }, (_, i) =>
            pdf.getPage(i + 1).then((p) => p.getViewport({ scale: 1 })),
          ),
        );
        if (stop.signal.aborted) return;
        trace?.read(pdf.numPages);
        setSizes(pages.map((v) => ({ width: v.width, height: v.height })));
        setDoc(pdf);
      })
      .catch((error: unknown) => {
        if (stop.signal.aborted) return;
        trace?.failed("read", error);
        setFailed(true);
      });
    return () => {
      stop.abort();
      void task.destroy();
    };
  }, [data, trace]);

  if (failed) return <PreviewMessage>Couldn't read “{name}” as a PDF.</PreviewMessage>;
  if (!doc) return <PreviewMessage busy>Opening…</PreviewMessage>;
  return (
    <div className="file-preview__pages" aria-label={`${name}, ${sizes.length} pages`}>
      {sizes.map((size, i) => (
        <PdfPage key={i} doc={doc} number={i + 1} size={size} trace={trace} />
      ))}
    </div>
  );
}

/** Largest canvas side and area: past them a webview refuses the canvas (or runs out of memory) and the page is blank. */
const MAX_CANVAS_SIDE = 4096;
const MAX_CANVAS_AREA = 16_000_000;

/** How much to shrink a page of this size so its canvas stays within the limits (1 when it already does). */
export function canvasFit({ width, height }: { width: number; height: number }): number {
  return Math.min(
    1,
    MAX_CANVAS_SIDE / width,
    MAX_CANVAS_SIDE / height,
    Math.sqrt(MAX_CANVAS_AREA / (width * height)),
  );
}

function PdfPage({
  doc,
  number,
  size,
  trace,
}: {
  doc: PDFDocumentProxy;
  number: number;
  size: PageSize;
  trace: PreviewTrace | null;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // Once near the view it stays drawn: nothing more to watch.
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setVisible(true);
        io.disconnect();
      },
      { rootMargin: "100% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = holder.current;
    const c = canvas.current;
    if (!visible || !el || !c) return;
    const stop = new AbortController();
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    doc
      .getPage(number)
      .then((page) => {
        if (stop.signal.aborted) return;
        // Nothing to draw into (a page with no width, or a holder not laid out).
        if (el.clientWidth <= 0 || !(size.width > 0)) return;
        const scale = (el.clientWidth / size.width) * (window.devicePixelRatio || 1);
        const viewport = page.getViewport({
          scale: scale * canvasFit(page.getViewport({ scale })),
        });
        c.width = Math.floor(viewport.width);
        c.height = Math.floor(viewport.height);
        task = page.render({ canvas: c, viewport });
        return task.promise.then(
          () => {
            if (!stop.signal.aborted) trace?.drew(number, isBlankCanvas(c), c);
          },
          (error: unknown) => {
            // Cancelled because the page scrolled away or the preview closed: not a failure.
            if (stop.signal.aborted) return;
            trace?.failed("render", error, number);
            setFailed(true);
          },
        );
      })
      .catch((error: unknown) => {
        if (stop.signal.aborted) return;
        trace?.failed("render", error, number);
        setFailed(true);
      });
    return () => {
      stop.abort();
      task?.cancel();
    };
  }, [visible, doc, number, size.width, trace]);

  return (
    <div
      ref={holder}
      className="file-preview__page"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
    >
      <canvas ref={canvas} aria-label={`Page ${number}`} role="img" />
      {/* Over the page's own frame, so a failure takes no more room than the page would have. */}
      {failed && (
        <p className="file-preview__page-failed">
          Pheeme couldn't draw page {number}. Open the file in its app, or download it.
        </p>
      )}
    </div>
  );
}
