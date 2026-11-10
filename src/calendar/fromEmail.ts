// Create event from email, the parts with no React in them: the title from the subject, guests from
// the thread, a description that links back to the conversation, and a time read from the email's
// words with chrono-node ("Thursday at 3", "Nov 12 2–3pm"), relative to when the email was sent.
import * as chrono from "chrono-node";
import type { MessageDetail, ThreadDetail } from "../lib/tauri";
import { addDays, wallClock, zonedMs } from "./dates";
import { type EventForm, type Guest, newForm, plainText } from "./eventForm";

/** How much of the email is searched for a date, and quoted in the description. */
const SCAN_CHARS = 2000;
const QUOTE_CHARS = 500;

/** The subject without its `Re:`/`Fwd:` prefixes (and the "[2]"-style counters some clients add). */
export function cleanSubject(subject: string | null): string {
  let s = (subject ?? "").trim();
  const prefix = /^(?:re|fwd?|fw|aw|wg|sv|vs|tr)\s*(?:\[\d+\])?\s*:\s*/i;
  while (prefix.test(s)) s = s.replace(prefix, "");
  return s;
}

/** Everyone on the thread (senders, To and Cc) except the user, in the order they first appear. */
export function threadGuests(messages: MessageDetail[], self: string[]): Guest[] {
  const mine = new Set(self.map((a) => a.toLowerCase()));
  const seen = new Set<string>();
  const out: Guest[] = [];
  const add = (address: string | null, name: string | null) => {
    const key = address?.trim().toLowerCase();
    if (!key || !key.includes("@") || mine.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push({ address: address!.trim(), name: name?.trim() || null, optional: false });
  };
  for (const m of messages) {
    add(m.fromAddress, m.fromName);
    for (const a of [...m.to, ...m.cc]) add(a.address, a.name);
  }
  return out;
}

/** The conversation in Gmail on the web, signed in as `email`. */
export const gmailLink = (email: string, threadId: string) =>
  `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#all/${encodeURIComponent(threadId)}`;

/** The message's words: its plain text, else its HTML as text, else Gmail's snippet. */
export function messageText(m: MessageDetail): string {
  const text = m.bodyText?.trim() || (m.bodyHtml ? plainText(m.bodyHtml) : "") || m.snippet || "";
  return text.replace(/\r\n/g, "\n");
}

/** The description: a link back to the conversation, then the start of the email. */
export function emailDescription(link: string, text: string): string {
  const quote = text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS).trimEnd()}…` : text;
  return quote ? `${link}\n\n${quote}` : link;
}

export type FoundTime =
  | { allDay: false; start: number; end: number }
  | { allDay: true; date: string; lastDate: string };

/** `tz`'s offset from UTC at `ms`, in minutes, as chrono-node takes it. */
function offsetMinutes(ms: number, tz: string): number {
  const { date, minutes } = wallClock(ms, tz);
  const [y, m, d] = date.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) + minutes * 60_000 - ms) / 60_000);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The day and, when known, the instant of what chrono read, as wall-clock time in `tz`. */
function read(c: chrono.ParsedComponents, tz: string): { date: string; ms: number } {
  const date = `${c.get("year")}-${pad(c.get("month") ?? 1)}-${pad(c.get("day") ?? 1)}`;
  // A zone in the text ("3pm EST") fixes the instant; otherwise the time is in the calendar's zone.
  if (c.isCertain("timezoneOffset")) return { date, ms: c.date().getTime() };
  return { date, ms: zonedMs(date, (c.get("hour") ?? 0) * 60 + (c.get("minute") ?? 0), tz) };
}

/**
 * A time the text mentions, read as of `sentAt` in `tz`: the first match with a time of day, else the
 * first date (an all-day event). Null when it mentions none.
 */
export function findTime(text: string, sentAt: number, tz: string): FoundTime | null {
  const results = chrono
    .parse(
      text.slice(0, SCAN_CHARS),
      { instant: new Date(sentAt), timezone: offsetMinutes(sentAt, tz) },
      { forwardDate: true },
    )
    // "now" and the like say nothing about when to meet.
    .filter((r) => !/^(now|right now|currently)$/i.test(r.text.trim()));
  const timed = results.find((r) => r.start.isCertain("hour"));
  if (timed) {
    const start = read(timed.start, tz).ms;
    const end =
      timed.end?.isCertain("hour") && read(timed.end, tz).ms > start
        ? read(timed.end, tz).ms
        : start + 60 * 60_000;
    return { allDay: false, start, end };
  }
  const first = results[0];
  if (!first) return null;
  const date = read(first.start, tz).date;
  const last = first.end ? read(first.end, tz).date : date;
  return { allDay: true, date, lastDate: last >= date ? last : date };
}

/** The next half hour from `now` in `tz`, for an hour. */
export function nextHalfHour(now: number, tz: string): { start: number; end: number } {
  const { date, minutes } = wallClock(now, tz);
  const at = Math.ceil((minutes + 1) / 30) * 30;
  const start = at >= 24 * 60 ? zonedMs(addDays(date, 1), 0, tz) : zonedMs(date, at, tz);
  return { start, end: start + 60 * 60_000 };
}

/**
 * The new event for an email: on `calendar`, titled by the subject, with the thread's people, a link
 * back, and the time the email mentions (else the next half hour). `found` says whether one was read.
 */
export function formFromEmail(
  detail: ThreadDetail,
  message: MessageDetail,
  opts: { email: string; accountId: string; calendarId: string; tz: string; now: number },
): { form: EventForm; found: boolean } {
  const text = messageText(message);
  const subject = cleanSubject(message.subject ?? detail.thread.subject);
  const found = findTime(`${subject}\n${text}`, message.date || opts.now, opts.tz);
  const base = {
    accountId: opts.accountId,
    calendarId: opts.calendarId,
    zone: opts.tz,
    summary: subject,
  };
  const form = found?.allDay
    ? newForm({ ...base, allDay: true, startDate: found.date, endDate: found.lastDate })
    : newForm({ ...base, allDay: false, ...(found ?? nextHalfHour(opts.now, opts.tz)) });
  return {
    form: {
      ...form,
      guests: threadGuests(detail.messages, [opts.email]),
      description: emailDescription(gmailLink(opts.email, detail.thread.id), text),
    },
    found: found !== null,
  };
}
