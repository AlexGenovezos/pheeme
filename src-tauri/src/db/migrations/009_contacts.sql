-- Recipient suggestions in compose (`contacts.rs`).

-- Everyone the account has exchanged mail with, kept by the trigger below: each message
-- counts once, when it is first cached. Deleting mail leaves its contacts, as Gmail does.
-- Drafts and spam don't count, and neither do senders of mail in the Promotions, Social,
-- Updates and Forums tabs (newsletters and notifications), unless you write to them.
CREATE TABLE contacts (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Lowercased.
  address TEXT NOT NULL,
  -- The display name from the newest message that had one.
  name TEXT,
  name_date INTEGER NOT NULL DEFAULT 0,
  -- Messages the account sent to this address (To or Cc).
  sent_count INTEGER NOT NULL DEFAULT 0,
  -- Messages it received with this address on them (From, To or Cc).
  received_count INTEGER NOT NULL DEFAULT 0,
  -- ms since the epoch, 0 for never.
  last_sent INTEGER NOT NULL DEFAULT 0,
  last_received INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, address)
) WITHOUT ROWID;

-- The account's Google Contacts (People API), replaced by each download. `saved` is 1 for
-- the user's own contacts, 0 for "Other contacts" (people Gmail saved from their mail); an
-- address may be in both.
CREATE TABLE google_contacts (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  name TEXT,
  saved INTEGER NOT NULL,
  PRIMARY KEY (account_id, saved, address)
) WITHOUT ROWID;

-- How the last Google Contacts download went, per account.
CREATE TABLE google_contacts_sync (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- 'on', 'missing_scope', 'api_disabled' or 'error'.
  status TEXT NOT NULL,
  -- api_disabled: the Google Cloud project number, when Google said; error: what failed.
  detail TEXT,
  checked_at INTEGER NOT NULL,
  -- The last download that succeeded.
  synced_at INTEGER
);

