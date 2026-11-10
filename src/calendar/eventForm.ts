// The event editor's model: what the form holds, how an event's detail fills it, which presets
// "Repeat" offers, and the `EventEdit` a save sends (only what changed, for an existing event).
// Pure: no React, no IPC.
import type { EventDetail, EventEdit } from "../lib/tauri";
import { addDays, dateOf, daysBetween, formatDay, wallClock, weekday, zonedMs } from "./dates";

export type ReminderUnit = "minutes" | "hours" | "days" | "weeks";
export interface Reminder {
  method: "popup" | "email";
  amount: number;
  unit: ReminderUnit;
}

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export type RepeatEnd =
  | { kind: "never" }
  | { kind: "on"; date: string }
  | { kind: "after"; count: number };
export interface RepeatRule {
  freq: Freq;
  interval: number;
  /** Weekly: the weekdays (`MO`…`SU`). Monthly: one `2WE`-style nth weekday, or none for the day of the month. */
  byDay: string[];
  ends: RepeatEnd;
}
/** `other`: a rule this editor can't show (kept as it is unless the user picks another). */
export type Repeat =
  | { kind: "none" }
  | { kind: "rule"; rule: RepeatRule }
  | { kind: "other"; lines: string[] };

export interface Guest {
  name: string | null;
  address: string;
  optional: boolean;
}

export interface EventForm {
  summary: string;
  allDay: boolean;
  /** Timed: the start's day and minutes in `startZone`. All-day: the first day. */
  startDate: string;
  startMinutes: number;
  /** Timed: the end's day and minutes in `endZone`. All-day: the last day (inclusive). */
  endDate: string;
  endMinutes: number;
  startZone: string;
  endZone: string;
  repeat: Repeat;
  /** EXDATE/RDATE lines of the series, kept with whatever rule it gets. */
  extraLines: string[];
  guests: Guest[];
  guestsCanModify: boolean;
  guestsCanInviteOthers: boolean;
  guestsCanSeeOtherGuests: boolean;
  meet: boolean;
  location: string;
  description: string;
  accountId: string;
  calendarId: string;
  /** `""`: the calendar's colour. */
  colorId: string;
  remindersDefault: boolean;
  reminders: Reminder[];
  transparency: "opaque" | "transparent";
  visibility: "default" | "public" | "private" | "confidential";
}

export const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const DAY_MINUTES = 24 * 60;
const UNIT_MINUTES: Record<ReminderUnit, number> = {
  minutes: 1,
  hours: 60,
  days: DAY_MINUTES,
  weeks: 7 * DAY_MINUTES,
};
/** Google's longest reminder: four weeks. */
export const MAX_REMINDER_MINUTES = 4 * 7 * DAY_MINUTES;
export const MAX_REMINDERS = 5;

export const reminderMinutes = (r: Reminder) => r.amount * UNIT_MINUTES[r.unit];

/** `minutes` in the largest unit it fills exactly ("1 week", not "10080 minutes"). */
export function reminderFrom(method: string, minutes: number): Reminder {
  const unit = (["weeks", "days", "hours"] as const).find(
    (u) => minutes > 0 && minutes % UNIT_MINUTES[u] === 0,
  );
  return {
    method: method === "email" ? "email" : "popup",
    amount: unit ? minutes / UNIT_MINUTES[unit] : minutes,
    unit: unit ?? "minutes",
  };
}

