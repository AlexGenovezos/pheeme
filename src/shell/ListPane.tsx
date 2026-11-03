import { PanelLeftOpen, Search } from "lucide-react";
import { useEffect, type KeyboardEvent } from "react";
import { IconButton } from "../components/ui/IconButton";
import { Kbd } from "../components/ui/Kbd";
import { TextInput } from "../components/ui/TextInput";
import { toast } from "../components/ui/Toast";
import { useCommands } from "../keyboard/useCommands";
import type { ThreadSummary } from "../lib/tauri";
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

const ROW_ACTION_NAMES: Record<RowAction, string> = { archive: "Archive", delete: "Delete", read: "Mark as read" };
const onRowAction = (action: RowAction) => notYet(ROW_ACTION_NAMES[action]);

const NO_LABELS: { id: string; name: string }[] = [];

const rowMenu = (t: ThreadSummary) => [
  { id: "archive", label: "Archive", shortcut: "e", onSelect: () => notYet("Archive") },
  { id: "read", label: t.unread ? "Mark as read" : "Mark as unread", shortcut: "shift+u", onSelect: () => notYet("Mark as read") },
  { id: "star", label: t.starred ? "Remove star" : "Add star", shortcut: "s", onSelect: () => notYet("Star") },
  { type: "separator" as const },
  { id: "delete", label: "Delete", shortcut: "#", danger: true, onSelect: () => notYet("Delete") },
];

export function ListPane() {
  const { accountId, labelId, category } = useUiStore((s) => s.mailbox);
  const selected = useUiStore((s) => s.openThread);
  const select = useUiStore((s) => s.setOpenThread);
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
  const index = threads.findIndex((t) => threadKey(t.accountId, t.id) === selected);

  const move = (delta: 1 | -1) => {
    if (!threads.length) return;
    const next = index < 0 ? (delta === 1 ? 0 : threads.length - 1) : Math.min(Math.max(index + delta, 0), threads.length - 1);
    select(threadKey(threads[next].accountId, threads[next].id));
  };

  useCommands([
    { id: "list.next", title: "Next conversation", group: "Conversation", shortcut: "j", run: () => move(1) },
    { id: "list.previous", title: "Previous conversation", group: "Conversation", shortcut: "k", run: () => move(-1) },
    {
      id: "search.focus",
      title: "Search mail",
      group: "Navigation",
      shortcut: "/",
      keywords: ["find"],
      run: () => document.getElementById(SEARCH_INPUT_ID)?.focus(),
    },
  ]);

  const onListKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else return;
    e.preventDefault();
  };

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

      <ThreadList title={title} onRowAction={onRowAction} rowMenu={rowMenu} onKeyDown={onListKeyDown} />
    </div>
  );
}
