// The email pinned beside the calendar (Open … in Calendar, Create event from email): its subject,
// sender, the invite card with Yes / Maybe / No when it's an invitation, and the start of its text.
// Close unpins it; Back to Mail returns to the conversation.
import { ArrowLeft, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Skeleton } from "../components/ui/Skeleton";
import { formatListDate } from "../lib/dates";
import { threadKey } from "../mail/mailboxes";
import { isInvitePart } from "../mail/invitePart";
import { useThreadStore } from "../store/threadStore";
import { type PinnedEmail as Pinned, useCalendarStore } from "./calendarStore";
import { messageText } from "./fromEmail";
import { InviteCard } from "./InviteCard";
import { backToMail } from "./mailActions";
import "./invite.css";

/** The start of the email: enough to recall it, not the whole thread. */
const EXCERPT_CHARS = 1200;

export function PinnedEmail() {
  const pinned = useCalendarStore((s) => s.pinned);
  if (!pinned) return null;
  return <PinnedBody key={`${pinned.accountId}\n${pinned.messageId}`} pinned={pinned} />;
}

function PinnedBody({ pinned }: { pinned: Pinned }) {
  const key = threadKey(pinned.accountId, pinned.threadId);
  const detail = useThreadStore((s) => s.details.get(key));
  useEffect(() => {
    if (!useThreadStore.getState().details.has(key)) void useThreadStore.getState().load(key);
  }, [key]);
  const message = detail?.messages.find((m) => m.id === pinned.messageId) ?? null;
  const text = message ? messageText(message) : null;
  const excerpt =
    text && text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS).trimEnd()}…` : text;
  const isInvite = message?.attachments.some(isInvitePart) ?? false;
  const from = message ? message.fromName || message.fromAddress || "Unknown sender" : null;

  return (
    <aside className="pinned-email" aria-label="Pinned email">
      <div className="pinned-email__head">
        <span className="pinned-email__label">From Mail</span>
        <IconButton
          size="sm"
          label="Unpin email"
          icon={<X />}
          onClick={() => useCalendarStore.getState().pin(null)}
        />
      </div>
      <div className="pinned-email__scroll">
        <h2 className="pinned-email__subject selectable">
          {detail ? detail.thread.subject || "(no subject)" : <Skeleton width="12em" />}
        </h2>
        <p className="pinned-email__from">
          {from && message ? (
            `${from} · ${formatListDate(message.date)}`
          ) : (
            <Skeleton width="10em" />
          )}
        </p>
        {isInvite && <InviteCard pinned={pinned} compact />}
        <p className="pinned-email__text selectable">
          {excerpt ?? (
            <>
              <Skeleton />
              <Skeleton />
              <Skeleton width="60%" />
            </>
          )}
        </p>
      </div>
      <div className="pinned-email__foot">
        <Button size="sm" icon={<ArrowLeft />} onClick={backToMail}>
          Back to Mail
        </Button>
      </div>
    </aside>
  );
}
