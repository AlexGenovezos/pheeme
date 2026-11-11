import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ToastProvider, useToastStore } from "../components/ui/Toast";
import { useAccountStore } from "../store/accountStore";
import { NotificationOffer } from "./NotificationOffer";
import { resetNotificationPrompt, useNotificationPrompt } from "./prompt";

const settings = (asked: boolean) => ({
  accounts: [{ accountId: "a", email: "a@example.com", enabled: false, asked }],
  permission: "notDetermined",
  trayAvailable: true,
  trayEnabled: true,
});

function Host() {
  useNotificationPrompt();
  return (
    <>
      <NotificationOffer />
      <ToastProvider />
    </>
  );
}

beforeEach(() => {
  useAccountStore.setState({ accounts: [{ id: "a", email: "a@example.com" }] as never });
});
afterEach(() => {
  resetNotificationPrompt();
  useToastStore.setState({ toasts: [] });
});

test("prompts for an account that hasn't been asked and turns notifications on", async () => {
  const answers: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "desktop_settings") return settings(false);
    if (command === "answer_notification_prompt") {
      answers.push(args);
      return settings(true);
    }
  });
  render(<Host />);
  expect(await screen.findByText("New mail alerts")).toBeInTheDocument();
  expect(screen.getByText(/a@example\.com/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  await waitFor(() => expect(answers).toEqual([{ enable: true }]));
  expect(await screen.findByText("Notifications are on")).toBeInTheDocument();
});

test("Not now records the answer so it isn't asked again", async () => {
  const answers: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "desktop_settings") return settings(false);
    if (command === "answer_notification_prompt") {
      answers.push(args);
      return settings(true);
    }
  });
  render(<Host />);
  await screen.findByText("New mail alerts");
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  await waitFor(() => expect(answers).toEqual([{ enable: false }]));
  expect(screen.queryByText("New mail alerts")).not.toBeInTheDocument();
});

test("a blocked permission explains how to recover", async () => {
  mockIPC((command) => {
    if (command === "desktop_settings") return settings(false);
    if (command === "answer_notification_prompt")
      throw { code: "desktop_settings", message: "Notifications are blocked." };
  });
  render(<Host />);
  await screen.findByText("New mail alerts");
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Notifications are blocked.");
});

test("doesn't prompt once every account has been asked", async () => {
  let reads = 0;
  mockIPC((command) => {
    if (command === "desktop_settings") {
      reads++;
      return settings(true);
    }
  });
  render(<Host />);
  await waitFor(() => expect(reads).toBe(1));
  expect(screen.queryByText("New mail alerts")).not.toBeInTheDocument();
});
