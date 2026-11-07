import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { GmailQuotaControl } from "./GmailQuotaControl";

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
