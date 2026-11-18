//! The sidebar and tray counts, kept as threads change (migration 020) rather than counted on each
//! read: in a mailbox of 800,000 messages each count took 1-4 s, and they are asked for after every
//! sync, outbox change and read.
//!
//! Every write to `threads` or `thread_labels` goes through [`super::recompute_threads`] (or the
//! test-only helpers beside it), which takes away each changed thread's old contribution and adds
//! its new one here, then writes the sums in the same transaction.

use super::ALL_MAIL;
use anyhow::Result;
use sqlx::SqliteConnection;
use std::collections::BTreeMap;

/// The inbox categories other than Primary, sorted as the `inbox_unread_counts` key lists them.
pub(super) const OTHER_TABS: [&str; 4] = [
    "CATEGORY_FORUMS",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_SOCIAL",
    "CATEGORY_UPDATES",
];

/// Changes to the counts, summed over the threads of one write.
#[derive(Debug, Default)]
pub(super) struct CountDeltas {
    /// Per label id (and [`ALL_MAIL`]): change to (total, unread).
    labels: BTreeMap<String, (i64, i64)>,
    /// Per `inbox_unread_counts` key: change to its threads.
    inbox: BTreeMap<String, i64>,
}

impl CountDeltas {
    /// Add (`sign` 1) or take away (`sign` -1) one thread with `labels` and `unread_count`, as the
    /// count queries saw it (see migration 020).
    pub(super) fn add(&mut self, labels: &[String], unread_count: i64, sign: i64) {
        let has = |id: &str| labels.iter().any(|l| l == id);
        let unread = unread_count > 0 && (has("UNREAD") || has("SPAM") || has("TRASH"));
        for label in labels {
            let entry = self.labels.entry(label.clone()).or_default();
            entry.0 += sign;
            entry.1 += sign * i64::from(unread);
        }
        if !has("SPAM") && !has("TRASH") {
            let entry = self.labels.entry(ALL_MAIL.to_owned()).or_default();
            entry.0 += sign;
            entry.1 += sign * i64::from(unread_count > 0 && has("UNREAD"));
        }
        if has("INBOX") && has("UNREAD") {
            let key: Vec<&str> = OTHER_TABS.iter().copied().filter(|c| has(c)).collect();
            *self.inbox.entry(key.join(",")).or_default() += sign;
        }
    }

    /// Write the summed changes for `account_id` and start over.
    pub(super) async fn flush(
        &mut self,
        conn: &mut SqliteConnection,
        account_id: &str,
    ) -> Result<()> {
        for (label_id, (total, unread)) in std::mem::take(&mut self.labels) {
            if total == 0 && unread == 0 {
                continue;
            }
            sqlx::query!(
                "INSERT INTO label_thread_counts (account_id, label_id, total, unread)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT (account_id, label_id) DO UPDATE SET
                   total = total + excluded.total, unread = unread + excluded.unread",
                account_id,
                label_id,
                total,
                unread
            )
            .execute(&mut *conn)
            .await?;
        }
        for (categories, threads) in std::mem::take(&mut self.inbox) {
            if threads == 0 {
                continue;
            }
            sqlx::query!(
                "INSERT INTO inbox_unread_counts (account_id, categories, threads)
                 VALUES (?, ?, ?)
                 ON CONFLICT (account_id, categories) DO UPDATE SET
                   threads = threads + excluded.threads",
                account_id,
                categories,
                threads
            )
            .execute(&mut *conn)
            .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn a_thread_counts_in_each_label_all_mail_and_its_inbox_group() {
        let mut d = CountDeltas::default();
        d.add(
            &labels(&["CATEGORY_UPDATES", "CATEGORY_SOCIAL", "INBOX", "UNREAD"]),
            1,
            1,
        );
        assert_eq!(d.labels["INBOX"], (1, 1));
        assert_eq!(d.labels["UNREAD"], (1, 1));
        assert_eq!(d.labels[ALL_MAIL], (1, 1));
        assert_eq!(
            d.inbox.into_iter().collect::<Vec<_>>(),
            [("CATEGORY_SOCIAL,CATEGORY_UPDATES".to_owned(), 1)]
        );
    }

    #[test]
    fn spam_and_trash_leave_all_mail_and_count_unread_by_the_thread() {
        let mut d = CountDeltas::default();
        // Wholly trashed: no UNREAD label, still unread in Trash.
        d.add(&labels(&["TRASH"]), 2, 1);
        assert_eq!(d.labels["TRASH"], (1, 1));
        assert!(!d.labels.contains_key(ALL_MAIL));
        assert!(d.inbox.is_empty());
    }

    #[test]
    fn a_read_thread_counts_in_totals_only_and_a_change_nets_out() {
        let mut d = CountDeltas::default();
        let before = labels(&["INBOX", "UNREAD"]);
        let after = labels(&["INBOX"]);
        d.add(&before, 1, -1);
        d.add(&after, 0, 1);
        assert_eq!(d.labels["INBOX"], (0, -1));
        assert_eq!(d.labels["UNREAD"], (-1, -1));
        assert_eq!(d.labels[ALL_MAIL], (0, -1));
        assert_eq!(d.inbox[""], -1);
    }
}
