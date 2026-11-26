// Archive, trash, star and read: the mail actions that add or remove a flag or a system label.
import { toast, toastError } from "../components/ui/Toast";
import { markInboxTabRead, type ThreadDetail, trashThreads } from "../lib/tauri";
import { currentArchiveSlot } from "./archiveSlot";
import {
  type Change,
  apply,
  inInbox,
  inMailbox,
  modify,
  present,
  readChange,
  withLabel,
} from "./change";
import { isImportant, withImportance } from "./importance";
import type { ThreadKey } from "./mailboxes";

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

/** The Archive slot (its buttons, row-menu item and `e`): archive, except Not spam in Spam and Move to Inbox in Trash. */
export function archiveSlotAction(keys?: ThreadKey[]): Promise<void> {
  return currentArchiveSlot() === "archive" ? archive(keys) : moveToInbox(keys);
}

/** The conversation as it will be back in the inbox: out of Spam and Trash. */
const backInInbox = (detail: ThreadDetail): ThreadDetail => {
  const out = withLabel("INBOX", true)(withLabel("SPAM", false)(detail));
  return withLabel("TRASH", false)(out);
};

/**
 * Gmail's Not spam (in Spam) and Move to Inbox (in Trash): the conversations go back to the inbox. Getting INBOX
 * takes mail out of Trash; Spam is removed with it. No Undo: Pheeme can't put mail back in Spam or Trash's place.
 */
export function moveToInbox(keys?: ThreadKey[]): Promise<void> {
  const fromSpam = inMailbox("SPAM");
  return apply(
    keys,
    modify(["INBOX"], ["SPAM"], {
      leavesList: fromSpam || inMailbox("TRASH"),
      detail: backInInbox,
    }),
    {
      announce: { title: fromSpam ? "Marked as not spam" : "Moved to Inbox" },
      cancelsAutoRead: true,
    },
  );
}

/** Moves to Trash. There is no Undo: putting it back would also need where it was. */
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

/**
 * Gmail's Mark as important and Mark as not important. Only the conversations that aren't in that state yet change, so
 * `+` on an important conversation does nothing, like Gmail's. In the Important mailbox, Not important takes the row out.
 */
export function setImportant(important: boolean, keys?: ThreadKey[]): Promise<void> {
  const to = (value: boolean): Change =>
    modify(value ? ["IMPORTANT"] : [], value ? [] : ["IMPORTANT"], {
      patch: (t) => withImportance(t, value),
      leavesList: !value && inMailbox("IMPORTANT"),
      detail: withLabel("IMPORTANT", value),
    });
  const changing = present(keys).filter((r) => isImportant(r.thread) !== important);
  return apply(
    changing.map((r) => r.key),
    to(important),
    {
      announce: {
        title: important ? "Marked as important" : "Marked as not important",
        undo: to(!important),
      },
    },
  );
}

export function setRead(read: boolean, keys?: ThreadKey[]): Promise<void> {
  return apply(keys, readChange(read), {
    announce: { title: read ? "Marked as read" : "Marked as unread", undo: readChange(!read) },
    cancelsAutoRead: true,
  });
}

/**
 * Mark every unread conversation in one inbox tab of an account read (`category`: `CATEGORY_*`), including
 * mail not downloaded yet. The cache changes at once and its `sync:messages_updated` reloads the list and counts.
 */
export async function markTabRead(accountId: string, category: string) {
  try {
    await markInboxTabRead(accountId, category);
  } catch (e) {
    toastError(e);
  }
}
