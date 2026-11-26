import { renderAsync } from "docx-preview";
import { PreviewMessage } from "./PreviewMessage";
import { type FramePreviewProps, useSandboxedFrame } from "./sandboxedFrame";

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
export default function DocxView({ data, name, onFrameKeyDown }: FramePreviewProps) {
  const { frame, state } = useSandboxedFrame(
    data,
    onFrameKeyDown,
    (doc, signal, trace) => ({
      done: renderAsync(data, doc.body, doc.head, {
        className: "docx",
        useBase64URL: true,
        renderAltChunks: false,
        renderComments: false,
        renderChanges: false,
        ignoreLastRenderedPageBreak: true,
        experimental: false,
      }).then(() => {
        if (signal.aborted) return;
        // Links can't go anywhere from a preview; keep their text only.
        for (const link of doc.querySelectorAll("[href]")) link.removeAttribute("href");
        trace?.shown();
      }),
    }),
    () => SHELL,
  );

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
