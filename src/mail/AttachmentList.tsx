import { Download, File } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import type { AttachmentInfo } from "../lib/tauri";
import { downloadAttachment } from "./attachmentActions";
import { isCalendarBodyPart } from "./invitePart";
import { usePreviewStore } from "./preview/previewStore";
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

/** The message's files, each opening the preview panel. Inline images belong to the body, so they're left out. */
export function AttachmentList({ accountId, messageId, attachments }: AttachmentListProps) {
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  // The invite card stands in for an invitation's unnamed calendar part.
  const files = attachments.filter((a) => !a.isInline && !isCalendarBodyPart(a));
  if (files.length === 0) return null;

  const download = async (file: AttachmentInfo) => {
    setSaving((s) => new Set(s).add(file.id));
    try {
      await downloadAttachment(accountId, messageId, file);
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(file.id);
        return next;
      });
    }
  };

  const preview = (index: number) =>
    usePreviewStore.getState().open({ accountId, messageId, files, index });

  return (
    <ul className="attachments" aria-label="Attachments">
      {files.map((file, index) => {
        const name = file.filename ?? "Attachment";
        const downloading = saving.has(file.id);
        return (
          <li key={file.id} className="attachments__item">
            {/* Click, or Space/Enter with it focused, opens the preview (like Quick Look). */}
            <button
              type="button"
              className="attachments__open"
              aria-label={`Preview ${name}`}
              title={`Preview ${name}`}
              onClick={() => preview(index)}
            >
              <File className="attachments__icon" aria-hidden="true" />
              <span className="attachments__name">{name}</span>
            </button>
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
