import { MailOpen, PanelLeftOpen, SquareCheckBig, SquarePen, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Skeleton } from "../components/ui/Skeleton";
import { registry } from "../keyboard/registry";
import { useCommands, useKeybinding } from "../keyboard/useCommands";
import type { ThreadSummary } from "../lib/tauri";
import {
  archiveSlotAction,
  composeNew,
  canMarkImportance,
  findSimilar,
  forwardConversationsAsAttachment,
  isImportant,
  markSearchResultsRead,
  moveSelection,
  reportSpam,
  setImportant,
  setRead,
  setStarred,
  trash,
} from "../mail/actions";
import { ARCHIVE_SLOT_LABEL, canReportSpam, currentArchiveSlot } from "../mail/archiveSlot";
import { mailboxTitle, queryFor, threadKey } from "../mail/mailboxes";
import { ThreadList } from "../mail/ThreadList";
import type { RowAction } from "../mail/ThreadRow";
import { useAccountStore } from "../store/accountStore";
import { useLabelStore } from "../store/labelStore";
import { useMailStore } from "../store/mailStore";
import { sidebarLayout, unreadOnlyFor, useUiStore } from "../store/uiStore";
import { hasTerm, toggleTerm } from "../search/operators";
import { SearchBar, SearchStatus, SEARCH_INPUT_ID } from "../search/SearchBar";
import { dragRegion } from "./chrome";
import { DEFAULT_KEYS } from "../keyboard/defaultKeys";
import { FORWARD_AS_ATTACHMENT_COMMAND } from "../compose/respond";
export { SEARCH_INPUT_ID };

