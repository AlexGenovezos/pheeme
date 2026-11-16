// Moving conversations between the inbox's category tabs, with the sender rules that can be saved alongside.
import {
  type InboxThread,
  type SavedRules,
  type ThreadSummary,
  undoSenderRules,
} from "../lib/tauri";
import { applyChange, mail, modify, present, ui, withLabels } from "./change";
import { perKeyInverse } from "./labelActions";
import { CATEGORIES, type ThreadKey, threadKey } from "./mailboxes";

const CATEGORY_IDS = CATEGORIES.map((c) => c.labelId);
const isCategory = (id: string) => CATEGORY_IDS.includes(id);

/** The inbox category tab being shown, if any. */
export const shownCategory = (): string | null =>
  mail().query?.search ? null : (ui().mailbox.category ?? null);

/** A row's system labels with `add` added and `remove` removed, sorted like the backend's. */
const withSystemLabels = (t: ThreadSummary, add: string[], remove: string[]): ThreadSummary => ({
  ...t,
  systemLabelIds: [
    ...new Set([...t.systemLabelIds.filter((id) => !remove.includes(id)), ...add]),
  ].sort(),
});

export interface CategoryMoveOptions {
  /** More of the account's inbox conversations to move with them (a sender's other mail), with their categories. */
  extra?: InboxThread[];
  /** Sender rules being saved with the move; Undo takes back what they changed. */
  rules?: Promise<SavedRules | null>;
  /** A line under the toast's title. */
  note?: string;
}

/**
 * Moves the targets of `accountId` to inbox `category` (a `CATEGORY_*` id): adds it and `INBOX`, removes the other
 * categories. They leave the list when another category tab is shown. Undo restores each conversation's own
 * categories and inbox state, then any sender rules saved with the move. Resolves to whether the move went through.
 */
export async function moveToCategory(
  accountId: string,
  keys: ThreadKey[],
  category: string,
  { extra = [], rules, note }: CategoryMoveOptions = {},
): Promise<boolean> {
  const prior = new Map<ThreadKey, { categories: string[]; inbox: boolean }>();
  for (const { key, thread } of present(keys)) {
    if (thread.accountId !== accountId) continue;
    const ids = thread.systemLabelIds;
    prior.set(key, { categories: ids.filter(isCategory), inbox: ids.includes("INBOX") });
  }
  for (const t of extra) {
    const key = threadKey(accountId, t.threadId);
    if (!prior.has(key)) prior.set(key, { categories: t.categories, inbox: true });
  }
  if (prior.size === 0) return false;
  const add = [category, "INBOX"];
  const remove = CATEGORY_IDS.filter((id) => id !== category);
  const shown = shownCategory();
  const undoOf = (key: ThreadKey) => {
    const before = prior.get(key) ?? { categories: [], inbox: true };
    return {
      add: before.categories.filter((id) => id !== category),
      remove: [
        ...(before.categories.includes(category) ? [] : [category]),
        ...(before.inbox ? [] : ["INBOX"]),
      ],
    };
  };
  const inverse = perKeyInverse(undoOf, withSystemLabels, async (account) => {
    const saved = await rules;
    if (saved && saved.created.length + saved.replaced.length > 0)
      await undoSenderRules(account, saved);
  });
  const name = CATEGORIES.find((c) => c.labelId === category)?.name ?? "Inbox";
  return applyChange(
    [...prior.keys()],
    modify(add, remove, {
      leavesList: shown !== null && shown !== category,
      patch: (t) => withSystemLabels(t, add, remove),
      detail: withLabels(add, remove),
    }),
    { announce: { title: `Moved to "${name}"`, undo: inverse, note }, evenIfGone: true },
  );
}
