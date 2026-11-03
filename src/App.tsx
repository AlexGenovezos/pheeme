import { useEffect, useState } from "react";
import { ToastProvider } from "./components/ui/Toast";
import { AccountsHome } from "./components/AccountsHome";
import { Onboarding } from "./onboarding/Onboarding";
import { useAccountStore } from "./store/accountStore";
import { UpdateBanner } from "./components/UpdateBanner";
import { useAppCommands } from "./keyboard/appCommands";
import { isEditableTarget } from "./keyboard/registry";
import { useGlobalShortcuts } from "./keyboard/useCommands";
import { listenForManualChecks, startUpdateChecks } from "./lib/updater";
import { CommandPalette } from "./palette/CommandPalette";
import { isTauri } from "./preview/runtime";
import { AppShell } from "./shell/AppShell";
import { ContextMenuHost } from "./shell/ContextMenuHost";

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

function MailScreen({ onManageAccounts }: { onManageAccounts: () => void }) {
  useGlobalShortcuts();
  useAppCommands();
  useNativeContextMenuOnly();

  return (
    <>
      <AppShell onManageAccounts={onManageAccounts} />
      <CommandPalette />
      <ContextMenuHost />
    </>
  );
}

function App() {
  const { accounts, loaded, error, load, upsert } = useAccountStore();
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);

  useEffect(() => { void load(); }, [load]);
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
    screen = <Onboarding accounts={accounts} onConnected={(account) => {
      upsert(account);
      setAdding(false);
      setManaging(false);
    }} onClose={accounts.length > 0 ? () => setAdding(false) : undefined} />;
  } else if (loaded && managing) {
    screen = <AccountsHome onAdd={() => setAdding(true)} onClose={() => setManaging(false)} />;
  } else if (loaded) {
    screen = <MailScreen onManageAccounts={() => setManaging(true)} />;
  }
  return <ToastProvider pinned={<UpdateBanner />}>{screen}</ToastProvider>;
}

export default App;
