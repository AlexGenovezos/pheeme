import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dismissToast, useToastStore } from "../components/ui/Toast";
import type { ComposeDraft } from "../lib/tauri";
import { __resetComposeSettingsForTests, useComposeSettings } from "./composeSettings";
import {
  __resetComposeStoreForTests,
  type ComposeWindow,
  emptyDraft,
  MAX_WINDOWS,
  sendProblem,
  useComposeStore,
} from "./composeStore";

type Call = { cmd: string; args: Record<string, unknown> };
let calls: Call[];
let handlers: Record<string, (args: Record<string, unknown>) => unknown>;
let stopEvents: (() => void) | null = null;

const store = () => useComposeStore.getState();
const win = (id: number): ComposeWindow => store().windows.find((w) => w.id === id)!;
const titles = () => useToastStore.getState().toasts.map((t) => t.title);
const called = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const mira = { name: "Mira", address: "mira@example.com" };

beforeEach(async () => {
  localStorage.clear();
  __resetComposeSettingsForTests();
  __resetComposeStoreForTests();
  useToastStore.getState().toasts.forEach((t) => dismissToast(t.id));
  calls = [];
  let n = 0;
  handlers = {
    save_draft: () => ({ draftId: "d1", messageId: `m${++n}`, threadId: "t1" }),
    send_email: () => ({ opId: "op1", sendAt: Date.now() + 5000 }),
    cancel_send: () => true,
  };
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      return handlers[cmd]?.((args ?? {}) as Record<string, unknown>);
    },
    { shouldMockEvents: true },
  );
  stopEvents = await store().subscribe();
});
afterEach(() => {
  stopEvents?.();
  vi.useRealTimers();
});

/** A new message from a1 with someone to send to and a body. */
function written(change: Partial<ComposeDraft> = {}): number {
  const id = store().compose("a1");
  store().update(id, { to: [mira], bodyHtml: "<p>Hello</p>", ...change });
  return id;
}

test("send problems: no recipients, a bad address, attachments over 25 MB", () => {
  expect(sendProblem(emptyDraft())).toBe("Add at least one recipient.");
  expect(sendProblem({ ...emptyDraft(), cc: [{ name: null, address: "nope" }] })).toMatch(/nope/);
  expect(
    sendProblem({
      ...emptyDraft(),
      to: [mira],
      attachments: [{ id: "x", filename: "big", mimeType: "a/b", size: 26 * 1024 * 1024 }],
    }),
  ).toMatch(/25 MB/);
  expect(sendProblem({ ...emptyDraft(), to: [mira] })).toBeNull();
});

test("sending closes the panel with an Undo that brings the message back", async () => {
  const id = written();
  await store().send(id);
  expect(called("send_email")).toEqual([
    {
      accountId: "a1",
      message: expect.objectContaining({ to: [mira], bodyHtml: "<p>Hello</p>" }),
      undoMs: 5000,
    },
  ]);
  expect(store().windows).toEqual([]);
  const sending = useToastStore.getState().toasts.find((t) => t.title === "Sending…")!;
  sending.action!.run();
  await vi.waitFor(() => expect(store().windows).toHaveLength(1));
  expect(called("cancel_send")).toEqual([{ opId: "op1" }]);
  expect(store().windows[0].draft).toMatchObject({ to: [mira], bodyHtml: "<p>Hello</p>" });
});

test("Undo too late says so and doesn't reopen", async () => {
  handlers.cancel_send = () => false;
  await store().send(written());
  useToastStore
    .getState()
    .toasts.find((t) => t.title === "Sending…")!
    .action!.run();
  await vi.waitFor(() => expect(titles()).toContain("Too late to undo"));
  expect(store().windows).toEqual([]);
});

test("the undo setting decides the wait; Off sends at once with no Undo", async () => {
  useComposeSettings.getState().setUndoSendSeconds(0);
  await store().send(written());
  expect(called("send_email")[0].undoMs).toBe(0);
  expect(
    useToastStore.getState().toasts.find((t) => t.title === "Sending…")?.action,
  ).toBeUndefined();
});

