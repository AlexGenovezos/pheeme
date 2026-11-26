// "Create label…": the one entry point for making a label outside a selection.
import type { LabelInfo } from "../lib/tauri";
import { resolveActiveAccount } from "../mail/mailboxes";
import { useLabelStore } from "../store/labelStore";
import { useAccountStore } from "../store/accountStore";
import { useUiStore } from "../store/uiStore";
import { openLabelDialog } from "./dialogStore";

/** Opens the new-label dialog for `accountId` (default: the account in view). */
export function openCreateLabel(accountId?: string): void {
  const { mailbox, activeAccountId } = useUiStore.getState();
  const id =
    accountId ??
    resolveActiveAccount(mailbox.accountId ?? activeAccountId, useAccountStore.getState().accounts);
  if (!id) return;
  openLabelDialog({ mode: "create", accountId: id });
}

/** Puts a label Gmail just made into the account's labels, so pickers show it before the next sync. */
export function addCreatedLabel(accountId: string, created: LabelInfo): void {
  useLabelStore.setState((s) => ({
    labels: {
      ...s.labels,
      [accountId]: [...(s.labels[accountId] ?? []).filter((l) => l.id !== created.id), created],
    },
  }));
}
