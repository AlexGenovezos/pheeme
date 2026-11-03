import { Archive, Forward, MailOpen, MoreHorizontal, Reply, Star, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import { IconButton } from "../components/ui/IconButton";
import { showContextMenu } from "../lib/contextMenu";
import { ThreadView } from "../mail/ThreadView";
import { useUiStore } from "../store/uiStore";
import { dragRegion } from "./chrome";
import { notYet } from "./ListPane";

export function ViewPane() {
  const openKey = useUiStore((s) => s.openThread);
  const off = !openKey;

  const openMore = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void showContextMenu(
      [
        { id: "label", label: "Label as…", shortcut: "l", onSelect: () => notYet("Labels") },
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
        <IconButton label="Archive" shortcut="e" icon={<Archive />} disabled={off} onClick={() => notYet("Archive")} />
        <IconButton label="Delete" shortcut="#" icon={<Trash2 />} disabled={off} onClick={() => notYet("Delete")} />
        <IconButton label="Mark as unread" shortcut="shift+u" icon={<MailOpen />} disabled={off} onClick={() => notYet("Mark as unread")} />
        <IconButton label="Star" shortcut="s" icon={<Star />} disabled={off} onClick={() => notYet("Star")} />
        <span className="toolbar__separator" />
        <IconButton label="Reply" shortcut="r" icon={<Reply />} disabled={off} onClick={() => notYet("Reply")} />
        <IconButton label="Forward" shortcut="f" icon={<Forward />} disabled={off} onClick={() => notYet("Forward")} />
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton label="More actions" icon={<MoreHorizontal />} disabled={off} onClick={openMore} />
      </div>

      <ThreadView />
    </div>
  );
}
