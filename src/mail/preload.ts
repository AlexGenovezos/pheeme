// Keep the conversations the reader is about to open loaded, so arrowing through a list never waits: the first rows
// of the list shown, a window ahead of the open one while navigating, and the first rows of Inbox and each category
// so switching is instant too (docs/superpowers/specs/2026-11-06-preload-ahead-design.md). Read-only: nothing here
// marks mail read.
import { listThreads, type ThreadSummary } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { useMailStore } from "../store/mailStore";
import { useThreadStore } from "../store/threadStore";
import { useInboxTabs, visibleCategories } from "../store/inboxTabsStore";
import { useUiStore } from "../store/uiStore";
import {
  categoryMailbox,
  type MailboxRef,
  queryFor,
  resolveActiveAccount,
  threadKey,
  type ThreadKey,
} from "./mailboxes";
import { startImagePreloading } from "./preloadImages";

/** Rows preloaded when a list is shown, and per category. */
const FIRST = 20;
/** Around the open row: 3.2 s of runway at five arrows a second, and a few rows for turning back. */
const AHEAD = 16;
const BEHIND = 4;

let direction: 1 | -1 = 1;
/** j / k and the arrows say which way the reader is going; the window leans that way. */
export const setTravelDirection = (to: 1 | -1) => {
  direction = to;
};

const keyOf = (t: ThreadSummary) => threadKey(t.accountId, t.id);

/** The shown list's rows to preload: around the open one, else the first. None while the list is being replaced. */
function listWindow(): ThreadKey[] {
  const { threads, loading, query, loadedQuery } = useMailStore.getState();
  if (loading || JSON.stringify(query) !== JSON.stringify(loadedQuery)) return [];
  const keys = threads.map(keyOf);
  const open = useUiStore.getState().openThread;
  const at = open ? keys.indexOf(open) : -1;
  if (at < 0) return keys.slice(0, FIRST);
  const near = (step: number, count: number) =>
    Array.from({ length: count }, (_, i) => keys[at + step * (i + 1)]);
  return [...near(direction, AHEAD), ...near(-direction, BEHIND)].filter(
    (k): k is ThreadKey => k !== undefined,
  );
}

/** Preload for as long as the mail screen is up. Returns the stop function. */
export function startPreloading(): () => void {
  const images = startImagePreloading();
  let categories: ThreadKey[] = [];
  let categoryScope = "";
  let published = "";
  let stopped = false;

  const publish = () => {
    const keys = [...new Set([...listWindow(), ...categories])];
    if (keys.join() === published) return;
    published = keys.join();
    useThreadStore.getState().prefetch(keys);
    images.update(keys);
  };

  /** The first rows of Inbox and each category of the active account, with Unread only as the list has it. */
  const loadCategories = async () => {
    const ui = useUiStore.getState();
    const accountId = resolveActiveAccount(ui.activeAccountId, useAccountStore.getState().accounts);
    const hiddenTabs = accountId ? useInboxTabs.getState().hidden[accountId] : null;
    const scope = JSON.stringify([accountId, ui.unreadOnly, hiddenTabs]);
    if (scope === categoryScope) return;
    categoryScope = scope;
    const refs: MailboxRef[] = accountId
      ? [
          { accountId, labelId: "INBOX" },
          ...visibleCategories(accountId).map((c) => categoryMailbox(accountId, c.labelId)),
        ]
      : [];
    const pages = await Promise.all(
      refs.map((ref) =>
        listThreads({
          ...queryFor(ref, [accountId!]),
          unreadOnly: ui.unreadOnly,
          limit: FIRST,
        }).catch(() => null),
      ),
    );
    if (stopped || scope !== categoryScope) return;
    categories = pages.flatMap((page) => page?.threads.map(keyOf) ?? []);
    publish();
  };

  const update = () => {
    void loadCategories();
    publish();
  };
  const unsubscribes = [
    useMailStore.subscribe(update),
    useUiStore.subscribe(update),
    useAccountStore.subscribe(update),
    useInboxTabs.subscribe(update),
  ];
  update();
  return () => {
    stopped = true;
    unsubscribes.forEach((unsubscribe) => unsubscribe());
    images.stop();
    useThreadStore.getState().prefetch([]);
  };
}
