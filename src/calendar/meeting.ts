// Joining an event's video call: the button's words and opening the link. Which link joins the
// call (Meet, Zoom, Teams, Webex, …) is decided once, in Rust (`src-tauri/src/calendar/meeting.rs`).
import { toast } from "../components/ui/Toast";
import { type MeetingLink, openMeetingLink, toCommandError } from "../lib/tauri";

/** "Join with Zoom", "Join with Google Meet", …; "Join video call" for a provider not named. */
export const joinLabel = (meeting: MeetingLink) =>
  meeting.provider ? `Join with ${meeting.provider}` : "Join video call";

/** Open the call in the default browser; say why when it can't. */
export function joinMeeting(meeting: MeetingLink) {
  openMeetingLink(meeting.url).catch((e: unknown) =>
    toast({
      title: "Couldn't join the call",
      description: toCommandError(e).message,
      tone: "danger",
    }),
  );
}

/** The location is only the call's link, which Join already offers. */
export const locationIsCall = (location: string | null, meeting: MeetingLink | null) =>
  !!location && !!meeting && location.trim() === meeting.url;
