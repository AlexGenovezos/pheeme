-- Calendar event templates (`calendar/templates.rs`): an event's details saved under a name,
-- so a new event made from it needs only a time. Local to this computer; nothing here is sent
-- to Google until an event is created from a template. `fields` is the JSON of
-- `TemplateFields`, checked on the way in. Not tied to an account: a template whose calendar
-- is gone puts new events on the default calendar instead.
CREATE TABLE event_templates (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  fields TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

-- One template per name, whatever its capitals.
CREATE UNIQUE INDEX event_templates_name ON event_templates (name COLLATE NOCASE);
