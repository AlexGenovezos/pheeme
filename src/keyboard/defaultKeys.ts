/**
 * The default key of each command a label is drawn for. The command definitions and the labels both
 * read it, so a default is written once; it is a leaf module so a label can use it without pulling
 * in the commands' actions. `registry.shortcutFor` falls back to it while a command isn't
 * registered (tests, the first frame).
 */
export const DEFAULT_KEYS = {
  "palette.toggle": "mod+k",
  "compose.new": "c",
  "view.toggleSidebar": "mod+b",
  "mode.mail": "mod+1",
  "mode.calendar": "mod+2",
  "go.next-inbox": "ctrl+tab",
  "go.previous-inbox": "ctrl+shift+tab",
  "list.next": "j",
  "list.previous": "k",
  "search.focus": "/",
  "conversation.archive": "e",
  "conversation.delete": "#",
  "conversation.star": "s",
  "conversation.mark-read": "shift+i",
  "conversation.mark-unread": "shift+u",
  "conversation.labels": "l",
  "conversation.move": "v",
  "conversation.close": "u",
  "conversation.reply": "r",
  "conversation.reply-all": "a",
  "conversation.forward": "f",
  "conversation.speed-read": "shift+r",
  "calendar.today": "t",
  "calendar.next": "j",
  "calendar.previous": "k",
  "calendar.create": "c",
  "calendar.edit": "e",
  "calendar.delete": "delete",
  "calendar.join": "shift+j",
  "calendar.search": "/",
  "plan.today": "t",
  "plan.tomorrow": "m",
  "plan.pickDay": "p",
  "plan.book": "b",
  "plan.done": "d",
  "plan.drop": "x",
} as const;

/** The default key for `id`, when it has one. */
export function defaultKeyFor(id: string): string | undefined {
  return (DEFAULT_KEYS as Record<string, string>)[id];
}
