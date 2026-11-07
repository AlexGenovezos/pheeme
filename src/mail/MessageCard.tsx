import { ChevronUp, Pencil } from "lucide-react";
import { type MouseEvent, useRef } from "react";
import { useComposeStore } from "../compose/composeStore";
import { Button } from "../components/ui/Button";
import { formatFullDate, formatListDate } from "../lib/dates";
import type { CommandError, EmailAddress, MessageDetail, ThreadLoading } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useThreadStore } from "../store/threadStore";
import { AttachmentList } from "./AttachmentList";
import { EmailBody } from "./EmailBody";
import { threadKey } from "./mailboxes";
import "./mail.css";

export interface MessageCardProps {
  message: MessageDetail;
  accountId: string;
  expanded: boolean;
  onToggle(): void;
  /** Why the thread's missing bodies couldn't be fetched, if they couldn't. */
  bodyError?: CommandError | null;
  /** What a fetch of the thread's bodies is waiting on, while one runs. */
  loading?: ThreadLoading;
}

const senderName = (m: MessageDetail) => m.fromName || m.fromAddress || "Unknown sender";

/** "to me, Mira Okafor": names where known, "me" for the account's own address. */
function recipientLine(
  prefix: string,
  people: EmailAddress[],
  myAddress: string | undefined,
): string | null {
  if (people.length === 0) return null;
  const names = people.map((p) =>
    myAddress && p.address.toLowerCase() === myAddress ? "me" : p.name || p.address,
  );
  return `${prefix} ${names.join(", ")}`;
}

export function MessageCard({
  message,
  accountId,
  expanded,
  onToggle,
  bodyError,
  loading,
}: MessageCardProps) {
  const myAddress = useAccountStore((s) =>
    s.accounts.find((a) => a.id === accountId)?.email.toLowerCase(),
  );
  const isDraft = message.labelIds.includes("DRAFT");
  const name = isDraft ? "Draft" : senderName(message);
  const when = message.date > 0 ? new Date(message.date) : null;
  const pressedAt = useRef<{ x: number; y: number } | null>(null);

  if (!expanded) {
    return (
      <article className="message-card message-card--collapsed" aria-label={`Message from ${name}`}>
        <button
          type="button"
          className="message-card__summary"
          aria-expanded="false"
          onClick={onToggle}
        >
          <span
            className="message-card__sender"
            data-unread={message.unread || undefined}
            data-draft={isDraft || undefined}
          >
            {name}
          </span>
          <span className="message-card__snippet">{message.snippet}</span>
          {when && (
            <time className="message-card__date" dateTime={when.toISOString()}>
              {formatListDate(message.date)}
            </time>
          )}
        </button>
      </article>
    );
  }

  /** A click on the header's empty space collapses the card, like the summary row expands
   *  it; the chevron stays the keyboard route. Its text keeps selecting (double-click a
   *  word), and a press that drags (selecting text) is left alone. */
  const collapseFromHeader = (e: MouseEvent) => {
    const from = pressedAt.current;
    if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4) return;
    if ((e.target as Element).closest("button, a, .selectable")) return;
    onToggle();
  };

  const lines = [
    recipientLine("to", message.to, myAddress),
    recipientLine("cc", message.cc, myAddress),
  ].filter(Boolean);
  return (
    <article
      className="message-card"
      aria-label={`Message from ${name}`}
      // The speed reader reads the message on screen; drafts aren't read.
      data-message-id={isDraft ? undefined : message.id}
    >
      <header
        className="message-card__header"
        onMouseDown={(e) => (pressedAt.current = { x: e.clientX, y: e.clientY })}
        onClick={collapseFromHeader}
      >
        <div className="message-card__from">
          <div className="message-card__identity">
            <span className="message-card__name selectable" data-draft={isDraft || undefined}>
              {name}
            </span>
            {message.fromName && message.fromAddress && (
              <span className="message-card__address selectable">{message.fromAddress}</span>
            )}
          </div>
          {lines.length > 0 && (
            <div className="message-card__to selectable">{lines.join(" · ")}</div>
          )}
        </div>
        {when && (
          <time className="message-card__date selectable" dateTime={when.toISOString()}>
            {formatFullDate(message.date)}
          </time>
        )}
        <button
          type="button"
          className="message-card__toggle"
          aria-expanded="true"
          aria-label="Collapse message"
          onClick={onToggle}
        >
          <ChevronUp aria-hidden="true" />
        </button>
      </header>
      <EmailBody
        message={message}
        bodyError={bodyError}
        loading={loading}
        onRetry={() => void useThreadStore.getState().load(threadKey(accountId, message.threadId))}
      />
      <AttachmentList
        accountId={accountId}
        messageId={message.id}
        attachments={message.attachments}
      />
      {isDraft && (
        <div className="message-card__draft-actions">
          <Button
            size="sm"
            icon={<Pencil />}
            onClick={() => void useComposeStore.getState().editDraft(accountId, message.id)}
          >
            Edit draft
          </Button>
        </div>
      )}
    </article>
  );
}
