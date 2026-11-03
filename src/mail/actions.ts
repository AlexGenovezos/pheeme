// Every mail action, shared by buttons, context menus and keyboard shortcuts.
//
// Mutations are optimistic in two layers (Builder's call 6): the list is patched or pruned synchronously, then
// the command updates the cache and the resulting `sync:messages_updated` reload confirms it. A rejection toasts
// the error and reloads from the cache, which still holds whatever Gmail refused.
import { toast } from "../components/ui/Toast";
import { type ContextMenuItem, showContextMenu } from "../lib/contextMenu";
import { getThread, modifyThreads, type ThreadDetail, type ThreadSummary, toCommandError, trashThreads } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useLabelStore } from "../store/labelStore";
import { newOp, useMailStore } from "../store/mailStore";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { parseThreadKey, type ThreadKey, threadKey } from "./mailboxes";
import { rowId } from "./ThreadRow";

/** Reply, Reply all, Forward and Compose arrive with Phase 7. */
export const composeLater = () => toast({ title: "Compose arrives with Phase 7" });

const mail = () => useMailStore.getState();
const ui = () => useUiStore.getState();
const keyOf = (t: ThreadSummary) => threadKey(t.accountId, t.id);

/** A change to some conversations: what the list shows right away, and how it reaches Gmail. */
interface Change {
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
  { patch, leavesList = false, detail }: { patch?: Change["patch"]; leavesList?: boolean; detail?: Change["detail"] } = {},
): Change => ({ patch, leavesList, detail, send: (accountId, ids) => modifyThreads(accountId, ids, add, remove) });

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
  void mail().reload();
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
async function send(groups: Map<string, string[]>, change: Change, op: number): Promise<Map<string, string[]>> {
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
      mail().settle(op, keys);
      useThreadStore.getState().settleDetails(op, keys);
      if (failure) {
        toast({ title: toCommandError(failure.reason).message, tone: "danger" });
        if (change.detail) refreshDetails(new Map([[accountId, ids]]));
        reloadLists();
      }
    }),
  );
  return done;
}

/** Where the open thread goes when `removed` leave the list: the next row, else the one above, else nothing. `undefined` if it stays. */
function nextOpenAfter(removed: Set<ThreadKey>): ThreadKey | null | undefined {
  const open = ui().openThread;
  if (open === null || !removed.has(open)) return undefined;
  const keys = mail().threads.map(keyOf);
  const at = keys.indexOf(open);
  const below = keys.slice(at + 1).find((k) => !removed.has(k));
  if (below !== undefined) return below;
  return keys.slice(0, Math.max(at, 0)).reverse().find((k) => !removed.has(k)) ?? null;
}

interface ApplyOptions {
  /** Toast shown once the change went through; `undo` adds an Undo button that sends the inverse. */
  announce?: { title: string; undo?: Change };
  /** Opening a thread marks it read without disturbing the selection. */
  keepChecked?: boolean;
}

