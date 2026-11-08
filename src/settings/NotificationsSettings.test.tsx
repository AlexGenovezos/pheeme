import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import { useNotificationPrompt } from "../desktop/prompt";
import { useAccountStore } from "../store/accountStore";
import { NotificationsSettings } from "./NotificationsSettings";

const snapshot = {
  accounts: [{ accountId: "a", email: "a@example.com", enabled: false, asked: false }],
  permission: "system",
  trayAvailable: true,
  trayEnabled: true,
  schedule: { mode: "always", startHour: 9, endHour: 17, weekdaysOnly: true },
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

test("answering in Settings dismisses a visible first-run prompt", async () => {
  mockIPC((command) => {
    if (command === "desktop_settings") return snapshot;
    if (command === "set_account_notifications")
      return { ...snapshot, accounts: [{ ...snapshot.accounts[0], enabled: true, asked: true }] };
    if (command === "answer_notification_prompt") return snapshot;
  });
  useAccountStore.setState({ accounts: [{ id: "a", email: "a@example.com" }] as never });
  function Prompt() {
    useNotificationPrompt();
    return null;
  }
  render(
    <>
      <Prompt />
      <NotificationsSettings />
    </>,
  );
  await waitFor(() =>
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain("Turn on notifications?"),
  );
  fireEvent.click(await screen.findByRole("switch", { name: "Notifications for a@example.com" }));
  await waitFor(() => expect(useToastStore.getState().toasts).toEqual([]));
});

test("a blocked permission in Settings also dismisses the first-run prompt", async () => {
  let asked = false;
  mockIPC((command) => {
    if (command === "desktop_settings")
      return { ...snapshot, accounts: [{ ...snapshot.accounts[0], asked }] };
    if (command === "set_account_notifications") {
      asked = true;
      throw { code: "desktop_settings", message: "Notifications are blocked." };
    }
  });
  useAccountStore.setState({ accounts: [{ id: "a", email: "a@example.com" }] as never });
  function Prompt() {
    useNotificationPrompt();
    return null;
  }
  render(
    <>
      <Prompt />
      <NotificationsSettings />
    </>,
  );
  await waitFor(() =>
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain("Turn on notifications?"),
  );
  fireEvent.click(await screen.findByRole("switch", { name: "Notifications for a@example.com" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Notifications are blocked.");
  await waitFor(() => expect(useToastStore.getState().toasts).toEqual([]));
});

test("work hours shows the hour pickers and saves the schedule; any time hides them", async () => {
  const calls: unknown[] = [];
  let current = snapshot;
  mockIPC((command, args) => {
    if (command === "desktop_settings") return current;
    if (command === "set_notification_schedule") {
      calls.push(args);
      current = {
        ...snapshot,
        schedule: (args as { schedule: typeof snapshot.schedule }).schedule,
      };
      return current;
    }
  });
  render(<NotificationsSettings />);
  await screen.findByRole("radiogroup", { name: "When to alert" });
  expect(screen.queryByRole("combobox", { name: "From" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Work hours" }));
  const from = await screen.findByRole("combobox", { name: "From" });
  expect(calls).toEqual([
    { schedule: { mode: "workHours", startHour: 9, endHour: 17, weekdaysOnly: true } },
  ]);
  expect(from).toHaveValue("9");
  expect(screen.getByRole("combobox", { name: "Until" })).toHaveValue("17");
  expect(screen.getByRole("switch", { name: "Weekdays only" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "09:00", selected: true })).toBeInTheDocument();
  fireEvent.change(from, { target: { value: "8" } });
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toEqual({
    schedule: { mode: "workHours", startHour: 8, endHour: 17, weekdaysOnly: true },
  });
  fireEvent.click(screen.getByRole("radio", { name: "Any time" }));
  await waitFor(() =>
    expect(screen.queryByRole("combobox", { name: "From" })).not.toBeInTheDocument(),
  );
});

test("the schedule can't be changed again while a save is in flight", async () => {
  const calls: unknown[] = [];
  let finish = () => {};
  mockIPC((command, args) => {
    if (command === "desktop_settings") return snapshot;
    if (command === "set_notification_schedule") {
      calls.push(args);
      return new Promise((resolve) => {
        finish = () =>
          resolve({ ...snapshot, schedule: { ...snapshot.schedule, mode: "workHours" } });
      });
    }
  });
  render(<NotificationsSettings />);
  await screen.findByRole("radiogroup", { name: "When to alert" });
  fireEvent.click(screen.getByRole("radio", { name: "Work hours" }));
  await waitFor(() => expect(screen.getByRole("radio", { name: "Off" })).toBeDisabled());
  fireEvent.click(screen.getByRole("radio", { name: "Off" }));
  expect(calls).toHaveLength(1);
  finish();
  await waitFor(() => expect(screen.getByRole("radio", { name: "Off" })).not.toBeDisabled());
});
