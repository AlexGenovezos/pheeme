import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer";
import { PreviewMessage } from "./PreviewMessage";
import { type FramePreviewProps, useSandboxedFrame } from "./sandboxedFrame";

/**
 * The frame's own policy, on top of the app's: nothing loads from outside the document (pictures
 * come in as `blob:` URLs), and the frame is sandboxed without scripts. The deck scrolls in
 * `#scroller`; charts take no pointer input, since their tooltips would insert the deck's text as
 * markup.
 */
const shell = (scrollbar: string, width: string) =>
  "<!doctype html><html><head><meta charset='utf-8'>" +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; form-action 'none'; base-uri 'none'">` +
  "<style>html,body{margin:0;height:100%}body{background:transparent}" +
  `#scroller{box-sizing:border-box;height:100%;overflow:auto;padding:16px;scrollbar-width:thin;scrollbar-color:${scrollbar} transparent}` +
  `#deck{max-width:${width};margin:0 auto}` +
  "#deck [_echarts_instance_]{pointer-events:none}</style>" +
  "</head><body><div id='scroller'><div id='deck'></div></div></body></html>";

/**
 * A PowerPoint deck, slide after slide down the panel, drawn as HTML and SVG by pptx-renderer
 * inside a script-less sandboxed frame. The parent writes and fills the frame (same origin), so
 * nothing in the deck can run. Slides parse and mount as they scroll into view, so a long deck
 * opens as fast as a short one.
 *
 * The renderer registers a deck's embedded fonts on the app's document (and measures text there),
 * so each one it adds is added to the frame's fonts too. Nothing loads from outside the file:
 * external media is blocked, and links and click actions are swallowed.
 */
export default function PptxView({ data, name, onFrameFocus }: FramePreviewProps) {
  const { frame, state } = useSandboxedFrame(
    data,
    onFrameFocus,
    (doc, signal, trace) => {
      const root = doc.getElementById("deck")!;
      const scrollContainer = doc.getElementById("scroller")!;

      const appFonts = new Set(document.fonts);
      const shareFonts = () => {
        for (const face of document.fonts) {
          if (appFonts.has(face) || doc.fonts.has(face)) continue;
          try {
            doc.fonts.add(face);
          } catch {
            // A face the app's CSS declared can't join another set; the deck's own never are.
          }
        }
      };

      // Slides react to clicks (hyperlinks, jumps between slides); a preview stays put.
      const swallow = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      };
      root.addEventListener("click", swallow, true);
      root.addEventListener("auxclick", swallow, true);

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
        onSlideRendered: (index, el) => {
          shareFonts();
          trace?.drew(index + 1, false);
          for (const link of el.querySelectorAll("a[href]")) link.removeAttribute("href");
        },
      });
      // The viewer may keep the buffer it's given; keep the cached one intact.
      const done = viewer
        .open(data.slice(0), {
          signal,
          listOptions: { windowed: true, initialSlides: 3, batchSize: 4 },
        })
        .then(() => {
          if (signal.aborted) return;
          shareFonts();
          trace?.read();
        });
      return {
        done,
        cleanup: () => {
          viewer.destroy();
          root.removeEventListener("click", swallow, true);
          root.removeEventListener("auxclick", swallow, true);
        },
      };
    },
    () => {
      const tokens = getComputedStyle(document.documentElement);
      const token = (prop: string, fallback: string) =>
        tokens.getPropertyValue(prop).trim() || fallback;
      return shell(
        token("--color-scrollbar-thumb", "auto"),
        token("--preview-page-max-width", "900px"),
      );
    },
  );

  // The frame stays laid out (just invisible) while loading: the viewer sizes slides to its box.
  return (
    <>
      <iframe
        ref={frame}
        className="file-preview__frame file-preview__slides"
        data-state={state}
        sandbox="allow-same-origin"
        title={name}
        referrerPolicy="no-referrer"
        aria-hidden={state !== "ready"}
      />
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
