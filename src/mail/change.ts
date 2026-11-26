// What every mail action shares: a change to some conversations (`Change`), `apply` to show it at once and send it,
// the targets it acts on, and opening a conversation. Mutations are optimistic in two layers (Builder's call 6): the
// list is patched or pruned synchronously, then the command updates the cache and the resulting
// `sync:messages_updated` reload confirms it. A rejection toasts the error and reloads from the cache, which still
// holds whatever Gmail refused.
//
// Opening a conversation lives here, not with the other navigation, because `applyChange` opens the next
// conversation when one leaves the list and drops a pending automatic read, so the two share `autoReads`.
import { toast, toastError } from "../components/ui/Toast";
import { modifyThreads, type ThreadDetail, type ThreadSummary } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { type UnreadCountChange, useLabelStore } from "../store/labelStore";
import { useMailStore } from "../store/mailStore";
import { useThreadStore } from "../store/threadStore";
import { focusedThread, useUiStore } from "../store/uiStore";
import { CATEGORIES, parseThreadKey, type ThreadKey, threadKey } from "./mailboxes";
import { OptimisticOp } from "./optimistic";
import { setTravelDirection } from "./preload";

export const mail = () => useMailStore.getState();
export const ui = () => useUiStore.getState();
export const keyOf = (t: ThreadSummary) => threadKey(t.accountId, t.id);

/** A change to some conversations: what the list shows right away, and how it reaches Gmail. */
export interface Change {
  read?: boolean;
  /** Rewrites the rows immediately. */
  patch?: (thread: ThreadSummary) => ThreadSummary;
  /** The change takes the rows out of the mailbox being shown. */
  leavesList: boolean;
  /** Rewrites the cached conversation (its label chips) immediately. */
  detail?: (detail: ThreadDetail) => ThreadDetail;
  send(accountId: string, threadIds: string[]): Promise<void>;
}

export const modify = (
  add: string[],
  remove: string[],
  {
    patch,
    leavesList = false,
    detail,
  }: { patch?: Change["patch"]; leavesList?: boolean; detail?: Change["detail"] } = {},
): Change => ({
  patch,
  leavesList,
  detail,
  send: (accountId, ids) => modifyThreads(accountId, ids, add, remove),
});

/**
 * The checked conversations, else the focused one (the open one, or with the reading pane off, the highlighted row).
 * Keys may have left the list since; mutating actions skip those.
 */
export function targetsOf(checked: ThreadKey[], focused: ThreadKey | null): ThreadKey[] {
  if (checked.length > 0) return checked;
  return focused === null ? [] : [focused];
}

export function targets(): ThreadKey[] {
  return targetsOf(ui().checked, focusedThread(ui()));
}

/** `keys` (default: the targets) that are still in the list, once each, with their rows. */
export function present(
  keys: ThreadKey[] | undefined,
  threads = mail().threads,
): Array<{ key: ThreadKey; thread: ThreadSummary }> {
  const wanted = new Set(keys ?? targets());
  if (wanted.size === 0) return [];
  const found = new Map<ThreadKey, ThreadSummary>();
  for (const thread of threads) {
    const key = keyOf(thread);
    if (wanted.has(key)) found.set(key, thread);
    if (found.size === wanted.size) break;
  }
  return [...wanted].flatMap((key) => {
    const thread = found.get(key);
    return thread ? [{ key, thread }] : [];
  });
}

/** One entry per account: Gmail ids are per account, and so is the command. */
function byAccount(keys: ThreadKey[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const { accountId, threadId } = parseThreadKey(key);
    groups.set(accountId, [...(groups.get(accountId) ?? []), threadId]);
  }
  return groups;
}

const keysOf = (groups: Map<string, string[]>): ThreadKey[] =>
  [...groups].flatMap(([accountId, ids]) => ids.map((id) => threadKey(accountId, id)));

function reloadLists() {
  void mail().reload(true);
  void useLabelStore.getState().load(useAccountStore.getState().accounts.map((a) => a.id));
}

/** Forget cached details that an optimistic change touched, and refetch the open one so its pane isn't left blank. */
function refreshDetails(groups: Map<string, string[]>) {
  const threads = useThreadStore.getState();
  for (const [accountId, ids] of groups) threads.evict(accountId, ids);
  const open = ui().openThread;
  if (open !== null && keysOf(groups).includes(open)) void threads.load(open);
}

/**
 * Send `change`, one call per account. Each account's pending changes are released as soon as its own command
 * settles, so one slow account can't hold back (or resurrect) the optimistic state of another. A rejection toasts its
 * message and reloads, which puts back the rows of the account whose change never reached the cache and leaves the
 * others as they are. Resolves to the groups that went through.
 */
