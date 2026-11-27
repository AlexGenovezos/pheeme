// Which inbox tabs (Social, Promotions, Updates, Forums) each account hides. Primary is always shown.
import { create } from "zustand";
import { CATEGORIES, categoryMailbox, type MailboxRow } from "../mail/mailboxes";
import { getInboxTabs, setInboxTabs } from "../lib/tauri";
import { useMailStore } from "./mailStore";
import { useUiStore } from "./uiStore";

const PRIMARY = CATEGORIES[0].labelId;
/** The tabs that can be hidden, in sidebar order. */
const HIDEABLE = CATEGORIES.slice(1).map((c) => c.labelId);

interface InboxTabsState {
  /** Per account, the hidden tabs' label ids. */
  hidden: Record<string, string[]>;
  /** Read each account's hidden tabs; accounts not listed are dropped. */
  load(accountIds: string[]): Promise<void>;
  /** Hides or shows one tab: shown at once, saved, then replaced by what was saved. Rejects (after undoing) on failure. */
  setHidden(accountId: string, label: string, hidden: boolean): Promise<void>;
}

const NONE: string[] = [];

/** The latest `load`: an older one answering late changes nothing. */
let loads = 0;
/** Per account, how many toggles have started: only the latest one's answer (or failure) is applied. */
const toggles = new Map<string, number>();
/** Per account, the last write: the next waits for it, so they reach the backend in the order they were made. */
const writes = new Map<string, Promise<unknown>>();
/** Per account, the hidden tabs last read or saved, which a failed toggle goes back to. */
const confirmed = new Map<string, string[]>();

export const useInboxTabs = create<InboxTabsState>((set, get) => ({
  hidden: {},
  async load(accountIds) {
    const ticket = ++loads;
    const started = new Map(accountIds.map((id) => [id, toggles.get(id) ?? 0]));
    const writing = new Set(accountIds.filter((id) => writes.has(id)));
    const entries = await Promise.all(
      accountIds.map(async (id) => [id, await getInboxTabs(id).catch(() => null)] as const),
    );
    if (ticket !== loads) return;
    // Toggled, or saving, while this read was out: what it read may be older than what's shown and saved.
    const fresh = (id: string) =>
      (toggles.get(id) ?? 0) === started.get(id) && !writing.has(id) && !writes.has(id);
    for (const [id, tabs] of entries) if (tabs && fresh(id)) confirmed.set(id, tabs);
    set((state) => ({
      hidden: Object.fromEntries(
        entries.map(([id, tabs]) => [id, (fresh(id) && tabs) || state.hidden[id] || NONE]),
      ),
    }));
  },
  async setHidden(accountId, label, hidden) {
    const mine = (toggles.get(accountId) ?? 0) + 1;
    toggles.set(accountId, mine);
    const latest = () => toggles.get(accountId) === mine;
    const before = get().hidden[accountId] ?? NONE;
    if (!confirmed.has(accountId)) confirmed.set(accountId, before);
    const next = HIDEABLE.filter((l) => (l === label ? hidden : before.includes(l)));
    set((state) => ({ hidden: { ...state.hidden, [accountId]: next } }));
    if (hidden) {
      const { mailbox, setMailbox } = useUiStore.getState();
      if (mailbox.accountId === accountId && mailbox.category === label)
        setMailbox(categoryMailbox(accountId, PRIMARY));
    }
    const write = (writes.get(accountId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => setInboxTabs(accountId, next));
    writes.set(accountId, write);
    try {
      const saved = await write;
      confirmed.set(accountId, saved);
      // A later toggle is already shown, and its own answer comes after this one.
      if (latest()) set((state) => ({ hidden: { ...state.hidden, [accountId]: saved } }));
      // Primary gains or loses mail and the hidden tab's list changes, but no message event says so.
      const { mailbox } = useUiStore.getState();
      if (mailbox.accountId === accountId && mailbox.category)
        await useMailStore.getState().reload();
    } catch (error) {
      // Back to what was last saved: `before` may hold an earlier toggle that failed too.
      const kept = confirmed.get(accountId) ?? before;
      if (latest()) set((state) => ({ hidden: { ...state.hidden, [accountId]: kept } }));
      throw error;
    } finally {
      if (writes.get(accountId) === write) writes.delete(accountId);
    }
  },
}));

/** The account's tab rows: Primary and every tab it hasn't hidden. */
export function visibleCategories(accountId: string): MailboxRow[] {
  const hidden = useInboxTabs.getState().hidden[accountId] ?? NONE;
  return CATEGORIES.filter((c) => !hidden.includes(c.labelId));
}
