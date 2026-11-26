import {
  archiveSlotAction,
  closeConversation,
  composeNew,
  findSimilar,
  labelMenuAnchor,
  openFocused,
  openLabelMenu,
  openMoveMenu,
  respond,
  setImportant,
  setRead,
  toggleStar,
  trash,
} from "../mail/actions";
import { openCreateLabel } from "../labels/create";
import { COPY_CODE_COMMAND, COPY_CODE_SHORTCUT, copyOpenConversationCode } from "../mail/CodeCard";
import { PRINT_COMMAND, printOpenConversation } from "../mail/print";
import { UNSUBSCRIBE_COMMAND, unsubscribeOpenConversation } from "../mail/unsubscribe";
import {
  CREATE_EVENT_COMMAND,
  CREATE_EVENT_SHORTCUT,
  createEventFromEmail,
} from "../calendar/mailActions";
import { useSetupGuide } from "../onboarding/guideStore";
import {
  ALL_INBOXES,
  CATEGORIES,
  categoryMailbox,
  FAVORITES,
  homeMailbox,
  resolveActiveAccount,
} from "../mail/mailboxes";
import { mailboxInAccount, nextInbox } from "../shell/sidebar/accountSwitch";
import { usePaletteStore } from "../palette/paletteStore";
import { useSettingsStore } from "../settings/settingsStore";
import { speedReadOpenConversation } from "../speedread/open";
import { useStatsStore } from "../stats/statsStore";
import { useAccountStore } from "../store/accountStore";
import { useInboxTabs, visibleCategories } from "../store/inboxTabsStore";
import { useUiStore } from "../store/uiStore";
import { useThemeStore } from "../theme/theme";
import { type AppMode, useCalendarStore } from "../calendar/calendarStore";
import { TOGGLE_TASKS_COMMAND, TOGGLE_TASKS_SHORTCUT, useTasksStore } from "../tasks/tasksStore";
import type { Command } from "./registry";
import { useCommands } from "./useCommands";
import { DEFAULT_KEYS } from "./defaultKeys";

