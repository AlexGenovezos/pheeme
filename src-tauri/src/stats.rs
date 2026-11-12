//! Settings › Mail stats: how much mail arrives, where it lands and how much of it the user
//! engages with (opens, replies to or stars), worked out from the cache through `db::messages`.
//! No Gmail calls. Tauri-free.

use crate::db::{messages, sync_state};
use crate::gmail::types::Header;
use crate::mail::MailError;
use crate::senders;
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

/// A sender over every account asked about; `account_id`, `thread_id` and `message_id` are its
/// newest mail, the one Unsubscribe uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderStats {
    pub account_id: String,
    pub sender: String,
    pub name: Option<String>,
    #[serde(flatten)]
    pub counts: Counts,
    /// The inbox tab most of it lands in, or `spam`.
    pub tab: &'static str,
    /// `one_click`, `link`, `email`, `none` or `unknown` (see [`senders::SenderDto`]).
    pub unsubscribe: &'static str,
    pub thread_id: Option<String>,
    pub message_id: Option<String>,
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
    let mut senders: HashMap<String, Merged> = HashMap::new();
    // One account's top rows are its share of the answer; several accounts are added up in full
    // first (-1 is SQLite's "no limit"), so a sender or label high in the sum isn't cut early.
    let (label_limit, sender_limit) = if accounts.len() > 1 {
        (-1, -1)
    } else {
        (LABELS, SENDERS)
    };

    for account in accounts {
        complete &= sync_state::get(db, account.id).await?.backfill_complete;
        for row in messages::received_by_day(db, account.id, since_ms, account.email).await? {
            totals.add(&row);
            days.entry(row.key.clone()).or_default().add(&row);
            tabs.entry(row.group.clone()).or_default().add(&row);
        }
        for row in messages::received_by_label(db, account.id, since_ms, account.email, label_limit)
            .await?
        {
            labels.entry(row.group.clone()).or_default().add(&row);
        }
        for s in
            messages::sender_stats(db, account.id, since_ms, account.email, sender_limit).await?
        {
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

    let mut merged: Vec<Merged> = senders.into_values().collect();
    merged.sort_by(|a, b| {
        b.counts
            .received
            .cmp(&a.counts.received)
            .then_with(|| b.last_date.cmp(&a.last_date))
    });
    merged.truncate(SENDERS as usize);
    let mut senders = Vec::with_capacity(merged.len());
    for m in merged {
        // Unsubscribe acts on this message, so the button offers what it carries.
        let latest = messages::latest_from(db, &m.account_id, &m.sender, since_ms).await?;
        let unsubscribe = match latest.as_ref().map(|(_, _, h)| h.as_deref()) {
            Some(Some(json)) => {
                let headers: Vec<Header> = serde_json::from_str(json).unwrap_or_default();
                senders::options(&headers).kind()
            }
            _ => "unknown",
        };
        let (message_id, thread_id) = latest.map(|(id, thread, _)| (id, thread)).unzip();
        senders.push(SenderStats {
            account_id: m.account_id,
            sender: m.sender,
            name: m.name,
            counts: m.counts,
            tab: m.tab,
            unsubscribe,
            thread_id,
            message_id,
            last_date: m.last_date,
        });
    }

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

/// A sender's mail, added up over accounts.
struct Merged {
    sender: String,
    name: Option<String>,
    counts: Counts,
    tab: &'static str,
    /// The most mail one account has from it, which decides `tab`.
    most: i64,
    /// The account with its newest mail, for unsubscribing.
    account_id: String,
    last_date: i64,
}

/// The tab a sender's mail lands in; Spam when most of it is there.
fn tab(s: &messages::DbSenderStats) -> &'static str {
    if s.in_spam * 2 > s.messages {
        "spam"
    } else {
        senders::tab(s)
    }
}

/// Add one account's figures for a sender to the others'.
fn merge_sender(into: &mut HashMap<String, Merged>, account_id: &str, s: messages::DbSenderStats) {
    let counts = Counts {
        received: s.messages,
        opened: s.messages - s.unread,
        replied: s.replied,
        starred: s.starred,
        engaged: s.engaged,
    };
    let tab = tab(&s);
    let Some(have) = into.get_mut(&s.address) else {
        into.insert(
            s.address.clone(),
            Merged {
                sender: s.address,
                name: s.name,
                counts,
                tab,
                most: counts.received,
                account_id: account_id.into(),
                last_date: s.last_date,
            },
        );
        return;
    };
    let c = &mut have.counts;
    c.received += counts.received;
    c.opened += counts.opened;
    c.replied += counts.replied;
    c.starred += counts.starred;
    c.engaged += counts.engaged;
    if counts.received > have.most {
        have.most = counts.received;
        have.tab = tab;
    }
    if s.last_date > have.last_date {
        have.account_id = account_id.into();
        have.last_date = s.last_date;
        have.name = s.name.or(have.name.take());
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
        let row = |messages, unread, in_spam, last_date| messages::DbSenderStats {
            address: "news@x.com".into(),
            name: None,
            messages,
            unread,
            replied: 0,
            starred: 0,
            engaged: messages - unread,
            in_inbox: 0,
            in_trash: 0,
            in_spam,
            promotions: 0,
            social: 0,
            updates: messages,
            forums: 0,
            last_date,
            you_wrote: 0,
        };
        let mut all = HashMap::new();
        merge_sender(&mut all, "a1", row(5, 5, 0, 10));
        merge_sender(&mut all, "a2", row(2, 1, 2, 20));
        let s = &all["news@x.com"];
        assert_eq!((s.counts.received, s.counts.opened), (7, 1));
        assert_eq!((s.account_id.as_str(), s.last_date), ("a2", 20));
        assert_eq!(s.tab, "updates", "the account with the most of it decides");
        assert_eq!(tab(&row(3, 0, 2, 0)), "spam");
    }

    #[tokio::test]
    async fn all_accounts_rank_senders_on_the_sum() {
        let db = TestDb::with_account("a1").await;
        crate::db::accounts::insert_account(
            &db.pool,
            &crate::db::accounts::DbAccount {
                id: "a2".into(),
                email: "me2@example.com".into(),
                display_name: None,
                profile_photo_url: None,
                client_id: "c".into(),
                history_id: None,
                created_at: 0,
                updated_at: 0,
            },
        )
        .await
        .unwrap();
        let mut seeded = Vec::new();
        // In each account alone, 15 senders of its own send 3 and news@x.com sends 2, so it is
        // 16th and cut; added up it sends 4, more than anyone.
        for account in ["a1", "a2"] {
            for n in 0..15 {
                for k in 0..3 {
                    let mut m = message(
                        &format!("{account}-{n}-{k}"),
                        &format!("t{account}{n}{k}"),
                        &["INBOX"],
                        &format!("s{n}@{account}.com"),
                        3,
                    );
                    m.account_id = account.into();
                    seeded.push(m);
                }
            }
            for k in 0..2 {
                let id = format!("{account}-news{k}");
                let mut m = message(&id, &id, &["INBOX"], "news@x.com", 2 - k);
                m.account_id = account.into();
                if account == "a2" {
                    // The newest copy, so Unsubscribe uses a2's.
                    m.date = m.date.map(|d| d + 1_000);
                }
                seeded.push(m);
            }
        }
        seed(&db, &seeded).await;
        let both = [
            StatsAccount {
                id: "a1",
                email: "me@example.com",
            },
            StatsAccount {
                id: "a2",
                email: "me2@example.com",
            },
        ];
        let stats = mail_stats(&db.pool, &both, NOW - 7 * DAY_MS).await.unwrap();
        assert_eq!(stats.senders.len(), SENDERS as usize);
        assert_eq!(stats.senders[0].sender, "news@x.com");
        assert_eq!(stats.senders[0].counts.received, 4);
        assert_eq!(stats.senders[0].message_id.as_deref(), Some("a2-news1"));
    }
}
