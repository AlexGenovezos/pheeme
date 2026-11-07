import { renderAsync } from "docx-preview";
import { useEffect, useRef, useState } from "react";
import { PreviewMessage } from "./PreviewMessage";

/**
 * The frame's own policy, on top of the app's: nothing loads from outside the document (images and fonts
 * come in as `data:` URLs), and the frame is sandboxed without scripts.
 */
const SHELL =
  "<!doctype html><html><head><meta charset='utf-8'>" +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">` +
  "<style>html,body{margin:0}body{background:transparent}.docx-wrapper{background:transparent!important;padding:16px 0!important}</style>" +
  "</head><body></body></html>";

/**
 * A Word document laid out page by page by docx-preview, inside a script-less sandboxed frame. The
 * parent writes and fills the frame (same origin), so nothing in the document can run.
 */
export default function DocxView({
  data,
  name,
  onFrameFocus,
}: {
  data: ArrayBuffer;
  name: string;
  /** The frame took focus (a click inside it); keys typed there would never reach the panel. */
  onFrameFocus?(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const stop = new AbortController();
    setState("loading");
    doc.open();
    doc.write(SHELL);
    doc.close();
    renderAsync(data, doc.body, doc.head, {
      className: "docx",
      useBase64URL: true,
      renderAltChunks: false,
      renderComments: false,
      renderChanges: false,
      ignoreLastRenderedPageBreak: true,
      experimental: false,
    })
      .then(() => {
        if (stop.signal.aborted) return;
        // Links can't go anywhere from a preview; keep their text only.
        for (const link of doc.querySelectorAll("[href]")) link.removeAttribute("href");
        setState("ready");
      })
      .catch(() => !stop.signal.aborted && setState("failed"));
    return () => {
      stop.abort();
    };
  }, [data]);

  useEffect(() => {
    const iframe = frame.current;
    const host = iframe?.ownerDocument.defaultView;
    if (!iframe || !host || !onFrameFocus) return;
    const onBlur = () =>
      setTimeout(() => iframe.ownerDocument.activeElement === iframe && onFrameFocus());
    host.addEventListener("blur", onBlur);
    return () => host.removeEventListener("blur", onBlur);
  }, [onFrameFocus]);

  return (
    <>
      {state === "loading" && <PreviewMessage busy>Opening…</PreviewMessage>}
      {state === "failed" && (
        <PreviewMessage>Couldn't read “{name}” as a Word document.</PreviewMessage>
      )}
      <iframe
        ref={frame}
        className="file-preview__frame"
        hidden={state !== "ready"}
        sandbox="allow-same-origin"
        title={name}
        referrerPolicy="no-referrer"
      />
    </>
  );
}
