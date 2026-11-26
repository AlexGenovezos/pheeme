import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AccountInfo } from "../lib/tauri";
import { createVacationHandlers } from "../preview/vacation";
import { useAccountStore } from "../store/accountStore";
import { VacationNotices } from "./VacationNotices";
import { VacationSettings } from "./VacationSettings";
import { useVacation } from "./vacationStore";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const accounts = [
  { id: "a1", email: "me@gmail.com" },
  { id: "a2", email: "me@studio.org" },
] as AccountInfo[];
let calls: { cmd: string; args: Record<string, unknown> }[] = [];

function backend(mode: string | null) {
  const handlers = createVacationHandlers(accounts, mode) as Record<
    string,
    (args: unknown) => unknown
  >;
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    return handlers[cmd]?.(args);
  });
}

beforeEach(() => {
  calls = [];
  useVacation.setState({ accounts: {}, drafts: {}, writing: {} });
  useAccountStore.setState({ accounts });
});
afterEach(() => clearMocks());

const section = (email: string) =>
  screen.getByRole("region", { name: `Vacation responder · ${email}` });
const control = (region: HTMLElement, name: string) => within(region).getByRole("switch", { name });

test("every field is there while Gmail answers, disabled until the responder is turned on", async () => {
  backend(null);
  render(<VacationSettings />);
  const one = section("me@gmail.com");
  const before = one.querySelectorAll(".settings-row").length;
  expect(
    within(one).getByRole("switch", { name: "Vacation responder for me@gmail.com" }),
  ).toBeDisabled();
  await flush();
  expect(one.querySelectorAll(".settings-row").length).toBe(before);
  expect(within(one).getByRole("textbox", { name: "Subject" })).toBeDisabled();

  fireEvent.click(within(one).getByRole("switch", { name: "Vacation responder for me@gmail.com" }));
  expect(within(one).getByRole("textbox", { name: "Subject" })).toBeEnabled();
  // Last day waits for its switch; the domain limit is only for Workspace accounts.
  expect(within(one).getByRole("combobox", { name: "Last day" })).toBeDisabled();
  fireEvent.click(within(one).getByRole("switch", { name: "Has a last day" }));
  expect(within(one).getByRole("combobox", { name: "Last day" })).toBeEnabled();
  expect(control(one, "Only reply to people at gmail.com")).toBeDisabled();
  expect(one).toHaveTextContent("Only for Google Workspace accounts.");
  expect(one.querySelectorAll(".settings-row").length).toBe(before);

  const work = section("me@studio.org");
  fireEvent.click(
    within(work).getByRole("switch", { name: "Vacation responder for me@studio.org" }),
  );
  expect(control(work, "Only reply to people at studio.org")).toBeEnabled();
});

test("Save sends the form to Gmail, and Discard puts Gmail's back", async () => {
  backend(null);
  render(<VacationSettings />);
  await flush();
  const one = section("me@gmail.com");
  const save = within(one).getByRole("button", { name: "Save" });
  expect(save).toBeDisabled();
  fireEvent.click(within(one).getByRole("switch", { name: "Vacation responder for me@gmail.com" }));
  fireEvent.change(within(one).getByRole("textbox", { name: "Subject" }), {
    target: { value: "Away" },
  });
  expect(one).toHaveTextContent("Not saved yet.");
  fireEvent.click(save);
  await flush();
  const sent = calls.find((c) => c.cmd === "set_vacation_responder")!;
  expect(sent.args).toMatchObject({
    accountId: "a1",
    responder: { enabled: true, subject: "Away", endMs: null, onlyDomain: false },
  });
  expect(one).toHaveTextContent("Saved to Gmail.");
  expect(useVacation.getState().accounts.a1?.value?.enabled).toBe(true);

  fireEvent.change(within(one).getByRole("textbox", { name: "Subject" }), {
    target: { value: "Gone" },
  });
  fireEvent.click(within(one).getByRole("button", { name: "Discard" }));
  expect(within(one).getByRole("textbox", { name: "Subject" })).toHaveValue("Away");
});

