import { invoke } from "@tauri-apps/api/core";
import { describe, expect, test, vi } from "vitest";
import { fixtureAccounts, fixtureThreadsIn } from "./fixtures";
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

describe("preview IPC", () => {
  test("invoke answers from fixtures once installed", async () => {
    installPreview();
    await expect(invoke("list_accounts")).resolves.toMatchObject(fixtureAccounts);
    await expect(invoke("list_threads", { labelId: "SENT" })).resolves.toEqual(fixtureThreadsIn("SENT"));
    await expect(invoke("greet", { name: "Alex" })).resolves.toContain("Alex");
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
