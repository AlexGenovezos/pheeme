-- Anonymous usage counts waiting to be sent with the daily usage report (`telemetry.rs`):
-- per local day, how often each screen was opened and how long it was on screen, and how
-- often each command ran by shortcut, palette or button. Names are fixed strings the app
-- defines, never user content. A day's rows are deleted once the report is accepted, and
-- all of them when usage stats are turned off.
CREATE TABLE usage_counts (
  day TEXT NOT NULL,
  -- `screen`, `key`, `palette` or `button`.
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  -- Time on screen; 0 for commands.
  ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, name)
) WITHOUT ROWID;
