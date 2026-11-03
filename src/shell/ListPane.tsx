import { PanelLeftOpen, Paperclip, Search, Star } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { Avatar } from "../components/ui/Avatar";
import { IconButton } from "../components/ui/IconButton";
import { Kbd } from "../components/ui/Kbd";
import { ListRow } from "../components/ui/ListRow";
import { TextInput } from "../components/ui/TextInput";
import { toast } from "../components/ui/Toast";
import { useCommands } from "../keyboard/useCommands";
import { openContextMenuFromEvent } from "../lib/contextMenu";
import { formatListDate } from "../lib/dates";
import type { ThreadSummary } from "../lib/tauri";
import { fixtureMailboxes, fixtureLabels } from "../preview/fixtures";
import { useAccountStore } from "../store/accountStore";
import { useMailStore } from "../store/mailStore";
import { useUiStore } from "../store/uiStore";
import { dragRegion } from "./chrome";

export const SEARCH_INPUT_ID = "mail-search";

/** Placeholder until the mail UI (Phase 6) wires real actions. */
export const notYet = (action: string) =>
  toast({ title: `${action} isn't wired up yet`, description: "It arrives with the mail UI." });

/** Mailboxes the sidebar shows that have no backing Gmail label yet (Phase 6). */
const UNBACKED_MAILBOXES = new Set(["ALL"]);

export const senderOf = (t: Pick<ThreadSummary, "fromName" | "fromAddress">) =>
  t.fromName ?? t.fromAddress ?? "Unknown sender";

const rowMenu = (t: ThreadSummary) => [
  { id: "archive", label: "Archive", shortcut: "e", onSelect: () => notYet("Archive") },
  {
    id: "read",
    label: t.unread ? "Mark as read" : "Mark as unread",
    shortcut: "shift+u",
    onSelect: () => notYet("Mark as read"),
  },
  {
    id: "star",
    label: t.starred ? "Remove star" : "Add star",
    shortcut: "s",
    onSelect: () => notYet("Star"),
  },
  { type: "separator" as const },
  { id: "delete", label: "Delete", shortcut: "#", danger: true, onSelect: () => notYet("Delete") },
];

export function ListPane() {
  const mailbox = useUiStore((s) => s.activeMailbox);
  const selected = useUiStore((s) => s.selectedThreadId);
  const select = useUiStore((s) => s.selectThread);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const listRef = useRef<HTMLDivElement>(null);

  const accountIds = useAccountStore((s) => s.accounts.map((a) => a.id).join("\n"));
  const threads = useMailStore((s) => s.threads);

  // All Inboxes: every connected account, refetched when the mailbox or the accounts change.
  useEffect(() => {
    const { load, clear } = useMailStore.getState();
    const ids = accountIds ? accountIds.split("\n") : [];
    if (UNBACKED_MAILBOXES.has(mailbox) || ids.length === 0) clear();
    else void load({ accountIds: ids, labelId: mailbox });
  }, [mailbox, accountIds]);

  const box =
    fixtureMailboxes.find((m) => m.id === mailbox) ?? fixtureLabels.find((l) => l.id === mailbox);
  const unread = threads.filter((t) => t.unread).length;
  const index = threads.findIndex((t) => t.id === selected);

  const move = (delta: 1 | -1) => {
    if (!threads.length) return;
    const next =
      index < 0
        ? delta === 1
          ? 0
          : threads.length - 1
        : Math.min(Math.max(index + delta, 0), threads.length - 1);
    select(threads[next].id);
  };

  useCommands([
    {
      id: "list.next",
      title: "Next conversation",
      group: "Conversation",
      shortcut: "j",
      run: () => move(1),
    },
    {
      id: "list.previous",
      title: "Previous conversation",
      group: "Conversation",
      shortcut: "k",
      run: () => move(-1),
    },
    {
      id: "search.focus",
      title: "Search mail",
      group: "Navigation",
      shortcut: "/",
      keywords: ["find"],
      run: () => document.getElementById(SEARCH_INPUT_ID)?.focus(),
    },
  ]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const onListKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else return;
    e.preventDefault();
  };

  return (
    <div className="list-pane">
      <div
        className="toolbar toolbar--list"
        data-sidebar-collapsed={collapsed || undefined}
        {...dragRegion}
      >
        {collapsed && (
          <IconButton
            label="Show sidebar"
            shortcut="mod+b"
            icon={<PanelLeftOpen />}
            onClick={toggleSidebar}
          />
        )}
        <h1 className="toolbar__title" {...dragRegion}>
          {box?.name ?? "Mail"}
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

      <div
        ref={listRef}
        className="list-pane__scroll"
        role="listbox"
        aria-label={`${box?.name ?? "Mail"} conversations`}
        tabIndex={0}
        onKeyDown={onListKeyDown}
      >
        {threads.length === 0 ? (
          <div className="pane-empty">
            <p className="pane-empty__title">No conversations in {box?.name ?? "this mailbox"}</p>
          </div>
        ) : (
          threads.map((t) => {
            const sender = senderOf(t);
            return (
              <ListRow
                key={t.id}
                selected={t.id === selected}
                unread={t.unread}
                leading={<Avatar name={sender} email={t.fromAddress ?? undefined} />}
                title={t.messageCount > 1 ? `${sender} (${t.messageCount})` : sender}
                meta={
                  <>
                    {t.hasAttachment && (
                      <Paperclip aria-label="Has attachment" className="list-pane__glyph" />
                    )}
                    {t.starred && (
                      <Star
                        aria-label="Starred"
                        className="list-pane__glyph list-pane__glyph--star"
                      />
                    )}
                    {t.date > 0 && (
                      <time dateTime={new Date(t.date).toISOString()}>
                        {formatListDate(t.date)}
                      </time>
                    )}
                  </>
                }
                subtitle={t.subject ?? "(no subject)"}
                description={t.snippet}
                onClick={() => select(t.id)}
                onContextMenu={(e) => {
                  select(t.id);
                  openContextMenuFromEvent(e, rowMenu(t));
                }}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
