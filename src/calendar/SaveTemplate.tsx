// Save as template (an event popover's Options menu): name the event's details, so a new event
// from them needs only a time. A name in use asks to replace that template, in the same dialog.
import { type FormEvent, useCallback, useId, useMemo, useState } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { TextInput } from "../components/ui/TextInput";
import { toast } from "../components/ui/Toast";
import { toCommandError } from "../lib/tauri";
import { closeSaveTemplate, writableCalendars } from "./actions";
import { useCalendarStore } from "./calendarStore";
import { useEditStore } from "./editStore";
import type { EventForm } from "./eventForm";
import { describeTemplate, templateFields } from "./templates";
import { saveTemplate } from "./templatesStore";
import "../components/ui/Surface.css";

export function SaveTemplate() {
  const form = useEditStore((s) => s.templateFrom);
  return form ? <SaveTemplateDialog form={form} /> : null;
}

/**
 * The name of the calendar new events from a template go on: null for the default one, undefined
 * while the calendars haven't been read (Settings before Calendar mode was opened).
 */
export function useCalendarNames() {
  const accounts = useCalendarStore((s) => s.accounts);
  return useCallback(
    (accountId: string | null, calendarId: string | null): string | null | undefined => {
      if (accounts === null) return undefined;
      const found = writableCalendars(accounts).find(
        (w) => w.account.accountId === accountId && w.calendar.id === calendarId,
      );
      if (!found) return null;
      return found.calendar.primary ? found.account.email : found.calendar.summary;
    },
    [accounts],
  );
}

function SaveTemplateDialog({ form }: { form: EventForm }) {
  const titleId = useId();
  const fields = useMemo(() => templateFields(form), [form]);
  const [name, setName] = useState(fields.summary);
  /** The name of the template a save would replace, once the user was told about it. */
  const [taken, setTaken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const calendarName = useCalendarNames()(fields.accountId, fields.calendarId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    try {
      const saved = await saveTemplate(name, fields, taken !== null);
      closeSaveTemplate();
      toast({
        title: `Saved template “${saved.name}”`,
        description: "Type its name in quick add, or find it in the command palette.",
      });
    } catch (err) {
      const e = toCommandError(err);
      if (e.code === "exists") {
        setTaken(name.trim());
        setError(`${e.message} Replace it, or choose another name.`);
      } else setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Save as template"
      titleId={titleId}
      onClose={closeSaveTemplate}
      scrimClassName="cal-dialog-scrim dialog-scrim"
      className="cal-prompt dialog-surface"
      titleClassName="cal-prompt__title"
    >
      <form className="cal-prompt__form" onSubmit={(e) => void submit(e)}>
        <p className="cal-prompt__message">{describeTemplate(fields, calendarName)}</p>
        <TextInput
          aria-label="Template name"
          placeholder="Name"
          maxLength={80}
          value={name}
          invalid={error !== null}
          data-autofocus=""
          onChange={(e) => {
            setName(e.currentTarget.value);
            setTaken(null);
            setError(null);
          }}
        />
        {/* Always there, so the dialog doesn't grow when a name is refused. */}
        <p className="cal-template__error" role="alert">
          {error ?? " "}
        </p>
        <div className="cal-prompt__actions">
          <Button size="sm" variant="ghost" onClick={closeSaveTemplate}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={saving || !name.trim()}>
            {taken ? "Replace" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
