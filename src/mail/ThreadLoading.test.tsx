import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ThreadLoading as Loading } from "../lib/tauri";
import { useSettingsStore } from "../settings/settingsStore";
import { ThreadLoading } from "./ThreadLoading";

const stage = (over: Partial<Loading> = {}): Loading => ({
  accountId: "a1",
  threadId: "t1",
  stage: "fetching",
  attempt: null,
  retryInMs: null,
  reason: null,
  syncBusy: false,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  useSettingsStore.setState({ open: false, page: "appearance" });
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

test("nothing shows for the first 300 ms, so a quick open doesn't flash", () => {
  const { container } = render(<ThreadLoading />);
  advance(299);
  expect(container).toBeEmptyDOMElement();
  advance(1);
  expect(screen.getByText("Downloading this message from Gmail…")).toBeInTheDocument();
});

test("waiting behind the first sync says so", () => {
  render(<ThreadLoading loading={stage({ stage: "queued", syncBusy: true })} />);
  advance(300);
  expect(
    screen.getByText(
      "Pheeme is still downloading your mailbox for the first time. This message is next in line.",
    ),
  ).toBeInTheDocument();
});

test("a rate-limited retry says how long until the next try", () => {
  render(
    <ThreadLoading
      loading={stage({ stage: "retrying", reason: "rate_limited", retryInMs: 8000, attempt: 0 })}
    />,
  );
  advance(300);
  expect(
    screen.getByText("Gmail is asking Pheeme to slow down. Retrying in 8 s…"),
  ).toBeInTheDocument();
});

test("a network or server retry gives the attempt number", () => {
  render(<ThreadLoading loading={stage({ stage: "retrying", reason: "network", attempt: 1 })} />);
  advance(300);
  expect(screen.getByText("Gmail isn't answering. Retrying (attempt 2)…")).toBeInTheDocument();
});

test("after 15 s a link offers to send diagnostics from Settings › Diagnostics", () => {
  render(<ThreadLoading />);
  advance(14_999);
  expect(screen.queryByRole("button", { name: "Taking too long? Send diagnostics" })).toBeNull();
  advance(1);
  fireEvent.click(screen.getByRole("button", { name: "Taking too long? Send diagnostics" }));
  expect(useSettingsStore.getState()).toMatchObject({ open: true, page: "diagnostics" });
});
