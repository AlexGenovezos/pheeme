// Every mail action, shared by buttons, context menus and keyboard shortcuts.
//
// Mutations are optimistic in two layers (Builder's call 6): the list is patched or pruned synchronously, then
// the command updates the cache and the resulting `sync:messages_updated` reload confirms it. A rejection toasts
// the error and reloads from the cache, which still holds whatever Gmail refused.
import { useComposeStore } from "../compose/composeStore";
import { toast } from "../components/ui/Toast";
import { type ContextMenuItem, showContextMenu } from "../lib/contextMenu";
import {
  type ComposeMode,
  getThread,
  modifyThreads,
  type ThreadDetail,
  type ThreadSummary,
  toCommandError,
  trashThreads,
} from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { type UnreadCountChange, useLabelStore } from "../store/labelStore";
import { newOp, useMailStore } from "../store/mailStore";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import {
  CATEGORIES,
  parseThreadKey,
  resolveActiveAccount,
  type ThreadKey,
  threadKey,
} from "./mailboxes";
import { rowId } from "./ThreadRow";

/** The message a Reply, Reply all or Forward answers: the conversation's latest that isn't a draft. */
export function replyTarget(detail: ThreadDetail | undefined): string | null {
  const sent = detail?.messages.filter((m) => !m.labelIds.includes("DRAFT")) ?? [];
  return sent[sent.length - 1]?.id ?? null;
}

/** Reply, Reply all or Forward the open conversation, from the account it's in. */
export async function respond(mode: ComposeMode): Promise<void> {
  const key = ui().openThread;
  if (key === null) return;
  const { accountId } = parseThreadKey(key);
  const threads = useThreadStore.getState();
  if (!threads.details.has(key)) await threads.load(key);
  const messageId = replyTarget(useThreadStore.getState().details.get(key));
  if (!messageId) return;
  await useComposeStore.getState().respond(accountId, messageId, mode);
}

/** A new message, from the account the sidebar is showing (or the open conversation's). */
export function composeNew(): void {
  const { activeAccountId, mailbox, openThread } = ui();
  const accounts = useAccountStore.getState().accounts;
  const preferred =
    mailbox.accountId ??
    (openThread === null ? activeAccountId : parseThreadKey(openThread).accountId);
  const accountId = resolveActiveAccount(preferred, accounts);
  if (accountId) useComposeStore.getState().compose(accountId);
}

const mail = () => useMailStore.getState();
const ui = () => useUiStore.getState();
const keyOf = (t: ThreadSummary) => threadKey(t.accountId, t.id);

/** A change to some conversations: what the list shows right away, and how it reaches Gmail. */
interface Change {
  read?: boolean;
  /** Rewrites the rows immediately. */
  patch?: (thread: ThreadSummary) => ThreadSummary;
  /** The change takes the rows out of the mailbox being shown. */
  leavesList: boolean;
  /** Rewrites the cached conversation (its label chips) immediately. */
  detail?: (detail: ThreadDetail) => ThreadDetail;
  send(accountId: string, threadIds: string[]): Promise<void>;
}

const modify = (
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

/** The checked conversations, else the open one. Keys may have left the list since; mutating actions skip those. */
export function targetsOf(checked: ThreadKey[], openThread: ThreadKey | null): ThreadKey[] {
  if (checked.length > 0) return checked;
  return openThread === null ? [] : [openThread];
}

export function targets(): ThreadKey[] {
  const { checked, openThread } = ui();
  return targetsOf(checked, openThread);
}

/** `keys` (default: the targets) that are still in the list, once each, with their rows. */
function present(keys: ThreadKey[] | undefined): Array<{ key: ThreadKey; thread: ThreadSummary }> {
  const byKey = new Map(mail().threads.map((t) => [keyOf(t), t]));
  const seen = new Set<ThreadKey>();
  const rows: Array<{ key: ThreadKey; thread: ThreadSummary }> = [];
  for (const key of keys ?? targets()) {
    const thread = byKey.get(key);
    if (!thread || seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, thread });
  }
  return rows;
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
  op: number,
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
      const keys = ids.map((id) => threadKey(accountId, id));
      mail().settle(op, keys, failure !== null);
      useThreadStore.getState().settleDetails(op, keys);
      if (failure) {
        toast({ title: toCommandError(failure.reason).message, tone: "danger" });
        if (change.detail) refreshDetails(new Map([[accountId, ids]]));
        reloadLists();
      }
    }),
  );
  useLabelStore.getState().settleUnread(op);
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

