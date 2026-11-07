import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, expect, test, vi } from "vitest";
import type { LabelInfo } from "../lib/tauri";
import { __resetLabelStoreForTests, useLabelStore } from "./labelStore";

const label = (id: string, name: string, type = "user", accountId = "a"): LabelInfo => ({
  id,
  accountId,
  name,
  type,
  messagesTotal: 0,
  messagesUnread: 0,
  threadsTotal: 0,
  threadsUnread: 0,
  colorBackground: null,
  colorText: null,
  messageListVisibility: "show",
  labelListVisibility: "labelShow",
});

const store = () => useLabelStore.getState();

interface World {
  labels: Record<string, LabelInfo[]>;
  counts: Record<string, { labelId: string; unread: number; total: number }[]>;
  mailbox: Record<string, { labelId: string; unread: number }[]>;
  allInbox: number;
}

/** The commands the label store calls, answering from a mutable `world`; records every call. */
function backend(world: World) {
  const calls: [string, unknown][] = [];
  mockIPC(
    (cmd, args) => {
      calls.push([cmd, args]);
      const a = args as { accountId?: string; accountIds?: string[] };
      if (cmd === "list_labels") return world.labels[a.accountId ?? ""] ?? [];
      if (cmd === "label_counts") return world.counts[a.accountId ?? ""] ?? [];
      if (cmd === "mailbox_counts") {
        const ids = a.accountIds ?? [];
        if (ids.length > 1) return [{ labelId: "INBOX", unread: world.allInbox }];
        return world.mailbox[ids[0]] ?? [];
      }
      return undefined;
    },
    { shouldMockEvents: true },
  );
  return calls;
}

const world = (): World => ({
  labels: {
    a: [
      label("INBOX", "Inbox", "system"),
      label("Label_2", "travel"),
      label("Label_1", "Receipts"),
      label("SENT", "Sent", "system"),
    ],
    b: [label("Label_9", "Work", "user", "b")],
  },
  counts: {
    a: [
      { labelId: "INBOX", unread: 3, total: 10 },
      { labelId: "STARRED", unread: 0, total: 4 },
    ],
    b: [{ labelId: "INBOX", unread: 2, total: 5 }],
  },
  mailbox: {
    a: [
      { labelId: "INBOX", unread: 3 },
      { labelId: "CATEGORY_PERSONAL", unread: 1 },
      { labelId: "CATEGORY_SOCIAL", unread: 2 },
    ],
    b: [
      { labelId: "INBOX", unread: 2 },
      { labelId: "CATEGORY_PERSONAL", unread: 2 },
    ],
  },
  allInbox: 5,
});

beforeEach(() => __resetLabelStoreForTests());

test("load fills labels, label counts, category counts and the All Inboxes total", async () => {
  backend(world());
  await store().load(["a", "b"]);
  expect(store().labels.b.map((l) => l.id)).toEqual(["Label_9"]);
  expect(store().counts.a).toEqual({
    INBOX: { unread: 3, total: 10 },
    STARRED: { unread: 0, total: 4 },
  });
  expect(store().categoryCounts.a).toEqual({ INBOX: 3, CATEGORY_PERSONAL: 1, CATEGORY_SOCIAL: 2 });
  expect(store().categoryCounts.b).toEqual({ INBOX: 2, CATEGORY_PERSONAL: 2 });
  expect(store().allInboxUnread).toBe(5);
});

test("a single account's All Inboxes total comes from its own mailbox counts", async () => {
  const w = world();
  backend(w);
  await store().load(["a"]);
  expect(store().allInboxUnread).toBe(3);
});

test("userLabels sorts and filters by type", async () => {
  backend(world());
  await store().load(["a", "b"]);
  expect(
    store()
      .userLabels("a")
      .map((l) => l.name),
  ).toEqual(["Receipts", "travel"]);
  expect(store().userLabels("a")).toBe(store().userLabels("a"));
  expect(store().userLabels("nobody")).toEqual([]);
});

test("labelName resolves ids and falls back to the id", async () => {
  backend(world());
  await store().load(["a"]);
  expect(store().labelName("a", "Label_1")).toBe("Receipts");
  expect(store().labelName("a", "SENT")).toBe("Sent");
  expect(store().labelName("a", "Label_404")).toBe("Label_404");
  expect(store().labelName("zzz", "Label_1")).toBe("Label_1");
});

