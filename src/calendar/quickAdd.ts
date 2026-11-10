// Quick add, the parts with no React in them: a sentence like "Lunch with Sam Friday at noon at
// Joe's /work" read into an event (or, after "todo", a task). Rules and chrono-node only, no AI:
// the date and time, a repeat ("every other Tue", "daily until Dec 1"), a length ("for 30 min"),
// the place ("at …"), the people ("with …", looked up in contacts by the caller) and a calendar
// or task list ("/work"). The title is what's left, people's names included.
import * as chrono from "chrono-node";
import { addDays, wallClock, weekday, zonedMs } from "./dates";
import { type RepeatRule, WEEKDAYS } from "./eventForm";
import { type FoundTime, offsetMinutes } from "./fromEmail";

export type SpanKind = "task" | "time" | "repeat" | "place" | "guest" | "calendar";
/** A part of the sentence that was read as something: `[start, end)` in the text. */
export interface Span {
  kind: SpanKind;
  start: number;
  end: number;
}

/** A name or address after "with". */
export interface Person {
  text: string;
  /** Set when an email address was typed. */
  address: string | null;
}

/** Somewhere the sentence can go with `/name`: a calendar, or a task list for tasks. */
export interface Target {
  key: string;
  name: string;
}

export interface QuickAdd {
  kind: "event" | "task";
  title: string;
  spans: Span[];
  /** When, if the sentence says; null leaves it to the caller. A task uses only the date. */
  when: FoundTime | null;
  repeat: RepeatRule | null;
  place: string;
  people: Person[];
  /** The `Target` key `/name` picked. */
  target: string | null;
}

const HOUR = 60 * 60_000;
const pad = (n: number) => String(n).padStart(2, "0");

const TASK_RE = /^\s*(?:todo|to-do|to do|task|remind me to|reminder)\b[\s:–—-]*/i;
const TARGET_RE = /(?:^|\s)(\/([^\s/]+))\s*$/;

const WEEKDAY =
  "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?";
const DAY_LIST = `${WEEKDAY}(?:\\s*(?:,|&|\\+|\\band\\b)\\s*${WEEKDAY})*`;
const EVERY_RE = new RegExp(
  `\\b(?:every|each)\\s+(?:(other|second|third|\\d+)\\s+)?(weekdays?|days?|weeks?|months?|years?|${DAY_LIST})\\b`,
  "i",
);
const SIMPLE_RE =
  /\b(daily|weekly|monthly|yearly|annually|fortnightly|biweekly|bi-weekly|weekdays)\b/i;