-- A message's addresses: To and Cc, plus From for received mail. Malformed JSON counts as
-- no addresses rather than failing the insert (and with it, sync). SQLite allows no CTEs
-- in triggers, so the two statements repeat the address list.
CREATE TRIGGER messages_contacts AFTER INSERT ON messages
WHEN NOT EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(new.label_ids) THEN new.label_ids ELSE '[]' END)
  WHERE value IN ('DRAFT', 'SPAM')
)
BEGIN
  INSERT INTO contacts (account_id, address, name, name_date, sent_count, last_sent)
  SELECT new.account_id, address, max(name),
         CASE WHEN max(name) IS NULL THEN 0 ELSE coalesce(new.date, 0) END,
         1, coalesce(new.date, 0)
  FROM (
    SELECT lower(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.address'))) AS address,
           nullif(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.name')), '') AS name
    FROM json_each(CASE WHEN json_valid(new.to_addresses) THEN new.to_addresses ELSE '[]' END) AS j
    UNION ALL
    SELECT lower(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.address'))),
           nullif(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.name')), '')
    FROM json_each(CASE WHEN json_valid(new.cc_addresses) THEN new.cc_addresses ELSE '[]' END) AS j
  )
  WHERE address LIKE '%_@_%'
    AND EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(new.label_ids) THEN new.label_ids ELSE '[]' END)
      WHERE value = 'SENT'
    )
  GROUP BY address
  ON CONFLICT (account_id, address) DO UPDATE SET
    sent_count = sent_count + 1,
    last_sent = max(last_sent, excluded.last_sent),
    name = CASE WHEN excluded.name IS NOT NULL AND excluded.name_date >= name_date
                THEN excluded.name ELSE name END,
    name_date = CASE WHEN excluded.name IS NOT NULL AND excluded.name_date >= name_date
                     THEN excluded.name_date ELSE name_date END;

  INSERT INTO contacts (account_id, address, name, name_date, received_count, last_received)
  SELECT new.account_id, address, max(name),
         CASE WHEN max(name) IS NULL THEN 0 ELSE coalesce(new.date, 0) END,
         1, coalesce(new.date, 0)
  FROM (
    SELECT lower(trim(new.from_address)) AS address, nullif(trim(new.from_name), '') AS name
    UNION ALL
    SELECT lower(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.address'))),
           nullif(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.name')), '')
    FROM json_each(CASE WHEN json_valid(new.to_addresses) THEN new.to_addresses ELSE '[]' END) AS j
    UNION ALL
    SELECT lower(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.address'))),
           nullif(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.name')), '')
    FROM json_each(CASE WHEN json_valid(new.cc_addresses) THEN new.cc_addresses ELSE '[]' END) AS j
  )
  WHERE address LIKE '%_@_%'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(new.label_ids) THEN new.label_ids ELSE '[]' END)
      WHERE value IN ('SENT', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS')
    )
  GROUP BY address
  ON CONFLICT (account_id, address) DO UPDATE SET
    received_count = received_count + 1,
    last_received = max(last_received, excluded.last_received),
    name = CASE WHEN excluded.name IS NOT NULL AND excluded.name_date >= name_date
                THEN excluded.name ELSE name END,
    name_date = CASE WHEN excluded.name IS NOT NULL AND excluded.name_date >= name_date
                     THEN excluded.name_date ELSE name_date END;
END;

-- Index the mail cached before this migration, by the same rules as the trigger. Each
-- message's labels are read once (`kind`: 1 sent, 0 received, NULL not counted), then its
-- addresses once each.
CREATE TEMP TABLE contact_msgs AS
SELECT rowid AS msg, account_id, coalesce(date, 0) AS date, from_address, from_name,
       CASE WHEN json_valid(to_addresses) THEN to_addresses ELSE '[]' END AS to_addresses,
       CASE WHEN json_valid(cc_addresses) THEN cc_addresses ELSE '[]' END AS cc_addresses,
       CASE
         WHEN EXISTS (SELECT 1 FROM json_each(labels) WHERE value IN ('DRAFT', 'SPAM')) THEN NULL
         WHEN EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'SENT') THEN 1
         WHEN EXISTS (SELECT 1 FROM json_each(labels) WHERE value IN ('CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS')) THEN NULL
         ELSE 0
       END AS kind
FROM (
  SELECT rowid, account_id, date, from_address, from_name, to_addresses, cc_addresses,
         CASE WHEN json_valid(label_ids) THEN label_ids ELSE '[]' END AS labels
  FROM messages
);

DELETE FROM contact_msgs WHERE kind IS NULL;

CREATE TEMP TABLE contact_seen AS
SELECT account_id, address, max(name) AS name, date, sent
FROM (
  SELECT m.msg, m.account_id, m.date, m.kind AS sent,
         lower(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.address'))) AS address,
         nullif(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.name')), '') AS name
  FROM contact_msgs m, json_each(m.to_addresses) AS j
  UNION ALL
  SELECT m.msg, m.account_id, m.date, m.kind,
         lower(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.address'))),
         nullif(trim(json_extract(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END, '$.name')), '')
  FROM contact_msgs m, json_each(m.cc_addresses) AS j
  UNION ALL
  SELECT m.msg, m.account_id, m.date, 0, lower(trim(m.from_address)), nullif(trim(m.from_name), '')
  FROM contact_msgs m
  WHERE m.kind = 0
)
WHERE address LIKE '%_@_%'
GROUP BY msg, address;

DROP TABLE contact_msgs;

CREATE INDEX temp.contact_seen_key ON contact_seen (account_id, address, date);

INSERT INTO contacts (account_id, address, sent_count, received_count, last_sent, last_received)
SELECT account_id, address, sum(sent), sum(1 - sent),
       max(CASE WHEN sent = 1 THEN date ELSE 0 END), max(CASE WHEN sent = 0 THEN date ELSE 0 END)
FROM contact_seen
GROUP BY account_id, address;

-- The name from the newest message that had one (SQLite takes `name` from the max() row).
UPDATE contacts SET (name, name_date) = (
  SELECT s.name, max(s.date) FROM contact_seen s
  WHERE s.account_id = contacts.account_id AND s.address = contacts.address AND s.name IS NOT NULL
)
WHERE EXISTS (
  SELECT 1 FROM contact_seen s
  WHERE s.account_id = contacts.account_id AND s.address = contacts.address AND s.name IS NOT NULL
);

DROP TABLE contact_seen;