function patchUnread(op: number, rows: ThreadSummary[], change: Change) {
  const { read } = change;
  if (read === undefined) return;
  useLabelStore.getState().patchUnread(
    op,
    rows.filter((t) => t.unread === read).map((t) => unreadCountChange(t, read)),
  );
}

/** Where the open thread goes when `removed` leave the list: the next row, else the one above, else nothing. `undefined` if it stays. */
function nextOpenAfter(removed: Set<ThreadKey>): ThreadKey | null | undefined {
  const open = ui().openThread;
  if (open === null || !removed.has(open)) return undefined;
  const keys = mail().threads.map(keyOf);
  const at = keys.indexOf(open);
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
  /** Toast shown once the change went through; `undo` adds an Undo button that sends the inverse. */
  announce?: { title: string; undo?: Change };
  /** Opening a thread marks it read without disturbing the selection. */
  keepChecked?: boolean;
  /** Hold the command (not the list change) until this resolves; `false` drops it and reloads the list. */
  after?: Promise<boolean>;
  /** An explicit read, unread, archive or delete: a pending automatic read of these conversations is dropped. */
  cancelsAutoRead?: boolean;
}

function apply(
  keys: ThreadKey[] | undefined,
  change: Change,
  { announce, keepChecked, after, cancelsAutoRead }: ApplyOptions = {},
): Promise<void> {
  const rows = present(keys);
  if (rows.length === 0) return Promise.resolve();
  const rowKeys = rows.map((r) => r.key);
  if (cancelsAutoRead) rowKeys.forEach((k) => autoReads.delete(k));
  const groups = byAccount(rowKeys);
  const op = newOp();

  // Everything up to the command runs before the first await, so the list answers at once.
  // A change can do both: the flag change follows the conversation into other mailboxes, the removal is scoped to this one.
  patchUnread(
    op,
    rows.map((r) => r.thread),
    change,
  );
  if (change.patch) mail().patch(rowKeys, change.patch, op);
  if (change.leavesList) {
    const next = nextOpenAfter(new Set(rowKeys));
    mail().remove(rowKeys, op);
    if (next === null) ui().setOpenThread(null);
    else if (next !== undefined) openAndMarkRead(next);
  }
  const patchDetail = change.detail;
  if (patchDetail)
    for (const key of rowKeys) useThreadStore.getState().patchDetail(key, patchDetail, op);
  if (!keepChecked) ui().clearChecked();

  const go = () => send(groups, change, op);
  const drop = () => {
    mail().settle(op, rowKeys, true);
    useThreadStore.getState().settleDetails(op, rowKeys);
    useLabelStore.getState().settleUnread(op);
    void mail().reload(true); // the patched rows go back to what the cache says
    return new Map<string, string[]>();
  };
  return (after ? after.then((wanted) => (wanted ? go() : drop()), go) : go()).then((done) => {
    if (!announce || done.size === 0) return;
    const count = keysOf(done).length;
    const { undo } = announce;
    toast({
      title: announce.title,
      description: count > 1 ? `${count} conversations` : undefined,
      duration: undo ? 6000 : undefined,
      action: undo && { label: "Undo", run: () => void revert(done, change, undo) },
    });
  });
}

async function revert(done: Map<string, string[]>, original: Change, inverse: Change) {
  const op = newOp();
  const keys = keysOf(done);
  patchUnread(
    op,
    present(keys).map((r) => r.thread),
    inverse,
  );
  if (inverse.patch) mail().patch(keys, inverse.patch, op);
  if (inverse.leavesList) mail().remove(keys, op);
  await send(done, inverse, op);
  // Rows the change had taken out of the list can only come back from the cache.
  if (original.leavesList) await mail().reload(true);
}

