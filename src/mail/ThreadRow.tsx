// One conversation in the list: selection checkbox, sender, subject, snippet, date and hover actions.
import { Archive, Mail, MailOpen, Paperclip, Star, Trash2 } from "lucide-react";
import { memo, type MouseEvent, useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { registry } from "../keyboard/registry";
import { ListRow } from "../components/ui/ListRow";
import { cx } from "../lib/utils";
import { formatListDate } from "../lib/dates";
import type { ThreadSummary } from "../lib/tauri";
import { threadKey } from "./mailboxes";
import "./mail.css";

export type RowAction = "archive" | "delete" | "read";

export const senderOf = (t: Pick<ThreadSummary, "fromName" | "fromAddress">) =>
  t.fromName ?? t.fromAddress ?? "Unknown sender";

/** The row's DOM id, for the listbox's `aria-activedescendant`. Injective: every character outside [A-Za-z0-9-] becomes `_hex_`. */
export const rowId = (key: string) =>
  `thread-${key.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`)}`;

export interface ThreadRowProps {
  thread: ThreadSummary;
  /** One-based place in the list, and the list's size (-1 while more pages exist). */
  position: number;
  setSize: number;
  /** The conversation shown in the reading pane. */
  open: boolean;
  /** Part of the multi-selection. */
  checked: boolean;
  /** All Inboxes mixes accounts, so rows carry their account's color. */
  showAccountDot: boolean;
  /** 1..6, the `--color-account-N` token. */
  accountColor: number;
  accountEmail: string;
  onSelect(e: MouseEvent, thread: ThreadSummary): void;
  onCheck(e: MouseEvent, thread: ThreadSummary): void;
  onAction(action: RowAction, thread: ThreadSummary): void;
  onContextMenu(e: MouseEvent, thread: ThreadSummary): void;
}

export const ThreadRow = memo(function ThreadRow({
  thread,
  position,
  setSize,
  open,
  checked,
  showAccountDot,
  accountColor,
  accountEmail,
  onSelect,
  onCheck,
  onAction,
  onContextMenu,
}: ThreadRowProps) {
  const [hovered, setHovered] = useState(false);
  const sender = senderOf(thread);
  const act = (action: RowAction) => (e: MouseEvent) => {
    e.stopPropagation();
    onAction(action, thread);
  };

  return (
    <ListRow
      className={cx("thread-row", checked && "thread-row--checked")}
      id={rowId(threadKey(thread.accountId, thread.id))}
      // `selected` only draws the open row (data-selected); aria-selected is the checked set. The open row is the listbox's active descendant.
      selected={open}
      aria-selected={checked}
      aria-posinset={position}
      aria-setsize={setSize}
      unread={thread.unread}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => onSelect(e, thread)}
      onContextMenu={(e) => onContextMenu(e, thread)}
      leading={
        <label
          className="thread-row__lead"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            className="thread-row__check"
            aria-label={`Select conversation from ${sender}`}
            checked={checked}
            readOnly
            // Mouse target only: focus stays on the listbox, and `x` is the keyboard path.
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onCheck(e, thread);
            }}
          />
        </label>
      }
      title={
        <>
          {showAccountDot && (
            <span
              className="thread-row__account"
              role="img"
              aria-label={`Account ${accountEmail}`}
              title={accountEmail}
              style={{ background: `var(--color-account-${accountColor})` }}
            />
          )}
          {thread.messageCount > 1 ? `${sender} (${thread.messageCount})` : sender}
        </>
      }
      meta={
        <>
          <span className="thread-row__stamp" data-hidden={hovered || undefined}>
            {thread.hasAttachment && (
              <Paperclip aria-label="Has attachment" className="list-pane__glyph" />
            )}
            {thread.starred && (
              <Star aria-label="Starred" className="list-pane__glyph list-pane__glyph--star" />
            )}
            {thread.date > 0 && (
              <time dateTime={new Date(thread.date).toISOString()}>
                {formatListDate(thread.date)}
              </time>
            )}
          </span>
          {hovered && (
            <span className="thread-row__actions" onMouseDown={(e) => e.preventDefault()}>
              <IconButton
                size="sm"
                tabIndex={-1}
                label="Archive"
                shortcut={registry.shortcutFor("conversation.archive", "e")}
                icon={<Archive />}
                onClick={act("archive")}
              />
              <IconButton
                size="sm"
                tabIndex={-1}
                label="Delete"
                shortcut={registry.shortcutFor("conversation.delete", "#")}
                icon={<Trash2 />}
                onClick={act("delete")}
              />
              <IconButton
                size="sm"
                tabIndex={-1}
                label={thread.unread ? "Mark as read" : "Mark as unread"}
                shortcut={
                  thread.unread
                    ? registry.shortcutFor("conversation.mark-read", "shift+i")
                    : registry.shortcutFor("conversation.mark-unread", "shift+u")
                }
                icon={thread.unread ? <MailOpen /> : <Mail />}
                onClick={act("read")}
              />
            </span>
          )}
        </>
      }
      subtitle={thread.subject ?? "(no subject)"}
      description={thread.snippet}
    />
  );
});