async function send(
  groups: Map<string, string[]>,
  change: Change,
  op: OptimisticOp,
): Promise<Map<string, string[]>> {
  const done = new Map<string, string[]>();
  await Promise.all(
    [...groups].map(async ([accountId, ids]) => {
      let failure: { reason: unknown } | null = null;
      try {
        await change.send(accountId, ids);
        done.set(accountId, ids);
      } catch (reason) {
        failure = { reason };
      }
      op.settle(
        ids.map((id) => threadKey(accountId, id)),
        failure !== null,
      );
      if (failure) {
        toastError(failure.reason);
        if (change.detail) refreshDetails(new Map([[accountId, ids]]));
        reloadLists();
      }
    }),
  );
  return done;
}

/** Membership we already know, so count updates never wait for a detail/body request. */
function unreadCountChange(thread: ThreadSummary, read: boolean): UnreadCountChange {
  const detail = useThreadStore.getState().details.get(keyOf(thread));
  const labels = new Set(
    detail?.messages.flatMap((m) =>
      m.labelIds.includes("TRASH")
        ? ["TRASH"]
        : m.labelIds.includes("SPAM")
          ? ["SPAM"]
          : m.labelIds,
    ),
  );
  const query = mail().loadedQuery ?? mail().query;
  if (query && !query.search && query.accountIds.includes(thread.accountId)) {
    labels.add(query.labelId);
    if (query.alsoLabelId) labels.add(query.alsoLabelId);
  }
  if (thread.starred) labels.add("STARRED");
  const categories = labels.has("INBOX")
    ? CATEGORIES.filter((c) => c.labelId !== "CATEGORY_PERSONAL" && labels.has(c.labelId)).map(
        (c) => c.labelId,
      )
    : [];
  // Primary is the inbox minus the other four categories, including accounts with no category labels.
  if (labels.has("INBOX") && categories.length === 0 && (detail || labels.has("CATEGORY_PERSONAL")))
    categories.push("CATEGORY_PERSONAL");
  if (labels.has("INBOX")) categories.push("INBOX");
  if (!labels.has("SPAM") && !labels.has("TRASH") && (detail || labels.has("INBOX")))
    labels.add("ALL");
  return {
    accountId: thread.accountId,
    delta: read ? -1 : 1,
    labelIds: [...labels].filter((id) => id !== "UNREAD"),
    categoryIds: categories,
  };
}

function patchUnread(op: OptimisticOp, rows: ThreadSummary[], change: Change) {
  const { read } = change;
  if (read === undefined) return;
  op.unread(rows.filter((t) => t.unread === read).map((t) => unreadCountChange(t, read)));
}

/** Where `open` (the open thread or the highlight) goes when `removed` leave the list: the next row, else the one above, else nothing. `undefined` if it stays. */
function nextAfter(open: ThreadKey | null, removed: Set<ThreadKey>): ThreadKey | null | undefined {
  if (open === null || !removed.has(open)) return undefined;
  const keys = mail().threads.map(keyOf);
  const at = keys.indexOf(open);
  if (at < 0) return undefined; // not in the list: stays open
  const below = keys.slice(at + 1).find((k) => !removed.has(k));
  if (below !== undefined) return below;
  return (
    keys
      .slice(0, Math.max(at, 0))
      .reverse()
      .find((k) => !removed.has(k)) ?? null
  );
}

interface ApplyOptions {
  /**
   * Toast shown once the change went through; `undo` adds an Undo button that sends the inverse, `note` a line
   * under the title.
   */
  announce?: { title: string; undo?: Change; note?: string };
  /** Hold the command (not the list change) until this resolves; `false` drops it and reloads the list. */
  after?: Promise<boolean>;
  /** An explicit read, unread, archive or delete: a pending automatic read of these conversations is dropped. */
  cancelsAutoRead?: boolean;
  /**
   * Act on `keys` even where they have left the list: an open picker keeps acting on the conversations it was
   * opened for after one of its own changes took them out of the mailbox.
   */
  evenIfGone?: boolean;
}

export function apply(
  keys: ThreadKey[] | undefined,
  change: Change,
  options?: ApplyOptions,
): Promise<void> {
  return applyChange(keys, change, options).then(() => undefined);
}

