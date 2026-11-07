// The conversation list: virtualized rows, multi-select, infinite scroll, and the first-sync, empty and error states.
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { Button } from "../components/ui/Button";
import { ListRow } from "../components/ui/ListRow";
import { Skeleton } from "../components/ui/Skeleton";
import { type ContextMenuItem, openContextMenuFromEvent } from "../lib/contextMenu";
import type { ThreadSummary } from "../lib/tauri";
import { useCommands } from "../keyboard/useCommands";
import { useAccountStore } from "../store/accountStore";
import { useLabelStore } from "../store/labelStore";
import { useMailStore } from "../store/mailStore";
import { useUiStore } from "../store/uiStore";
import { moveSelection, openAndMarkRead, openFocused } from "./actions";
import { accountColorIndex, mailboxKey, type MailboxRef, threadKey } from "./mailboxes";
import { type RowAction, rowId, ThreadRow } from "./ThreadRow";
import "./mail.css";

/** Ask for the next page when the last rendered row is this close to the end. */
const LOAD_MORE_WITHIN = 10;
const SKELETON_ROWS = 8;
/** Used until CSS is readable (tests); the real value is `--row-height-comfortable`. */
const FALLBACK_ROW_HEIGHT = 76;

function rowHeightEstimate(): number {
  const value = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--row-height-comfortable"),
  );
  return Number.isFinite(value) && value > 0 ? value : FALLBACK_ROW_HEIGHT;
}

export interface ThreadListProps {
  /** The mailbox's display name, for the listbox label and the empty state. */
  title: string;
  onRowAction(action: RowAction, thread: ThreadSummary): void;
  rowMenu(thread: ThreadSummary): ContextMenuItem[];
}

/** What to say when a mailbox has nothing in it. */
export function emptyCopy(mailbox: MailboxRef, title: string): string {
  if (mailbox.labelId === "INBOX") return "Inbox zero.";
  if (mailbox.labelId === "STARRED") return "Nothing starred yet.";
  return `No conversations in ${title}`;
}

export function ThreadList(props: ThreadListProps) {
  const mailbox = useUiStore((s) => s.mailbox);
  const search = useMailStore((s) => s.search);
  const searchText = useUiStore((s) => s.searchText.trim());
  const unreadOnly = useUiStore((s) => !!s.unreadMailboxes[mailboxKey(s.mailbox)]);
  const threads = useMailStore((s) => s.threads);
  const loading = useMailStore((s) => s.loading);
  const error = useMailStore((s) => s.error);
  const accounts = useAccountStore((s) => s.accounts);

  if (threads.length > 0)
    return (
      <Rows
        key={`${mailbox.accountId}/${mailbox.labelId}/${mailbox.category}/${searchText}`}
        {...props}
      />
    );

  const queried =
    mailbox.accountId === null ? accounts : accounts.filter((a) => a.id === mailbox.accountId);
  const firstSync = queried.some((a) => !a.synced);

  // A failed first query is worth more than a skeleton that would never go away.
  if (error) {
    return (
      <div className="list-pane__scroll">
        <div className="thread-state" role="alert">
          <p className="thread-state__message">{error.message}</p>
          <Button onClick={() => void useMailStore.getState().reload()}>Try again</Button>
        </div>
      </div>
    );
  }
  if (firstSync && !searchText) {
    return (
      <div
        className="list-pane__scroll"
        aria-busy="true"
        aria-label={`${props.title} conversations loading`}
      >
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <ListRow
            key={i}
            role="presentation"
            leading={<Skeleton shape="circle" />}
            title={<Skeleton width="45%" />}
            subtitle={<Skeleton width="75%" />}
            description={<Skeleton width="90%" />}
          />
        ))}
      </div>
    );
  }
  // The first page is still on its way: show nothing rather than flash "Inbox zero".
  if (loading) return <div className="list-pane__scroll" aria-busy="true" />;
  return (
    <div className="list-pane__scroll">
      <div className="thread-state">
        <p className="thread-state__message">
          {searchText
            ? search?.remoteError
              ? "No cached matches. Retry Gmail to search the rest of your mail."
              : search?.remoteLoading
                ? "Looking for matching mail…"
                : "No conversations match your search."
            : unreadOnly
              ? `No unread mail in ${props.title}`
              : emptyCopy(mailbox, props.title)}
        </p>
        {searchText && Object.keys(search?.remoteNext ?? {}).length > 0 && (
          <Button onClick={() => void useMailStore.getState().loadMore()}>Load more results</Button>
        )}
      </div>
    </div>
  );
}

