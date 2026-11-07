import { useDesktopEvents } from "./desktop/events";
import { useNotificationPrompt } from "./desktop/prompt";
import { useModCommands, useModEvents } from "./mods/lifecycle";
import { ModPanel } from "./mods/ModSurfaces";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { toast, ToastProvider } from "./components/ui/Toast";
import { ComposeHost, useComposeEvents } from "./compose/ComposeHost";
import { Onboarding } from "./onboarding/Onboarding";
import { useAccountStore } from "./store/accountStore";
import { UpdateBanner } from "./components/UpdateBanner";
import { useAppCommands } from "./keyboard/appCommands";
import { isEditableTarget } from "./keyboard/registry";
import { useGlobalShortcuts } from "./keyboard/useCommands";
import { createSubscriptionScope } from "./lib/subscriptions";
import { type OutboxRejected, SYNC_EVENTS } from "./lib/tauri";
import { listenForManualChecks, startUpdateChecks } from "./lib/updater";
import { CommandPalette } from "./palette/CommandPalette";
import { Settings } from "./settings/Settings";
import { useSettingsStore } from "./settings/settingsStore";
import { isTauri } from "./preview/runtime";
import { revealWindow } from "./theme/nativeWindow";
import { AppShell } from "./shell/AppShell";
import { ContextMenuHost } from "./shell/ContextMenuHost";
import { useLabelStore } from "./store/labelStore";
import { useMailStore } from "./store/mailStore";
import { useThreadStore } from "./store/threadStore";
import { startPreloading } from "./mail/preload";

/** Hide the webview's own menu (Reload, Inspect…) outside text; dev builds keep it for devtools. */
function useNativeContextMenuOnly() {
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (isEditableTarget(target) || target?.closest?.(".selectable")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
}

/** Keep the thread list, labels and counts fresh on sync, and say when Gmail refuses a queued change. */
function useSyncEvents() {
  useEffect(() => {
    const scope = createSubscriptionScope();
    const log = (err: unknown) => console.warn("sync event listener failed", err);
    scope.add((signal) => useMailStore.getState().subscribe(signal)).catch(log);
    scope.add((signal) => useLabelStore.getState().subscribe(signal)).catch(log);
    scope
      .add(() =>
        listen<OutboxRejected>(SYNC_EVENTS.outboxRejected, ({ payload }) =>
          toast({
            title: `Couldn't ${payload.kind}`,
            description: `Gmail said: ${payload.message}. Your change was undone.`,
            tone: "danger",
            duration: 0,
          }),
        ),
      )
      .catch(log);
    return scope.dispose;
  }, []);
}

/** Load labels and counts for the connected accounts, again whenever the set changes. */
function useLabelsAndCounts() {
  const accountIds = useAccountStore((s) => s.accounts.map((a) => a.id).join("\n"));
  useEffect(() => {
    void useLabelStore.getState().load(accountIds ? accountIds.split("\n") : []);
  }, [accountIds]);
}

function MailScreen({ onAddAccount }: { onAddAccount: () => void }) {
  useEffect(startPreloading, []);
  useGlobalShortcuts();
  useAppCommands();
  useModCommands();
  useNativeContextMenuOnly();
  useSyncEvents();
  useLabelsAndCounts();
  useNotificationPrompt();

  return (
    <>
      <AppShell onAddAccount={onAddAccount} />
      <ComposeHost />
      <CommandPalette />
      <Settings onAddAccount={onAddAccount} />
      <ContextMenuHost />
      <ModPanel />
    </>
  );
}

/**
 * Account sync state (first sync done, last failure) and the cached conversation details, for the whole
 * session. Subscribed above the screens, so adding an account (onboarding) doesn't drop events,
 * forget a failure, or leave the reading pane showing a conversation as it was before.
 */
function useSessionSyncEvents() {
  useEffect(() => {
    const scope = createSubscriptionScope();
    const log = (err: unknown) => console.warn("sync event listener failed", err);
    scope.add((signal) => useAccountStore.getState().subscribe(signal)).catch(log);
    scope.add((signal) => useThreadStore.getState().subscribe(signal)).catch(log);
    return scope.dispose;
  }, []);
}

function App() {
  useModEvents();
  const { accounts, loaded, error, load, upsert, reconnecting, reconnect } = useAccountStore();
  const reconnectAccount = accounts.find((a) => a.id === reconnecting);
  const [adding, setAdding] = useState(false);
  const showMail = useCallback(() => setAdding(false), []);
  useDesktopEvents(loaded && accounts.length > 0, showMail);
  // Onboarding replaces the mail screen; the settings dialog closes so it doesn't reopen on return.
  const addAccount = () => {
    useSettingsStore.getState().close();
    setAdding(true);
  };

  useEffect(() => {
    void load();
  }, [load]);
  useSessionSyncEvents();
  useComposeEvents();
  useEffect(() => {
    if (import.meta.env.PROD && isTauri()) return startUpdateChecks();
  }, []);
  useEffect(() => {
    if (isTauri()) return listenForManualChecks();
  }, []);
  useEffect(() => {
    if (loaded && isTauri()) revealWindow();
  }, [loaded]);

  let screen = null;
  if (loaded && error) {
    screen = (
      <div className="onboarding onboarding--single">
        <main className="onboarding-main">
          <div className="onboarding-content" role="alert">
            <h1>Pheeme couldn't start</h1>
            <p className="guide-lead">{error.message}</p>
          </div>
        </main>
      </div>
    );
  } else if (loaded && (accounts.length === 0 || adding || reconnectAccount)) {
    screen = (
      <Onboarding
        key={reconnectAccount?.id ?? "add"}
        accounts={accounts}
        reconnect={reconnectAccount}
        onConnected={(account) => {
          upsert(account);
          setAdding(false);
          reconnect(null);
        }}
        onClose={
          accounts.length > 0
            ? () => {
                setAdding(false);
                reconnect(null);
              }
            : undefined
        }
      />
    );
  } else if (loaded) {
    screen = <MailScreen onAddAccount={addAccount} />;
  }
  return <ToastProvider pinned={<UpdateBanner />}>{screen}</ToastProvider>;
}

export default App;
