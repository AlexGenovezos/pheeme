// "Create label…": the one entry point for making a label outside a selection.
import { resolveActiveAccount } from "../mail/mailboxes";
import { useAccountStore } from "../store/accountStore";
import { useUiStore } from "../store/uiStore";
import { usePickerStore } from "./pickerStore";

/**
 * Starts creating a label in `accountId` (default: the account in view). For now that is the label picker with
 * nothing selected, where typing a name offers only "Create"; the label dialog replaces it.
 */
export function openCreateLabel(accountId?: string): void {
  const { mailbox, activeAccountId } = useUiStore.getState();
  const id =
    accountId ??
    resolveActiveAccount(mailbox.accountId ?? activeAccountId, useAccountStore.getState().accounts);
  if (!id) return;
  usePickerStore.getState().open({
    mode: "label",
    accountId: id,
    keys: [],
    at: { x: window.innerWidth / 2, y: window.innerHeight / 3 },
  });
}
