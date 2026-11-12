// The conversation list: virtualized rows, multi-select, infinite scroll, and the first-sync, empty and error states.
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { Button } from "../components/ui/Button";
import { ListRow } from "../components/ui/ListRow";
import { Skeleton } from "../components/ui/Skeleton";
import { type ContextMenuItem, openContextMenuFromEvent } from "../lib/contextMenu";
import type { ThreadSummary } from "../lib/tauri";
import { focusFromKeyboard } from "../keyboard/focus";
import { registry } from "../keyboard/registry";
import { useCommands } from "../keyboard/useCommands";
import { useAccountStore } from "../store/accountStore";
import { useLabelStore } from "../store/labelStore";
import { useMailStore } from "../store/mailStore";
import { focusedThread, type ListDensity, readingPaneShown, useUiStore } from "../store/uiStore";
import { moveSelection, openAndMarkRead, openFocused, toggleCheckFocused } from "./actions";
import {
  accountColorIndex,
  locationOf,
  type MailboxRef,
  showsLocation,
  threadKey,
} from "./mailboxes";
import { type RowAction, rowId, ThreadRow } from "./ThreadRow";
import "./mail.css";

/** Ask for the next page when the last rendered row is this close to the end. */
const LOAD_MORE_WITHIN = 10;
const SKELETON_ROWS = 8;
/** Used until CSS is readable (tests); the real values are `--row-height-comfortable` and `--row-height-thread-compact`. */
const FALLBACK_ROW_HEIGHT: Record<ListDensity, number> = { comfortable: 76, compact: 56 };
const ROW_HEIGHT_TOKEN: Record<ListDensity, string> = {
  comfortable: "--row-height-comfortable",
  compact: "--row-height-thread-compact",
};

function rowHeightEstimate(density: ListDensity): number {
  const value = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(ROW_HEIGHT_TOKEN[density]),
  );
  return Number.isFinite(value) && value > 0 ? value : FALLBACK_ROW_HEIGHT[density];
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
  const unreadOnly = useUiStore((s) => s.unreadOnly);
  const threads = useMailStore((s) => s.threads);
  const loading = useMailStore((s) => s.loading);
  const error = useMailStore((s) => s.error);
  const accounts = useAccountStore((s) => s.accounts);

  if (threads.length > 0)
    return (
      <Rows
        key={`${mailbox.accountId}/${mailbox.labelId}/${mailbox.category}/${!!searchText}`}
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
  // The row drawn as selected: the open one, or with the reading pane off and nothing open, the highlight.
  const open = useUiStore(focusedThread);
  const readingPane = useUiStore(readingPaneShown);
  const listShown = useUiStore((s) => readingPaneShown(s) || s.openThread === null);
  const checked = useUiStore((s) => s.checked);
  const threads = useMailStore((s) => s.threads);
  const loading = useMailStore((s) => s.loading);
  const next = useMailStore((s) => s.next);
  const search = useMailStore((s) => s.search);
  const searchAccountId = useUiStore((s) => s.searchAccountId);
  const density = useUiStore((s) => s.listDensity);
  const remoteMore = Object.keys(search?.remoteNext ?? {}).length > 0;
  const canLoadMore = !!next || remoteMore;
  const error = useMailStore((s) => s.error);
  const accounts = useAccountStore((s) => s.accounts);
  useLabelStore((s) => s.labels); // re-render when any account's labels change; rows read the per-account maps
  const labelsById = useLabelStore.getState().labelsById;
  const scrollRef = useRef<HTMLDivElement>(null);

  const keys = useMemo(() => threads.map((t) => threadKey(t.accountId, t.id)), [threads]);
  // For the row callbacks: read at click time, so they stay the same functions and the memoized rows don't
  // all re-render whenever a thread changes (opening one marks it read).
  const keysRef = useRef(keys);
  useLayoutEffect(() => {
    keysRef.current = keys;
  });
  const checkedSet = useMemo(() => new Set(checked), [checked]);
  const accountEmail = useMemo(() => new Map(accounts.map((a) => [a.id, a.email])), [accounts]);
  const withLocation = showsLocation(mailbox, !!search);

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
    estimateSize: () => rowHeightEstimate(density),
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

  // Rows change height with density: drop the measured sizes so every row is measured again.
  useEffect(() => {
    virtualizer.measure();
    // `virtualizer` is stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [density]);

  // j/k and arrow keys move the open thread (or the highlight); keep it in view.
  useEffect(() => {
    if (openIndex >= 0) virtualizer.scrollToIndex(openIndex, { align: "auto" });
    // `virtualizer` is stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIndex]);

  // Reading pane off: back from a conversation (u or Back), the keys go to the list again.
  const wasShown = useRef(listShown);
  useEffect(() => {
    if (listShown && !wasShown.current && !readingPane)
      focusFromKeyboard(scrollRef.current, { preventScroll: true });
    wasShown.current = listShown;
  }, [listShown, readingPane]);

  const checkAll = () => useUiStore.getState().checkAll(keys);

  // Focus stays on the listbox and points at the open row, so rows can unmount while it scrolls.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "ArrowLeft" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      // On to the mailboxes; handled here so the global Left (`list.focus`) doesn't keep focus in place.
      // A held Left from the email stops at the list.
      e.preventDefault();
      if (!e.repeat) registry.run("sidebar.focus");
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
      run: () => focusFromKeyboard(scrollRef.current),
    },
    {
      id: "list.toggle-check",
      title: "Select conversation",
      group: "Conversation",
      shortcut: "x",
      run: toggleCheckFocused,
    },
    {
      id: "list.check-all",
      title: "Select all conversations",
      group: "Conversation",
      run: checkAll,
    },
  ]);

  const select = useCallback((e: MouseEvent, thread: ThreadSummary) => {
    scrollRef.current?.focus({ preventScroll: true });
    const key = threadKey(thread.accountId, thread.id);
    const ui = useUiStore.getState();
    if (e.metaKey || e.ctrlKey) ui.toggleChecked(key);
    else if (e.shiftKey) ui.checkRange(keysRef.current, key);
    else openAndMarkRead(key);
  }, []);
  const check = useCallback((e: MouseEvent, thread: ThreadSummary) => {
    const key = threadKey(thread.accountId, thread.id);
    const ui = useUiStore.getState();
    if (e.shiftKey) ui.checkRange(keysRef.current, key);
    else ui.toggleChecked(key);
  }, []);
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
        data-density={density}
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
                  compact={density === "compact"}
                  open={key === open}
                  checked={checkedSet.has(key)}
                  showAccountDot={showAccountDot}
                  accountColor={accountColorIndex(thread.accountId, accounts)}
                  accountEmail={accountEmail.get(thread.accountId) ?? thread.accountId}
                  labels={labelsById(thread.accountId)}
                  currentLabelId={mailbox.labelId}
                  location={withLocation ? locationOf(thread.systemLabelIds) : null}
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