/** App-wide commands. Pane-specific ones (j/k, search, selection) register in their panes. */
export function appCommands(): Command[] {
  const theme = () => useThemeStore.getState();
  const ui = () => useUiStore.getState();
  const accounts = () => useAccountStore.getState().accounts;
  // Favorites and categories open in the account the sidebar is showing them for.
  const activeAccount = () => resolveActiveAccount(ui().activeAccountId, accounts());
  return [
    {
      id: "palette.toggle",
      title: "Show all commands",
      group: "General",
      shortcut: DEFAULT_KEYS["palette.toggle"],
      global: true,
      hidden: true,
      run: () => usePaletteStore.getState().toggle(),
    },
    {
      id: "settings.open",
      title: "Open settings",
      group: "General",
      shortcut: "mod+,",
      keywords: ["preferences", "options"],
      global: true,
      run: () => useSettingsStore.getState().openSettings(),
    },
    {
      id: "stats.open",
      title: "Mail stats",
      group: "View",
      keywords: ["statistics", "insights", "senders", "unsubscribe", "how much mail"],
      run: () => useStatsStore.getState().openStats(),
    },
    {
      id: "settings.keyboard",
      title: "Keyboard shortcuts",
      group: "General",
      keywords: ["keybindings", "hotkeys", "settings"],
      run: () => useSettingsStore.getState().openSettings("keyboard"),
    },
    {
      id: "settings.accounts",
      title: "Manage accounts",
      group: "General",
      keywords: ["settings", "add account", "remove account", "sign out"],
      run: () => useSettingsStore.getState().openSettings("accounts"),
    },
    {
      id: "help.setupGuide",
      title: "Open setup guide",
      group: "General",
      keywords: ["tutorial", "google cloud", "help", "setup", "onboarding"],
      run: () => useSetupGuide.getState().open(),
    },
    {
      id: "compose.new",
      title: "New message",
      group: "General",
      shortcut: DEFAULT_KEYS["compose.new"],
      keywords: ["compose", "write", "email"],
      run: composeNew,
    },
    {
      id: "go.inbox",
      title: "Go to Inbox",
      group: "Navigation",
      shortcut: "g i",
      keywords: ["all inboxes"],
      run: () => ui().setMailbox(homeMailbox(accounts())),
    },
    ...([1, -1] as const).map<Command>((by) => ({
      id: by === 1 ? "go.next-inbox" : "go.previous-inbox",
      title: by === 1 ? "Next account's inbox" : "Previous account's inbox",
      group: "Navigation",
      shortcut: DEFAULT_KEYS[by === 1 ? "go.next-inbox" : "go.previous-inbox"],
      keywords: ["account", "switch", "all inboxes", "cycle"],
      global: true,
      // All Inboxes, then each account in order, keeping the same Inbox tab or favorite where it can.
      run: () => {
        const { mailbox, setMailbox } = ui();
        const ids = accounts().map((a) => a.id);
        const next = nextInbox(mailbox.accountId, ids, by);
        if (next === mailbox.accountId) return;
        if (next === null) return setMailbox(ALL_INBOXES);
        const tabs = visibleCategories(next).map((c) => c.labelId);
        setMailbox(mailboxInAccount(mailbox, next, tabs));
      },
    })),
    ...CATEGORIES.map<Command>((c) => ({
      id: `go.category.${c.name.toLowerCase()}`,
      title: `Go to ${c.name}`,
      group: "Navigation",
      keywords: ["inbox", "category"],
      run: () => {
        const id = activeAccount();
        if (!id) return;
        const hidden = useInboxTabs.getState().hidden[id]?.includes(c.labelId);
        ui().setMailbox(categoryMailbox(id, hidden ? CATEGORIES[0].labelId : c.labelId));
      },
    })),
    ...FAVORITES.map<Command>((f) => ({
      id: `go.${f.labelId.toLowerCase()}`,
      title: `Go to ${f.name}`,
      group: "Navigation",
      shortcut: f.goKey ? `g ${f.goKey}` : undefined,
      run: () => {
        const id = activeAccount();
        if (id) ui().setMailbox({ accountId: id, labelId: f.labelId });
      },
    })),
    {
      id: "conversation.archive",
      title: "Archive",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.archive"],
      // In Spam and Trash it moves mail back to the inbox.
      keywords: ["not spam", "move to inbox", "restore", "untrash"],
      run: () => void archiveSlotAction(),
    },
    {
      id: "conversation.delete",
      title: "Delete",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.delete"],
      keywords: ["trash"],
      run: () => void trash(),
    },
    {
      id: "conversation.star",
      title: "Star or unstar",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.star"],
      run: () => void toggleStar(),
    },
    {
      id: "conversation.mark-unread",
      title: "Mark as unread",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.mark-unread"],
      run: () => void setRead(false),
    },
    {
      id: "conversation.mark-read",
      title: "Mark as read",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.mark-read"],
      run: () => void setRead(true),
    },
    {
      id: "conversation.mark-important",
      title: "Mark as important",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.mark-important"],
      run: () => void setImportant(true),
    },
    {
      // Gmail takes `=` as well as `+` (the same key without Shift), so both mark important.
      id: "conversation.mark-important-alt",
      title: "Mark as important (alternate key)",
      group: "Conversation",
      shortcut: "=",
      hidden: true,
      run: () => void setImportant(true),
    },
    {
      id: "conversation.mark-not-important",
      title: "Mark as not important",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.mark-not-important"],
      run: () => void setImportant(false),
    },
    {
      id: "conversation.labels",
      title: "Label as…",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.labels"],
      keywords: ["tag"],
      run: () => void openLabelMenu(labelMenuAnchor()),
    },
    {
      id: "conversation.move",
      title: "Move to…",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.move"],
      keywords: ["folder", "label"],
      run: () => openMoveMenu(labelMenuAnchor()),
    },
    {
      id: "conversation.find-same-sender",
      title: "Find emails from this sender",
      group: "Conversation",
      keywords: ["similar", "filter", "search"],
      run: () => void findSimilar("sender"),
    },
    {
      id: "conversation.find-same-subject",
      title: "Find emails with this subject",
      group: "Conversation",
      keywords: ["similar", "filter", "search"],
      run: () => void findSimilar("subject"),
    },
    {
      id: "labels.create",
      title: "Create label…",
      group: "Labels",
      keywords: ["new label", "tag"],
      run: () => openCreateLabel(),
    },
    {
      id: "conversation.open",
      title: "Open conversation",
      group: "Conversation",
      shortcut: "o",
      run: openFocused,
    },
    {
      id: "conversation.close",
      title: "Close conversation",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.close"],
      run: closeConversation,
    },
    {
      id: "conversation.reply",
      title: "Reply",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.reply"],
      run: () => void respond("reply"),
    },
    {
      id: "conversation.reply-all",
      title: "Reply all",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.reply-all"],
      run: () => void respond("replyAll"),
    },
    {
      id: "conversation.forward",
      title: "Forward",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.forward"],
      run: () => void respond("forward"),
    },
    {
      id: "conversation.speed-read",
      title: "Speed read",
      group: "Conversation",
      shortcut: DEFAULT_KEYS["conversation.speed-read"],
      keywords: ["rsvp", "fast", "reader", "words per minute"],
      run: speedReadOpenConversation,
    },
    {
      id: PRINT_COMMAND,
      title: "Print",
      group: "Conversation",
      shortcut: DEFAULT_KEYS[PRINT_COMMAND],
      keywords: ["paper", "pdf", "printer"],
      run: () => void printOpenConversation(),
    },
    {
      id: UNSUBSCRIBE_COMMAND,
      title: "Unsubscribe from sender…",
      group: "Conversation",
      keywords: ["mailing list", "newsletter", "stop emails", "opt out"],
      run: () => void unsubscribeOpenConversation(),
    },
    {
      id: COPY_CODE_COMMAND,
      title: "Copy verification code",
      group: "Conversation",
      shortcut: COPY_CODE_SHORTCUT,
      keywords: ["otp", "2fa", "login code", "one-time", "passcode"],
      run: copyOpenConversationCode,
    },
    {
      id: CREATE_EVENT_COMMAND,
      title: "Create event from email",
      group: "Conversation",
      shortcut: CREATE_EVENT_SHORTCUT,
      keywords: ["calendar", "meeting", "schedule", "new event", "add to calendar"],
      run: () => void createEventFromEmail(),
    },
    {
      id: "view.toggleSidebar",
      title: "Toggle sidebar",
      group: "View",
      shortcut: DEFAULT_KEYS["view.toggleSidebar"],
      keywords: ["hide", "show", "panel"],
      run: () => ui().toggleSidebar(),
    },
    {
      id: TOGGLE_TASKS_COMMAND,
      title: "Show or hide Tasks",
      group: "View",
      shortcut: TOGGLE_TASKS_SHORTCUT,
      keywords: ["tasks", "to-do", "todo", "panel", "google tasks"],
      global: true,
      run: () => useTasksStore.getState().togglePanel(),
    },
    {
      id: "theme.toggle",
      title: "Toggle light and dark theme",
      group: "Appearance",
      shortcut: "mod+shift+l",
      keywords: ["theme", "dark mode", "light mode", "appearance"],
      run: () => theme().toggle(),
    },
    {
      id: "theme.system",
      title: "Theme: Match system",
      group: "Appearance",
      keywords: ["auto", "os"],
      run: () => theme().setMode("system"),
    },
    {
      id: "theme.light",
      title: "Theme: Light",
      group: "Appearance",
      run: () => theme().setMode("light"),
    },
    {
      id: "theme.dark",
      title: "Theme: Dark",
      group: "Appearance",
      run: () => theme().setMode("dark"),
    },
  ];
}

