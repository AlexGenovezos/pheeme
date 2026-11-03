import { Archive, Forward, Mail, MailOpen, MoreHorizontal, Reply, Star, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import { IconButton } from "../components/ui/IconButton";
import { showContextMenu } from "../lib/contextMenu";
import { archive, composeLater, openLabelMenu, setRead, setStarred, trash } from "../mail/actions";
import { threadKey } from "../mail/mailboxes";
import { ThreadView } from "../mail/ThreadView";
import { useMailStore } from "../store/mailStore";
import { useUiStore } from "../store/uiStore";
import { dragRegion } from "./chrome";
import { notYet } from "./ListPane";

export function ViewPane() {
  const openKey = useUiStore((s) => s.openThread);
  const off = !openKey;
  // The open row, for the toggles' labels. Gone from the list (archived elsewhere), the buttons stay off.
  const summary = useMailStore((s) => (openKey ? s.threads.find((t) => threadKey(t.accountId, t.id) === openKey) : undefined));
  const stale = off || !summary; // no open row, or it has left the list

  const openMore = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void showContextMenu(
      [
        { id: "label", label: "Label as…", shortcut: "l", onSelect: () => void openLabelMenu({ x: r.left, y: r.bottom }) },
        { id: "move", label: "Move to…", shortcut: "v", onSelect: () => notYet("Move") },
        { type: "separator" },
        { id: "original", label: "Show original", onSelect: () => notYet("Show original") },
      ],
      { x: r.left, y: r.bottom },
    );
  };

  return (
    <div className="view-pane">
      <div className="toolbar toolbar--view" {...dragRegion}>
        <IconButton label="Archive" shortcut="e" icon={<Archive />} disabled={stale} onClick={() => void archive()} />
        <IconButton label="Delete" shortcut="#" icon={<Trash2 />} disabled={stale} onClick={() => void trash()} />
        <IconButton
          label={summary?.unread ? "Mark as read" : "Mark as unread"}
          shortcut={summary?.unread ? "shift+i" : "shift+u"}
          icon={summary?.unread ? <Mail /> : <MailOpen />}
          disabled={stale}
          onClick={() => void setRead(Boolean(summary?.unread))}
        />
        <IconButton
          label={summary?.starred ? "Remove star" : "Star"}
          shortcut="s"
          icon={<Star />}
          disabled={stale}
          onClick={() => void setStarred(!summary?.starred)}
        />
        <span className="toolbar__separator" />
        <IconButton label="Reply" shortcut="r" icon={<Reply />} disabled={off} onClick={composeLater} />
        <IconButton label="Forward" shortcut="f" icon={<Forward />} disabled={off} onClick={composeLater} />
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton label="More actions" icon={<MoreHorizontal />} disabled={off} onClick={openMore} />
      </div>

      <ThreadView />
    </div>
  );
}
