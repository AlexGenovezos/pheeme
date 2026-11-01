import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { AccountInfo } from "../lib/tauri";
import { fixtureAccounts, fixtureLabels, fixtureMailboxes, fixtureThreadsIn } from "./fixtures";

type Args = Record<string, unknown> | undefined;

/** One stateful backend for both onboarding and the shell in browser preview. */
export function createPreviewHandlers(search = ""): Record<string, (args: Args) => unknown> {
  const params = new URLSearchParams(search);
  const accounts: AccountInfo[] = params.get("accounts") === "0" ? [] : fixtureAccounts
    .slice(0, params.get("accounts") === "1" ? 1 : undefined)
    .map((account) => ({ ...account, clientId: "1.apps.googleusercontent.com" }));
  const flows = new Set<string>();
  return {
    greet: (args) => `Hello, ${String(args?.name ?? "world")}! (preview)`,
    list_accounts: () => [...accounts],
    list_labels: () => [...fixtureMailboxes, ...fixtureLabels],
    list_threads: (args) => fixtureThreadsIn(String(args?.labelId ?? "INBOX")),
    begin_oauth: () => {
      const flowId = crypto.randomUUID();
      flows.add(flowId);
      return { flowId, authUrl: "https://accounts.google.com/o/oauth2/v2/auth?mock=1" };
    },
    complete_oauth: async (args) => {
      const flowId = String(args?.flowId);
      await new Promise((resolve) => setTimeout(resolve, Number(params.get("delay") ?? 2500)));
      if (!flows.delete(flowId)) throw { code: "cancelled", message: "Sign-in cancelled." };
      const fail = params.get("fail");
      if (fail) throw { code: fail, message: `Mock failure: ${fail}.` };
      const account = accounts.find((a) => a.email === "you@example.com") ?? {
        id: crypto.randomUUID(), email: "you@example.com", displayName: "You", clientId: "1.apps.googleusercontent.com",
      };
      if (!accounts.includes(account)) accounts.push(account);
      return account;
    },
    cancel_oauth: (args) => { flows.delete(String(args?.flowId)); },
    remove_account: (args) => {
      const index = accounts.findIndex((a) => a.id === args?.accountId);
      if (index !== -1) accounts.splice(index, 1);
    },
    open_external: () => undefined,
    "plugin:updater|check": () => null,
  };
}

export let previewHandlers = createPreviewHandlers();

export function handlePreviewCommand(cmd: string, args?: unknown): unknown {
  const handler = previewHandlers[cmd];
  if (handler) return handler(args as Args);
  console.warn(`[preview] no fixture for "${cmd}"; returning null`);
  return null;
}

/** Make invoke() and window APIs answer from fixtures in a plain browser. */
export function installPreview() {
  previewHandlers = createPreviewHandlers(location.search);
  mockWindows("main");
  mockIPC(handlePreviewCommand, { shouldMockEvents: true });
}
