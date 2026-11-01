// Dev-only: lets `npm run dev` render the app in a plain browser (no Tauri) with a
// fake backend, for checking UI on machines without a native build (design doc §11).
// main.tsx imports this only in dev builds when Tauri isn't present.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { AccountInfo } from "../lib/tauri";

export function installMockBackend() {
  const params = new URLSearchParams(location.search);
  const accounts: AccountInfo[] =
    params.get("accounts") === "1"
      ? [{ id: "a1", email: "alex@example.com", displayName: "Alex", clientId: "1.apps.googleusercontent.com" }]
      : [];
  // ?fail=<code> makes sign-in fail with that error code.
  const fail = params.get("fail");

  mockIPC(async (cmd, args) => {
    const a = args as Record<string, never>;
    switch (cmd) {
      case "list_accounts":
        return accounts;
      case "begin_oauth":
        return { flowId: crypto.randomUUID(), authUrl: "https://accounts.google.com/o/oauth2/v2/auth?mock=1" };
      case "complete_oauth": {
        await new Promise((resolve) => setTimeout(resolve, Number(params.get("delay") ?? 2500)));
        if (fail) throw { code: fail, message: `Mock failure: ${fail}.` };
        const account = { id: crypto.randomUUID(), email: "you@example.com", displayName: "You", clientId: "1.apps.googleusercontent.com" };
        accounts.push(account);
        return account;
      }
      case "remove_account":
        accounts.splice(accounts.findIndex((x) => x.id === a.accountId), 1);
        return;
      case "open_external":
        console.info("[mock] open", a.url);
        return;
      default:
        return;
    }
  });
}
