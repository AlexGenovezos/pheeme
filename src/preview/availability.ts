/** Guests' free/busy for browser preview (`calendar/availability.rs` in the app). */

import type { AvailabilityResult, BusyInterval, CalendarEvent } from "../lib/tauri";
import type { Handler } from "./handlers";

/** Guests whose availability Google won't show (another domain that doesn't share it). */
const NOT_SHARED = new Set(["priya@example.org"]);

const HOUR = 3_600_000;

/** A small stable number from `text`, so each guest's day redraws the same. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Two or three meetings a weekday between 8:00 and 18:00 (local), none at weekends. */
function guestBusy(email: string, fromMs: number, toMs: number): BusyInterval[] {
  const out: BusyInterval[] = [];
  const day = new Date(fromMs);
  day.setHours(0, 0, 0, 0);
  for (; day.getTime() < toMs; day.setDate(day.getDate() + 1)) {
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    const seed = hash(`${email}|${day.toDateString()}`);
    const count = 2 + (seed % 2);
    for (let i = 0; i < count; i++) {
      const hour = 8 + ((seed >>> (i * 4)) % 10);
      const half = (seed >>> (i * 3 + 13)) % 2;
      const length = [0.5, 1, 1.5][(seed >>> (i * 2 + 20)) % 3];
      const startMs = day.getTime() + (hour + half / 2) * HOUR;
      out.push({ startMs, endMs: startMs + length * HOUR });
    }
  }
  return out
    .filter((b) => b.startMs < toMs && b.endMs > fromMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * `freeBusy`: `missing_scope` makes every account ask for the free/busy consent first (until a
 * sign-in with `{ kind: "availability" }` allows it). `eventsIn` reads the account's own events.
 */
export function createAvailabilityHandlers(
  accounts: { id: string; email: string }[],
  eventsIn: (fromMs: number, toMs: number) => CalendarEvent[],
  freeBusy: string | null,
) {
  const allowed = new Set(freeBusy === "missing_scope" ? [] : accounts.map((a) => a.id));
  return {
    allow(accountId: string) {
      allowed.add(accountId);
    },
    calendar_availability: ((args): AvailabilityResult => {
      const accountId = String(args.accountId);
      const fromMs = Number(args.fromMs);
      const toMs = Number(args.toMs);
      const account = accounts.find((a) => a.id === accountId);
      if (!account)
        throw { code: "invalid_input", message: "That account isn't connected any more." };
      if (!allowed.has(accountId))
        throw {
          code: "missing_scope",
          message: "Allow Pheeme to see guests' availability on Google Calendar.",
        };
      const own = eventsIn(fromMs, toMs)
        .filter(
          (e) =>
            e.accountId === accountId &&
            !e.allDay &&
            e.selfResponse !== "declined" &&
            e.transparency !== "transparent" &&
            e.start.ms != null &&
            e.end.ms != null,
        )
        .map((e) => ({ startMs: e.start.ms!, endMs: e.end.ms! }))
        .sort((a, b) => a.startMs - b.startMs);
      const emails = (args.emails as string[] | undefined) ?? [];
      const seen = new Set<string>();
      return {
        you: { email: account.email, status: "known", busy: own },
        guests: emails
          .filter((e) => !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()))
          .map((email) =>
            NOT_SHARED.has(email.toLowerCase())
              ? { email, status: "unknown", reason: "notFound" }
              : { email, status: "known", busy: guestBusy(email.toLowerCase(), fromMs, toMs) },
          ),
      };
    }) satisfies Handler<"calendar_availability">,
  };
}
