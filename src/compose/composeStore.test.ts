import { emit, listen } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dismissToast, useToastStore } from "../components/ui/Toast";
import type { ComposeDraft } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { installBeforeQuit } from "../lib/updater";
import { saveBeforeExit } from "./ComposeHost";
import { __resetComposeSettingsForTests, useComposeSettings } from "./composeSettings";
import {
  __resetComposeStoreForTests,
  type ComposeWindow,
  emptyDraft,
  gmailDraftsUrl,
  MAX_WINDOWS,
  SAVED_BEFORE_EXIT_EVENT,
  sendProblem,
  useComposeStore,
} from "./composeStore";
import { __resetSendAsForTests } from "./sendAs";
import { __resetSignaturesForTests, useSignatures } from "./signatures";

vi.mock("../lib/updater", () => ({ installBeforeQuit: vi.fn(async () => {}) }));

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
  __resetSignaturesForTests();
  __resetSendAsForTests();
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
  await vi.waitFor(() => expect(called("save_draft")).toHaveLength(1));
  const sending = store().send(id);
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

test("forward as attachment opens a new message with the .eml files; a failure closes it", async () => {
  const eml = { id: "s1", filename: "Hi.eml", mimeType: "message/rfc822", size: 900 };
  handlers.forward_as_attachment = () => ({
    ...emptyDraft(),
    subject: "Fwd: Hi",
    attachments: [eml],
  });
  await store().forwardAsAttachment("a1", { threadIds: ["t1", "t2"] });
  expect(called("forward_as_attachment")).toEqual([
    { accountId: "a1", threadIds: ["t1", "t2"], messageIds: [] },
  ]);
  expect(store().windows).toMatchObject([
    { kind: "new", loading: false, draft: { subject: "Fwd: Hi", attachments: [eml] } },
  ]);

  handlers.forward_as_attachment = () => {
    throw { code: "invalid_input", message: "Too big." };
  };
  await store().forwardAsAttachment("a1", { messageIds: ["m1"] });
  expect(store().windows).toHaveLength(1);
  expect(titles()).toContain("Too big.");
});

const SIGNED =
  '<p></p><div class="gmail_signature" data-smartmail="gmail_signature"><b>Me</b></div>';

test("a new message starts with the signature, and a signature alone isn't worth keeping", async () => {
  handlers.gmail_signature = () => "<b>Me</b>";
  await useSignatures.getState().refreshGmail("a1");
  const id = store().compose("a1");
  expect(win(id).draft.bodyHtml).toBe(SIGNED);
  store().update(id, { bodyHtml: SIGNED.replace("<p></p>", "<p> </p>") });
  store().requestClose(id);
  expect(store().windows).toEqual([]); // no "Save draft?" for an untouched signature
  expect(called("save_draft")).toEqual([]);

  useSignatures.getState().update("a1", { newMessages: "none" });
  expect(win(store().compose("a1")).draft.bodyHtml).toBe("");
});

