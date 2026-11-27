import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dismissToast, ToastProvider, useToastStore } from "../components/ui/Toast";
import { registry } from "../keyboard/registry";
import { useAccountStore } from "../store/accountStore";
import { ComposeHost } from "./ComposeHost";
import { __resetComposeSettingsForTests, useComposeSettings } from "./composeSettings";
import { __resetComposeStoreForTests, useComposeStore } from "./composeStore";
import { __resetSendAsForTests, useSendAs } from "./sendAs";
import { __resetSignaturesForTests, useSignatures } from "./signatures";

let calls: Array<{ cmd: string; args: Record<string, unknown> }>;

beforeEach(() => {
  localStorage.clear();
  __resetComposeSettingsForTests();
  __resetComposeStoreForTests();
  __resetSignaturesForTests();
  __resetSendAsForTests();
  useToastStore.getState().toasts.forEach((t) => dismissToast(t.id));
  useAccountStore.setState({
    accounts: [
      {
        id: "a1",
        email: "me@example.com",
        displayName: null,
        clientId: "c",
        synced: true,
        color: 1,
      },
      {
        id: "a2",
        email: "me@example.org",
        displayName: null,
        clientId: "c",
        synced: true,
        color: 1,
      },
    ],
  });
  calls = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd === "send_email") return { opId: "op1", sendAt: Date.now() + 5000 };
    if (cmd === "save_draft") return { draftId: "d1", messageId: "m1", threadId: "t1" };
    return undefined;
  });
});

const renderHost = () =>
  render(
    <ToastProvider>
      <ComposeHost />
    </ToastProvider>,
  );

async function openNew() {
  renderHost();
  act(() => void useComposeStore.getState().compose("a1"));
  // The panel lazy-loads the editor; slow CI runners can take over findBy's default 1 s.
  return screen.findByRole("region", { name: "New message" }, { timeout: 5000 });
}

