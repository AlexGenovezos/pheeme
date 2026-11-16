import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useCalendarStore } from "../calendar/calendarStore";
import type { AccountInfo, ThreadDetail } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { __resetThreadStoreForTests, useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { DiagnosticsSection } from "./DiagnosticsSection";

const account = (id: string, email: string): AccountInfo => ({
  id,
  email,
  displayName: null,
  clientId: "c",
  synced: true,
});

/** Records every diagnostics command; `answer` decides how each one ends. */
function backend(answer: (cmd: string, args: unknown) => unknown = () => undefined) {
  const calls: Array<[string, unknown]> = [];
  mockIPC((cmd, args) => {
    if (
      cmd === "send_diagnostics" ||
      cmd === "save_diagnostics" ||
      cmd === "prepare_screenshot" ||
      cmd === "plugin:dialog|save"
    ) {
      calls.push([cmd, args]);
      return answer(cmd, args);
    }
  });
  return calls;
}

const setAccounts = (accounts: AccountInfo[]) => useAccountStore.setState({ accounts });
const note = () => screen.getByRole("textbox", { name: "What happened?" });
const send = () => fireEvent.click(screen.getByRole("button", { name: "Send" }));

beforeEach(() => {
  setAccounts([]);
  __resetThreadStoreForTests();
  useUiStore.setState({ openThread: null });
  useCalendarStore.setState({ mode: "mail" });
});
afterEach(() => document.querySelectorAll(".thread-view__retained").forEach((el) => el.remove()));

/** The reading pane behind Settings: `key` open, one message frame holding `srcs`, plus a hidden neighbour. */
function openEmail(key: string, subject: string, srcs: string[]) {
  const detail = { thread: { subject }, messages: [{ subject }] } as unknown as ThreadDetail;
  useThreadStore.setState({ details: new Map([[key, detail]]) });
  useUiStore.setState({ openThread: key });
  for (const visible of [false, true]) {
    const root = document.createElement("div");
    root.className = "thread-view__retained";
    root.dataset.visible = String(visible);
    const body = document.createElement("div");
    body.className = "email-body";
    body.dataset.messageId = visible ? "m1" : "other";
    const frame = document.createElement("iframe");
    body.append(frame);
    root.append(body);
    document.body.append(root);
    for (const src of visible ? srcs : ["https://neighbour.example/x.png"]) {
      const img = frame.contentDocument!.createElement("img");
      img.setAttribute("src", src);
      frame.contentDocument!.body.append(img);
    }
  }
}
const includeSwitch = () => screen.queryByRole("switch", { name: "Include the email on screen" });

test("Send uploads the note as the only account's address and says thanks", async () => {
  setAccounts([account("a1", "me@gmail.com")]);
  const calls = backend();
  render(<DiagnosticsSection />);
  expect(screen.getByText("Sent as me@gmail.com so the developer can reply")).toBeInTheDocument();
  fireEvent.change(note(), { target: { value: "Opening an email took ages" } });
  send();
  expect(await screen.findByText("Sent. Thanks, Alex will take a look.")).toBeInTheDocument();
  expect(calls).toEqual([
    ["send_diagnostics", { note: "Opening an email took ages", replyTo: "me@gmail.com" }],
  ]);
});

test("a refused upload shows why and points to saving the file", async () => {
  setAccounts([account("a1", "me@gmail.com")]);
  backend(() => {
    throw { code: "rate_limited", message: "Too many reports right now. Please try again later." };
  });
  render(<DiagnosticsSection />);
  send();
  expect(
    await screen.findByText(/Too many reports right now\. Please try again later\./),
  ).toHaveTextContent("You can save the file and email it instead.");
  expect(screen.queryByText("Sent. Thanks, Alex will take a look.")).toBeNull();
});

test("with several accounts the reply address is picked from them", async () => {
  setAccounts([account("a1", "me@gmail.com"), account("a2", "work@example.com")]);
  const calls = backend();
  render(<DiagnosticsSection />);
  const picker = screen.getByRole("combobox", { name: "Reply address" });
  expect(picker).toHaveTextContent("me@gmail.com");
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole("option", { name: "work@example.com" }));
  send();
  await screen.findByText("Sent. Thanks, Alex will take a look.");
  expect(calls).toEqual([["send_diagnostics", { note: "", replyTo: "work@example.com" }]]);
});

test("with no accounts the typed address is sent, or none at all", async () => {
  const calls = backend();
  render(<DiagnosticsSection />);
  const email = screen.getByRole("textbox", { name: "Your email (so the developer can reply)" });
  send();
  await screen.findByText("Sent. Thanks, Alex will take a look.");
  fireEvent.change(email, { target: { value: " jane@example.com " } });
  send();
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls).toEqual([
    ["send_diagnostics", { note: "", replyTo: null }],
    ["send_diagnostics", { note: "", replyTo: "jane@example.com" }],
  ]);
});

test("Save a copy writes the bundle where the user chose, and does nothing if they cancel", async () => {
  setAccounts([account("a1", "me@gmail.com")]);
  let chosen: string | null = null;
  const calls = backend((cmd) => (cmd === "plugin:dialog|save" ? chosen : undefined));
  render(<DiagnosticsSection />);
  const save = screen.getByRole("button", { name: "Save a copy…" });

  fireEvent.click(save);
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0][0]).toBe("plugin:dialog|save");
  expect(calls[0][1]).toMatchObject({ options: { defaultPath: "pheeme-diagnostics.zip" } });

  chosen = "/Users/me/pheeme-diagnostics.zip";
  fireEvent.change(note(), { target: { value: "Slow" } });
  fireEvent.click(save);
  expect(await screen.findByText("Saved to /Users/me/pheeme-diagnostics.zip.")).toBeInTheDocument();
  expect(calls.slice(2)).toEqual([
    [
      "save_diagnostics",
      { note: "Slow", replyTo: "me@gmail.com", path: "/Users/me/pheeme-diagnostics.zip" },
    ],
  ]);
});