/** Descriptions are often HTML from Google's editor: the editor shows (and saves) plain text. */
export function plainText(html: string): string {
  if (!/<[a-z][\s\S]*>/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(
    html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n"),
    "text/html",
  );
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Repeat rules ─────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** The nth weekday of `date` in its month: `2WE` for the second Wednesday, `-1WE` for the last. */
export function nthWeekday(date: string): string {
  const n = Math.ceil(Number(date.slice(8)) / 7);
  return `${n === 5 ? -1 : n}${WEEKDAYS[weekday(date)]}`;
}

/**
 * Splits RRULE lines from the EXDATE/RDATE ones and reads the rule if the editor can show it. A
 * timed `UNTIL` (UTC) is read as its day in `zone`.
 */
export function parseRecurrence(
  lines: string[],
  zone = "UTC",
): { repeat: Repeat; extra: string[] } {
  const rules = lines.filter((l) => /^RRULE:/i.test(l));
  const extra = lines.filter((l) => !/^RRULE:/i.test(l));
  if (rules.length === 0) return { repeat: { kind: "none" }, extra };
  const rule = rules.length === 1 ? parseRule(rules[0], zone) : null;
  return { repeat: rule ? { kind: "rule", rule } : { kind: "other", lines: rules }, extra };
}

function parseRule(line: string, zone: string): RepeatRule | null {
  const parts = new Map(
    line
      .replace(/^RRULE:/i, "")
      .split(";")
      .map((p) => p.split("=") as [string, string])
      .map(([k, v]) => [k.toUpperCase(), (v ?? "").toUpperCase()]),
  );
  const freq = parts.get("FREQ") as Freq | undefined;
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  const known = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"]);
  if ([...parts.keys()].some((k) => !known.has(k))) return null;
  const interval = Number(parts.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1) return null;
  const byDay = parts.get("BYDAY")?.split(",").filter(Boolean) ?? [];
  if (freq === "WEEKLY" && byDay.some((d) => !WEEKDAYS.includes(d as never))) return null;
  if (freq === "MONTHLY" && (byDay.length > 1 || byDay.some((d) => !/^-?[1-5][A-Z]{2}$/.test(d))))
    return null;
  if ((freq === "DAILY" || freq === "YEARLY") && byDay.length) return null;
  let ends: RepeatEnd = { kind: "never" };
  const count = parts.get("COUNT");
  const until = parts.get("UNTIL");
  if (count) ends = { kind: "after", count: Number(count) };
  else if (until) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(until);
    if (!m) return null;
    const [, y, mo, d, h, mi, sec, utc] = m;
    const date =
      h && utc ? dateOf(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec), zone) : `${y}-${mo}-${d}`;
    ends = { kind: "on", date };
  }
  return { freq, interval, byDay, ends };
}

/**
 * The RRULE line for `rule`. `UNTIL` is the end of the last day in `zone` (UTC, as Google
 * requires for timed events), or the date itself for all-day events.
 */
export function ruleLine(rule: RepeatRule, allDay: boolean, zone: string): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay.length && (rule.freq === "WEEKLY" || rule.freq === "MONTHLY"))
    parts.push(`BYDAY=${rule.byDay.join(",")}`);
  if (rule.ends.kind === "after") parts.push(`COUNT=${rule.ends.count}`);
  if (rule.ends.kind === "on") {
    if (allDay) parts.push(`UNTIL=${rule.ends.date.replace(/-/g, "")}`);
    else {
      const d = new Date(zonedMs(addDays(rule.ends.date, 1), 0, zone) - 1000);
      parts.push(
        `UNTIL=${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`,
      );
    }
  }
  return `RRULE:${parts.join(";")}`;
}

const sameRule = (a: RepeatRule, b: RepeatRule) =>
  a.freq === b.freq &&
  a.interval === b.interval &&
  [...a.byDay].sort().join() === [...b.byDay].sort().join() &&
  JSON.stringify(a.ends) === JSON.stringify(b.ends);

export interface RepeatPreset {
  id: string;
  label: string;
  rule: RepeatRule;
}

const NEVER: RepeatEnd = { kind: "never" };
const longWeekday = (date: string) => formatDay(date, { weekday: "long" });
const ORDINALS: Record<string, string> = {
  "1": "first",
  "2": "second",
  "3": "third",
  "4": "fourth",
  "-1": "last",
};

