// Label colour and visibility changes from the sidebar, straight to Gmail.
import { toast } from "../components/ui/Toast";
import { type LabelEdit, toCommandError, updateLabel } from "../lib/tauri";
import { useLabelStore } from "../store/labelStore";

/**
 * Applies `edit` to a label in Gmail and writes the labels it changed into the store; a refusal leaves the store as
 * it was and shows Gmail's message. Resolves to whether Gmail took it.
 */
export async function editLabel(
  accountId: string,
  labelId: string,
  edit: LabelEdit,
): Promise<boolean> {
  try {
    const changed = await updateLabel(accountId, labelId, edit);
    if (changed?.length) {
      const byId = new Map(changed.map((l) => [l.id, l]));
      useLabelStore.setState((s) => ({
        labels: {
          ...s.labels,
          [accountId]: (s.labels[accountId] ?? []).map((l) => byId.get(l.id) ?? l),
        },
      }));
    }
    return true;
  } catch (err) {
    toast({ title: toCommandError(err).message, tone: "danger" });
    return false;
  }
}
