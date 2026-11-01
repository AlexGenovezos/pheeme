// Typed wrappers around invoke(). Rust commands live in src-tauri/src/commands/.
import { invoke } from "@tauri-apps/api/core";

export { invoke };

export interface AccountInfo {
  id: string;
  email: string;
  displayName: string | null;
  clientId: string;
}

export type ClientChoice =
  | { kind: "new"; clientId: string; clientSecret: string }
  | { kind: "sameAs"; accountId: string };

export interface SignInStart {
  flowId: string;
  authUrl: string;
}

/** Every command rejects with this shape: a stable code and a plain-language message. */
export interface CommandError {
  code: string;
  message: string;
}

export function toCommandError(error: unknown): CommandError {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as CommandError).code === "string" &&
    typeof (error as CommandError).message === "string"
  ) {
    return error as CommandError;
  }
  return { code: "internal", message: `Something went wrong: ${String(error)}` };
}

export const beginOauth = (client: ClientChoice) => invoke<SignInStart>("begin_oauth", { client });
/** Resolves when the browser sign-in finishes; rejects on failure, timeout or cancel. */
export const completeOauth = (flowId: string) => invoke<AccountInfo>("complete_oauth", { flowId });
export const cancelOauth = (flowId: string) => invoke<void>("cancel_oauth", { flowId });
export const refreshToken = (accountId: string) => invoke<void>("refresh_token", { accountId });
export const listAccounts = () => invoke<AccountInfo[]>("list_accounts");
export const removeAccount = (accountId: string) => invoke<void>("remove_account", { accountId });
/** Opens an allow-listed https URL (Google, Pheeme) in the default browser. */
export const openExternal = (url: string) => invoke<void>("open_external", { url });