/** The mode switch, in both modes. */
function modeCommands(): Command[] {
  const setMode = (mode: AppMode) => useCalendarStore.getState().setMode(mode);
  return [
    {
      id: "mode.mail",
      title: "Go to Mail",
      group: "Navigation",
      shortcut: DEFAULT_KEYS["mode.mail"],
      keywords: ["inbox", "email", "switch"],
      global: true,
      run: () => setMode("mail"),
    },
    {
      id: "mode.calendar",
      title: "Go to Calendar",
      group: "Navigation",
      shortcut: DEFAULT_KEYS["mode.calendar"],
      keywords: ["events", "schedule", "switch"],
      global: true,
      run: () => setMode("calendar"),
    },
  ];
}

/**
 * The app commands for `mode`. Calendar has its own single keys (d, w, m, t, j, k, g), so there the
 * conversation and mailbox commands are left out (a saved binding such as `g i` would otherwise
 * swallow `g`), and New message keeps its palette entry without its key.
 */
export function commandsForMode(commands: Command[], mode: AppMode): Command[] {
  if (mode === "mail") return [...commands, ...modeCommands()];
  const mailOnly = (c: Command) =>
    c.id.startsWith("conversation.") || c.id.startsWith("go.") || c.id === COPY_CODE_COMMAND;
  return [
    ...commands.flatMap<Command>((c) => {
      if (mailOnly(c)) return [];
      if (c.id === "compose.new") return [{ ...c, shortcut: undefined }];
      return [c];
    }),
    ...modeCommands(),
  ];
}

export function useAppCommands() {
  const mode = useCalendarStore((s) => s.mode);
  useCommands(commandsForMode(appCommands(), mode));
}
