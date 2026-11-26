import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Select } from "../components/ui/Select";
import { type EventForm, MAX_REMINDERS, type Reminder } from "./eventForm";

const METHODS: { value: Reminder["method"]; label: string }[] = [
  { value: "popup", label: "Notification" },
  { value: "email", label: "Email" },
];
const UNITS: { value: Reminder["unit"]; label: string }[] = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
  { value: "weeks", label: "weeks" },
];

export function RemindersField({
  form,
  onChange,
}: {
  form: EventForm;
  onChange(form: EventForm): void;
}) {
  // Reminders have no id of their own: each row keeps a key here, so removing one doesn't hand
  // its focus and typed text to the row below.
  const [rows, setRows] = useState(() => ({
    keys: form.remindersDefault ? [] : form.reminders.map((_, i) => i),
    next: form.reminders.length,
  }));
  const setList = (reminders: Reminder[]) =>
    onChange({ ...form, remindersDefault: false, reminders });
  const addRow = () => {
    setRows(({ keys, next }) => ({ keys: [...keys, next], next: next + 1 }));
    setList([...form.reminders, { method: "popup", amount: 30, unit: "minutes" }]);
  };
  const useDefaults = () => {
    setRows(({ next }) => ({ keys: [], next }));
    onChange({ ...form, remindersDefault: true, reminders: [] });
  };
  const removeRow = (i: number) => {
    setRows(({ keys, next }) => ({ keys: keys.filter((_, j) => j !== i), next }));
    setList(form.reminders.filter((_, j) => j !== i));
  };
  if (form.remindersDefault)
    return (
      <div className="cal-editor__inline">
        <span>The calendar's default notifications</span>
        <Button size="sm" variant="ghost" onClick={() => setList([])}>
          Change
        </Button>
      </div>
    );
  return (
    <div className="cal-reminders">
      {form.reminders.length === 0 && <span className="cal-editor__muted">No notifications</span>}
      {form.reminders.map((r, i) => {
        const update = (patch: Partial<Reminder>) =>
          setList(form.reminders.map((o, j) => (j === i ? { ...o, ...patch } : o)));
        return (
          <div
            key={rows.keys[i]}
            className="cal-editor__inline"
            role="group"
            aria-label={`Notification ${i + 1}`}
          >
            <Select
              className="cal-select"
              aria-label="Notify by"
              value={r.method}
              options={METHODS}
              onChange={(method) => update({ method })}
            />
            <input
              type="number"
              min={0}
              className="cal-field cal-repeat__number"
              aria-label="How long before"
              value={r.amount}
              onChange={(e) =>
                update({ amount: Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)) })
              }
            />
            <Select
              className="cal-select"
              aria-label="Unit"
              value={r.unit}
              options={UNITS}
              onChange={(unit) => update({ unit })}
            />
            <span>before</span>
            <IconButton
              size="sm"
              label="Remove notification"
              icon={<X />}
              onClick={() => removeRow(i)}
            />
          </div>
        );
      })}
      <div className="cal-editor__inline">
        <Button size="sm" disabled={form.reminders.length >= MAX_REMINDERS} onClick={addRow}>
          Add notification
        </Button>
        <Button size="sm" variant="ghost" onClick={useDefaults}>
          Use the calendar's defaults
        </Button>
      </div>
    </div>
  );
}
