import { mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Search } from "lucide-react";
import { expect, test, vi } from "vitest";
import { GmailQuotaControl } from "./GmailQuotaControl";
import { Settings } from "./Settings";
import { useSettingsStore } from "./settingsStore";

test("the Gmail limit loads from the backend and saves the stored value", async () => {
  const saved: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "gmail_quota") return 6000;
    if (command === "set_gmail_quota") {
      saved.push(args);
      return 15000;
    }
  });
  render(<GmailQuotaControl />);
  const input = await screen.findByRole("textbox", { name: "Gmail API limit" });
  await waitFor(() => expect(input).toHaveValue("6,000"));

  fireEvent.change(input, { target: { value: "15000" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(saved).toEqual([{ perMinute: 15000 }]));
  await waitFor(() => expect(input).toHaveValue("15,000"));
});

test("a value that isn't a whole number isn't saved", async () => {
  const saved: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "gmail_quota") return 6000;
    if (command === "set_gmail_quota") saved.push(args);
  });
  render(<GmailQuotaControl />);
  const input = await screen.findByRole("textbox", { name: "Gmail API limit" });
  await waitFor(() => expect(input).toHaveValue("6,000"));

  fireEvent.change(input, { target: { value: "lots" } });
  fireEvent.blur(input);
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(saved).toEqual([]);
});

test("editing while a save is pending keeps the new draft and doesn't save twice", async () => {
  const saved: unknown[] = [];
  let finish: (value: number) => void = () => {};
  mockIPC((command, args) => {
    if (command === "gmail_quota") return 6000;
    if (command === "set_gmail_quota") {
      saved.push(args);
      return new Promise<number>((resolve) => (finish = resolve));
    }
  });
  render(<GmailQuotaControl />);
  const input = await screen.findByRole("textbox", { name: "Gmail API limit" });
  await waitFor(() => expect(input).toHaveValue("6,000"));

  fireEvent.change(input, { target: { value: "15000" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);
  fireEvent.change(input, { target: { value: "20000" } });
  await waitFor(() => expect(saved).toHaveLength(1));
  finish(15000);
  await new Promise((r) => setTimeout(r, 0));
  expect(input).toHaveValue("20000");
  expect(saved).toEqual([{ perMinute: 15000 }]);
});

test("a save asked for while another is pending runs after it", async () => {
  const saved: unknown[] = [];
  const pending: Array<(value: number) => void> = [];
  mockIPC((command, args) => {
    if (command === "gmail_quota") return 6000;
    if (command === "set_gmail_quota") {
      saved.push(args);
      return new Promise<number>((resolve) => pending.push(resolve));
    }
  });
  render(<GmailQuotaControl />);
  const input = await screen.findByRole("textbox", { name: "Gmail API limit" });
  await waitFor(() => expect(input).toHaveValue("6,000"));

  fireEvent.change(input, { target: { value: "15000" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.change(input, { target: { value: "20000" } });
  fireEvent.blur(input);
  await waitFor(() => expect(saved).toHaveLength(1));
  pending[0](15000);
  await waitFor(() => expect(saved).toEqual([{ perMinute: 15000 }, { perMinute: 20000 }]));
  pending[1](20000);
  await waitFor(() => expect(input).toHaveValue("20,000"));
});

test("Escape with an edit puts the stored value back and doesn't reach Settings", async () => {
  const saved: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "gmail_quota") return 6000;
    if (command === "set_gmail_quota") saved.push(args);
  });
  const onWindowKey = vi.fn();
  window.addEventListener("keydown", onWindowKey);
  const { unmount } = render(<GmailQuotaControl />);
  const input = await screen.findByRole("textbox", { name: "Gmail API limit" });
  await waitFor(() => expect(input).toHaveValue("6,000"));

  fireEvent.change(input, { target: { value: "15000" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input).toHaveValue("6,000");
  expect(onWindowKey).not.toHaveBeenCalled();
  // The reverted field has nothing left to save, on blur or on close.
  fireEvent.blur(input);
  unmount();
  expect(saved).toEqual([]);

  // With nothing to undo, Escape goes on to close Settings.
  const second = render(<GmailQuotaControl />);
  const again = await screen.findByRole("textbox", { name: "Gmail API limit" });
  await waitFor(() => expect(again).toHaveValue("6,000"));
  fireEvent.keyDown(again, { key: "Escape" });
  expect(onWindowKey).toHaveBeenCalledTimes(1);
  second.unmount();
  window.removeEventListener("keydown", onWindowKey);
});

test("closing with a valid edit still in the field saves it; an invalid one isn't saved", async () => {
  const saved: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "gmail_quota") return 6000;
    if (command === "set_gmail_quota") {
      saved.push(args);
      return 15000;
    }
  });
  const first = render(<GmailQuotaControl />);
  const input = await screen.findByRole("textbox", { name: "Gmail API limit" });
  await waitFor(() => expect(input).toHaveValue("6,000"));
  fireEvent.change(input, { target: { value: "lots" } });
  first.unmount();
  expect(saved).toEqual([]);

  render(<GmailQuotaControl />);
  const next = await screen.findByRole("textbox", { name: "Gmail API limit" });
  await waitFor(() => expect(next).toHaveValue("6,000"));
  fireEvent.change(next, { target: { value: "15000" } });
  cleanup();
  await waitFor(() => expect(saved).toEqual([{ perMinute: 15000 }]));
});

test("in Settings, Escape reverts an edit and only a second Escape closes the dialog", async () => {
  mockIPC((command) => (command === "gmail_quota" ? 6000 : undefined));
  useSettingsStore.setState({ open: true, page: "quota" });
  render(
    <Settings
      pages={[
        {
          id: "quota",
          title: "Quota",
          group: null,
          icon: Search,
          Component: GmailQuotaControl,
        } as never,
      ]}
    />,
  );
  const input = await screen.findByRole("textbox", { name: "Gmail API limit" });
  await waitFor(() => expect(input).toHaveValue("6,000"));
  fireEvent.change(input, { target: { value: "15000" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input).toHaveValue("6,000");
  expect(useSettingsStore.getState().open).toBe(true);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(useSettingsStore.getState().open).toBe(false);
});
