// The full event editor, a dialog over the app like Settings: title, when (all day, time zones),
// repeat (the website's presets and Custom), guests with suggestions and what they may do, Google
// Meet, place, description, calendar and colour, notifications, busy/free and visibility.
import {
  AlignLeft,
  Bell,
  Briefcase,
  CalendarClock,
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
import { Select } from "../components/ui/Select";
import { TextInput } from "../components/ui/TextInput";
import { RecipientField } from "../compose/RecipientField";
import { type EmailAddress, suggestContacts } from "../lib/tauri";
import { structuralEqual } from "../lib/structuralEqual";
import { closeEditor, saveEditor } from "./actions";
import { AvailabilityPlanner } from "./AvailabilityPlanner";
import { displayZone, useCalendarStore } from "./calendarStore";
import { calendarColor } from "./colors";
import { ColorField } from "./ColorField";
import { ask, type EditorSpec, useEditStore } from "./editStore";
import { CalendarSelect, TimeFields } from "./EventFields";
import { type EventForm, formTimes, hasOtherGuests, otherCall } from "./eventForm";
import { RemindersField } from "./RemindersField";
import { RepeatField } from "./RepeatField";
import "../compose/compose.css";
import "../components/ui/Surface.css";

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
  const [planner, setPlanner] = useState(false);
  const accounts = useCalendarStore((s) => s.accounts);
  const account = accounts?.find((a) => a.accountId === form.accountId);
  const calendar = account?.calendars.find((c) => c.id === form.calendarId);
  const set = (patch: Partial<EventForm>) => setForm((f) => ({ ...f, ...patch }));
  const suggest = useCallback(
    (query: string) => suggestContacts(form.accountId, query),
    [form.accountId],
  );
  const editing = spec.event !== null;
  // Another provider's call (Zoom, Teams, …): shown as it is. One that's the event's conference
  // leaves no room for Meet (Google keeps one conference per event), so Meet isn't offered.
  const call = editing && spec.detail ? otherCall(spec.detail) : null;
  const otherConference = call !== null && spec.detail!.hasConference;
  const dirty = !structuralEqual(form, spec.form);
  // The event's time as saved: Google counts it as busy, so the planner leaves it out.
  const savedSpan = useMemo(() => {
    if (!editing || spec.form.allDay) return null;
    const { start, end } = formTimes(spec.form);
    return {
      startMs: start!.ms!,
      endMs: end!.ms!,
      guests: spec.form.guests.map((g) => g.address),
    };
  }, [editing, spec.form]);

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
    const result = await saveEditor(spec, form);
    // A user who backed out of a question stays in the editor as it was.
    if (result.kind === "failed") setError(result.message);
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
      scrimClassName="cal-dialog-scrim dialog-scrim"
      className="cal-editor dialog-surface"
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
          {!form.allDay && hasOtherGuests(form.guests, account?.email) && (
            <Section icon={<CalendarClock />} label="Check availability">
              <div className="cal-editor__inline">
                <Button size="sm" aria-expanded={planner} onClick={() => setPlanner((o) => !o)}>
                  {planner ? "Hide availability" : "Check availability"}
                </Button>
              </div>
              {planner && (
                <AvailabilityPlanner
                  form={form}
                  onChange={setForm}
                  tz={displayZone(accounts)}
                  selfEmail={account?.email ?? null}
                  saved={savedSpan}
                />
              )}
            </Section>
          )}
          <Section icon={<Video />} label="Google Meet">
            {otherConference ? null : form.meet ? (
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
            {call && (
              // Another provider's call: shown as it is, changed only where it was made.
              <div className="cal-editor__inline">
                <span>
                  {call.provider ?? "Video call"}: {call.url.replace(/^https?:\/\//, "")}
                </span>
              </div>
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
              <Select
                className="cal-select"
                aria-label="Show as"
                value={form.transparency}
                options={TRANSPARENCY}
                onChange={(transparency) => set({ transparency })}
              />
              <Select
                className="cal-select"
                aria-label="Visibility"
                value={form.visibility}
                options={
                  form.visibility === "confidential"
                    ? [...VISIBILITY, { value: "confidential" as const, label: "Confidential" }]
                    : VISIBILITY
                }
                onChange={(visibility) => set({ visibility })}
              />
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

const TRANSPARENCY: { value: EventForm["transparency"]; label: string }[] = [
  { value: "opaque", label: "Busy" },
  { value: "transparent", label: "Free" },
];
const VISIBILITY: { value: EventForm["visibility"]; label: string }[] = [
  { value: "default", label: "Default visibility" },
  { value: "public", label: "Public" },
  { value: "private", label: "Private" },
];
