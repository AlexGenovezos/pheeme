import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { dismissToast, useToastStore } from "../components/ui/Toast";
import { useAccountStore } from "../store/accountStore";
import { DriveDialog } from "./DriveDialog";
import { type DriveFile, driveFileUrl } from "./api";

const file: DriveFile = {
  id: "report",
  name: "Report <draft>",
  mimeType: "application/pdf",
  size: "512",
  modifiedTime: null,
  resourceKey: "private/key",
};

beforeEach(() => {
  useToastStore.getState().toasts.forEach((t) => dismissToast(t.id));
  useAccountStore.setState({
    accounts: [
      { id: "a", email: "me@example.com", displayName: null, clientId: "c", synced: true },
    ],
  });
});

test("search, pagination, and multi-selection preserve a file's resource key", async () => {
  const pick = vi.fn();
  const close = vi.fn();
  const calls: Record<string, unknown>[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== "drive_files") return;
    const a = args as Record<string, unknown>;
    calls.push(a);
    if (a.pageToken === "more")
      return { files: [{ ...file, id: "second", name: "Second" }], nextPageToken: null };
    return { files: [file], nextPageToken: "more" };
  });
  render(<DriveDialog accountId="a" onClose={close} onPick={pick} />);
  fireEvent.click(await screen.findByRole("button", { name: /Report <draft>/ }));
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  fireEvent.click(await screen.findByRole("button", { name: /Second/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search Drive files" }), {
    target: { value: "Quarterly" },
  });
  await waitFor(() =>
    expect(
      calls.some((a) => a.accountId === "a" && a.query === "Quarterly" && a.pageToken === null),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Insert 2 links" }));
  expect(pick.mock.calls[0][0].map((f: DriveFile) => f.id)).toEqual(["report", "second"]);
  expect(driveFileUrl(pick.mock.calls[0][0][0])).toBe(
    "https://drive.google.com/file/d/report/view?resourcekey=private%2Fkey",
  );
  expect(close).toHaveBeenCalledOnce();
});

test("missing Drive access is requested for the selected account and closing cancels OAuth", async () => {
  const calls = vi.fn();
  mockIPC((cmd, args) => {
    calls(cmd, args);
    if (cmd === "drive_files") throw { code: "missing_scope", message: "Allow Drive access." };
    if (cmd === "begin_oauth")
      return { flowId: "drive-flow", authUrl: "https://accounts.google.com/auth" };
    if (cmd === "complete_oauth") return new Promise(() => {});
  });
  const view = render(<DriveDialog accountId="auth-account" onClose={vi.fn()} onPick={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Allow Drive access" }));
  await screen.findByRole("button", { name: "Cancel sign-in" });
  expect(calls).toHaveBeenCalledWith("begin_oauth", {
    client: { kind: "drive", accountId: "auth-account" },
  });
  view.unmount();
  await waitFor(() => expect(calls).toHaveBeenCalledWith("cancel_oauth", { flowId: "drive-flow" }));
});

test("a late search result cannot replace a newer search", async () => {
  let finish!: (page: unknown) => void;
  mockIPC((cmd, args) => {
    if (cmd !== "drive_files") return;
    if ((args as { query: string }).query === "old")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return { files: [{ ...file, name: "New result" }], nextPageToken: null };
  });
  render(<DriveDialog accountId="search-account" onClose={vi.fn()} onPick={vi.fn()} />);
  const search = screen.getByRole("textbox", { name: "Search Drive files" });
  fireEvent.change(search, { target: { value: "old" } });
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.change(search, { target: { value: "new" } });
  await screen.findByRole("button", { name: /New result/ });
  await act(async () => finish({ files: [{ ...file, name: "Old result" }], nextPageToken: null }));
  expect(screen.queryByRole("button", { name: /Old result/ })).not.toBeInTheDocument();
});

test("saving stays busy, prevents repeat uploads, and reports an uncertain result without retrying", async () => {
  let fail!: (e: unknown) => void;
  const save = vi.fn(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const close = vi.fn();
  mockIPC((cmd) => {
    if (cmd === "drive_files") return { files: [], nextPageToken: null };
    if (cmd === "save_attachment_to_drive") return save();
  });
  render(
    <DriveDialog
      accountId="save-account"
      messageId="m"
      attachment={{
        id: "att",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 42,
        isInline: false,
        contentId: null,
      }}
      onClose={close}
    />,
  );
  const dialog = screen.getByRole("dialog");
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Save to My Drive" })).toBeEnabled(),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Save to My Drive" }));
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  await act(async () =>
    fail({ code: "upload_unconfirmed", message: "Check My Drive before saving again." }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Check My Drive before saving again.");
  expect(save).toHaveBeenCalledOnce();
});

test("an account that allowed browsing can grant upload access and retry the explicit save", async () => {
  let allowed = false;
  let finish!: (account: unknown) => void;
  const close = vi.fn();
  mockIPC((cmd) => {
    if (cmd === "drive_files") return { files: [], nextPageToken: null };
    if (cmd === "save_attachment_to_drive") {
      if (!allowed) throw { code: "missing_scope", message: "Allow Drive access." };
      return file;
    }
    if (cmd === "begin_oauth")
      return { flowId: "upload-flow", authUrl: "https://accounts.google.com/auth" };
    if (cmd === "complete_oauth")
      return new Promise((resolve) => {
        finish = resolve;
      });
  });
  render(
    <DriveDialog
      accountId="partial-scope"
      messageId="m"
      attachment={{
        id: "att",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 42,
        isInline: false,
        contentId: null,
      }}
      onClose={close}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save to My Drive" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save to My Drive" }));
  fireEvent.click(await screen.findByRole("button", { name: "Allow Drive access" }));
  await waitFor(() => expect(finish).toBeDefined());
  expect(screen.getByRole("button", { name: "Save to My Drive" })).toBeDisabled();
  allowed = true;
  await act(async () => finish({ id: "partial-scope", email: "me@example.com" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save to My Drive" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save to My Drive" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
