import { call } from "./call";

export interface LabelInfo {
  id: string;
  accountId: string;
  name: string;
  type: string;
  messagesTotal: number;
  messagesUnread: number;
  threadsTotal: number;
  threadsUnread: number;
  colorBackground: string | null;
  colorText: string | null;
  /** Gmail's `show` | `hide` | `showIfUnread`; null when Gmail didn't say. */
  messageListVisibility: string | null;
  /** Gmail's `labelShow` | `labelShowIfUnread` | `labelHide`; null when Gmail didn't say. */
  labelListVisibility: string | null;
}

/** A Gmail label colour pair; only values from Gmail's palette are accepted. */
export interface LabelColor {
  background: string;
  text: string;
}

/** Changes to one label; fields left out stay as they are. */
export interface LabelEdit {
  /** The full new path (`Clients/Acme`); renaming a parent renames its sublabels too. */
  name?: string;
  color?: LabelColor;
  clearColor?: boolean;
  /** `labelShow` | `labelShowIfUnread` | `labelHide`. */
  labelListVisibility?: string;
  /** `show` | `hide`. */
  messageListVisibility?: string;
}

/** What deleting a label takes with it. */
export interface LabelDeletePreview {
  /** Conversations with the label, per Gmail; null when Gmail couldn't be asked. */
  threads: number | null;
  /** Full names of the sublabels deleted with it. */
  sublabels: string[];
}

export interface LabelCount {
  labelId: string;
  unread: number;
  total: number;
}

export const listLabels = (accountId: string) => call("list_labels", { accountId });
/** The inbox tabs (`CATEGORY_SOCIAL`, `_PROMOTIONS`, `_UPDATES`, `_FORUMS`) this account hides. */
export const getInboxTabs = (accountId: string) => call("inbox_tabs", { accountId });
/** Hides these inbox tabs (their mail shows under Primary); resolves to what's now hidden. */
export const setInboxTabs = (accountId: string, hidden: string[]) =>
  call("set_inbox_tabs", { accountId, hidden });
/** Unread and total conversations per label of one account, counted from the local cache. */
export const labelCounts = (accountId: string) => call("label_counts", { accountId });
/** Creates a user label in Gmail (`name` is the full path) and caches it. */
export const createLabel = (accountId: string, name: string, color: LabelColor | null) =>
  call("create_label", { accountId, name, color });
/** Edits a label in Gmail; resolves to every label changed (parent first, then sublabels). */
export const updateLabel = (accountId: string, labelId: string, edit: LabelEdit) =>
  call("update_label", { accountId, labelId, edit });
/** Deletes a label and its sublabels in Gmail; the conversations stay. */
export const deleteLabel = (accountId: string, labelId: string) =>
  call("delete_label", { accountId, labelId });
export const deleteLabelPreview = (accountId: string, labelId: string) =>
  call("delete_label_preview", { accountId, labelId });
