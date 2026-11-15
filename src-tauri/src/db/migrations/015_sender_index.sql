-- A sender's mail, newest first: the sender report looks up each top sender's latest message
-- (for its unsubscribe header), which walked every message in the window once per sender.
CREATE INDEX idx_messages_sender ON messages(account_id, lower(from_address), date);
