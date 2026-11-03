import { PanelLeftOpen, Search } from "lucide-react";
import { useEffect } from "react";
import { IconButton } from "../components/ui/IconButton";
import { Kbd } from "../components/ui/Kbd";
import { TextInput } from "../components/ui/TextInput";
import { toast } from "../components/ui/Toast";
import { useCommands } from "../keyboard/useCommands";
import type { ThreadSummary } from "../lib/tauri";
import { archive, moveSelection, setRead, setStarred, trash } from "../mail/actions";
import { mailboxTitle, queryFor, threadKey } from "../mail/mailboxes";
import { ThreadList } from "../mail/ThreadList";
import { senderOf } from "../mail/ThreadRow";
import type { RowAction } from "../mail/ThreadRow";
import { useAccountStore } from "../store/accountStore";
import { useLabelStore } from "../store/labelStore";
import { useMailStore } from "../store/mailStore";
import { useUiStore } from "../store/uiStore";
import { dragRegion } from "./chrome";

export const SEARCH_INPUT_ID = "mail-search";

/** Placeholder until the mail UI (Phase 6) wires real actions. */
export const notYet = (action: string) => toast({ title: `${action} isn't wired up yet`, description: "It arrives with the mail UI." });

export { senderOf };

const onRowAction = (action: RowAction, t: ThreadSummary) => {
  const keys = [threadKey(t.accountId, t.id)];
  if (action === "archive") void archive(keys);
  else if (action === "delete") void trash(keys);
  else void setRead(t.unread, keys);
};

const NO_LABELS: { id: string; name: string }[] = [];

/** The row's menu. Actions apply to the checked set when the row is part of it (the list checks that before opening), else to the row. */
const rowMenu = (t: ThreadSummary) => [
  { id: "archive", label: "Archive", shortcut: "e", onSelect: () => void archive() },
  { id: "read", label: t.unread ? "Mark as read" : "Mark as unread", shortcut: t.unread ? "shift+i" : "shift+u", onSelect: () => void setRead(t.unread) },
  { id: "star", label: t.starred ? "Remove star" : "Add star", shortcut: "s", onSelect: () => void setStarred(!t.starred) },
  { type: "separator" as const },
  { id: "delete", label: "Delete", shortcut: "#", danger: true, onSelect: () => void trash() },
];

export function ListPane() {
  const { accountId, labelId, category } = useUiStore((s) => s.mailbox);
  const anyChecked = useUiStore((s) => s.checked.length > 0);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  const accountIds = useAccountStore((s) => s.accounts.map((a) => a.id).join("\n"));
  const threads = useMailStore((s) => s.threads);

  // Refetched when the mailbox or the accounts change.
  useEffect(() => {
    const { load, clear } = useMailStore.getState();
    const ids = accountIds ? accountIds.split("\n") : [];
    if (ids.length === 0) clear();
    else void load(queryFor({ accountId, labelId, category }, ids));
  }, [accountId, labelId, category, accountIds]);

  const userLabels = useLabelStore((s) => (accountId ? s.userLabels(accountId) : NO_LABELS));
  const title = mailboxTitle({ accountId, labelId, category }, userLabels);
  const unread = threads.filter((t) => t.unread).length;

  useCommands([
    { id: "list.next", title: "Next conversation", group: "Conversation", shortcut: "j", run: () => moveSelection(1) },
    { id: "list.previous", title: "Previous conversation", group: "Conversation", shortcut: "k", run: () => moveSelection(-1) },
    {
      id: "search.focus",
      title: "Search mail",
      group: "Navigation",
      shortcut: "/",
      keywords: ["find"],
      run: () => document.getElementById(SEARCH_INPUT_ID)?.focus(),
    },
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
      : []),
  ]);

  return (
    <div className="list-pane">
      <div className="toolbar toolbar--list" data-sidebar-collapsed={collapsed || undefined} {...dragRegion}>
        {collapsed && <IconButton label="Show sidebar" shortcut="mod+b" icon={<PanelLeftOpen />} onClick={toggleSidebar} />}
        <h1 className="toolbar__title" {...dragRegion}>
          {title}
        </h1>
        {unread > 0 && (
          <span className="toolbar__subtitle" {...dragRegion}>
            {unread} unread
          </span>
        )}
      </div>

      <div className="list-pane__search">
        <TextInput
          id={SEARCH_INPUT_ID}
          type="search"
          placeholder="Search mail"
          aria-label="Search mail"
          leading={<Search />}
          trailing={<Kbd shortcut="/" />}
          onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
        />
      </div>

      <ThreadList title={title} onRowAction={onRowAction} rowMenu={rowMenu} />
    </div>
  );
}
