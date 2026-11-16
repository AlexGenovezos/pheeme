// Feeds the anonymous usage tracker while the main window runs: the screens the stores show, the
// commands the registry hears (shortcuts, the palette, and clicks on `data-command` buttons), and
// whether anyone is there. Every `FLUSH_MS`, and when the window is hidden, the counts go to Rust,
// which keeps them only while usage stats are on.

import { useEffect } from "react";
import { useCalendarStore } from "../calendar/calendarStore";
import { useEditStore } from "../calendar/editStore";
import { useComposeStore } from "../compose/composeStore";
import { usePersonStore } from "../contacts/personStore";
import { registry as defaultRegistry, type CommandRegistry } from "../keyboard/registry";
import { usePreviewStore } from "../mail/preview/previewStore";
import { usePaletteStore } from "../palette/paletteStore";
import { recordUsage } from "../lib/tauri";
import { useSettingsStore } from "../settings/settingsStore";
import { useSpeedReader } from "../speedread/open";
import { useStatsStore } from "../stats/statsStore";
import { useUiStore } from "../store/uiStore";
import { useTasksStore } from "../tasks/tasksStore";
import { useThemeEditorStore } from "../theme/editor/editorStore";
import { currentScreens, type ScreenState } from "./screens";
import { commandName, createUsageTracker, onDiscard } from "./tracker";

export const FLUSH_MS = 5 * 60 * 1000;

function screenState(): ScreenState {
  const calendar = useCalendarStore.getState();
  const ui = useUiStore.getState();
  const settings = useSettingsStore.getState();
  return {
    mode: calendar.mode,
    view: calendar.view,
    mailbox: ui.mailbox,
    searchText: ui.searchText,
    conversationOpen: ui.openThread !== null,
    eventOpen: calendar.open !== null,
    eventEditorOpen: useEditStore.getState().editor !== null,
    emailPinned: calendar.pinned !== null,
    settingsPage: settings.open ? settings.page : null,
    statsOpen: useStatsStore.getState().open,
    paletteOpen: usePaletteStore.getState().open,
    composing: useComposeStore.getState().windows.length > 0,
    previewOpen: usePreviewStore.getState().session !== null,
    personOpen: usePersonStore.getState().open !== null,
    speedReading: useSpeedReader.getState().session !== null,
    tasksOpen: useTasksStore.getState().panelOpen,
    themeEditorOpen: useThemeEditorStore.getState().open,
  };
}

const STORES = [
  useCalendarStore,
  useUiStore,
  useSettingsStore,
  useEditStore,
  useStatsStore,
  usePaletteStore,
  useComposeStore,
  usePreviewStore,
  usePersonStore,
  useSpeedReader,
  useTasksStore,
  useThemeEditorStore,
];

/** The user's rebound shortcuts, by the names they're counted under. */
export function reboundShortcuts(overrides: Readonly<Record<string, string | null>>) {
  return Object.entries(overrides).flatMap(([id, key]) => {
    const name = commandName(id);
    return name && name !== "mod" ? [{ id: name, key }] : [];
  });
}

export function useUsageTracking(reg: CommandRegistry = defaultRegistry) {
  useEffect(() => {
    const tracker = createUsageTracker();
    const cleanups: Array<() => void> = [];

    let shown = "";
    const updateScreens = () => {
      const screens = currentScreens(screenState());
      const key = screens.join(" ");
      if (key === shown) return;
      shown = key;
      tracker.setScreens(screens);
    };
    updateScreens();
    for (const store of STORES) cleanups.push(store.subscribe(updateScreens));

    cleanups.push(reg.onRun((id, source) => tracker.command(id, source)));

    // A click on a button that stands for a command (`data-command`), whatever its handler does.
    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-command]");
      const id = el?.getAttribute("data-command");
      if (id) reg.noteRun(id, "button");
    };
    document.addEventListener("click", onClick, true);
    cleanups.push(() => document.removeEventListener("click", onClick, true));

    const onInput = () => tracker.input();
    const inputs = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const type of inputs) {
      window.addEventListener(type, onInput, { capture: true, passive: true });
      cleanups.push(() => window.removeEventListener(type, onInput, { capture: true }));
    }

    const flush = () => {
      const counts = tracker.take();
      const rebound = reboundShortcuts(reg.overrides());
      void recordUsage({ ...counts, rebound }).catch(() => {});
    };
    const attention = () => {
      const attentive = document.visibilityState === "visible" && document.hasFocus();
      tracker.setAttentive(attentive);
      if (document.visibilityState === "hidden") flush();
    };
    attention();
    for (const type of ["focus", "blur"] as const) {
      window.addEventListener(type, attention);
      cleanups.push(() => window.removeEventListener(type, attention));
    }
    document.addEventListener("visibilitychange", attention);
    cleanups.push(() => document.removeEventListener("visibilitychange", attention));

    const timer = setInterval(flush, FLUSH_MS);
    cleanups.push(() => clearInterval(timer));
    cleanups.push(onDiscard(() => void tracker.take()));

    return () => {
      cleanups.forEach((c) => c());
      flush();
    };
  }, [reg]);
}
