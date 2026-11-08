import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useAccountStore } from "../store/accountStore";
import { useInboxTabs } from "../store/inboxTabsStore";
import { InboxTabsSettings } from "./InboxTabsSettings";

beforeEach(() => {
  useInboxTabs.setState({ hidden: {} });
  useAccountStore.setState({
    accounts: [{ id: "a", email: "a@example.com", displayName: null, clientId: "c", synced: true }],
    loaded: true,
  });
});

test("toggling a tab saves the hidden list; Primary is on and disabled", async () => {
  const calls: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "set_inbox_tabs") {
      calls.push(args);
      return (args as { hidden: string[] }).hidden;
    }
  });
  render(<InboxTabsSettings />);
  const primary = screen.getByRole("switch", { name: "Primary for a@example.com" });
  expect(primary).toBeDisabled();
  expect(primary).toHaveAttribute("aria-checked", "true");
  const promotions = screen.getByRole("switch", { name: "Promotions for a@example.com" });
  fireEvent.click(promotions);
  await waitFor(() => expect(promotions).toHaveAttribute("aria-checked", "false"));
  expect(calls).toEqual([{ accountId: "a", hidden: ["CATEGORY_PROMOTIONS"] }]);
});

test("a failed save reverts the switch and shows the error", async () => {
  mockIPC((command) => {
    if (command === "set_inbox_tabs") throw { code: "db", message: "Could not save." };
  });
  render(<InboxTabsSettings />);
  const social = screen.getByRole("switch", { name: "Social for a@example.com" });
  fireEvent.click(social);
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save.");
  expect(social).toHaveAttribute("aria-checked", "true");
});
