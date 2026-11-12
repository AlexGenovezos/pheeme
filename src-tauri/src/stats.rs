//! Settings › Mail stats: how much mail arrives, where it lands and how much of it the user
//! engages with (opens, replies to or stars), worked out from the cache through `db::messages`.
//! No Gmail calls. Tauri-free.

use crate::db::{messages, sync_state};
use crate::mail::MailError;
use crate::senders::{self, SenderDto};
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashMap};

/// The inbox tabs (and Spam) received mail is sorted into, in the page's order.
pub const TABS: [(&str, &str); 6] = [
    ("primary", "Primary"),
    ("promotions", "Promotions"),
    ("social", "Social"),
    ("updates", "Updates"),
    ("forums", "Forums"),
    ("spam", "Spam"),
];
const LABELS: i64 = 8;
const SENDERS: i64 = 15;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub received: i64,
    pub opened: i64,
    pub replied: i64,
    pub starred: i64,
    /// Opened, replied to or starred.
    pub engaged: i64,
}

impl Counts {
    fn add(&mut self, row: &messages::DbReceivedStats) {
        self.received += row.received;
        self.opened += row.opened;
        self.replied += row.replied;
        self.starred += row.starred;
        self.engaged += row.engaged;
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStats {
    /// Local `YYYY-MM-DD`.
    pub day: String,
    #[serde(flatten)]
    pub counts: Counts,
}

/// An inbox tab or a label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceStats {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub counts: Counts,
}

/// A sender over every account asked about; `account_id` and `thread_id` are the newest of its
/// mail, for unsubscribing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderStats {
    pub account_id: String,
    pub sender: String,
    pub name: Option<String>,
    #[serde(flatten)]
    pub counts: Counts,
    /// The inbox tab most of it lands in.
    pub tab: &'static str,
    /// `one_click`, `link`, `email`, `none` or `unknown` (see [`SenderDto::unsubscribe`]).
    pub unsubscribe: &'static str,
    pub thread_id: Option<String>,
    pub last_date: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailStats {
    pub since: i64,
    /// Every account's older mail is on this computer; while it downloads, older days count low.
    pub complete: bool,
    pub totals: Counts,
    /// Days with mail, oldest first.
    pub days: Vec<DayStats>,
    /// Every tab in [`TABS`] order, with or without mail.
    pub tabs: Vec<PlaceStats>,
    /// User labels with mail, most first.
    pub labels: Vec<PlaceStats>,
    /// Who sends the most, most first.
    pub senders: Vec<SenderStats>,
}

/// One account to count: its id and address (its own mail isn't "received").
pub struct StatsAccount<'a> {
    pub id: &'a str,
    pub email: &'a str,
}