const DURATION_RE =
  /\bfor\s+(an?|one|half an?|\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i;
const UNTIL_RE = /^\s*,?\s*(?:until|till|til|through|thru|ending)\s+/i;
const TIMES_RE = /(?:^|\s)((?:for\s+)?(\d+)\s+times)\b/i;

/** Words after "with" that aren't someone to look up. */
const NOT_PEOPLE = new Set([
  "a",
  "an",
  "the",
  "me",
  "my",
  "our",
  "us",
  "you",
  "your",
  "them",
  "him",
  "her",
  "everyone",
  "everybody",
  "all",
  "at",
  "about",
  "on",
  "to",
  "re",
  "for",
]);

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** The weekday code (`MO`…`SU`) of a weekday word. */
function weekdayCode(word: string): string {
  const w = word.toLowerCase();
  return WEEKDAYS.find((c) => w.startsWith(c.toLowerCase())) ?? "MO";
}

/** The target `/token` names: an exact name first, else the first that starts with it. */
export function matchTarget(token: string, targets: Target[]): Target | null {
  const t = normalize(token);
  if (!t) return null;
  return (
    targets.find((x) => normalize(x.name) === t) ??
    targets.find((x) => normalize(x.name).startsWith(t)) ??
    null
  );
}

interface RepeatFound {
  spans: Span[];
  freq: RepeatRule["freq"];
  interval: number;
  byDay: string[];
  until: string | null;
  count: number | null;
}

/** "every other Tue", "daily", "weekdays", with "until …" or "5 times" right after. */
function findRepeat(
  text: string,
  masked: string,
  ref: chrono.ParsingReference,
): RepeatFound | null {
  const every = EVERY_RE.exec(masked);
  const simple = SIMPLE_RE.exec(masked);
  const m = every && (!simple || every.index <= simple.index) ? every : simple;
  if (!m) return null;
  let freq: RepeatRule["freq"] = "WEEKLY";
  let interval = 1;
  let byDay: string[] = [];
  if (m === every) {
    const n = (m[1] ?? "").toLowerCase();
    interval = n === "other" || n === "second" ? 2 : n === "third" ? 3 : Number(n) || 1;
    const unit = m[2].toLowerCase();
    if (/^weekdays?$/.test(unit)) byDay = ["MO", "TU", "WE", "TH", "FR"];
    else if (/^days?$/.test(unit)) freq = "DAILY";
    else if (/^weeks?$/.test(unit)) freq = "WEEKLY";
    else if (/^months?$/.test(unit)) freq = "MONTHLY";
    else if (/^years?$/.test(unit)) freq = "YEARLY";
    else byDay = [...new Set(unit.match(new RegExp(WEEKDAY, "gi"))!.map(weekdayCode))];
  } else {
    const word = m[1].toLowerCase();
    if (word === "daily") freq = "DAILY";
    else if (word === "monthly") freq = "MONTHLY";
    else if (word === "yearly" || word === "annually") freq = "YEARLY";
    else if (word === "weekdays") byDay = ["MO", "TU", "WE", "TH", "FR"];
    else if (word !== "weekly") interval = 2;
  }
  let end = m.index + m[0].length;
  let until: string | null = null;
  let count: number | null = null;
  const spans: Span[] = [];
  const rest = text.slice(end);
  const u = UNTIL_RE.exec(rest);
  const times = TIMES_RE.exec(
    masked.slice(0, m.index) + " ".repeat(m[0].length) + masked.slice(end),
  );
  if (u) {
    // Only the day: "until Dec 1 at 7am" ends on Dec 1, and each one is at 7.
    const after = rest.slice(u[0].length);
    const stop = /\s+(?:at|from|@)\s/i.exec(after);
    const found = chrono.parse(stop ? after.slice(0, stop.index) : after, ref, {
      forwardDate: true,
    })[0];
    if (found && found.index === 0) {
      const c = found.start;
      until = `${c.get("year")}-${pad(c.get("month") ?? 1)}-${pad(c.get("day") ?? 1)}`;
      end += u[0].length + found.text.length;
    }
  } else if (times) {
    count = Number(times[2]);
    const start = times.index + times[0].indexOf(times[1]);
    spans.push({ kind: "repeat", start, end: start + times[1].length });
  }
  spans.push({ kind: "repeat", start: m.index, end });
  return { spans, freq, interval, byDay, until, count };
}

/** Blank out `spans` (keeping every index where it was), so later rules don't read them again. */
function mask(text: string, spans: Span[]): string {
  let out = text;
  for (const s of spans)
    out = out.slice(0, s.start) + " ".repeat(s.end - s.start) + out.slice(s.end);
  return out;
}

/** The length "for 30 min" asks for, in ms. */
function durationMs(m: RegExpExecArray): number {
  const n = m[1].toLowerCase();
  const amount = /^half/.test(n) ? 0.5 : /^(an?|one)$/.test(n) ? 1 : Number(n);
  return amount * (/^h/i.test(m[2]) ? HOUR : 60_000);
}

/** The hour chrono read, with "at 2" read as 2 PM: 1–7 without AM/PM is afternoon, as people mean it. */
function hourOf(c: chrono.ParsedComponents): number {
  const hour = c.get("hour") ?? 0;
  return !c.isCertain("meridiem") && hour >= 1 && hour <= 7 ? hour + 12 : hour;
}

const hasDay = (c: chrono.ParsedComponents) =>
  c.isCertain("day") || c.isCertain("weekday") || c.isCertain("month");
const dateOfComponents = (c: chrono.ParsedComponents) =>
  `${c.get("year")}-${pad(c.get("month") ?? 1)}-${pad(c.get("day") ?? 1)}`;

/** The instant of a day and time chrono read, in `tz` unless the text named a zone ("3pm EST"). */
function instant(c: chrono.ParsedComponents, date: string, minutes: number, tz: string): number {
  if (c.isCertain("timezoneOffset")) {
    const offset = c.get("timezoneOffset") ?? 0;
    const [y, m, d] = date.split("-").map(Number);
    return Date.UTC(y, m - 1, d) + (minutes - offset) * 60_000;
  }
  return zonedMs(date, minutes, tz);
}

/**
 * Read `text` as of `now` in `tz`. `targets` are what `/name` can pick: calendars, or task lists
 * when `taskTargets` is given and the sentence starts with "todo".
 */
export function parseQuickAdd(
  text: string,
  opts: { now: number; tz: string; targets: Target[]; taskTargets?: Target[] },
): QuickAdd {
  const { now, tz } = opts;
  const spans: Span[] = [];
  const ref: chrono.ParsingReference = { instant: new Date(now), timezone: offsetMinutes(now, tz) };

  const task = TASK_RE.exec(text);
  const kind = task && task[0].trim() ? "task" : "event";
  if (kind === "task") spans.push({ kind: "task", start: 0, end: task![0].length });

  let target: string | null = null;
  const t = TARGET_RE.exec(text);
  if (t) {
    const found = matchTarget(t[2], kind === "task" ? (opts.taskTargets ?? []) : opts.targets);
    if (found) {
      target = found.key;
      const start = t.index + t[0].indexOf(t[1]);
      spans.push({ kind: "calendar", start, end: start + t[1].length });
    }
  }

  const repeat = kind === "event" ? findRepeat(text, mask(text, spans), ref) : null;
  if (repeat) spans.push(...repeat.spans);

  let length: number | null = null;
  const d = kind === "event" ? DURATION_RE.exec(mask(text, spans)) : null;
  if (d) {
    length = durationMs(d);
    spans.push({ kind: "time", start: d.index, end: d.index + d[0].length });
  }

  // The date and time: the first thing chrono reads, with a time or day said apart from it
  // ("Friday lunch at noon") filled in from the next.
  const results = chrono
    .parse(mask(text, spans), ref, { forwardDate: true })
    .filter((r) => !/^(now|right now|currently)$/i.test(r.text.trim()));
  const first = results[0];
  const timed = first?.start.isCertain("hour")
    ? first
    : results.find((r) => r.start.isCertain("hour") && !hasDay(r.start));
  const dated = first && hasDay(first.start) ? first : results.find((r) => hasDay(r.start));
  for (const r of new Set([timed, dated]))
    if (r) spans.push({ kind: "time", start: r.index, end: r.index + r.text.length });

  const today = wallClock(now, tz).date;
  const repeatDays = repeat?.byDay ?? [];
  let when: FoundTime | null = null;
  if (timed) {
    const c = timed.start;
    const minutes = hourOf(c) * 60 + (c.get("minute") ?? 0);
    let date: string;
    if (dated) date = dateOfComponents(dated.start);
    else {
      // A time alone: the next time it comes round (on a repeat's day, if it names days).
      date = today;
      for (let i = 0; i < 14; i++) {
        const day = addDays(today, i);
        const fits = !repeatDays.length || repeatDays.includes(WEEKDAYS[weekday(day)]);
        if (fits && instant(c, day, minutes, tz) > now) {
          date = day;
          break;
        }
      }
    }
    const start = instant(c, date, minutes, tz);
    let end = start + (length ?? HOUR);
    if (length === null && timed.end?.isCertain("hour")) {
      const e = timed.end;
      const endDate = e.isCertain("day") ? dateOfComponents(e) : date;
      let endMinutes = (e.get("hour") ?? 0) * 60 + (e.get("minute") ?? 0);
      let at = instant(e, endDate, endMinutes, tz);
      // "2-3" with no AM/PM: the end follows the start into the afternoon.
      if (at <= start && !e.isCertain("meridiem") && endMinutes < 12 * 60) {
        endMinutes += 12 * 60;
        at = instant(e, endDate, endMinutes, tz);
      }
      if (at > start) end = at;
    }
    when = { allDay: false, start, end };
  } else if (dated) {
    const date = dateOfComponents(dated.start);
    const last = dated.end && hasDay(dated.end) ? dateOfComponents(dated.end) : date;
    when = { allDay: true, date, lastDate: last >= date ? last : date };
  } else if (repeatDays.length) {
    // "every Tue": all day on the next one.
    for (let i = 0; i < 7; i++) {
      const day = addDays(today, i);
      if (repeatDays.includes(WEEKDAYS[weekday(day)])) {
        when = { allDay: true, date: day, lastDate: day };
        break;
      }
    }
  }

  let rule: RepeatRule | null = null;
  if (repeat) {
    const startDate = when ? (when.allDay ? when.date : wallClock(when.start, tz).date) : today;
    rule = {
      freq: repeat.freq,
      interval: repeat.interval,
      byDay:
        repeat.freq === "WEEKLY"
          ? repeatDays.length
            ? repeatDays
            : [WEEKDAYS[weekday(startDate)]]
          : [],
      ends: repeat.until
        ? { kind: "on", date: repeat.until }
        : repeat.count
          ? { kind: "after", count: repeat.count }
          : { kind: "never" },
    };
  }

  // What's left, piece by piece: the place after "at" and the people after "with".
  let place = "";
  const people: Person[] = [];
  if (kind === "event") {
    for (const seg of segments(text, spans)) {
      if (!place) {
        const found = findPlace(seg.text);
        if (found) {
          place = found.place;
          spans.push({ kind: "place", start: seg.start + found.start, end: seg.start + found.end });
        }
      }
      for (const p of findPeople(seg.text)) {
        if (people.some((x) => x.text.toLowerCase() === p.text.toLowerCase())) continue;
        people.push({ text: p.text, address: p.address });
        spans.push({ kind: "guest", start: seg.start + p.start, end: seg.start + p.end });
      }
    }
  }

  spans.sort((a, b) => a.start - b.start);
  return {
    kind,
    title: titleOf(text, spans),
    spans,
    when,
    repeat: rule,
    place,
    people,
    target,
  };
}

/** The runs of text no rule has read yet (people's names aside). */
function segments(text: string, spans: Span[]): { start: number; text: string }[] {
  const taken = spans.filter((s) => s.kind !== "guest").sort((a, b) => a.start - b.start);
  const out: { start: number; text: string }[] = [];
  let at = 0;
  for (const s of taken) {
    if (s.start > at) out.push({ start: at, text: text.slice(at, s.start) });
    at = Math.max(at, s.end);
  }
  if (at < text.length) out.push({ start: at, text: text.slice(at) });
  return out;
}

/** "at Joe's" (or "@ Joe's"), up to "with" or the end of the run. */
function findPlace(seg: string): { place: string; start: number; end: number } | null {
  const m = /(?:^|\s)((?:at|@)\s+)(?=\S)/i.exec(seg);
  if (!m) return null;
  const start = m.index + m[0].indexOf(m[1]);
  const from = start + m[1].length;
  const stop = /\s+with\s+/i.exec(seg.slice(from));
  let end = stop ? from + stop.index : seg.length;
  while (end > from && /[\s,.;:!?]/.test(seg[end - 1])) end--;
  if (end <= from) return null;
  return { place: seg.slice(from, end), start, end };
}

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>.]+/;
const NAME_RE = /^[\p{L}][\p{L}\p{M}'’-]*/u;
const SURNAME_RE = /^\s+(\p{Lu}[\p{L}\p{M}'’-]*)/u;
const JOIN_RE = /^\s*(?:,|&|\+|\band\b)\s*/i;

/** The people after "with": names (a first name and a capitalised surname) or addresses. */
function findPeople(seg: string): (Person & { start: number; end: number })[] {
  const out: (Person & { start: number; end: number })[] = [];
  const re = /\bwith\s+/gi;
  for (let m = re.exec(seg); m; m = re.exec(seg)) {
    let at = m.index + m[0].length;
    for (;;) {
      const rest = seg.slice(at);
      const email = EMAIL_RE.exec(rest);
      let len = 0;
      let address: string | null = null;
      if (email) {
        len = email[0].length;
        address = email[0];
      } else {
        const name = NAME_RE.exec(rest);
        if (!name || NOT_PEOPLE.has(name[0].toLowerCase())) break;
        len = name[0].length;
        const surname = SURNAME_RE.exec(rest.slice(len));
        if (surname && !NOT_PEOPLE.has(surname[1].toLowerCase())) len += surname[0].length;
      }
      out.push({ text: rest.slice(0, len), address, start: at, end: at + len });
      at += len;
      const join = JOIN_RE.exec(seg.slice(at));
      if (!join) break;
      at += join[0].length;
    }
  }
  return out;
}

/** Words left hanging when what follows them was read: "lunch at [noon]", "dentist on [Friday]". */
const DANGLING = /(?:^|\s)(?:on|at|from|by|starting|this|next|every|until|for|in|@)?[\s,;:–—-]*$/i;

/** The sentence without what was read (people's names stay), tidied and capitalised. */
function titleOf(text: string, spans: Span[]): string {
  const kept: string[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.kind === "guest" || s.start < at) continue;
    kept.push(text.slice(at, s.start).replace(DANGLING, ""));
    at = s.end;
  }
  kept.push(text.slice(at));
  const out = kept
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}
