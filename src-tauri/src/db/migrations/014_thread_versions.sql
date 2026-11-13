-- A number per account that grows whenever its threads or their labels change (bumped by
-- `threads::recompute_threads` in the same transaction), so `label_counts` can answer again
-- from its last count while nothing changed: counting a large mailbox takes seconds, and the
-- sidebar asks after every sync of every account.
CREATE TABLE thread_versions (
  account_id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL
);
