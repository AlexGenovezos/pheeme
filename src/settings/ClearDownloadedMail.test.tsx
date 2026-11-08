import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import { ClearDownloadedMail, clearedMessage } from "./ClearDownloadedMail";

let calls: string[];

beforeEach(() => {
  calls = [];
  useToastStore.setState({ toasts: [] });
  mockIPC((command) => {
    calls.push(command);
    if (command === "clear_downloaded_mail") return { messages: 3, bytes: 30 };
  });
});

test("clearing asks first, then clears and says how much went", async () => {
  render(<ClearDownloadedMail />);
  fireEvent.click(screen.getByRole("button", { name: "Clear…" }));

  const dialog = screen.getByRole("alertdialog", { name: "Clear downloaded mail?" });
  expect(dialog).toHaveTextContent("Your conversation list and labels stay.");
  expect(calls).toEqual([]);

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() =>
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual([
      "Cleared 3 emails and 30 bytes of attachments",
    ]),
  );
  expect(calls).toEqual(["clear_downloaded_mail"]);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

test("cancelling clears nothing", () => {
  render(<ClearDownloadedMail />);
  fireEvent.click(screen.getByRole("button", { name: "Clear…" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clear…" })).toBeInTheDocument();
  expect(calls).toEqual([]);
});

test("a failure shows why", async () => {
  mockIPC(() => {
    throw { code: "internal", message: "The disk is full." };
  });
  render(<ClearDownloadedMail />);
  fireEvent.click(screen.getByRole("button", { name: "Clear…" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() =>
    expect(useToastStore.getState().toasts).toMatchObject([
      { title: "Couldn't clear downloaded mail", description: "The disk is full.", tone: "danger" },
    ]),
  );
});

test("the summary counts in plain words", () => {
  expect(clearedMessage({ messages: 1, bytes: 1 })).toBe(
    "Cleared 1 email and 1 byte of attachments",
  );
  expect(clearedMessage({ messages: 1200, bytes: 5 * 1024 * 1024 })).toBe(
    "Cleared 1,200 emails and 5 MB of attachments",
  );
});
