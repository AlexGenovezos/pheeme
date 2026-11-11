// UI state: pane layout and navigation preferences (persisted), current mailbox, open and checked threads.
import { create } from "zustand";
import {
  mailboxKey,
  homeMailbox,
  type MailboxRef,
  parseThreadKey,
  type ThreadKey,
} from "../mail/mailboxes";

/** Pane geometry in CSS px. The shell writes these into CSS variables. */
export const PANE = {
  sidebarDefault: 220,
  sidebarMin: 200,
  sidebarMax: 320,
  listDefault: 380,
  listMin: 280,
  viewMin: 400,
} as const;

export const LAYOUT_KEY = "pheeme.layout";

/** Comfortable shows sender, subject and snippet; compact drops the snippet. */
export type ListDensity = "comfortable" | "compact";

export interface PaneLayout {
  sidebarWidth: number;
  listWidth: number;
  sidebarCollapsed: boolean;
  listDensity: ListDensity;
  /** Off: no reading pane; a conversation opens in place of the list. */
  readingPane: boolean;
}

/** Navigation choices that survive a restart, stored beside the layout. */
export interface NavPrefs {
  /** The account whose Favorites and labels the sidebar shows; `null` means the first account. */
  activeAccountId: string | null;
  collapsedAccounts: string[];
  /** Per account, the label paths whose sublabels the sidebar folds away. */
  foldedLabels: Record<string, string[]>;
  /** Accounts whose Labels section has its More row (hidden labels) open. */
  labelsMoreOpen: string[];
}

export const DEFAULT_MAILBOX: MailboxRef = { accountId: null, labelId: "INBOX" };

const DEFAULT_LAYOUT: PaneLayout = {
  sidebarWidth: PANE.sidebarDefault,
  listWidth: PANE.listDefault,
  sidebarCollapsed: false,
  listDensity: "comfortable",
  readingPane: true,
};

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), Math.max(min, max));

export const clampSidebar = (w: number) => Math.round(clamp(w, PANE.sidebarMin, PANE.sidebarMax));

/** `available` is the shell width minus the sidebar; unknown (0) means no upper bound. */
export const clampList = (w: number, available = 0) =>
  Math.round(clamp(w, PANE.listMin, available > 0 ? available - PANE.viewMin : Infinity));

type Stored = Partial<Record<keyof PaneLayout | keyof NavPrefs | "mailbox", unknown>>;

function readStored(storage: Pick<Storage, "getItem"> | undefined): Stored | null {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(LAYOUT_KEY) ?? "null");
    return raw && typeof raw === "object" ? (raw as Stored) : null;
  } catch {
    return null;
  }
}

export function readLayout(
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): PaneLayout {
  const raw = readStored(storage);
  if (!raw) return DEFAULT_LAYOUT;
  return {
    sidebarWidth:
      typeof raw.sidebarWidth === "number"
        ? clampSidebar(raw.sidebarWidth)
        : DEFAULT_LAYOUT.sidebarWidth,
    listWidth:
      typeof raw.listWidth === "number" ? clampList(raw.listWidth) : DEFAULT_LAYOUT.listWidth,
    sidebarCollapsed: raw.sidebarCollapsed === true,
    listDensity: raw.listDensity === "compact" ? "compact" : "comfortable",
    readingPane: raw.readingPane !== false,
  };
}

const strings = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];

export function readNavPrefs(
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): NavPrefs {
  const raw = readStored(storage);
  const folded = raw?.foldedLabels;
  return {
    activeAccountId: typeof raw?.activeAccountId === "string" ? raw.activeAccountId : null,
    collapsedAccounts: strings(raw?.collapsedAccounts),
    foldedLabels:
      folded && typeof folded === "object" && !Array.isArray(folded)
        ? Object.fromEntries(Object.entries(folded).map(([id, paths]) => [id, strings(paths)]))
        : {},
    labelsMoreOpen: strings(raw?.labelsMoreOpen),
  };
}

/** The mailbox showing when the app last closed, so launch reopens it from the cache; All Inboxes if none or malformed. */
export function readLastMailbox(
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): MailboxRef {
  const raw = readStored(storage)?.mailbox;
  if (!raw || typeof raw !== "object") return DEFAULT_MAILBOX;
  const { accountId, labelId, category } = raw as Record<string, unknown>;
  if (accountId !== null && typeof accountId !== "string") return DEFAULT_MAILBOX;
  if (typeof labelId !== "string" || labelId === "") return DEFAULT_MAILBOX;
  if (category !== undefined && typeof category !== "string") return DEFAULT_MAILBOX;
  return category === undefined ? { accountId, labelId } : { accountId, labelId, category };
}

