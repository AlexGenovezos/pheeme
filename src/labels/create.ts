// "Create label…": the one entry point for making a label outside a selection.
import { resolveActiveAccount } from "../mail/mailboxes";
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
