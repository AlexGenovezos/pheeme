import { useEffect, useRef, useState } from "react";
import { usePreviewTrace } from "./trace";

export type FrameState = "loading" | "ready" | "failed";

export interface FramePreviewProps {
  data: ArrayBuffer;
  name: string;
  /** Keys pressed while focus is inside the frame (e.g. Escape, Left/Right). */
  onFrameKeyDown?(e: KeyboardEvent): void;
}

/**
 * Shared lifecycle for a script-less sandboxed preview iframe (`DocxView`, `PptxView`): writes
 * `shell` into the frame, tracks loading/ready/failed state, and forwards frame keydown events to
 * the panel without stealing focus from the document.
 */
export function useSandboxedFrame(
  data: ArrayBuffer,
  onFrameKeyDown: ((e: KeyboardEvent) => void) | undefined,
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
  const onKeyDownRef = useRef(onFrameKeyDown);
  onKeyDownRef.current = onFrameKeyDown;

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const stop = new AbortController();
    setState("loading");
    doc.open();
    doc.write(buildShell());
    doc.close();
    const onKeyDown = (e: KeyboardEvent) => onKeyDownRef.current?.(e);
    doc.addEventListener("keydown", onKeyDown);
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
      doc.removeEventListener("keydown", onKeyDown);
      cleanup?.();
    };
    // `render` and `buildShell` depend only on `data`/`trace` (stable per mount/file).
    // oxlint-disable-next-line react/exhaustive-deps
  }, [data, trace]);

  return { frame, state };
}
