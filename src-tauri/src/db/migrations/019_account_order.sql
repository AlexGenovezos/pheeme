-- Accounts in the order the user drags them into, each with a colour they can pick (1–12, the
-- `--color-account-N` theme tokens). Existing accounts keep the order they were added in and
-- the colour that order gave them (the first six cycling), so nothing changes until the user
-- moves or recolours one.
ALTER TABLE accounts ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN color INTEGER NOT NULL DEFAULT 1;

UPDATE accounts SET position = (
  SELECT COUNT(*) FROM accounts AS earlier
  WHERE earlier.created_at < accounts.created_at
     OR (earlier.created_at = accounts.created_at AND earlier.id < accounts.id)
);
UPDATE accounts SET color = (position % 6) + 1;
