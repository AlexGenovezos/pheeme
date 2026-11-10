// Fields the quick-create popover and the editor share: when (dates, times, all day, time
// zones) and which calendar.
import { useId, useMemo, useState } from "react";
import { useCalendarStore } from "./calendarStore";
import { writableCalendars } from "./actions";
import { addDays, daysBetween } from "./dates";
import { type EventForm, moveStart } from "./eventForm";

const pad = (n: number) => String(n).padStart(2, "0");
export const timeValue = (minutes: number) =>
  `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
const parseTime = (value: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Every IANA zone this runtime knows, with `current` in the list. */
function zones(current: string[]): string[] {
  const all =
    (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ??
    [];
  return [...new Set([...all, ...current])].sort();
}

/**
 * Start and end. Changing the start keeps the length (the end moves with it), as on the website.
 * `compact` (quick create) leaves out the time zones.
 */
export function TimeFields({
  form,
  onChange,
  compact = false,
}: {
  form: EventForm;
  onChange(form: EventForm): void;
  compact?: boolean;
}) {
  const id = useId();
  const zoneList = useMemo(
    () => (compact ? [] : zones([form.startZone, form.endZone])),
    [compact, form.startZone, form.endZone],
  );
  const [separateZones, setSeparateZones] = useState(form.startZone !== form.endZone);

  const setStartDate = (v: string) => isDate(v) && onChange(moveStart(form, v, form.startMinutes));
  const setStartTime = (v: string) => {
    const m = parseTime(v);
    if (m != null) onChange(moveStart(form, form.startDate, m));
  };
  const setEndDate = (v: string) => {
    if (!isDate(v)) return;
    // An all-day end before the start moves the start with it.
    if (form.allDay && v < form.startDate) onChange({ ...form, startDate: v, endDate: v });
    else onChange({ ...form, endDate: v });
  };
  const setEndTime = (v: string) => {
    const m = parseTime(v);
    if (m == null) return;
    // An end earlier than the start on the same day means the next day, as on the website.
    const endDate =
      form.endDate === form.startDate && m <= form.startMinutes && form.startZone === form.endZone
        ? addDays(form.startDate, 1)
        : form.endDate;
    onChange({ ...form, endMinutes: m, endDate });
  };
  const setAllDay = (allDay: boolean) => {
    if (allDay) {
      const last =
        form.endDate > form.startDate && form.endMinutes === 0
          ? addDays(form.endDate, -1)
          : form.endDate;
      onChange({ ...form, allDay, endDate: last < form.startDate ? form.startDate : last });
    } else {
      // Back to times: the same days, the hour it had (or 9 to 10).
      const sameDay = daysBetween(form.startDate, form.endDate) === 0;
      onChange({
        ...form,
        allDay,
        endMinutes:
          sameDay && form.endMinutes <= form.startMinutes
            ? form.startMinutes + 60
            : form.endMinutes,
      });
    }
  };

  const multiDay = form.endDate !== form.startDate;
  return (
    <div className="cal-when">
      <div className="cal-when__row">
        <input
          type="date"
          className="cal-field cal-when__date"
          aria-label={form.allDay ? "Start date" : "Date"}
          value={form.startDate}
          required
          onChange={(e) => setStartDate(e.currentTarget.value)}
        />
        {!form.allDay && (
          <input
            type="time"
            step={900}
            className="cal-field cal-when__time"
            aria-label="Start time"
            value={timeValue(form.startMinutes)}
            required
            onChange={(e) => setStartTime(e.currentTarget.value)}
          />
        )}
        <span className="cal-when__to">to</span>
        {!form.allDay && (
          <input
            type="time"
            step={900}
            className="cal-field cal-when__time"
            aria-label="End time"
            value={timeValue(form.endMinutes)}
            required
            onChange={(e) => setEndTime(e.currentTarget.value)}
          />
        )}
        {(form.allDay || multiDay || !compact) && (
          <input
            type="date"
            className="cal-field cal-when__date"
            aria-label="End date"
            value={form.endDate}
            min={form.allDay ? form.startDate : undefined}
            required
            onChange={(e) => setEndDate(e.currentTarget.value)}
          />
        )}
      </div>
      <div className="cal-when__row">
        <label className="cal-check">
          <input
            type="checkbox"
            checked={form.allDay}
            onChange={(e) => setAllDay(e.currentTarget.checked)}
          />
          All day
        </label>
        {!compact && !form.allDay && (
          <>
            <label className="cal-when__zone" htmlFor={`${id}-zone`}>
              {separateZones ? "Start time zone" : "Time zone"}
            </label>
            <select
              id={`${id}-zone`}
              className="cal-field cal-select"
              value={form.startZone}
              onChange={(e) => {
                const zone = e.currentTarget.value;
                onChange({
                  ...form,
                  startZone: zone,
                  endZone: separateZones ? form.endZone : zone,
                });
              }}
            >
              {zoneList.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <label className="cal-check">
              <input
                type="checkbox"
                checked={separateZones}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setSeparateZones(on);
                  if (!on) onChange({ ...form, endZone: form.startZone });
                }}
              />
              Separate end time zone
            </label>
          </>
        )}
      </div>
      {!compact && !form.allDay && separateZones && (
        <div className="cal-when__row">
          <label className="cal-when__zone" htmlFor={`${id}-end-zone`}>
            End time zone
          </label>
          <select
            id={`${id}-end-zone`}
            className="cal-field cal-select"
            value={form.endZone}
            onChange={(e) => onChange({ ...form, endZone: e.currentTarget.value })}
          >
            {zoneList.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

const calendarValue = (accountId: string, calendarId: string) => `${accountId}\n${calendarId}`;

/**
 * Which calendar the event is on: every calendar you can add events to, by account. `lockAccount`
 * (an existing event) keeps it within its account, since Google moves events only there.
 */
export function CalendarSelect({
  form,
  onChange,
  lockAccount = false,
  disabled = false,
  id,
}: {
  form: EventForm;
  onChange(form: EventForm): void;
  lockAccount?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const accounts = useCalendarStore((s) => s.accounts);
  const groups = useMemo(() => {
    const byAccount = new Map<string, ReturnType<typeof writableCalendars>>();
    for (const w of writableCalendars(accounts)) {
      const list = byAccount.get(w.account.accountId) ?? [];
      list.push(w);
      byAccount.set(w.account.accountId, list);
    }
    return [...byAccount.values()];
  }, [accounts]);
  const known = groups.some((g) =>
    g.some((w) => w.account.accountId === form.accountId && w.calendar.id === form.calendarId),
  );
  return (
    <select
      id={id}
      className="cal-field cal-select"
      aria-label={id ? undefined : "Calendar"}
      value={calendarValue(form.accountId, form.calendarId)}
      disabled={disabled}
      onChange={(e) => {
        const [accountId, calendarId] = e.currentTarget.value.split("\n");
        onChange({ ...form, accountId, calendarId });
      }}
    >
      {!known && (
        <option value={calendarValue(form.accountId, form.calendarId)}>{form.calendarId}</option>
      )}
      {groups.map((g) => (
        <optgroup key={g[0].account.accountId} label={g[0].account.email}>
          {g.map((w) => (
            <option
              key={w.calendar.id}
              value={calendarValue(w.account.accountId, w.calendar.id)}
              disabled={lockAccount && w.account.accountId !== form.accountId}
            >
              {w.calendar.primary ? w.account.email : w.calendar.summary}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