/** `apply`, resolving to whether the change went through (for at least one account). */
export function applyChange(
  keys: ThreadKey[] | undefined,
  change: Change,
  { announce, after, cancelsAutoRead, evenIfGone }: ApplyOptions = {},
): Promise<boolean> {
  const rows = present(keys);
  const rowKeys = evenIfGone && keys ? [...new Set(keys)] : rows.map((r) => r.key);
  if (rowKeys.length === 0) return Promise.resolve(false);
  if (cancelsAutoRead) rowKeys.forEach((k) => autoReads.delete(k));
  const groups = byAccount(rowKeys);
  const op = new OptimisticOp(rowKeys);

  // Everything up to the command runs before the first await, so the list answers at once.
  // A change can do both: the flag change follows the conversation into other mailboxes, the removal is scoped to this one.
  patchUnread(
    op,
    rows.map((r) => r.thread),
    change,
  );
  if (change.patch) op.rows(change.patch);
  if (change.leavesList) {
    const removed = new Set(rowKeys);
    const next = nextAfter(ui().openThread, removed);
    const nextCursor = nextAfter(ui().cursor, removed);
    op.remove();
    // Rows that leave are unchecked; a change that keeps them in the list keeps the selection, so the same
    // conversations can be acted on again (mark read, then archive).
    ui().uncheck(rowKeys);
    if (next === null) ui().setOpenThread(null);
    else if (next !== undefined) openAndMarkRead(next);
    if (nextCursor !== undefined) ui().setCursor(nextCursor);
  }
  if (change.detail) op.detail(change.detail);

  const go = () => send(groups, change, op);
  const drop = () => {
    op.settle(rowKeys, true);
    void mail().reload(true); // the patched rows go back to what the cache says
    return new Map<string, string[]>();
  };
  return (after ? after.then((wanted) => (wanted ? go() : drop()), go) : go()).then((done) => {
    if (!announce || done.size === 0) return done.size > 0;
    const count = keysOf(done).length;
    const { undo, note } = announce;
    const description = [count > 1 ? `${count} conversations` : "", note ?? ""]
      .filter(Boolean)
      .join(" · ");
    toast({
      title: announce.title,
      description: description || undefined,
      duration: undo ? 6000 : undefined,
      action: undo && { label: "Undo", run: () => void revert(done, change, undo) },
    });
    return true;
  });
}

async function revert(done: Map<string, string[]>, original: Change, inverse: Change) {
  const keys = keysOf(done);
  const op = new OptimisticOp(keys);
  patchUnread(
    op,
    present(keys).map((r) => r.thread),
    inverse,
  );
  if (inverse.patch) op.rows(inverse.patch);
  if (inverse.leavesList) op.remove();
  await send(done, inverse, op);
  // Rows the change had taken out of the list can only come back from the cache.
  if (original.leavesList) await mail().reload(true);
}

// Archive and its kin only leave the list when the list is the inbox (a label view or All Mail keeps them).
export const inMailbox = (labelId: string) =>
  !mail().query?.search && ui().mailbox.labelId === labelId;
export const inInbox = () => inMailbox("INBOX");

export const readChange = (read: boolean): Change => ({
  ...modify(read ? [] : ["UNREAD"], read ? ["UNREAD"] : [], {
    patch: (t) => ({ ...t, unread: !read }),
  }),
  read,
});

/** The conversation as it will be once `labelId` is added to, or removed from, every message. */
export const withLabel =
  (labelId: string, add: boolean) =>
  (detail: ThreadDetail): ThreadDetail => ({
    ...detail,
    messages: detail.messages.map((m) => ({
      ...m,
      labelIds: add
        ? m.labelIds.includes(labelId)
          ? m.labelIds
          : [...m.labelIds, labelId]
        : m.labelIds.filter((id) => id !== labelId),
    })),
  });

/** The conversation with `add` added to and `remove` removed from every message. */
export const withLabels =
  (add: string[], remove: string[]) =>
  (detail: ThreadDetail): ThreadDetail =>
    remove.reduce(
      (d, id) => withLabel(id, false)(d),
      add.reduce((d, id) => withLabel(id, true)(d), detail),
    );

/** Automatic mark-reads waiting for their conversation's detail. An explicit change to the conversation drops one. */
const autoReads = new Map<ThreadKey, object>();

/**
 * Show a conversation. Opening it marks it read (Builder's call 7), quietly and once. The row turns read at once, but
 * the command waits until the conversation's detail is cached: answered after the change, every message would
 * arrive read and the view couldn't tell which ones to expand. If the detail can't be cached (the request failed,
 * or kept being superseded), or the user marks it unread (or archives or deletes it) in the meantime, the automatic
 * read is dropped rather than sent.
 *
 * `unread`: the caller knows the conversation was unread though its row may not be listed yet (a notification click
 * switches mailbox and opens it at once). The detail then decides: it is marked read only if a message is still
 * unread, and the row shows read whenever the list loads it.
 */
export function openAndMarkRead(
  key: ThreadKey,
  direction: 1 | -1 = 1,
  { unread = false }: { unread?: boolean } = {},
): void {
  // Ask for it before the preload window moves, so preloads queue behind it.
  void useThreadStore.getState().load(key);
  setTravelDirection(direction);
  ui().setOpenThread(key);
  const row = present([key])[0];
  if (!row?.thread.unread && !unread) return;
  const ticket = {};
  autoReads.set(key, ticket);
  const wanted = useThreadStore
    .getState()
    .waitForDetail(key)
    .then((cached) => {
      const current = autoReads.get(key) === ticket;
      if (current) autoReads.delete(key);
      // Without the detail on screen there is nothing to protect the expansion with, so no automatic read.
      if (!cached || !current) return false;
      if (row?.thread.unread) return true;
      const detail = useThreadStore.getState().details.get(key);
      return !!detail?.messages.some((m) => m.labelIds.includes("UNREAD"));
    });
  void apply([key], readChange(true), { after: wanted, evenIfGone: !row });
}
