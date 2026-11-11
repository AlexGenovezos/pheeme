-- Calendar mode: each account's Google calendars and their events, cached for instant,
-- offline views. Repeating events are stored as the series (`recurrence`) plus its changed
-- or cancelled occurrences (`recurring_event_id`); occurrences are expanded when read.

CREATE TABLE calendars (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT,
  time_zone TEXT,
  background_color TEXT,
  foreground_color TEXT,
  -- owner, writer, reader or freeBusyReader.
  access_role TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  -- Unticked in Pheeme's sidebar (local only).
  hidden INTEGER NOT NULL DEFAULT 0,
  -- JSON array of {method, minutes}.
  default_reminders TEXT NOT NULL DEFAULT '[]',
  -- Calendar API events.list nextSyncToken; NULL means sync it in full.
  sync_token TEXT,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE events (
  account_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  id TEXT NOT NULL,
  ical_uid TEXT,
  -- Set on a changed or cancelled occurrence of a series: the series' event id.
  recurring_event_id TEXT,
  -- The occurrence's start before it was changed (ms, or a date for all-day series).
  original_start_ms INTEGER,
  original_start_date TEXT,
  -- confirmed, tentative or cancelled (only occurrences are kept cancelled).
  status TEXT NOT NULL,
  -- UTC ms. All-day events also carry UTC midnight of their dates here, for range queries.
  start_ms INTEGER,
  end_ms INTEGER,
  -- All-day events: YYYY-MM-DD, end exclusive.
  start_date TEXT,
  end_date TEXT,
  time_zone TEXT,
  -- JSON array of RRULE/EXDATE/RDATE lines; set on a series.
  recurrence TEXT,
  -- When a series ends (ms); NULL for one that never does.
  recur_until_ms INTEGER,
  summary TEXT,
  location TEXT,
  description TEXT,
  organizer_email TEXT,
  -- needsAction, declined, tentative or accepted.
  self_response TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',
  conference TEXT,
  color_id TEXT,
  transparency TEXT,
  visibility TEXT,
  reminders TEXT,
  html_link TEXT,
  etag TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  -- The whole Calendar API resource, for fields not modelled above.
  raw TEXT NOT NULL,
  PRIMARY KEY (account_id, calendar_id, id),
  FOREIGN KEY (account_id, calendar_id) REFERENCES calendars(account_id, id) ON DELETE CASCADE
);

CREATE INDEX events_start ON events (start_ms);
CREATE INDEX events_ical_uid ON events (account_id, ical_uid);
CREATE INDEX events_series ON events (account_id, calendar_id, recurring_event_id);
CREATE INDEX events_masters ON events (start_ms) WHERE recurrence IS NOT NULL;

CREATE TABLE calendar_access (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- unknown, on, missing_scope, api_disabled or error.
  status TEXT NOT NULL,
  -- api_disabled: the Google Cloud project number, when Google said; error: what failed.
  detail TEXT,
  checked_at INTEGER NOT NULL,
  -- The last sync that worked.
  synced_at INTEGER,
  -- When the calendar list and settings were last read.
  settings_checked_at INTEGER,
  -- The user's Google Calendar settings.
  time_zone TEXT,
  -- 0 Sunday, 1 Monday, 6 Saturday.
  week_start INTEGER
);
