/**
 * Fixture data for browser preview mode and the shell's placeholder panes.
 * Shapes follow the SQLite rows in src-tauri/src/db/ closely enough that the
 * Phase 6 mail UI can swap these for real queries without reshaping its props.
 */

export interface FixtureAccount {
  id: string;
  email: string;
  displayName: string;
}

export interface FixtureMailbox {
  id: string;
  name: string;
  /** lucide icon name, resolved by the sidebar. */
  icon: "inbox" | "star" | "send" | "file" | "archive" | "alert" | "trash";
  unread: number;
  /** Gmail-style `g` chord key for "go to". */
  goKey?: string;
}

export interface FixtureLabel {
  id: string;
  name: string;
  unread: number;
}

export interface FixtureThread {
  id: string;
  accountId: string;
  mailbox: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  snippet: string;
  body: string;
  date: number;
  unread: boolean;
  starred: boolean;
  hasAttachment: boolean;
  messageCount: number;
}

const NOW = Date.now();
const minutesAgo = (m: number) => NOW - m * 60_000;

export const fixtureAccounts: FixtureAccount[] = [
  { id: "acc-personal", email: "alex@genovezos.dev", displayName: "Alex Genovezos" },
  { id: "acc-work", email: "alex@pheeme.app", displayName: "Alex (Pheeme)" },
];

export const fixtureMailboxes: FixtureMailbox[] = [
  { id: "INBOX", name: "Inbox", icon: "inbox", unread: 4, goKey: "i" },
  { id: "STARRED", name: "Starred", icon: "star", unread: 0, goKey: "s" },
  { id: "SENT", name: "Sent", icon: "send", unread: 0, goKey: "t" },
  { id: "DRAFT", name: "Drafts", icon: "file", unread: 1, goKey: "d" },
  { id: "ALL", name: "All Mail", icon: "archive", unread: 0, goKey: "a" },
  { id: "SPAM", name: "Spam", icon: "alert", unread: 0 },
  { id: "TRASH", name: "Trash", icon: "trash", unread: 0 },
];

export const fixtureLabels: FixtureLabel[] = [
  { id: "Label_1", name: "Receipts", unread: 0 },
  { id: "Label_2", name: "Travel", unread: 1 },
  { id: "Label_3", name: "Pheeme", unread: 2 },
];

const thread = (t: Omit<FixtureThread, "accountId" | "mailbox" | "messageCount"> & Partial<FixtureThread>): FixtureThread => ({
  accountId: "acc-personal",
  mailbox: "INBOX",
  messageCount: 1,
  ...t,
});

