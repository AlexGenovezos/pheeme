import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useComposeStore, __resetComposeStoreForTests } from "../compose/composeStore";
import { useAccountStore } from "../store/accountStore";
import { __resetMailStoreForTests, useMailStore } from "../store/mailStore";
import { __resetThreadStoreForTests } from "../store/threadStore";
import { __resetUiStoreForTests, useUiStore } from "../store/uiStore";
import { createPreviewHandlers } from "../preview/install";
import { threadKey } from "../mail/mailboxes";
import { EventPopover } from "../calendar/EventPopover";
import { useCalendarStore } from "../calendar/calendarStore";
import { useEditStore } from "../calendar/editStore";
import { createCalendarHandlers } from "../preview/calendar";
import type { CalendarEvent } from "../lib/tauri";
import { PersonHost, PersonPanel } from "./PersonPanel";
import { usePersonStore } from "./personStore";
import type { PersonProfile } from "./api";

const profile: PersonProfile = {
  address: "ada@example.com",
  name: "Ada",
  saved: false,
  phone: null,
  organization: null,
  photoUrl: null,
  conversations: [{ id: "thread", subject: "Shared plans", snippet: null, date: Date.now() }],
  events: [],
  pastEvents: [],
  calendarAvailable: true,
};

beforeEach(() => {
  __resetComposeStoreForTests();
  __resetMailStoreForTests();
  __resetThreadStoreForTests();
  __resetUiStoreForTests();
  useAccountStore.setState({
    accounts: [
      { id: "a", email: "me@example.com", displayName: null, clientId: "c", synced: true },
    ],
  });
});

test("opening an unread conversation outside the current list marks it read", async () => {
  const handlers = createPreviewHandlers();
  const mutations = vi.fn();
  useMailStore.setState({ threads: [], query: null });
  mockIPC((cmd, args) => {
    if (cmd === "person_profile")
      return { ...profile, conversations: [{ ...profile.conversations[0], id: "p-01" }] };
    if (cmd === "modify_threads") mutations(args);
    return handlers[cmd]?.(args as Record<string, unknown>);
  });
  const close = vi.fn();
  render(
    <PersonPanel
      accountId="acc-personal"
      person={{ address: "mira@example.net", name: "Mira" }}
      onClose={close}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Shared plans/ }));
  expect(useUiStore.getState().openThread).toBe(threadKey("acc-personal", "p-01"));
  await waitFor(() =>
    expect(mutations).toHaveBeenCalledWith({
      accountId: "acc-personal",
      threadIds: ["p-01"],
      add: [],
      remove: ["UNREAD"],
    }),
  );
  expect(close).toHaveBeenCalledOnce();
});

