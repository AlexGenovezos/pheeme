-- Google Tasks: each account's task lists and their tasks, cached for instant, offline reads.
-- The Tasks API has no sync token: lists are polled with `updatedMin` and listed in full
-- every 6 hours. Access is tracked apart from `calendar_access`, so a Tasks API that is off
-- never affects the calendar.

CREATE TABLE task_lists (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  -- Google's order of the account's lists.
  sort_order INTEGER NOT NULL,
  etag TEXT,
  updated_ms INTEGER,
  -- Unticked in Pheeme's sidebar (local only): its dated tasks stay off the calendar.
  hidden INTEGER NOT NULL DEFAULT 0,
  -- The newest task `updated` seen in the list (ms): the next poll's `updatedMin`.
  synced_through_ms INTEGER,
  -- When the list was last read in full (ms); NULL means read it in full next.
  full_synced_at INTEGER,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE tasks (
  account_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  id TEXT NOT NULL,
  -- The parent task, for a subtask.
  parent TEXT,
  -- Sorts the task among its siblings (string order).
  position TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  -- YYYY-MM-DD; Google Tasks has no due times.
  due_date TEXT,
  -- needsAction or completed.
  status TEXT NOT NULL,
  completed_ms INTEGER,
  updated_ms INTEGER NOT NULL,
  -- Completed and cleared from the list's view.
  hidden INTEGER NOT NULL DEFAULT 0,
  etag TEXT NOT NULL,
  -- The whole Tasks API resource, for fields not modelled above.
  raw TEXT NOT NULL,
  PRIMARY KEY (account_id, list_id, id),
  FOREIGN KEY (account_id, list_id) REFERENCES task_lists(account_id, id) ON DELETE CASCADE
);

CREATE INDEX tasks_due ON tasks (due_date) WHERE due_date IS NOT NULL;

CREATE TABLE tasks_access (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- on, missing_scope, api_disabled or error (no row: never checked).
  status TEXT NOT NULL,
  -- api_disabled: the Google Cloud project number, when Google said; error: what failed.
  detail TEXT,
  checked_at INTEGER NOT NULL,
  -- The last sync that worked.
  synced_at INTEGER
);
