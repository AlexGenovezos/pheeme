import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MessageDetail, ThreadDetail } from "../lib/tauri";
import { createCalendarHandlers } from "../preview/calendar";
import { useAccountStore } from "../store/accountStore";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { useCalendarStore } from "./calendarStore";
import { useEditStore } from "./editStore";
import { InviteCard } from "./InviteCard";
import { backToMail, createEventFromEmail } from "./mailActions";

const ACCOUNTS = [
  { id: "acc-personal", email: "avery@example.com" },
  { id: "acc-work", email: "avery@example.org" },
];
// Wednesday 2026-11-11, noon local time: the fixture's Design review is Thursday at 2 PM.
const NOW = new Date(2026, 10, 11, 12).getTime();
const PINNED = { accountId: "acc-work", threadId: "w-13", messageId: "w-13-m1" };

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;

function backend(access: string | null) {
  const handlers = createCalendarHandlers(ACCOUNTS, access, NOW) as Record<
    string,
    (args?: Record<string, unknown>) => unknown
  >;
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      return handlers[cmd]?.(a);
    },
    { shouldMockEvents: true },
  );
}

const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  calls = [];
  useAccountStore.setState({ accounts: ACCOUNTS as never });
  useCalendarStore.setState({
    mode: "mail",
    view: "week",
    anchor: "2026-11-11",
    accounts: null,
    events: null,
    eventsFor: null,
    loadError: null,
    open: null,
    goToOpen: false,
    pinned: null,
    reveal: null,
  });
  useEditStore.setState({ editor: null, draft: null });
});
afterEach(() => {
  clearMocks();
  vi.useRealTimers();
});

describe("InviteCard", () => {
  test("shows the invitation, the clash, and answers on the calendar's copy", async () => {
    backend(null);
    render(<InviteCard pinned={PINNED} />);
    // Holds its rows while loading.
    expect(screen.getByRole("region", { name: "Invitation" })).toBeInTheDocument();
    await flush();
    await flush();
    await flush();

    expect(screen.getByRole("heading", { name: "Design review" })).toBeInTheDocument();
    expect(screen.getByText("Invitation from Morgan Lee")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join with Google Meet" })).toBeInTheDocument();
    expect(screen.getByText(/Morgan Lee \(organizer\) · 4 guests/)).toBeInTheDocument();
    expect(screen.getByText(/^Overlaps 1:1 Alex \(2:30\sPM\)$/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Yes" })).toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
    await flush();
    await flush();
    expect(sent("respond_to_calendar_event").map((c) => c.args)).toEqual([
      {
        accountId: "acc-work",
        calendarId: "avery@example.org",
        eventId: "design-review",
        scope: "all",
        response: "accepted",
        comment: null,
      },
    ]);
    expect(screen.getByRole("radio", { name: "Yes" })).toHaveAttribute("aria-checked", "true");
  });

  test("More options sends a note with the answer", async () => {
    backend(null);
    render(<InviteCard pinned={PINNED} />);
    await flush();
    await flush();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note for the organizer" }), {
      target: { value: "Running 5 min late" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send “Maybe”" }));
    await flush();
    await flush();
    expect(sent("respond_to_calendar_event")[0].args).toMatchObject({
      response: "tentative",
      comment: "Running 5 min late",
    });
  });

  test("without calendar access it still shows the invitation and offers Allow", async () => {
    backend("missing_scope");
    render(<InviteCard pinned={PINNED} />);
    await flush();
    await flush();
    await flush();
    expect(screen.getByRole("heading", { name: "Design review" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow calendar access" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Yes" })).not.toBeInTheDocument();
  });

  test("a cancelled invitation says so and can't be answered", async () => {
    backend(null);
    render(
      <InviteCard pinned={{ accountId: "acc-personal", threadId: "p-20", messageId: "p-20-m1" }} />,
    );
    await flush();
    await flush();
    await flush();
    expect(screen.getByText("This event was cancelled.")).toBeInTheDocument();
    expect(screen.getByText("Nothing to answer.")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Yes" })).not.toBeInTheDocument();
  });

  test("Open … in Calendar shows that day with the email pinned; Back to Mail returns", async () => {
    backend(null);
    render(<InviteCard pinned={PINNED} />);
    await flush();
    await flush();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^Open Thursday, Nov 12 in Calendar$/ }));
    await flush();
    const s = useCalendarStore.getState();
    expect(s.mode).toBe("calendar");
    expect(s.view).toBe("week");
    expect(s.anchor).toBe("2026-11-12");
    expect(s.pinned).toEqual(PINNED);
    expect(s.reveal).toBe(14 * 60);

    backToMail();
    expect(useCalendarStore.getState().mode).toBe("mail");
    expect(useCalendarStore.getState().reveal).toBeNull();
    expect(useUiStore.getState().openThread).toBe("acc-work:w-13");
  });
});

describe("createEventFromEmail", () => {
  const message: MessageDetail = {
    id: "p-21-m1",
    threadId: "p-21",
    fromName: "Jonas Weber",
    fromAddress: "jonas@example.net",
    to: [{ name: "Avery", address: "avery@example.com" }],
    cc: [],
    subject: "Re: Coffee next week?",
    snippet: "",
    date: NOW,
    bodyHtml: null,
    hasRemoteContent: false,
    declaresDarkMode: false,
    bodyText: "Are you free for coffee Friday at 3pm?",
    bodyAvailable: true,
    unread: false,
    starred: false,
    labelIds: ["INBOX"],
    hasAttachment: false,
    attachments: [],
  };
  const detail = {
    thread: { id: "p-21", accountId: "acc-personal", subject: "Re: Coffee next week?" },
    messages: [message],
    bodyError: null,
  } as unknown as ThreadDetail;

  test("opens the editor filled in from the open conversation, with the email pinned", async () => {
    backend(null);
    useThreadStore.setState({ details: new Map([["acc-personal:p-21", detail]]) });
    useUiStore.setState({ openThread: "acc-personal:p-21" });
    await act(() => createEventFromEmail());

    const editor = useEditStore.getState().editor;
    expect(editor?.event).toBeNull();
    expect(editor?.form).toMatchObject({
      summary: "Coffee next week?",
      accountId: "acc-personal",
      calendarId: "avery@example.com",
      startDate: "2026-11-13",
      startMinutes: 15 * 60,
      allDay: false,
    });
    expect(editor?.form.guests.map((g) => g.address)).toEqual(["jonas@example.net"]);
    const s = useCalendarStore.getState();
    expect(s.mode).toBe("calendar");
    expect(s.anchor).toBe("2026-11-13");
    expect(s.pinned).toEqual({
      accountId: "acc-personal",
      threadId: "p-21",
      messageId: "p-21-m1",
    });
  });

  test("with no calendar to write to, says how to get one", async () => {
    backend("missing_scope");
    useCalendarStore.setState({
      accounts: [
        {
          accountId: "acc-personal",
          email: "avery@example.com",
          access: { status: "missing_scope", message: null, enableUrl: null, syncedAt: null },
          timeZone: null,
          weekStart: null,
          calendars: [],
        },
      ],
    });
    useThreadStore.setState({ details: new Map([["acc-personal:p-21", detail]]) });
    useUiStore.setState({ openThread: "acc-personal:p-21" });
    await act(() => createEventFromEmail());
    expect(useEditStore.getState().editor).toBeNull();
    expect(useCalendarStore.getState().mode).toBe("calendar");
  });
});
