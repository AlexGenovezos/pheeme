import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { NotificationsSettings } from "./NotificationsSettings";

const snapshot = {
  accounts: [{ accountId: "a", email: "a@example.com", enabled: false, asked: false }],
  permission: "system",
  trayAvailable: true,
  trayEnabled: true,
};

test("notification choices are per account and reflect the persisted backend value", async () => {
  const calls: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "desktop_settings") return snapshot;
    if (command === "set_account_notifications") {
      calls.push(args);
      return { ...snapshot, accounts: [{ ...snapshot.accounts[0], enabled: true }] };
    }
  });
  const { unmount } = render(<NotificationsSettings />);
  const toggle = await screen.findByRole("switch", { name: "Notifications for a@example.com" });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  expect(calls).toEqual([{ accountId: "a", enabled: true }]);
  expect(screen.getByText("Pheeme keeps running when you close its window")).toBeInTheDocument();
  unmount();
});

test("denied permission keeps the choice disabled and explains how to recover", async () => {
  mockIPC((command) => {
    if (command === "desktop_settings") return { ...snapshot, permission: "denied" };
    if (command === "set_account_notifications")
      throw {
        code: "desktop_settings",
        message: "Allow Pheeme in your system notification settings, then try again.",
      };
  });
  render(<NotificationsSettings />);
  const toggle = await screen.findByRole("switch", { name: "Notifications for a@example.com" });
  expect(screen.getByText("Notifications are blocked")).toBeInTheDocument();
  fireEvent.click(toggle);
  expect(await screen.findByRole("alert")).toHaveTextContent("Allow Pheeme");
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(toggle).not.toBeDisabled();
});

test("the tray icon can be turned off, and then closing the window quits", async () => {
  const calls: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "desktop_settings") return snapshot;
    if (command === "set_tray_icon") {
      calls.push(args);
      return { ...snapshot, trayEnabled: false, trayAvailable: false };
    }
  });
  render(<NotificationsSettings />);
  const toggle = await screen.findByRole("switch", {
    name: "Show icon in the menu bar or notification area",
  });
  expect(toggle).toHaveAttribute("aria-checked", "true");
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  expect(calls).toEqual([{ shown: false }]);
  expect(screen.getByText("Closing the window quits Pheeme")).toBeInTheDocument();
});

test("Settings no longer mentions marking mail read from the tray", async () => {
  mockIPC((command) => (command === "desktop_settings" ? snapshot : undefined));
  render(<NotificationsSettings />);
  await screen.findByRole("switch", { name: "Notifications for a@example.com" });
  expect(screen.queryByText(/mark .* read/i)).not.toBeInTheDocument();
});
