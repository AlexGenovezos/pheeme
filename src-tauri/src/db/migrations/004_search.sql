-- Phase 8: local full-text search and recent searches.

-- What the index sees for each message. Addresses are stored as JSON
-- (`[{"name":..,"address":..}]`); the keys are stripped so searching "name" or
-- "address" doesn't match every message. The triggers below must compute exactly the
-- same values (FTS5 needs the old values to delete a row from the index).
CREATE VIEW messages_search (msg_rowid, subject, sender, recipients, cc, snippet, body_text) AS
SELECT rowid, subject, concat_ws(' ', from_name, from_address),
       replace(replace(replace(to_addresses, '"name":null', ''), '"name":', ''), '"address":', ''),
       replace(replace(replace(cc_addresses, '"name":null', ''), '"name":', ''), '"address":', ''),
       snippet, body_text
FROM messages;

-- External-content index keyed by `messages.rowid`. `messages` has no INTEGER PRIMARY
-- KEY, so a VACUUM may renumber its rowids: never VACUUM without running
-- `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')` afterwards.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, sender, recipients, cc, snippet, body_text,
  content = 'messages_search',
  content_rowid = 'msg_rowid',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

-- Kept in step by triggers, so every message write updates the index in the same
-- transaction.
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, subject, sender, recipients, cc, snippet, body_text)
  VALUES (
    new.rowid, new.subject, concat_ws(' ', new.from_name, new.from_address),
    replace(replace(replace(new.to_addresses, '"name":null', ''), '"name":', ''), '"address":', ''),
    replace(replace(replace(new.cc_addresses, '"name":null', ''), '"name":', ''), '"address":', ''),
    new.snippet, new.body_text
  );
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, subject, sender, recipients, cc, snippet, body_text)
  VALUES (
    'delete', old.rowid, old.subject, concat_ws(' ', old.from_name, old.from_address),
    replace(replace(replace(old.to_addresses, '"name":null', ''), '"name":', ''), '"address":', ''),
    replace(replace(replace(old.cc_addresses, '"name":null', ''), '"name":', ''), '"address":', ''),
    old.snippet, old.body_text
  );
END;

-- Label and flag changes don't touch indexed text, so they skip the index.
CREATE TRIGGER messages_fts_update
AFTER UPDATE OF subject, from_name, from_address, to_addresses, cc_addresses, snippet, body_text
ON messages
WHEN old.subject IS NOT new.subject
  OR old.from_name IS NOT new.from_name
  OR old.from_address IS NOT new.from_address
  OR old.to_addresses IS NOT new.to_addresses
  OR old.cc_addresses IS NOT new.cc_addresses
  OR old.snippet IS NOT new.snippet
  OR old.body_text IS NOT new.body_text
BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, subject, sender, recipients, cc, snippet, body_text)
  VALUES (
    'delete', old.rowid, old.subject, concat_ws(' ', old.from_name, old.from_address),
    replace(replace(replace(old.to_addresses, '"name":null', ''), '"name":', ''), '"address":', ''),
    replace(replace(replace(old.cc_addresses, '"name":null', ''), '"name":', ''), '"address":', ''),
    old.snippet, old.body_text
  );
  INSERT INTO messages_fts (rowid, subject, sender, recipients, cc, snippet, body_text)
  VALUES (
    new.rowid, new.subject, concat_ws(' ', new.from_name, new.from_address),
    replace(replace(replace(new.to_addresses, '"name":null', ''), '"name":', ''), '"address":', ''),
    replace(replace(replace(new.cc_addresses, '"name":null', ''), '"name":', ''), '"address":', ''),
    new.snippet, new.body_text
  );
END;

-- Index the mail cached before this migration.
INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');

-- The last 20 searches, newest first.
CREATE TABLE recent_searches (
  query TEXT PRIMARY KEY NOT NULL,
  used_at INTEGER NOT NULL
);
