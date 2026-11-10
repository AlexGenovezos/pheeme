// Fields the quick-create popover and the editor share: when (dates, times, all day, time
// zones) and which calendar.
import { useId, useMemo, useState } from "react";
import { DateField } from "../components/ui/DateField";
import { Select, type SelectOption } from "../components/ui/Select";
import { TimeField } from "../components/ui/TimeField";
import { useCalendarStore, weekStartOf } from "./calendarStore";
import { writableCalendars } from "./actions";
import { addDays, daysBetween } from "./dates";
import { type EventForm, moveStart } from "./eventForm";

const DAY = 24 * 60;

/** Every IANA zone this runtime knows, with `current` in the list. */
function zones(current: string[]): SelectOption<string>[] {
  const all =
    (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ??
    [];
  return [...new Set([...all, ...current])]
    .sort()
    .map((z) => ({ value: z, label: z.replace(/_/g, " ") }));
}

/** The calendar's first weekday, for the date pickers. */
export const useWeekStart = () => useCalendarStore((s) => weekStartOf(s.accounts));

/**
 * Whether a timed event is under a day long in one zone: its end is then picked as a length from
 * the start ("11:30 AM (30 mins)"), and an end at or before the start is the next day.
 */
function shortEvent(form: EventForm): boolean {
  if (form.allDay || form.startZone !== form.endZone) return false;
  const days = daysBetween(form.startDate, form.endDate);
  const length = days * DAY + form.endMinutes - form.startMinutes;
  return days >= 0 && days <= 1 && length > 0 && length <= DAY;
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
  const weekStart = useWeekStart();
  const zoneList = useMemo(
    () => (compact ? [] : zones([form.startZone, form.endZone])),
    [compact, form.startZone, form.endZone],
  );
  const [separateZones, setSeparateZones] = useState(form.startZone !== form.endZone);
  const short = shortEvent(form);

  const setStartDate = (v: string) => onChange(moveStart(form, v, form.startMinutes));
  const setStartTime = (m: number) => onChange(moveStart(form, form.startDate, m));
  const setEndDate = (v: string) => {
    // An all-day end before the start moves the start with it.
    if (form.allDay && v < form.startDate) onChange({ ...form, startDate: v, endDate: v });
    else onChange({ ...form, endDate: v });
  };
  const setEndTime = (m: number) => {
    // Under a day long, the end is a length from the start: at or before the start's time it's the
    // next day, as on the website.
    let endDate = form.endDate;
    if (short) endDate = m <= form.startMinutes ? addDays(form.startDate, 1) : form.startDate;
    else if (
      form.endDate === form.startDate &&
      m <= form.startMinutes &&
      form.startZone === form.endZone
    )
      endDate = addDays(form.startDate, 1);
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
        <DateField
          className="cal-when__date"
          aria-label={form.allDay ? "Start date" : "Date"}
          value={form.startDate}
          weekStart={weekStart}
          onChange={setStartDate}
        />
        {!form.allDay && (
          <TimeField
            className="cal-when__time"
            aria-label="Start time"
            value={form.startMinutes}
            onChange={setStartTime}
          />
        )}
        <span className="cal-when__to">to</span>
        {!form.allDay && (
          <TimeField
            className="cal-when__time"
            aria-label="End time"
            value={form.endMinutes}
            durationFrom={short ? form.startMinutes : undefined}
            onChange={setEndTime}
          />
        )}
        {(form.allDay || multiDay || !compact) && (
          <DateField
            className="cal-when__date"
            aria-label="End date"
            value={form.endDate}
            min={form.allDay ? form.startDate : undefined}
            weekStart={weekStart}
            onChange={setEndDate}
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
            <span className="cal-when__zone" id={`${id}-zone`}>
              {separateZones ? "Start time zone" : "Time zone"}
            </span>
            <Select
              aria-labelledby={`${id}-zone`}
              className="cal-select cal-when__zone-select"
              value={form.startZone}
              options={zoneList}
              onChange={(zone) =>
                onChange({
                  ...form,
                  startZone: zone,
                  endZone: separateZones ? form.endZone : zone,
                })
              }
            />
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
          <span className="cal-when__zone" id={`${id}-end-zone`}>
            End time zone
          </span>
          <Select
            aria-labelledby={`${id}-end-zone`}
            className="cal-select cal-when__zone-select"
            value={form.endZone}
            options={zoneList}
            onChange={(zone) => onChange({ ...form, endZone: zone })}
          />
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
  const options: SelectOption<string>[] = [
    ...(known
      ? []
      : [{ value: calendarValue(form.accountId, form.calendarId), label: form.calendarId }]),
    ...groups.flatMap((g) =>
      g.map((w) => ({
        value: calendarValue(w.account.accountId, w.calendar.id),
        label: w.calendar.primary ? w.account.email : w.calendar.summary,
        group: g[0].account.email,
        disabled: lockAccount && w.account.accountId !== form.accountId,
      })),
    ),
  ];
  return (
    <Select
      id={id}
      className="cal-select"
      aria-label={id ? undefined : "Calendar"}
      value={calendarValue(form.accountId, form.calendarId)}
      options={options}
      disabled={disabled}
      onChange={(value) => {
        const [accountId, calendarId] = value.split("\n");
        onChange({ ...form, accountId, calendarId });
      }}
    />
  );
}