// Archive and its kin only leave the list when the list is the inbox (a label view or All Mail keeps them).
const inMailbox = (labelId: string) => !mail().query?.search && ui().mailbox.labelId === labelId;
const inInbox = () => inMailbox("INBOX");

export function archive(keys?: ThreadKey[]): Promise<void> {
  return apply(keys, modify([], ["INBOX"], { leavesList: inInbox() }), {
    announce: { title: "Archived", undo: modify(["INBOX"], []) },
    cancelsAutoRead: true,
  });
}

/** Moves to Trash. Gmail's outbox has no untrash yet, so there is no Undo. */
export function trash(keys?: ThreadKey[]): Promise<void> {
  if (inMailbox("TRASH")) {
    toast({ title: "Already in Trash" });
    return Promise.resolve();
  }
  return apply(
    keys,
    { leavesList: true, send: (accountId, ids) => trashThreads(accountId, ids) },
    { announce: { title: "Moved to Trash" }, cancelsAutoRead: true },
  );
}

export function setStarred(starred: boolean, keys?: ThreadKey[]): Promise<void> {
  // Unstarring in Starred takes the row out of the mailbox, like archiving in the inbox.
  const to = (value: boolean): Change =>
    modify(value ? ["STARRED"] : [], value ? [] : ["STARRED"], {
      patch: (t) => ({ ...t, starred: value }),
      leavesList: !value && inMailbox("STARRED"),
    });
  return apply(keys, to(starred), {
    announce: { title: starred ? "Starred" : "Removed star", undo: to(!starred) },
  });
}

/** Stars the targets unless the first one is starred already, in which case it unstars them all. */
export function toggleStar(keys?: ThreadKey[]): Promise<void> {
  const first = present(keys)[0];
  return first ? setStarred(!first.thread.starred, keys) : Promise.resolve();
}

export function setRead(read: boolean, keys?: ThreadKey[]): Promise<void> {
  return apply(keys, readChange(read), {
    announce: { title: read ? "Marked as read" : "Marked as unread", undo: readChange(!read) },
    cancelsAutoRead: true,
  });
}

const readChange = (read: boolean): Change => ({
  ...modify(read ? [] : ["UNREAD"], read ? ["UNREAD"] : [], {
    patch: (t) => ({ ...t, unread: !read }),
  }),
  read,
});

/**
 * The labels each of `keys` carries, from the cached detail or else straight from the backend. Read once per action
 * and kept out of the detail cache, whose 30 entries a larger selection would push each other out of.
 */
async function labelsOf(keys: ThreadKey[]): Promise<Map<ThreadKey, Set<string>>> {
  const cached = useThreadStore.getState().details;
  const entries = await Promise.all(
    keys.map(async (key): Promise<[ThreadKey, Set<string>]> => {
      let detail = cached.get(key);
      if (!detail) {
        const { accountId, threadId } = parseThreadKey(key);
        detail = await getThread(accountId, threadId).catch(() => undefined);
      }
      return [key, new Set(detail?.messages.flatMap((m) => m.labelIds))];
    }),
  );
  return new Map(entries);
}

const allHave = (membership: Map<ThreadKey, Set<string>>, labelId: string) =>
  [...membership.values()].every((labels) => labels.has(labelId));

/** The conversation as it will be once `labelId` is added to, or removed from, every message. */
const withLabel =
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

/** Adds `labelId` to the targets of `accountId`, or removes it if they all have it already. */
export async function toggleLabel(
  accountId: string,
  labelId: string,
  keys?: ThreadKey[],
): Promise<void> {
  const rowKeys = present(keys)
    .map((r) => r.key)
    .filter((k) => parseThreadKey(k).accountId === accountId);
  if (rowKeys.length === 0) return;
  const add = !allHave(await labelsOf(rowKeys), labelId);
  // Removing a label in that label's own mailbox takes the row out of it.
  const leavesList = !add && inMailbox(labelId);
  await apply(
    rowKeys,
    modify(add ? [labelId] : [], add ? [] : [labelId], {
      leavesList,
      detail: withLabel(labelId, add),
    }),
  );
}

