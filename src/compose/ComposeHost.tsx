import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { lazy, Suspense, useEffect, useState } from "react";
import { useCommands } from "../keyboard/useCommands";
import { toast } from "../components/ui/Toast";
import { createSubscriptionScope } from "../lib/subscriptions";
import { stopQuietly } from "../lib/tauri";
import { isTauri } from "../preview/runtime";
import { useAccountStore } from "../store/accountStore";
import {
  type ComposeWindow,
  SAVE_BEFORE_EXIT_EVENT,
  SAVED_BEFORE_EXIT_EVENT,
  SEND_LATER_COMMAND,
  useComposeStore,
} from "./composeStore";
import { useSignatures } from "./signatures";
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

/** The message a compose command acts on: the panel with focus, else the newest one open, else the newest. */
function activeWindow(windows: ComposeWindow[]): ComposeWindow | undefined {
  const focused = Number(
    document.activeElement?.closest<HTMLElement>("[data-compose-id]")?.dataset.composeId,
  );
  return (
    windows.find((w) => w.id === focused) ??
    [...windows].reverse().find((w) => !w.minimized) ??
    windows[windows.length - 1]
  );
}

/** Docks the open compose panels along the bottom of the window, newest on the right. */
export function ComposeHost() {
  const windows = useComposeStore((s) => s.windows);
  const dropTarget = useFileDrops(windows.length > 0);
  // Gmail's API has no scheduled send, so Send later hands the draft to Gmail on the web (see `sendLater`).
  useCommands(
    windows.length > 0
      ? [
          {
            id: SEND_LATER_COMMAND,
            title: "Send later in Gmail",
            group: "General",
            keywords: ["schedule send", "scheduled", "later", "compose"],
            run: () => {
              const target = activeWindow(useComposeStore.getState().windows);
              if (target) void useComposeStore.getState().sendLater(target.id);
            },
          },
        ]
      : [],
  );
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

/**
 * The app is about to quit (or restart): save what's being written to Gmail Drafts, then tell Rust how it went.
 * Rust holds the quit for the answer; on `false` the app stays open, and quitting again goes through.
 */
export async function saveBeforeExit(): Promise<void> {
  const saved = await useComposeStore
    .getState()
    .saveAll()
    .catch(() => false);
  if (!saved)
    toast({
      title: "Pheeme didn't quit",
      description: "A draft couldn't be saved. Quit again to leave without saving it.",
      tone: "danger",
      duration: 0,
    });
  await emit(SAVED_BEFORE_EXIT_EVENT, saved);
}

/**
 * Follow send outcomes for the whole session (a panel is gone by the time its send is confirmed), save open
 * messages when the app is about to quit, fetch each account's Gmail signature once, so a new message
 * starts with the current one, and say which sends from before a restart didn't go through.
 */
export function useComposeEvents() {
  useEffect(() => {
    const scope = createSubscriptionScope();
    scope
      .add(() => useComposeStore.getState().subscribe())
      .catch((err) => console.warn("send status listener failed", err));
    scope
      .add(() =>
        listen(SAVE_BEFORE_EXIT_EVENT, () => void saveBeforeExit().catch(() => {})).then(
          (stop) => () => stopQuietly(stop),
        ),
      )
      .catch((err) => console.warn("save-before-exit listener failed", err));
    return scope.dispose;
  }, []);
  const accounts = useAccountStore((s) => s.accounts);
  useEffect(() => {
    const signatures = useSignatures.getState();
    void signatures.loadSaved(accounts.map((a) => a.id)).then(() => {
      for (const a of accounts) void useSignatures.getState().refreshGmailOnce(a.id);
    });
    for (const a of accounts) {
      // Sends from before a restart that didn't go through: no panel is left to say so.
      void useComposeStore.getState().checkFailedSends(a.id);
    }
  }, [accounts]);
}
