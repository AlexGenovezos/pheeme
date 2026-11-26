import { AddFromFileHost } from "./calendar/AddFromFile";
import { useDesktopEvents } from "./desktop/events";
import { useNotificationPrompt } from "./desktop/prompt";
import { useModCommands, useModEvents } from "./mods/lifecycle";
import { ModPanel } from "./mods/ModSurfaces";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ErrorBoundary, LazyDialog, surfaceLoader } from "./components/ui/ErrorBoundary";
import { toast, ToastProvider } from "./components/ui/Toast";
import { ComposeHost, useComposeEvents } from "./compose/ComposeHost";
import { Onboarding } from "./onboarding/Onboarding";
import { useSetupGuide } from "./onboarding/guideStore";
import { useAccountStore } from "./store/accountStore";
import { useDownloadStore } from "./store/downloadStore";
import { useAppCommands } from "./keyboard/appCommands";
import { isEditableTarget } from "./keyboard/registry";
import { useGlobalShortcuts } from "./keyboard/useCommands";
import { createSubscriptionScope } from "./lib/subscriptions";
import { listen, SYNC_EVENTS } from "./lib/tauri";
import { listenForManualChecks, startUpdateChecks } from "./lib/updater";
import { CommandPalette } from "./palette/CommandPalette";
import { useStatsStore } from "./stats/statsStore";
import { closeThemeEditor, useThemeEditorStore } from "./theme/editor/editorStore";
import { usePreviewStore } from "./mail/preview/previewStore";
import { useModStore } from "./mods/store";
import { useFilterEditorStore } from "./filters/editorStore";
import { PersonHost } from "./contacts/PersonPanel";
import { useSettingsStore } from "./settings/settingsStore";
import { isTauri } from "./preview/runtime";
import { revealWindow } from "./theme/nativeWindow";
import { AppShell } from "./shell/AppShell";
import { useCalendarStore } from "./calendar/calendarStore";
import { ContextMenuHost } from "./shell/ContextMenuHost";
import { CornerNotices } from "./shell/CornerNotices";
import { useInboxTabs } from "./store/inboxTabsStore";
import { useLabelStore } from "./store/labelStore";
import { useMailStore } from "./store/mailStore";
import { useThreadStore } from "./store/threadStore";
import { startPreloading } from "./mail/preload";
import { SpeedReaderHost } from "./speedread/SpeedReader";
import { TasksPanelHost } from "./tasks/TasksPanel";
import { useUsageTracking } from "./usage/useUsageTracking";

const CalendarScreen = lazy(
  surfaceLoader(() =>
    import("./calendar/CalendarScreen").then(({ CalendarScreen }) => ({ default: CalendarScreen })),
  ),
);
const Settings = lazy(
  surfaceLoader(() =>
    import("./settings/Settings").then(({ Settings }) => ({ default: Settings })),
  ),
);
const FilterEditorHost = lazy(
  surfaceLoader(() =>
    import("./filters/FilterEditor").then(({ FilterEditorHost }) => ({
      default: FilterEditorHost,
    })),
  ),
);
const Stats = lazy(
  surfaceLoader(() => import("./stats/StatsDialog").then(({ Stats }) => ({ default: Stats }))),
);
const ThemeEditorHost = lazy(
  surfaceLoader(() =>
    import("./theme/editor/ThemeEditor").then(({ ThemeEditorHost }) => ({
      default: ThemeEditorHost,
    })),
  ),
);
const AttachmentPreview = lazy(
  surfaceLoader(() =>
    import("./mail/preview/AttachmentPreview").then(({ AttachmentPreview }) => ({
      default: AttachmentPreview,
    })),
  ),
);

