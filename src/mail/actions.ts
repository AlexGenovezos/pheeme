// Every mail action, shared by buttons, context menus and keyboard shortcuts.
//
// Mutations are optimistic in two layers (Builder's call 6): the list is patched or pruned synchronously, then
// the command updates the cache and the resulting `sync:messages_updated` reload confirms it. A rejection toasts
// the error and reloads from the cache, which still holds whatever Gmail refused.
import { useComposeStore } from "../compose/composeStore";
import { toast } from "../components/ui/Toast";
import { type Membership, usePickerStore } from "../labels/pickerStore";
import {
  type ComposeMode,
  getThread,
  type InboxThread,
  markInboxTabRead,
  markSearchRead,
  modifyThreads,
  type SavedRules,
  type ThreadDetail,
  type ThreadSummary,
  toCommandError,
  trashThreads,
  undoSenderRules,
} from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { type UnreadCountChange, useLabelStore } from "../store/labelStore";
import { newOp, useMailStore } from "../store/mailStore";
import { useThreadStore } from "../store/threadStore";
import { focusedThread, readingPaneShown, useUiStore } from "../store/uiStore";
import {
  CATEGORIES,
  parseThreadKey,
  resolveActiveAccount,
  type ThreadKey,
  threadKey,
} from "./mailboxes";
import { rowId } from "./ThreadRow";
import { similarSender, type SimilarBy, similarQuery } from "./similar";
import { setTravelDirection } from "./preload";

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
  /** Opening a thread marks it read without disturbing the selection. */
  keepChecked?: boolean;
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

function apply(
  keys: ThreadKey[] | undefined,
  change: Change,
  options?: ApplyOptions,
): Promise<void> {
  return applyChange(keys, change, options).then(() => undefined);
}

