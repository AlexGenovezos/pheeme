import { useEffect, useRef, useState } from "react";
import { usePreviewTrace } from "./trace";

export type FrameState = "loading" | "ready" | "failed";

export interface FramePreviewProps {
  data: ArrayBuffer;
  name: string;
  /** The frame took focus (a click inside it); keys typed there would never reach the panel. */
  onFrameFocus?(): void;
}

/**
 * Shared lifecycle for a script-less sandboxed preview iframe (`DocxView`, `PptxView`): writes
 * `shell` into the frame, tracks loading/ready/failed state, and notifies the panel when the frame
 * takes focus so Escape/shortcuts still work.
 */
export function useSandboxedFrame(
  data: ArrayBuffer,
  onFrameFocus: (() => void) | undefined,
  render: (
    doc: Document,
    signal: AbortSignal,
    trace: ReturnType<typeof usePreviewTrace>,
  ) => { done: Promise<void>; cleanup?: () => void },
  buildShell: () => string,
) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<FrameState>("loading");
  const trace = usePreviewTrace();

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const stop = new AbortController();
    setState("loading");
    doc.open();
    doc.write(buildShell());
    doc.close();
    const { done, cleanup } = render(doc, stop.signal, trace);
    done
      .then(() => {
        if (stop.signal.aborted) return;
        setState("ready");
      })
      .catch((error: unknown) => {
        if (stop.signal.aborted) return;
        trace?.failed("read", error);
        setState("failed");
      });
    return () => {
      stop.abort();
      cleanup?.();
    };
    // `render` and `buildShell` depend only on `data`/`trace` (stable per mount/file).
    // oxlint-disable-next-line react/exhaustive-deps
  }, [data, trace]);

  useEffect(() => {
    const iframe = frame.current;
    const host = iframe?.ownerDocument.defaultView;
    if (!iframe || !host || !onFrameFocus) return;
    const onBlur = () =>
      setTimeout(() => iframe.ownerDocument.activeElement === iframe && onFrameFocus());
    host.addEventListener("blur", onBlur);
    return () => host.removeEventListener("blur", onBlur);
  }, [onFrameFocus]);

  return { frame, state };
}
