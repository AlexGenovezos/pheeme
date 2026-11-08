// One conversation in the list: selection checkbox, sender, subject, snippet, date and hover actions.
import { Archive, Mail, MailOpen, Paperclip, Star, Trash2 } from "lucide-react";
import { type CSSProperties, memo, type MouseEvent, useEffect, useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { registry } from "../keyboard/registry";
import { ListRow } from "../components/ui/ListRow";
import { cx } from "../lib/utils";
import { formatListDate } from "../lib/dates";
import { LabelChip } from "../labels/LabelChip";
import type { LabelInfo, ThreadSummary } from "../lib/tauri";
import { CodeChip } from "./CodeCard";
import { startMailDrag } from "./dragMail";
import { type Location, threadKey } from "./mailboxes";
import { LIST_CODE_MAX_AGE, rowCode } from "./verificationCode";
import "./mail.css";

export type RowAction = "archive" | "delete" | "read";

export const senderOf = (t: Pick<ThreadSummary, "fromName" | "fromAddress">) =>
  t.fromName ?? t.fromAddress ?? "Unknown sender";

/** The row's DOM id, for the listbox's `aria-activedescendant`. Injective: every character outside [A-Za-z0-9-] becomes `_hex_`. */
export const rowId = (key: string) =>
  `thread-${key.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`)}`;

/** Chips shown before the subject; the rest collapse into `+N`. */
const MAX_ROW_CHIPS = 3;

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
  /** The account's labels by id, stable until they change. */
  labels: ReadonlyMap<string, LabelInfo>;
  /** The mailbox being viewed, whose own chip would be redundant. */
  currentLabelId: string;
  /** Where the conversation sits (Updates, Spam, Archived…), shown before the subject; null hides it. */
  location: Location | null;
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
  labels,
  currentLabelId,
  location,
  onSelect,
  onCheck,
  onAction,
  onContextMenu,
}: ThreadRowProps) {
  const [hovered, setHovered] = useState(false);
  const sender = senderOf(thread);
  const chips = thread.labelIds.flatMap((id) => {
    const label = labels.get(id);
    return label && label.messageListVisibility !== "hide" && id !== currentLabelId ? [label] : [];
  });
  // Re-checked when the code gets too old for the list, even if nothing else re-renders the row.
  const [, setExpired] = useState(0);
  const code = rowCode(thread, Date.now());
  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(
      () => setExpired((n) => n + 1),
      thread.date + LIST_CODE_MAX_AGE - Date.now() + 1,
    );
    return () => clearTimeout(timer);
  }, [code, thread.date]);
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
      onPointerDown={(e) => {
        // The checkbox and hover actions are buttons, not handles.
        if ((e.target as Element).closest(".thread-row__lead, .thread-row__actions, .code-chip"))
          return;
        startMailDrag(e, threadKey(thread.accountId, thread.id));
      }}
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
      subtitle={
        <>
          {location && (
            <span
              className="thread-row__location"
              style={{ "--row-color": `var(${location.colorToken})` } as CSSProperties}
            >
              {location.name}
            </span>
          )}
          {chips.length > 0 && (
            <span className="label-chips">
              {chips.slice(0, MAX_ROW_CHIPS).map((label) => (
                <LabelChip key={label.id} label={label} />
              ))}
              {chips.length > MAX_ROW_CHIPS && (
                <span
                  className="label-chips__more"
                  title={chips
                    .slice(MAX_ROW_CHIPS)
                    .map((l) => l.name)
                    .join(", ")}
                >
                  +{chips.length - MAX_ROW_CHIPS}
                </span>
              )}
            </span>
          )}
          {thread.subject ?? "(no subject)"}
        </>
      }
      description={
        code ? (
          <>
            <CodeChip code={code} />
            {thread.snippet}
          </>
        ) : (
          thread.snippet
        )
      }
    />
  );
});