export const fixtureThreads: FixtureThread[] = [
  thread({
    id: "t-01",
    fromName: "Mira Okafor",
    fromAddress: "mira@northlight.studio",
    subject: "Icon sketches for the dock",
    snippet: "Three directions attached. The folded-letter one reads best at 16 px, the trumpet is fun but busy.",
    body: "Hi Alex,\n\nThree directions attached. The folded-letter one reads best at 16 px; the trumpet is fun but gets busy below 32 px. The third is a plain monogram if you want something quieter.\n\nI can turn the favourite into a full macOS and Windows set by Friday.\n\nMira",
    date: minutesAgo(12),
    unread: true,
    starred: false,
    hasAttachment: true,
    messageCount: 3,
  }),
  thread({
    id: "t-02",
    fromName: "GitHub",
    fromAddress: "notifications@github.com",
    subject: "[pheeme] CI passed on feat/app-shell",
    snippet: "All checks have passed: typecheck, lint, test, macOS bundle.",
    body: "All checks have passed on feat/app-shell.\n\n- typecheck\n- lint\n- test\n- macOS bundle\n\nView the run on GitHub.",
    date: minutesAgo(47),
    unread: true,
    starred: false,
    hasAttachment: false,
  }),
  thread({
    id: "t-03",
    fromName: "Jonas Weber",
    fromAddress: "jonas.weber@posteo.de",
    subject: "Re: Lisbon in March?",
    snippet: "Flights are cheap the week of the 9th. I can book the flat if you confirm by Sunday.",
    body: "Flights are cheap the week of the 9th. I can book the flat near Príncipe Real if you confirm by Sunday.\n\nJonas",
    date: minutesAgo(130),
    unread: true,
    starred: true,
    hasAttachment: false,
    messageCount: 6,
  }),
  thread({
    id: "t-04",
    fromName: "Tessellate Bank",
    fromAddress: "statements@tessellate.example",
    subject: "Your October statement is ready",
    snippet: "Your statement for the period ending 31 October is now available to view.",
    body: "Your statement for the period ending 31 October is now available in online banking.",
    date: minutesAgo(60 * 5),
    unread: false,
    starred: false,
    hasAttachment: true,
  }),
  thread({
    id: "t-05",
    fromName: "Priya Raman",
    fromAddress: "priya@fieldnotes.io",
    subject: "Keyboard map feedback",
    snippet: "j/k feels right. I kept reaching for e to archive in the thread view, so that should work there too.",
    body: "j/k feels right. I kept reaching for e to archive while reading a thread, so that should work there too, not just in the list.\n\nAlso: g then i to jump to the inbox is muscle memory from Gmail. Please keep it.\n\nPriya",
    date: minutesAgo(60 * 9),
    unread: true,
    starred: false,
    hasAttachment: false,
    messageCount: 2,
  }),
  thread({
    id: "t-06",
    fromName: "Hetzner Online",
    fromAddress: "billing@hetzner.example",
    subject: "Invoice R0042817",
    snippet: "Your invoice for November is attached. The amount will be debited on the 5th.",
    body: "Your invoice for November is attached. The amount will be debited on the 5th.",
    date: minutesAgo(60 * 26),
    unread: false,
    starred: false,
    hasAttachment: true,
  }),
  thread({
    id: "t-07",
    fromName: "Sam Lindqvist",
    fromAddress: "sam@lindqvist.se",
    subject: "Photos from Saturday",
    snippet: "Finally went through them. A few of the harbour ones came out really well.",
    body: "Finally went through them. A few of the harbour ones came out really well; the shared album has all 84.\n\nSam",
    date: minutesAgo(60 * 50),
    unread: false,
    starred: true,
    hasAttachment: false,
  }),
  thread({
    id: "t-08",
    fromName: "Google Cloud",
    fromAddress: "cloud-noreply@google.com",
    subject: "OAuth consent screen verification",
    snippet: "Your app is in testing mode. Up to 100 test users can sign in without verification.",
    body: "Your app is in testing mode. Up to 100 test users can sign in without verification. Refresh tokens for apps in testing expire after 7 days.",
    date: minutesAgo(60 * 74),
    unread: false,
    starred: false,
    hasAttachment: false,
  }),
  thread({
    id: "t-09",
    fromName: "Ana Ribeiro",
    fromAddress: "ana@ribeiro.pt",
    subject: "Dinner list",
    snippet: "Adding you to the Thursday list. Bring the good olive oil if you still have it.",
    body: "Adding you to the Thursday list. Bring the good olive oil if you still have it.\n\nAna",
    date: minutesAgo(60 * 24 * 4),
    unread: false,
    starred: false,
    hasAttachment: false,
  }),
  thread({
    id: "t-10",
    fromName: "Alex Genovezos",
    fromAddress: "alex@genovezos.dev",
    mailbox: "SENT",
    subject: "Re: Icon sketches for the dock",
    snippet: "Folded letter, please. Can it hold up in the menu bar at 16 px?",
    body: "Folded letter, please. Can it hold up in the menu bar at 16 px?",
    date: minutesAgo(5),
    unread: false,
    starred: false,
    hasAttachment: false,
  }),
  thread({
    id: "t-11",
    fromName: "Alex Genovezos",
    fromAddress: "alex@genovezos.dev",
    mailbox: "DRAFT",
    subject: "Release notes 0.2",
    snippet: "Light and dark themes, a command palette, and every action on the keyboard.",
    body: "Light and dark themes, a command palette, and every action on the keyboard.",
    date: minutesAgo(90),
    unread: true,
    starred: false,
    hasAttachment: false,
  }),
];

export const fixtureThreadsIn = (mailbox: string): FixtureThread[] => {
  if (mailbox === "ALL") return fixtureThreads;
  if (mailbox === "STARRED") return fixtureThreads.filter((t) => t.starred);
  return fixtureThreads.filter((t) => t.mailbox === mailbox);
};