test("Drive inserts escaped links into the draft and the picker owns the Send shortcut", async () => {
  mockIPC((cmd) => {
    if (cmd === "drive_files")
      return {
        files: [
          {
            id: "drive-file",
            name: "Report <script>",
            mimeType: "application/pdf",
            size: "42",
            resourceKey: "key",
          },
        ],
        nextPageToken: null,
      };
    return undefined;
  });
  const panel = await openNew();
  fireEvent.click(within(panel).getByRole("button", { name: "Attach from Google Drive" }));
  const dialog = await screen.findByRole("dialog", { name: "Attach from Google Drive" });
  fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
  expect(useComposeStore.getState().windows[0].error).toBeNull();
  fireEvent.click(await within(dialog).findByRole("button", { name: /Report <script>/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Insert 1 link" }));
  const draft = useComposeStore.getState().windows[0].draft;
  expect(draft.bodyHtml).toContain("Report &lt;script&gt;");
  expect(draft.bodyHtml).toContain(
    "https://drive.google.com/file/d/drive-file/view?resourcekey=key",
  );
  expect(draft.attachments).toEqual([]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("typed addresses become chips; Backspace takes the last one back to edit", async () => {
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.change(to, { target: { value: "Mira <mira@example.com>" } });
  fireEvent.keyDown(to, { key: "Enter" });
  fireEvent.change(to, { target: { value: "bo@x.test" } });
  fireEvent.keyDown(to, { key: "," });
  const chips = within(panel).getByRole("list", { name: "To recipients" });
  expect(within(chips).getByRole("button", { name: "Edit Mira" })).toBeInTheDocument();
  expect(useComposeStore.getState().windows[0].draft.to.map((r) => r.address)).toEqual([
    "mira@example.com",
    "bo@x.test",
  ]);
  fireEvent.keyDown(to, { key: "Backspace" });
  expect(to).toHaveValue("bo@x.test");
  expect(useComposeStore.getState().windows[0].draft.to).toHaveLength(1);
});

const PEOPLE = [
  { name: "Mira Tan", address: "mira@example.com" },
  { name: null, address: "mira.k@example.net" },
];

function suggestPeople() {
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd === "suggest_contacts") return PEOPLE;
    return undefined;
  });
}

test("typing suggests people; arrows move, Enter picks with the name", async () => {
  suggestPeople();
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.focus(to);
  fireEvent.change(to, { target: { value: "mir" } });
  const list = await within(panel).findByRole("listbox", { name: "Suggested To recipients" });
  expect(calls.find((c) => c.cmd === "suggest_contacts")?.args).toMatchObject({
    accountId: "a1",
    query: "mir",
  });
  const options = within(list).getAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "Mira Tanmira@example.com",
    "mira.k@example.net",
  ]);
  expect(to).toHaveAttribute("aria-activedescendant", options[0].id);
  fireEvent.keyDown(to, { key: "ArrowDown" });
  expect(to).toHaveAttribute("aria-activedescendant", options[1].id);
  fireEvent.keyDown(to, { key: "ArrowUp" });
  fireEvent.keyDown(to, { key: "Enter" });
  expect(useComposeStore.getState().windows[0].draft.to).toEqual([
    { name: "Mira Tan", address: "mira@example.com" },
  ]);
  expect(to).toHaveValue("");
  expect(within(panel).queryByRole("listbox")).not.toBeInTheDocument();
});

test("people already added aren't suggested again, and clicking one adds it", async () => {
  suggestPeople();
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.focus(to);
  fireEvent.change(to, { target: { value: "mira@example.com" } });
  await within(panel).findByRole("listbox");
  fireEvent.keyDown(to, { key: "Enter" });
  // A whole typed address goes in as typed, with the suggestion's name.
  expect(useComposeStore.getState().windows[0].draft.to).toEqual([
    { name: "Mira Tan", address: "mira@example.com" },
  ]);
  fireEvent.change(to, { target: { value: "mi" } });
  const list = await within(panel).findByRole("listbox");
  const options = within(list).getAllByRole("option");
  expect(options).toHaveLength(1);
  fireEvent.mouseDown(options[0]);
  fireEvent.click(options[0]);
  expect(useComposeStore.getState().windows[0].draft.to.map((r) => r.address)).toEqual([
    "mira@example.com",
    "mira.k@example.net",
  ]);
});

test("suggestions for earlier text can't be picked while the new ones load", async () => {
  let answer: (people: typeof PEOPLE) => void = () => {};
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd !== "suggest_contacts") return undefined;
    if ((args as { query: string }).query === "mi") return PEOPLE;
    return new Promise((resolve) => (answer = resolve));
  });
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.focus(to);
  fireEvent.change(to, { target: { value: "mi" } });
  await within(panel).findByRole("listbox");
  fireEvent.change(to, { target: { value: "bob" } });
  expect(within(panel).queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.keyDown(to, { key: "Enter" });
  expect(useComposeStore.getState().windows[0].draft.to.map((r) => r.address)).toEqual(["bob"]);
  await act(async () => answer([]));
});

test("Escape hides suggestions without closing the panel", async () => {
  suggestPeople();
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.focus(to);
  fireEvent.change(to, { target: { value: "mir" } });
  await within(panel).findByRole("listbox");
  fireEvent.keyDown(to, { key: "Escape" });
  expect(within(panel).queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "New message" })).toBeInTheDocument();
  // Typed text without a pick still becomes a chip as before.
  fireEvent.keyDown(to, { key: "Enter" });
  expect(useComposeStore.getState().windows[0].draft.to.map((r) => r.address)).toEqual(["mir"]);
});

test("Cc and Bcc appear on request", async () => {
  const panel = await openNew();
  expect(within(panel).queryByRole("combobox", { name: "Cc" })).not.toBeInTheDocument();
  fireEvent.click(within(panel).getByRole("button", { name: "Cc" }));
  expect(within(panel).getByRole("combobox", { name: "Cc" })).toBeInTheDocument();
});

test("a new message can come from any account", async () => {
  const panel = await openNew();
  expect(within(panel).getByRole("button", { name: /me@example\.com/ })).toBeInTheDocument();
});

test("Send without recipients says why instead of sending", async () => {
  const panel = await openNew();
  fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
  expect(await within(panel).findByRole("alert")).toHaveTextContent("Add at least one recipient.");
  expect(calls.some((c) => c.cmd === "send_email")).toBe(false);
});

