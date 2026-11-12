import type {
  DayStats,
  InboxTab,
  MailCounts,
  MailStats,
  PlaceStats,
  SenderStats,
  UnsubscribeKind,
  Unsubscribed,
} from "../lib/tauri";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The same small "random" wobble for the same day and seed, so the page doesn't jump. */
function wobble(day: number, seed: number, spread: number) {
  const x = Math.sin(day * 12.9898 + seed * 78.233) * 43758.5453;
  return Math.floor((x - Math.floor(x)) * spread);
}

const counts = (received: number, openShare: number, replied = 0, starred = 0): MailCounts => {
  const opened = Math.round(received * openShare);
  return { received, opened, replied, starred, engaged: Math.min(received, opened + replied) };
};

const sum = (all: MailCounts[]): MailCounts =>
  all.reduce(
    (a, c) => ({
      received: a.received + c.received,
      opened: a.opened + c.opened,
      replied: a.replied + c.replied,
      starred: a.starred + c.starred,
      engaged: a.engaged + c.engaged,
    }),
    { received: 0, opened: 0, replied: 0, starred: 0, engaged: 0 },
  );

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Per day: how much each inbox tab gets, and how much of it is opened. */
const TAB_MIX: { id: InboxTab; name: string; perDay: number; open: number }[] = [
  { id: "primary", name: "Primary", perDay: 9, open: 0.85 },
  { id: "promotions", name: "Promotions", perDay: 19, open: 0.06 },
  { id: "social", name: "Social", perDay: 8, open: 0.12 },
  { id: "updates", name: "Updates", perDay: 24, open: 0.41 },
  { id: "forums", name: "Forums", perDay: 2, open: 0.3 },
  { id: "spam", name: "Spam", perDay: 1, open: 0 },
];

const SENDERS: {
  sender: string;
  name: string | null;
  tab: InboxTab;
  perWeek: number;
  open: number;
  replied: number;
  unsubscribe: UnsubscribeKind;
}[] = [
  {
    sender: "notifications@github.com",
    name: "GitHub",
    tab: "updates",
    perWeek: 40,
    open: 0.71,
    replied: 0,
    unsubscribe: "one_click",
  },
  {
    sender: "deals@bestbuy.com",
    name: "Best Buy",
    tab: "promotions",
    perWeek: 21,
    open: 0,
    replied: 0,
    unsubscribe: "one_click",
  },
  {
    sender: "notifications@linkedin.com",
    name: "LinkedIn",
    tab: "social",
    perWeek: 18,
    open: 0.03,
    replied: 0,
    unsubscribe: "link",
  },
  {
    sender: "news@substack.com",
    name: "The Weekly Byte",
    tab: "promotions",
    perWeek: 7,
    open: 0.4,
    replied: 0,
    unsubscribe: "email",
  },
  {
    sender: "no-reply@chase.com",
    name: "Chase",
    tab: "updates",
    perWeek: 5,
    open: 0.8,
    replied: 0,
    unsubscribe: "none",
  },
  {
    sender: "sam@rivera.co",
    name: "Sam Rivera",
    tab: "primary",
    perWeek: 4,
    open: 1,
    replied: 0.75,
    unsubscribe: "none",
  },
  {
    sender: "hello@figma.com",
    name: "Figma",
    tab: "updates",
    perWeek: 3,
    open: 0.2,
    replied: 0,
    unsubscribe: "unknown",
  },
];

/** Plausible stats for browser preview: a weekday rhythm, lots of unread promotions. */
export function previewMailStats(
  accountId: string | null,
  sinceMs: number,
  now = Date.now(),
): MailStats {
  const scale = accountId === null ? 1 : accountId === "acc-personal" ? 0.7 : 0.3;
  const days: DayStats[] = [];
  const tabs = TAB_MIX.map(() => [] as MailCounts[]);
  for (let t = sinceMs; t <= now; t += DAY_MS) {
    const date = new Date(t);
    const n = Math.floor(t / DAY_MS);
    const weekend = date.getDay() === 0 || date.getDay() === 6 ? 0.45 : 1;
    const perTab = TAB_MIX.map((tab, i) => {
      const received = Math.round((tab.perDay * weekend + wobble(n, i, 6) - 2) * scale);
      return counts(Math.max(0, received), tab.open, tab.id === "primary" ? wobble(n, 9, 3) : 0);
    });
    perTab.forEach((c, i) => tabs[i].push(c));
    days.push({ day: dayKey(date), ...sum(perTab) });
  }
  const weeks = days.length / 7;
  const tabStats: PlaceStats[] = TAB_MIX.map((tab, i) => ({
    id: tab.id,
    name: tab.name,
    ...sum(tabs[i]),
  }));
  const labels: PlaceStats[] = [
    { id: "Receipts", name: "Receipts", ...counts(Math.round(3 * days.length * scale), 0.9) },
    {
      id: "Work/Projects",
      name: "Work/Projects",
      ...counts(Math.round(2 * days.length * scale), 0.95, 4, 2),
    },
  ];
  const senders: SenderStats[] = SENDERS.map((s, i) => {
    const received = Math.max(1, Math.round(s.perWeek * weeks * scale));
    return {
      accountId: accountId ?? "acc-personal",
      threadId: `stats-thread-${i}`,
      messageId: `stats-message-${i}`,
      sender: s.sender,
      name: s.name,
      tab: s.tab,
      unsubscribe: s.unsubscribe,
      lastDate: now - i * 3_600_000,
      ...counts(received, s.open, Math.round(received * s.replied)),
    };
  });
  return {
    since: sinceMs,
    complete: true,
    totals: sum(days),
    days,
    tabs: tabStats,
    labels,
    senders,
  };
}

/** What unsubscribing from a preview sender does, by the kind its fixture offers. */
export function previewUnsubscribe(threadId: string): Unsubscribed {
  const s = SENDERS[Number(threadId.replace("stats-thread-", ""))];
  if (!s || s.unsubscribe === "none") {
    return {
      sender: s?.sender ?? null,
      method: "none",
      unsubscribed: false,
      web: null,
      mailto: null,
    };
  }
  if (s.unsubscribe === "link") {
    return {
      sender: s.sender,
      method: "link",
      unsubscribed: false,
      web: "https://example.com/unsubscribe",
      mailto: null,
    };
  }
  if (s.unsubscribe === "email") {
    return {
      sender: s.sender,
      method: "email",
      unsubscribed: false,
      web: null,
      mailto: "mailto:leave@substack.com?subject=unsubscribe",
    };
  }
  return { sender: s.sender, method: "one_click", unsubscribed: true, web: null, mailto: null };
}
