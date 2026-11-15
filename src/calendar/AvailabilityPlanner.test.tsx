import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AvailabilityResult } from "../lib/tauri";
import type { SavedSpan } from "./availability";
import { AvailabilityPlanner } from "./AvailabilityPlanner";
import { zonedMs } from "./dates";
import { type EventForm, newForm } from "./eventForm";

const TZ = "America/New_York";
const at = (date: string, h: number, m = 0) => zonedMs(date, h * 60 + m, TZ);
// Monday 2026-11-16, 8:00 in New York.
const NOW = at("2026-11-16", 8);

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};

let calls: Array<Record<string, unknown>>;
let answer: (args: Record<string, unknown>) => AvailabilityResult | Promise<AvailabilityResult>;
/** Every form the planner handed back, newest last. */
const changed = vi.fn<(form: EventForm) => void>();
const latest = () => changed.mock.lastCall![0];

function backend() {
  mockIPC((cmd, args) => {
    if (cmd === "calendar_availability") {
      calls.push(args as Record<string, unknown>);
      return answer(args as Record<string, unknown>);
    }
    if (cmd === "begin_oauth") return { flowId: "f1", authUrl: "https://accounts.google.com/x" };
    if (cmd === "complete_oauth") return { id: "acc", email: "me@example.com" };
    return undefined;
  });
}

function Harness({ saved = null }: { saved?: SavedSpan | null }) {
  const [form, setForm] = useState<EventForm>(() => ({
    ...newForm({
      accountId: "acc",
      calendarId: "me@example.com",
      zone: TZ,
      allDay: false,
      start: at("2026-11-16", 10),
      end: at("2026-11-16", 11),
    }),
    guests: [
      { name: "Sam Ortiz", address: "sam@example.com", optional: false },
      { name: null, address: "priya@other.org", optional: false },
      { name: "Me", address: "ME@example.com", optional: false },
    ],
  }));
  const change = (update: (f: EventForm) => EventForm) =>
    setForm((f) => {
      const next = update(f);
      changed(next);
      return next;
    });
  return (
    <>
      <button type="button" onClick={() => setForm((f) => ({ ...f, summary: "Renamed" }))}>
        Rename
      </button>
      <AvailabilityPlanner
        form={form}
        onChange={change}
        tz={TZ}
        selfEmail="me@example.com"
        saved={saved}
      />
    </>
  );
}

const result = (busy: {
  sam: [number, number][];
  you: [number, number][];
}): AvailabilityResult => ({
  you: {
    email: "me@example.com",
    status: "known",
    busy: busy.you.map(([startMs, endMs]) => ({ startMs, endMs })),
  },
  guests: [
    {
      email: "sam@example.com",
      status: "known",
      busy: busy.sam.map(([startMs, endMs]) => ({ startMs, endMs })),
    },
    { email: "priya@other.org", status: "unknown", reason: "notFound" },
  ],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  calls = [];
  changed.mockClear();
});
afterEach(() => {
  clearMocks();
  vi.useRealTimers();
});

