-- Phase 4: sync engine bookkeeping and the outbox.

ALTER TABLE messages ADD COLUMN rfc822_message_id TEXT;
CREATE INDEX idx_messages_rfc822 ON messages(account_id, rfc822_message_id);

-- Sender of the latest message, for the thread list.
ALTER TABLE threads ADD COLUMN from_name TEXT;
ALTER TABLE threads ADD COLUMN from_address TEXT;
ALTER TABLE threads ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0;

ALTER TABLE labels ADD COLUMN threads_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE labels ADD COLUMN threads_unread INTEGER NOT NULL DEFAULT 0;

CREATE TABLE sync_state (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  backfill_page_token TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  backfill_bodies_done INTEGER NOT NULL DEFAULT 0,
  -- Bumped on every reset, so a page fetched before the reset is discarded.
  backfill_generation INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER
);

-- Durable, ordered queue of local mutations waiting for Gmail.
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  -- pending_op_id and idempotency key.
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- 'modify' | 'trash' | 'send'
  kind TEXT NOT NULL,
  -- JSON: modify {"add":[..],"remove":[..]}; send {"raw":"<base64url>"}
  payload TEXT NOT NULL,
  -- 'pending' | 'checking' | 'unconfirmed' | 'failed'
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Unix milliseconds.
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  -- Sends: completed Sent searches that found nothing.
  checks_done INTEGER NOT NULL DEFAULT 0,
  -- Sends: client-generated Message-ID, with angle brackets.
  rfc822_message_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_outbox_account ON outbox(account_id, seq);

-- Messages an op targets, with each one's labels before the op (rollback data).
CREATE TABLE outbox_messages (
  op_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  prior_label_ids TEXT NOT NULL,
  PRIMARY KEY (op_id, message_id)
);
CREATE INDEX idx_outbox_messages_thread ON outbox_messages(account_id, thread_id);
