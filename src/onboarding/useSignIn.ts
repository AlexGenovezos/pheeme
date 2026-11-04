import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AccountInfo,
  type ClientChoice,
  type CommandError,
  beginOauth,
  cancelOauth,
  completeOauth,
  openExternal,
  toCommandError,
} from "../lib/tauri";
import { cancelClientTransfer, receiveClientTransfer } from "../transfer/api";

type SignInChoice = ClientChoice | { kind: "transfer"; invitation: string };

export type SignInState =
  | { phase: "idle" }
  | { phase: "receiving" }
  | { phase: "authorizing"; authUrl: string; client: ClientChoice | null }
  | { phase: "failed"; error: CommandError; client: ClientChoice | null }
  | { phase: "connected"; account: AccountInfo };

/** Own one sign-in attempt, including transfer approval, OAuth, and cancellation. */
export function useSignIn() {
  const [state, setState] = useState<SignInState>({ phase: "idle" });
  const flowRef = useRef<string | null>(null);
  const transferRef = useRef<string | null>(null);
  // A cancelled, replaced, or unmounted attempt must never publish a late result.
  const attemptRef = useRef(0);

  const abandonAttempt = useCallback(() => {
    attemptRef.current += 1;
    const flowId = flowRef.current;
    flowRef.current = null;
    if (flowId) void cancelOauth(flowId).catch(() => {});
    const transferId = transferRef.current;
    transferRef.current = null;
    if (transferId) void cancelClientTransfer(transferId).catch(() => {});
  }, []);

  useEffect(() => abandonAttempt, [abandonAttempt]);

  async function start(next: SignInChoice) {
    abandonAttempt();
    const attempt = attemptRef.current;
    const current = () => attemptRef.current === attempt;
    // Only ordinary OAuth choices can be retried. Never retain a transfer invitation in state.
    const client = next.kind === "transfer" ? null : next;
    setState(
      next.kind === "transfer"
        ? { phase: "receiving" }
        : { phase: "authorizing", authUrl: "", client },
    );
    try {
      let started;
      if (next.kind === "transfer") {
        const transferId = crypto.randomUUID();
        transferRef.current = transferId;
        const pending = receiveClientTransfer(transferId, next.invitation);
        next.invitation = "";
        started = await pending;
        if (current()) transferRef.current = null;
      } else {
        started = await beginOauth(next);
      }
      if (!current()) {
        void cancelOauth(started.flowId).catch(() => {});
        return;
      }
      flowRef.current = started.flowId;
      setState({ phase: "authorizing", authUrl: started.authUrl, client });
      void openExternal(started.authUrl).catch(() => {});
      const account = await completeOauth(started.flowId);
      if (!current()) return;
      flowRef.current = null;
      setState({ phase: "connected", account });
    } catch (raw) {
      if (!current()) return;
      flowRef.current = null;
      setState({ phase: "failed", error: toCommandError(raw), client });
    }
  }

  function cancel() {
    abandonAttempt();
    setState({ phase: "idle" });
  }

  return { state, start, cancel };
}
