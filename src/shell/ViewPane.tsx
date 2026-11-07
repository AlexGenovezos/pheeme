import {
  Archive,
  Forward,
  Mail,
  MailOpen,
  MoreHorizontal,
  Reply,
  ReplyAll,
  Star,
  Trash2,
  Zap,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useMemo, useRef } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { describeShortcut } from "../keyboard/format";
import { useWidth } from "../lib/useWidth";
import { registry } from "../keyboard/registry";
import { useKeybinding } from "../keyboard/useCommands";
import { showContextMenu } from "../lib/contextMenu";
import {
  archive,
  respond,
  openLabelMenu,
  openMoveMenu,
  setRead,
  targetsOf,
  toggleStar,
  trash,
} from "../mail/actions";
import { threadKey } from "../mail/mailboxes";
import { ThreadView } from "../mail/ThreadView";
import { speedReadOpenConversation, useReadableMessage } from "../speedread/open";
import { useSpeedReaderSettings } from "../speedread/settings";
import { useMailStore } from "../store/mailStore";
import { useUiStore } from "../store/uiStore";
import { dragRegion } from "./chrome";
import { notYet } from "./ListPane";

/** Below this reading-pane width, Reply, Reply all and Forward drop their words to fit the toolbar. */
const LABELED_REPLIES_MIN = 560;

/** Reply, Reply all or Forward: worded in the toolbar so it's always in reach, icon-only when the pane is narrow. */
function ReplyButton(props: {
  label: string;
  shortcut: string | undefined;
  icon: ReactNode;
  compact: boolean;
  disabled: boolean;
  onClick(): void;
}) {
  const { label, shortcut, icon, compact, ...rest } = props;
  if (compact) return <IconButton label={label} shortcut={shortcut} icon={icon} {...rest} />;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="toolbar__reply"
      icon={icon}
      title={shortcut ? `${label} (${describeShortcut(shortcut)})` : label}
      {...rest}
    >
      {label}
    </Button>
  );
}

export function ViewPane() {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const compact = width > 0 && width < LABELED_REPLIES_MIN;
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
    replyAll: useKeybinding("conversation.reply-all", "a"),
    forward: useKeybinding("conversation.forward", "f"),
    speedRead: useKeybinding("conversation.speed-read", "shift+r"),
  };
  // Offered only on simple prose emails; the shortcut still says so when there's nothing to read.
  const offerSpeedRead = useSpeedReaderSettings((s) => s.offer);
  const readable = useReadableMessage(offerSpeedRead);

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
        {
          id: "move",
          label: "Move to…",
          shortcut: registry.shortcutFor("conversation.move", "v"),
          onSelect: () => openMoveMenu({ x: r.left, y: r.bottom }),
        },
        { type: "separator" },
        { id: "original", label: "Show original", onSelect: () => notYet("Show original") },
      ],
      { x: r.left, y: r.bottom },
    );
  };

  return (
    <div className="view-pane" ref={ref}>
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
        <ReplyButton
          label="Reply"
          shortcut={keys.reply}
          icon={<Reply />}
          compact={compact}
          disabled={off}
          onClick={() => void respond("reply")}
        />
        <ReplyButton
          label="Reply all"
          shortcut={keys.replyAll}
          icon={<ReplyAll />}
          compact={compact}
          disabled={off}
          onClick={() => void respond("replyAll")}
        />
        <ReplyButton
          label="Forward"
          shortcut={keys.forward}
          icon={<Forward />}
          compact={compact}
          disabled={off}
          onClick={() => void respond("forward")}
        />
        {offerSpeedRead && readable && (
          <ReplyButton
            label="Speed read"
            shortcut={keys.speedRead}
            icon={<Zap />}
            compact={compact}
            disabled={false}
            onClick={speedReadOpenConversation}
          />
        )}
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
