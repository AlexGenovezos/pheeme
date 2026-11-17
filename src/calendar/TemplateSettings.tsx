// Settings › Calendar › Event templates: each saved template with what it fills in, renamed in
// place or deleted (with Undo). Templates are made from an event's Options menu, not here.
import { type FormEvent, useState } from "react";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { TextInput } from "../components/ui/TextInput";
import { type EventTemplate, toCommandError } from "../lib/tauri";
import { PendingButton, SettingsRow, SettingsSection } from "../settings/rows";
import { useCalendarNames } from "./SaveTemplate";
import { describeTemplate } from "./templates";
import { deleteTemplate, renameTemplate, useTemplates, useTemplatesStore } from "./templatesStore";

/** Whether a settings search finds a template by its name. */
export function templatesMatch(query: string): boolean {
  const q = query.trim().toLowerCase();
  return (
    q !== "" &&
    (useTemplatesStore.getState().templates ?? []).some((t) => t.name.toLowerCase().includes(q))
  );
}

export function TemplateSettings() {
  const templates = useTemplates();
  const calendarName = useCalendarNames();
  return (
    <SettingsSection title="Event templates">
      {templates === null && (
        <SettingsRow
          title={<Skeleton width="8em" />}
          description={<Skeleton width="14em" />}
          control={<PendingButton />}
        />
      )}
      {templates?.length === 0 && (
        <SettingsRow
          title="No templates yet"
          description="Open an event and choose Save as template… from its Options menu. Then type the template's name in quick add, like “Gym tomorrow at 7”."
        />
      )}
      {templates?.map((t) => (
        <TemplateRow
          key={t.id}
          template={t}
          summary={describeTemplate(
            t.fields,
            calendarName(t.fields.accountId, t.fields.calendarId),
          )}
        />
      ))}
    </SettingsSection>
  );
}

function TemplateRow({ template, summary }: { template: EventTemplate; summary: string }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (editing === null || busy) return;
    setBusy(true);
    try {
      await renameTemplate(template.id, editing);
      setEditing(null);
      setError(null);
    } catch (err) {
      setError(toCommandError(err).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    setEditing(null);
    setError(null);
  };

  if (editing !== null)
    return (
      <form onSubmit={(e) => void save(e)}>
        <SettingsRow
          title={
            <TextInput
              aria-label={`New name for ${template.name}`}
              maxLength={80}
              value={editing}
              invalid={error !== null}
              autoFocus
              onChange={(e) => {
                setEditing(e.currentTarget.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  cancel();
                }
              }}
            />
          }
          description={error ?? summary}
          control={
            <>
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" type="submit" disabled={busy || !editing.trim()}>
                Save
              </Button>
            </>
          }
        />
      </form>
    );
  return (
    <SettingsRow
      title={template.name}
      description={summary}
      control={
        <>
          <Button
            size="sm"
            aria-label={`Rename ${template.name}`}
            onClick={() => setEditing(template.name)}
          >
            Rename
          </Button>
          <Button
            size="sm"
            variant="danger"
            aria-label={`Delete ${template.name}`}
            onClick={() => void deleteTemplate(template)}
          >
            Delete
          </Button>
        </>
      }
    />
  );
}