test("sent: the toast says so and the staged files are let go", async () => {
  const id = written({
    attachments: [{ id: "s1", filename: "a.pdf", mimeType: "application/pdf", size: 10 }],
  });
  await store().send(id);
  expect(called("discard_attachments")).toEqual([]); // kept while Undo might need them
  await emit("outbox:send_status", { accountId: "a1", opId: "op1", status: "sent" });
  await vi.waitFor(() => expect(titles()).toContain("Message sent"));
  expect(titles()).not.toContain("Sending…");
  expect(called("discard_attachments")).toEqual([{ ids: ["s1"] }]);
});

test("a refused send comes back to be fixed, and leaves the outbox", async () => {
  await store().send(written());
  await emit("outbox:send_status", { accountId: "a1", opId: "op1", status: "failed" });
  await vi.waitFor(() => expect(store().windows).toHaveLength(1));
  expect(store().windows[0].error).toMatch(/didn't accept/);
  expect(store().windows[0].draft.to).toEqual([mira]);
  expect(called("cancel_send")).toEqual([{ opId: "op1" }]);
  expect(titles()).toContain("Couldn't send your message");
});

test("a send that can't start keeps the panel open with the reason", async () => {
  handlers.send_email = () => {
    throw { code: "invalid", message: "Add at least one recipient." };
  };
  const id = written();
  await store().send(id);
  expect(win(id)).toMatchObject({ sending: false, error: "Add at least one recipient." });
});

test("nothing to send to: no command, the panel says why", async () => {
  const id = store().compose("a1");
  await store().send(id);
  expect(called("send_email")).toEqual([]);
  expect(win(id).error).toBe("Add at least one recipient.");
});

test("saving keeps the draft id, and a send waits for a save in flight", async () => {
  let release!: () => void;
  handlers.save_draft = () =>
    new Promise((resolve) => {
      release = () => resolve({ draftId: "d1", messageId: "m1", threadId: "t1" });
    });
  const id = written();
  const saving = store().save(id);
  const sending = store().send(id);
  await vi.waitFor(() => expect(called("save_draft")).toHaveLength(1));
  expect(called("send_email")).toEqual([]);
  release();
  await saving;
  await sending;
  expect((called("send_email")[0].message as ComposeDraft).draftId).toBe("d1");
});

test("autosave skips untouched and blank messages", async () => {
  const id = store().compose("a1");
  expect(await store().save(id)).toBe(true);
  store().update(id, { subject: "" });
  expect(await store().save(id)).toBe(true);
  expect(called("save_draft")).toEqual([]);
  store().update(id, { subject: "Plans" });
  await store().save(id);
  await store().save(id); // nothing new
  expect(called("save_draft")).toHaveLength(1);
  expect(win(id)).toMatchObject({ savedAt: expect.any(Number), draft: { draftId: "d1" } });
});

test("closing: quiet when untouched, asks when there are unsaved changes", async () => {
  const quiet = store().compose("a1");
  store().requestClose(quiet);
  expect(store().windows).toEqual([]);

  const id = written();
  store().requestClose(id);
  expect(win(id).confirmingClose).toBe(true);
  store().cancelClose(id);
  expect(win(id).confirmingClose).toBe(false);

  store().requestClose(id);
  await store().saveAndClose(id);
  expect(store().windows).toEqual([]);
  expect(called("save_draft")).toHaveLength(1);
  expect(titles()).toContain("Draft saved");
});

test("closing after everything is saved closes without asking", async () => {
  const id = written();
  await store().save(id);
  store().requestClose(id);
  expect(store().windows).toEqual([]);
});

test("discard deletes the saved draft", async () => {
  const id = written();
  await store().save(id);
  await store().discard(id);
  expect(called("delete_draft")).toEqual([{ accountId: "a1", draftId: "d1" }]);
  expect(store().windows).toEqual([]);
  expect(titles()).toContain("Draft discarded");
});

test("a reply panel loads its template; a failure closes it with the reason", async () => {
  handlers.compose_template = () => ({ ...emptyDraft(), to: [mira], subject: "Re: Hi" });
  await store().respond("a1", "m9", "reply");
  expect(store().windows).toMatchObject([
    { kind: "reply", loading: false, draft: { subject: "Re: Hi" } },
  ]);

  handlers.compose_template = () => {
    throw { code: "not_found", message: "Gone." };
  };
  await store().respond("a1", "m9", "forward");
  expect(store().windows).toHaveLength(1);
  expect(titles()).toContain("Gone.");
});

test("attachments: staged files join the message; a failure is reported", async () => {
  handlers.stage_attachment = ({ path }) => {
    if (path === "/bad") throw { code: "invalid", message: "Couldn't read that file." };
    return { id: `s-${String(path)}`, filename: "a.pdf", mimeType: "x/y", size: 5 };
  };
  const id = store().compose("a1");
  await store().attachFiles(id, ["/a", "/bad"]);
  expect(win(id).draft.attachments.map((a) => a.id)).toEqual(["s-/a"]);
  expect(win(id).attaching).toBe(0);
  expect(titles()).toContain("Couldn't read that file.");
  store().removeAttachment(id, "s-/a");
  expect(win(id).draft.attachments).toEqual([]);
  expect(called("discard_attachments")).toEqual([{ ids: ["s-/a"] }]);
});

test("switching account moves the draft out of the old account", async () => {
  const id = written();
  await store().save(id);
  store().setAccount(id, "a2");
  expect(win(id)).toMatchObject({ accountId: "a2", draft: { draftId: null } });
  expect(called("delete_draft")).toEqual([{ accountId: "a1", draftId: "d1" }]);
});

test(`at most ${MAX_WINDOWS} panels; opening one tucks the others away`, () => {
  for (let i = 0; i < MAX_WINDOWS; i++) store().compose("a1");
  expect(store().windows.map((w) => w.minimized)).toEqual([true, true, false]);
  expect(store().compose("a1")).toBe(-1);
  expect(store().windows).toHaveLength(MAX_WINDOWS);
  expect(titles()).toContain("Too many messages open");
});

/** `save_draft` that waits for `release()`. */
function heldSave(): () => void {
  let release: () => void = () => {};
  handlers.save_draft = () =>
    new Promise((resolve) => {
      release = () => resolve({ draftId: "d1", messageId: "m1", threadId: "t1" });
    });
  return () => release();
}

test("discarding during the first save deletes the draft that save made", async () => {
  const release = heldSave();
  const id = written();
  const saving = store().save(id);
  await vi.waitFor(() => expect(called("save_draft")).toHaveLength(1));
  const discarding = store().discard(id);
  release();
  await saving;
  await discarding;
  expect(called("delete_draft")).toEqual([{ accountId: "a1", draftId: "d1" }]);
});

test("Undo brings the message back even with every panel slot taken", async () => {
  await store().send(written());
  for (let i = 0; i < MAX_WINDOWS; i++) store().compose("a1");
  useToastStore
    .getState()
    .toasts.find((t) => t.title === "Sending…")!
    .action!.run();
  await vi.waitFor(() => expect(store().windows).toHaveLength(MAX_WINDOWS + 1));
  expect(store().windows[MAX_WINDOWS].draft.to).toEqual([mira]);
  expect(called("discard_attachments")).toEqual([]);
});

test("Save draft on close saves edits made during the save before closing", async () => {
  const release = heldSave();
  const id = written({ bodyHtml: "<p>before</p>" });
  const closing = store().saveAndClose(id);
  await vi.waitFor(() => expect(called("save_draft")).toHaveLength(1));
  store().update(id, { bodyHtml: "<p>after</p>" });
  handlers.save_draft = () => ({ draftId: "d1", messageId: "m2", threadId: "t1" });
  release();
  await closing;
  expect(store().windows).toEqual([]);
  expect(called("save_draft").map((a) => (a.message as ComposeDraft).bodyHtml)).toEqual([
    "<p>before</p>",
    "<p>after</p>",
  ]);
});

test("while sending, edits and closing are ignored", async () => {
  let queue: () => void = () => {};
  handlers.send_email = () =>
    new Promise((resolve) => {
      queue = () => resolve({ opId: "op1", sendAt: Date.now() + 5000 });
    });
  const id = written();
  const sending = store().send(id);
  await vi.waitFor(() => expect(called("send_email")).toHaveLength(1));
  store().update(id, { subject: "changed" });
  await store().discard(id);
  expect(win(id).draft.subject).toBe("");
  expect(win(id).sending).toBe(true);
  queue();
  await sending;
  expect(store().windows).toEqual([]);
});