test("with no email open there's nothing to include", () => {
  setAccounts([account("a1", "me@gmail.com")]);
  render(<DiagnosticsSection />);
  expect(includeSwitch()).toBeNull();
});

test("in Calendar mode the email left open in Mail isn't offered", () => {
  setAccounts([account("a1", "me@gmail.com")]);
  openEmail("a1:t1", "Ammo in stock", []);
  useCalendarStore.setState({ mode: "calendar" });
  render(<DiagnosticsSection />);
  expect(includeSwitch()).toBeNull();
});

test("the email on screen is sent only when included, with what its images did", async () => {
  setAccounts([account("a1", "me@gmail.com")]);
  openEmail("a1:t1", "Ammo in stock", ["http://shop.example/a.jpg"]);
  const calls = backend();
  render(<DiagnosticsSection />);
  expect(
    screen.getByText(/“Ammo in stock”: its text, sender and image addresses/),
  ).toBeInTheDocument();
  expect(includeSwitch()).toHaveAttribute("aria-checked", "false");

  send();
  await screen.findByText("Sent. Thanks, Alex will take a look.");
  fireEvent.click(includeSwitch()!);
  send();
  await waitFor(() => expect(calls).toHaveLength(2));

  expect(calls[0]).toEqual(["send_diagnostics", { note: "", replyTo: "me@gmail.com" }]);
  expect(calls[1]).toEqual([
    "send_diagnostics",
    {
      note: "",
      replyTo: "me@gmail.com",
      email: {
        accountId: "a1",
        threadId: "t1",
        images: [
          expect.objectContaining({
            messageId: "m1",
            src: "http://shop.example/a.jpg",
            loading: "",
          }),
        ],
      },
    },
  ]);
});

/** What `prepare_screenshot` answers: the "cleaned" PNG is the input reversed, so the test can tell them apart. */
function screenshots(refuse: (data: string) => boolean = () => false) {
  return backend((cmd, args) => {
    if (cmd !== "prepare_screenshot") return undefined;
    const { data } = args as { data: string };
    if (refuse(data)) {
      throw { code: "invalid_input", message: "That isn't a screenshot. Add a PNG or JPEG image." };
    }
    return { png: [...data].reverse().join(""), width: 1280, height: 800 };
  });
}
const png = (text: string) => new File([text], "shot.png", { type: "image/png" });
const pick = (...files: File[]) =>
  fireEvent.change(screen.getByTestId("screenshot-file-input"), { target: { files } });
const thumbnails = () => screen.queryAllByRole("img", { name: /^Screenshot \d/ });

test("a picked screenshot is checked, shown as cleaned and sent with the report", async () => {
  setAccounts([account("a1", "me@gmail.com")]);
  const calls = screenshots();
  render(<DiagnosticsSection />);
  pick(png("abc"));
  const [thumb] = await screen.findAllByRole("img", { name: "Screenshot 1, 1280 × 800" });
  expect(calls[0]).toEqual(["prepare_screenshot", { data: btoa("abc") }]);
  expect(thumb).toHaveAttribute(
    "src",
    `data:image/png;base64,${[...btoa("abc")].reverse().join("")}`,
  );

  send();
  await screen.findByText("Sent. Thanks, Alex will take a look.");
  expect(calls[1]).toEqual([
    "send_diagnostics",
    { note: "", replyTo: "me@gmail.com", screenshots: [[...btoa("abc")].reverse().join("")] },
  ]);
});

test("a file that isn't a screenshot is refused with the reason and not added", async () => {
  setAccounts([account("a1", "me@gmail.com")]);
  screenshots(() => true);
  render(<DiagnosticsSection />);
  pick(new File(["#!/bin/sh"], "evil.png", { type: "image/png" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That isn't a screenshot. Add a PNG or JPEG image.",
  );
  expect(thumbnails()).toHaveLength(0);
});

test("a pasted image is added, up to three, and each can be removed", async () => {
  setAccounts([account("a1", "me@gmail.com")]);
  screenshots();
  render(<DiagnosticsSection />);
  const paste = (...files: File[]) =>
    fireEvent.paste(window, { clipboardData: { files, getData: () => "" } });

  paste(png("1"), png("2"));
  await waitFor(() => expect(thumbnails()).toHaveLength(2));
  paste(png("3"), png("4"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Add at most 3 screenshots.");
  await waitFor(() => expect(thumbnails()).toHaveLength(3));
  expect(screen.queryByRole("button", { name: "Add screenshot…" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Remove screenshot 2" }));
  expect(thumbnails()).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Add screenshot…" })).toBeInTheDocument();
});

test("pasting text isn't taken for a screenshot", () => {
  setAccounts([account("a1", "me@gmail.com")]);
  const calls = screenshots();
  render(<DiagnosticsSection />);
  fireEvent.paste(window, { clipboardData: { files: [], getData: () => "hello" } });
  expect(calls).toHaveLength(0);
});
