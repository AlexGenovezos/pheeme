import { invoke } from "@tauri-apps/api/core";
import { describe, expect, test, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import {
  type ThreadDetail,
  type ThreadPage,
  SYNC_EVENTS,
  type SyncMessagesUpdated,
} from "../lib/tauri";
import { createFixtureThreads, fixtureAccounts } from "./fixtures";
import { createPreviewHandlers, handlePreviewCommand, installPreview } from "./install";
import { detectTauri, isPreview, isTauri } from "./runtime";

describe("runtime detection", () => {
  test("Tauri is detected by its injected internals", () => {
    expect(detectTauri({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(detectTauri({})).toBe(false);
  });

  test("a plain browser (jsdom here) is preview mode", () => {
    expect(isPreview()).toBe(true);
    expect(isTauri()).toBe(false);
  });

  test("installing the IPC mock doesn't flip the startup decision", () => {
    installPreview();
    expect(detectTauri(window)).toBe(true);
    expect(isPreview()).toBe(true);
  });
});

const CATEGORIES = [
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];
type Page = { threads: { id: string; unread: boolean; starred: boolean }[] };
type Counts = { labelId: string; unread: number }[];

describe("preview IPC", () => {
  test("invoke answers from fixtures once installed", async () => {
    installPreview();
    await expect(invoke("list_accounts")).resolves.toMatchObject(fixtureAccounts);
    const sent = (await invoke("list_threads", {
      accountIds: ["acc-personal"],
      labelId: "SENT",
    })) as Page;
    expect(sent.threads.map((t) => t.id)).toEqual(["p-13"]);
    await expect(
      invoke("get_thread", { accountId: "acc-personal", threadId: "p-01" }),
    ).resolves.toMatchObject({
      thread: { id: "p-01", messageCount: 4 },
    });
    await expect(invoke("greet", { name: "Avery" })).resolves.toContain("Avery");
  });

  test("list_threads honours All Mail and the category inboxes", () => {
    const handlers = createPreviewHandlers();
    const ids = (args: Record<string, unknown>) =>
      (handlers.list_threads(args) as Page).threads.map((t) => t.id);
    const all = ids({ accountIds: [], labelId: "ALL" });
    expect(all).toContain("p-15");
    expect(all).not.toContain("p-16");
    expect(all).not.toContain("p-17");
    const inbox = ids({ accountIds: ["acc-personal"], labelId: "INBOX" });
    const primary = ids({
      accountIds: ["acc-personal"],
      labelId: "INBOX",
      alsoLabelId: "CATEGORY_PERSONAL",
    });
    expect(primary.length).toBeGreaterThan(0);
    for (const category of ["SOCIAL", "PROMOTIONS", "UPDATES", "FORUMS"]) {
      const inCategory = ids({
        accountIds: ["acc-personal"],
        labelId: "INBOX",
        alsoLabelId: `CATEGORY_${category}`,
      });
      expect(inCategory.length).toBeGreaterThan(0);
      expect(inCategory.some((id) => primary.includes(id))).toBe(false);
    }
    expect(inbox.length).toBeGreaterThan(primary.length);
  });

  test("both accounts have unread mail in every category, starred threads and drafts", () => {
    const handlers = createPreviewHandlers();
    for (const accountId of ["acc-personal", "acc-work"]) {
      const counts = Object.fromEntries(
        (handlers.mailbox_counts({ accountIds: [accountId] }) as Counts).map((c) => [
          c.labelId,
          c.unread,
        ]),
      );
      for (const category of CATEGORIES)
        expect(counts[category], `${accountId} ${category}`).toBeGreaterThan(0);
      const labels = handlers.label_counts({ accountId }) as { labelId: string; total: number }[];
      expect(labels.find((c) => c.labelId === "STARRED")?.total, accountId).toBeGreaterThan(0);
      expect(labels.find((c) => c.labelId === "DRAFT")?.total, accountId).toBeGreaterThan(0);
    }
  });

  test("the All Mail count matches the All Mail list", () => {
    const handlers = createPreviewHandlers();
    const listed = (
      handlers.list_threads({ accountIds: ["acc-personal"], labelId: "ALL", limit: 500 }) as {
        threads: { unread: boolean }[];
      }
    ).threads;
    const all = (
      handlers.label_counts({ accountId: "acc-personal" }) as {
        labelId: string;
        unread: number;
        total: number;
      }[]
    ).find((c) => c.labelId === "ALL");
    expect(all).toEqual({
      labelId: "ALL",
      unread: listed.filter((t) => t.unread).length,
      total: listed.length,
    });
  });

  test("labels come per account, with and without colors", () => {
    const handlers = createPreviewHandlers();
    const userLabels = (accountId: string) =>
      (
        handlers.list_labels({ accountId }) as {
          name: string;
          type: string;
          colorBackground: string | null;
        }[]
      ).filter((l) => l.type === "user");
    expect(userLabels("acc-personal").map((l) => l.name)).toEqual(["Receipts", "Travel", "Pheeme"]);
    expect(userLabels("acc-work").map((l) => l.name)).toEqual(["Customers", "Invoices"]);
    expect(userLabels("acc-personal").some((l) => l.colorBackground)).toBe(true);
    expect(userLabels("acc-personal").some((l) => !l.colorBackground)).toBe(true);
  });

  test("labels carry visibilities and rows carry only their user label ids", () => {
    const handlers = createPreviewHandlers();
    const labels = handlers.list_labels({ accountId: "acc-personal" }) as {
      messageListVisibility: string | null;
      labelListVisibility: string | null;
    }[];
    expect(labels.every((l) => l.messageListVisibility && l.labelListVisibility)).toBe(true);
    const pages = ["INBOX", "SENT", "TRASH", "STARRED"].map(
      (labelId) =>
        handlers.list_threads({ accountIds: ["acc-personal"], labelId }) as {
          threads: { labelIds: string[] }[];
        },
    );
    const rows = pages.flatMap((p) => p.threads);
    const userIds = new Set(["Label_1", "Label_2", "Label_3"]);
    expect(rows.every((r) => r.labelIds.every((id) => userIds.has(id)))).toBe(true);
    expect(rows.some((r) => r.labelIds.length > 0)).toBe(true);
  });

  test("threads cover the long, HTML, remote-image, dark-mode, plain-URL and PDF cases", () => {
    const handlers = createPreviewHandlers();
    const detail = (threadId: string, accountId = "acc-personal") =>
      handlers.get_thread({ accountId, threadId }) as ThreadDetail;
    expect(detail("p-01").messages).toHaveLength(4);
    expect(detail("p-03").messages.length).toBeGreaterThanOrEqual(10);
    const ci = detail("p-02").messages[0];
    expect(ci.bodyHtml).toContain("https://");
    expect(ci.bodyHtml).toContain("data:image");
    expect(ci.hasRemoteContent).toBe(true);
    expect(detail("p-08").messages[0].declaresDarkMode).toBe(true);
    expect(detail("p-05").messages[1]).toMatchObject({
      bodyHtml: null,
      bodyText: expect.stringContaining("https://"),
    });
    expect(detail("p-01").messages[2].attachments[0]).toMatchObject({
      mimeType: "application/pdf",
      isInline: false,
    });
  });

  test("a missing or foreign thread is not_found", () => {
    const handlers = createPreviewHandlers();
    expect(() => handlers.get_thread({ accountId: "acc-work", threadId: "p-01" })).toThrow();
  });

  test("archive in preview removes the thread from INBOX and fires messages_updated", async () => {
    installPreview();
    const events: SyncMessagesUpdated[] = [];
    const stop = await listen<SyncMessagesUpdated>(SYNC_EVENTS.messagesUpdated, (e) =>
      events.push(e.payload),
    );
    const inbox = async () =>
      (
        (await invoke("list_threads", { accountIds: ["acc-personal"], labelId: "INBOX" })) as Page
      ).threads.map((t) => t.id);
    const before = await inbox();
    expect(before).toContain("p-05");

    await invoke("modify_threads", {
      accountId: "acc-personal",
      threadIds: ["p-05"],
      add: [],
      remove: ["INBOX"],
    });

    expect(await inbox()).toEqual(before.filter((id) => id !== "p-05"));
    const all = (await invoke("list_threads", {
      accountIds: ["acc-personal"],
      labelId: "ALL",
    })) as Page;
    expect(all.threads.map((t) => t.id)).toContain("p-05");
    await vi.waitFor(() =>
      expect(events).toEqual([
        { accountId: "acc-personal", added: [], removed: [], modified: ["p-05"] },
      ]),
    );
    stop();
  });

  test("category counts move when threads are archived, read, starred and trashed", async () => {
    installPreview();
    const counts = async (accountId: string) =>
      Object.fromEntries(
        ((await invoke("mailbox_counts", { accountIds: [accountId] })) as Counts).map((c) => [
          c.labelId,
          c.unread,
        ]),
      );
    const totals = async (labelId: string) =>
      (
        (await invoke("label_counts", { accountId: "acc-personal" })) as {
          labelId: string;
          total: number;
        }[]
      ).find((c) => c.labelId === labelId)?.total;
    const before = await counts("acc-personal");
    const workBefore = await counts("acc-work");

    // p-05 is an unread Primary thread: reading it lowers Primary and the inbox by one.
    await invoke("modify_threads", {
      accountId: "acc-personal",
      threadIds: ["p-05"],
      add: [],
      remove: ["UNREAD"],
    });
    expect(await counts("acc-personal")).toMatchObject({
      INBOX: before.INBOX - 1,
      CATEGORY_PERSONAL: before.CATEGORY_PERSONAL - 1,
    });

    // p-10 is an unread Social thread: trashing it lowers Social and the inbox, and adds to Trash.
    const trashed = await totals("TRASH");
    await invoke("trash_threads", { accountId: "acc-personal", threadIds: ["p-10"] });
    expect(await counts("acc-personal")).toMatchObject({
      INBOX: before.INBOX - 2,
      CATEGORY_SOCIAL: before.CATEGORY_SOCIAL - 1,
    });
    expect(await totals("TRASH")).toBe((trashed ?? 0) + 1);

    // Starring adds to the Starred total; it doesn't touch the inbox counts.
    const starred = await totals("STARRED");
    await invoke("modify_threads", {
      accountId: "acc-personal",
      threadIds: ["p-09"],
      add: ["STARRED"],
      remove: [],
    });
    expect(await totals("STARRED")).toBe((starred ?? 0) + 1);
    expect((await counts("acc-personal")).INBOX).toBe(before.INBOX - 2);

    // Marking unread brings a thread back to the unread counts, and nothing leaks into the other account.
    await invoke("modify_threads", {
      accountId: "acc-personal",
      threadIds: ["p-05"],
      add: ["UNREAD"],
      remove: [],
    });
    expect((await counts("acc-personal")).CATEGORY_PERSONAL).toBe(before.CATEGORY_PERSONAL);
    expect(await counts("acc-work")).toEqual(workBefore);
  });

  test("marking a conversation read or unread applies to every message, like the backend", async () => {
    installPreview();
    const flags = async () =>
      (
        (await invoke("get_thread", {
          accountId: "acc-personal",
          threadId: "p-01",
        })) as ThreadDetail
      ).messages.map((m) => m.unread);
    const unreadRow = async () =>
      (
        (await invoke("label_counts", { accountId: "acc-personal" })) as {
          labelId: string;
          unread: number;
          total: number;
        }[]
      ).find((c) => c.labelId === "UNREAD");
    // p-01 starts with only its newest message unread.
    expect(await flags()).toEqual([false, false, false, true]);
    const startUnread = (await unreadRow())?.total ?? 0;

    await invoke("modify_threads", {
      accountId: "acc-personal",
      threadIds: ["p-01"],
      add: [],
      remove: ["UNREAD"],
    });
    expect(await flags()).toEqual([false, false, false, false]);
    expect(await unreadRow()).toEqual({
      labelId: "UNREAD",
      unread: startUnread - 1,
      total: startUnread - 1,
    });

    await invoke("modify_threads", {
      accountId: "acc-personal",
      threadIds: ["p-01"],
      add: ["UNREAD"],
      remove: [],
    });
    expect(await flags()).toEqual([true, true, true, true]);
    expect(await unreadRow()).toEqual({
      labelId: "UNREAD",
      unread: startUnread,
      total: startUnread,
    });
  });

  test("modify_threads refuses Trash and Spam like the backend", () => {
    const handlers = createPreviewHandlers();
    expect(() =>
      handlers.modify_threads({
        accountId: "acc-personal",
        threadIds: ["p-05"],
        add: ["TRASH"],
        remove: [],
      }),
    ).toThrow();
  });

  test("search and recent searches answer in preview", async () => {
    installPreview();
    const t = createFixtureThreads()[0];
    const page = await invoke<{ threads: { id: string }[]; local: boolean }>("search_messages", {
      accountIds: [t.accountId],
      query: String(t.subject).split(" ")[0],
    });
    expect(page.local).toBe(true);
    expect(page.threads.map((x) => x.id)).toContain(t.id);
    await invoke("add_recent_search", { query: " a " });
    await invoke("add_recent_search", { query: "b" });
    await invoke("add_recent_search", { query: "a" });
    await expect(invoke("recent_searches")).resolves.toEqual(["a", "b"]);
    await invoke("remove_recent_search", { query: null });
    await expect(invoke("recent_searches")).resolves.toEqual([]);
  });

  test("the updater check reports no update", () => {
    expect(handlePreviewCommand("plugin:updater|check")).toBeNull();
  });

  test("unknown commands warn and resolve to null instead of hanging", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(handlePreviewCommand("does_not_exist")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("does_not_exist"));
  });
});

test("preview onboarding can connect and remove an account", async () => {
  const handlers = createPreviewHandlers("?accounts=0&delay=0");
  expect(handlers.list_accounts(undefined)).toEqual([]);
  const flow = handlers.begin_oauth(undefined) as { flowId: string };
  const account = (await handlers.complete_oauth(flow)) as { id: string };
  expect(handlers.list_accounts(undefined)).toEqual([account]);
  handlers.remove_account({ accountId: "missing" });
  expect(handlers.list_accounts(undefined)).toEqual([account]);
  handlers.remove_account({ accountId: account.id });
  expect(handlers.list_accounts(undefined)).toEqual([]);
});

test("cancelled preview sign-in cannot save an account", async () => {
  const handlers = createPreviewHandlers("?accounts=0&delay=0");
  const flow = handlers.begin_oauth(undefined) as { flowId: string };
  const completion = handlers.complete_oauth(flow);
  handlers.cancel_oauth(flow);
  await expect(completion).rejects.toMatchObject({ code: "cancelled" });
  expect(handlers.list_accounts(undefined)).toEqual([]);
});

test("preview sign-in preserves failure simulation", async () => {
  const handlers = createPreviewHandlers("?accounts=0&delay=0&fail=invalid_grant");
  const flow = handlers.begin_oauth(undefined) as { flowId: string };
  await expect(handlers.complete_oauth(flow)).rejects.toMatchObject({ code: "invalid_grant" });
  expect(handlers.list_accounts(undefined)).toEqual([]);
});

test("?threads=N adds that many Inbox conversations that open", () => {
  const plain = createPreviewHandlers();
  const handlers = createPreviewHandlers("?threads=3");
  const ids = (h: typeof handlers, labelId: string) =>
    (h.list_threads({ accountIds: ["acc-personal"], labelId }) as ThreadPage).threads.map(
      (t) => t.id,
    );
  expect(ids(handlers, "INBOX")).toEqual([...ids(plain, "INBOX"), "gen-0", "gen-1", "gen-2"]);
  expect(ids(handlers, "SENT")).toEqual(ids(plain, "SENT"));
  expect(handlers.get_thread({ accountId: "acc-personal", threadId: "gen-2" })).toMatchObject({
    thread: { id: "gen-2" },
  });
});
