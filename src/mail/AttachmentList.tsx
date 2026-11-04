import { Download, File } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { toast } from "../components/ui/Toast";
import { type AttachmentInfo, revealDownload, saveAttachment, toCommandError } from "../lib/tauri";
import "./mail.css";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export interface AttachmentListProps {
  accountId: string;
  messageId: string;
  attachments: AttachmentInfo[];
}

/** The message's files. Inline images belong to the body, so they're left out. */
export function AttachmentList({ accountId, messageId, attachments }: AttachmentListProps) {
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const files = attachments.filter((a) => !a.isInline);
  if (files.length === 0) return null;

  const download = async (file: AttachmentInfo) => {
    setSaving((s) => new Set(s).add(file.id));
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
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(file.id);
        return next;
      });
    }
  };

  return (
    <ul className="attachments" aria-label="Attachments">
      {files.map((file) => {
        const name = file.filename ?? "Attachment";
        const downloading = saving.has(file.id);
        return (
          <li key={file.id} className="attachments__item">
            <File className="attachments__icon" aria-hidden="true" />
            <span className="attachments__name selectable" title={name}>
              {name}
            </span>
            {downloading ? (
              <span className="attachments__size" role="status">
                Downloading…
              </span>
            ) : (
              file.size != null && (
                <span className="attachments__size">{formatSize(file.size)}</span>
              )
            )}
            <IconButton
              label={`${downloading ? "Downloading" : "Download"} ${name}`}
              icon={<Download />}
              size="sm"
              disabled={downloading}
              aria-busy={downloading}
              onClick={() => void download(file)}
            />
          </li>
        );
      })}
    </ul>
  );
}
