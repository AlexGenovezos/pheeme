CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  profile_photo_url TEXT,
  client_id TEXT NOT NULL,
  history_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE labels (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  message_list_visibility TEXT,
  label_list_visibility TEXT,
  color_background TEXT,
  color_text TEXT,
  messages_total INTEGER NOT NULL DEFAULT 0,
  messages_unread INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, account_id)
);

CREATE TABLE threads (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject TEXT,
  snippet TEXT,
  history_id TEXT,
  last_message_date INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  has_attachment INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, account_id)
);

CREATE TABLE messages (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  label_ids TEXT,
  from_address TEXT,
  from_name TEXT,
  to_addresses TEXT,
  cc_addresses TEXT,
  subject TEXT,
  snippet TEXT,
  body_html TEXT,
  body_text TEXT,
  date INTEGER,
  size_estimate INTEGER,
  has_attachment INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 1,
  is_starred INTEGER NOT NULL DEFAULT 0,
  raw_headers TEXT,
  fully_fetched INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, account_id)
);

CREATE TABLE attachments (
  id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  attachment_id TEXT,
  PRIMARY KEY (id, message_id, account_id),
  FOREIGN KEY (message_id, account_id) REFERENCES messages(id, account_id) ON DELETE CASCADE
);

CREATE TABLE thread_labels (
  account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  last_message_date INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, thread_id, label_id),
  FOREIGN KEY (thread_id, account_id) REFERENCES threads(id, account_id) ON DELETE CASCADE
);

CREATE INDEX idx_threads_date ON threads(last_message_date DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id, account_id);
CREATE INDEX idx_messages_date ON messages(date DESC);
CREATE INDEX idx_thread_labels_listing
  ON thread_labels(label_id, last_message_date DESC, account_id DESC, thread_id DESC);
