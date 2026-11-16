// Label as… and Move to…: adding labels to and taking them from conversations, and the pickers that ask which.
import { toast } from "../components/ui/Toast";
import { type Membership, usePickerStore } from "../labels/pickerStore";
import { getThread, modifyThreads, type ThreadSummary } from "../lib/tauri";
import { useLabelStore } from "../store/labelStore";
import { useThreadStore } from "../store/threadStore";
import {
  type Change,
  apply,
  applyChange,
  inInbox,
  inMailbox,
  keyOf,
  modify,
  present,
  ui,
  withLabel,
  withLabels,
} from "./change";
import { parseThreadKey, type ThreadKey, threadKey } from "./mailboxes";
import { trash } from "./mutations";
import { rowId } from "./ThreadRow";

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

/** "Move to…": the picker over Inbox, the account's labels and Trash. In Spam and Trash, Not spam and Move to Inbox take mail out. */
export function openMoveMenu(at: { x: number; y: number }): void {
  if (present(undefined).length === 0) return;
  if (inMailbox("SPAM") || inMailbox("TRASH")) {
    toast({
      title: "Move to isn't available in Spam or Trash",
      description: inMailbox("SPAM")
        ? "Use Not spam to move it to the inbox."
        : "Use Move to Inbox.",
    });
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

/** What one conversation's Undo adds and removes. */
interface LabelUndo {
  add: string[];
  remove: string[];
}

/**
 * The Undo of a move, which puts back what each conversation had, so it differs per conversation: `undoOf` gives it,
 * `patchRow` shows it on a row, and `then` runs for each account after its labels are back. Conversations with the
 * same Undo share one command; those with nothing to undo send none.
 */
export function perKeyInverse(
  undoOf: (key: ThreadKey) => LabelUndo,
  patchRow: (t: ThreadSummary, add: string[], remove: string[]) => ThreadSummary,
  then?: (accountId: string) => Promise<void>,
): Change {
  return {
    leavesList: false,
    patch: (t) => {
      const undo = undoOf(keyOf(t));
      return patchRow(t, undo.add, undo.remove);
    },
    detail: (d) => {
      const undo = undoOf(keyOf(d.thread));
      return withLabels(undo.add, undo.remove)(d);
    },
    send: async (account, ids) => {
      const groups = new Map<string, LabelUndo & { ids: string[] }>();
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
      if (then) await then(account);
    },
  };
}

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
  const inverse = perKeyInverse(undoOf, rowMoveIds);
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