function apply(keys: ThreadKey[] | undefined, change: Change, { announce, keepChecked }: ApplyOptions = {}): Promise<void> {
  const rows = present(keys);
  if (rows.length === 0) return Promise.resolve();
  const rowKeys = rows.map((r) => r.key);
  const groups = byAccount(rowKeys);
  const op = newOp();

  // Everything up to the command runs before the first await, so the list answers at once.
  // A change can do both: the flag change follows the conversation into other mailboxes, the removal is scoped to this one.
  if (change.patch) mail().patch(rowKeys, change.patch, op);
  if (change.leavesList) {
    const next = nextOpenAfter(new Set(rowKeys));
    mail().remove(rowKeys, op);
    if (next === null) ui().setOpenThread(null);
    else if (next !== undefined) openAndMarkRead(next);
  }
  const patchDetail = change.detail;
  if (patchDetail) for (const key of rowKeys) useThreadStore.getState().patchDetail(key, patchDetail, op);
  if (!keepChecked) ui().clearChecked();

  return send(groups, change, op).then((done) => {
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
  if (inverse.patch) mail().patch(keys, inverse.patch, op);
  if (inverse.leavesList) mail().remove(keys, op);
  await send(done, inverse, op);
  // Rows the change had taken out of the list can only come back from the cache.
  if (original.leavesList) await mail().reload();
}

// Archive and its kin only leave the list when the list is the inbox (a label view or All Mail keeps them).
const inInbox = () => ui().mailbox.labelId === "INBOX";

export function archive(keys?: ThreadKey[]): Promise<void> {
  return apply(keys, modify([], ["INBOX"], { leavesList: inInbox() }), {
    announce: { title: "Archived", undo: modify(["INBOX"], []) },
  });
}

/** Moves to Trash. Gmail's outbox has no untrash yet, so there is no Undo. */
export function trash(keys?: ThreadKey[]): Promise<void> {
  if (ui().mailbox.labelId === "TRASH") {
    toast({ title: "Already in Trash" });
    return Promise.resolve();
  }
  return apply(
    keys,
    { leavesList: true, send: (accountId, ids) => trashThreads(accountId, ids) },
    { announce: { title: "Moved to Trash" } },
  );
}

export function setStarred(starred: boolean, keys?: ThreadKey[]): Promise<void> {
  // Unstarring in Starred takes the row out of the mailbox, like archiving in the inbox.
  const to = (value: boolean): Change =>
    modify(value ? ["STARRED"] : [], value ? [] : ["STARRED"], {
      patch: (t) => ({ ...t, starred: value }),
      leavesList: !value && ui().mailbox.labelId === "STARRED",
    });
  return apply(keys, to(starred), { announce: { title: starred ? "Starred" : "Removed star", undo: to(!starred) } });
}

/** Stars the targets unless the first one is starred already, in which case it unstars them all. */
export function toggleStar(keys?: ThreadKey[]): Promise<void> {
  const first = present(keys)[0];
  return first ? setStarred(!first.thread.starred, keys) : Promise.resolve();
}

export function setRead(read: boolean, keys?: ThreadKey[]): Promise<void> {
  return apply(keys, readChange(read), {
    announce: { title: read ? "Marked as read" : "Marked as unread", undo: readChange(!read) },
  });
}

const readChange = (read: boolean): Change =>
  modify(read ? [] : ["UNREAD"], read ? ["UNREAD"] : [], { patch: (t) => ({ ...t, unread: !read }) });

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
export async function toggleLabel(accountId: string, labelId: string, keys?: ThreadKey[]): Promise<void> {
  const rowKeys = present(keys)
    .map((r) => r.key)
    .filter((k) => parseThreadKey(k).accountId === accountId);
  if (rowKeys.length === 0) return;
  const add = !allHave(await labelsOf(rowKeys), labelId);
  // Removing a label in that label's own mailbox takes the row out of it.
  const leavesList = !add && ui().mailbox.labelId === labelId;
  await apply(rowKeys, modify(add ? [labelId] : [], add ? [] : [labelId], { leavesList, detail: withLabel(labelId, add) }));
}

/** Where the labels menu opens for the keyboard: under the open row, else near the top of the window. */
export function labelMenuAnchor(): { x: number; y: number } {
  const open = ui().openThread;
  const rect = open === null ? undefined : document.getElementById(rowId(open))?.getBoundingClientRect();
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

/** Show a conversation. Opening it marks it read (Builder's call 7), quietly and once. */
export function openAndMarkRead(key: ThreadKey): void {
  ui().setOpenThread(key);
  prefetchAround(key);
  const row = present([key])[0];
  if (row?.thread.unread) void apply([key], readChange(true), { keepChecked: true });
}

/** j / k and the arrow keys: open the next or previous row, or the first/last when none is open. */
export function moveSelection(delta: 1 | -1): void {
  const keys = mail().threads.map(keyOf);
  if (keys.length === 0) return;
  const open = ui().openThread;
  const at = open === null ? -1 : keys.indexOf(open);
  const to = at < 0 ? (delta === 1 ? 0 : keys.length - 1) : Math.min(Math.max(at + delta, 0), keys.length - 1);
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
