import { THEME_TOKENS, type ThemeToken } from "../../styles/themes/schema";

/** Advanced mode's sections, in the order schema.ts lists the tokens. */
const GROUPS: { title: string; test: RegExp }[] = [
  { title: "Surfaces", test: /^--color-(app|pane|sidebar|titlebar|border)/ },
  { title: "Text", test: /^--color-(foreground|link|selection)/ },
  { title: "Accent and focus", test: /^--color-(accent|focus|unread)/ },
  { title: "Controls", test: /^--color-(button|control|input)/ },
  { title: "Lists", test: /^--color-list/ },
  { title: "Badges and keys", test: /^--color-(badge|kbd)/ },
  { title: "Menus, palette and toasts", test: /^--color-(menu|palette|toast|scrim|shadow)/ },
  { title: "Status", test: /^--color-(danger|warning|success|info)$/ },
  { title: "Scrollbars and loading", test: /^--color-(scrollbar|skeleton)/ },
  { title: "Avatars", test: /^--color-avatar/ },
  { title: "Accounts", test: /^--color-account/ },
  { title: "Mailboxes", test: /^--color-mailbox/ },
];

const WORDS: Record<string, string> = {
  bg: "background",
  kbd: "key",
  allmail: "All Mail",
  vibrant: "(macOS see-through)",
};

/** `--color-list-active-bg` → "List active background". */
export function tokenLabel(token: ThemeToken): string {
  const words = token
    .replace(/^--color-/, "")
    .split("-")
    .map((w) => WORDS[w] ?? w);
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface TokenGroup {
  title: string;
  tokens: ThemeToken[];
}

export const TOKEN_GROUPS: TokenGroup[] = (() => {
  const colors = (Object.keys(THEME_TOKENS) as ThemeToken[]).filter((t) =>
    t.startsWith("--color-"),
  );
  // Each token in the first group that claims it.
  const groupOf = (t: ThemeToken) => GROUPS.findIndex(({ test }) => test.test(t));
  const groups = GROUPS.map(({ title }, i) => ({
    title,
    tokens: colors.filter((t) => groupOf(t) === i),
  }));
  const rest = colors.filter((t) => groupOf(t) === -1);
  return rest.length ? [...groups, { title: "Other", tokens: rest }] : groups;
})();
