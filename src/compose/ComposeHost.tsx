import { getCurrentWebview } from "@tauri-apps/api/webview";
import { lazy, Suspense, useEffect, useState } from "react";
import { createSubscriptionScope } from "../lib/subscriptions";
import { isTauri } from "../preview/runtime";
import { useComposeStore } from "./composeStore";
import "./compose.css";

// The editor is the heaviest part of the app; it loads the first time a message is written.
const ComposePanel = lazy(() =>
  import("./ComposePanel").then((m) => ({ default: m.ComposePanel })),
);

/** The compose panel under a viewport point, if any. */
function panelAt(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-compose-id]");
  const id = Number(el?.dataset.composeId);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Files dragged in from the OS: Tauri hands over their paths (the DOM only gets them without one). */
function useFileDrops(enabled: boolean): number | null {
  const [over, setOver] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    const scope = createSubscriptionScope();
    scope
      .add(() =>
        getCurrentWebview().onDragDropEvent(({ payload }) => {
          if (payload.type === "leave") {
            setOver(null);
            return;
          }
          const scale = window.devicePixelRatio || 1;
          const id = panelAt(payload.position.x / scale, payload.position.y / scale);
          if (payload.type === "over" || payload.type === "enter") setOver(id);
          else if (payload.type === "drop") {
            setOver(null);
            if (id !== null) void useComposeStore.getState().attachFiles(id, payload.paths);
          }
        }),
      )
      .catch((err) => console.warn("file drop listener failed", err));
    return scope.dispose;
  }, [enabled]);
  return over;
}

/** Docks the open compose panels along the bottom of the window, newest on the right. */
export function ComposeHost() {
  const windows = useComposeStore((s) => s.windows);
  const dropTarget = useFileDrops(windows.length > 0);
  if (windows.length === 0) return null;
  return (
    <div className="compose-dock" data-open="true">
      <Suspense fallback={null}>
        {windows.map((win) => (
          <div
            key={win.id}
            className="compose-dock__slot"
            data-drop-target={dropTarget === win.id || undefined}
          >
            <ComposePanel win={win} />
          </div>
        ))}
      </Suspense>
    </div>
  );
}

/** Follow send outcomes for the whole session (a panel is gone by the time its send is confirmed). */
export function useComposeEvents() {
  useEffect(() => {
    const scope = createSubscriptionScope();
    scope
      .add(() => useComposeStore.getState().subscribe())
      .catch((err) => console.warn("send status listener failed", err));
    return scope.dispose;
  }, []);
}
