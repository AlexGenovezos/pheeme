import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { toast, ToastProvider } from "./components/ui/Toast";
import { AccountsHome } from "./components/AccountsHome";
import { Onboarding } from "./onboarding/Onboarding";
import { useAccountStore } from "./store/accountStore";
import { UpdateBanner } from "./components/UpdateBanner";
import { useAppCommands } from "./keyboard/appCommands";
import { isEditableTarget } from "./keyboard/registry";
import { useGlobalShortcuts } from "./keyboard/useCommands";
import { type OutboxRejected, stopQuietly, SYNC_EVENTS } from "./lib/tauri";
import { listenForManualChecks, startUpdateChecks } from "./lib/updater";
import { CommandPalette } from "./palette/CommandPalette";
import { isTauri } from "./preview/runtime";
import { AppShell } from "./shell/AppShell";
import { ContextMenuHost } from "./shell/ContextMenuHost";
import { useLabelStore } from "./store/labelStore";
import { useMailStore } from "./store/mailStore";
import { useThreadStore } from "./store/threadStore";

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
    let stopped = false;
    const stops: (() => void)[] = [];
    const keep = (stop: () => void) => (stopped ? stopQuietly(stop) : stops.push(stop));
    const log = (err: unknown) => console.warn("sync event listener failed", err);
    useMailStore.getState().subscribe().then(keep, log);
    useLabelStore.getState().subscribe().then(keep, log);
    listen<OutboxRejected>(SYNC_EVENTS.outboxRejected, ({ payload }) =>
      toast({
        title: `Couldn't ${payload.kind}`,
        description: `Gmail said: ${payload.message}. Your change was undone.`,
        tone: "danger",
      }),
    ).then(keep, log);
    return () => {
      stopped = true;
      stops.forEach(stopQuietly);
    };
  }, []);
}

/** Load labels and counts for the connected accounts, again whenever the set changes. */
function useLabelsAndCounts() {
  const accountIds = useAccountStore((s) => s.accounts.map((a) => a.id).join("\n"));
  useEffect(() => {
    void useLabelStore.getState().load(accountIds ? accountIds.split("\n") : []);
  }, [accountIds]);
}

function MailScreen({
  onManageAccounts,
  onAddAccount,
}: {
  onManageAccounts: () => void;
  onAddAccount: () => void;
}) {
  useGlobalShortcuts();
  useAppCommands();
  useNativeContextMenuOnly();
  useSyncEvents();
  useLabelsAndCounts();

  return (
    <>
      <AppShell onManageAccounts={onManageAccounts} onAddAccount={onAddAccount} />
      <CommandPalette />
      <ContextMenuHost />
    </>
  );
}

/**
 * Account sync state (first sync done, last failure) and the cached conversation details, for the whole
 * session. Subscribed above the screens, so opening Manage accounts or onboarding doesn't drop events,
 * forget a failure, or leave the reading pane showing a conversation as it was before.
 */
function useSessionSyncEvents() {
  useEffect(() => {
    let stopped = false;
    const stops: (() => void)[] = [];
    const keep = (stop: () => void) => (stopped ? stopQuietly(stop) : stops.push(stop));
    const log = (err: unknown) => console.warn("sync event listener failed", err);
    useAccountStore.getState().subscribe().then(keep, log);
    useThreadStore.getState().subscribe().then(keep, log);
    return () => {
      stopped = true;
      stops.forEach(stopQuietly);
    };
  }, []);
}

function App() {
  const { accounts, loaded, error, load, upsert } = useAccountStore();
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);
  useSessionSyncEvents();
  useEffect(() => {
    if (import.meta.env.PROD && isTauri()) return startUpdateChecks();
  }, []);
  useEffect(() => {
    if (isTauri()) return listenForManualChecks();
  }, []);

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
  } else if (loaded && (accounts.length === 0 || adding)) {
    screen = (
      <Onboarding
        accounts={accounts}
        onConnected={(account) => {
          upsert(account);
          setAdding(false);
          setManaging(false);
        }}
        onClose={accounts.length > 0 ? () => setAdding(false) : undefined}
      />
    );
  } else if (loaded && managing) {
    screen = <AccountsHome onAdd={() => setAdding(true)} onClose={() => setManaging(false)} />;
  } else if (loaded) {
    screen = (
      <MailScreen onManageAccounts={() => setManaging(true)} onAddAccount={() => setAdding(true)} />
    );
  }
  return <ToastProvider pinned={<UpdateBanner />}>{screen}</ToastProvider>;
}

export default App;
