// Settings › Sender rules: each account's Gmail filters that file a sender's mail in an inbox category, made with
// "This and future mail from…" when moving mail. Fetched when the page opens; they aren't synced.
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { deleteSenderRule, listSenderRules, type SenderRule, toCommandError } from "../lib/tauri";
import { categoryName } from "../mail/CategoryMoveDialog";
import { ReconnectButton } from "../onboarding/Reconnect";
import { useAccountStore } from "../store/accountStore";
import { SettingsRow, SettingsSection } from "./rows";

type Rules =
  | { kind: "loading" }
  | { kind: "ready"; rules: SenderRule[] }
  | { kind: "missing-scope" }
  | { kind: "error"; message: string };

function AccountRules({ accountId, email }: { accountId: string; email: string }) {
  const [state, setState] = useState<Rules>({ kind: "loading" });
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());

  const answer = useCallback(
    (rules: Promise<SenderRule[]>, live: () => boolean = () => true) =>
      rules.then(
        (list) => {
          if (live()) setState({ kind: "ready", rules: list });
        },
        (raw: unknown) => {
          if (!live()) return;
          const error = toCommandError(raw);
          setState(
            error.code === "missing_scope"
              ? { kind: "missing-scope" }
              : { kind: "error", message: error.message },
          );
        },
      ),
    [],
  );
  const load = () => void answer(listSenderRules(accountId));

  useEffect(() => {
    let live = true;
    void answer(listSenderRules(accountId), () => live);
    return () => {
      live = false;
    };
  }, [accountId, answer]);

  const remove = async (rule: SenderRule) => {
    setBusy((b) => new Set(b).add(rule.id));
    try {
      await deleteSenderRule(accountId, rule.id);
      setState((s) =>
        s.kind === "ready" ? { kind: "ready", rules: s.rules.filter((r) => r.id !== rule.id) } : s,
      );
    } catch (raw) {
      setState({ kind: "error", message: toCommandError(raw).message });
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(rule.id);
        return next;
      });
    }
  };

  return (
    <SettingsSection title={email}>
      {state.kind === "loading" && <SettingsRow title="Loading sender rules…" />}
      {state.kind === "missing-scope" && (
        <SettingsRow
          title="Pheeme can't see this account's Gmail filters"
          description="Sign in again and allow Pheeme to manage your Gmail filters to save and list sender rules."
          control={<ReconnectButton accountId={accountId} />}
        />
      )}
      {state.kind === "error" && (
        <SettingsRow
          title="Couldn't load sender rules"
          description={state.message}
          control={
            <Button size="sm" onClick={load}>
              Try again
            </Button>
          }
        />
      )}
      {state.kind === "ready" && state.rules.length === 0 && (
        <SettingsRow
          title="No sender rules"
          description='Move a conversation to an inbox category and choose "This and future mail" to add one.'
        />
      )}
      {state.kind === "ready" &&
        state.rules.map((rule) => (
          <SettingsRow
            key={rule.id}
            title={rule.sender}
            description={`Goes to ${categoryName(rule.category)}`}
            control={
              <Button
                size="sm"
                variant="danger"
                disabled={busy.has(rule.id)}
                aria-label={`Delete the rule for ${rule.sender}`}
                onClick={() => void remove(rule)}
              >
                Delete
              </Button>
            }
          />
        ))}
    </SettingsSection>
  );
}

export function SenderRulesSettings() {
  const accounts = useAccountStore((s) => s.accounts);
  if (accounts.length === 0) return <p className="settings-empty">No accounts connected.</p>;
  return (
    <>
      {accounts.map((a) => (
        <AccountRules key={a.id} accountId={a.id} email={a.email} />
      ))}
    </>
  );
}
