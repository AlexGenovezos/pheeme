# Calendar event templates (#262)

## Why

People re-create the same events again and again ("1:1 with Sam", "Gym 45m"), and each time they fill in the
editor's guests, place, calendar, video call and reminders by hand. A template saves those once, so a new event
from it needs only a time.

## Goals

- **Save as template** from any event you can open: the name defaults to the event's title.
- **Use** a template from quick add (Create, `c`), by typing its name or picking it, and from the command
  palette.
- **Manage** templates in Settings › Calendar: rename and delete.

## Non-goals

- Syncing templates between devices: that waits for settings sync (#267). Templates live on this computer.
- The tray mini window (#253) doesn't exist yet. It can use templates once it's built.
- Repeating templates, and templates that fix a time of day. The sentence or the editor gives the time.
- Editing a template's fields in Settings. To change one, save it again from an event under the same name.
- MCP tools for templates in this change. The service is Tauri-free so a `local_api` tool can call it later
  without touching storage.

## Anti-goals

- Nothing a template does reaches Google until an event is saved from it. No hidden calendar, no extra writes.
- Quick add must not get worse for sentences that don't use a template: a name only counts as a template
  when it starts the sentence and matches a whole word or words.

## Approaches

- **A. Browser storage, frontend only.** Templates in localStorage, like `zoneSettings.ts`. The least to build,
  but out of reach of the Rust side, so assistants could never use them.
- **B. SQLite through a Rust service (chosen by Alex).** A table, a Tauri-free service and four commands. It
  costs a migration, IPC and preview fakes, and in return templates sit with the rest of Pheeme's data, where
  MCP assistants and a future settings sync (#267) can reach them.
- **C. A hidden Google calendar holding template events.** It syncs for free, but shows up in Google Calendar
  everywhere and turns templates into real events. Rejected.

## Design

### What a template holds

The `EventForm` fields that don't depend on when the event is: title, all-day, length (minutes, or days for
all-day), account and calendar, guests (name, address, optional), the three guest permissions, Google Meet
on/off, place, notes, colour, reminders (the calendar's default or a list), busy/free and visibility. It isn't
the stored series: no repeat, `extraLines` or resources.

- A template with Meet on gives each new event a new Meet link. Other video links in the place or notes are
  copied as text. Personal Zoom rooms are reused that way, which is what people want.
- If the template's calendar is no longer writable (an account removed, access lost), a new event falls back
  to `defaultCalendar()`. Templates don't cascade from accounts.

### Storage (Rust)

- **Migration `018_event_templates.sql`:** `event_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL,
  fields TEXT NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)` with a unique index on
  `name COLLATE NOCASE`. `fields` is the JSON of a serde struct (`TemplateFields`), so the shape is checked on
  the way in and a later field gets `#[serde(default)]`.
- **`db/templates.rs`:** list (by name), get, insert, replace by name, rename, delete, with `query_as!` and
  `cargo sqlx prepare`.
- **`calendar/templates.rs`, `TemplateService`, Tauri-free:** `list`, `save(name, fields, replace)`,
  `rename(id, name)`, `delete(id)`. It trims names (1–80 characters) and rejects a taken name with the code
  `exists` (or replaces when `replace` is set) and an empty one with `invalid`. Undoing a delete saves the
  returned template again.
- **Commands** in `commands/calendar.rs`: `event_templates`, `save_event_template`, `rename_event_template`,
  `delete_event_template`, all local (no Gmail, no `user_action`). No event: only the main window uses
  templates, and its store updates itself from each command's answer. An assistant tool that writes them
  later adds one.
- **Frontend:** the commands in `Commands` and wrappers in `src/lib/ipc/calendarEvents.ts` (or the calendar
  file that fits), a small `templatesStore` loaded when Calendar mode or Settings › Calendar first needs it,
  and preview fakes in `src/preview/` that keep templates in memory. `src/calendar/templates.ts` (pure,
  tested) holds `templateFromForm(form)` and `formFromTemplate(template, times, zone, fallback)`.

### Saving

- The event popover's Options menu gets **Save as template…** next to Duplicate. It loads the detail and
  opens a small dialog: a name field (the title by default) and one line saying what it keeps ("45 min ·
  Work · 2 guests · Google Meet"). Save adds it, and a toast confirms.
- Saving under a name that exists asks whether to replace it.
- Works for events you can't edit too: like Duplicate, it only reads them.

### Using

- **Quick add.** `parseQuickAdd` takes a `templates` option. When the sentence starts with a template's
  name (case-insensitive, whole words, longest name wins), that part is a new `template` span and is
  highlighted. The event starts from the template; the rest of the sentence still sets the time, length,
  place, `/calendar` and repeat, and its "with" people are added to the template's guests. The title is the
  template's title, followed by any words the sentence leaves over ("gym legs tomorrow 7am" → "Gym legs").
  With no time in the sentence, it uses `defaultTimes()` with the template's length.
- **Create.** The templates show under the quick add field as one row of buttons (alphabetical, cut off
  where the row ends), the one in use pressed. Clicking one starts the sentence with its name, in place of
  the template it named, ready for a time. With no templates, the row isn't there.
- **Palette.** One command per template, "New event from template: Gym" (`calendar.template:<id>`, in the
  Calendar group, no default key), opens the full editor with the template at `defaultTimes()`. Only
  registered in Calendar mode, like the other calendar commands. Usage stats count them all as
  `calendar.template`, never by id.

### Managing

Settings › Calendar gets a **Templates** section, drawn by its own block (`SettingsBlockDef`): each template
on one row with its name, the summary line and a menu with Rename and Delete. Delete has no confirmation and
shows a toast with Undo. With no templates, one line explains how to make one ("Open an event and choose
Save as template… from its Options menu").

### Docs

CLAUDE.md: the `calendar/` row of the module table, the Calendar mode paragraph, and the schema list
(twenty-seven tables, `event_templates`). The release notes come with the release.

## Left to the builder

- Wording of the dialog, toasts and Settings text, in the app's voice.
- Exactly how the buttons under quick add look, within the no-layout-shift rule.
- Test placement: Rust unit tests in `calendar/templates.rs` (names, conflicts, replace, rename, unknown
  JSON fields), `templates.test.ts` for the conversions, `sentence.test.ts` for the template span, one
  component test for Save as template and one for quick add from a template.
