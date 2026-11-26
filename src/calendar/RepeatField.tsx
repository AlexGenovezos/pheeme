import { useId, useMemo, useState } from "react";
import { DateField } from "../components/ui/DateField";
import { Select } from "../components/ui/Select";
import { addDays, formatDay, weekday } from "./dates";
import {
  type EventForm,
  type Freq,
  nthWeekday,
  type RepeatRule,
  repeatChoice,
  repeatPresets,
  WEEKDAYS,
} from "./eventForm";
import { useWeekStart } from "./EventFields";

const FREQS: { value: Freq; one: string; many: string }[] = [
  { value: "DAILY", one: "day", many: "days" },
  { value: "WEEKLY", one: "week", many: "weeks" },
  { value: "MONTHLY", one: "month", many: "months" },
  { value: "YEARLY", one: "year", many: "years" },
];

export function RepeatField({
  form,
  onChange,
}: {
  form: EventForm;
  onChange(form: EventForm): void;
}) {
  const presets = useMemo(() => repeatPresets(form.startDate), [form.startDate]);
  const choice = repeatChoice(form.repeat, form.startDate);
  const [custom, setCustom] = useState(choice === "custom");
  const showCustom = custom || choice === "custom";

  const pick = (value: string) => {
    if (value === "none") {
      setCustom(false);
      onChange({ ...form, repeat: { kind: "none" } });
    } else if (value === "custom") {
      setCustom(true);
      if (form.repeat.kind !== "rule")
        onChange({ ...form, repeat: { kind: "rule", rule: { ...presets[1].rule } } });
    } else {
      setCustom(false);
      const preset = presets.find((p) => p.id === value);
      if (preset) onChange({ ...form, repeat: { kind: "rule", rule: { ...preset.rule } } });
    }
  };

  return (
    <div className="cal-repeat">
      <Select
        className="cal-select cal-repeat__select"
        aria-label="Repeat"
        value={showCustom ? "custom" : choice}
        options={[
          { value: "none", label: "Does not repeat" },
          ...presets.map((p) => ({ value: p.id, label: p.label })),
          { value: "custom", label: "Custom…" },
        ]}
        onChange={pick}
      />
      {showCustom && form.repeat.kind === "rule" && (
        <CustomRepeat
          rule={form.repeat.rule}
          startDate={form.startDate}
          monthlyLabel={presets[2].label}
          onChange={(rule) => onChange({ ...form, repeat: { kind: "rule", rule } })}
        />
      )}
      {form.repeat.kind === "other" && (
        <p className="cal-editor__muted">
          This event repeats in a way Pheeme can't show. It stays as it is unless you pick another
          repeat.
        </p>
      )}
    </div>
  );
}

function CustomRepeat({
  rule,
  startDate,
  monthlyLabel,
  onChange,
}: {
  rule: RepeatRule;
  startDate: string;
  monthlyLabel: string;
  onChange(rule: RepeatRule): void;
}) {
  const id = useId();
  const weekStart = useWeekStart();
  const set = (patch: Partial<RepeatRule>) => onChange({ ...rule, ...patch });
  const unit = FREQS.find((f) => f.value === rule.freq)!;
  const toggleDay = (code: string) => {
    const has = rule.byDay.includes(code);
    const next = has ? rule.byDay.filter((d) => d !== code) : [...rule.byDay, code];
    // A weekly repeat needs a day: the start's.
    set({
      byDay: next.length
        ? WEEKDAYS.filter((d) => next.includes(d))
        : [WEEKDAYS[weekday(startDate)]],
    });
  };
  const nth = nthWeekday(startDate);
  return (
    <div className="cal-repeat__custom" role="group" aria-label="Custom repeat">
      <div className="cal-editor__inline">
        <label htmlFor={`${id}-every`}>Every</label>
        <input
          id={`${id}-every`}
          type="number"
          min={1}
          max={99}
          className="cal-field cal-repeat__number"
          value={rule.interval}
          onChange={(e) =>
            set({ interval: Math.max(1, Math.floor(Number(e.currentTarget.value) || 1)) })
          }
        />
        <Select
          className="cal-select"
          aria-label="Repeat unit"
          value={rule.freq}
          options={FREQS.map((f) => ({
            value: f.value,
            label: rule.interval === 1 ? f.one : f.many,
          }))}
          onChange={(freq) =>
            set({ freq, byDay: freq === "WEEKLY" ? [WEEKDAYS[weekday(startDate)]] : [] })
          }
        />
      </div>
      {rule.freq === "WEEKLY" && (
        <div className="cal-repeat__days" role="group" aria-label={`Repeat on (every ${unit.one})`}>
          {WEEKDAYS.map((code, i) => {
            const day = addDays("2026-11-01", i);
            return (
              <button
                key={code}
                type="button"
                className="cal-repeat__day"
                aria-pressed={rule.byDay.includes(code)}
                aria-label={formatDay(day, { weekday: "long" })}
                onClick={() => toggleDay(code)}
              >
                {formatDay(day, { weekday: "narrow" })}
              </button>
            );
          })}
        </div>
      )}
      {rule.freq === "MONTHLY" && (
        <Select
          className="cal-select cal-repeat__select"
          aria-label="Repeat on"
          value={rule.byDay.length ? "weekday" : "day"}
          options={[
            { value: "day", label: `Monthly on day ${Number(startDate.slice(8))}` },
            {
              value: "weekday",
              label: monthlyLabel,
            },
          ]}
          onChange={(by) => set({ byDay: by === "weekday" ? [nth] : [] })}
        />
      )}
      <div className="cal-repeat__ends" role="radiogroup" aria-label="Ends">
        <span className="cal-editor__muted">Ends</span>
        <label className="cal-check">
          <input
            type="radio"
            name={`${id}-ends`}
            checked={rule.ends.kind === "never"}
            onChange={() => set({ ends: { kind: "never" } })}
          />
          Never
        </label>
        <span className="cal-editor__inline">
          <label className="cal-check">
            <input
              type="radio"
              name={`${id}-ends`}
              checked={rule.ends.kind === "on"}
              onChange={() => set({ ends: { kind: "on", date: addDays(startDate, 30) } })}
            />
            On
          </label>
          <DateField
            aria-label="Ends on"
            disabled={rule.ends.kind !== "on"}
            min={startDate}
            weekStart={weekStart}
            value={rule.ends.kind === "on" ? rule.ends.date : addDays(startDate, 30)}
            onChange={(date) => set({ ends: { kind: "on", date } })}
          />
        </span>
        <span className="cal-editor__inline">
          <label className="cal-check">
            <input
              type="radio"
              name={`${id}-ends`}
              checked={rule.ends.kind === "after"}
              onChange={() => set({ ends: { kind: "after", count: 13 } })}
            />
            After
          </label>
          <input
            type="number"
            min={1}
            max={730}
            className="cal-field cal-repeat__number"
            aria-label="Occurrences"
            disabled={rule.ends.kind !== "after"}
            value={rule.ends.kind === "after" ? rule.ends.count : 13}
            onChange={(e) =>
              set({
                ends: {
                  kind: "after",
                  count: Math.max(1, Math.floor(Number(e.currentTarget.value) || 1)),
                },
              })
            }
          />
          <span>occurrences</span>
        </span>
      </div>
    </div>
  );
}
