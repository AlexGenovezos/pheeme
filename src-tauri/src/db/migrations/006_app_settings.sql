-- App-wide preferences the Rust side needs before the window loads (for example the Gmail
-- quota sync paces itself by). One row per setting; values are text.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
