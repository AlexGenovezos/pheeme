// Which messages carry a calendar invitation, from their attachment list alone (no download), so the
// invite card can hold its place from the conversation's first frame.
import type { AttachmentInfo, MessageDetail } from "../lib/tauri";

const lower = (s: string | null) => (s ?? "").trim().toLowerCase();

/** A calendar file (as `mail.rs`'s `invite_part` picks them): a `text/calendar` part or an `.ics` file. */
export function isInvitePart(a: AttachmentInfo): boolean {
  const mime = lower(a.mimeType);
  return (
    mime === "text/calendar" || mime === "application/ics" || lower(a.filename).endsWith(".ics")
  );
}

/** The unnamed `text/calendar` part beside the body: the invite card stands in for it, so it isn't listed as a file. */
export const isCalendarBodyPart = (a: AttachmentInfo) =>
  !a.filename && lower(a.mimeType) === "text/calendar";

/** The newest message carrying an invitation: the one the card is about. */
export function inviteMessage(messages: MessageDetail[]): MessageDetail | null {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].attachments.some(isInvitePart)) return messages[i];
  return null;
}
