// UI state: pane layout and navigation preferences (persisted), current mailbox, open and checked threads.
import { create } from "zustand";
import { homeMailbox, type MailboxRef, parseThreadKey, type ThreadKey } from "../mail/mailboxes";

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

/** Navigation choices that survive a restart, stored beside the layout. */
export interface NavPrefs {
  /** The account whose Favorites and labels the sidebar shows; `null` means the first account. */
  activeAccountId: string | null;
  collapsedAccounts: string[];
}

export const DEFAULT_MAILBOX: MailboxRef = { accountId: null, labelId: "INBOX" };

const DEFAULT_LAYOUT: PaneLayout = {
  sidebarWidth: PANE.sidebarDefault,
  listWidth: PANE.listDefault,
  sidebarCollapsed: false,
};

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), Math.max(min, max));

export const clampSidebar = (w: number) => Math.round(clamp(w, PANE.sidebarMin, PANE.sidebarMax));

/** `available` is the shell width minus the sidebar; unknown (0) means no upper bound. */
export const clampList = (w: number, available = 0) =>
  Math.round(clamp(w, PANE.listMin, available > 0 ? available - PANE.viewMin : Infinity));

type Stored = Partial<Record<keyof PaneLayout | keyof NavPrefs, unknown>>;

function readStored(storage: Pick<Storage, "getItem"> | undefined): Stored | null {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(LAYOUT_KEY) ?? "null");
    return raw && typeof raw === "object" ? (raw as Stored) : null;
  } catch {
    return null;
  }
}

export function readLayout(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): PaneLayout {
  const raw = readStored(storage);
  if (!raw) return DEFAULT_LAYOUT;
  return {
    sidebarWidth: typeof raw.sidebarWidth === "number" ? clampSidebar(raw.sidebarWidth) : DEFAULT_LAYOUT.sidebarWidth,
    listWidth: typeof raw.listWidth === "number" ? clampList(raw.listWidth) : DEFAULT_LAYOUT.listWidth,
    sidebarCollapsed: raw.sidebarCollapsed === true,
  };
}