test("opens cached context for the chosen account and composes to that person", async () => {
  const calls = vi.fn();
  mockIPC((cmd, args) => {
    calls(cmd, args);
    if (cmd === "person_profile") return profile;
  });
  const close = vi.fn();
  render(
    <PersonPanel
      accountId="a"
      person={{ address: profile.address, name: "Ada" }}
      onClose={close}
    />,
  );
  expect(await screen.findByRole("button", { name: /Shared plans/ })).toBeInTheDocument();
  expect(calls).toHaveBeenCalledWith(
    "person_profile",
    expect.objectContaining({ accountId: "a", address: profile.address }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Email" }));
  expect(useComposeStore.getState().windows[0]).toMatchObject({
    accountId: "a",
    draft: { to: [{ name: "Ada", address: profile.address }] },
  });
  expect(close).toHaveBeenCalledOnce();
});

test("saving a sender requires separate consent and never claims success before Google responds", async () => {
  let finish!: () => void;
  let allowed = false;
  const calls = vi.fn();
  mockIPC((cmd, args) => {
    calls(cmd, args);
    if (cmd === "person_profile") return profile;
    if (cmd === "save_person_contact") {
      if (!allowed) throw { code: "missing_scope", message: "Allow saving contacts." };
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    if (cmd === "begin_oauth")
      return { flowId: "contacts-flow", authUrl: "https://accounts.google.com/auth" };
    if (cmd === "complete_oauth") {
      allowed = true;
      return { id: "a", email: "me@example.com" };
    }
  });
  render(
    <PersonPanel
      accountId="a"
      person={{ address: profile.address, name: "Ada" }}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Save contact" }));
  fireEvent.click(await screen.findByRole("button", { name: "Allow saving contacts" }));
  await waitFor(() => expect(allowed).toBe(true));
  expect(calls).toHaveBeenCalledWith("begin_oauth", {
    client: { kind: "contacts", accountId: "a" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save contact" }));
  await waitFor(() => expect(finish).toBeDefined());
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Saved" })).not.toBeInTheDocument();
  await act(async () => finish());
  expect(await screen.findByRole("button", { name: "Saved" })).toBeDisabled();
});

test("shows who they are and meetings both ways", async () => {
  const handlers = createCalendarHandlers([{ id: "a", email: "me@example.com" }], null);
  const [soon, earlier] = (
    handlers.calendar_events({ fromMs: 0, toMs: Date.now() * 2 }) as CalendarEvent[]
  ).filter((e) => !e.allDay);
  mockIPC((cmd) => {
    if (cmd === "person_profile")
      return {
        ...profile,
        saved: true,
        organization: "Programmer at Analytical Engines",
        phone: "+44 20 7946 0000",
        events: [{ ...soon, summary: "Planning together" }],
        pastEvents: [{ ...earlier, summary: "Last review" }],
      };
  });
  render(
    <PersonPanel
      accountId="a"
      person={{ address: profile.address, name: null }}
      onClose={vi.fn()}
    />,
  );
  expect(
    await screen.findByText("Programmer at Analytical Engines · +44 20 7946 0000"),
  ).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Ada" })).toHaveTextContent("A");
  expect(screen.getByRole("button", { name: /Planning together/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Last review/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
});

test("says whether an unknown person is in your contacts, and copies their address", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  mockIPC((cmd) => (cmd === "person_profile" ? profile : undefined));
  render(
    <PersonPanel
      accountId="a"
      person={{ address: profile.address, name: "Ada" }}
      onClose={vi.fn()}
    />,
  );
  expect(await screen.findByText("Not in your Google Contacts")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
  expect(writeText).toHaveBeenCalledWith(profile.address);
});

test("New event opens the editor in Calendar with them invited", async () => {
  const handlers = createPreviewHandlers();
  mockIPC((cmd, args) =>
    cmd === "person_profile" ? profile : handlers[cmd]?.(args as Record<string, unknown>),
  );
  useCalendarStore.setState({ accounts: null, mode: "mail" });
  useEditStore.setState({ editor: null, draft: null });
  const close = vi.fn();
  render(
    <PersonPanel
      accountId="acc-personal"
      person={{ address: "ada@example.com", name: "Ada" }}
      onClose={close}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "New event" }));
  expect(close).toHaveBeenCalledOnce();
  await waitFor(() => expect(useEditStore.getState().editor).not.toBeNull());
  expect(useCalendarStore.getState().mode).toBe("calendar");
  expect(useEditStore.getState().editor?.form).toMatchObject({
    accountId: "acc-personal",
    guests: [{ name: "Ada", address: "ada@example.com", optional: false }],
  });
});

test("a guest in the event popover opens their card in place of the popover", async () => {
  const accounts = [
    { id: "acc-personal", email: "avery@example.com" },
    { id: "acc-work", email: "avery@example.org" },
  ];
  const handlers = createCalendarHandlers(accounts, null);
  const review = (
    handlers.calendar_events({ fromMs: 0, toMs: Date.now() * 2 }) as CalendarEvent[]
  ).find((e) => e.id === "design-review")!;
  const calls = vi.fn();
  mockIPC((cmd, args) => {
    calls(cmd, args);
    if (cmd === "person_profile") return { ...profile, address: "priya@example.org" };
    return (handlers as Record<string, (a?: unknown) => unknown>)[cmd]?.(args);
  });
  usePersonStore.setState({ open: null });
  useCalendarStore.setState({ open: { event: review, anchor: null } });
  render(
    <>
      <EventPopover />
      <PersonHost />
    </>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "View contact Priya Raman" }));
  expect(useCalendarStore.getState().open).toBeNull();
  expect(await screen.findByRole("dialog", { name: "Priya Raman" })).toBeInTheDocument();
  expect(calls).toHaveBeenCalledWith(
    "person_profile",
    expect.objectContaining({ accountId: "acc-work", address: "priya@example.org" }),
  );
  // The organizer opens theirs too; you don't have a card.
  act(() => usePersonStore.getState().close());
  useCalendarStore.setState({ open: { event: review, anchor: null } });
  expect(
    await screen.findByRole("button", { name: "View contact morgan@example.org" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /avery@example.org/ })).not.toBeInTheDocument();
});
