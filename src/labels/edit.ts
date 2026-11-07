// Label renames, colour and visibility changes, straight to Gmail but shown at once.
import { toast } from "../components/ui/Toast";
import { type LabelEdit, type LabelInfo, toCommandError, updateLabel } from "../lib/tauri";
import { useLabelStore } from "../store/labelStore";

/** `labels` as they'll be once Gmail takes `edit` on `labelId`; a rename carries its sublabels' paths along. */
function applyLabelEdit(labels: LabelInfo[], labelId: string, edit: LabelEdit): LabelInfo[] {
  const target = labels.find((l) => l.id === labelId);
  if (!target) return labels;
  const oldPath = `${target.name}/`;
  return labels.map((l) => {
    if (l.id === labelId) {
      const next = { ...l };
      if (edit.name != null) next.name = edit.name;
      if (edit.color) {
        next.colorBackground = edit.color.background;
        next.colorText = edit.color.text;
      }
      if (edit.clearColor) {
        next.colorBackground = null;
        next.colorText = null;
      }
      if (edit.labelListVisibility) next.labelListVisibility = edit.labelListVisibility;
      if (edit.messageListVisibility) next.messageListVisibility = edit.messageListVisibility;
      return next;
    }
    if (edit.name != null && l.name.startsWith(oldPath))
      return { ...l, name: `${edit.name}/${l.name.slice(oldPath.length)}` };
    return l;
  });
}

/**
 * Shows `edit` on the label at once and sends it to Gmail in the background; a refusal puts the labels back and
 * shows Gmail's message. Resolves to whether Gmail took it.
 */
export async function editLabel(
  accountId: string,
  labelId: string,
  edit: LabelEdit,
): Promise<boolean> {
  const store = useLabelStore.getState();
  const change = store.patchLabels(accountId, (labels) => applyLabelEdit(labels, labelId, edit));
  try {
    const changed = await updateLabel(accountId, labelId, edit);
    useLabelStore.getState().settleLabels(change, changed ?? []);
    return true;
  } catch (err) {
    useLabelStore.getState().settleLabels(change, null);
    toast({ title: toCommandError(err).message, tone: "danger" });
    return false;
  }
}