test("mod+Enter sends and the panel closes", async () => {
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.change(to, { target: { value: "mira@example.com" } });
  fireEvent.keyDown(to, { key: "Enter" });
  fireEvent.keyDown(to, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(calls.some((c) => c.cmd === "send_email")).toBe(true));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "New message" })).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Sending…")).toBeInTheDocument();
});

test("closing with unsaved changes asks: Save draft, Discard or keep editing", async () => {
  const panel = await openNew();
  fireEvent.change(within(panel).getByRole("textbox", { name: "Subject" }), {
    target: { value: "Plans" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
  const prompt = within(panel).getByRole("alertdialog", { name: "Save draft or discard?" });
  fireEvent.click(within(prompt).getByRole("button", { name: "Save draft" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "New message" })).not.toBeInTheDocument(),
  );
  expect(calls.find((c) => c.cmd === "save_draft")?.args).toMatchObject({
    accountId: "a1",
    message: { subject: "Plans" },
  });
});

test("minimized panels show the subject and open again on click", async () => {
  const panel = await openNew();
  fireEvent.change(within(panel).getByRole("textbox", { name: "Subject" }), {
    target: { value: "Plans" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Minimize" }));
  const small = await screen.findByRole("region", { name: "Plans" });
  fireEvent.click(within(small).getByRole("button", { name: "Plans" }));
  expect(await screen.findByRole("textbox", { name: "Subject" })).toHaveValue("Plans");
});

test("autosave runs every 30 s while typing goes on", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const panel = await openNew();
    const subject = within(panel).getByRole("textbox", { name: "Subject" });
    for (let i = 1; i <= 6; i++) {
      fireEvent.change(subject, { target: { value: `Plans ${i}` } });
      await act(() => vi.advanceTimersByTimeAsync(10_000));
    }
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() =>
    expect(calls.filter((c) => c.cmd === "save_draft").length).toBeGreaterThan(0),
  );
});

afterEach(() => vi.useRealTimers());

test("opening a saved draft and closing it untouched doesn't ask", async () => {
  renderHost();
  act(() => {
    const id = useComposeStore.getState().compose("a1", { subject: "Saved", draftId: "d1" });
    useComposeStore.setState((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, kind: "draft" as const } : w)),
    }));
  });
  const panel = await screen.findByRole("region", { name: "Draft" });
  fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("region", { name: "Draft" })).not.toBeInTheDocument();
});

async function addressed() {
  const panel = await openNew();
  const to = within(panel).getByRole("combobox", { name: "To" });
  fireEvent.change(to, { target: { value: "mira@example.com" } });
  fireEvent.keyDown(to, { key: "Enter" });
  return { panel, to };
}
const sent = () => calls.filter((c) => c.cmd === "send_email").length;

test("confirm before sending: Send asks first, then sends once", async () => {
  act(() => useComposeSettings.getState().setConfirmSend(true));
  const { panel } = await addressed();
  fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
  const prompt = within(panel).getByRole("alertdialog", { name: "Send this message?" });
  expect(sent()).toBe(0);
  fireEvent.click(within(prompt).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sent()).toBe(1));
});

