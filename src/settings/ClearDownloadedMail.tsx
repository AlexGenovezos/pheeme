import { useState } from "react";
import { Button } from "../components/ui/Button";
import { toast } from "../components/ui/Toast";
import { type ClearedDownloads, clearDownloadedMail, toCommandError } from "../lib/tauri";
import { formatSize } from "../mail/AttachmentList";

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The toast after clearing, e.g. "Cleared 3 emails and 30 bytes of attachments". */
export function clearedMessage({ messages, bytes }: ClearedDownloads): string {
  const size = bytes < 1024 ? plural(bytes, "byte", "bytes") : formatSize(bytes);
  return `Cleared ${plural(messages, "email", "emails")} and ${size} of attachments`;
}

/** Settings › Appearance › Privacy: drops downloaded email text and attachments, after asking. */
export function ClearDownloadedMail() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function clear() {
    setBusy(true);
    try {
      toast({ title: clearedMessage(await clearDownloadedMail()) });
    } catch (raw) {
      toast({
        title: "Couldn't clear downloaded mail",
        description: toCommandError(raw).message,
        tone: "danger",
      });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!confirming)
    return (
      <Button size="sm" onClick={() => setConfirming(true)}>
        Clear…
      </Button>
    );
  return (
    <div className="settings-clear" role="alertdialog" aria-label="Clear downloaded mail?">
      <span>Your conversation list and labels stay.</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        autoFocus
        onClick={() => setConfirming(false)}
      >
        Cancel
      </Button>
      <Button size="sm" variant="danger" disabled={busy} onClick={() => void clear()}>
        Clear
      </Button>
    </div>
  );
}
