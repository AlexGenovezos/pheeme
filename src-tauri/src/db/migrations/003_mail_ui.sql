-- Phase 6: inline attachment metadata, and an index for the account-wide thread list.

-- Content-ID without angle brackets, for resolving `cid:` URLs in HTML bodies.
ALTER TABLE attachments ADD COLUMN content_id TEXT;
-- Embedded in the body (has a Content-ID and is not marked `attachment`).
ALTER TABLE attachments ADD COLUMN is_inline INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_attachments_content_id ON attachments(account_id, message_id, content_id);

CREATE INDEX idx_threads_account_date ON threads(account_id, last_message_date DESC, id DESC);