function SecondarySurfaces({ onAddAccount }: { onAddAccount: () => void }) {
  const settings = useSettingsStore((s) => s.open);
  const filterEditor = useFilterEditorStore((s) => s.editor !== null);
  const stats = useStatsStore((s) => s.open);
  const theme = useThemeEditorStore((s) => s.open);
  const attachment = usePreviewStore((s) => s.session !== null);
  const mod = useModStore((s) => s.panel);
  const closeSettings = useSettingsStore.getState().close;
  const closeStats = useStatsStore.getState().close;
  const closePreview = usePreviewStore.getState().close;
  // These are overlays. Loading a chunk leaves the app's geometry and other open surfaces in place.
  return (
    <>
      {settings && (
        <LazyDialog
          title="Couldn't open Settings"
          loadingTitle="Opening Settings…"
          onClose={closeSettings}
        >
          <Settings onAddAccount={onAddAccount} />
        </LazyDialog>
      )}
      {/* After Settings, so the editor Settings › Filters opens sits over it. */}
      {filterEditor && (
        <LazyDialog
          title="Couldn't open the filter editor"
          loadingTitle="Opening the filter editor…"
          onClose={useFilterEditorStore.getState().close}
        >
          <FilterEditorHost />
        </LazyDialog>
      )}
      {stats && (
        <LazyDialog
          title="Couldn't open statistics"
          loadingTitle="Opening Stats…"
          onClose={closeStats}
        >
          <Stats />
        </LazyDialog>
      )}
      {theme && (
        <LazyDialog
          title="Couldn't open the theme editor"
          loadingTitle="Opening the theme editor…"
          onClose={closeThemeEditor}
        >
          <ThemeEditorHost />
        </LazyDialog>
      )}
      {attachment && (
        <LazyDialog
          title="Couldn't preview the attachment"
          loadingTitle="Opening the preview…"
          onClose={closePreview}
        >
          <AttachmentPreview />
        </LazyDialog>
      )}
      {mod && (
        <ErrorBoundary
          key={mod}
          title="Couldn't open the mod panel"
          onClose={() => useModStore.getState().openPanel(null)}
        >
          <ModPanel />
        </ErrorBoundary>
      )}
    </>
  );
}

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
        listen(SYNC_EVENTS.outboxRejected, ({ payload }) =>
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
    const ids = accountIds ? accountIds.split("\n") : [];
    void useLabelStore.getState().load(ids);
    void useInboxTabs.getState().load(ids);
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
  useUsageTracking();

  const mode = useCalendarStore((s) => s.mode);

  return (
    <>
      <div className="tasks-frame" data-mode={mode}>
        {mode === "calendar" ? (
          <ErrorBoundary
            title="Couldn't open Calendar"
            className="tasks-frame__surface"
            recovery={{
              label: "Back to Mail",
              run: () => useCalendarStore.getState().setMode("mail"),
            }}
          >
            <Suspense
              fallback={
                <div className="tasks-frame__surface" role="status" aria-label="Loading Calendar" />
              }
            >
              <CalendarScreen onAddAccount={onAddAccount} />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <AppShell onAddAccount={onAddAccount} />
        )}
        <TasksPanelHost />
      </div>
      <ComposeHost />
      <CommandPalette />
      <SecondarySurfaces onAddAccount={onAddAccount} />
      <AddFromFileHost />
      <PersonHost />
      <ContextMenuHost />
      <SpeedReaderHost />
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
    scope.add((signal) => useDownloadStore.getState().subscribe(signal)).catch(log);
    return scope.dispose;
  }, []);
}

function App() {
  useModEvents();
  // Not the whole store: sync errors and progress change it, and this re-renders the entire app.
  const { accounts, loaded, error, load, upsert, reconnecting, reconnect } = useAccountStore(
    useShallow(({ accounts, loaded, error, load, upsert, reconnecting, reconnect }) => ({
      accounts,
      loaded,
      error,
      load,
      upsert,
      reconnecting,
      reconnect,
    })),
  );
  const reconnectAccount = accounts.find((a) => a.id === reconnecting);
  const [adding, setAdding] = useState<false | "account" | "guide">(false);
  const showMail = useCallback(() => setAdding(false), []);
  useDesktopEvents(loaded && accounts.length > 0, showMail);
  // Onboarding opens over the mail screen; the settings dialog closes so the two don't stack.
  const addAccount = () => {
    useSettingsStore.getState().close();
    setAdding("account");
  };

  // Settings › About and the palette's "Open setup guide" open onboarding at the guide's first step.
  useEffect(
    () =>
      useSetupGuide.subscribe((state, prev) => {
        if (state.requested !== prev.requested) {
          useSettingsStore.getState().close();
          setAdding("guide");
        }
      }),
    [],
  );

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
  } else if (loaded) {
    const onboarding = (
      <Onboarding
        key={reconnectAccount?.id ?? (adding === "guide" ? "guide" : "add")}
        accounts={accounts}
        reconnect={reconnectAccount}
        tutorial={adding === "guide"}
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
    // First run, setup is the whole window; after that it's a dialog over the mail screen.
    screen =
      accounts.length === 0 ? (
        onboarding
      ) : (
        <>
          <MailScreen onAddAccount={addAccount} />
          {(adding || reconnectAccount) && onboarding}
        </>
      );
  }
  return <ToastProvider pinned={<CornerNotices />}>{screen}</ToastProvider>;
}

export default function AppRoot() {
  return (
    <ErrorBoundary title="Pheeme stopped unexpectedly" reloadOnly>
      <App />
    </ErrorBoundary>
  );
}
