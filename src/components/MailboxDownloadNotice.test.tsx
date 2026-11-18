import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AccountInfo, SyncProgress } from "../lib/tauri";
import { useSettingsStore } from "../settings/settingsStore";
import { useAccountStore } from "../store/accountStore";
import { __resetDownloadForTests, useDownloadStore } from "../store/downloadStore";
import { MailboxDownloadNotice } from "./MailboxDownloadNotice";

const account = (id: string, email: string): AccountInfo => ({
  id,
  email,
  displayName: null,
  clientId: "c.apps.googleusercontent.com",
  synced: true,
  color: 1,
});
const row = (accountId: string, synced: number, total: number | null, complete = false) =>
  ({
    accountId,
    syncedMessages: synced,
    totalMessages: total,
    downloadedMessages: synced,
    complete,
  }) satisfies SyncProgress;

beforeEach(() => {
  __resetDownloadForTests();
  useAccountStore.setState({
    accounts: [account("a", "me@home.test"), account("b", "me@work.test")],
    slowSync: {},
  });
});
afterEach(() => __resetDownloadForTests());

test("nothing shows until a download is known to be running", () => {
  const { container, rerender } = render(<MailboxDownloadNotice />);
  expect(container).toBeEmptyDOMElement();
  useDownloadStore.setState({ progress: [row("a", 10, 10, true)] });
  rerender(<MailboxDownloadNotice />);
  expect(container).toBeEmptyDOMElement();
});

test("shows how far one account's download is, naming the account", () => {
  useDownloadStore.setState({ progress: [row("a", 12340, 29100), row("b", 5, 5, true)] });
  render(<MailboxDownloadNotice />);
  expect(screen.getByText("Downloading your mailbox")).toBeInTheDocument();
  expect(screen.getByText("42%")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "Mailbox download" })).toHaveAttribute(
    "value",
    "42",
  );
  expect(screen.getByText(/of 29,100 messages · me@home\.test$/)).toBeInTheDocument();
  expect(screen.getByText("You can keep using Pheeme meanwhile.")).toBeInTheDocument();
});

test("combines several accounts, and keeps every line while the size is still unknown", () => {
  useDownloadStore.setState({ progress: [row("a", 100, null), row("b", 50, 1000)] });
  render(<MailboxDownloadNotice />);
  expect(screen.getByText("150 messages · Counting mail… · 2 accounts")).toBeInTheDocument();
  expect(document.querySelector(".mailbox-download__percent")).toHaveTextContent("");
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
});

test("says when Gmail is slowing the download", () => {
  useAccountStore.setState({ slowSync: { a: { contended: false, since: 0 } } });
  useDownloadStore.setState({ progress: [row("a", 10, 100)] });
  render(<MailboxDownloadNotice />);
  expect(
    screen.getByText("Gmail is slowing the download. It carries on by itself."),
  ).toBeInTheDocument();
});

test("Details opens Settings › Accounts, and closing hides the card", () => {
  useDownloadStore.setState({ progress: [row("a", 10, 100)] });
  render(<MailboxDownloadNotice />);
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(useSettingsStore.getState()).toMatchObject({ open: true, page: "accounts" });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByText("Downloading your mailbox")).not.toBeInTheDocument();
});

test("a closed card comes back when another account starts downloading", () => {
  useDownloadStore.setState({ progress: [row("a", 10, 100)], dismissed: ["a"] });
  const { rerender } = render(<MailboxDownloadNotice />);
  expect(screen.queryByText("Downloading your mailbox")).not.toBeInTheDocument();
  useDownloadStore.setState({ progress: [row("a", 20, 100), row("b", 0, null)] });
  rerender(<MailboxDownloadNotice />);
  expect(screen.getByText("Downloading your mailbox")).toBeInTheDocument();
});

test("says the mailbox is downloaded, in the same lines", () => {
  useDownloadStore.setState({
    progress: [row("a", 29100, 29100, true)],
    finished: { total: 29100 },
  });
  render(<MailboxDownloadNotice />);
  expect(screen.getByText("Mailbox downloaded")).toBeInTheDocument();
  expect(screen.getByText("100%")).toBeInTheDocument();
  expect(screen.getByText("29,100 messages")).toBeInTheDocument();
});