/** Where the labels menu opens for the keyboard: under the open row, else near the top of the window. */
export function labelMenuAnchor(): { x: number; y: number } {
  const open = ui().openThread;
  const rect =
    open === null ? undefined : document.getElementById(rowId(open))?.getBoundingClientRect();
  if (rect && (rect.width > 0 || rect.height > 0)) return { x: rect.left + 48, y: rect.bottom };
  return { x: window.innerWidth / 2, y: window.innerHeight / 3 };
}

/** One checkable item per user label of the first target's account; choosing one toggles it on the targets of that account. */
export async function openLabelMenu(at: { x: number; y: number }): Promise<void> {
  const rows = present(undefined);
  if (rows.length === 0) return;
  const { accountId } = parseThreadKey(rows[0].key);
  const keys = rows.map((r) => r.key).filter((k) => parseThreadKey(k).accountId === accountId);
  const labels = useLabelStore.getState().userLabels(accountId);
  if (labels.length === 0) {
    toast({ title: "No labels yet", description: "Labels you create in Gmail show up here." });
    return;
  }
  const membership = await labelsOf(keys);
  const items: ContextMenuItem[] = labels.map((label) => ({
    id: label.id,
    label: label.name,
    checked: allHave(membership, label.id),
    onSelect: () => void toggleLabel(accountId, label.id, keys),
  }));
  await showContextMenu(items, at);
}

/** Warm the details of the rows above and below `key`, so the next j or k opens instantly (Builder's call 17). */
function prefetchAround(key: ThreadKey) {
  const keys = mail().threads.map(keyOf);
  const at = keys.indexOf(key);
  if (at < 0) return;
  const near = [keys[at - 1], keys[at + 1]].filter((k): k is ThreadKey => k !== undefined);
  if (near.length > 0) useThreadStore.getState().prefetch(near);
}

/** Automatic mark-reads waiting for their conversation's detail. An explicit change to the conversation drops one. */
const autoReads = new Map<ThreadKey, object>();

/**
 * Show a conversation. Opening it marks it read (Builder's call 7), quietly and once. The row turns read at once, but
 * the command waits until the conversation's detail is cached: answered after the change, every message would
 * arrive read and the view couldn't tell which ones to expand. If the detail can't be cached (the request failed,
 * or kept being superseded), or the user marks it unread (or archives or deletes it) in the meantime, the automatic
 * read is dropped rather than sent.
 */
export function openAndMarkRead(key: ThreadKey): void {
  ui().setOpenThread(key);
  const row = present([key])[0];
  if (row?.thread.unread) {
    const ticket = {};
    autoReads.set(key, ticket);
    const wanted = useThreadStore
      .getState()
      .waitForDetail(key)
      .then((cached) => {
        const current = autoReads.get(key) === ticket;
        if (current) autoReads.delete(key);
        // Without the detail on screen there is nothing to protect the expansion with, so no automatic read.
        return cached && current;
      });
    void apply([key], readChange(true), { keepChecked: true, after: wanted });
  }
  prefetchAround(key);
}

/** j / k and the arrow keys: open the next or previous row, or the first/last when none is open. */
export function moveSelection(delta: 1 | -1): void {
  const keys = mail().threads.map(keyOf);
  if (keys.length === 0) return;
  const open = ui().openThread;
  const at = open === null ? -1 : keys.indexOf(open);
  const to =
    at < 0
      ? delta === 1
        ? 0
        : keys.length - 1
      : Math.min(Math.max(at + delta, 0), keys.length - 1);
  if (to === at) return;
  openAndMarkRead(keys[to]);
}

/** `o` / Enter: open the focused conversation, or the first one when nothing is. */
export function openFocused(): void {
  const open = ui().openThread;
  const first = mail().threads[0];
  if (open !== null) openAndMarkRead(open);
  else if (first) openAndMarkRead(keyOf(first));
}
