// One conversation in the list: avatar (a checkbox while selecting), sender, subject, snippet, date and hover actions.
import { Archive, Mail, MailOpen, Paperclip, Star, Trash2 } from "lucide-react";
import { memo, type MouseEvent, useState } from "react";
import { Avatar } from "../components/ui/Avatar";
import { IconButton } from "../components/ui/IconButton";
import { ListRow } from "../components/ui/ListRow";
import { cx } from "../lib/utils";
import { formatListDate } from "../lib/dates";
import type { ThreadSummary } from "../lib/tauri";
import "./mail.css";

export type RowAction = "archive" | "delete" | "read";

export const senderOf = (t: Pick<ThreadSummary, "fromName" | "fromAddress">) => t.fromName ?? t.fromAddress ?? "Unknown sender";

export interface ThreadRowProps {
  thread: ThreadSummary;
  /** The conversation shown in the reading pane. */
  open: boolean;
  /** Part of the multi-selection. */
  checked: boolean;
  /** Anything in the list is checked, so every avatar is a checkbox. */
  anyChecked: boolean;
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
  open,
  checked,
  anyChecked,
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
  const asCheckbox = anyChecked || hovered;
  const act = (action: RowAction) => (e: MouseEvent) => {
    e.stopPropagation();
    onAction(action, thread);
  };

  return (
    <ListRow
      className={cx("thread-row", checked && "thread-row--checked")}
      selected={open}
      // In a multiselectable listbox aria-selected means checked; the open row counts as selected too.
      aria-selected={open || checked}
      unread={thread.unread}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => onSelect(e, thread)}
      onContextMenu={(e) => onContextMenu(e, thread)}
      leading={
        asCheckbox ? (
          <span className="thread-row__lead">
            <input
              type="checkbox"
              className="thread-row__check"
              aria-label={`Select conversation from ${sender}`}
              checked={checked}
              readOnly
              onClick={(e) => {
                e.stopPropagation();
                onCheck(e, thread);
              }}
            />
          </span>
        ) : (
          <span className="thread-row__lead">
            <Avatar name={sender} email={thread.fromAddress ?? undefined} />
          </span>
        )
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
            {thread.hasAttachment && <Paperclip aria-label="Has attachment" className="list-pane__glyph" />}
            {thread.starred && <Star aria-label="Starred" className="list-pane__glyph list-pane__glyph--star" />}
            {thread.date > 0 && <time dateTime={new Date(thread.date).toISOString()}>{formatListDate(thread.date)}</time>}
          </span>
          {hovered && (
            <span className="thread-row__actions">
              <IconButton size="sm" label="Archive" shortcut="e" icon={<Archive />} onClick={act("archive")} />
              <IconButton size="sm" label="Delete" shortcut="#" icon={<Trash2 />} onClick={act("delete")} />
              <IconButton
                size="sm"
                label={thread.unread ? "Mark as read" : "Mark as unread"}
                shortcut="shift+u"
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
