import { Forward, Reply, ReplyAll } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { Kbd } from "../components/ui/Kbd";
import { LabelChip } from "../labels/LabelChip";
import { useCommands, useKeybinding } from "../keyboard/useCommands";
import type { LabelInfo, ThreadDetail } from "../lib/tauri";
import { useLabelStore } from "../store/labelStore";
import { useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { MessageCard } from "./MessageCard";
import { ThreadLoading } from "./ThreadLoading";
import { applyLabel, archive, respond } from "./actions";
import { parseThreadKey } from "./mailboxes";
import "./mail.css";

/** Which messages are open. `seen` is every message already given its starting state. */
interface Expansion {
  key: string | null;
  seen: ReadonlySet<string>;
  open: ReadonlySet<string>;
}

/** How far one arrow press scrolls the reading pane, about two lines of body text. */
const LINE_STEP = 40;
/** A page press keeps this much of the old view on screen, so the reader doesn't lose their place. */
const PAGE_FRACTION = 0.9;

/**
 * Scroll the focused reading pane from the keyboard. WebKit doesn't reliably scroll a focused `overflow` div
 * by itself, so the keys are handled here rather than left to the browser.
 */
function scrollFromKey(e: KeyboardEvent<HTMLDivElement>) {
  if (e.target !== e.currentTarget || e.defaultPrevented) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const pane = e.currentTarget;
  const behavior = e.repeat ? "auto" : "smooth";
  const page = Math.round(pane.clientHeight * PAGE_FRACTION);
  const by = {
    ArrowDown: LINE_STEP,
    ArrowUp: -LINE_STEP,
    PageDown: page,
    PageUp: -page,
    " ": e.shiftKey ? -page : page,
  }[e.key];
  if (by !== undefined) pane.scrollBy({ top: by, behavior });
  else if (e.key === "Home") pane.scrollTo({ top: 0, behavior });
  else if (e.key === "End") pane.scrollTo({ top: pane.scrollHeight, behavior });
  else return;
  e.preventDefault();
}

/**
 * Messages start open when they're the last or unread, and each is decided once: opening the thread marks it
 * read, and that mustn't fold the cards the user is looking at. Messages that arrive later are decided the same way.
 */
function withNewMessages(state: Expansion, key: string, detail: ThreadDetail): Expansion {
  const base =
    state.key === key ? state : { key, seen: new Set<string>(), open: new Set<string>() };
  const fresh = detail.messages.filter((m) => !base.seen.has(m.id));
  if (fresh.length === 0 && base === state) return state;
  const seen = new Set(base.seen);
  const open = new Set(base.open);
  const lastId = detail.messages[detail.messages.length - 1]?.id;
  for (const m of fresh) {
    seen.add(m.id);
    if (m.unread || m.id === lastId) open.add(m.id);
  }
  return { key, seen, open };
}

/** The Inbox chip when the label list hasn't loaded: system labels carry no colour, so it draws in the badge tokens. */
const INBOX_FALLBACK = (accountId: string): LabelInfo => ({
  id: "INBOX",
  accountId,
  name: "Inbox",
  type: "system",
  messagesTotal: 0,
  messagesUnread: 0,
  threadsTotal: 0,
  threadsUnread: 0,
  colorBackground: null,
  colorText: null,
  messageListVisibility: null,
  labelListVisibility: null,
});

function LabelChips({
  labels,
  onRemove,
}: {
  labels: LabelInfo[];
  onRemove(label: LabelInfo): void;
}) {
  if (labels.length === 0) return null;
  return (
    <ul className="thread-view__labels" aria-label="Labels">
      {labels.map((label) => (
        <li key={label.id}>
          <LabelChip label={label} onRemove={() => onRemove(label)} />
        </li>
      ))}
    </ul>
  );
}

export function ThreadView() {
  const openKey = useUiStore((s) => s.openThread);
  const detail = useThreadStore((s) => (openKey ? s.details.get(openKey) : undefined));
  const error = useThreadStore((s) => (openKey ? s.errors[openKey] : undefined));
  const loading = useThreadStore((s) => (openKey ? s.loading[openKey] : undefined));
  const load = useThreadStore((s) => s.load);
  const accountId = openKey ? parseThreadKey(openKey).accountId : "";
  const userLabels = useLabelStore((s) => s.userLabels(accountId));
  const labelsById = useLabelStore((s) => s.labelsById(accountId));
  const scroller = useRef<HTMLDivElement>(null);
  const [expansion, setExpansion] = useState<Expansion>({
    key: null,
    seen: new Set(),
    open: new Set(),
  });

  useEffect(() => {
    if (openKey) void load(openKey);
  }, [openKey, load]);

  // Right moves into the conversation, where the arrows scroll it; Left (`list.focus`) goes back to the list.
  useCommands([
    {
      id: "view.focus",
      title: "Focus conversation",
      group: "Navigation",
      shortcut: "right",
      run: () => {
        if (useUiStore.getState().openThread) scroller.current?.focus({ preventScroll: true });
      },
    },
  ]);

  // A new conversation starts at the top.
  useEffect(() => {
    scroller.current?.scrollTo?.({ top: 0 });
  }, [openKey]);

  let current = expansion;
  if (openKey && detail) {
    current = withNewMessages(expansion, openKey, detail);
    if (current !== expansion) setExpansion(current);
  }

  const toggle = (id: string) =>
    setExpansion((s) => {
      const open = new Set(s.open);
      if (!open.delete(id)) open.add(id);
      return { ...s, open };
    });

  let content;
  if (!openKey) {
    content = (
      <div className="pane-empty">
        <p className="pane-empty__title">No conversation selected</p>
        <EmptyHint />
      </div>
    );
  } else if (detail) {
    const onThread = new Set(detail.messages.flatMap((m) => m.labelIds));
    const chips = userLabels.filter((l) => onThread.has(l.id));
    const inbox = onThread.has("INBOX")
      ? (labelsById.get("INBOX") ?? INBOX_FALLBACK(accountId))
      : null;
    const subject = detail.thread.subject || "(no subject)";
    content = (
      <div className="thread-view">
        <h2 className="thread-view__subject selectable">{subject}</h2>
        <LabelChips
          labels={inbox ? [inbox, ...chips] : chips}
          onRemove={(label) =>
            void (label.id === "INBOX"
              ? archive([openKey], { evenIfGone: true })
              : applyLabel(accountId, label.id, false, [openKey], { evenIfGone: true }))
          }
        />
        <div className="thread-view__messages">
          {detail.messages.map((m) => (
            <MessageCard
              key={m.id}
              message={m}
              accountId={detail.thread.accountId}
              expanded={current.open.has(m.id)}
              onToggle={() => toggle(m.id)}
              bodyError={detail.bodyError}
              loading={loading}
            />
          ))}
        </div>
        <div className="thread-view__replies">
          <Button icon={<Reply />} onClick={() => void respond("reply")}>
            Reply
          </Button>
          <Button icon={<ReplyAll />} onClick={() => void respond("replyAll")}>
            Reply all
          </Button>
          <Button icon={<Forward />} onClick={() => void respond("forward")}>
            Forward
          </Button>
        </div>
      </div>
    );
  } else if (error) {
    content = (
      <div className="pane-empty">
        <p className="pane-empty__title">
          {error.code === "not_found"
            ? "This conversation isn't available any more."
            : error.message}
        </p>
        {error.code !== "not_found" && (
          <Button size="sm" onClick={() => void load(openKey)}>
            Try again
          </Button>
        )}
      </div>
    );
  } else {
    // Usually a blink from the local cache: ThreadLoading stays blank for that long, then says what it waits on.
    content = <ThreadLoading key={openKey} loading={loading} />;
  }

  return (
    <div
      className="view-pane__scroll"
      ref={scroller}
      role="region"
      aria-label="Open conversation"
      tabIndex={-1}
      onKeyDown={scrollFromKey}
    >
      {content}
    </div>
  );
}

/** "J and K move through the list. ⌘K shows every command.", with the user's keys. */
function EmptyHint() {
  const next = useKeybinding("list.next", "j");
  const previous = useKeybinding("list.previous", "k");
  const palette = useKeybinding("palette.toggle", "mod+k");
  return (
    <p className="pane-empty__hint">
      {next && previous && (
        <span className="pane-empty__hint-line">
          <Kbd shortcut={next} /> and <Kbd shortcut={previous} /> move through the list.
        </span>
      )}
      {palette && (
        <span className="pane-empty__hint-line">
          <Kbd shortcut={palette} /> shows every command.
        </span>
      )}
    </p>
  );
}