function Rows({ title, onRowAction, rowMenu }: ThreadListProps) {
  const mailbox = useUiStore((s) => s.mailbox);
  const open = useUiStore((s) => s.openThread);
  const checked = useUiStore((s) => s.checked);
  const threads = useMailStore((s) => s.threads);
  const loading = useMailStore((s) => s.loading);
  const next = useMailStore((s) => s.next);
  const search = useMailStore((s) => s.search);
  const searchAccountId = useUiStore((s) => s.searchAccountId);
  const remoteMore = Object.keys(search?.remoteNext ?? {}).length > 0;
  const canLoadMore = !!next || remoteMore;
  const error = useMailStore((s) => s.error);
  const accounts = useAccountStore((s) => s.accounts);
  useLabelStore((s) => s.labels); // re-render when any account's labels change; rows read the per-account maps
  const labelsById = useLabelStore.getState().labelsById;
  const scrollRef = useRef<HTMLDivElement>(null);

  const keys = useMemo(() => threads.map((t) => threadKey(t.accountId, t.id)), [threads]);
  const checkedSet = useMemo(() => new Set(checked), [checked]);
  const accountEmail = useMemo(() => new Map(accounts.map((a) => [a.id, a.email])), [accounts]);

  const openIndex = open === null ? -1 : keys.indexOf(open);
  // The active option must stay in the DOM wherever the user scrolls, or aria-activedescendant would name a missing element.
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = defaultRangeExtractor(range);
      if (openIndex < 0 || openIndex >= range.count || indexes.includes(openIndex)) return indexes;
      return [...indexes, openIndex].sort((a, b) => a - b);
    },
    [openIndex],
  );

  // The compiler skips this component because the virtualizer's functions aren't memoizable; that is expected.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: rowHeightEstimate,
    overscan: 8,
    rangeExtractor,
    getItemKey: (i) => keys[i],
  });
  const items = virtualizer.getVirtualItems();
  const lastRendered = items.length ? items[items.length - 1].index : -1;

  // Infinite scroll. The store ignores a call while a page is in flight; a finished page changes `threads.length` and asks again.
  useEffect(() => {
    if (
      canLoadMore &&
      !error &&
      lastRendered >= 0 &&
      lastRendered >= threads.length - LOAD_MORE_WITHIN
    )
      void useMailStore.getState().loadMore();
  }, [
    lastRendered,
    threads.length,
    next,
    canLoadMore,
    search?.remoteNext,
    search?.remoteLoading,
    loading,
    error,
  ]);

  // j/k and arrow keys move the open thread; keep it in view.
  useEffect(() => {
    if (openIndex >= 0) virtualizer.scrollToIndex(openIndex, { align: "auto" });
    // `virtualizer` is stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIndex]);

  const checkAll = () => useUiStore.getState().checkAll(keys);

  // Focus stays on the listbox and points at the open row, so rows can unmount while it scrolls.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      openFocused();
    } else if (
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === "a"
    ) {
      // Not a registry shortcut: inside an email body the same keys must still select text.
      e.preventDefault();
      checkAll();
    }
  };

  useCommands([
    {
      id: "list.focus",
      title: "Focus conversation list",
      group: "Navigation",
      shortcut: "left",
      run: () => scrollRef.current?.focus(),
    },
    {
      id: "list.toggle-check",
      title: "Select conversation",
      group: "Conversation",
      shortcut: "x",
      run: () => {
        const key = useUiStore.getState().openThread;
        if (key !== null) useUiStore.getState().toggleChecked(key);
      },
    },
    {
      id: "list.check-all",
      title: "Select all conversations",
      group: "Conversation",
      run: checkAll,
    },
  ]);

  const select = useCallback(
    (e: MouseEvent, thread: ThreadSummary) => {
      scrollRef.current?.focus({ preventScroll: true });
      const key = threadKey(thread.accountId, thread.id);
      const ui = useUiStore.getState();
      if (e.metaKey || e.ctrlKey) ui.toggleChecked(key);
      else if (e.shiftKey) ui.checkRange(keys, key);
      else openAndMarkRead(key);
    },
    [keys],
  );
  const check = useCallback(
    (e: MouseEvent, thread: ThreadSummary) => {
      const key = threadKey(thread.accountId, thread.id);
      const ui = useUiStore.getState();
      if (e.shiftKey) ui.checkRange(keys, key);
      else ui.toggleChecked(key);
    },
    [keys],
  );
  const contextMenu = useCallback(
    (e: MouseEvent, thread: ThreadSummary) => {
      // Right-clicking neither opens the row nor touches the selection; the menu knows its own target.
      openContextMenuFromEvent(e, rowMenu(thread));
    },
    [rowMenu],
  );

  const showAccountDot = search ? searchAccountId === null : mailbox.accountId === null;

  // Logical set size; -1 while more pages exist.
  const setSize = canLoadMore || search?.remoteLoading ? -1 : threads.length;

  return (
    <div className="thread-body">
      <div
        ref={scrollRef}
        className="list-pane__scroll"
        role="listbox"
        aria-multiselectable="true"
        aria-label={`${title} conversations`}
        aria-activedescendant={openIndex >= 0 ? rowId(keys[openIndex]) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div className="thread-list" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const thread = threads[item.index];
            const key = keys[item.index];
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                role="presentation"
                className="thread-list__item"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <ThreadRow
                  thread={thread}
                  position={item.index + 1}
                  setSize={setSize}
                  open={key === open}
                  checked={checkedSet.has(key)}
                  showAccountDot={showAccountDot}
                  accountColor={accountColorIndex(thread.accountId, accounts)}
                  accountEmail={accountEmail.get(thread.accountId) ?? thread.accountId}
                  labels={labelsById(thread.accountId)}
                  currentLabelId={mailbox.labelId}
                  onSelect={select}
                  onCheck={check}
                  onAction={onRowAction}
                  onContextMenu={contextMenu}
                />
              </div>
            );
          })}
        </div>
      </div>
      {error && (
        <div className="thread-list__error" role="alert">
          <span>{error.message}</span>
          <Button size="sm" onClick={() => void useMailStore.getState().reload()}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