/// Mail received by `accounts` since `since_ms`, added together.
pub async fn mail_stats(
    db: &SqlitePool,
    accounts: &[StatsAccount<'_>],
    since_ms: i64,
) -> Result<MailStats, MailError> {
    let mut complete = true;
    let mut totals = Counts::default();
    let mut days: BTreeMap<String, Counts> = BTreeMap::new();
    let mut tabs: HashMap<String, Counts> = HashMap::new();
    // By name, so the same label in two accounts is one row.
    let mut labels: HashMap<String, Counts> = HashMap::new();
    let mut senders: HashMap<String, (SenderStats, i64)> = HashMap::new();

    for account in accounts {
        complete &= sync_state::get(db, account.id).await?.backfill_complete;
        for row in messages::received_by_day(db, account.id, since_ms, account.email).await? {
            totals.add(&row);
            days.entry(row.key.clone()).or_default().add(&row);
            tabs.entry(row.group.clone()).or_default().add(&row);
        }
        for row in
            messages::received_by_label(db, account.id, since_ms, account.email, LABELS).await?
        {
            labels.entry(row.group.clone()).or_default().add(&row);
        }
        for s in senders::report(db, account.id, account.email, since_ms, SENDERS).await? {
            merge_sender(&mut senders, account.id, s);
        }
    }

    let mut labels: Vec<PlaceStats> = labels
        .into_iter()
        .map(|(name, counts)| PlaceStats {
            id: name.clone(),
            name,
            counts,
        })
        .collect();
    labels.sort_by(|a, b| {
        b.counts
            .received
            .cmp(&a.counts.received)
            .then_with(|| a.name.cmp(&b.name))
    });
    labels.truncate(LABELS as usize);

    let mut senders: Vec<SenderStats> = senders.into_values().map(|(s, _)| s).collect();
    senders.sort_by(|a, b| {
        b.counts
            .received
            .cmp(&a.counts.received)
            .then_with(|| b.last_date.cmp(&a.last_date))
    });
    senders.truncate(SENDERS as usize);

    Ok(MailStats {
        since: since_ms,
        complete,
        totals,
        days: days
            .into_iter()
            .map(|(day, counts)| DayStats { day, counts })
            .collect(),
        tabs: TABS
            .iter()
            .map(|(id, name)| PlaceStats {
                id: (*id).into(),
                name: (*name).into(),
                counts: tabs.get(*id).copied().unwrap_or_default(),
            })
            .collect(),
        labels,
        senders,
    })
}

/// Add one account's report of a sender to the others'. The newest mail decides where to
/// unsubscribe; the account with the most of it decides the tab.
fn merge_sender(into: &mut HashMap<String, (SenderStats, i64)>, account_id: &str, s: SenderDto) {
    let counts = Counts {
        received: s.messages,
        opened: s.messages - s.unread,
        replied: s.replied,
        starred: s.starred,
        engaged: s.engaged,
    };
    let fresh = SenderStats {
        account_id: account_id.into(),
        sender: s.sender.clone(),
        name: s.name,
        counts,
        tab: s.tab,
        unsubscribe: s.unsubscribe,
        thread_id: s.thread_id,
        last_date: s.last_date,
    };
    let Some((have, most)) = into.get_mut(&s.sender) else {
        into.insert(s.sender, (fresh, counts.received));
        return;
    };
    let c = &mut have.counts;
    c.received += counts.received;
    c.opened += counts.opened;
    c.replied += counts.replied;
    c.starred += counts.starred;
    c.engaged += counts.engaged;
    if counts.received > *most {
        *most = counts.received;
        have.tab = fresh.tab;
    }
    if fresh.last_date > have.last_date {
        have.account_id = fresh.account_id;
        have.unsubscribe = fresh.unsubscribe;
        have.thread_id = fresh.thread_id;
        have.last_date = fresh.last_date;
        have.name = fresh.name.or(have.name.take());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::messages::{upsert_message, DbMessage};
    use crate::db::test_support::TestDb;

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;
    // Noon UTC, so a few hours' time zone offset keeps each message on its day.
    const NOW: i64 = 1_800_000_000_000 - 1_800_000_000_000 % DAY_MS + DAY_MS / 2;

    fn message(id: &str, thread: &str, labels: &[&str], from: &str, days_ago: i64) -> DbMessage {
        DbMessage {
            id: id.into(),
            account_id: "a1".into(),
            thread_id: thread.into(),
            label_ids: Some(serde_json::to_string(labels).unwrap()),
            from_address: Some(from.into()),
            from_name: None,
            to_addresses: None,
            cc_addresses: None,
            subject: None,
            snippet: None,
            body_html: None,
            body_text: None,
            date: Some(NOW - days_ago * DAY_MS),
            size_estimate: None,
            has_attachment: 0,
            is_read: i64::from(!labels.contains(&"UNREAD")),
            is_starred: i64::from(labels.contains(&"STARRED")),
            raw_headers: None,
            fully_fetched: 0,
            rfc822_message_id: None,
        }
    }

    async fn seed(db: &TestDb, messages: &[DbMessage]) {
        for m in messages {
            upsert_message(&db.pool, m).await.unwrap();
        }
    }

    #[tokio::test]
    async fn counts_received_mail_by_day_tab_label_and_sender() {
        let db = TestDb::with_account("a1").await;
        sqlx::query(
            "INSERT INTO labels (id, account_id, name, type) VALUES ('Label_1', 'a1', 'Receipts', 'user')",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        seed(
            &db,
            &[
                // Never opened, Promotions.
                message(
                    "d1",
                    "td1",
                    &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
                    "deals@shop.com",
                    1,
                ),
                message(
                    "d2",
                    "td2",
                    &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
                    "deals@shop.com",
                    2,
                ),
                message(
                    "d3",
                    "td3",
                    &["INBOX", "CATEGORY_PROMOTIONS", "Label_1"],
                    "deals@shop.com",
                    2,
                ),
                // Unread but answered: the reply makes it engaged.
                message("f1", "tf", &["INBOX", "UNREAD"], "friend@x.com", 2),
                message("r1", "tf", &["SENT"], "me@example.com", 1),
                // Starred, and replied to before it arrived (doesn't count as replied).
                message("f0", "tg", &["SENT"], "me@example.com", 3),
                message(
                    "f2",
                    "tg",
                    &["INBOX", "UNREAD", "STARRED"],
                    "friend@x.com",
                    1,
                ),
                message("s1", "ts", &["SPAM", "UNREAD"], "spam@bad.com", 1),
                // Outside the window, and the account's own draft.
                message("old", "told", &["INBOX"], "deals@shop.com", 40),
                message("dr", "tdr", &["DRAFT"], "me@example.com", 1),
            ],
        )
        .await;

        let stats = mail_stats(
            &db.pool,
            &[StatsAccount {
                id: "a1",
                email: "me@example.com",
            }],
            NOW - 7 * DAY_MS,
        )
        .await
        .unwrap();

        assert_eq!(
            stats.totals,
            Counts {
                received: 6,
                opened: 1,
                replied: 1,
                starred: 1,
                engaged: 3
            }
        );
        assert_eq!(stats.days.len(), 2);
        assert_eq!(stats.days.iter().map(|d| d.counts.received).sum::<i64>(), 6);
        let tab = |id: &str| stats.tabs.iter().find(|t| t.id == id).unwrap().counts;
        assert_eq!(stats.tabs.len(), TABS.len());
        assert_eq!(tab("promotions").received, 3);
        assert_eq!(tab("promotions").opened, 1);
        assert_eq!(tab("primary").received, 2);
        assert_eq!(tab("primary").engaged, 2);
        assert_eq!(tab("spam").received, 1);
        assert_eq!(tab("social").received, 0);
        assert_eq!(stats.labels.len(), 1);
        assert_eq!(stats.labels[0].name, "Receipts");
        assert_eq!(stats.labels[0].counts.received, 1);

        let senders: Vec<_> = stats.senders.iter().map(|s| s.sender.as_str()).collect();
        assert_eq!(senders, ["deals@shop.com", "friend@x.com", "spam@bad.com"]);
        let deals = &stats.senders[0];
        assert_eq!(deals.counts.received, 3);
        assert_eq!(deals.counts.opened, 1);
        assert_eq!(deals.tab, "promotions");
        assert_eq!(deals.thread_id.as_deref(), Some("td1"));
        let friend = &stats.senders[1].counts;
        assert_eq!((friend.replied, friend.starred, friend.engaged), (1, 1, 2));
        assert!(!stats.complete, "the backfill hasn't run");
    }

    #[test]
    fn merges_a_sender_across_accounts() {
        let dto = |messages, unread, last_date, thread: &str| SenderDto {
            sender: "news@x.com".into(),
            name: None,
            messages,
            unread,
            replied: 0,
            starred: 0,
            engaged: messages - unread,
            in_inbox: 0,
            in_trash: 0,
            in_spam: 0,
            tab: "updates",
            last_date,
            you_wrote: 0,
            unsubscribe: "one_click",
            thread_id: Some(thread.into()),
        };
        let mut all = HashMap::new();
        merge_sender(&mut all, "a1", dto(5, 5, 10, "t-old"));
        merge_sender(&mut all, "a2", dto(2, 1, 20, "t-new"));
        let (s, _) = &all["news@x.com"];
        assert_eq!((s.counts.received, s.counts.opened), (7, 1));
        assert_eq!(
            (s.account_id.as_str(), s.thread_id.as_deref()),
            ("a2", Some("t-new"))
        );
    }
}
