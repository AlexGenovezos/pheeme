import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { QuotaMinute, QuotaUsage } from "../lib/tauri";
import { previewQuotaUsage } from "../preview/quota";
import {
  GmailQuotaUsage,
  QUOTA_REFRESH_MS,
  QuotaUsageChart,
  summarizeQuota,
  useQuotaUsage,
} from "./QuotaUsage";

const NOW = Date.UTC(2026, 10, 11, 10, 30, 20);

function quiet(limitPerMinute = 6_000): QuotaUsage {
  const current = Math.floor(NOW / 60_000);
  return {
    limitPerMinute,
    minutes: Array.from({ length: 60 }, (_, i) => ({
      startMs: (current - 59 + i) * 60_000,
      units: { newMail: 0, olderMail: 0, yourChanges: 0, youAsked: 0, assistants: 0 },
      refused: 0,
    })),
  };
}

/** `quiet()` with minute `i` (0 = an hour ago, 59 = now) changed. */
function withMinute(usage: QuotaUsage, i: number, change: Partial<QuotaMinute>): QuotaUsage {
  const minutes = usage.minutes.map((m, j) =>
    j === i ? { ...m, ...change, units: { ...m.units, ...change.units } } : m,
  );
  return { ...usage, minutes };
}

afterEach(() => vi.useRealTimers());

test("the legend totals each source over the hour, with its share", () => {
  let usage = quiet();
  usage = withMinute(usage, 10, {
    units: { newMail: 10, olderMail: 2_000, yourChanges: 0, youAsked: 0, assistants: 0 },
  });
  usage = withMinute(usage, 40, {
    units: { newMail: 30, olderMail: 0, yourChanges: 150, youAsked: 10, assistants: 0 },
  });
  const summary = summarizeQuota(usage);
  expect(summary.totals).toEqual({
    newMail: 40,
    olderMail: 2_000,
    yourChanges: 150,
    youAsked: 10,
    assistants: 0,
  });
  expect(summary.total).toBe(2_200);
  expect(summary.peak).toBe(2_010);

  render(<QuotaUsageChart email="me@example.com" usage={usage} />);
  const legend = screen.getByRole("list", { name: "Quota used in the last hour" });
  const item = (label: string) => within(legend).getByText(label).closest("li")!;
  expect(item("Checking for new mail")).toHaveTextContent("40 · 2%");
  expect(item("Downloading older mail")).toHaveTextContent("2,000 · 91%");
  expect(item("Sending your changes")).toHaveTextContent("150 · 7%");
  expect(item("Opening and searching")).toHaveTextContent("10 · <1%");
  expect(item("AI assistants")).toHaveTextContent("0 · 0%");
  expect(screen.getByText("Busiest minute 2,010 of 6,000")).toBeInTheDocument();
  expect(screen.getByText("Limit 6,000 a minute")).toBeInTheDocument();
});

test("the preview fixture shows sync every minute, a backfill burst and the refused minute", () => {
  const usage = previewQuotaUsage("acc-personal", 6_000, NOW);
  expect(usage.minutes).toHaveLength(60);
  const summary = summarizeQuota(usage);
  expect(usage.minutes.every((m) => m.units.newMail > 0)).toBe(true);
  expect(summary.totals.olderMail).toBeGreaterThan(summary.totals.newMail);
  expect(summary.refused).toBe(2);
  expect(summary.somethingElse).toBe(true);
  expect(summarizeQuota(previewQuotaUsage("acc-work", 6_000, NOW)).refused).toBe(0);
});

test("says how many requests Gmail refused, or that it refused nothing", () => {
  const { rerender } = render(<QuotaUsageChart email="me@example.com" usage={quiet()} />);
  expect(screen.getByText("Gmail refused nothing in the last hour")).toBeInTheDocument();
  expect(screen.getAllByText("0", { selector: ".settings-usage__key-value" })).toHaveLength(5);

  rerender(
    <QuotaUsageChart
      email="me@example.com"
      usage={withMinute(quiet(), 50, {
        units: { newMail: 5_000, olderMail: 0, yourChanges: 0, youAsked: 0, assistants: 0 },
        refused: 1,
      })}
    />,
  );
  expect(screen.getByText("Gmail refused 1 request in the last hour")).toBeInTheDocument();
});

test("the something-else note shows only when this Pheeme couldn't have reached the limit itself", () => {
  const note = () => screen.queryByRole("note");
  const at = (units: number, refused: number) =>
    withMinute(quiet(), 30, {
      units: { newMail: units, olderMail: 0, yourChanges: 0, youAsked: 0, assistants: 0 },
      refused,
    });

  // Refused while using little: something else is spending the quota.
  const { rerender } = render(<QuotaUsageChart email="me@example.com" usage={at(120, 3)} />);
  expect(note()).toHaveAttribute("data-warning");
  expect(screen.getByText("Gmail refused 3 requests in the last hour")).toBeInTheDocument();

  // Refused near the limit: this Pheeme could have done it itself.
  rerender(<QuotaUsageChart email="me@example.com" usage={at(6_000, 2)} />);
  expect(note()).not.toHaveAttribute("data-warning");

  // Refused just after a busy minute: Gmail's minute can straddle two of ours.
  const afterBusy = withMinute(at(120, 2), 29, {
    units: { newMail: 0, olderMail: 5_900, yourChanges: 0, youAsked: 0, assistants: 0 },
  });
  rerender(<QuotaUsageChart email="me@example.com" usage={afterBusy} />);
  expect(note()).not.toHaveAttribute("data-warning");

  // Busy but never refused.
  rerender(<QuotaUsageChart email="me@example.com" usage={at(100, 0)} />);
  expect(note()).not.toHaveAttribute("data-warning");

  // It follows the user's limit.
  rerender(
    <QuotaUsageChart email="me@example.com" usage={{ ...at(6_000, 2), limitPerMinute: 12_000 }} />,
  );
  expect(note()).toHaveAttribute("data-warning");
});

