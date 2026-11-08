import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { PreviewMessage } from "./PreviewMessage";

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
        setSizes(pages.map((v) => ({ width: v.width, height: v.height })));
        setDoc(pdf);
      })
      .catch(() => !stop.signal.aborted && setFailed(true));
    return () => {
      stop.abort();
      void task.destroy();
    };
  }, [data]);

  if (failed) return <PreviewMessage>Couldn't read “{name}” as a PDF.</PreviewMessage>;
  if (!doc) return <PreviewMessage busy>Opening…</PreviewMessage>;
  return (
    <div className="file-preview__pages" aria-label={`${name}, ${sizes.length} pages`}>
      {sizes.map((size, i) => (
        <PdfPage key={i} doc={doc} number={i + 1} size={size} />
      ))}
    </div>
  );
}

function PdfPage({ doc, number, size }: { doc: PDFDocumentProxy; number: number; size: PageSize }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const el = holder.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setVisible(true),
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
    void doc.getPage(number).then((page) => {
      if (stop.signal.aborted) return;
      const scale = (el.clientWidth / size.width) * (window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      task = page.render({ canvas: c, viewport });
      task.promise.catch(() => undefined);
    });
    return () => {
      stop.abort();
      task?.cancel();
    };
  }, [visible, doc, number, size.width]);

  return (
    <div
      ref={holder}
      className="file-preview__page"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
    >
      <canvas ref={canvas} aria-label={`Page ${number}`} role="img" />
    </div>
  );
}
