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

export const useInboxTabs = create<InboxTabsState>((set, get) => ({
  hidden: {},
  async load(accountIds) {
    const entries = await Promise.all(
      accountIds.map(async (id) => [id, await getInboxTabs(id).catch(() => null)] as const),
    );
    set((state) => ({
      hidden: Object.fromEntries(
        entries.map(([id, tabs]) => [id, tabs ?? state.hidden[id] ?? NONE]),
      ),
    }));
  },
  async setHidden(accountId, label, hidden) {
    const before = get().hidden[accountId] ?? NONE;
    const next = HIDEABLE.filter((l) => (l === label ? hidden : before.includes(l)));
    set((state) => ({ hidden: { ...state.hidden, [accountId]: next } }));
    if (hidden) {
      const { mailbox, setMailbox } = useUiStore.getState();
      if (mailbox.accountId === accountId && mailbox.category === label)
        setMailbox(categoryMailbox(accountId, PRIMARY));
    }
    try {
      const saved = await setInboxTabs(accountId, next);
      set((state) => ({ hidden: { ...state.hidden, [accountId]: saved } }));
      // Primary gains or loses mail and the hidden tab's list changes, but no message event says so.
      const { mailbox } = useUiStore.getState();
      if (mailbox.accountId === accountId && mailbox.category)
        await useMailStore.getState().reload();
    } catch (error) {
      set((state) => ({ hidden: { ...state.hidden, [accountId]: before } }));
      throw error;
    }
  },
}));

/** The account's tab rows: Primary and every tab it hasn't hidden. */
export function visibleCategories(accountId: string): MailboxRow[] {
  const hidden = useInboxTabs.getState().hidden[accountId] ?? NONE;
  return CATEGORIES.filter((c) => !hidden.includes(c.labelId));
}