test("an account that hasn't allowed its mail settings is asked to sign in again", async () => {
  backend("missing");
  render(<VacationSettings />);
  await flush();
  const one = section("me@gmail.com");
  expect(one).toHaveTextContent("can't see this account's Gmail settings");
  expect(within(one).getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
});

test("a responder that's on shows in the corner, and End now turns it off in Gmail", async () => {
  backend("on");
  render(<VacationNotices />);
  await flush();
  const card = screen.getByRole("status");
  expect(card).toHaveTextContent("Vacation responder is on");
  expect(card).toHaveTextContent("me@gmail.com: “Out of office”");
  fireEvent.click(within(card).getByRole("button", { name: "End now" }));
  await flush();
  expect(calls.some((c) => c.cmd === "end_vacation_responder")).toBe(true);
  expect(screen.queryByText("Vacation responder is on")).toBeNull();
});

test("Gmail's message fills the editor once it loads, and a responder that's on enables the fields", async () => {
  backend("on");
  render(<VacationSettings />);
  await flush();
  const one = section("me@gmail.com");
  const message = await within(one).findByRole("textbox", {
    name: "Vacation message for me@gmail.com",
  });
  await waitFor(() => expect(message).toHaveTextContent("back next week"));
  expect(message).toHaveAttribute("contenteditable", "true");
  expect(within(one).getByRole("textbox", { name: "Subject" })).toHaveValue("Out of office");
  expect(within(one).getByRole("combobox", { name: "Last day" })).toBeEnabled();
  expect(within(one).getByRole("button", { name: "Save" })).toBeDisabled();
});

test("an account that can read but not change its responder is asked to sign in again on Save", async () => {
  backend("readonly");
  render(<VacationSettings />);
  await flush();
  const one = section("me@gmail.com");
  fireEvent.click(within(one).getByRole("switch", { name: "Vacation responder for me@gmail.com" }));
  fireEvent.click(within(one).getByRole("button", { name: "Save" }));
  await flush();
  expect(one).toHaveTextContent("isn't allowed to change this account's Gmail settings");
  expect(within(one).getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  expect(within(one).getByRole("button", { name: "Discard" })).toBeEnabled();

  // Signing in again closes Settings; the unsaved edit is there when it opens again.
  cleanup();
  render(<VacationSettings />);
  await flush();
  expect(
    within(section("me@gmail.com")).getByRole("switch", {
      name: "Vacation responder for me@gmail.com",
    }),
  ).toBeChecked();
});

/** Holds each account's next read until the test answers it. */
function heldReads(other?: (cmd: string) => unknown) {
  const pending = new Map<string, (value: unknown) => void>();
  mockIPC((cmd, args) => {
    if (cmd !== "get_vacation_responder") return other?.(cmd);
    const { accountId } = args as { accountId: string };
    return new Promise((resolve) => pending.set(accountId, resolve));
  });
  return (accountId: string, value: unknown) => pending.get(accountId)!(value);
}

test("the fields wait for a fresh read when the page opens, even with an earlier answer", async () => {
  backend("on");
  await useVacation.getState().refresh("a1");
  const on = useVacation.getState().accounts.a1!.value!;
  const answer = heldReads();
  render(<VacationSettings />);
  await flush();
  const one = section("me@gmail.com");
  const subject = within(one).getByRole("textbox", { name: "Subject" });
  expect(subject).toBeDisabled();
  await act(async () => answer("a1", { ...on, subject: "Newer" }));
  await flush();
  expect(subject).toBeEnabled();
  expect(subject).toHaveValue("Newer");
});

test("a read that started before End now can't turn the responder back on", async () => {
  backend("on");
  await useVacation.getState().refresh("a1");
  const on = useVacation.getState().accounts.a1!.value!;
  const answer = heldReads((cmd) =>
    cmd === "end_vacation_responder" ? { ...on, enabled: false } : undefined,
  );
  const stale = useVacation.getState().refresh("a1");
  await flush();
  await useVacation.getState().end("a1");
  answer("a1", on);
  await stale;
  expect(useVacation.getState().accounts.a1?.value?.enabled).toBe(false);
});

test("an edit put back by hand leaves no draft behind", async () => {
  backend(null);
  render(<VacationSettings />);
  await flush();
  const subject = within(section("me@gmail.com")).getByRole("textbox", { name: "Subject" });
  const on = within(section("me@gmail.com")).getByRole("switch", {
    name: "Vacation responder for me@gmail.com",
  });
  fireEvent.click(on);
  expect(useVacation.getState().drafts.a1).toBeDefined();
  fireEvent.click(on);
  expect(useVacation.getState().drafts.a1).toBeUndefined();
  expect(subject).toBeDisabled();
});

test("a form reopened while its save is on the way waits for it, and so does End now", async () => {
  backend("on");
  render(<VacationSettings />);
  await flush();
  const handlers = createVacationHandlers(accounts, "on") as Record<
    string,
    (a: unknown) => unknown
  >;
  let land!: () => void;
  mockIPC((cmd, args) =>
    cmd === "set_vacation_responder"
      ? new Promise((resolve) => (land = () => resolve(handlers[cmd]!(args))))
      : handlers[cmd]?.(args),
  );
  const toggle = () =>
    within(section("me@gmail.com")).getByRole("switch", {
      name: "Vacation responder for me@gmail.com",
    });
  // Turning it off is on its way to Gmail; meanwhile Settings is closed and opened again.
  fireEvent.click(toggle());
  fireEvent.click(within(section("me@gmail.com")).getByRole("button", { name: "Save" }));
  cleanup();
  render(
    <>
      <VacationSettings />
      <VacationNotices />
    </>,
  );
  await flush();
  expect(toggle()).toBeDisabled();
  expect(screen.getByRole("button", { name: "End now" })).toBeDisabled();
  await act(async () => land());
  await flush();
  expect(toggle()).toBeEnabled();
  expect(toggle()).not.toBeChecked();
  expect(screen.queryByRole("button", { name: "End now" })).toBeNull();
});