test("confirm before sending: mod+Enter asks, and Keep editing or Escape closes the prompt", async () => {
  act(() => useComposeSettings.getState().setConfirmSend(true));
  const { panel, to } = await addressed();
  fireEvent.keyDown(to, { key: "Enter", ctrlKey: true });
  const prompt = within(panel).getByRole("alertdialog", { name: "Send this message?" });
  expect(sent()).toBe(0);
  fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
  expect(within(panel).queryByRole("alertdialog")).not.toBeInTheDocument();
  fireEvent.keyDown(to, { key: "Enter", ctrlKey: true });
  expect(within(panel).getByRole("alertdialog", { name: "Send this message?" })).toBeVisible();
  fireEvent.keyDown(to, { key: "Escape" });
  expect(within(panel).queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(sent()).toBe(0);
});

test("without confirm before sending, Send sends straight away", async () => {
  const { panel } = await addressed();
  fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
  expect(within(panel).queryByRole("alertdialog")).not.toBeInTheDocument();
  await waitFor(() => expect(sent()).toBe(1));
});

test("closing while the send prompt is open leaves only the close prompt", async () => {
  act(() => useComposeSettings.getState().setConfirmSend(true));
  const { panel } = await addressed();
  fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
  expect(within(panel).getByRole("alertdialog", { name: "Send this message?" })).toBeVisible();
  fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
  const prompts = within(panel).getAllByRole("alertdialog");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toHaveAccessibleName("Save draft or discard?");
  const keepEditing = within(prompts[0]).getByRole("button", { name: "Keep editing" });
  const saveDraft = within(prompts[0]).getByRole("button", { name: "Save draft" });
  expect(keepEditing).toHaveFocus();
  fireEvent.keyDown(keepEditing, { key: "Tab", shiftKey: true });
  expect(saveDraft).toHaveFocus();
  fireEvent.keyDown(saveDraft, { key: "Tab" });
  expect(keepEditing).toHaveFocus();
});

test("the send prompt takes focus on its Send button", async () => {
  act(() => useComposeSettings.getState().setConfirmSend(true));
  const { panel } = await addressed();
  fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
  const prompt = within(panel).getByRole("alertdialog", { name: "Send this message?" });
  const send = within(prompt).getByRole("button", { name: "Send" });
  await waitFor(() => expect(send).toHaveFocus());
  fireEvent.keyDown(send, { key: "Tab" });
  expect(within(prompt).getByRole("button", { name: "Keep editing" })).toHaveFocus();
});

test("restoring a minimized draft leaves focus in its open confirmation", async () => {
  const { panel } = await addressed();
  const id = useComposeStore.getState().windows[0].id;
  fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
  fireEvent.click(within(panel).getByRole("button", { name: "Minimize" }));
  act(() => useComposeStore.getState().setMinimized(id, false));

  const prompt = screen.getByRole("alertdialog", { name: "Save draft or discard?" });
  const keepEditing = within(prompt).getByRole("button", { name: "Keep editing" });
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(keepEditing).toHaveFocus();
});

test("the signature shows whole in the editor, stays one block, and follows the From account", async () => {
  useSignatures.setState({
    gmail: {
      a1: {
        html: '<table><tr><td><img src="https://x/logo.png" alt="Logo"></td><td><b>Me</b> One</td></tr></table>',
        loading: false,
      },
      a2: { html: "<i>Me Two</i>", loading: false },
    },
  });
  const panel = await openNew();
  const editor = within(panel).getByRole("textbox", { name: "Message" });
  const block = editor.querySelector(".gmail_signature")!;
  expect(block.querySelector("img")?.getAttribute("src")).toBe("https://x/logo.png");
  expect(block.querySelector("table b")?.textContent).toBe("Me");
  expect(block.getAttribute("contenteditable")).toBe("false");

  act(() => useComposeStore.getState().setAccount(1, "a2"));
  await waitFor(
    () =>
      expect(useComposeStore.getState().windows[0].draft.bodyHtml).toBe(
        '<p></p><div class="gmail_signature" data-smartmail="gmail_signature"><i>Me Two</i></div><p></p>',
      ), // the editor keeps a line after a block, to click into
  );
  expect(editor.querySelectorAll(".gmail_signature")).toHaveLength(1);
  expect(editor.querySelector(".gmail_signature")?.textContent).toBe("Me Two");
});

test("a new message opened before the first Gmail signature fetch gets it when it arrives", async () => {
  let answer: (html: string) => void = () => {};
  mockIPC((cmd) =>
    cmd === "gmail_signature" ? new Promise<string>((resolve) => (answer = resolve)) : undefined,
  );
  const fetching = useSignatures.getState().refreshGmail("a1");
  const panel = await openNew();
  const editor = within(panel).getByRole("textbox", { name: "Message" });
  expect(editor.querySelector(".gmail_signature")).toBeNull();

  await act(async () => {
    answer("<b>Late</b>");
    await fetching;
  });
  await waitFor(() => expect(editor.querySelector(".gmail_signature b")?.textContent).toBe("Late"));
  expect(editor.querySelectorAll(".gmail_signature")).toHaveLength(1);
  // Filled in, not typed: the message is still untouched, so closing it asks nothing.
  expect(useComposeStore.getState().windows[0].version).toBe(0);
});

test("the From picker offers each sendable address and swaps in its signature", async () => {
  useSignatures.setState({ gmail: { a1: { html: "<b>Me</b>", loading: false } } });
  useSendAs.setState({
    lists: {
      a1: [
        { email: "me@example.com", name: null, isPrimary: true, isDefault: true, signature: null },
        {
          email: "team@example.com",
          name: "Team",
          isPrimary: false,
          isDefault: false,
          signature: "<i>Team</i>",
        },
      ],
    },
  });
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd === "send_as_addresses")
      return useSendAs.getState().lists[(args as { accountId: string }).accountId];
    return undefined;
  });
  const panel = await openNew();
  const editor = within(panel).getByRole("textbox", { name: "Message" });
  expect(editor.querySelector(".gmail_signature")?.textContent).toBe("Me");
  const from = within(panel).getByRole("button", { name: /me@example\.com/ });
  expect(from).toBeInTheDocument();

  act(() => useComposeStore.getState().setFrom(1, { name: "Team", address: "team@example.com" }));
  await waitFor(() => expect(editor.querySelector(".gmail_signature")?.textContent).toBe("Team"));
  expect(within(panel).getByRole("button", { name: /team@example\.com/ })).toBeInTheDocument();
});

