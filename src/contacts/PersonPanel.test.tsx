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
import { PersonPanel } from "./PersonPanel";
import type { PersonProfile } from "./api";

const profile: PersonProfile = {
  address: "ada@example.com",
  name: "Ada",
  saved: false,
  conversations: [{ id: "thread", subject: "Shared plans", snippet: null, date: Date.now() }],
  events: [],
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
  fireEvent.click(await screen.findByRole("button", { name: "Save to Google Contacts" }));
  fireEvent.click(await screen.findByRole("button", { name: "Allow saving contacts" }));
  await waitFor(() => expect(allowed).toBe(true));
  expect(calls).toHaveBeenCalledWith("begin_oauth", {
    client: { kind: "contacts", accountId: "a" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save to Google Contacts" }));
  await waitFor(() => expect(finish).toBeDefined());
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Saved contact" })).not.toBeInTheDocument();
  await act(async () => finish());
  expect(await screen.findByRole("button", { name: "Saved contact" })).toBeDisabled();
});