/** `apply`, resolving to whether the change went through (for at least one account). */
function applyChange(
  keys: ThreadKey[] | undefined,
  change: Change,
  { announce, keepChecked, after, cancelsAutoRead, evenIfGone }: ApplyOptions = {},
): Promise<boolean> {
  const rows = present(keys);
  const rowKeys = evenIfGone && keys ? [...new Set(keys)] : rows.map((r) => r.key);
  if (rowKeys.length === 0) return Promise.resolve(false);
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
    const removed = new Set(rowKeys);
    const next = nextAfter(ui().openThread, removed);
    const nextCursor = nextAfter(ui().cursor, removed);
    mail().remove(rowKeys, op);
    if (next === null) ui().setOpenThread(null);
    else if (next !== undefined) openAndMarkRead(next);
    if (nextCursor !== undefined) ui().setCursor(nextCursor);
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

/** `evenIfGone`: the conversation view's own controls act on the open thread even when its row has left the list. */
export function archive(keys?: ThreadKey[], { evenIfGone = false } = {}): Promise<void> {
  return apply(
    keys,
    modify([], ["INBOX"], { leavesList: inInbox(), detail: withLabel("INBOX", false) }),
    {
      announce: {
        title: "Archived",
        undo: modify(["INBOX"], [], { detail: withLabel("INBOX", true) }),
      },
      cancelsAutoRead: true,
      evenIfGone,
    },
  );
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
async function labelsOf(keys: ThreadKey[], fresh = false): Promise<Map<ThreadKey, Set<string>>> {
  const cached = useThreadStore.getState().details;
  const entries = await Promise.all(
    keys.map(async (key): Promise<[ThreadKey, Set<string>]> => {
      let detail = fresh ? undefined : cached.get(key);
      if (!detail) {
        const { accountId, threadId } = parseThreadKey(key);
        const read = getThread(accountId, threadId);
        // A fresh read that fails rejects rather than passing for a conversation without labels.
        detail = fresh ? await read : await read.catch(() => undefined);
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

/** A row's user-label ids after adding or removing `labelId`, kept sorted by name like the backend's. */
function rowLabelIds(t: ThreadSummary, labelId: string, add: boolean): string[] {
  if (!add) return t.labelIds.filter((id) => id !== labelId);
  if (t.labelIds.includes(labelId)) return t.labelIds;
  const { labelName } = useLabelStore.getState();
  const name = (id: string) => labelName(t.accountId, id);
  return [...t.labelIds, labelId].sort((a, b) =>
    name(a).localeCompare(name(b), undefined, { sensitivity: "base" }),
  );
}

/** `keys` (default: the targets) still in the list (or, `evenIfGone`, at all) that belong to `accountId`. */
const accountKeys = (
  accountId: string,
  keys: ThreadKey[] | undefined,
  evenIfGone = false,
): ThreadKey[] =>
  (evenIfGone && keys ? [...new Set(keys)] : present(keys).map((r) => r.key)).filter(
    (k) => parseThreadKey(k).accountId === accountId,
  );

/**
 * Adds `labelId` to (or removes it from) the targets of `accountId`, whatever they carry now. Resolves to whether
 * Gmail's queue took the change. `evenIfGone` acts on `keys` that have left the list (see `ApplyOptions`).
 */
export async function applyLabel(
  accountId: string,
  labelId: string,
  add: boolean,
  keys?: ThreadKey[],
  { evenIfGone = false }: { evenIfGone?: boolean } = {},
): Promise<boolean> {
  const rowKeys = accountKeys(accountId, keys, evenIfGone);
  if (rowKeys.length === 0) return false;
  // Removing a label in that label's own mailbox takes the row out of it.
  const leavesList = !add && inMailbox(labelId);
  return applyChange(
    rowKeys,
    modify(add ? [labelId] : [], add ? [] : [labelId], {
      leavesList,
      patch: (t) => ({ ...t, labelIds: rowLabelIds(t, labelId, add) }),
      detail: withLabel(labelId, add),
    }),
    { evenIfGone },
  );
}

/** Adds `labelId` to the targets of `accountId`, or removes it if they all have it already. */
export async function toggleLabel(
  accountId: string,
  labelId: string,
  keys?: ThreadKey[],
): Promise<void> {
  const rowKeys = accountKeys(accountId, keys);
  if (rowKeys.length === 0) return;
  await applyLabel(accountId, labelId, !allHave(await labelsOf(rowKeys), labelId), rowKeys);
}

/** Where the labels menu opens for the keyboard: under the open row, else near the top of the window. */
export function labelMenuAnchor(): { x: number; y: number } {
  const open = ui().openThread;
  const rect =
    open === null ? undefined : document.getElementById(rowId(open))?.getBoundingClientRect();
  if (rect && (rect.width > 0 || rect.height > 0)) return { x: rect.left + 48, y: rect.bottom };
  return { x: window.innerWidth / 2, y: window.innerHeight / 3 };
}

/** The targets still in the list, when they all come from one account; otherwise says so and gives `null`. */
function oneAccountTargets(): { accountId: string; keys: ThreadKey[] } | null {
  const rows = present(undefined);
  if (rows.length === 0) return null;
  const { accountId } = rows[0].thread;
  if (rows.some((r) => r.thread.accountId !== accountId)) {
    toast({ title: "Select conversations from one account to label them" });
    return null;
  }
  return { accountId, keys: rows.map((r) => r.key) };
}

/** "Label as…": the picker over the targets' account labels, ticked where all, some or none of the targets have them. */
export async function openLabelMenu(at: { x: number; y: number }): Promise<void> {
  const targets = oneAccountTargets();
  if (!targets) return;
  const { accountId, keys } = targets;
  const membership = await labelMembership(accountId, keys);
  usePickerStore.getState().open({ mode: "label", accountId, keys, at, membership });
}

/**
 * Whether all, some or none of `keys` carry each of the account's user labels. `fresh` reads them from the backend
 * rather than the detail cache, which may still hold a change the backend has since undone; it rejects if a read fails.
 */
export async function labelMembership(
  accountId: string,
  keys: ThreadKey[],
  { fresh = false } = {},
): Promise<Map<string, Membership>> {
  const labels = [...(await labelsOf(keys, fresh)).values()];
  const membership = new Map<string, Membership>();
  for (const label of useLabelStore.getState().userLabels(accountId)) {
    const count = labels.filter((ids) => ids.has(label.id)).length;
    membership.set(label.id, count === 0 ? "none" : count === labels.length ? "all" : "some");
  }
  return membership;
}

/**
 * The label a move takes conversations out of (spec §3 goal 8): the Inbox (or a category of it) or the user label
 * being shown, which the rows then leave; anywhere else (All Mail, Starred, Sent, search results) `INBOX`, if present.
 */
function moveSource(accountId: string): { labelId: string; leaves: boolean } {
  if (inInbox()) return { labelId: "INBOX", leaves: true };
  const { labelId } = ui().mailbox;
  const user = useLabelStore.getState().labelsById(accountId).get(labelId)?.type === "user";
  if (user && inMailbox(labelId)) return { labelId, leaves: true };
  return { labelId: "INBOX", leaves: false };
}

/** The label the conversations are shown in and a move takes them out of, which Move to… doesn't offer; else `null`. */
export function moveOrigin(accountId: string): string | null {
  const source = moveSource(accountId);
  return source.leaves ? source.labelId : null;
}

/** "Move to…": the picker over Inbox, the account's labels and Trash. Pheeme can't yet take mail out of Spam or Trash. */
export function openMoveMenu(at: { x: number; y: number }): void {
  if (present(undefined).length === 0) return;
  if (inMailbox("SPAM") || inMailbox("TRASH")) {
    toast({ title: "Move to isn't available in Spam or Trash yet" });
    return;
  }
  const targets = oneAccountTargets();
  if (targets) usePickerStore.getState().open({ mode: "move", ...targets, at });
}

/** A row's user-label ids with `add` added and `remove` removed; `INBOX` isn't among them. */
function rowMoveIds(t: ThreadSummary, add: string[], remove: string[]): ThreadSummary {
  let labelIds = t.labelIds;
  const row = () => ({ ...t, labelIds });
  for (const id of add) if (id !== "INBOX") labelIds = rowLabelIds(row(), id, true);
  for (const id of remove) if (id !== "INBOX") labelIds = rowLabelIds(row(), id, false);
  return row();
}

/** The conversation with `add` added to and `remove` removed from every message. */
const withLabels =
  (add: string[], remove: string[]) =>
  (detail: ThreadDetail): ThreadDetail =>
    remove.reduce(
      (d, id) => withLabel(id, false)(d),
      add.reduce((d, id) => withLabel(id, true)(d), detail),
    );

/**
 * Moves the targets of `accountId` to `target` (a user label, `INBOX` or `TRASH`): adds it and takes them out of
 * where they are (see `moveSource`). Trash is the existing delete. Undo puts back only what each conversation had.
 */
export async function moveTo(accountId: string, keys: ThreadKey[], target: string): Promise<void> {
  const rowKeys = accountKeys(accountId, keys);
  if (target === "TRASH") return trash(rowKeys);
  if (rowKeys.length === 0) return;
  const source = moveSource(accountId);
  if (source.leaves && source.labelId === target) return; // already there
  const remove = source.labelId === target ? [] : [source.labelId];
  const before = await labelsOf(rowKeys);
  // The mailbox being shown holds its rows' label even where their detail couldn't be read.
  const had = (key: ThreadKey, id: string) =>
    (source.leaves && id === source.labelId) || (before.get(key)?.has(id) ?? false);
  const undoOf = (key: ThreadKey) => ({
    add: remove.filter((id) => had(key, id)),
    remove: had(key, target) ? [] : [target],
  });
  const inverse: Change = {
    leavesList: false,
    patch: (t) => {
      const undo = undoOf(keyOf(t));
      return rowMoveIds(t, undo.add, undo.remove);
    },
    detail: (d) => {
      const undo = undoOf(keyOf(d.thread));
      return withLabels(undo.add, undo.remove)(d);
    },
    send: async (account, ids) => {
      const groups = new Map<string, { add: string[]; remove: string[]; ids: string[] }>();
      for (const id of ids) {
        const undo = undoOf(threadKey(account, id));
        if (undo.add.length + undo.remove.length === 0) continue;
        const signature = JSON.stringify(undo);
        const group = groups.get(signature) ?? { ...undo, ids: [] };
        group.ids.push(id);
        groups.set(signature, group);
      }
      await Promise.all(
        [...groups.values()].map((g) => modifyThreads(account, g.ids, g.add, g.remove)),
      );
    },
  };
  const name = target === "INBOX" ? "Inbox" : useLabelStore.getState().labelName(accountId, target);
  await apply(
    rowKeys,
    modify([target], remove, {
      leavesList: source.leaves,
      patch: (t) => rowMoveIds(t, [target], remove),
      detail: withLabels([target], remove),
    }),
    { announce: { title: `Moved to "${name}"`, undo: inverse } },
  );
}

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
  const inverse: Change = {
    leavesList: false,
    patch: (t) => {
      const undo = undoOf(keyOf(t));
      return withSystemLabels(t, undo.add, undo.remove);
    },
    detail: (d) => {
      const undo = undoOf(keyOf(d.thread));
      return withLabels(undo.add, undo.remove)(d);
    },
    send: async (account, ids) => {
      const groups = new Map<string, { add: string[]; remove: string[]; ids: string[] }>();
      for (const id of ids) {
        const undo = undoOf(threadKey(account, id));
        if (undo.add.length + undo.remove.length === 0) continue;
        const signature = JSON.stringify(undo);
        const group = groups.get(signature) ?? { ...undo, ids: [] };
        group.ids.push(id);
        groups.set(signature, group);
      }
      await Promise.all(
        [...groups.values()].map((g) => modifyThreads(account, g.ids, g.add, g.remove)),
      );
      const saved = await rules;
      if (saved && saved.created.length + saved.replaced.length > 0)
        await undoSenderRules(account, saved);
    },
  };
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

/** Automatic mark-reads waiting for their conversation's detail. An explicit change to the conversation drops one. */
const autoReads = new Map<ThreadKey, object>();

/**
 * Show a conversation. Opening it marks it read (Builder's call 7), quietly and once. The row turns read at once, but
 * the command waits until the conversation's detail is cached: answered after the change, every message would
 * arrive read and the view couldn't tell which ones to expand. If the detail can't be cached (the request failed,
 * or kept being superseded), or the user marks it unread (or archives or deletes it) in the meantime, the automatic
 * read is dropped rather than sent.
 */
export function openAndMarkRead(key: ThreadKey, direction: 1 | -1 = 1): void {
  // Ask for it before the preload window moves, so preloads queue behind it.
  void useThreadStore.getState().load(key);
  setTravelDirection(direction);
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
}

/**
 * j / k and the arrow keys: open the next or previous row, or the first/last when none is open. With the reading
 * pane off and nothing open, they move the highlight instead.
 */
export function moveSelection(delta: 1 | -1): void {
  const keys = mail().threads.map(keyOf);
  if (keys.length === 0) return;
  const browsing = !readingPaneShown(ui()) && ui().openThread === null;
  const current = focusedThread(ui());
  const at = current === null ? -1 : keys.indexOf(current);
  const to =
    at < 0
      ? delta === 1
        ? 0
        : keys.length - 1
      : Math.min(Math.max(at + delta, 0), keys.length - 1);
  if (to === at) return;
  if (browsing) ui().setCursor(keys[to]);
  else openAndMarkRead(keys[to], delta);
}

/** The focused conversation, where a highlight whose row has left the list (filtered out, archived elsewhere) counts as nothing. */
function focusedInList(): ThreadKey | null {
  const focused = focusedThread(ui());
  if (focused !== null && ui().openThread === null && present([focused]).length === 0) return null;
  return focused;
}

/** `o` / Enter: open the focused conversation (or highlighted row), or the first one when nothing is. */
export function openFocused(): void {
  const focused = focusedInList();
  const first = mail().threads[0];
  if (focused !== null) openAndMarkRead(focused);
  else if (first) openAndMarkRead(keyOf(first));
}

/** `x`: check or uncheck the focused conversation (or highlighted row). */
export function toggleCheckFocused(): void {
  const focused = focusedInList();
  if (focused !== null) ui().toggleChecked(focused);
}

/** `u` / Back: close the conversation, leaving its row highlighted for when the reading pane is off. */
export function closeConversation(): void {
  const open = ui().openThread;
  if (open !== null) ui().setCursor(open);
  ui().setOpenThread(null);
}

/**
 * Mark every unread conversation in one inbox tab of an account read (`category`: `CATEGORY_*`), including
 * mail not downloaded yet. The cache changes at once and its `sync:messages_updated` reloads the list and counts.
 */
export async function markTabRead(accountId: string, category: string) {
  try {
    await markInboxTabRead(accountId, category);
  } catch (e) {
    toast({ title: toCommandError(e).message, tone: "danger" });
  }
}

/**
 * Find similar: search the conversation's account (default: the open or highlighted conversation) for mail from its
 * sender or with its subject, so every match can be seen and marked read at once.
 */
export async function findSimilar(by: SimilarBy, key?: ThreadKey): Promise<void> {
  const target = key ?? focusedThread(ui());
  if (target === null) return;
  const { accountId } = parseThreadKey(target);
  const own = useAccountStore.getState().accounts.find((a) => a.id === accountId)?.email;
  const row = mail().threads.find((t) => keyOf(t) === target);
  const threads = useThreadStore.getState();
  // A row whose latest message is your own reply names you; the conversation knows who wrote to you.
  if (by === "sender" && !threads.details.has(target) && !similarSender(row, undefined, own)) {
    await threads.load(target);
  }
  const detail = useThreadStore.getState().details.get(target);
  const query = similarQuery(by, {
    sender: similarSender(row, detail?.messages, own),
    subject: row?.subject ?? detail?.thread.subject ?? null,
  });
  if (query === null) {
    toast({
      title: by === "sender" ? "No sender to search for." : "This conversation has no subject.",
      tone: "danger",
    });
    return;
  }
  ui().setSearch(query, accountId);
}

/** Mark every unread match of the search being shown read, including matches not loaded or downloaded yet. */
export async function markSearchResultsRead(): Promise<void> {
  const { searchText, searchAccountId } = ui();
  const query = searchText.trim();
  if (!query) return;
  const accountIds =
    searchAccountId === null
      ? useAccountStore.getState().accounts.map((a) => a.id)
      : [searchAccountId];
  try {
    await markSearchRead(accountIds, query);
    toast({ title: "Marked every match as read" });
  } catch (e) {
    toast({ title: toCommandError(e).message, tone: "danger" });
  }
}
