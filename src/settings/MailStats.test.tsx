import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useToastStore } from "../components/ui/Toast";
import { useComposeStore } from "../compose/composeStore";
import type { MailStats, SenderStats, Unsubscribed } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import {
  __resetUnsubscribedForTests,
  buckets,
  dayKey,
  MailStatsSettings,
  parseMailto,
  percent,
  rate,
  windowStart,
} from "./MailStats";
import { useSettingsStore } from "./settingsStore";

const counts = (received: number, opened: number, replied = 0, starred = 0) => ({
  received,
  opened,
  replied,
  starred,
  engaged: opened + replied,
});

const sender = (over: Partial<SenderStats>): SenderStats => ({
  accountId: "a",
  threadId: "t1",
  sender: "deals@shop.com",
  name: "Shop",
  tab: "promotions",
  unsubscribe: "one_click",
  lastDate: 0,
  ...counts(12, 0),
  ...over,
});

function stats(): MailStats {
  const today = dayKey(new Date());
  return {
    since: 0,
    complete: true,
    totals: counts(60, 30, 3, 6),
    days: [{ day: today, ...counts(60, 30, 3, 6) }],
    tabs: [
      { id: "primary", name: "Primary", ...counts(20, 18) },
      { id: "promotions", name: "Promotions", ...counts(30, 3) },
      { id: "social", name: "Social", ...counts(0, 0) },
      { id: "updates", name: "Updates", ...counts(10, 9) },
      { id: "forums", name: "Forums", ...counts(0, 0) },
      { id: "spam", name: "Spam", ...counts(0, 0) },
    ],
    labels: [{ id: "Receipts", name: "Receipts", ...counts(4, 4) }],
    senders: [
      sender({}),
      sender({ sender: "news@x.com", name: null, threadId: "t2", unsubscribe: "link" }),
      sender({ sender: "list@y.com", name: "List", threadId: "t3", unsubscribe: "email" }),
      sender({ sender: "bank@z.com", name: "Bank", threadId: "t4", unsubscribe: "none" }),
    ],
  };
}

const unsubscribed: Record<string, Unsubscribed> = {
  t1: {
    sender: "deals@shop.com",
    method: "one_click",
    unsubscribed: true,
    web: null,
    mailto: null,
  },
  t2: {
    sender: "news@x.com",
    method: "link",
    unsubscribed: false,
    web: "https://x.com/leave",
    mailto: null,
  },
  t3: {
    sender: "list@y.com",
    method: "email",
    unsubscribed: false,
    web: null,
    mailto: "mailto:leave@y.com?subject=Remove%20me",
  },
};

let calls: { cmd: string; args: Record<string, unknown> }[];

beforeEach(() => {
  calls = [];
  __resetUnsubscribedForTests();
  useToastStore.setState({ toasts: [] });
  useAccountStore.setState({
    accounts: [
      { id: "a", email: "a@example.com", displayName: null, clientId: "c", synced: true },
      { id: "b", email: "b@example.com", displayName: null, clientId: "c", synced: true },
    ],
    loaded: true,
  });
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === "mail_stats") return stats();
    if (cmd === "unsubscribe_sender")
      return unsubscribed[String((args as { threadId: string }).threadId)];
  });
});

test("shows the totals, where mail lands and who sends the most", async () => {
  const { container } = render(<MailStatsSettings />);
  await screen.findByText("60 emails in 30 days");
  const tiles = [...container.querySelectorAll(".settings-stats__tile")].map((t) => t.textContent);
  // 60 emails over 30 days is 2 a day.
  expect(tiles).toEqual(["2received a day", "50%opened", "5%replied to", "10%starred"]);
  expect(screen.getByText("60 emails in 30 days")).toBeInTheDocument();
  expect(screen.getByText("Receipts")).toBeInTheDocument();

  const table = screen.getByRole("table");
  const shop = within(table).getByText("Shop").closest("tr")!;
  expect(shop).toHaveTextContent("Promotions");
  expect(shop).toHaveTextContent("2.8"); // 12 in 30 days is 2.8 a week
  expect(shop).toHaveTextContent("0%");
  expect(within(table).getByText("Bank").closest("tr")).toHaveTextContent("No unsubscribe");

  const first = calls.find((c) => c.cmd === "mail_stats")!;
  expect(first.args).toEqual({ accountId: null, sinceMs: windowStart(30).getTime() });
});

test("changing the range or account asks again", async () => {
  render(<MailStatsSettings />);
  await screen.findByText("60 emails in 30 days");
  fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
  await screen.findByText("60 emails in 7 days");
  expect(calls.filter((c) => c.cmd === "mail_stats").at(-1)!.args).toEqual({
    accountId: null,
    sinceMs: windowStart(7).getTime(),
  });
});

test("one-click unsubscribes say so and don't offer it again", async () => {
  render(<MailStatsSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Unsubscribe from Shop" }));
  await screen.findByText("Unsubscribed");
  expect(calls.find((c) => c.cmd === "unsubscribe_sender")!.args).toEqual({
    accountId: "a",
    threadId: "t1",
  });
  expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(["Unsubscribed from Shop"]);
});

test("a sender that unsubscribes by link opens it", async () => {
  render(<MailStatsSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Unsubscribe from news@x.com" }));
  await waitFor(() =>
    expect(calls.find((c) => c.cmd === "open_mail_link")?.args).toEqual({
      url: "https://x.com/leave",
    }),
  );
});

test("a sender that unsubscribes by email gets a message ready to send", async () => {
  useSettingsStore.setState({ open: true });
  render(<MailStatsSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Unsubscribe from List" }));
  await waitFor(() => expect(useSettingsStore.getState().open).toBe(false));
  const panel = useComposeStore.getState().windows.at(-1)!;
  expect(panel.draft.to).toEqual([{ name: null, address: "leave@y.com" }]);
  expect(panel.draft.subject).toBe("Remove me");
});

test("days without mail are empty bars; a year goes by week", () => {
  const start = new Date(2026, 9, 1);
  const days = buckets({ days: [{ day: "2026-10-02", ...counts(5, 2) }] }, start, 3);
  expect(days.map((b) => [b.length, b.received, b.engaged])).toEqual([
    [1, 0, 0],
    [1, 5, 2],
    [1, 0, 0],
  ]);
  const weeks = buckets({ days: [{ day: "2026-10-02", ...counts(5, 2) }] }, start, 365);
  expect(weeks).toHaveLength(53);
  expect(weeks[0]).toMatchObject({ length: 7, received: 5 });
  expect(weeks.at(-1)!.length).toBe(1);
});

test("numbers read plainly", () => {
  expect(percent(0, 0)).toBe("–");
  expect(percent(1, 300)).toBe("<1%");
  expect(percent(1, 3)).toBe("33%");
  expect(rate(60, 30)).toBe("2");
  expect(rate(12, 30, 7)).toBe("2.8");
  expect(rate(1, 365)).toBe("<0.1");
  expect(rate(1200, 30, 7)).toBe("280");
  expect(parseMailto("mailto:a@b.com")).toEqual({
    to: "a@b.com",
    subject: "unsubscribe",
    body: "",
  });
  expect(parseMailto("mailto:a%40b.com?subject=Stop&body=Please")).toEqual({
    to: "a@b.com",
    subject: "Stop",
    body: "Please",
  });
  expect(parseMailto("https://x.com")).toBeNull();
});
