-- The sidebar and tray counts, kept as threads change instead of counted on every read. Counting
-- a mailbox of 800,000 messages took 1-4 s per query, and every sync, outbox change and read asked
-- again, until reads queued for tens of seconds behind each other (diagnostics report, v0.28).
-- `threads::recompute_threads`, the only writer of `threads` and `thread_labels`, adds each
-- thread's change to these in the same transaction (`db/threads/counts.rs`).

-- Threads per label, and those of them counted unread (`unread_count > 0` and carrying UNREAD,
-- SPAM or TRASH), as `label_counts` answers them. `ALL` is All Mail: threads in neither Spam nor
-- Trash, unread when they carry UNREAD.
CREATE TABLE label_thread_counts (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL,
  total INTEGER NOT NULL,
  unread INTEGER NOT NULL,
  PRIMARY KEY (account_id, label_id)
) WITHOUT ROWID;

-- Unread inbox threads (INBOX and UNREAD), grouped by which of the other inbox tabs' categories
-- they carry: sorted, comma-separated, '' for none. The Inbox, each tab and Primary (minus the
-- tabs the account shows) are sums of these.
CREATE TABLE inbox_unread_counts (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  categories TEXT NOT NULL,
  threads INTEGER NOT NULL,
  PRIMARY KEY (account_id, categories)
) WITHOUT ROWID;

INSERT INTO label_thread_counts (account_id, label_id, total, unread)
SELECT tl.account_id, tl.label_id, COUNT(*),
       COALESCE(SUM(t.unread_count > 0 AND EXISTS (
         SELECT 1 FROM thread_labels c
         WHERE c.account_id = tl.account_id AND c.thread_id = tl.thread_id
           AND c.label_id IN ('UNREAD', 'SPAM', 'TRASH'))), 0)
FROM thread_labels tl
JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
GROUP BY tl.account_id, tl.label_id;

INSERT INTO label_thread_counts (account_id, label_id, total, unread)
SELECT t.account_id, 'ALL', COUNT(*),
       COALESCE(SUM(t.unread_count > 0 AND EXISTS (
         SELECT 1 FROM thread_labels u
         WHERE u.account_id = t.account_id AND u.thread_id = t.id AND u.label_id = 'UNREAD')), 0)
FROM threads t
WHERE NOT EXISTS (
  SELECT 1 FROM thread_labels e
  WHERE e.account_id = t.account_id AND e.thread_id = t.id AND e.label_id IN ('SPAM', 'TRASH'))
GROUP BY t.account_id;

INSERT INTO inbox_unread_counts (account_id, categories, threads)
SELECT account_id, categories, COUNT(*)
FROM (
  SELECT u.account_id AS account_id,
         COALESCE((SELECT group_concat(c.label_id, ',' ORDER BY c.label_id)
                   FROM thread_labels c
                   WHERE c.account_id = u.account_id AND c.thread_id = u.thread_id
                     AND c.label_id IN ('CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS',
                                        'CATEGORY_UPDATES', 'CATEGORY_FORUMS')), '') AS categories
  FROM thread_labels u
  JOIN thread_labels i
    ON i.account_id = u.account_id AND i.thread_id = u.thread_id AND i.label_id = 'INBOX'
  WHERE u.label_id = 'UNREAD'
)
GROUP BY account_id, categories;
