import { mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { SyncProgress } from "../lib/tauri";
import { MailSyncProgress, useSyncProgress } from "./MailSyncProgress";

const partial: SyncProgress = {
  accountId: "a",
  syncedMessages: 250,
  totalMessages: 1000,
  downloadedMessages: 200,
  complete: false,
};

afterEach(() => vi.useRealTimers());

test("shows mailbox progress separately from downloaded message bodies", () => {
  const { rerender } = render(
    <MailSyncProgress email="me@example.com" progress={partial} unavailable={false} />,
  );
  const bar = screen.getByRole("progressbar", { name: "Mail sync for me@example.com" });
  expect(bar).toHaveAttribute("value", "25");
  expect(screen.getByText("250 of 1,000 messages synced")).toBeInTheDocument();
  expect(screen.getByText(/200 message bodies available offline/)).toBeInTheDocument();

  rerender(
    <MailSyncProgress
      email="me@example.com"
      progress={{ ...partial, syncedMessages: 1000 }}
      unavailable={false}
    />,
  );
  expect(bar).toHaveAttribute("value", "99");
  expect(screen.queryByText("Mailbox synced")).not.toBeInTheDocument();

  rerender(
    <MailSyncProgress
      email="me@example.com"
      progress={{ ...partial, syncedMessages: 1000, complete: true }}
      unavailable={false}
    />,
  );
  expect(bar).toHaveAttribute("value", "100");
  expect(screen.getByText("Mailbox synced")).toBeInTheDocument();
});

test("unknown totals are indeterminate and an empty completed mailbox is 100%", () => {
  const { rerender } = render(
    <MailSyncProgress
      email="me@example.com"
      progress={{ ...partial, totalMessages: null }}
      unavailable={false}
    />,
  );
  const bar = screen.getByRole("progressbar");
  expect(bar).not.toHaveAttribute("value");
  expect(screen.getByText(/Counting mail/)).toBeInTheDocument();
  rerender(
    <MailSyncProgress
      email="me@example.com"
      progress={{ ...partial, syncedMessages: 0, totalMessages: 0, complete: true }}
      unavailable={false}
    />,
  );
  expect(bar).toHaveAttribute("value", "100");
});

function LiveProgress() {
  const { progress, unavailable } = useSyncProgress();
  return (
    <MailSyncProgress email="me@example.com" progress={progress?.[0]} unavailable={unavailable} />
  );
}

test("loads saved progress, updates while open, retries failures and stops on unmount", async () => {
  vi.useFakeTimers();
  let calls = 0;
  mockIPC((command) => {
    expect(command).toBe("get_sync_progress");
    calls++;
    if (calls === 2) throw new Error("offline");
    return [{ ...partial, syncedMessages: calls === 1 ? 250 : 500 }];
  });
  const { unmount } = render(<LiveProgress />);
  await act(async () => {});
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "25");
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByText("Sync progress unavailable. Retrying…")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "50");
  expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(calls).toBe(3);
});

test("unmount while IPC is pending does not schedule another request", async () => {
  vi.useFakeTimers();
  let resolve!: (value: SyncProgress[]) => void;
  const ipc = vi.fn(
    () =>
      new Promise<SyncProgress[]>((done) => {
        resolve = done;
      }),
  );
  mockIPC(ipc);
  const { unmount } = render(<LiveProgress />);
  unmount();
  await act(async () => {
    resolve([partial]);
  });
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(ipc).toHaveBeenCalledTimes(1);
});
