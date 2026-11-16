import { call } from "../lib/ipc/call";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  size: string | null;
  resourceKey: string | null;
}

export interface DrivePage {
  files: DriveFile[];
  nextPageToken: string | null;
}

export const driveFiles = (accountId: string, query: string, pageToken: string | null = null) =>
  call("drive_files", { accountId, query, pageToken });

export const saveAttachmentToDrive = (accountId: string, messageId: string, attachmentId: string) =>
  call("save_attachment_to_drive", { accountId, messageId, attachmentId });

/** Use a known Google origin, even if a file carries an unexpected URL or name. */
export function driveFileUrl(file: DriveFile): string {
  const url = new URL(`https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`);
  if (file.resourceKey) url.searchParams.set("resourcekey", file.resourceKey);
  return url.href;
}
