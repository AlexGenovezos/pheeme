import { invoke } from "@tauri-apps/api/core";
import { describe, expect, test, vi } from "vitest";
import { fixtureAccounts, fixtureThreadsIn } from "./fixtures";
import { createPreviewHandlers, handlePreviewCommand, installPreview, toSummary } from "./install";
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

describe("preview IPC", () => {
  test("invoke answers from fixtures once installed", async () => {
    installPreview();
    await expect(invoke("list_accounts")).resolves.toMatchObject(fixtureAccounts);
    await expect(invoke("list_threads", { accountIds: ["acc-personal"], labelId: "SENT" })).resolves.toEqual({
      threads: fixtureThreadsIn("SENT").map(toSummary),
      next: null,
    });
    await expect(invoke("get_thread", { accountId: "acc-personal", threadId: "t-01" })).resolves.toMatchObject({
      thread: { id: "t-01" },
    });
    await expect(invoke("greet", { name: "Alex" })).resolves.toContain("Alex");
  });

  test("list_threads honours All Mail and the category tabs", () => {
    const handlers = createPreviewHandlers();
    const ids = (args: Record<string, unknown>) => (handlers.list_threads(args) as { threads: { id: string }[] }).threads.map((t) => t.id);
    expect(ids({ accountIds: [], labelId: "ALL" })).toEqual(fixtureThreadsIn("ALL").map((t) => t.id));
    const inbox = ids({ accountIds: [], labelId: "INBOX" });
    const primary = ids({ accountIds: [], labelId: "INBOX", alsoLabelId: "CATEGORY_PERSONAL" });
    const updates = ids({ accountIds: [], labelId: "INBOX", alsoLabelId: "CATEGORY_UPDATES" });
    expect(updates.length).toBeGreaterThan(0);
    expect(primary.length).toBeGreaterThan(0);
    expect(primary.some((id) => updates.includes(id))).toBe(false);
    expect(inbox.length).toBeGreaterThan(primary.length);
  });

  test("label_counts reports unread labels", () => {
    expect(createPreviewHandlers().label_counts({ accountId: "acc-personal" })).toContainEqual({ labelId: "Label_3", unread: 2 });
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
  const account = await handlers.complete_oauth(flow) as { id: string };
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
