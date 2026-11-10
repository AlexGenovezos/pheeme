// The full event editor, a dialog over the app like Settings: title, when (all day, time zones),
// repeat (the website's presets and Custom), guests with suggestions and what they may do, Google
// Meet, place, description, calendar and colour, notifications, busy/free and visibility.
import {
  AlignLeft,
  Bell,
  Briefcase,
  CalendarDays,
  Clock,
  MapPin,
  Repeat as RepeatIcon,
  Users,
  Video,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useId, useMemo, useState } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Modal } from "../components/ui/Modal";
import { TextInput } from "../components/ui/TextInput";
import { RecipientField } from "../compose/RecipientField";
import { type EmailAddress, suggestContacts } from "../lib/tauri";
import { cx } from "../lib/utils";
import { closeEditor, saveEditor } from "./actions";
import { useCalendarStore } from "./calendarStore";
import { calendarColor, EVENT_COLORS } from "./colors";
import { ask, type EditorSpec, useEditStore } from "./editStore";
import { CalendarSelect, TimeFields } from "./EventFields";
import {
  type EventForm,
  type Freq,
  MAX_REMINDERS,
  nthWeekday,
  type Reminder,
  type RepeatRule,
  repeatChoice,
  repeatPresets,
  WEEKDAYS,
} from "./eventForm";
import { addDays, formatDay, weekday } from "./dates";
import "../compose/compose.css";

/** Google's names for the event colours. */
const COLOR_NAMES: Record<string, string> = {
  "1": "Lavender",
  "2": "Sage",
  "3": "Grape",
  "4": "Flamingo",
  "5": "Banana",
  "6": "Tangerine",
  "7": "Peacock",
  "8": "Graphite",
  "9": "Blueberry",
  "10": "Basil",
  "11": "Tomato",
};

export function EventEditor() {
  const editor = useEditStore((s) => s.editor);
  return editor ? <EditorBody spec={editor} /> : null;
}

function Section({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="cal-editor__section" role="group" aria-label={label}>
      <span className="cal-editor__icon" aria-hidden="true">
        {icon}
      </span>
      <div className="cal-editor__fields">{children}</div>
    </div>
  );
}

