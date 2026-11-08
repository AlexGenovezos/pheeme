import { toast } from "../components/ui/Toast";
import {
  type AttachmentInfo,
  openAttachment,
  revealDownload,
  saveAttachment,
  toCommandError,
} from "../lib/tauri";

/** Save a file to Downloads and say so, with a way to show it in the file manager. */
export async function downloadAttachment(
  accountId: string,
  messageId: string,
  file: AttachmentInfo,
): Promise<void> {
  try {
    const path = await saveAttachment(accountId, messageId, file.id);
    toast({
      title: "Saved to Downloads",
      description: file.filename ?? undefined,
      action: {
        label: "Show in folder",
        run: () =>
          void revealDownload(path).catch((e) =>
            toast({
              title: "Couldn't show the file",
              description: toCommandError(e).message,
              tone: "danger",
            }),
          ),
      },
    });
  } catch (error) {
    toast({
      title: "Couldn't save the attachment",
      description: toCommandError(error).message,
      tone: "danger",
    });
  }
}

/** Open a file in the default app for its type. */
export async function openAttachmentExternally(
  accountId: string,
  messageId: string,
  file: AttachmentInfo,
): Promise<void> {
  try {
    await openAttachment(accountId, messageId, file.id);
  } catch (error) {
    toast({
      title: "Couldn't open the attachment",
      description: toCommandError(error).message,
      tone: "danger",
    });
  }
}
