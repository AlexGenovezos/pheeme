import type { AccountInfo } from "../lib/tauri";
import type { DriveFile, DrivePage } from "../drive/api";
import type { FixtureThread } from "./fixtures";

type Args = Record<string, unknown> | undefined;

/** Stateful Drive fixtures: files and saves are isolated by account. */
export function createDriveHandlers(
  accounts: AccountInfo[],
  threads: FixtureThread[],
  initialStatus: string | null,
) {
  const files = new Map<string, DriveFile[]>();
  const statuses = new Map<string, string>();
  for (const a of accounts)
    files.set(a.id, [
      {
        id: `${a.id}-brief`,
        name: "Project brief",
        mimeType: "application/vnd.google-apps.document",
        size: null,
        modifiedTime: new Date().toISOString(),
        resourceKey: null,
      },
      {
        id: `${a.id}-budget`,
        name: "Budget.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: "18432",
        modifiedTime: new Date().toISOString(),
        resourceKey: "sample-key",
      },
    ]);
  const ensure = (accountId: string) => {
    if (!accounts.some((a) => a.id === accountId))
      throw { code: "not_found", message: "That account isn't connected." };
    const status = statuses.get(accountId) ?? initialStatus;
    if (status === "missing_scope")
      throw {
        code: "missing_scope",
        message: "Allow Google Drive access to browse files and save attachments.",
      };
    if (status === "api_disabled")
      throw {
        code: "api_disabled",
        message: "Turn on the Google Drive API in your Google Cloud project, then try again.",
      };
  };
  return {
    allow(accountId: string) {
      statuses.set(accountId, "on");
    },
    handlers: {
      drive_files: (args: Args): DrivePage => {
        const accountId = String(args?.accountId);
        ensure(accountId);
        const query = String(args?.query ?? "").toLowerCase();
        return {
          files: (files.get(accountId) ?? [])
            .filter((f) => f.name.toLowerCase().includes(query))
            .map((f) => ({ ...f })),
          nextPageToken: null,
        };
      },
      save_attachment_to_drive: (args: Args): DriveFile => {
        const accountId = String(args?.accountId);
        ensure(accountId);
        const attachment = threads
          .filter((t) => t.accountId === accountId)
          .flatMap((t) => t.messages)
          .find((m) => m.id === args?.messageId)
          ?.attachments.find((a) => a.id === args?.attachmentId);
        if (!attachment)
          throw { code: "not_found", message: "That attachment isn't on this device." };
        const file: DriveFile = {
          id: crypto.randomUUID(),
          name: attachment.filename ?? "Attachment",
          mimeType: attachment.mimeType ?? "application/octet-stream",
          size: String(attachment.size ?? 0),
          modifiedTime: new Date().toISOString(),
          resourceKey: null,
        };
        files.set(accountId, [file, ...(files.get(accountId) ?? [])]);
        return file;
      },
    },
  };
}
