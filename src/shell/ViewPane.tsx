import {
  ArrowLeft,
  CalendarPlus,
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
import { useComposeSettings } from "../compose/composeSettings";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { describeShortcut } from "../keyboard/format";
import { useWidth } from "../lib/useWidth";
import { registry } from "../keyboard/registry";
import { useKeybinding } from "../keyboard/useCommands";
import { showContextMenu } from "../lib/contextMenu";
import { ARCHIVE_SLOT_LABEL, archiveSlotIcon, useArchiveSlot } from "../mail/archiveSlot";
import {
  archiveSlotAction,
  closeConversation,
  findSimilar,
  respond,
  openLabelMenu,
  openMoveMenu,
  setRead,
  targetsOf,
  toggleStar,
  trash,
} from "../mail/actions";
import { threadKey } from "../mail/mailboxes";
import { PRINT_COMMAND, printConversation } from "../mail/print";
import {
  CREATE_EVENT_COMMAND,
  CREATE_EVENT_SHORTCUT,
  createEventFromEmail,
} from "../calendar/mailActions";
import { ThreadView } from "../mail/ThreadView";
import { speedReadOpenConversation, useCanSpeedRead } from "../speedread/open";
import { useSpeedReaderSettings } from "../speedread/settings";
import { useMailStore } from "../store/mailStore";
import { readingPaneShown, useUiStore } from "../store/uiStore";
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
  /** The default reply: filled when the button is labelled. */
  primary?: boolean;
  onClick(): void;
}) {
  const { label, shortcut, icon, compact, primary, ...rest } = props;
  if (compact) return <IconButton label={label} shortcut={shortcut} icon={icon} {...rest} />;
  return (
    <Button
      variant={primary ? "primary" : "ghost"}
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
  const readingPane = useUiStore(readingPaneShown);
  const defaultReply = useComposeSettings((s) => s.defaultReply);
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
  const slot = useArchiveSlot();
  const anyUnread = rows.some((t) => t.unread);
  const starred = rows[0]?.starred ?? false;
  const keys = {
    back: useKeybinding("conversation.close"),
    archive: useKeybinding("conversation.archive"),
    delete: useKeybinding("conversation.delete"),
    read: useKeybinding("conversation.mark-read"),
    unread: useKeybinding("conversation.mark-unread"),
    star: useKeybinding("conversation.star"),
    reply: useKeybinding("conversation.reply"),
    replyAll: useKeybinding("conversation.reply-all"),
    forward: useKeybinding("conversation.forward"),
    speedRead: useKeybinding("conversation.speed-read"),
    createEvent: useKeybinding(CREATE_EVENT_COMMAND, CREATE_EVENT_SHORTCUT),
  };
  // Offered only on simple prose emails; the shortcut still says so when there's nothing to read.
  const offerSpeedRead = useSpeedReaderSettings((s) => s.offer);
  const readable = useCanSpeedRead(offerSpeedRead);

  const openMore = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void showContextMenu(
      [
        {
          id: "label",
          label: "Label as…",
          shortcut: registry.shortcutFor("conversation.labels"),
          onSelect: () => void openLabelMenu({ x: r.left, y: r.bottom }),
        },
        {
          id: "move",
          label: "Move to…",
          shortcut: registry.shortcutFor("conversation.move"),
          onSelect: () => openMoveMenu({ x: r.left, y: r.bottom }),
        },
        {
          id: "create-event",
          label: "Create event from email",
          shortcut: registry.shortcutFor(CREATE_EVENT_COMMAND, CREATE_EVENT_SHORTCUT),
          disabled: off,
          onSelect: () => void createEventFromEmail(),
        },
        { type: "separator" },
        {
          id: "similar-sender",
          label: "Find emails from this sender",
          onSelect: () => void findSimilar("sender"),
        },
        {
          id: "similar-subject",
          label: "Find emails with this subject",
          onSelect: () => void findSimilar("subject"),
        },
        { type: "separator" },
        {
          id: "print",
          label: "Print",
          shortcut: registry.shortcutFor(PRINT_COMMAND),
          disabled: stale,
          onSelect: () => void printConversation(),
        },
        { id: "original", label: "Show original", onSelect: () => notYet("Show original") },
      ],
      { x: r.left, y: r.bottom },
    );
  };

  return (
    <div className="view-pane" ref={ref}>
      <div className="toolbar toolbar--view" {...dragRegion}>
        {/* Reading pane off: the conversation stands in for the list, so offer the way back. */}
        {!readingPane && (
          <>
            <IconButton
              label="Back to list"
              data-command="conversation.close"
              shortcut={keys.back}
              icon={<ArrowLeft />}
              onClick={closeConversation}
            />
            <span className="toolbar__separator" />
          </>
        )}
        <IconButton
          label={ARCHIVE_SLOT_LABEL[slot]}
          data-command="conversation.archive"
          shortcut={keys.archive}
          icon={archiveSlotIcon(slot)}
          disabled={stale}
          onClick={() => void archiveSlotAction()}
        />
        <IconButton
          label="Delete"
          data-command="conversation.delete"
          shortcut={keys.delete}
          icon={<Trash2 />}
          disabled={stale}
          onClick={() => void trash()}
        />
        <IconButton
          label={anyUnread ? "Mark as read" : "Mark as unread"}
          data-command={anyUnread ? "conversation.mark-read" : "conversation.mark-unread"}
          shortcut={anyUnread ? keys.read : keys.unread}
          icon={anyUnread ? <MailOpen /> : <Mail />}
          disabled={stale}
          onClick={() => void setRead(anyUnread)}
        />
        <IconButton
          label={starred ? "Remove star" : "Star"}
          data-command="conversation.star"
          shortcut={keys.star}
          icon={<Star />}
          disabled={stale}
          onClick={() => void toggleStar()}
        />
        <span className="toolbar__separator" />
        {defaultReply === "replyAll" ? (
          <>
            <ReplyButton
              label="Reply all"
              data-command="conversation.reply-all"
              shortcut={keys.replyAll}
              icon={<ReplyAll />}
              compact={compact}
              disabled={off}
              primary
              onClick={() => void respond("replyAll")}
            />
            <ReplyButton
              label="Reply"
              data-command="conversation.reply"
              shortcut={keys.reply}
              icon={<Reply />}
              compact={compact}
              disabled={off}
              onClick={() => void respond("reply")}
            />
          </>
        ) : (
          <>
            <ReplyButton
              label="Reply"
              data-command="conversation.reply"
              shortcut={keys.reply}
              icon={<Reply />}
              compact={compact}
              disabled={off}
              primary
              onClick={() => void respond("reply")}
            />
            <ReplyButton
              label="Reply all"
              data-command="conversation.reply-all"
              shortcut={keys.replyAll}
              icon={<ReplyAll />}
              compact={compact}
              disabled={off}
              onClick={() => void respond("replyAll")}
            />
          </>
        )}
        <ReplyButton
          label="Forward"
          data-command="conversation.forward"
          shortcut={keys.forward}
          icon={<Forward />}
          compact={compact}
          disabled={off}
          onClick={() => void respond("forward")}
        />
        {offerSpeedRead && readable && (
          <ReplyButton
            label="Speed read"
            data-command="conversation.speed-read"
            shortcut={keys.speedRead}
            icon={<Zap />}
            compact={compact}
            disabled={false}
            onClick={speedReadOpenConversation}
          />
        )}
        <span className="toolbar__spacer" {...dragRegion} />
        <IconButton
          label="Create event from email"
          data-command={CREATE_EVENT_COMMAND}
          shortcut={keys.createEvent}
          icon={<CalendarPlus />}
          disabled={off}
          onClick={() => void createEventFromEmail()}
        />
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
