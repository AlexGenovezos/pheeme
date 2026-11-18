import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ImagePlus, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type DragEvent, type RefObject } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Skeleton } from "../components/ui/Skeleton";
import { base64Of } from "../lib/base64";
import { createSubscriptionScope } from "../lib/subscriptions";
import { prepareScreenshot, toCommandError, type PreparedScreenshot } from "../lib/tauri";
import { isTauri } from "../preview/runtime";

/** Matches `MAX_SCREENSHOTS` and `MAX_INPUT_BYTES` in `support/screenshot.rs`. */
export const MAX_SCREENSHOTS = 3;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

type Slot = { id: number; shot: PreparedScreenshot | null };
/** A file from a paste, the picker or a drop in the browser preview; a path from a drop in the app. */
type Source = Blob | string;

/** The image files on a clipboard or in a drop. */
function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((f) => f.type.startsWith("image/"));
}

let nextId = 1;

/**
 * The screenshots added to a report. Each file is checked by `prepare_screenshot`, which returns it
 * as a clean PNG (or refuses it), so what is shown here is exactly what is sent. A paste anywhere
 * while the form is open adds the image on the clipboard; a file dropped on `dropZone` adds it too.
 */
export function useDiagnosticScreenshots(
  dropZone: RefObject<HTMLElement | null>,
  onError: (message: string) => void,
) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [dropOver, setDropOver] = useState(false);
  // Slots taken, kept in step by the handlers so several adds before a render still count.
  const count = useRef(0);

  const add = (sources: Source[]) => {
    if (!sources.length) return;
    const room = MAX_SCREENSHOTS - count.current;
    if (sources.length > room) onError(`Add at most ${MAX_SCREENSHOTS} screenshots.`);
    for (const source of sources.slice(0, Math.max(0, room))) {
      const id = nextId++;
      count.current += 1;
      setSlots((s) => [...s, { id, shot: null }]);
      void (async () => {
        try {
          if (typeof source !== "string" && source.size > MAX_FILE_BYTES) {
            throw {
              code: "invalid_input",
              message: "That image is too large. Add one under 25 MB.",
            };
          }
          const shot = await prepareScreenshot(
            typeof source === "string" ? { path: source } : { data: await base64Of(source) },
          );
          setSlots((s) => s.map((slot) => (slot.id === id ? { id, shot } : slot)));
        } catch (raw) {
          count.current -= 1;
          setSlots((s) => s.filter((slot) => slot.id !== id));
          onError(toCommandError(raw).message);
        }
      })();
    }
  };
  const addFromEvent = useEffectEvent(add);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = imageFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      addFromEvent(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // The app gets dropped files from Tauri, as paths; the DOM never sees them.
  useEffect(() => {
    if (!isTauri()) return;
    const inZone = (x: number, y: number) => {
      const scale = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(x / scale, y / scale);
      return !!el && !!dropZone.current?.contains(el);
    };
    const scope = createSubscriptionScope();
    scope
      .add(() =>
        getCurrentWebview().onDragDropEvent(({ payload }) => {
          if (payload.type === "leave") setDropOver(false);
          else if (payload.type === "enter" || payload.type === "over") {
            setDropOver(inZone(payload.position.x, payload.position.y));
          } else if (payload.type === "drop") {
            setDropOver(false);
            if (inZone(payload.position.x, payload.position.y)) addFromEvent(payload.paths);
          }
        }),
      )
      .catch((err) => console.warn("screenshot drop listener failed", err));
    return scope.dispose;
  }, [dropZone]);

  return {
    slots,
    dropOver,
    add,
    remove: (id: number) => {
      count.current -= 1;
      setSlots((s) => s.filter((slot) => slot.id !== id));
    },
    /** Still being checked: Send waits for them. */
    pending: slots.some((s) => s.shot === null),
    /** The cleaned PNGs, base64, in the order added. */
    ready: slots.flatMap((s) => (s.shot ? [s.shot.png] : [])),
    /** For a drop in the browser preview (the app's drops come through Tauri). */
    onDrop: (e: DragEvent) => {
      const files = imageFiles(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      add(files);
    },
  };
}

/** The Screenshots field: a thumbnail for each one added, and Add screenshot… while there's room. */
export function DiagnosticsScreenshots({
  slots,
  add,
  remove,
}: Pick<ReturnType<typeof useDiagnosticScreenshots>, "slots" | "add" | "remove">) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="settings-diagnostics__field">
      <span className="settings-diagnostics__label" id="settings-diagnostics-shots">
        Screenshots
      </span>
      <ul className="settings-diagnostics__shots" aria-labelledby="settings-diagnostics-shots">
        {slots.map((slot, n) => (
          <li key={slot.id} className="settings-diagnostics__shot">
            {slot.shot ? (
              <img
                src={`data:image/png;base64,${slot.shot.png}`}
                alt={`Screenshot ${n + 1}, ${slot.shot.width} × ${slot.shot.height}`}
              />
            ) : (
              <Skeleton shape="block" className="settings-diagnostics__shot-loading" />
            )}
            <IconButton
              size="sm"
              className="settings-diagnostics__shot-remove"
              label={`Remove screenshot ${n + 1}`}
              icon={<X size={12} aria-hidden />}
              disabled={!slot.shot}
              onClick={() => remove(slot.id)}
            />
          </li>
        ))}
        {slots.length < MAX_SCREENSHOTS && (
          <li>
            <Button
              size="sm"
              icon={<ImagePlus size={14} aria-hidden />}
              onClick={() => input.current?.click()}
            >
              Add screenshot…
            </Button>
          </li>
        )}
      </ul>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg"
        multiple
        hidden
        data-testid="screenshot-file-input"
        onChange={(e) => {
          add([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <span className="settings-diagnostics__sender">
        {`Or paste or drop them here, up to ${MAX_SCREENSHOTS} PNG or JPEG images. They're sent as they look, so crop out anything private.`}
      </span>
    </div>
  );
}