/** The website's Repeat presets for an event starting on `date`. */
export function repeatPresets(date: string): RepeatPreset[] {
  const nth = nthWeekday(date);
  const n = nth.slice(0, -2);
  return [
    { id: "daily", label: "Daily", rule: { freq: "DAILY", interval: 1, byDay: [], ends: NEVER } },
    {
      id: "weekly",
      label: `Weekly on ${longWeekday(date)}`,
      rule: { freq: "WEEKLY", interval: 1, byDay: [WEEKDAYS[weekday(date)]], ends: NEVER },
    },
    {
      id: "monthly",
      label: `Monthly on the ${ORDINALS[n]} ${longWeekday(date)}`,
      rule: { freq: "MONTHLY", interval: 1, byDay: [nth], ends: NEVER },
    },
    {
      id: "yearly",
      label: `Annually on ${formatDay(date, { month: "long", day: "numeric" })}`,
      rule: { freq: "YEARLY", interval: 1, byDay: [], ends: NEVER },
    },
    {
      id: "weekdays",
      label: "Every weekday (Monday to Friday)",
      rule: { freq: "WEEKLY", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"], ends: NEVER },
    },
  ];
}

/** Which Repeat choice `repeat` is for an event on `date`: `none`, a preset's id, or `custom`. */
export function repeatChoice(repeat: Repeat, date: string): string {
  if (repeat.kind === "none") return "none";
  if (repeat.kind === "other") return "custom";
  return repeatPresets(date).find((p) => sameRule(p.rule, repeat.rule))?.id ?? "custom";
}

const FREQ_UNIT: Record<Freq, [string, string]> = {
  DAILY: ["day", "days"],
  WEEKLY: ["week", "weeks"],
  MONTHLY: ["month", "months"],
  YEARLY: ["year", "years"],
};

/** "Every 2 weeks on Monday, Wednesday, 10 times"-style words for a rule. */
export function describeRule(rule: RepeatRule): string {
  const [one, many] = FREQ_UNIT[rule.freq];
  let text = rule.interval === 1 ? `Every ${one}` : `Every ${rule.interval} ${many}`;
  if (rule.freq === "WEEKLY" && rule.byDay.length) {
    const names = WEEKDAYS.map((code, i) => [
      code,
      formatDay(addDays("2026-11-01", i), { weekday: "long" }),
    ]);
    text += ` on ${rule.byDay.map((d) => names.find(([c]) => c === d)?.[1] ?? d).join(", ")}`;
  }
  if (rule.freq === "MONTHLY" && rule.byDay[0]) {
    const code = rule.byDay[0];
    const day = WEEKDAYS.indexOf(code.slice(-2) as never);
    text += ` on the ${ORDINALS[code.slice(0, -2)] ?? code.slice(0, -2)} ${formatDay(addDays("2026-11-01", day), { weekday: "long" })}`;
  }
  if (rule.ends.kind === "after")
    text += `, ${rule.ends.count} ${rule.ends.count === 1 ? "time" : "times"}`;
  if (rule.ends.kind === "on")
    text += `, until ${formatDay(rule.ends.date, { month: "short", day: "numeric", year: "numeric" })}`;
  return text;
}

// ── Building the form ────────────────────────────────────────────────────────

/** A new event's form: `start`/`end` UTC ms (timed) or first/last day (all-day). */
export function newForm(init: {
  accountId: string;
  calendarId: string;
  zone: string;
  allDay: boolean;
  /** UTC ms for timed events. */
  start?: number;
  end?: number;
  /** First and last day for all-day events. */
  startDate?: string;
  endDate?: string;
  summary?: string;
}): EventForm {
  const { zone } = init;
  const timed = (ms: number) => wallClock(ms, zone);
  const start = init.start != null ? timed(init.start) : null;
  const end = init.end != null ? timed(init.end) : null;
  const startDate = init.startDate ?? start?.date ?? dateOf(Date.now(), zone);
  return {
    summary: init.summary ?? "",
    allDay: init.allDay,
    startDate,
    startMinutes: start?.minutes ?? 9 * 60,
    endDate: init.endDate ?? end?.date ?? startDate,
    endMinutes: end?.minutes ?? 10 * 60,
    startZone: zone,
    endZone: zone,
    repeat: { kind: "none" },
    extraLines: [],
    guests: [],
    guestsCanModify: false,
    guestsCanInviteOthers: true,
    guestsCanSeeOtherGuests: true,
    meet: false,
    location: "",
    description: "",
    accountId: init.accountId,
    calendarId: init.calendarId,
    colorId: "",
    remindersDefault: true,
    reminders: [],
    transparency: init.allDay ? "transparent" : "opaque",
    visibility: "default",
  };
}

/** The form for an existing event (or a duplicate of one), times in the event's own zones. */
export function formFromDetail(d: EventDetail, displayZone: string): EventForm {
  const startZone = d.start.timeZone || displayZone;
  const endZone = d.end.timeZone || startZone;
  const { repeat, extra } = parseRecurrence(d.recurrence, startZone);
  const base = newForm({
    accountId: d.accountId,
    calendarId: d.calendarId,
    zone: startZone,
    allDay: d.allDay,
  });
  let times: Pick<EventForm, "startDate" | "startMinutes" | "endDate" | "endMinutes">;
  if (d.allDay && d.start.date) {
    const end = d.end.date && d.end.date > d.start.date ? d.end.date : addDays(d.start.date, 1);
    times = {
      startDate: d.start.date,
      startMinutes: 9 * 60,
      endDate: addDays(end, -1),
      endMinutes: 10 * 60,
    };
  } else {
    const s = wallClock(d.start.ms ?? Date.now(), startZone);
    const e = wallClock(d.end.ms ?? d.start.ms ?? Date.now(), endZone);
    times = { startDate: s.date, startMinutes: s.minutes, endDate: e.date, endMinutes: e.minutes };
  }
  return {
    ...base,
    ...times,
    summary: d.summary ?? "",
    endZone,
    repeat,
    extraLines: extra,
    guests: d.attendees
      .filter((a) => !a.resource && a.email)
      .map((a) => ({ name: a.name, address: a.email!, optional: a.optional })),
    guestsCanModify: d.guestsCanModify,
    guestsCanInviteOthers: d.guestsCanInviteOthers,
    guestsCanSeeOtherGuests: d.guestsCanSeeOtherGuests,
    meet: d.hasConference || d.meetUrl != null || d.conferencePending,
    location: d.location ?? "",
    description: d.description ? plainText(d.description) : "",
    colorId: d.colorId ?? "",
    remindersDefault: d.reminders.useDefault,
    reminders: d.reminders.overrides.map((r) => reminderFrom(r.method, r.minutes)),
    transparency: d.transparency === "transparent" ? "transparent" : "opaque",
    visibility:
      d.visibility === "public" || d.visibility === "private" || d.visibility === "confidential"
        ? d.visibility
        : "default",
  };
}

// ── Times ────────────────────────────────────────────────────────────────────

/** The start and end as an edit sends them. */
export function formTimes(f: EventForm): Pick<EventEdit, "start" | "end"> {
  if (f.allDay)
    return {
      start: { date: f.startDate },
      end: { date: addDays(f.endDate, 1) },
    };
  return {
    start: { ms: zonedMs(f.startDate, f.startMinutes, f.startZone), timeZone: f.startZone },
    end: { ms: zonedMs(f.endDate, f.endMinutes, f.endZone), timeZone: f.endZone },
  };
}

/** Why the form can't be saved, or null. */
export function formProblem(f: EventForm): string | null {
  if (f.allDay) {
    if (daysBetween(f.startDate, f.endDate) < 0) return "The event must end after it starts.";
  } else {
    const { start, end } = formTimes(f);
    if ((end!.ms ?? 0) <= (start!.ms ?? 0)) return "The event must end after it starts.";
  }
  if (f.repeat.kind === "rule") {
    const { ends } = f.repeat.rule;
    if (ends.kind === "after" && !(ends.count >= 1)) return "Repeat at least once.";
    if (ends.kind === "on" && ends.date < f.startDate)
      return "The repeat can't end before the event starts.";
  }
  for (const g of f.guests)
    if (!/^[^\s@]+@[^\s@]+$/.test(g.address)) return `“${g.address}” isn't an email address.`;
  for (const r of f.reminders)
    if (!(r.amount >= 0) || reminderMinutes(r) > MAX_REMINDER_MINUTES)
      return "A reminder must be between 0 minutes and 4 weeks before the event.";
  return null;
}

/** The recurrence lines the form sends. */
export function formRecurrence(f: EventForm): string[] {
  if (f.repeat.kind === "none") return [];
  const rule =
    f.repeat.kind === "rule" ? [ruleLine(f.repeat.rule, f.allDay, f.startZone)] : f.repeat.lines;
  return [...rule, ...f.extraLines];
}

// ── The edit a save sends ────────────────────────────────────────────────────

const sameList = <T>(a: T[], b: T[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What saving `form` sends. With `initial` (an existing event's form), only the fields that
 * changed, so nothing the user didn't touch is rewritten; without it, everything.
 */
export function formEdit(form: EventForm, initial: EventForm | null): EventEdit {
  const changed = <K extends keyof EventForm>(...keys: K[]) =>
    !initial || keys.some((k) => JSON.stringify(form[k]) !== JSON.stringify(initial[k]));
  const edit: EventEdit = {};
  if (changed("summary")) edit.summary = form.summary.trim();
  if (changed("location") && (initial || form.location.trim()))
    edit.location = form.location.trim();
  if (changed("description") && (initial || form.description.trim()))
    edit.description = form.description;
  if (changed("colorId") && (initial || form.colorId)) edit.colorId = form.colorId;
  if (
    changed("allDay", "startDate", "startMinutes", "endDate", "endMinutes", "startZone", "endZone")
  )
    Object.assign(edit, formTimes(form));
  const recurrence = formRecurrence(form);
  if (initial ? !sameList(recurrence, formRecurrence(initial)) : recurrence.length)
    edit.recurrence = recurrence;
  if (changed("guests") && (initial || form.guests.length))
    edit.attendees = form.guests.map((g) => ({ email: g.address, optional: g.optional }));
  if (changed("guestsCanModify")) edit.guestsCanModify = form.guestsCanModify;
  if (changed("guestsCanInviteOthers")) edit.guestsCanInviteOthers = form.guestsCanInviteOthers;
  if (changed("guestsCanSeeOtherGuests"))
    edit.guestsCanSeeOtherGuests = form.guestsCanSeeOtherGuests;
  if (changed("meet") && (initial || form.meet)) edit.conference = form.meet;
  if (changed("remindersDefault", "reminders") && (initial || !form.remindersDefault))
    edit.reminders = {
      useDefault: form.remindersDefault,
      overrides: form.remindersDefault
        ? []
        : form.reminders.map((r) => ({ method: r.method, minutes: reminderMinutes(r) })),
    };
  if (changed("transparency")) edit.transparency = form.transparency;
  if (changed("visibility") && (initial || form.visibility !== "default"))
    edit.visibility = form.visibility;
  return edit;
}

/** Whether an edit changes nothing. */
export const isEmptyEdit = (edit: EventEdit) => Object.keys(edit).length === 0;

/** Moves the end with the start, keeping the length (as the website does when the start changes). */
export function moveStart(f: EventForm, startDate: string, startMinutes: number): EventForm {
  if (f.allDay) {
    const days = daysBetween(f.startDate, f.endDate);
    return { ...f, startDate, endDate: addDays(startDate, Math.max(0, days)) };
  }
  const length =
    zonedMs(f.endDate, f.endMinutes, f.endZone) - zonedMs(f.startDate, f.startMinutes, f.startZone);
  const start = zonedMs(startDate, startMinutes, f.startZone);
  const end = wallClock(start + Math.max(0, length), f.endZone);
  return { ...f, startDate, startMinutes, endDate: end.date, endMinutes: end.minutes };
}

/** Whether guests other than the account itself are on the event (so they could be emailed). */
export const hasOtherGuests = (guests: Guest[], selfEmail: string | null | undefined) =>
  guests.some((g) => g.address.toLowerCase() !== (selfEmail ?? "").toLowerCase());