test("before usage loads, the block already has every element it will have after", () => {
  const { container, rerender } = render(<QuotaUsageChart email="me@example.com" usage={null} />);
  const elements = () =>
    [...container.querySelectorAll(".settings-usage *")]
      .filter((el) => !el.classList.contains("ui-skeleton"))
      // The bars' parts, refusal marks and table rows are the data itself.
      .filter((el) => !el.matches(".settings-usage__part, .settings-usage__mark > *"))
      .filter((el) => !el.closest(".settings-usage__table tbody tr")).length;
  const before = elements();
  expect(container.querySelectorAll(".settings-usage__minute")).toHaveLength(60);
  expect(container.querySelectorAll(".settings-usage__key")).toHaveLength(5);
  expect(container.querySelectorAll(".settings-usage .ui-skeleton").length).toBeGreaterThan(0);
  // Nothing about refusals is claimed until the answer is in.
  expect(container.querySelector(".settings-usage__refusals")).not.toHaveTextContent(
    /Gmail refused/,
  );
  expect(screen.getByRole("note")).not.toHaveAttribute("data-warning");

  rerender(<QuotaUsageChart email="me@example.com" usage={quiet()} />);
  expect(elements()).toBe(before);
  expect(container.querySelectorAll(".settings-usage .ui-skeleton")).toHaveLength(0);
  expect(screen.getByText("Gmail refused nothing in the last hour")).toBeInTheDocument();

  // Loading straight into a report that blames something else adds nothing either.
  rerender(<QuotaUsageChart email="me@example.com" usage={null} />);
  const refused = withMinute(quiet(), 30, {
    units: { newMail: 120, olderMail: 0, yourChanges: 0, youAsked: 0, assistants: 0 },
    refused: 2,
  });
  rerender(<QuotaUsageChart email="me@example.com" usage={refused} />);
  expect(elements()).toBe(before);
  expect(screen.getByRole("note")).toHaveAttribute("data-warning");
});

test("the oldest minute's refusals don't blame anything else: the minute before it is unknown", () => {
  const usage = withMinute(quiet(), 0, {
    units: { newMail: 120, olderMail: 0, yourChanges: 0, youAsked: 0, assistants: 0 },
    refused: 2,
  });
  expect(summarizeQuota(usage).somethingElse).toBe(false);
  expect(summarizeQuota(withMinute(usage, 1, { refused: 1 })).somethingElse).toBe(true);
});

test("hovering a minute shows what it was spent on", () => {
  const usage = withMinute(quiet(), 58, {
    units: { newMail: 12, olderMail: 0, yourChanges: 100, youAsked: 0, assistants: 0 },
    refused: 2,
  });
  const { container } = render(<QuotaUsageChart email="me@example.com" usage={usage} />);
  const minute = container.querySelectorAll(".settings-usage__minute")[58];
  fireEvent.mouseEnter(minute);
  const tooltip = container.querySelector(".settings-usage__tooltip")!;
  expect(tooltip).toHaveTextContent("Checking for new mail12");
  expect(tooltip).toHaveTextContent("Sending your changes100");
  expect(tooltip).toHaveTextContent("Total112 of 6,000");
  expect(tooltip).toHaveTextContent("Refused by Gmail2");
  expect(tooltip).not.toHaveTextContent("Downloading older mail");
});

test("asks the backend for the account's usage and again every 10 seconds", async () => {
  vi.useFakeTimers();
  const asked: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "gmail_quota_usage") {
      asked.push(args);
      return quiet();
    }
  });
  render(<GmailQuotaUsage accountId="a1" email="me@example.com" />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(asked).toEqual([{ accountId: "a1" }]);
  expect(screen.getByText("Gmail refused nothing in the last hour")).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(QUOTA_REFRESH_MS);
  });
  expect(asked).toHaveLength(2);
});

test("a failed refresh keeps the last answer", async () => {
  vi.useFakeTimers();
  let fail = false;
  mockIPC((cmd) => {
    if (cmd === "gmail_quota_usage") {
      if (fail) throw new Error("boom");
      return quiet();
    }
  });
  let seen: QuotaUsage | null = null;
  function Probe() {
    seen = useQuotaUsage("a1");
    return null;
  }
  render(<Probe />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(seen).not.toBeNull();
  fail = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(QUOTA_REFRESH_MS);
  });
  expect(seen).not.toBeNull();
});