function writeStored(stored: Persisted) {
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
  searchText: string;
  searchAccountId: string | null;
  setSearch(text: string): void;
  setSearchAccount(accountId: string | null): void;
  /** Per-mailbox filters for this session only. */
  unreadMailboxes: Record<string, boolean>;
  toggleUnreadOnly(): void;
  /** The conversation shown in the reading pane. */
  openThread: ThreadKey | null;
  /**
   * With the reading pane off, the row highlighted in the list without being open: j/k and the arrows move it,
   * `o` opens it, and actions with nothing checked act on it. Unused while the reading pane is on.
   */
  cursor: ThreadKey | null;
  /** Multi-selection, in the order it was checked. */
  checked: ThreadKey[];
  /** Where a shift-click range starts: the last row toggled or range-started. */
  anchor: ThreadKey | null;
  setSidebarWidth(width: number): void;
  setListWidth(width: number, available?: number): void;
  resetSidebarWidth(): void;
  resetListWidth(): void;
  /** Show or hide the sidebar; with no room for it beside the content, open it over the content. */
  toggleSidebar(): void;
  /** The Show sidebar preference itself (Settings), apart from opening it over the content. */
  setSidebarCollapsed(collapsed: boolean): void;
  /** The window has no room for the sidebar beside the content (set by the shell on screen). */
  sidebarSqueezed: boolean;
  /** While squeezed: the sidebar is open over the content. */
  sidebarPeek: boolean;
  setSidebarSqueezed(squeezed: boolean): void;
  /** No room for the list beside the reading pane: one shows at a time, as with the reading pane off. */
  readingPaneSqueezed: boolean;
  setReadingPaneSqueezed(squeezed: boolean): void;
  setListDensity(density: ListDensity): void;
  setReadingPane(on: boolean): void;
  /** Go to a mailbox: clears the open thread, highlight and selection. An account mailbox also becomes the active account. */
  setMailbox(ref: MailboxRef): void;
  /** Show `accountId`'s Favorites and labels in the sidebar, leaving the mailbox as it is. */
  setActiveAccount(accountId: string): void;
  setOpenThread(key: ThreadKey | null): void;
  setCursor(key: ThreadKey | null): void;
  toggleChecked(key: ThreadKey): void;
  /** Check every row from the anchor to `to` inclusive; `keys` is the list in display order. */
  checkRange(keys: ThreadKey[], to: ThreadKey): void;
  /** Check every row in `keys` (select all loaded rows). */
  checkAll(keys: ThreadKey[]): void;
  clearChecked(): void;
  toggleAccountCollapsed(accountId: string): void;
  /** Fold or unfold a label's sublabels in the sidebar (`path` is the label's full name). */
  toggleLabelFold(accountId: string, path: string): void;
  toggleLabelsMore(accountId: string): void;
  /**
   * An account was removed: leave its mailbox for the home mailbox of the `remaining` accounts (All Inboxes, or the
   * last account's Primary), and drop its open and checked conversations and its stored navigation choices.
   */
  forgetAccount(accountId: string, remaining: { id: string }[]): void;
}

/**
 * The row the keyboard acts on: the open conversation, or with the reading pane off and nothing open, the
 * highlighted row.
 */
/**
 * How the sidebar shows: beside the content, hidden, or over the content (there's no room for it
 * beside the content, and it was opened). It never shrinks below its narrowest width.
 */
export const sidebarLayout = (
  s: Pick<UiState, "sidebarCollapsed" | "sidebarSqueezed" | "sidebarPeek">,
): "expanded" | "collapsed" | "overlay" =>
  s.sidebarCollapsed
    ? "collapsed"
    : !s.sidebarSqueezed
      ? "expanded"
      : s.sidebarPeek
        ? "overlay"
        : "collapsed";

/** The reading pane is on and there's room for it beside the list. */
export const readingPaneShown = (
  s: Pick<UiState, "readingPane" | "readingPaneSqueezed">,
): boolean => s.readingPane && !s.readingPaneSqueezed;

export const focusedThread = (
  s: Pick<UiState, "readingPane" | "readingPaneSqueezed" | "openThread" | "cursor">,
): ThreadKey | null => (readingPaneShown(s) || s.openThread !== null ? s.openThread : s.cursor);

type Persisted = PaneLayout & NavPrefs & Pick<UiState, "mailbox">;

const persistedOf = (s: Persisted): Persisted => ({
  mailbox: s.mailbox,
  sidebarWidth: s.sidebarWidth,
  listWidth: s.listWidth,
  sidebarCollapsed: s.sidebarCollapsed,
  listDensity: s.listDensity,
  readingPane: s.readingPane,
  activeAccountId: s.activeAccountId,
  collapsedAccounts: s.collapsedAccounts,
  foldedLabels: s.foldedLabels,
  labelsMoreOpen: s.labelsMoreOpen,
});

const navReset = (): Pick<UiState, "mailbox" | "openThread" | "cursor" | "checked" | "anchor"> => ({
  mailbox: DEFAULT_MAILBOX,
  openThread: null,
  cursor: null,
  checked: [],
  anchor: null,
});