test("a reply waits for a first fetch of the Gmail signature and puts it above the quote", async () => {
  handlers.gmail_signature = () => "<b>Me</b>";
  handlers.compose_template = () => ({ ...emptyDraft(), quoteHtml: "<blockquote>Hi</blockquote>" });
  await store().respond("a1", "m9", "reply");
  expect(called("gmail_signature")).toHaveLength(1);
  expect(store().windows[0].draft).toMatchObject({
    bodyHtml: SIGNED,
    quoteHtml: "<blockquote>Hi</blockquote>",
  });

  useSignatures.getState().update("a1", { replies: "none" });
  await store().respond("a1", "m10", "forward");
  expect(store().windows[1].draft.bodyHtml).toBe("");
  expect(called("gmail_signature")).toHaveLength(1); // once a session
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

test("a save that lands after an account switch deletes its draft from the old account only", async () => {
  const release = heldSave();
  const id = written();
  const saving = store().save(id);
  await vi.waitFor(() => expect(called("save_draft")).toHaveLength(1));
  store().setAccount(id, "a2");
  release();
  await saving;
  expect(win(id)).toMatchObject({ accountId: "a2", saving: false, draft: { draftId: null } });
  expect(called("delete_draft")).toEqual([{ accountId: "a1", draftId: "d1" }]);
  // Discarding now has no a1 draft to delete from a2.
  await store().discard(id);
  expect(called("delete_draft")).toEqual([{ accountId: "a1", draftId: "d1" }]);
});

test("discarding after a switch that raced a save deletes that draft from its own account", async () => {
  const release = heldSave();
  const id = written();
  const saving = store().save(id);
  await vi.waitFor(() => expect(called("save_draft")).toHaveLength(1));
  store().setAccount(id, "a2");
  const discarding = store().discard(id);
  release();
  await saving;
  await discarding;
  expect(called("delete_draft")).toEqual([{ accountId: "a1", draftId: "d1" }]);
});

test("the account can't change while the message is sending", async () => {
  handlers.send_email = () => new Promise(() => {});
  const id = written();
  void store().send(id);
  await vi.waitFor(() => expect(win(id).sending).toBe(true));
  store().setAccount(id, "a2");
  expect(win(id).accountId).toBe("a1");
});

test("filling in what an untouched message starts with leaves nothing to save", async () => {
  const id = store().compose("a1");
  store().fillIn(id, { from: mira, bodyHtml: "<p></p><div>sig</div>" });
  expect(win(id)).toMatchObject({ version: 0, draft: { from: mira } });
  await store().save(id);
  expect(called("save_draft")).toEqual([]);
  // Once it's been edited, a fill-in is a change like any other.
  store().update(id, { subject: "Hi" });
  store().fillIn(id, { from: mira });
  expect(win(id).version).toBe(2);
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

test("Save draft on close of a message emptied meanwhile just closes", async () => {
  const id = written({ bodyHtml: "", to: [] });
  store().update(id, { subject: "x" });
  store().requestClose(id);
  store().update(id, { subject: "" });
  await store().saveAndClose(id);
  expect(store().windows).toEqual([]);
  expect(called("save_draft")).toEqual([]);
});

test("no autosave once a send is queued", async () => {
  let queue: () => void = () => {};
  handlers.send_email = () =>
    new Promise((resolve) => {
      queue = () => resolve({ opId: "op1", sendAt: Date.now() + 5000 });
    });
  const id = written();
  const sending = store().send(id);
  await vi.waitFor(() => expect(called("send_email")).toHaveLength(1));
  expect(await store().save(id, { quiet: true })).toBe(false);
  queue();
  await sending;
  expect(called("save_draft")).toEqual([]);
});

const ALIASES = [
  {
    email: "me@example.com",
    name: "Me",
    isPrimary: true,
    isDefault: false,
    signature: "<b>Me</b>",
  },
  {
    email: "work@example.com",
    name: "Work",
    isPrimary: false,
    isDefault: true,
    signature: "<b>Work</b>",
  },
  {
    email: "sales@example.com",
    name: "Sales",
    isPrimary: false,
    isDefault: false,
    signature: null,
  },
];

test("send-as aliases: a new message starts from Gmail's default; a reply from an alias takes its signature", async () => {
  handlers.gmail_signature = () => "<b>Me</b>";
  handlers.send_as_addresses = () => ALIASES;
  handlers.compose_template = () => ({
    ...emptyDraft(),
    from: { name: "Work", address: "work@example.com" },
  });
  await store().respond("a1", "m9", "reply");
  expect(called("send_as_addresses")).toEqual([{ accountId: "a1" }]);
  expect(store().windows[0].draft).toMatchObject({
    from: { address: "work@example.com" },
    bodyHtml: SIGNED.replace("<b>Me</b>", "<b>Work</b>"),
  });

  const id = store().compose("a1");
  expect(win(id).draft.from).toEqual({ name: "Work", address: "work@example.com" });
  expect(win(id).draft.bodyHtml).toBe(SIGNED.replace("<b>Me</b>", "<b>Work</b>"));

  // An alias with no Gmail signature has none; the account's own address keeps the account's.
  expect(useSignatures.getState().signatureFor("a1", "new", "sales@example.com")).toBeNull();
  expect(useSignatures.getState().signatureFor("a1", "new", "me@example.com")).toBe("<b>Me</b>");
  useSignatures.getState().update("a1", { newMessages: "custom", custom: "<i>Mine</i>" });
  expect(useSignatures.getState().signatureFor("a1", "new", "work@example.com")).toBe(
    "<i>Mine</i>",
  );

  store().setFrom(id, { name: "Sales", address: "sales@example.com" });
  store().update(id, { to: [mira] });
  await store().send(id);
  expect(called("send_email")[0]?.message).toMatchObject({
    from: { name: "Sales", address: "sales@example.com" },
  });
});

test("Send later saves the draft, closes the panel and opens it in Gmail on the right account", async () => {
  useAccountStore.setState({
    accounts: [
      {
        id: "a1",
        email: "me+x@example.com",
        displayName: null,
        clientId: "c",
        synced: true,
        color: 1,
      },
    ],
  });
  handlers.open_external = () => undefined;
  const id = written();
  await store().save(id);
  // Nothing new since that save: it saves again, so Gmail opens the latest message.
  await store().sendLater(id);
  expect(called("save_draft")).toHaveLength(2);
  expect(called("save_draft")[1]).toMatchObject({ accountId: "a1", message: { draftId: "d1" } });
  expect(store().windows).toEqual([]);
  expect(called("open_external")).toEqual([
    { url: "https://mail.google.com/mail/u/me%2Bx%40example.com/#drafts" },
  ]);
  expect(called("send_email")).toEqual([]);
  expect(titles()).toContain("Draft saved and Gmail opened");
  expect(gmailDraftsUrl("a@b.co")).toBe("https://mail.google.com/mail/u/a%40b.co/#drafts");
});

test("Send later keeps the panel when the message isn't ready or the save fails", async () => {
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
  const blank = store().compose("a1");
  await store().sendLater(blank);
  expect(win(blank).error).toBe("Add at least one recipient.");
  expect(called("save_draft")).toEqual([]);

  handlers.save_draft = () => {
    throw { code: "network", message: "Can't reach Gmail." };
  };
  const id = written();
  await store().sendLater(id);
  expect(win(id).error).toBe("Can't reach Gmail.");
  expect(called("open_external")).toEqual([]);
});

test("Send later opens the draft in the account it was saved in, and waits for files still attaching", async () => {
  useAccountStore.setState({
    accounts: [
      {
        id: "a1",
        email: "one@example.com",
        displayName: null,
        clientId: "c",
        synced: true,
        color: 1,
      },
      {
        id: "a2",
        email: "two@example.com",
        displayName: null,
        clientId: "c",
        synced: true,
        color: 1,
      },
    ],
  });
  handlers.open_external = () => undefined;
  let release: () => void = () => {};
  let saves = 0;
  handlers.save_draft = () =>
    ++saves === 1
      ? new Promise((resolve) => {
          release = () => resolve({ draftId: "d1", messageId: "m1", threadId: "t1" });
        })
      : { draftId: "d2", messageId: "m2", threadId: "t2" };
  const id = written();
  const later = store().sendLater(id);
  await vi.waitFor(() => expect(saves).toBe(1));
  store().setAccount(id, "a2"); // while the first save is out
  release();
  await later;
  expect(called("save_draft")[called("save_draft").length - 1]).toMatchObject({ accountId: "a2" });
  expect(called("open_external")[0]?.url).toMatch(
    /^https:\/\/mail\.google\.com\/mail\/u\/two%40example\.com\//,
  );

  let staged: (v: unknown) => void = () => {};
  handlers.save_draft = () => ({ draftId: "d2", messageId: "m9", threadId: "t1" });
  handlers.stage_attachment = () => new Promise((resolve) => (staged = resolve));
  const next = written();
  const attaching = store().attachFiles(next, ["/a"]);
  await store().sendLater(next);
  expect(win(next).error).toBe("Wait for the attachments to finish.");
  staged({ id: "s-a", filename: "a.pdf", mimeType: "x/y", size: 5 });
  await attaching;
});

test("Edit draft on a draft that's already open shows its panel, even with every slot taken", async () => {
  handlers.open_draft = () => ({ ...emptyDraft(), subject: "Plans", draftId: "d7" });
  await store().editDraft("a1", "msg7");
  const draft = store().windows[0].id;
  store().compose("a1");
  store().compose("a1");
  expect(store().windows).toHaveLength(MAX_WINDOWS);
  expect(win(draft).minimized).toBe(true);

  await store().editDraft("a1", "msg7");
  expect(titles()).not.toContain("Too many messages open");
  expect(called("open_draft")).toHaveLength(1);
  expect(store().windows).toHaveLength(MAX_WINDOWS);
  expect(win(draft).minimized).toBe(false);
  expect(store().focusRequest?.id).toBe(draft);

  // Saved since: Drafts now lists it under the message that save made.
  store().update(draft, { subject: "Plans B" });
  handlers.save_draft = () => ({ draftId: "d7", messageId: "msg8", threadId: "t1" });
  await store().save(draft);
  store().setMinimized(draft, true);
  await store().editDraft("a1", "msg8");
  expect(called("open_draft")).toHaveLength(1);
  expect(win(draft).minimized).toBe(false);

  // Another draft still needs a free slot.
  await store().editDraft("a1", "other");
  expect(titles()).toContain("Too many messages open");
});

test("an unconfirmed send lets its staged files go", async () => {
  const id = written({
    attachments: [{ id: "s1", filename: "a.pdf", mimeType: "application/pdf", size: 10 }],
  });
  await store().send(id);
  await emit("outbox:send_status", { accountId: "a1", opId: "op1", status: "unconfirmed" });
  await vi.waitFor(() => expect(titles()).toContain("Couldn't confirm your message was sent"));
  expect(titles()).not.toContain("Sending…");
  expect(called("discard_attachments")).toEqual([{ ids: ["s1"] }]);
  expect(store().windows).toEqual([]);
});

const refused = {
  opId: "old1",
  status: "failed",
  subject: "Lunch",
  to: [mira],
  cc: [],
  bcc: [],
  error: "Invalid To header",
  threadId: null,
  queuedAt: 1,
  failedAt: 2,
};
const toast = (title: string) => useToastStore.getState().toasts.find((t) => t.title === title);

test("a send refused after a restart is shown, and Open brings it back from Drafts", async () => {
  handlers.failed_sends = () => [refused];
  handlers.reopen_failed_send = () => ({ draftId: "d9", messageId: "m9" });
  handlers.open_draft = () => ({ ...emptyDraft(), to: [mira], subject: "Lunch", draftId: "d9" });
  await store().checkFailedSends("a1");
  const notice = toast("Couldn't send “Lunch” to Mira");
  expect(notice).toMatchObject({ tone: "danger", duration: 0, action: { label: "Open" } });

  notice!.action!.run();
  await vi.waitFor(() => expect(store().windows[0]?.loading).toBe(false));
  expect(called("reopen_failed_send")).toEqual([{ accountId: "a1", opId: "old1" }]);
  expect(called("open_draft")).toEqual([{ accountId: "a1", messageId: "m9" }]);
  expect(store().windows[0]).toMatchObject({ accountId: "a1", kind: "draft" });
  expect(store().windows[0].draft).toMatchObject({ subject: "Lunch", draftId: "d9" });
});

test("failed sends are listed once per account per session, and not shown twice", async () => {
  handlers.failed_sends = () => [refused];
  await store().checkFailedSends("a1");
  await store().checkFailedSends("a1");
  expect(called("failed_sends")).toHaveLength(1);
  // The same op failing again (its event) doesn't bring a dismissed notice back.
  dismissToast(toast("Couldn't send “Lunch” to Mira")!.id);
  await emit("outbox:send_status", { accountId: "a1", opId: "old1", status: "failed" });
  await vi.waitFor(() => expect(called("failed_sends")).toHaveLength(2));
  expect(titles()).toEqual([]);
});

test("a failure for a send no panel tracks is shown, worded for unconfirmed sends", async () => {
  handlers.failed_sends = () => [
    { ...refused, opId: "x", subject: "Other" },
    {
      ...refused,
      status: "unconfirmed",
      subject: null,
      to: [],
      bcc: [{ name: null, address: "b@x.io" }],
    },
  ];
  await emit("outbox:send_status", { accountId: "a1", opId: "old1", status: "unconfirmed" });
  await vi.waitFor(() =>
    expect(titles()).toEqual(["Couldn't confirm your message to b@x.io was sent"]),
  );
  expect(toast(titles()[0])!.description).toBe("Check Sent before sending it again.");
  expect(called("failed_sends")).toEqual([{ accountId: "a1" }]);
});

test("Open that fails says why and offers the send again", async () => {
  handlers.failed_sends = () => [refused];
  handlers.reopen_failed_send = () => {
    throw { code: "offline", message: "No connection." };
  };
  await store().checkFailedSends("a1");
  toast("Couldn't send “Lunch” to Mira")!.action!.run();
  dismissToast(toast("Couldn't send “Lunch” to Mira")!.id);
  await vi.waitFor(() => expect(titles()).toContain("No connection."));
  expect(titles()).toContain("Couldn't send “Lunch” to Mira");
  expect(store().windows).toEqual([]);
});

test("a known unconfirmed send isn't announced a second time by the launch check", async () => {
  await store().send(written());
  await emit("outbox:send_status", { accountId: "a1", opId: "op1", status: "unconfirmed" });
  await vi.waitFor(() => expect(titles()).toContain("Couldn't confirm your message was sent"));
  handlers.failed_sends = () => [{ ...refused, opId: "op1", status: "unconfirmed" }];
  await store().checkFailedSends("a1");
  expect(titles()).toEqual(["Couldn't confirm your message was sent"]);
});

test("a failed autosave is remembered until a save gets through", async () => {
  const id = written();
  handlers.save_draft = () => {
    throw { code: "offline", message: "No connection." };
  };
  expect(await store().save(id, { quiet: true })).toBe(false);
  expect(win(id)).toMatchObject({ saveError: "No connection.", error: null, saving: false });
  store().update(id, { subject: "Still typing" });
  expect(win(id).saveError).toBe("No connection.");

  handlers.save_draft = () => ({ draftId: "d1", messageId: "m1", threadId: "t1" });
  expect(await store().save(id, { quiet: true })).toBe(true);
  expect(win(id)).toMatchObject({ saveError: null, savedAt: expect.any(Number) });
});

test("before quitting, every unsaved message is saved and Rust is told how it went", async () => {
  const answers: unknown[] = [];
  const stop = await listen(SAVED_BEFORE_EXIT_EVENT, (e) => answers.push(e.payload));
  // A downloaded update installs on the way out, once everything is saved and before Rust is answered.
  vi.mocked(installBeforeQuit).mockImplementation(async () => {
    answers.push("install");
  });
  const first = written({ subject: "One" });
  const second = written({ subject: "Two" });
  const untouched = store().compose("a1");
  await store().save(first);
  expect(called("save_draft")).toHaveLength(1);

  await saveBeforeExit();
  expect(called("save_draft").map((a) => (a.message as ComposeDraft).subject)).toEqual([
    "One",
    "Two",
  ]);
  expect(win(second).version).toBe(win(second).savedVersion);
  expect(answers).toEqual(["install", true]);
  expect(titles()).not.toContain("Pheeme didn't quit");

  // One can't be saved: the app is told to stay open, and that panel comes up with the reason.
  store().update(first, { subject: "One, edited" });
  store().update(second, { subject: "Two, edited" });
  store().setMinimized(untouched, false);
  handlers.save_draft = (args) => {
    if ((args.message as ComposeDraft).subject === "One, edited")
      throw { code: "offline", message: "No connection." };
    return { draftId: "d2", messageId: "m9", threadId: "t1" };
  };
  await saveBeforeExit();
  expect(answers).toEqual(["install", true, false]);
  expect(titles()).toContain("Pheeme didn't quit");
  expect(win(first)).toMatchObject({ minimized: false, error: "No connection." });
  expect(win(first).version).not.toBe(win(first).savedVersion);
  expect(win(second).version).toBe(win(second).savedVersion); // the others are still saved
  stop();
});

test("a reopened reply keeps its quote out of the editor, and saves it back untouched", async () => {
  const quoteHtml =
    '<div class="gmail_quote"><blockquote class="gmail_quote"><table style="width:100%"><tbody><tr>' +
    '<td><img src="cid:logo"></td></tr></tbody></table><div class="gmail_signature">Theirs</div></blockquote></div>';
  handlers.open_draft = () => ({
    ...emptyDraft(),
    to: [mira],
    subject: "Re: Plans",
    bodyHtml: "<p>Sounds good</p>",
    quoteHtml,
    inReplyTo: "<m1@x>",
    threadId: "t1",
    draftId: "d7",
  });
  await store().editDraft("a1", "msg7");
  const id = store().windows[0].id;
  expect(win(id).draft.bodyHtml).not.toContain("Theirs");

  store().update(id, { bodyHtml: "<p>Sounds great</p>" });
  await store().save(id);
  expect(called("save_draft")).toEqual([
    {
      accountId: "a1",
      message: expect.objectContaining({ bodyHtml: "<p>Sounds great</p>", quoteHtml }),
    },
  ]);
});

test("saving before quit waits for a send on its way to the outbox, and saves it if the send fails", async () => {
  let refuse: (e: unknown) => void = () => {};
  handlers.send_email = () => new Promise((_, reject) => (refuse = reject));
  const id = written();
  const sending = store().send(id);
  await vi.waitFor(() => expect(called("send_email")).toHaveLength(1));
  let done = false;
  const saving = store()
    .saveAll()
    .then((ok) => {
      done = true;
      return ok;
    });
  await new Promise((r) => setTimeout(r, 0));
  expect(done).toBe(false);
  refuse({ code: "offline", message: "No connection" });
  await sending;
  expect(await saving).toBe(true);
  expect(called("save_draft")).toHaveLength(1);
});

test("a save waits for pasted images to be staged; one that fails comes out of the text", async () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
  );
  const finish: Array<(ok: boolean) => void> = [];
  handlers.stage_pasted_attachment = (args) =>
    new Promise((resolve, reject) =>
      finish.push((ok) =>
        ok
          ? resolve({
              id: `s${finish.length}`,
              filename: "image.png",
              mimeType: "image/png",
              size: 4,
              contentId: args.contentId,
            })
          : reject({ code: "invalid_input", message: "Too big." }),
      ),
    );
  const id = store().compose("a1");
  const png = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
  const { contentIds, failed } = store().pasteImages(id, [png, png]);
  // The editor puts them in the text (here, as it would store it), then the panel is minimized.
  store().update(id, {
    bodyHtml: `<p>Hi</p><p>${contentIds.map((c) => `<img src="cid:${c}">`).join("")}</p>`,
  });
  store().setMinimized(id, true);

  const saved = store().save(id);
  await Promise.resolve();
  expect(called("save_draft")).toEqual([]);
  await vi.waitFor(() => expect(finish).toHaveLength(2));
  // Another image pasted while the save waits: it waits for that one too.
  const third = store().pasteImages(id, [png]);
  store().update(id, {
    bodyHtml: `${win(id).draft.bodyHtml}<img src="cid:${third.contentIds[0]}">`,
  });
  finish[0](true);
  finish[1](false);
  expect(await failed).toEqual([contentIds[1]]);
  await vi.waitFor(() => expect(finish).toHaveLength(3));
  expect(called("save_draft")).toEqual([]);
  finish[2](true);
  expect(await saved).toBe(true);

  const message = called("save_draft")[0].message as ComposeDraft;
  expect(message.bodyHtml).toContain(`cid:${contentIds[0]}`);
  expect(message.bodyHtml).not.toContain(`cid:${contentIds[1]}`);
  expect(message.bodyHtml).toContain(`cid:${third.contentIds[0]}`);
  expect(message.attachments.map((a) => a.contentId)).toEqual([contentIds[0], third.contentIds[0]]);
  vi.unstubAllGlobals();
});

test("closing a new message whose only content is an image still being staged asks first", async () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
  );
  let finish: (() => void) | null = null;
  handlers.stage_pasted_attachment = (args) =>
    new Promise((resolve) => {
      finish = () =>
        resolve({
          id: "s1",
          filename: "image.png",
          mimeType: "image/png",
          size: 4,
          contentId: args.contentId,
        });
    });
  const id = store().compose("a1");
  const png = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
  const { contentIds } = store().pasteImages(id, [png]);
  store().update(id, { bodyHtml: `<p><img src="cid:${contentIds[0]}"></p>` });
  store().requestClose(id);
  expect(win(id).confirmingClose).toBe(true);
  await vi.waitFor(() => expect(finish).not.toBeNull());
  finish!();
  await store().saveAndClose(id);
  const message = called("save_draft")[0].message as ComposeDraft;
  expect(message.attachments.map((a) => a.contentId)).toEqual(contentIds);
  vi.unstubAllGlobals();
});
