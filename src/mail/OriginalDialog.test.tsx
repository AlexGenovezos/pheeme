import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dismissToast, useToastStore } from "../components/ui/Toast";
import type { OriginalMessage } from "../lib/tauri";
import { closeOriginal, showOriginal, useOriginalStore } from "./original";
import { OriginalHost } from "./OriginalDialog";

const original: OriginalMessage = {
  messageId: "<abc@mail.example.com>",
  createdAt: Date.UTC(2026, 10, 24, 15, 17),
  from: "Bob Müller <bob@example.com>",
  to: "me@example.com",
  subject: "Café menu",
  auth: [
    { method: "dkim", result: "pass", detail: "header.i=@example.com" },
    { method: "spf", result: "softfail", detail: null },
  ],
  source: "Message-ID: <abc@mail.example.com>\r\n\r\nHello",
  truncated: false,
};

beforeEach(() => {
  useToastStore.getState().toasts.forEach((t) => dismissToast(t.id));
});
afterEach(() => act(() => closeOriginal()));

test("shows the summary, the checks Gmail reported and the source", async () => {
  mockIPC((cmd) => (cmd === "message_original" ? original : undefined));
  render(<OriginalHost />);
  act(() => showOriginal("a", "m1"));

  expect(await screen.findByText("Café menu")).toBeTruthy();
  expect(screen.getByText("<abc@mail.example.com>")).toBeTruthy();
  expect(screen.getByText("Bob Müller <bob@example.com>")).toBeTruthy();
  expect(screen.getByText("PASS")).toBeTruthy();
  expect(screen.getByText("SOFTFAIL")).toBeTruthy();
  // DMARC wasn't in the header: said so, not left blank.
  expect(screen.getByText("Not reported")).toBeTruthy();
  expect(screen.getByLabelText("Message source").textContent).toBe(original.source);
});

test("Download original saves the .eml and offers to show it", async () => {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "message_original") return original;
    if (cmd === "save_original") return "/home/me/Downloads/Café menu.eml";
  });
  render(<OriginalHost />);
  act(() => showOriginal("a", "m1"));
  await screen.findByText("Café menu");

  fireEvent.click(screen.getByRole("button", { name: "Download original" }));
  await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
  expect(calls.find((c) => c.cmd === "save_original")?.args).toEqual({
    accountId: "a",
    messageId: "m1",
  });
  expect(useToastStore.getState().toasts[0]?.description).toBe("Café menu.eml");
});

test("Copy to clipboard copies the source", async () => {
  mockIPC((cmd) => (cmd === "message_original" ? original : undefined));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<OriginalHost />);
  act(() => showOriginal("a", "m1"));
  await screen.findByText("Café menu");

  fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(original.source));
});

test("Copy on a source cut for display fetches the whole source", async () => {
  const calls: Record<string, unknown>[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== "message_original") return;
    calls.push(args as Record<string, unknown>);
    return (args as { full: boolean }).full
      ? { ...original, source: "the whole source" }
      : { ...original, truncated: true };
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<OriginalHost />);
  act(() => showOriginal("a", "m1"));
  await screen.findByText("Café menu");

  fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("the whole source"));
  expect(calls.map((c) => c.full)).toEqual([false, true]);
});

test("offline says why and Try again fetches once more", async () => {
  let attempts = 0;
  mockIPC((cmd) => {
    if (cmd !== "message_original") return;
    attempts += 1;
    if (attempts === 1) throw { code: "network", message: "Can't reach Gmail." };
    return original;
  });
  render(<OriginalHost />);
  act(() => showOriginal("a", "m1"));

  expect((await screen.findByRole("alert")).textContent).toContain("Can't reach Gmail.");
  expect(useOriginalStore.getState().open).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Café menu")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("several results for one check share its single line", async () => {
  mockIPC((cmd) =>
    cmd === "message_original"
      ? {
          ...original,
          auth: [
            { method: "dkim", result: "pass", detail: "header.i=@a.example" },
            { method: "dkim", result: "fail", detail: "header.i=@b.example" },
          ],
        }
      : undefined,
  );
  render(<OriginalHost />);
  act(() => showOriginal("a", "m1"));

  const first = await screen.findByText("PASS");
  const line = first.parentElement!;
  expect(line.children.length).toBe(3);
  expect(line.getAttribute("title")).toBe("header.i=@a.example\nheader.i=@b.example");
});

test("a failed full fetch for Copy says why", async () => {
  mockIPC((cmd, args) => {
    if (cmd !== "message_original") return;
    if ((args as { full: boolean }).full) throw { code: "network", message: "Can't reach Gmail." };
    return { ...original, truncated: true };
  });
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  render(<OriginalHost />);
  act(() => showOriginal("a", "m1"));
  await screen.findByText("Café menu");

  fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
  expect(useToastStore.getState().toasts[0]?.description).toBe("Can't reach Gmail.");
});
