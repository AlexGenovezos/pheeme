import { type KeyboardEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { Kbd } from "../components/ui/Kbd";
import { LabelChip } from "../labels/LabelChip";
import { useCommands, useKeybinding } from "../keyboard/useCommands";
import { type LabelInfo, prefetchAttachments, type ThreadDetail } from "../lib/tauri";
import { useReadingSettings } from "../settings/readingSettings";
import { useMailStore } from "../store/mailStore";
import { useLabelStore } from "../store/labelStore";
import { isComplete, useThreadStore } from "../store/threadStore";
import { useUiStore } from "../store/uiStore";
import { InviteCard } from "../calendar/InviteCard";
import { inviteMessage } from "./invitePart";
import { CodeCard } from "./CodeCard";
import { MessageCard } from "./MessageCard";
import { ThreadLoading } from "./ThreadLoading";
import { applyLabel, archive } from "./actions";
import { focusFromKeyboard } from "../keyboard/focus";
import { registry } from "../keyboard/registry";
import { FindBar } from "./find/FindBar";
import { handleScrollKeyDown, handleScrollKeyUp, stopKeyScroll } from "./keyScroll";
import { parseThreadKey, threadKey } from "./mailboxes";
import { openTimer } from "./openTiming";
import { conversationCode } from "./verificationCode";
import "./mail.css";

/** Which messages are open. `seen` is every message already given its starting state. */
interface Expansion {
  key: string | null;
  seen: ReadonlySet<string>;
  open: ReadonlySet<string>;
}

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
  // Arrows glide, including while held; the rest jump a page (or to an end), smoothly when pressed once.
  if (handleScrollKeyDown(pane, e.nativeEvent)) return;
  const behavior = e.repeat ? "auto" : "smooth";
  const page = Math.round(pane.clientHeight * PAGE_FRACTION);
  const by = {
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
  const details = useThreadStore((s) => s.details);
  const rows = useMailStore((s) => s.threads);
  const preloadImages = useReadingSettings((s) => s.preloadImages);
  const scroller = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState<string[]>([]);
  // Find in conversation: 0 is closed; each mod+f counts up, which refocuses the open bar.
  const [find, setFind] = useState(0);
  if (find && !openKey) setFind(0);
  // The open conversation, plus (with Preload images on) two rows either side rendered out of sight, so the next
  // arrow shows a finished email. Images a server won't let us cache only survive in a live document.
  const keys = rows.map((row) => threadKey(row.accountId, row.id));
  const at = openKey ? keys.indexOf(openKey) : -1;
  const nearby = !preloadImages
    ? []
    : at < 0
      ? keys.slice(0, 2)
      : keys.slice(Math.max(0, at - 2), at + 3);
  const wanted = new Set(
    [...nearby, ...(openKey ? [openKey] : [])].filter((key) => details.has(key)),
  );
  // Survivors keep their place: moving an iframe in the DOM throws its document away.
  const next = [
    ...mounted.filter((key) => wanted.has(key)),
    ...[...wanted].filter((key) => !mounted.includes(key)),
  ];
  if (next.join() !== mounted.join()) setMounted(next);

  useEffect(() => {
    if (openKey) void load(openKey);
  }, [openKey, load]);

  // Children wrote their email frames in layout effects, so the open conversation is in the DOM: time its paint
  // and images (diagnostics) once every body is in, or the backend said why one isn't. Later refreshes of the
  // same open are ignored by the timer.
  useEffect(() => {
    const root = scroller.current?.querySelector('.thread-view__retained[data-visible="true"]');
    const ready = detail && (isComplete(detail) || detail.bodyError);
    if (openKey && ready && root) openTimer().shown(openKey, root);
  }, [openKey, detail]);

  // Right moves into the conversation, where the arrows scroll it; Left (`list.focus`) goes back to the list.
  useCommands([
    {
      id: "view.focus",
      title: "Focus conversation",
      group: "Navigation",
      shortcut: "right",
      run: () => {
        if (useUiStore.getState().openThread)
          focusFromKeyboard(scroller.current, { preventScroll: true });
      },
    },
    {
      id: "conversation.find",
      title: "Find in conversation",
      group: "Conversation",
      shortcut: "mod+f",
      keywords: ["search", "find in page", "find in email"],
      run: () => {
        // With no conversation open there's nothing to find in: search mail instead.
        if (useUiStore.getState().openThread) setFind((n) => n + 1);
        else registry.run("search.focus");
      },
    },
  ]);

  // A new conversation starts at the top.
  useEffect(() => {
    if (scroller.current) stopKeyScroll(scroller.current);
    scroller.current?.scrollTo?.({ top: 0 });
  }, [openKey]);

  let content;
  if (!openKey) {
    content = (
      <div className="pane-empty">
        <p className="pane-empty__title">No conversation selected</p>
        <EmptyHint />
      </div>
    );
  } else if (detail) {
    content = null;
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

  // The focus ring is drawn by the frame, above the content: on the scroller itself, an email's iframe covers it.
  return (
    <div className="view-pane__frame">
      <div
        className="view-pane__scroll"
        ref={scroller}
        role="region"
        aria-label="Open conversation"
        tabIndex={-1}
        onKeyDown={scrollFromKey}
        onKeyUp={(e) => handleScrollKeyUp(e.currentTarget, e.nativeEvent)}
      >
        {content}
        {mounted.map((key) => (
          <div
            key={key}
            className="thread-view__retained"
            data-visible={key === openKey}
            aria-hidden={key !== openKey || undefined}
            {...(key !== openKey ? { inert: true } : {})}
          >
            <Conversation openKey={key} detail={details.get(key)!} active={key === openKey} />
          </div>
        ))}
      </div>
      {find > 0 && openKey && (
        <FindBar pane={scroller} openKey={openKey} request={find} onClose={() => setFind(0)} />
      )}
    </div>
  );
}

/**
 * Memoized: the view re-renders whenever any cached conversation changes (prefetching neighbours, marking read),
 * and the conversations kept mounted beside the open one only need to when their own detail does.
 */
const Conversation = memo(function Conversation({
  openKey,
  detail,
  active,
}: {
  openKey: string;
  detail: ThreadDetail;
  /** The conversation on screen; the rest are neighbours rendered out of sight. */
  active: boolean;
}) {
  const loading = useThreadStore((s) => s.loading[openKey]);
  const accountId = parseThreadKey(openKey).accountId;
  const userLabels = useLabelStore((s) => s.userLabels(accountId));
  const labelsById = useLabelStore((s) => s.labelsById(accountId));
  const [expansion, setExpansion] = useState<Expansion>({
    key: null,
    seen: new Set(),
    open: new Set(),
  });
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

  const onThread = new Set(detail.messages.flatMap((m) => m.labelIds));
  const chips = userLabels.filter((l) => onThread.has(l.id));
  const inbox = onThread.has("INBOX")
    ? (labelsById.get("INBOX") ?? INBOX_FALLBACK(accountId))
    : null;
  const subject = detail.thread.subject || "(no subject)";
  const code = useMemo(() => conversationCode(detail.messages), [detail.messages]);
  const invite = useMemo(() => inviteMessage(detail.messages), [detail.messages]);
  usePrefetchAttachments(detail, active);
  const sent = detail.messages.filter((m) => !m.labelIds.includes("DRAFT")).length;
  return (
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
      {code && <CodeCard code={code.code} />}
      {/* Only on screen: reading the invitation may download it, and neighbours are speculative. */}
      {invite && active && (
        <InviteCard
          key={invite.id}
          pinned={{ accountId, threadId: detail.thread.id, messageId: invite.id }}
        />
      )}
      <div className="thread-view__messages">
        {detail.messages.map((m) => (
          <MessageCard
            key={m.id}
            message={m}
            accountId={detail.thread.accountId}
            expanded={current.open.has(m.id)}
            bodyError={detail.bodyError}
            loading={loading}
            onToggle={() => toggle(m.id)}
            respondHere={sent > 1}
          />
        ))}
      </div>
    </div>
  );
});

/**
 * Opening a conversation starts caching its attachments in the background, so a preview opens at once.
 * Once per conversation and set of messages: a reply arriving asks again, for the new message only.
 */
function usePrefetchAttachments(detail: ThreadDetail, active: boolean) {
  const accountId = detail.thread.accountId;
  const ids = detail.messages
    .filter((m) => m.attachments.some((a) => !a.isInline))
    .map((m) => m.id)
    .reverse(); // newest first: if the budget runs out, the latest files are the ones cached
  const key = ids.join(",");
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!active) return;
    const fresh = key ? key.split(",").filter((id) => !asked.current.has(id)) : [];
    if (!fresh.length) return;
    fresh.forEach((id) => asked.current.add(id));
    prefetchAttachments(accountId, fresh).catch(() => undefined);
  }, [accountId, key, active]);
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
