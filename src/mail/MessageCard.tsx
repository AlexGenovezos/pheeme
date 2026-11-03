import { ChevronUp } from "lucide-react";
import { Avatar } from "../components/ui/Avatar";
import { formatFullDate, formatListDate } from "../lib/dates";
import type { EmailAddress, MessageDetail } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { AttachmentList } from "./AttachmentList";
import { EmailBody } from "./EmailBody";
import "./mail.css";

export interface MessageCardProps {
  message: MessageDetail;
  accountId: string;
  expanded: boolean;
  onToggle(): void;
}

const senderName = (m: MessageDetail) => m.fromName || m.fromAddress || "Unknown sender";

/** "to me, Mira Okafor": names where known, "me" for the account's own address. */
function recipientLine(prefix: string, people: EmailAddress[], myAddress: string | undefined): string | null {
  if (people.length === 0) return null;
  const names = people.map((p) => (myAddress && p.address.toLowerCase() === myAddress ? "me" : p.name || p.address));
  return `${prefix} ${names.join(", ")}`;
}

export function MessageCard({ message, accountId, expanded, onToggle }: MessageCardProps) {
  const myAddress = useAccountStore((s) => s.accounts.find((a) => a.id === accountId)?.email.toLowerCase());
  const name = senderName(message);
  const when = message.date > 0 ? new Date(message.date) : null;

  if (!expanded) {
    return (
      <article className="message-card message-card--collapsed" aria-label={`Message from ${name}`}>
        <button type="button" className="message-card__summary" aria-expanded="false" onClick={onToggle}>
          <Avatar name={name} email={message.fromAddress ?? undefined} />
          <span className="message-card__sender" data-unread={message.unread || undefined}>
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

  const lines = [recipientLine("to", message.to, myAddress), recipientLine("cc", message.cc, myAddress)].filter(Boolean);
  return (
    <article className="message-card" aria-label={`Message from ${name}`}>
      <header className="message-card__header">
        <Avatar name={name} email={message.fromAddress ?? undefined} />
        <div className="message-card__from">
          <div className="message-card__identity">
            <span className="message-card__name selectable">{name}</span>
            {message.fromName && message.fromAddress && (
              <span className="message-card__address selectable">{message.fromAddress}</span>
            )}
          </div>
          {lines.length > 0 && <div className="message-card__to selectable">{lines.join(" · ")}</div>}
        </div>
        {when && (
          <time className="message-card__date selectable" dateTime={when.toISOString()}>
            {formatFullDate(message.date)}
          </time>
        )}
        <button type="button" className="message-card__toggle" aria-expanded="true" aria-label="Collapse message" onClick={onToggle}>
          <ChevronUp aria-hidden="true" />
        </button>
      </header>
      <EmailBody message={message} />
      <AttachmentList accountId={accountId} messageId={message.id} attachments={message.attachments} />
    </article>
  );
}

