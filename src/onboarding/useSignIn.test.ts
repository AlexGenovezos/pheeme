import { mockIPC } from "@tauri-apps/api/mocks";
import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import type { AccountInfo, SignInStart } from "../lib/tauri";
import { useSignIn } from "./useSignIn";

const account: AccountInfo = {
  id: "a1",
  email: "me@example.com",
  displayName: null,
  clientId: "test.apps.googleusercontent.com",
  synced: true,
};
const client = { kind: "sameAs", accountId: "a1" } as const;
const started = (flowId: string): SignInStart => ({
  flowId,
  authUrl: `https://accounts.google.com/${flowId}`,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function backend(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    return handlers[cmd]?.(args as Record<string, unknown>);
  });
  return calls;
}

test("replacing a pending start cancels its late flow without opening its browser", async () => {
  const begin = deferred<SignInStart>();
  const calls = backend({
    begin_oauth: ({ client }) =>
      (client as { accountId: string }).accountId === "a1" ? begin.promise : started("new"),
    complete_oauth: () => account,
  });
  const { result } = renderHook(useSignIn);
  let old!: Promise<void>;
  act(() => {
    old = result.current.start(client);
  });
  await act(async () => {
    await result.current.start({ kind: "sameAs", accountId: "a2" });
  });
  await act(async () => {
    begin.resolve(started("old"));
    await old;
  });
  expect(result.current.state).toEqual({ phase: "connected", account });
  expect(calls).toContainEqual({ cmd: "cancel_oauth", args: { flowId: "old" } });
  expect(calls.filter((call) => call.cmd === "open_external")).toEqual([
    { cmd: "open_external", args: { url: started("new").authUrl } },
  ]);
});

test.each(["success", "failure"])(
  "a replaced OAuth completion cannot publish its late %s",
  async (outcome) => {
    const oldComplete = deferred<AccountInfo>();
    const freshComplete = deferred<AccountInfo>();
    let n = 0;
    const calls = backend({
      begin_oauth: () => started(`f${++n}`),
      complete_oauth: ({ flowId }) =>
        flowId === "f1" ? oldComplete.promise : freshComplete.promise,
    });
    const { result } = renderHook(useSignIn);
    let old!: Promise<void>;
    let fresh!: Promise<void>;
    await act(async () => {
      old = result.current.start(client);
    });
    await act(async () => {
      fresh = result.current.start({ kind: "sameAs", accountId: "a2" });
    });
    expect(calls).toContainEqual({ cmd: "cancel_oauth", args: { flowId: "f1" } });
    await act(async () => {
      if (outcome === "success") oldComplete.resolve(account);
      else oldComplete.reject({ code: "cancelled", message: "Old attempt cancelled." });
      await old;
    });
    expect(result.current.state).toMatchObject({
      phase: "authorizing",
      authUrl: started("f2").authUrl,
    });
    await act(async () => {
      freshComplete.resolve(account);
      await fresh;
    });
    expect(result.current.state).toEqual({ phase: "connected", account });
  },
);
