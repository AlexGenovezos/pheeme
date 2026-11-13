import { MailOpen, PanelLeftOpen, SquareCheckBig, SquarePen, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { toast } from "../components/ui/Toast";
import { registry } from "../keyboard/registry";
import { useCommands, useKeybinding } from "../keyboard/useCommands";
import type { ThreadSummary } from "../lib/tauri";
import {
  archive,
  composeNew,
  findSimilar,
  markSearchResultsRead,
  moveSelection,
  setRead,
  setStarred,
  trash,
} from "../mail/actions";
import { mailboxTitle, queryFor, threadKey } from "../mail/mailboxes";
import { ThreadList } from "../mail/ThreadList";
import type { RowAction } from "../mail/ThreadRow";
import { useAccountStore } from "../store/accountStore";
import { useLabelStore } from "../store/labelStore";
import { useMailStore } from "../store/mailStore";
import { sidebarLayout, useUiStore } from "../store/uiStore";
import { SearchBar, SEARCH_INPUT_ID } from "../search/SearchBar";
import { dragRegion } from "./chrome";
export { SEARCH_INPUT_ID };

/** Placeholder until the mail UI (Phase 6) wires real actions. */
export const notYet = (action: string) =>
  toast({ title: `${action} isn't wired up yet`, description: "It arrives with the mail UI." });

const onRowAction = (action: RowAction, t: ThreadSummary) => {
  const keys = [threadKey(t.accountId, t.id)];
  if (action === "archive") void archive(keys);
  else if (action === "delete") void trash(keys);
  else void setRead(t.unread, keys);
};

const NO_LABELS: { id: string; name: string }[] = [];

/**
 * The row's menu. It acts on the checked set when the row is part of it, else on the row alone: right-clicking
 * doesn't open the row, so the open conversation isn't its target.
 */
export const rowMenu = (t: ThreadSummary) => {
  const key = threadKey(t.accountId, t.id);
  const keys = useUiStore.getState().checked.includes(key) ? undefined : [key];
  return [
    {
      id: "archive",
      label: "Archive",
      shortcut: registry.shortcutFor("conversation.archive", "e"),
      onSelect: () => void archive(keys),
    },
    {
      id: "read",
      label: t.unread ? "Mark as read" : "Mark as unread",
      shortcut: t.unread
        ? registry.shortcutFor("conversation.mark-read", "shift+i")
        : registry.shortcutFor("conversation.mark-unread", "shift+u"),
      onSelect: () => void setRead(t.unread, keys),
    },
    {
      id: "star",
      label: t.starred ? "Remove star" : "Add star",
      shortcut: registry.shortcutFor("conversation.star", "s"),
      onSelect: () => void setStarred(!t.starred, keys),
    },
    { type: "separator" as const },
    {
      id: "similar-sender",
      label: "Find emails from this sender",
      onSelect: () => void findSimilar("sender", key),
    },
    {
      id: "similar-subject",
      label: "Find emails with this subject",
      onSelect: () => void findSimilar("subject", key),
    },
    { type: "separator" as const },
    {
      id: "delete",
      label: "Delete",
      shortcut: registry.shortcutFor("conversation.delete", "#"),
      danger: true,
      onSelect: () => void trash(keys),
    },
  ];
};

export function ListPane() {
  const { accountId, labelId, category } = useUiStore((s) => s.mailbox);
  const searchText = useUiStore((s) => s.searchText.trim());
  const searchAccountId = useUiStore((s) => s.searchAccountId);
  const search = useMailStore((s) => s.search);
  const next = useMailStore((s) => s.next);
  const loading = useMailStore((s) => s.loading);
  const error = useMailStore((s) => s.error);
  const unreadOnly = useUiStore((s) => s.unreadOnly);
  const toggleUnreadOnly = useUiStore((s) => s.toggleUnreadOnly);
  const anyChecked = useUiStore((s) => s.checked.length > 0);
  const checkedCount = useUiStore((s) => s.checked.length);
  const collapsed = useUiStore((s) => sidebarLayout(s) !== "expanded");
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  const accountIds = useAccountStore((s) => s.accounts.map((a) => a.id).join("\n"));
  const threads = useMailStore((s) => s.threads);

  // Refetched when the mailbox or the accounts change.
  useEffect(() => {
    const { load, clear } = useMailStore.getState();
    const ids = accountIds ? accountIds.split("\n") : [];
    if (ids.length === 0) clear();
    else if (searchText)
      void load({
        accountIds: searchAccountId === null ? ids : ids.filter((id) => id === searchAccountId),
        labelId: "ALL",
        search: searchText,
      });
    else
      void load({
        ...queryFor({ accountId, labelId, category }, ids),
        ...(unreadOnly ? { unreadOnly: true } : {}),
      });
  }, [accountId, labelId, category, accountIds, searchText, searchAccountId, unreadOnly]);

  const userLabels = useLabelStore((s) => (accountId ? s.userLabels(accountId) : NO_LABELS));
  const mailboxName = mailboxTitle({ accountId, labelId, category }, userLabels);
  const title = searchText ? "Search results" : mailboxName;
  const unread = useLabelStore((s) => {
    if (accountId === null) return s.allInboxUnread;
    if (category) return s.categoryCounts[accountId]?.[category] ?? 0;
    return s.counts[accountId]?.[labelId]?.unread ?? 0;
  });
  const sidebarKey = useKeybinding("view.toggleSidebar", "mod+b");
  const composeKey = useKeybinding("compose.new", "c");

  useCommands([
    {
      id: "list.next",
      title: "Next conversation",
      group: "Conversation",
      shortcut: "j",
      run: () => moveSelection(1),
    },
    {
      id: "list.previous",
      title: "Previous conversation",
      group: "Conversation",
      shortcut: "k",
      run: () => moveSelection(-1),
    },
    {
      id: "search.focus",
      title: "Search mail",
      group: "Navigation",
      shortcut: "/",
      keywords: ["find"],
      run: () => document.getElementById(SEARCH_INPUT_ID)?.focus(),
    },
    ...(searchText
      ? [
          {
            id: "search.mark-all-read",
            title: "Mark all search results as read",
            group: "Conversation",
            keywords: ["matches", "unread"],
            run: () => void markSearchResultsRead(),
          },
        ]
      : []),
    // Registered only while something is checked, so Escape stays free for everything else.
    ...(anyChecked
      ? [
          {
            id: "list.clear-checks",
            title: "Clear selection",
            group: "Conversation",
            shortcut: "escape",
            hidden: true,
            run: () => useUiStore.getState().clearChecked(),
          },
        ]
      : searchText
        ? [
            {
              id: "search.clear",
              title: "Clear search",
              group: "Navigation",
              shortcut: "escape",
              run: () => useUiStore.getState().setSearch(""),
            },
          ]
        : []),
  ]);

  return (
    <div className="list-pane">
      <div
        className="toolbar toolbar--list"
        data-sidebar-collapsed={collapsed || undefined}
        {...dragRegion}
      >
        {collapsed && (
          <>
            <IconButton
              label="Show sidebar"
              data-sidebar-toggle=""
              shortcut={sidebarKey}
              icon={<PanelLeftOpen />}
              onClick={toggleSidebar}
            />
            <IconButton
              label="New message"
              shortcut={composeKey}
              icon={<SquarePen />}
              onClick={composeNew}
            />
          </>
        )}
        <h1 className="toolbar__title" {...dragRegion}>
          {title}
        </h1>
        {searchText ? (
          <span className="toolbar__subtitle" aria-live="polite">
            {threads.length}
            {next ||
            loading ||
            error ||
            search?.remoteLoading ||
            Object.keys(search?.remoteNext ?? {}).length ||
            search?.remoteError
              ? "+"
              : ""}{" "}
            {threads.length === 1 ? "result" : "results"}
          </span>
        ) : (
          unread > 0 && (
            <span className="toolbar__subtitle" {...dragRegion}>
              {unread} unread
            </span>
          )
        )}
        {!searchText && (
          <Button
            size="sm"
            variant={unreadOnly ? "primary" : "secondary"}
            className="toolbar__unread-toggle"
            aria-pressed={unreadOnly}
            onClick={toggleUnreadOnly}
          >
            Unread only
          </Button>
        )}
      </div>

      <div className="list-pane__search">
        <SearchBar />
      </div>

      {threads.length > 0 && (
        <div className="list-pane__controls">
          <Button
            variant="ghost"
            size="sm"
            icon={anyChecked ? <X aria-hidden="true" /> : <SquareCheckBig aria-hidden="true" />}
            title={
              anyChecked ? "Clear selection" : `Select all ${threads.length} loaded conversations`
            }
            onClick={() => {
              const ui = useUiStore.getState();
              if (anyChecked) ui.clearChecked();
              else ui.checkAll(threads.map((thread) => threadKey(thread.accountId, thread.id)));
            }}
          >
            {anyChecked ? "Clear selection" : "Select all"}
          </Button>
          <span>
            <span aria-live="polite">{anyChecked ? `${checkedCount} selected` : ""}</span>
            {!anyChecked &&
              !searchText &&
              `${threads.length}${next ? "+" : ""} ${threads.length === 1 ? "conversation" : "conversations"}`}
          </span>
          {searchText && !anyChecked && (
            <Button
              variant="ghost"
              size="sm"
              icon={<MailOpen aria-hidden="true" />}
              title="Mark every match of this search as read, including ones not loaded yet"
              onClick={() => void markSearchResultsRead()}
            >
              Mark all as read
            </Button>
          )}
        </div>
      )}

      <ThreadList title={title} onRowAction={onRowAction} rowMenu={rowMenu} />
    </div>
  );
}
