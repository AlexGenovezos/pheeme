import { Archive, Forward, MailOpen, MoreHorizontal, Reply, Star, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import { Avatar } from "../components/ui/Avatar";
import { IconButton } from "../components/ui/IconButton";
import { Kbd } from "../components/ui/Kbd";
import { showContextMenu } from "../lib/contextMenu";
import { formatFullDate } from "../lib/dates";
import { fixtureThreads } from "../preview/fixtures";
import { isPreview } from "../preview/runtime";
import { useMailStore } from "../store/mailStore";
import { useUiStore } from "../store/uiStore";
import { dragRegion } from "./chrome";
import { notYet, senderOf } from "./ListPane";

export function ViewPane() {
  const selectedId = useUiStore((s) => s.selectedThreadId);
  const summary = useMailStore((s) => s.threads.find((t) => t.id === selectedId));
  // Preview mode has full fixture bodies; real threads show their summary until the Phase 6 thread view.
  const fixture = isPreview() ? fixtureThreads.find((t) => t.id === selectedId) : undefined;
  const thread = fixture ?? summary;
  const off = !thread;

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
        <IconButton
          label="Archive"
          shortcut="e"
          icon={<Archive />}
          disabled={off}
          onClick={() => notYet("Archive")}
        />
        <IconButton
          label="Delete"
          shortcut="#"
          icon={<Trash2 />}
          disabled={off}
          onClick={() => notYet("Delete")}
        />
        <IconButton
          label="Mark as unread"
          shortcut="shift+u"
          icon={<MailOpen />}
          disabled={off}
          onClick={() => notYet("Mark as unread")}
        />
        <IconButton
          label="Star"
          shortcut="s"
          icon={<Star />}
          disabled={off}
          onClick={() => notYet("Star")}
        />
        <span className="toolbar__separator" />
        <IconButton
          label="Reply"
          shortcut="r"
          icon={<Reply />}
          disabled={off}
          onClick={() => notYet("Reply")}
        />
        <IconButton
          label="Forward"
          shortcut="f"
          icon={<Forward />}
          disabled={off}
          onClick={() => notYet("Forward")}
        />
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton
          label="More actions"
          icon={<MoreHorizontal />}
          disabled={off}
          onClick={openMore}
        />
      </div>

      <div className="view-pane__scroll">
        {thread ? (
          <article className="message" aria-label={thread.subject ?? "(no subject)"}>
            <h2 className="message__subject selectable">{thread.subject ?? "(no subject)"}</h2>
            <header className="message__header">
              <Avatar name={senderOf(thread)} email={thread.fromAddress ?? undefined} />
              <div className="message__from">
                <span className="message__name selectable">{senderOf(thread)}</span>
                {thread.fromAddress && (
                  <span className="message__address selectable">{thread.fromAddress}</span>
                )}
              </div>
              {thread.date > 0 && (
                <time className="message__date" dateTime={new Date(thread.date).toISOString()}>
                  {formatFullDate(thread.date)}
                </time>
              )}
            </header>
            <div className="message__body selectable">{fixture?.body ?? thread.snippet}</div>
          </article>
        ) : (
          <div className="pane-empty">
            <p className="pane-empty__title">No conversation selected</p>
            <p className="pane-empty__hint">
              <Kbd shortcut="j" /> and <Kbd shortcut="k" /> move through the list.{" "}
              <Kbd shortcut="mod+k" /> shows every command.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