test("rows show skeletons, then busy time and 'not shared'; you aren't a guest row", async () => {
  let release: () => void = () => {};
  answer = () =>
    new Promise((resolve) => {
      release = () =>
        resolve(result({ you: [[at("2026-11-16", 9), at("2026-11-16", 10)]], sam: [] }));
    });
  backend();
  const { container } = render(<Harness />);
  await settle();

  const rows = () => container.querySelectorAll(".cal-avail__track");
  expect([...container.querySelectorAll(".cal-avail__name")].map((n) => n.textContent)).toEqual([
    "You",
    "Sam Ortiz",
    "priya@other.org",
  ]);
  expect(rows()).toHaveLength(3);
  expect(container.querySelectorAll(".ui-skeleton")).toHaveLength(3);
  expect(calls).toEqual([
    {
      accountId: "acc",
      emails: ["sam@example.com", "priya@other.org"],
      fromMs: at("2026-11-16", 7),
      toMs: at("2026-11-16", 21),
    },
  ]);

  release();
  await settle();
  expect(rows()).toHaveLength(3);
  expect(container.querySelectorAll(".ui-skeleton")).toHaveLength(0);
  expect(screen.getByText("Availability not shared")).toBeInTheDocument();
  expect(screen.getByText("You: busy 9:00 AM to 10:00 AM")).toBeInTheDocument();
  expect(screen.getByText("Sam Ortiz: free all day")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("1 guest's availability unknown");
  expect(screen.getByRole("slider", { name: /Proposed time/ })).toHaveAttribute(
    "aria-valuetext",
    "10:00 AM to 11:00 AM",
  );
});

test("arrow keys move the proposed time a quarter hour; the next day is asked for", async () => {
  answer = () => result({ you: [], sam: [] });
  backend();
  render(<Harness />);
  await settle();

  fireEvent.keyDown(screen.getByRole("slider", { name: /Proposed time/ }), { key: "ArrowRight" });
  expect(latest().startMinutes).toBe(10 * 60 + 15);
  expect(latest().endMinutes).toBe(11 * 60 + 15);

  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  await settle();
  expect(calls[calls.length - 1]).toMatchObject({
    fromMs: at("2026-11-17", 7),
    toMs: at("2026-11-17", 21),
  });
  // The event stays where it was; it isn't on the day shown.
  expect(latest().startDate).toBe("2026-11-16");
  expect(screen.queryByRole("slider")).toBeNull();
});

test("Next available time moves the event to the first slot everyone known is free", async () => {
  answer = (args) =>
    Number(args.toMs) - Number(args.fromMs) > 86_400_000
      ? result({
          you: [[at("2026-11-16", 9), at("2026-11-16", 12)]],
          sam: [[at("2026-11-16", 12), at("2026-11-16", 14, 30)]],
        })
      : result({ you: [], sam: [] });
  backend();
  render(<Harness />);
  await settle();

  fireEvent.click(screen.getByRole("button", { name: "Next available time" }));
  await settle();

  const query = calls[calls.length - 1]!;
  expect(query.fromMs).toBe(at("2026-11-16", 10));
  expect(query.toMs).toBe(at("2026-11-30", 0));
  expect(latest().startDate).toBe("2026-11-16");
  expect(latest().startMinutes).toBe(14 * 60 + 30);
  expect(latest().endMinutes).toBe(15 * 60 + 30);
  expect(screen.getByRole("status")).toHaveTextContent(
    /^Moved to Mon, Nov 16 at 2:30 PM\. 1 guest's availability unknown$/,
  );
});

test("Next available time keeps edits made while it searched", async () => {
  let reply: (r: AvailabilityResult) => void = () => {};
  answer = (args) =>
    Number(args.toMs) - Number(args.fromMs) > 86_400_000
      ? new Promise((resolve) => (reply = resolve))
      : result({ you: [], sam: [] });
  backend();
  render(<Harness />);
  await settle();

  fireEvent.click(screen.getByRole("button", { name: "Next available time" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  reply(result({ you: [[at("2026-11-16", 9), at("2026-11-16", 12)]], sam: [] }));
  await settle();

  expect(latest().summary).toBe("Renamed");
  expect(latest().startMinutes).toBe(12 * 60);
});

test("without free/busy access the rows hold an Allow button that asks for it", async () => {
  let granted = false;
  answer = () => {
    if (!granted)
      throw {
        code: "missing_scope",
        message: "Allow Pheeme to see guests' availability on Google Calendar.",
      };
    return result({ you: [], sam: [] });
  };
  backend();
  const { container } = render(<Harness />);
  await settle();

  expect(screen.getByRole("alert")).toHaveTextContent("Allow Pheeme to see guests' availability");
  expect(container.querySelectorAll(".cal-avail__track")).toHaveLength(3);
  expect(screen.getByRole("button", { name: "Next available time" })).toBeDisabled();

  granted = true;
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  await settle();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Availability not shared")).toBeInTheDocument();
});

test("a saved event's own time doesn't count as busy; another clash is flagged", async () => {
  // Google counts the saved event (10:00–11:00) as busy for you and for Sam, who accepted it.
  const own: [number, number] = [at("2026-11-16", 10), at("2026-11-16", 11)];
  answer = () =>
    result({ you: [own], sam: [own, [at("2026-11-16", 10, 30), at("2026-11-16", 12)]] });
  backend();
  render(<Harness saved={{ startMs: own[0], endMs: own[1], guests: ["sam@example.com"] }} />);
  await settle();

  expect(screen.getByText("You: free all day")).toBeInTheDocument();
  // Sam's other meeting overlaps the saved time and is kept beyond it.
  expect(screen.getByText("Sam Ortiz: busy 11:00 AM to 12:00 PM")).toBeInTheDocument();
  expect(screen.getByRole("slider", { name: /Proposed time/ })).toHaveAttribute(
    "aria-valuetext",
    "10:00 AM to 11:00 AM",
  );
  fireEvent.keyDown(screen.getByRole("slider", { name: /Proposed time/ }), { key: "ArrowRight" });
  expect(screen.getByRole("slider", { name: /Proposed time/ })).toHaveAttribute(
    "aria-valuetext",
    "10:15 AM to 11:15 AM, someone is busy",
  );
});