const onRowAction = (action: RowAction, t: ThreadSummary) => {
  const keys = [threadKey(t.accountId, t.id)];
  if (action === "archive") void archiveSlotAction(keys);
  else if (action === "delete") void trash(keys);
  else if (action === "important") void setImportant(!isImportant(t), keys);
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
      label: ARCHIVE_SLOT_LABEL[currentArchiveSlot()],
      shortcut: registry.shortcutFor("conversation.archive"),
      onSelect: () => void archiveSlotAction(keys),
    },
    {
      id: "report-spam",
      label: "Report spam",
      shortcut: registry.shortcutFor("conversation.report-spam"),
      // Not for conversations in Spam, Trash or Drafts, like Gmail; the item keeps its place.
      disabled: !canReportSpam(t.systemLabelIds),
      onSelect: () => void reportSpam(keys),
    },
    {
      id: "read",
      label: t.unread ? "Mark as read" : "Mark as unread",
      shortcut: t.unread
        ? registry.shortcutFor("conversation.mark-read")
        : registry.shortcutFor("conversation.mark-unread"),
      onSelect: () => void setRead(t.unread, keys),
    },
    {
      id: "star",
      label: t.starred ? "Remove star" : "Add star",
      shortcut: registry.shortcutFor("conversation.star"),
      onSelect: () => void setStarred(!t.starred, keys),
    },
    {
      id: "important",
      disabled: !canMarkImportance(t),
      label: isImportant(t) ? "Mark as not important" : "Mark as important",
      shortcut: registry.shortcutFor(
        isImportant(t) ? "conversation.mark-not-important" : "conversation.mark-important",
      ),
      onSelect: () => void setImportant(!isImportant(t), keys),
    },
    {
      id: "forward-attachment",
      label: "Forward as attachment",
      shortcut: registry.shortcutFor(FORWARD_AS_ATTACHMENT_COMMAND),
      onSelect: () => void forwardConversationsAsAttachment(keys),
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
      shortcut: registry.shortcutFor("conversation.delete"),
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
  const unreadOnly = useUiStore((s) => unreadOnlyFor(s, s.mailbox));
  const toggleUnreadOnly = useUiStore((s) => s.toggleUnreadOnly);
  const anyChecked = useUiStore((s) => s.checked.length > 0);
  const checkedCount = useUiStore((s) => s.checked.length);
  const collapsed = useUiStore((s) => sidebarLayout(s) !== "expanded");
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  const accountIds = useAccountStore((s) => s.accounts.map((a) => a.id).join("\n"));
  const scopeEmail = useAccountStore((s) =>
    s.accounts.length > 1 ? s.accounts.find((a) => a.id === searchAccountId)?.email : undefined,
  );
  // While searching, Unread only is the search's own `is:unread`, so the button stays where it is.
  const unreadPressed = searchText ? hasTerm(searchText, "is", "unread") : unreadOnly;
  const onUnreadOnly = () => {
    if (!searchText) return toggleUnreadOnly();
    const ui = useUiStore.getState();
    ui.setSearch(toggleTerm(ui.searchText.trim(), "is", "unread", !unreadPressed));
  };
  const count = useMailStore((s) => s.threads.length);

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
  // `null` until the account's counts have loaded.
  const unread = useLabelStore((s): number | null => {
    if (accountId === null)
      return Object.keys(s.categoryCounts).length > 0 ? s.allInboxUnread : null;
    if (category) {
      const counts = s.categoryCounts[accountId];
      return counts ? (counts[category] ?? 0) : null;
    }
    const counts = s.counts[accountId];
    return counts ? (counts[labelId]?.unread ?? 0) : null;
  });
  const sidebarKey = useKeybinding("view.toggleSidebar");
  const composeKey = useKeybinding("compose.new");

  useCommands([
    {
      id: "list.next",
      title: "Next conversation",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["list.next"],
      repeat: true,
      run: () => moveSelection(1),
    },
    {
      id: "list.previous",
      title: "Previous conversation",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["list.previous"],
      repeat: true,
      run: () => moveSelection(-1),
    },
    {
      id: "search.focus",
      title: "Search mail",
      group: "Navigation",
      shortcut: DEFAULT_KEYS["search.focus"],
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
              data-command="view.toggleSidebar"
              shortcut={sidebarKey}
              icon={<PanelLeftOpen />}
              onClick={toggleSidebar}
            />
            <IconButton
              label="New message"
              data-command="compose.new"
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
          <span
            className="toolbar__subtitle toolbar__subtitle--search"
            title={scopeEmail && `Searching ${scopeEmail} only`}
            aria-live="polite"
          >
            {count}
            {next ||
            loading ||
            error ||
            search?.remoteLoading ||
            Object.keys(search?.remoteNext ?? {}).length ||
            search?.remoteError
              ? "+"
              : ""}{" "}
            {count === 1 ? "result" : "results"}
            {scopeEmail && ` in ${scopeEmail}`}
          </span>
        ) : (
          // Always there, so the count arriving doesn't move the title row.
          <span className="toolbar__subtitle" {...dragRegion}>
            {unread === null ? <Skeleton width="5em" /> : unread > 0 ? `${unread} unread` : null}
          </span>
        )}
        <Button
          size="sm"
          variant={unreadPressed ? "primary" : "secondary"}
          className="toolbar__unread-toggle"
          aria-pressed={unreadPressed}
          onClick={onUnreadOnly}
        >
          Unread only
        </Button>
      </div>

      <div className="list-pane__search">
        <SearchBar />
      </div>

      {/* Drawn from the first frame (off while there is nothing to select), so rows don't move down when they arrive. */}
      <div className="list-pane__controls">
        <Button
          variant="ghost"
          size="sm"
          disabled={count === 0 && !anyChecked}
          icon={anyChecked ? <X aria-hidden="true" /> : <SquareCheckBig aria-hidden="true" />}
          title={anyChecked ? "Clear selection" : `Select all ${count} loaded conversations`}
          onClick={() => {
            const ui = useUiStore.getState();
            if (anyChecked) ui.clearChecked();
            else
              ui.checkAll(
                useMailStore
                  .getState()
                  .threads.map((thread) => threadKey(thread.accountId, thread.id)),
              );
          }}
        >
          {anyChecked ? "Clear selection" : "Select all"}
        </Button>
        <span className="list-pane__count">
          <span aria-live="polite">{anyChecked ? `${checkedCount} selected` : ""}</span>
          {searchText && <SearchStatus />}
          {!anyChecked &&
            !searchText &&
            (count === 0 && loading ? (
              <Skeleton width="8em" />
            ) : (
              `${count}${next ? "+" : ""} ${count === 1 ? "conversation" : "conversations"}`
            ))}
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

      <ThreadList title={title} onRowAction={onRowAction} rowMenu={rowMenu} />
    </div>
  );
}