test("with one address and one account, From is plain text", async () => {
  useAccountStore.setState({
    accounts: [
      {
        id: "a1",
        email: "me@example.com",
        displayName: null,
        clientId: "c",
        synced: true,
        color: 1,
      },
    ],
  });
  const panel = await openNew();
  expect(within(panel).queryByRole("button", { name: /me@example\.com/ })).toBeNull();
  expect(within(panel).getByText("me@example.com")).toBeInTheDocument();
});

test("Send later is a palette command while a message is open", async () => {
  expect(registry.list().some((c) => c.id === "compose.sendLater")).toBe(false);
  const panel = await openNew();
  expect(within(panel).getByRole("button", { name: "Send options" })).toBeInTheDocument();
  const command = registry.list().find((c) => c.id === "compose.sendLater");
  expect(command?.title).toBe("Send later in Gmail");
  const sendLater = vi.spyOn(useComposeStore.getState(), "sendLater").mockResolvedValue();
  act(() => command!.run());
  expect(sendLater).toHaveBeenCalledWith(1);
  sendLater.mockRestore();
});

test("each panel's To, Cc and Bcc labels belong to its own fields", async () => {
  renderHost();
  act(() => void useComposeStore.getState().compose("a1"));
  act(() => void useComposeStore.getState().compose("a1"));
  // Opening the second tucked the first away; bring both up.
  act(() =>
    useComposeStore.setState((s) => ({
      windows: s.windows.map((w) => ({ ...w, minimized: false })),
    })),
  );
  await waitFor(() => expect(screen.getAllByRole("combobox", { name: "To" })).toHaveLength(2), {
    timeout: 5000,
  });
  const panels = screen.getAllByRole("region", { name: "New message" });
  expect(panels).toHaveLength(2);
  const inputs = panels.map((p) => within(p).getByRole("combobox", { name: "To" }));
  expect(inputs[0].id).not.toBe(inputs[1].id);
  panels.forEach((panel, i) => {
    const label = within(panel).getByText("To", { selector: "label" });
    expect(label).toHaveAttribute("for", inputs[i].id);
    fireEvent.click(within(panel).getByRole("button", { name: "Cc" }));
    expect(within(panel).getByRole("combobox", { name: "Cc" }).id).not.toBe(inputs[i].id);
  });
  const ids = screen.getAllByRole("combobox").map((el) => el.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("a failed autosave shows Not saved in the footer, in the place Draft saved takes", async () => {
  const panel = await openNew();
  const status = panel.querySelector(".compose__status")!;
  expect(status).toHaveTextContent("");
  mockIPC((cmd) => {
    if (cmd === "save_draft") throw { code: "offline", message: "No connection." };
    return undefined;
  });
  act(() => useComposeStore.getState().update(1, { subject: "Plans" }));
  await act(async () => void (await useComposeStore.getState().save(1, { quiet: true })));
  expect(panel.querySelector(".compose__status")).toBe(status);
  expect(status).toHaveTextContent("Not saved");
  expect(status).toHaveAttribute("title", "No connection.");
  expect(within(panel).queryByRole("alert")).toBeNull();

  mockIPC((cmd) =>
    cmd === "save_draft" ? { draftId: "d1", messageId: "m1", threadId: "t1" } : undefined,
  );
  await act(async () => void (await useComposeStore.getState().save(1, { quiet: true })));
  expect(status).toHaveTextContent("Draft saved");
});

test("a screenshot pasted into the message goes in the text at once; other pasted files are attached", async () => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:shot" }));
  let finishImage: (() => void) | null = null;
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd === "stage_pasted_attachment") {
      const a = args as { filename: string; mimeType: string; contentId?: string | null };
      const staged = { id: `s-${a.filename}`, filename: a.filename, mimeType: a.mimeType, size: 4 };
      if (!a.contentId) return { ...staged, contentId: null };
      // The image's file is still being staged while the test looks at the text.
      return new Promise((resolve) => {
        finishImage = () => resolve({ ...staged, contentId: a.contentId });
      });
    }
    return undefined;
  });
  const panel = await openNew();
  const body = await within(panel).findByRole("textbox", { name: "Message" });
  const png = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
  const pdf = new File([new Uint8Array([37, 80, 68, 70])], "notes.pdf", {
    type: "application/pdf",
  });
  fireEvent.paste(body, {
    clipboardData: { files: [png, pdf], types: ["Files"], getData: () => "" },
  });

  // In the text before its file is staged, where the cursor was, shown from the pasted bytes.
  const win = () => useComposeStore.getState().windows[0];
  const cid = /src="cid:([0-9a-f]{32}@pheeme\.app)"/.exec(win().draft.bodyHtml)?.[1];
  expect(cid).toBeTruthy();
  const image = await waitFor(() => {
    const img = body.querySelector("img.compose-image");
    expect(img?.getAttribute("src")).toBe("blob:shot");
    return img;
  });
  expect(image).not.toBeNull();
  await waitFor(() => expect(finishImage).not.toBeNull());
  await act(async () => finishImage!());
  await waitFor(() => expect(win().attaching).toBe(0));
  expect(win().draft.attachments.map((a) => a.contentId)).toEqual([null, cid]);
  // Only the PDF is listed as a file; the image is in the text.
  expect(await within(panel).findByText("notes.pdf")).toBeTruthy();
  expect(within(panel).queryByText("image.png")).toBeNull();
  expect(calls.filter((c) => c.cmd === "stage_pasted_attachment").map((c) => c.args)).toEqual([
    { filename: "notes.pdf", mimeType: "application/pdf", data: "JVBERg==", contentId: null },
    { filename: "image.png", mimeType: "image/png", data: "iVBORw==", contentId: cid },
  ]);

  // Pasted into the subject, a screenshot is still attached as a file.
  fireEvent.paste(within(panel).getByLabelText("Subject"), {
    clipboardData: { files: [png], types: ["Files"], getData: () => "" },
  });
  expect(await within(panel).findByText("image.png")).toBeTruthy();

  fireEvent.paste(body, {
    clipboardData: {
      files: [png],
      types: ["text/plain", "Files"],
      getData: (t: string) => (t === "text/plain" ? "Q3 numbers" : ""),
    },
  });
  expect(await within(panel).findByText(/Q3 numbers/)).toBeTruthy();
  expect(win().attaching).toBe(0);
  expect(calls.filter((c) => c.cmd === "stage_pasted_attachment")).toHaveLength(3);
  vi.unstubAllGlobals();
});

test("a pasted image whose file couldn't be staged comes back out of the text", async () => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:shot" }));
  mockIPC((cmd) => {
    if (cmd === "stage_pasted_attachment")
      throw { code: "invalid_input", message: "Attachments can add up to 25 MB at most." };
    return undefined;
  });
  const panel = await openNew();
  const body = await within(panel).findByRole("textbox", { name: "Message" });
  const png = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
  fireEvent.paste(body, { clipboardData: { files: [png], types: ["Files"], getData: () => "" } });
  const win = () => useComposeStore.getState().windows[0];
  expect(win().draft.bodyHtml).toContain("cid:");
  await waitFor(() => expect(win().draft.bodyHtml).not.toContain("cid:"));
  expect(body.querySelector("img.compose-image")).toBeNull();
  expect(win().draft.attachments).toEqual([]);
  vi.unstubAllGlobals();
});
