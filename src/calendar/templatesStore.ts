// The saved event templates (`calendar/templates.rs` keeps them): read once when something first
// needs them, then kept in step with each change made here. Saving and renaming reject as the
// command does (`exists` for a taken name), so the dialog can say so; deleting has Undo.
import { useEffect } from "react";
import { create } from "zustand";
import { toast } from "../components/ui/Toast";
import {
  deleteEventTemplate,
  type EventTemplate,
  listEventTemplates,
  renameEventTemplate,
  saveEventTemplate,
  type TemplateFields,
  toCommandError,
} from "../lib/tauri";
import { byName } from "./templates";

interface TemplatesState {
  /** `null` until read. */
  templates: EventTemplate[] | null;
}

export const useTemplatesStore = create<TemplatesState>(() => ({ templates: null }));

let reading: Promise<void> | null = null;

/** Read the templates; a read already under way is shared. */
export function loadTemplates(): Promise<void> {
  reading ??= listEventTemplates()
    .then((list) => useTemplatesStore.setState({ templates: byName(list) }))
    .catch((e: unknown) => {
      // Shown as none: quick add and the palette work without them.
      useTemplatesStore.setState({ templates: [] });
      console.warn("couldn't read event templates", e);
    })
    .finally(() => {
      reading = null;
    });
  return reading;
}

/** The templates, read when first asked for. */
export function useTemplates(): EventTemplate[] | null {
  const templates = useTemplatesStore((s) => s.templates);
  useEffect(() => {
    if (templates === null) void loadTemplates();
  }, [templates]);
  return templates;
}

function put(saved: EventTemplate) {
  useTemplatesStore.setState((s) => ({
    templates: byName([...(s.templates ?? []).filter((t) => t.id !== saved.id), saved]),
  }));
}

/** Save `fields` as `name`; rejects with `exists` when that name is taken, unless `replace`. */
export async function saveTemplate(
  name: string,
  fields: TemplateFields,
  replace: boolean,
): Promise<EventTemplate> {
  const saved = await saveEventTemplate(name, fields, replace);
  put(saved);
  return saved;
}

export async function renameTemplate(id: string, name: string): Promise<EventTemplate> {
  const renamed = await renameEventTemplate(id, name);
  put(renamed);
  return renamed;
}

/** Delete a template, with Undo on the toast (it's saved again under its name). */
export async function deleteTemplate(t: EventTemplate): Promise<void> {
  try {
    await deleteEventTemplate(t.id);
  } catch (e) {
    toast({
      title: "Couldn't delete the template",
      description: toCommandError(e).message,
      tone: "danger",
    });
    return;
  }
  useTemplatesStore.setState((s) => ({
    templates: (s.templates ?? []).filter((x) => x.id !== t.id),
  }));
  toast({
    title: `Deleted “${t.name}”`,
    action: {
      label: "Undo",
      run: () =>
        void saveTemplate(t.name, t.fields, false).catch((e: unknown) =>
          toast({
            title: `Couldn't bring back “${t.name}”`,
            description: toCommandError(e).message,
            tone: "danger",
          }),
        ),
    },
  });
}
