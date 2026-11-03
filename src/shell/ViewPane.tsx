import { Archive, Forward, Mail, MailOpen, MoreHorizontal, Reply, Star, Trash2 } from "lucide-react";
import { type MouseEvent, useMemo } from "react";
import { IconButton } from "../components/ui/IconButton";
import { showContextMenu } from "../lib/contextMenu";
import { archive, composeLater, openLabelMenu, setRead, setStarred, targetsOf, trash } from "../mail/actions";
import { threadKey } from "../mail/mailboxes";
import { ThreadView } from "../mail/ThreadView";
import { useMailStore } from "../store/mailStore";
import { useUiStore } from "../store/uiStore";
import { dragRegion } from "./chrome";
import { notYet } from "./ListPane";

export function ViewPane() {
  const openKey = useUiStore((s) => s.openThread);
  const checked = useUiStore((s) => s.checked);
  const threads = useMailStore((s) => s.threads);
  const off = !openKey; // Reply and Forward need an open conversation
  // What the mutations act on (the checked rows, else the open one) that is still in the list. Rows that have
  // left it (archived elsewhere) are skipped by the actions, so with none left the buttons stay off.
  const rows = useMemo(() => {
    const wanted = new Set(targetsOf(checked, openKey));
    return threads.filter((t) => wanted.has(threadKey(t.accountId, t.id)));
  }, [checked, openKey, threads]);
  const stale = rows.length === 0;
  const anyUnread = rows.some((t) => t.unread);
  const allStarred = !stale && rows.every((t) => t.starred);

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
          label={anyUnread ? "Mark as read" : "Mark as unread"}
          shortcut={anyUnread ? "shift+i" : "shift+u"}
          icon={anyUnread ? <Mail /> : <MailOpen />}
          disabled={stale}
          onClick={() => void setRead(anyUnread)}
        />
        <IconButton
          label={allStarred ? "Remove star" : "Star"}
          shortcut="s"
          icon={<Star />}
          disabled={stale}
          onClick={() => void setStarred(!allStarred)}
        />
        <span className="toolbar__separator" />
        <IconButton label="Reply" shortcut="r" icon={<Reply />} disabled={off} onClick={composeLater} />
        <IconButton label="Forward" shortcut="f" icon={<Forward />} disabled={off} onClick={composeLater} />
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton label="More actions" icon={<MoreHorizontal />} disabled={stale} onClick={openMore} />
      </div>

      <ThreadView />
    </div>
  );
}
