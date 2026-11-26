import { useEffect, useRef, useState } from "react";
import { isEditableTarget } from "../../keyboard/registry";
import { platform } from "../../lib/platform";
import { usePreviewTrace } from "./trace";

export type FrameState = "loading" | "ready" | "failed";

export interface FramePreviewProps {
  data: ArrayBuffer;
  name: string;
  /** Keys pressed while focus is inside the frame (when the engine runs parent listeners on it). */
  onFrameKeyDown?(e: KeyboardEvent): void;
  /** Fallback when the engine blocks listeners in script-less frames (WebKit): return focus to the panel. */
  onFrameFocus?(): void;
}

/**
 * Shared lifecycle for a script-less sandboxed preview iframe (`DocxView`, `PptxView`): writes
 * `shell` into the frame, tracks loading/ready/failed state, and keeps panel shortcuts working on
 * both Chromium (capture-phase keydown on `doc`, leaving focus inside) and WebKit (host blur
 * refocus plus `Mod+C` forwarding for the frame's selection, matching `EmailBody`).
 */
export function useSandboxedFrame(
  data: ArrayBuffer,
  onFrameKeyDown: ((e: KeyboardEvent) => void) | undefined,
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
  const onKeyDownRef = useRef(onFrameKeyDown);
  onKeyDownRef.current = onFrameKeyDown;
  const onFocusRef = useRef(onFrameFocus);
  onFocusRef.current = onFrameFocus;

  useEffect(() => {
    const iframe = frame.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return;
    const stop = new AbortController();
    setState("loading");
    doc.open();
    doc.write(buildShell());
    doc.close();

    // WebKit (macOS WKWebView / Linux WebKitGTK) refuses to invoke any DOM listener on a
    // script-less sandboxed document, even one attached by the same-origin parent.
    let listenersRun = false;
    const probe = () => (listenersRun = true);
    doc.addEventListener("pheeme-probe", probe);
    doc.dispatchEvent(new Event("pheeme-probe"));
    doc.removeEventListener("pheeme-probe", probe);

    const hostDoc = iframe.ownerDocument;
    const host = hostDoc.defaultView;
    const onKeyDown = (e: KeyboardEvent) => onKeyDownRef.current?.(e);
    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    const onHostBlur = () => {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        blurTimer = null;
        if (hostDoc.activeElement === iframe) onFocusRef.current?.();
      });
    };
    const onHostKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.shiftKey || isEditableTarget(event.target)) return;
      const mod = platform === "macos" ? event.metaKey : event.ctrlKey;
      if (!mod || event.key.toLowerCase() !== "c") return;
      if (
        doc.getSelection()?.isCollapsed !== false ||
        hostDoc.getSelection()?.isCollapsed === false
      )
        return;
      if (doc.execCommand("copy")) event.preventDefault();
    };

    if (listenersRun) {
      doc.addEventListener("keydown", onKeyDown, true);
    } else if (host) {
      host.addEventListener("blur", onHostBlur);
      host.addEventListener("keydown", onHostKeyDown, true);
    }

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
      if (blurTimer) clearTimeout(blurTimer);
      if (listenersRun) {
        doc.removeEventListener("keydown", onKeyDown, true);
      } else if (host) {
        host.removeEventListener("blur", onHostBlur);
        host.removeEventListener("keydown", onHostKeyDown, true);
      }
      cleanup?.();
    };
    // `render` and `buildShell` depend only on `data`/`trace` (stable per mount/file).
    // oxlint-disable-next-line react/exhaustive-deps
  }, [data, trace]);

  return { frame, state };
}
