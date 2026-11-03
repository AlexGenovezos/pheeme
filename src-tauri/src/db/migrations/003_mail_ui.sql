-- Phase 6: inline attachment metadata, and an index for the account-wide thread list.

-- Content-ID without angle brackets, for resolving `cid:` URLs in HTML bodies.
ALTER TABLE attachments ADD COLUMN content_id TEXT;
-- Embedded in the body (has a Content-ID and is not marked `attachment`).
ALTER TABLE attachments ADD COLUMN is_inline INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_attachments_content_id ON attachments(account_id, message_id, content_id);

-- Rows cached before this migration have no Content-IDs. Mark their messages as not fully
-- fetched so opening the thread re-fetches them (`load_thread_bodies`) and rewrites the
-- attachment rows. The cached bodies stay in place until then.
UPDATE messages SET fully_fetched = 0
WHERE EXISTS (
  SELECT 1 FROM attachments a
  WHERE a.account_id = messages.account_id AND a.message_id = messages.id
);

CREATE INDEX idx_threads_account_date ON threads(account_id, last_message_date DESC, id DESC);
