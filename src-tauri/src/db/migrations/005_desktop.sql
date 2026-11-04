-- Opt in per account. Settings disappear with the account; tokens never live here.
CREATE TABLE notification_settings (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
);
