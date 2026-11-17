// Browser preview: event templates kept in memory, refusing a taken name or a missing template the
// way `calendar/templates.rs` does. Two to start with on the first account's primary calendar;
// `?templates=none` starts with none.
import type { EventTemplate, TemplateFields } from "../lib/tauri";
import type { PartialHandlers } from "./handlers";

const fields = (
  account: { id: string; email: string } | undefined,
  f: Partial<TemplateFields>,
) => ({
  summary: "",
  allDay: false,
  length: 60,
  accountId: account?.id ?? null,
  calendarId: account?.email ?? null,
  guests: [],
  guestsCanModify: false,
  guestsCanInviteOthers: true,
  guestsCanSeeOtherGuests: true,
  meet: false,
  location: "",
  description: "",
  colorId: "",
  remindersDefault: true,
  reminders: [],
  transparency: "opaque" as const,
  visibility: "default" as const,
  ...f,
});

export function createTemplateHandlers(
  accounts: { id: string; email: string }[],
  param: string | null,
) {
  const [first] = accounts;
  let templates: EventTemplate[] =
    param === "none" || !first
      ? []
      : [
          {
            id: "tpl-gym",
            name: "Gym",
            updatedMs: 0,
            fields: fields(first, {
              summary: "Gym",
              length: 45,
              location: "Mission Cliffs",
              colorId: "10",
              remindersDefault: false,
              reminders: [{ method: "popup", minutes: 15 }],
            }),
          },
          {
            id: "tpl-sam",
            name: "1:1 with Sam",
            updatedMs: 0,
            fields: fields(first, {
              summary: "1:1 with Sam",
              length: 30,
              guests: [{ name: "Sam Rivera", address: "sam@example.com", optional: false }],
              meet: true,
            }),
          },
        ];
  let next = 1;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const byName = () =>
    [...templates].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const clean = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) throw { code: "invalid_input", message: "Give the template a name." };
    return trimmed;
  };
  const exists = (name: string) => ({
    code: "exists",
    message: `There's already a template called “${name}”.`,
  });
  const missing = () => ({ code: "not_found", message: "That template isn't there any more." });

  return {
    event_templates: () => byName(),
    save_event_template: ({ name, fields: f, replace }) => {
      const clean_ = clean(name);
      const taken = templates.find((t) => same(t.name, clean_));
      if (taken && !replace) throw exists(taken.name);
      const saved: EventTemplate = {
        id: taken?.id ?? `tpl-${next++}`,
        name: clean_,
        fields: f,
        updatedMs: Date.now(),
      };
      templates = [...templates.filter((t) => t.id !== saved.id), saved];
      return saved;
    },
    rename_event_template: ({ id, name }) => {
      const clean_ = clean(name);
      const t = templates.find((x) => x.id === id);
      if (!t) throw missing();
      const other = templates.find((x) => x.id !== id && same(x.name, clean_));
      if (other) throw exists(other.name);
      const renamed = { ...t, name: clean_, updatedMs: Date.now() };
      templates = templates.map((x) => (x.id === id ? renamed : x));
      return renamed;
    },
    delete_event_template: ({ id }) => {
      if (!templates.some((t) => t.id === id)) throw missing();
      templates = templates.filter((t) => t.id !== id);
    },
  } satisfies PartialHandlers;
}