export function readNavPrefs(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): NavPrefs {
  const raw = readStored(storage);
  return {
    activeAccountId: typeof raw?.activeAccountId === "string" ? raw.activeAccountId : null,
    collapsedAccounts: Array.isArray(raw?.collapsedAccounts)
      ? raw.collapsedAccounts.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function writeStored(stored: PaneLayout & NavPrefs) {
  try {
    safeStorage()?.setItem(LAYOUT_KEY, JSON.stringify(stored));
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

interface UiState extends PaneLayout, NavPrefs {
  mailbox: MailboxRef;
  /** The conversation shown in the reading pane. */
  openThread: ThreadKey | null;
  /** Multi-selection, in the order it was checked. */
  checked: ThreadKey[];
  /** Where a shift-click range starts: the last row toggled or range-started. */
  anchor: ThreadKey | null;
  setSidebarWidth(width: number): void;
  setListWidth(width: number, available?: number): void;
  resetSidebarWidth(): void;
  resetListWidth(): void;
  toggleSidebar(): void;
  /** Go to a mailbox: clears the open thread and selection. An account mailbox also becomes the active account. */
  setMailbox(ref: MailboxRef): void;
  setOpenThread(key: ThreadKey | null): void;
  toggleChecked(key: ThreadKey): void;
  /** Check every row from the anchor to `to` inclusive; `keys` is the list in display order. */
  checkRange(keys: ThreadKey[], to: ThreadKey): void;
  /** Check every row in `keys` (select all loaded rows). */
  checkAll(keys: ThreadKey[]): void;
  clearChecked(): void;
  toggleAccountCollapsed(accountId: string): void;
  /**
   * An account was removed: leave its mailbox for the home mailbox of the `remaining` accounts (All Inboxes, or the
   * last account's Primary), and drop its open and checked conversations and its stored navigation choices.
   */
  forgetAccount(accountId: string, remaining: { id: string }[]): void;
}

const persistedOf = (s: PaneLayout & NavPrefs): PaneLayout & NavPrefs => ({
  sidebarWidth: s.sidebarWidth,
  listWidth: s.listWidth,
  sidebarCollapsed: s.sidebarCollapsed,
  activeAccountId: s.activeAccountId,
  collapsedAccounts: s.collapsedAccounts,
});

const navReset = (): Pick<UiState, "mailbox" | "openThread" | "checked" | "anchor"> => ({
  mailbox: DEFAULT_MAILBOX,
  openThread: null,
  checked: [],
  anchor: null,
});

export const useUiStore = create<UiState>((set, get) => {
  /** Apply a change to persisted state and write it all back. */
  const persist = (patch: Partial<PaneLayout & NavPrefs>) => {
    set(patch);
    writeStored(persistedOf(get()));
  };
  return {
    ...readLayout(),
    ...readNavPrefs(),
    ...navReset(),
    setSidebarWidth: (w) => persist({ sidebarWidth: clampSidebar(w) }),
    setListWidth: (w, available) => persist({ listWidth: clampList(w, available) }),
    resetSidebarWidth: () => persist({ sidebarWidth: PANE.sidebarDefault }),
    resetListWidth: () => persist({ listWidth: PANE.listDefault }),
    toggleSidebar: () => persist({ sidebarCollapsed: !get().sidebarCollapsed }),
    setMailbox: (ref) => {
      set({ mailbox: ref, openThread: null, checked: [], anchor: null });
      if (ref.accountId !== null && ref.accountId !== get().activeAccountId) persist({ activeAccountId: ref.accountId });
    },
    setOpenThread: (key) => set({ openThread: key }),
    toggleChecked: (key) =>
      set((s) => ({
        checked: s.checked.includes(key) ? s.checked.filter((k) => k !== key) : [...s.checked, key],
        anchor: key,
      })),
    checkRange: (keys, to) =>
      set((s) => {
        const end = keys.indexOf(to);
        const start = s.anchor === null ? -1 : keys.indexOf(s.anchor);
        if (end === -1) return {};
        // No usable anchor (none yet, or it left the list): the range is just the target.
        const span = start === -1 ? [to] : keys.slice(Math.min(start, end), Math.max(start, end) + 1);
        const checked = [...s.checked, ...span.filter((k) => !s.checked.includes(k))];
        return { checked, anchor: start === -1 ? to : s.anchor };
      }),
    checkAll: (keys) => set({ checked: [...keys], anchor: keys[keys.length - 1] ?? null }),
    clearChecked: () => set({ checked: [], anchor: null }),
    forgetAccount: (id, remaining) => {
      const s = get();
      const ofAccount = (key: ThreadKey | null) => key !== null && parseThreadKey(key).accountId === id;
      if (s.mailbox.accountId === id) set({ ...navReset(), mailbox: homeMailbox(remaining) });
      else
        set({
          openThread: ofAccount(s.openThread) ? null : s.openThread,
          checked: s.checked.filter((k) => !ofAccount(k)),
          anchor: ofAccount(s.anchor) ? null : s.anchor,
        });
      persist({
        activeAccountId: s.activeAccountId === id ? null : s.activeAccountId,
        collapsedAccounts: s.collapsedAccounts.filter((a) => a !== id),
      });
    },
    toggleAccountCollapsed: (id) => {
      const { collapsedAccounts } = get();
      persist({
        collapsedAccounts: collapsedAccounts.includes(id)
          ? collapsedAccounts.filter((a) => a !== id)
          : [...collapsedAccounts, id],
      });
    },
  };
});

/** Test helper: reload persisted state from storage and reset navigation. */
export function __resetUiStoreForTests() {
  useUiStore.setState({ ...readLayout(), ...readNavPrefs(), ...navReset() });
}