export const useUiStore = create<UiState>((set, get) => {
  /** Apply a change to persisted state and write it all back. */
  const persist = (patch: Partial<Persisted>) => {
    set(patch);
    writeStored(persistedOf(get()));
  };
  return {
    unreadMailboxes: {},
    toggleUnreadOnly: () =>
      set((s) => ({
        unreadMailboxes: {
          ...s.unreadMailboxes,
          [mailboxKey(s.mailbox)]: !s.unreadMailboxes[mailboxKey(s.mailbox)],
        },
        checked: [],
        anchor: null,
        openThread: null,
        cursor: null,
      })),
    ...readLayout(),
    ...readNavPrefs(),
    ...navReset(),
    searchText: "",
    searchAccountId: null,
    setSearch: (text) =>
      set((s) => ({
        searchText: text,
        searchAccountId: s.searchText.trim() ? s.searchAccountId : s.mailbox.accountId,
        openThread: null,
        cursor: null,
        checked: [],
        anchor: null,
      })),
    setSearchAccount: (searchAccountId) =>
      set({ searchAccountId, openThread: null, cursor: null, checked: [], anchor: null }),
    mailbox: readLastMailbox(),
    setSidebarWidth: (w) => persist({ sidebarWidth: clampSidebar(w) }),
    setListWidth: (w, available) => persist({ listWidth: clampList(w, available) }),
    resetSidebarWidth: () => persist({ sidebarWidth: PANE.sidebarDefault }),
    resetListWidth: () => persist({ listWidth: PANE.listDefault }),
    toggleSidebar: () => {
      const s = get();
      if (!s.sidebarSqueezed) persist({ sidebarCollapsed: !s.sidebarCollapsed });
      else if (s.sidebarCollapsed) {
        persist({ sidebarCollapsed: false });
        set({ sidebarPeek: true });
      } else set({ sidebarPeek: !s.sidebarPeek });
    },
    setSidebarCollapsed: (sidebarCollapsed) => {
      persist({ sidebarCollapsed });
      set({ sidebarPeek: false });
    },
    sidebarSqueezed: false,
    sidebarPeek: false,
    readingPaneSqueezed: false,
    setReadingPaneSqueezed: (readingPaneSqueezed) => set({ readingPaneSqueezed }),
    setSidebarSqueezed: (squeezed) =>
      set((s) => ({ sidebarSqueezed: squeezed, sidebarPeek: squeezed && s.sidebarPeek })),
    setListDensity: (listDensity) => persist({ listDensity }),
    setReadingPane: (readingPane) => persist({ readingPane }),
    setMailbox: (ref) => {
      set({ searchText: "", openThread: null, cursor: null, checked: [], anchor: null });
      persist({
        mailbox: ref,
        ...(ref.accountId !== null && { activeAccountId: ref.accountId }),
      });
    },
    setActiveAccount: (accountId) => persist({ activeAccountId: accountId }),
    setOpenThread: (key) => set({ openThread: key }),
    setCursor: (key) => set({ cursor: key }),
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
        const span =
          start === -1 ? [to] : keys.slice(Math.min(start, end), Math.max(start, end) + 1);
        const checked = [...s.checked, ...span.filter((k) => !s.checked.includes(k))];
        return { checked, anchor: start === -1 ? to : s.anchor };
      }),
    checkAll: (keys) => set({ checked: [...keys], anchor: keys[keys.length - 1] ?? null }),
    clearChecked: () => set({ checked: [], anchor: null }),
    forgetAccount: (id, remaining) => {
      const s = get();
      if (s.searchAccountId === id) set({ searchText: "", searchAccountId: null });
      const ofAccount = (key: ThreadKey | null) =>
        key !== null && parseThreadKey(key).accountId === id;
      if (s.mailbox.accountId === id) set({ ...navReset(), mailbox: homeMailbox(remaining) });
      else
        set({
          openThread: ofAccount(s.openThread) ? null : s.openThread,
          cursor: ofAccount(s.cursor) ? null : s.cursor,
          checked: s.checked.filter((k) => !ofAccount(k)),
          anchor: ofAccount(s.anchor) ? null : s.anchor,
        });
      persist({
        activeAccountId: s.activeAccountId === id ? null : s.activeAccountId,
        collapsedAccounts: s.collapsedAccounts.filter((a) => a !== id),
        foldedLabels: Object.fromEntries(
          Object.entries(s.foldedLabels).filter(([account]) => account !== id),
        ),
        labelsMoreOpen: s.labelsMoreOpen.filter((a) => a !== id),
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
    toggleLabelFold: (id, path) => {
      const folded = get().foldedLabels[id] ?? [];
      persist({
        foldedLabels: {
          ...get().foldedLabels,
          [id]: folded.includes(path) ? folded.filter((p) => p !== path) : [...folded, path],
        },
      });
    },
    toggleLabelsMore: (id) => {
      const { labelsMoreOpen } = get();
      persist({
        labelsMoreOpen: labelsMoreOpen.includes(id)
          ? labelsMoreOpen.filter((a) => a !== id)
          : [...labelsMoreOpen, id],
      });
    },
  };
});

/** Test helper: reload persisted state from storage and reset navigation. */
export function __resetUiStoreForTests() {
  useUiStore.setState({
    readingPaneSqueezed: false,
    sidebarSqueezed: false,
    sidebarPeek: false,
    unreadMailboxes: {},
    ...readLayout(),
    ...readNavPrefs(),
    ...navReset(),
    searchText: "",
    searchAccountId: null,
    mailbox: readLastMailbox(),
  });
}
