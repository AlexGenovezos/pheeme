// The Archive slot (its toolbar and row buttons, its row-menu item and `e`): archiving does nothing in Spam or
// Trash, so there it offers Gmail's way out instead, Not spam and Move to Inbox.
import { Archive, Inbox, ShieldCheck } from "lucide-react";
import { useMailStore } from "../store/mailStore";
import { useUiStore } from "../store/uiStore";

export type ArchiveSlot = "archive" | "not-spam" | "move-to-inbox";

/** The slot for a mailbox (`labelId`); search results always archive. */
export const archiveSlotFor = (labelId: string, search: boolean): ArchiveSlot =>
  search
    ? "archive"
    : labelId === "SPAM"
      ? "not-spam"
      : labelId === "TRASH"
        ? "move-to-inbox"
        : "archive";

export const ARCHIVE_SLOT_LABEL: Record<ArchiveSlot, string> = {
  archive: "Archive",
  "not-spam": "Not spam",
  "move-to-inbox": "Move to Inbox",
};

export const archiveSlotIcon = (slot: ArchiveSlot) =>
  slot === "not-spam" ? <ShieldCheck /> : slot === "move-to-inbox" ? <Inbox /> : <Archive />;

/** The slot for the mailbox on screen. */
export function useArchiveSlot(): ArchiveSlot {
  const labelId = useUiStore((s) => s.mailbox.labelId);
  const search = useMailStore((s) => Boolean(s.query?.search));
  return archiveSlotFor(labelId, search);
}

/** The same, read once (menus built on demand). */
export const currentArchiveSlot = (): ArchiveSlot =>
  archiveSlotFor(
    useUiStore.getState().mailbox.labelId,
    Boolean(useMailStore.getState().query?.search),
  );

/**
 * Gmail offers Report spam on conversations that aren't in Spam (Not spam is there), Trash or Drafts, judged by
 * their own system labels, so a search's results and a mixed selection are covered too.
 */
export const canReportSpam = (systemLabelIds: string[]): boolean =>
  !systemLabelIds.some((l) => l === "SPAM" || l === "TRASH" || l === "DRAFT");
