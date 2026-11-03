// UI state: pane layout (persisted), active mailbox, selected thread.
import { create } from "zustand";

/** Pane geometry in CSS px. The shell writes these into CSS variables. */
export const PANE = {
  sidebarDefault: 220,
  sidebarMin: 180,
  sidebarMax: 320,
  listDefault: 380,
  listMin: 280,
  viewMin: 400,
} as const;

export const LAYOUT_KEY = "pheeme.layout";

export interface PaneLayout {
  sidebarWidth: number;
  listWidth: number;
  sidebarCollapsed: boolean;
}

const DEFAULT_LAYOUT: PaneLayout = {
  sidebarWidth: PANE.sidebarDefault,
  listWidth: PANE.listDefault,
  sidebarCollapsed: false,
};

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), Math.max(min, max));

export const clampSidebar = (w: number) => Math.round(clamp(w, PANE.sidebarMin, PANE.sidebarMax));

/** `available` is the shell width minus the sidebar; unknown (0) means no upper bound. */
export const clampList = (w: number, available = 0) =>
  Math.round(clamp(w, PANE.listMin, available > 0 ? available - PANE.viewMin : Infinity));

export function readLayout(
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): PaneLayout {
  try {
    const raw = JSON.parse(storage?.getItem(LAYOUT_KEY) ?? "null") as Partial<PaneLayout> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_LAYOUT;
    return {
      sidebarWidth:
        typeof raw.sidebarWidth === "number"
          ? clampSidebar(raw.sidebarWidth)
          : DEFAULT_LAYOUT.sidebarWidth,
      listWidth:
        typeof raw.listWidth === "number" ? clampList(raw.listWidth) : DEFAULT_LAYOUT.listWidth,
      sidebarCollapsed: raw.sidebarCollapsed === true,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function writeLayout(layout: PaneLayout) {
  try {
    safeStorage()?.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Storage unavailable: layout resets next launch, nothing else breaks.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

interface UiState extends PaneLayout {
  activeMailbox: string;
  selectedThreadId: string | null;
  setSidebarWidth(width: number): void;
  setListWidth(width: number, available?: number): void;
  resetSidebarWidth(): void;
  resetListWidth(): void;
  toggleSidebar(): void;
  setActiveMailbox(id: string): void;
  selectThread(id: string | null): void;
}

const layoutOf = (s: PaneLayout): PaneLayout => ({
  sidebarWidth: s.sidebarWidth,
  listWidth: s.listWidth,
  sidebarCollapsed: s.sidebarCollapsed,
});

export const useUiStore = create<UiState>((set, get) => {
  const setLayout = (patch: Partial<PaneLayout>) => {
    set(patch);
    writeLayout(layoutOf(get()));
  };
  return {
    ...readLayout(),
    activeMailbox: "INBOX",
    selectedThreadId: null,
    setSidebarWidth: (w) => setLayout({ sidebarWidth: clampSidebar(w) }),
    setListWidth: (w, available) => setLayout({ listWidth: clampList(w, available) }),
    resetSidebarWidth: () => setLayout({ sidebarWidth: PANE.sidebarDefault }),
    resetListWidth: () => setLayout({ listWidth: PANE.listDefault }),
    toggleSidebar: () => setLayout({ sidebarCollapsed: !get().sidebarCollapsed }),
    setActiveMailbox: (id) => set({ activeMailbox: id, selectedThreadId: null }),
    selectThread: (id) => set({ selectedThreadId: id }),
  };
});

/** Test helper: reload layout from storage and reset navigation. */
export function __resetUiStoreForTests() {
  useUiStore.setState({ ...readLayout(), activeMailbox: "INBOX", selectedThreadId: null });
}
