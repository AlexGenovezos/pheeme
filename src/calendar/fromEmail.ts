// Create event from email, the parts with no React in them: the title from the subject, guests from
// the thread, a description with the email's new text (not the quoted thread) and a link back to
// the conversation, and a time read from the email's words with chrono-node ("Thursday at 3",
// "Nov 12 2–3pm"), relative to when the email was sent.
import * as chrono from "chrono-node";
import type { MessageDetail, ThreadDetail } from "../lib/tauri";
import { addDays, wallClock, zonedMs } from "./dates";
import { type EventForm, type Guest, INVISIBLE, newForm, plainText } from "./eventForm";
import { offsetMinutes } from "./zones";

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
  return text
    .replace(INVISIBLE, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\u00A0]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Where a reply's quoted thread (or a signature) begins: Gmail's and Apple Mail's "On … wrote:"
 * (which can wrap), Outlook's "-----Original Message-----" or "From: …" over "Sent:"/"Date:", a
 * block of "> " lines, a "-- " signature line. A forwarded message is the point of a forward, so
 * it stays.
 */
const QUOTE_STARTS = [
  /^On\b[^\n]*(?:\n[^\n]*){0,2}?\bwrote:[ \t]*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^From:[^\n]*\n(?:Sent|Date):/im,
  /^>/m,
  /^-- ?$/m,
];

/** Gmail's and Apple Mail's line above a forwarded message, whose own headers aren't a quote. */
const FORWARDED = /^-+\s*Forwarded message\s*-+|^Begin forwarded message:/im;

/** The new part of a message: without the quoted thread or signature, unless that's all there is. */
export function replyText(text: string): string {
  const forward = text.search(FORWARDED);
  const cut = Math.min(...QUOTE_STARTS.map((re) => text.match(re)?.index ?? text.length));
  if (forward >= 0 && forward < cut) return text.trim();
  return text.slice(0, cut).trim() || text.trim();
}

/** The quoted thread with the lines that only say who wrote when ("On … wrote:", "Sent: …"). */
const withoutAttributions = (text: string) =>
  text
    .replace(new RegExp(QUOTE_STARTS[0].source, "gm"), "")
    .replace(/^>?\s*(?:From|Sent|Date|To|Cc|Subject):.*$/gim, "");

/** The description: the start of the email's new text, then a link back to the conversation. */
export function emailDescription(link: string, text: string): string {
  const quote = text.length > QUOTE_CHARS ? `${cutBetweenWords(text, QUOTE_CHARS)}…` : text;
  const back = `Email in Gmail: ${link}`;
  return quote ? `${quote}\n\n${back}` : back;
}

/** The first `max` characters, ending at a space when there's one near the end. */
function cutBetweenWords(text: string, max: number): string {
  const head = text.slice(0, max);
  const space = head.search(/\s\S*$/);
  return (space > max * 0.8 ? head.slice(0, space) : head).trimEnd();
}

export type FoundTime =
  | { allDay: false; start: number; end: number }
  | { allDay: true; date: string; lastDate: string };

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
  const reply = replyText(text);
  const subject = cleanSubject(message.subject ?? detail.thread.subject);
  const sentAt = message.date || opts.now;
  // The new text first; the quoted thread only when it names no time, and never its "On Mon, Nov 9
  // at 9:00 AM … wrote:" lines, which say when the earlier email was sent.
  const found =
    findTime(`${subject}\n${reply}`, sentAt, opts.tz) ??
    (reply === text.trim() ? null : findTime(withoutAttributions(text), sentAt, opts.tz));
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
      description: emailDescription(gmailLink(opts.email, detail.thread.id), reply),
    },
    found: found !== null,
  };
}
