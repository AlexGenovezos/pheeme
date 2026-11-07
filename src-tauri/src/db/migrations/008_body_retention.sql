-- When a message's cached body was downloaded (ms since the epoch), NULL when no body is
-- cached. Bodies of mail older than the body window are dropped once they haven't been
-- downloaded for a while, so the cache stops growing (`db::messages::trim_old_bodies`).
ALTER TABLE messages ADD COLUMN body_fetched_at INTEGER;

-- Bodies cached before this column existed count as downloaded now, so an old email
-- opened just before the upgrade isn't dropped the moment the app starts.
UPDATE messages SET body_fetched_at = unixepoch() * 1000
WHERE fully_fetched = 1 OR body_html IS NOT NULL OR body_text IS NOT NULL;

-- Only the few thousand messages with a cached body, so the trim doesn't scan the whole
-- mailbox; `date` is included so it never reads the rows (bodies sit before `date`).
CREATE INDEX idx_messages_body_fetched ON messages(body_fetched_at, date)
WHERE body_fetched_at IS NOT NULL;
