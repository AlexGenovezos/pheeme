import {
  Archive,
  Forward,
  Mail,
  MailOpen,
  MoreHorizontal,
  Reply,
  Star,
  Trash2,
} from "lucide-react";
import { type MouseEvent, useMemo } from "react";
import { IconButton } from "../components/ui/IconButton";
import { registry } from "../keyboard/registry";
import { useKeybinding } from "../keyboard/useCommands";
import { showContextMenu } from "../lib/contextMenu";
import {
  archive,
  respond,
  openLabelMenu,
  setRead,
  targetsOf,
  toggleStar,
  trash,
} from "../mail/actions";
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
  // In target order, so the first is the one `toggleStar` (and `s`) decides from.
  const rows = useMemo(() => {
    const byKey = new Map(threads.map((t) => [threadKey(t.accountId, t.id), t]));
    return [...new Set(targetsOf(checked, openKey))].flatMap((k) => byKey.get(k) ?? []);
  }, [checked, openKey, threads]);
  const stale = rows.length === 0;
  const anyUnread = rows.some((t) => t.unread);
  const starred = rows[0]?.starred ?? false;
  const keys = {
    archive: useKeybinding("conversation.archive", "e"),
    delete: useKeybinding("conversation.delete", "#"),
    read: useKeybinding("conversation.mark-read", "shift+i"),
    unread: useKeybinding("conversation.mark-unread", "shift+u"),
    star: useKeybinding("conversation.star", "s"),
    reply: useKeybinding("conversation.reply", "r"),
    forward: useKeybinding("conversation.forward", "f"),
  };

  const openMore = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void showContextMenu(
      [
        {
          id: "label",
          label: "Label as…",
          shortcut: registry.shortcutFor("conversation.labels", "l"),
          onSelect: () => void openLabelMenu({ x: r.left, y: r.bottom }),
        },
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
        <IconButton
          label="Archive"
          shortcut={keys.archive}
          icon={<Archive />}
          disabled={stale}
          onClick={() => void archive()}
        />
        <IconButton
          label="Delete"
          shortcut={keys.delete}
          icon={<Trash2 />}
          disabled={stale}
          onClick={() => void trash()}
        />
        <IconButton
          label={anyUnread ? "Mark as read" : "Mark as unread"}
          shortcut={anyUnread ? keys.read : keys.unread}
          icon={anyUnread ? <Mail /> : <MailOpen />}
          disabled={stale}
          onClick={() => void setRead(anyUnread)}
        />
        <IconButton
          label={starred ? "Remove star" : "Star"}
          shortcut={keys.star}
          icon={<Star />}
          disabled={stale}
          onClick={() => void toggleStar()}
        />
        <span className="toolbar__separator" />
        <IconButton
          label="Reply"
          shortcut={keys.reply}
          icon={<Reply />}
          disabled={off}
          onClick={() => void respond("reply")}
        />
        <IconButton
          label="Forward"
          shortcut={keys.forward}
          icon={<Forward />}
          disabled={off}
          onClick={() => void respond("forward")}
        />
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton
          label="More actions"
          icon={<MoreHorizontal />}
          disabled={stale}
          onClick={openMore}
        />
      </div>

      <ThreadView />
    </div>
  );
}
