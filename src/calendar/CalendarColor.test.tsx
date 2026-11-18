import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { CalendarAccount, CalendarInfo } from "../lib/tauri";
import { CalendarColorButton, useCalendarColor } from "./CalendarColor";
import { useCalendarStore } from "./calendarStore";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};

const TEAM: CalendarInfo = {
  id: "team",
  summary: "Team",
  backgroundColor: "#9fe1e7",
  foregroundColor: "#000000",
  accessRole: "reader",
  primary: false,
  hidden: false,
};

let saves: Array<Record<string, unknown>>;
let allowed: boolean;
let signIns: string[];

beforeEach(() => {
  saves = [];
  allowed = true;
  signIns = [];
  useCalendarStore.setState({
    accounts: [
      {
        accountId: "acc",
        email: "me@example.com",
        access: { status: "on" },
        timeZone: "UTC",
        weekStart: 1,
        calendars: [TEAM],
      } as CalendarAccount,
    ],
  });
  mockIPC((cmd, args) => {
    if (cmd === "set_calendar_color") {
      saves.push(args as Record<string, unknown>);
      if (!allowed)
        throw { code: "missing_scope", message: "Allow Pheeme to change your calendars' colours." };
      return null;
    }
    if (cmd === "begin_oauth") {
      signIns.push((args as { client: { kind: string } }).client.kind);
      return { flowId: "f1", authUrl: "https://accounts.google.com/x" };
    }
    if (cmd === "complete_oauth") {
      allowed = true;
      return { id: "acc", email: "me@example.com" };
    }
    return undefined;
  });
});

afterEach(() => clearMocks());

function Row() {
  const calendar = useCalendarStore((s) => s.accounts![0].calendars[0]);
  const picker = useCalendarColor("acc", calendar);
  return (
    <>
      <span data-testid="color">{calendar.backgroundColor}</span>
      <CalendarColorButton name="Team" open={picker.open} onOpen={picker.openAt} />
      {picker.popover}
    </>
  );
}

const shown = () => screen.getByTestId("color").textContent;

test("a picked colour shows at once and is saved to Google", async () => {
  render(<Row />);
  fireEvent.click(screen.getByRole("button", { name: "Colour of Team" }));
  expect(screen.getByRole("radio", { name: "Aqua" })).toHaveAttribute("aria-checked", "true");

  fireEvent.click(screen.getByRole("radio", { name: "Blue" }));
  expect(shown()).toBe("#4986e7");
  await settle();

  expect(saves).toEqual([
    { accountId: "acc", calendarId: "team", background: "#4986e7", foreground: "#000000" },
  ]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("without access it asks once, then saves the colour it was given", async () => {
  allowed = false;
  render(<Row />);
  fireEvent.click(screen.getByRole("button", { name: "Colour of Team" }));
  fireEvent.click(screen.getByRole("radio", { name: "Blue" }));
  await settle();

  // Put back until Google takes it, with the way to allow it in the popover.
  expect(shown()).toBe("#9fe1e7");
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  await settle();

  expect(signIns).toEqual(["calendarColors"]);
  expect(saves).toHaveLength(2);
  expect(shown()).toBe("#4986e7");
  expect(screen.queryByRole("dialog")).toBeNull();
});
