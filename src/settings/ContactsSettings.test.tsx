import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { GoogleContactsStatus } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { ContactsSettings, PEOPLE_API_URL } from "./ContactsSettings";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const status = (s: Partial<GoogleContactsStatus>): GoogleContactsStatus => ({
  status: "on",
  message: null,
  enableUrl: null,
  count: 0,
  syncedAt: null,
  ...s,
});

let current: Record<string, GoogleContactsStatus>;
let afterRefresh: Record<string, GoogleContactsStatus>;
let calls: Array<{ cmd: string; args: Record<string, unknown> }>;

beforeEach(() => {
  calls = [];
  current = {
    a1: status({ status: "on", count: 1234, syncedAt: Date.now() }),
    a2: status({ status: "missing_scope" }),
    a3: status({ status: "api_disabled", enableUrl: `${PEOPLE_API_URL}?project=42` }),
    a4: status({ status: "unknown" }),
  };
  afterRefresh = {
    a3: status({ status: "on", count: 5 }),
    a4: status({ status: "missing_scope" }),
  };
  useAccountStore.setState({
    accounts: ["a1", "a2", "a3", "a4"].map((id) => ({ id, email: `${id}@example.com` }) as never),
  });
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    const id = String(a.accountId);
    if (cmd === "google_contacts_status") return current[id];
    if (cmd === "refresh_google_contacts") return (current[id] = afterRefresh[id] ?? current[id]);
    return undefined;
  });
});
afterEach(() => clearMocks());

test("each account shows its Google Contacts and the steps to turn them on", async () => {
  render(<ContactsSettings />);
  await flush();
  expect(screen.getByRole("region", { name: "a1@example.com" })).toHaveTextContent(
    "On: 1,234 addresses",
  );

  const missing = screen.getByRole("region", { name: "a2@example.com" });
  expect(missing).toHaveTextContent("1. Turn on the People API");
  expect(within(missing).getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  fireEvent.click(within(missing).getByRole("button", { name: "Open People API" }));
  expect(calls.find((c) => c.cmd === "open_external")?.args).toEqual({ url: PEOPLE_API_URL });

  // The project's own People API page, then Check again turns it on.
  const disabled = screen.getByRole("region", { name: "a3@example.com" });
  fireEvent.click(within(disabled).getByRole("button", { name: "Open People API" }));
  expect(calls.filter((c) => c.cmd === "open_external")[1].args).toEqual({
    url: `${PEOPLE_API_URL}?project=42`,
  });
  fireEvent.click(within(disabled).getByRole("button", { name: "Check again" }));
  await flush();
  expect(disabled).toHaveTextContent("On: 5 addresses");

  // Never checked: the page checks straight away.
  expect(calls.some((c) => c.cmd === "refresh_google_contacts" && c.args.accountId === "a4")).toBe(
    true,
  );
  expect(screen.getByRole("region", { name: "a4@example.com" })).toHaveTextContent("Sign in again");
});