function EditorBody({ spec }: { spec: EditorSpec }) {
  const titleId = useId();
  const [form, setForm] = useState(spec.form);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const accounts = useCalendarStore((s) => s.accounts);
  const account = accounts?.find((a) => a.accountId === form.accountId);
  const calendar = account?.calendars.find((c) => c.id === form.calendarId);
  const set = (patch: Partial<EventForm>) => setForm((f) => ({ ...f, ...patch }));
  const suggest = useCallback(
    (query: string) => suggestContacts(form.accountId, query),
    [form.accountId],
  );
  const editing = spec.event !== null;
  const dirty = JSON.stringify(form) !== JSON.stringify(spec.form);

  const close = async () => {
    if (dirty) {
      const answer = await ask({
        title: "Discard unsaved changes?",
        kind: "buttons",
        options: [
          { value: "keep", label: "Keep editing" },
          { value: "discard", label: "Discard" },
        ],
      });
      if (answer !== "discard") return;
    }
    closeEditor();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    const problem = await saveEditor(spec, form);
    // "" means the user backed out of a question: stay as it was.
    if (problem) setError(problem);
    setSaving(false);
  };

  const guests: EmailAddress[] = form.guests.map((g) => ({ name: g.name, address: g.address }));
  const setGuests = (next: EmailAddress[]) =>
    set({
      guests: next.map((g) => ({
        name: g.name,
        address: g.address,
        optional:
          form.guests.find((o) => o.address.toLowerCase() === g.address.toLowerCase())?.optional ??
          false,
      })),
    });

  return (
    <Modal
      title={editing ? "Edit event" : "New event"}
      titleId={titleId}
      onClose={() => void close()}
      scrimClassName="cal-dialog-scrim"
      className="cal-editor"
      titleClassName="cal-editor__title"
      titleActions={
        <IconButton size="sm" label="Close" icon={<X />} onClick={() => void close()} />
      }
    >
      <form className="cal-editor__form" onSubmit={(e) => void submit(e)}>
        <div className="cal-editor__body">
          <TextInput
            className="cal-editor__summary"
            placeholder="Add title"
            aria-label="Title"
            data-autofocus=""
            value={form.summary}
            onChange={(e) => set({ summary: e.currentTarget.value })}
          />
          <Section icon={<Clock />} label="When">
            <TimeFields form={form} onChange={setForm} />
          </Section>
          <Section icon={<RepeatIcon />} label="Repeat">
            <RepeatField form={form} onChange={setForm} />
          </Section>
          <Section icon={<Users />} label="Guests">
            <div className="cal-editor__guests">
              <RecipientField
                label="Guests"
                value={guests}
                onChange={setGuests}
                suggest={suggest}
              />
            </div>
            <div className="cal-editor__permissions">
              <span className="cal-editor__muted">Guests can:</span>
              <label className="cal-check">
                <input
                  type="checkbox"
                  checked={form.guestsCanModify}
                  onChange={(e) => set({ guestsCanModify: e.currentTarget.checked })}
                />
                Modify event
              </label>
              <label className="cal-check">
                <input
                  type="checkbox"
                  checked={form.guestsCanModify || form.guestsCanInviteOthers}
                  disabled={form.guestsCanModify}
                  onChange={(e) => set({ guestsCanInviteOthers: e.currentTarget.checked })}
                />
                Invite others
              </label>
              <label className="cal-check">
                <input
                  type="checkbox"
                  checked={form.guestsCanModify || form.guestsCanSeeOtherGuests}
                  disabled={form.guestsCanModify}
                  onChange={(e) => set({ guestsCanSeeOtherGuests: e.currentTarget.checked })}
                />
                See guest list
              </label>
            </div>
          </Section>
          <Section icon={<Video />} label="Google Meet">
            {form.meet ? (
              <div className="cal-editor__inline">
                <span>
                  {spec.form.meet && spec.detail?.meetUrl
                    ? spec.detail.meetUrl.replace(/^https?:\/\//, "")
                    : "A Google Meet link is added when you save"}
                </span>
                <Button size="sm" variant="ghost" onClick={() => set({ meet: false })}>
                  Remove
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={() => set({ meet: true })}>
                Add Google Meet video conferencing
              </Button>
            )}
          </Section>
          <Section icon={<MapPin />} label="Location">
            <TextInput
              placeholder="Add location"
              aria-label="Location"
              value={form.location}
              onChange={(e) => set({ location: e.currentTarget.value })}
            />
          </Section>
          <Section icon={<AlignLeft />} label="Description">
            <textarea
              className="cal-field cal-editor__description"
              placeholder="Add description"
              aria-label="Description"
              rows={4}
              value={form.description}
              onChange={(e) => set({ description: e.currentTarget.value })}
            />
          </Section>
          <Section icon={<CalendarDays />} label="Calendar">
            <div className="cal-editor__inline">
              <CalendarSelect
                form={form}
                onChange={setForm}
                lockAccount={editing}
                disabled={editing && spec.event?.recurring}
              />
              <ColorField
                value={form.colorId}
                calendarColor={calendarColor(calendar)}
                onChange={(colorId) => set({ colorId })}
              />
            </div>
          </Section>
          <Section icon={<Bell />} label="Notifications">
            <RemindersField form={form} onChange={setForm} />
          </Section>
          <Section icon={<Briefcase />} label="Availability and visibility">
            <div className="cal-editor__inline">
              <select
                className="cal-field cal-select"
                aria-label="Show as"
                value={form.transparency}
                onChange={(e) =>
                  set({ transparency: e.currentTarget.value as EventForm["transparency"] })
                }
              >
                <option value="opaque">Busy</option>
                <option value="transparent">Free</option>
              </select>
              <select
                className="cal-field cal-select"
                aria-label="Visibility"
                value={form.visibility}
                onChange={(e) =>
                  set({ visibility: e.currentTarget.value as EventForm["visibility"] })
                }
              >
                <option value="default">Default visibility</option>
                <option value="public">Public</option>
                <option value="private">Private</option>
                {form.visibility === "confidential" && (
                  <option value="confidential">Confidential</option>
                )}
              </select>
            </div>
          </Section>
        </div>
        {error && (
          <p className="cal-editor__error" role="alert">
            {error}
          </p>
        )}
        <div className="cal-editor__actions">
          <Button size="sm" variant="ghost" onClick={() => void close()}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Repeat ───────────────────────────────────────────────────────────────────

const FREQS: { value: Freq; one: string; many: string }[] = [
  { value: "DAILY", one: "day", many: "days" },
  { value: "WEEKLY", one: "week", many: "weeks" },
  { value: "MONTHLY", one: "month", many: "months" },
  { value: "YEARLY", one: "year", many: "years" },
];

function RepeatField({ form, onChange }: { form: EventForm; onChange(form: EventForm): void }) {
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
      <select
        className="cal-field cal-select"
        aria-label="Repeat"
        value={showCustom ? "custom" : choice}
        onChange={(e) => pick(e.currentTarget.value)}
      >
        <option value="none">Does not repeat</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {showCustom && form.repeat.kind === "rule" && (
        <CustomRepeat
          rule={form.repeat.rule}
          startDate={form.startDate}
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
  onChange,
}: {
  rule: RepeatRule;
  startDate: string;
  onChange(rule: RepeatRule): void;
}) {
  const id = useId();
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
        <select
          className="cal-field cal-select"
          aria-label="Repeat unit"
          value={rule.freq}
          onChange={(e) => {
            const freq = e.currentTarget.value as Freq;
            set({ freq, byDay: freq === "WEEKLY" ? [WEEKDAYS[weekday(startDate)]] : [] });
          }}
        >
          {FREQS.map((f) => (
            <option key={f.value} value={f.value}>
              {rule.interval === 1 ? f.one : f.many}
            </option>
          ))}
        </select>
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
        <select
          className="cal-field cal-select"
          aria-label="Repeat on"
          value={rule.byDay.length ? "weekday" : "day"}
          onChange={(e) => set({ byDay: e.currentTarget.value === "weekday" ? [nth] : [] })}
        >
          <option value="day">Monthly on day {Number(startDate.slice(8))}</option>
          <option value="weekday">
            Monthly on the {repeatPresets(startDate)[2].label.replace(/^Monthly on the /, "")}
          </option>
        </select>
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
          <input
            type="date"
            className="cal-field"
            aria-label="Ends on"
            disabled={rule.ends.kind !== "on"}
            min={startDate}
            value={rule.ends.kind === "on" ? rule.ends.date : addDays(startDate, 30)}
            onChange={(e) => {
              const date = e.currentTarget.value;
              if (/^\d{4}-\d{2}-\d{2}$/.test(date)) set({ ends: { kind: "on", date } });
            }}
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

// ── Colour ───────────────────────────────────────────────────────────────────

function ColorField({
  value,
  calendarColor: own,
  onChange,
}: {
  value: string;
  calendarColor: string;
  onChange(colorId: string): void;
}) {
  const options = [
    { id: "", name: "Calendar colour", color: own },
    ...Object.entries(EVENT_COLORS).map(([id, color]) => ({ id, name: COLOR_NAMES[id], color })),
  ];
  return (
    <div className="cal-colors" role="radiogroup" aria-label="Event colour">
      {options.map((o) => (
        <button
          key={o.id || "calendar"}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          aria-label={o.name}
          title={o.name}
          className={cx("cal-colors__swatch", o.id === "" && "cal-colors__swatch--calendar")}
          style={{ background: o.color }}
          onClick={() => onChange(o.id)}
        />
      ))}
    </div>
  );
}

// ── Notifications ────────────────────────────────────────────────────────────

function RemindersField({ form, onChange }: { form: EventForm; onChange(form: EventForm): void }) {
  const setList = (reminders: Reminder[]) =>
    onChange({ ...form, remindersDefault: false, reminders });
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
            key={i}
            className="cal-editor__inline"
            role="group"
            aria-label={`Notification ${i + 1}`}
          >
            <select
              className="cal-field cal-select"
              aria-label="Notify by"
              value={r.method}
              onChange={(e) => update({ method: e.currentTarget.value as Reminder["method"] })}
            >
              <option value="popup">Notification</option>
              <option value="email">Email</option>
            </select>
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
            <select
              className="cal-field cal-select"
              aria-label="Unit"
              value={r.unit}
              onChange={(e) => update({ unit: e.currentTarget.value as Reminder["unit"] })}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
            </select>
            <span>before</span>
            <IconButton
              size="sm"
              label="Remove notification"
              icon={<X />}
              onClick={() => setList(form.reminders.filter((_, j) => j !== i))}
            />
          </div>
        );
      })}
      <div className="cal-editor__inline">
        <Button
          size="sm"
          disabled={form.reminders.length >= MAX_REMINDERS}
          onClick={() =>
            setList([...form.reminders, { method: "popup", amount: 30, unit: "minutes" }])
          }
        >
          Add notification
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange({ ...form, remindersDefault: true, reminders: [] })}
        >
          Use the calendar's defaults
        </Button>
      </div>
    </div>
  );
}
