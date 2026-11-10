-- Event reminders Pheeme has shown (or dropped for the notification schedule), so a
-- restart or a re-plan never shows one twice. One row per reminder of an occurrence: a
-- moved event's reminders count as new. Rows older than a couple of days are pruned.
CREATE TABLE calendar_reminders_fired (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL,
  -- The occurrence's event id (Google's instance id for a repeating event).
  event_id TEXT NOT NULL,
  -- The occurrence's start (UTC ms; all-day events: midnight in the account's zone).
  start_ms INTEGER NOT NULL,
  -- How long before the start the reminder is.
  minutes INTEGER NOT NULL,
  fired_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, calendar_id, event_id, start_ms, minutes)
);

CREATE INDEX calendar_reminders_fired_at ON calendar_reminders_fired (fired_at);