test("reloads counts on sync events", async () => {
  const w = world();
  backend(w);
  await store().load(["a", "b"]);
  const stop = await store().subscribe();

  w.counts.a = [{ labelId: "INBOX", unread: 9, total: 10 }];
  await emit("sync:messages_updated", { accountId: "a", added: [], removed: [], modified: ["t1"] });
  await vi.waitFor(() => expect(store().counts.a.INBOX.unread).toBe(9));

  w.labels.a = [label("Label_7", "Fresh")];
  await emit("sync:labels_updated", { accountId: "a" });
  await vi.waitFor(() => expect(store().labels.a.map((l) => l.id)).toEqual(["Label_7"]));

  w.allInbox = 11;
  await emit("sync:completed", { accountId: "b" });
  await vi.waitFor(() => expect(store().allInboxUnread).toBe(11));
  stop();
});

test("a load drops accounts that are no longer connected", async () => {
  backend(world());
  await store().load(["a", "b"]);
  await store().load(["a"]);
  expect(Object.keys(store().labels)).toEqual(["a"]);
  expect(Object.keys(store().counts)).toEqual(["a"]);
  expect(Object.keys(store().categoryCounts)).toEqual(["a"]);
});

test("one account failing leaves the others (and its own last values) in place", async () => {
  const w = world();
  let failB = false;
  mockIPC((cmd, args) => {
    const a = args as { accountId?: string; accountIds?: string[] };
    if (failB && a.accountId === "b") throw { code: "internal", message: "boom" };
    if (failB && a.accountIds?.length === 1 && a.accountIds[0] === "b")
      throw { code: "internal", message: "boom" };
    if (cmd === "list_labels") return w.labels[a.accountId ?? ""] ?? [];
    if (cmd === "label_counts") return w.counts[a.accountId ?? ""] ?? [];
    if (cmd === "mailbox_counts")
      return (a.accountIds ?? []).length > 1
        ? [{ labelId: "INBOX", unread: w.allInbox }]
        : (w.mailbox[(a.accountIds ?? [])[0]] ?? []);
    return undefined;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await store().load(["a", "b"]);
  failB = true;
  w.counts.a = [{ labelId: "INBOX", unread: 8, total: 10 }];
  await store().load(["a", "b"]);
  expect(store().counts.a.INBOX.unread).toBe(8);
  expect(store().counts.b.INBOX).toEqual({ unread: 2, total: 5 });
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test("only the latest load writes its result", async () => {
  const w = world();
  const gates: Array<() => void> = [];
  mockIPC((cmd, args) => {
    const a = args as { accountId?: string; accountIds?: string[] };
    if (cmd === "label_counts") {
      const snapshot = w.counts[a.accountId ?? ""] ?? [];
      return new Promise((resolve) => gates.push(() => resolve(snapshot)));
    }
    if (cmd === "list_labels") return [];
    if (cmd === "mailbox_counts") return [];
    return undefined;
  });
  const first = store().load(["a"]);
  await vi.waitFor(() => expect(gates).toHaveLength(1));
  w.counts.a = [{ labelId: "INBOX", unread: 1, total: 1 }];
  const second = store().load(["a"]);
  await vi.waitFor(() => expect(gates).toHaveLength(2));
  gates[1]();
  await second;
  gates[0]();
  await first;
  expect(store().counts.a.INBOX.unread).toBe(1);
});

const readChange = (delta = -1) => ({
  accountId: "a",
  delta,
  labelIds: ["INBOX"],
  categoryIds: ["INBOX", "CATEGORY_SOCIAL"],
});

test("pending reads reject older refreshes and reconcile once all commands settle", async () => {
  const w = world();
  backend(w);
  await store().load(["a", "b"]);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  mockIPC(async (cmd, args) => {
    const a = args as { accountId?: string; accountIds?: string[] };
    const snapshot =
      cmd === "list_labels"
        ? w.labels[a.accountId ?? ""]
        : cmd === "label_counts"
          ? w.counts[a.accountId ?? ""]
          : a.accountIds?.length === 1
            ? w.mailbox[a.accountIds[0]]
            : [{ labelId: "INBOX", unread: w.allInbox }];
    await gate;
    return snapshot;
  });
  const stale = store().load(["a", "b"]);
  store().patchUnread(1, [readChange()]);
  store().patchUnread(2, [readChange()]);
  release();
  await stale;
  expect(store().counts.a.INBOX).toEqual({ unread: 1, total: 10 });
  expect(store().categoryCounts.a.CATEGORY_SOCIAL).toBe(0);
  expect(store().allInboxUnread).toBe(3);
  expect(store().counts.b.INBOX.unread).toBe(2);

  // A refresh after one write commits mustn't count it twice or restore the other unread row.
  w.counts.a = [{ labelId: "INBOX", unread: 2, total: 10 }];
  w.allInbox = 4;
  store().settleUnread(1);
  await store().load(["a", "b"]);
  expect(store().counts.a.INBOX.unread).toBe(1);
  expect(store().allInboxUnread).toBe(3);

  w.counts.a = [{ labelId: "INBOX", unread: 1, total: 10 }];
  w.mailbox.a = [
    { labelId: "INBOX", unread: 1 },
    { labelId: "CATEGORY_PERSONAL", unread: 1 },
  ];
  w.allInbox = 3;
  store().settleUnread(2);
  await vi.waitFor(() =>
    expect(store().categoryCounts.a).toEqual({ INBOX: 1, CATEGORY_PERSONAL: 1 }),
  );
  expect(store().counts.a.INBOX.unread).toBe(1);
  expect(store().allInboxUnread).toBe(3);
});

test("failed or cancelled reads restore cached counts, and mark-unread raises them immediately", async () => {
  backend(world());
  await store().load(["a", "b"]);
  store().patchUnread(1, [readChange()]);
  expect(store().allInboxUnread).toBe(4);
  store().settleUnread(1); // No cache write: failed command or cancelled automatic read.
  await vi.waitFor(() => expect(store().allInboxUnread).toBe(5));
  expect(store().counts.a.INBOX.unread).toBe(3);

  store().patchUnread(2, [readChange(1)]);
  expect(store().counts.a.INBOX).toEqual({ unread: 4, total: 10 });
  expect(store().categoryCounts.a.CATEGORY_SOCIAL).toBe(3);
  expect(store().allInboxUnread).toBe(6);
  store().settleUnread(2);
  await vi.waitFor(() => expect(store().allInboxUnread).toBe(5));
});

test("a label change waiting for Gmail shows at once and survives reloads until it settles", async () => {
  const w = world();
  backend(w);
  await store().load(["a"]);
  const hide = (labels: LabelInfo[]) =>
    labels.map((l) => (l.id === "Label_2" ? { ...l, labelListVisibility: "labelHide" } : l));
  const change = store().patchLabels("a", hide);
  const travel = () => store().labels.a.find((l) => l.id === "Label_2");
  expect(travel()?.labelListVisibility).toBe("labelHide");

  // A sync refresh reads the cache, which doesn't have the change yet: it stays shown.
  await store().load(["a"]);
  expect(travel()?.labelListVisibility).toBe("labelHide");

  // Gmail took it: its copy goes in.
  const taken = { ...label("Label_2", "travel"), labelListVisibility: "labelHide" };
  store().settleLabels(change, [taken]);
  expect(travel()).toEqual(taken);
});

test("a refused label change goes back, keeping a later change still waiting", async () => {
  const w = world();
  const calls = backend(w);
  await store().load(["a"]);
  const set = (patch: Partial<LabelInfo>) => (labels: LabelInfo[]) =>
    labels.map((l) => (l.id === "Label_2" ? { ...l, ...patch } : l));
  const hide = store().patchLabels("a", set({ labelListVisibility: "labelHide" }));
  const colour = store().patchLabels("a", set({ colorBackground: "#16a766" }));
  const travel = () => store().labels.a.find((l) => l.id === "Label_2");
  expect(travel()).toMatchObject({ labelListVisibility: "labelHide", colorBackground: "#16a766" });

  const reads = calls.length;
  store().settleLabels(hide, null);
  expect(travel()).toMatchObject({ labelListVisibility: "labelShow", colorBackground: "#16a766" });
  // A refusal re-reads the labels, in case Gmail took part of it.
  expect(calls.slice(reads).map(([cmd]) => cmd)).toContain("list_labels");
  await vi.waitFor(() => expect(travel()?.colorBackground).toBe("#16a766"));

  store().settleLabels(colour, null);
  expect(travel()).toMatchObject({ labelListVisibility: "labelShow", colorBackground: null });
});

test("a refused label change doesn't undo a later change Gmail already took", async () => {
  const w = world();
  backend(w);
  await store().load(["a"]);
  const colour = (c: string) => (labels: LabelInfo[]) =>
    labels.map((l) => (l.id === "Label_2" ? { ...l, colorBackground: c } : l));
  const first = store().patchLabels("a", colour("#16a766"));
  const second = store().patchLabels("a", colour("#4986e7"));
  const travel = () => store().labels.a.find((l) => l.id === "Label_2");

  const taken = { ...label("Label_2", "travel"), colorBackground: "#4986e7" };
  store().settleLabels(second, [taken]);
  store().settleLabels(first, null);
  expect(travel()?.colorBackground).toBe("#4986e7");
});
