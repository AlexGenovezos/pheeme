//! Tasks API resources to cache rows.

use crate::db::tasks::{DbTask, TaskListRow};
use crate::gmail::tasks::{ApiTask, ApiTaskList};
use chrono::NaiveDate;

/// RFC 3339 to UTC ms.
pub fn ms(time: Option<&str>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(time?)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// UTC ms to RFC 3339 as Google writes it (`2026-11-09T10:00:00.000Z`).
pub fn rfc3339(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A due time's date: Google Tasks keeps dates only, sent as UTC midnight.
pub fn due_date(due: Option<&str>) -> Option<String> {
    let date = due?.get(..10)?;
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .map(|d| d.format("%Y-%m-%d").to_string())
}

/// A due date as the Tasks API takes it.
pub fn due_time(date: &NaiveDate) -> String {
    format!("{}T00:00:00.000Z", date.format("%Y-%m-%d"))
}

pub fn task_list(l: &ApiTaskList) -> TaskListRow {
    TaskListRow {
        id: l.id.clone(),
        title: l.title.clone(),
        etag: l.etag.clone(),
        updated_ms: ms(l.updated.as_deref()),
    }
}

pub fn task(account_id: &str, list_id: &str, t: &ApiTask) -> DbTask {
    DbTask {
        account_id: account_id.to_owned(),
        list_id: list_id.to_owned(),
        id: t.id.clone(),
        parent: t.parent.clone().filter(|p| !p.is_empty()),
        position: t.position.clone().unwrap_or_default(),
        title: t.title.clone().unwrap_or_default(),
        notes: t.notes.clone().filter(|n| !n.is_empty()),
        due_date: due_date(t.due.as_deref()),
        status: t.status.clone().unwrap_or_else(|| "needsAction".into()),
        completed_ms: ms(t.completed.as_deref()),
        updated_ms: ms(t.updated.as_deref()).unwrap_or_default(),
        hidden: t.hidden,
        etag: t.etag.clone().unwrap_or_default(),
        raw: t.raw.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn converts_a_task() {
        let api = ApiTask::try_from(json!({
            "id": "t1", "title": "Call Sam", "notes": "", "status": "completed",
            "due": "2026-11-12T00:00:00.000Z", "completed": "2026-11-10T08:30:00.000Z",
            "parent": "p", "position": "00000000000000000003",
            "updated": "2026-11-10T08:30:00.000Z", "etag": "\"e\"", "hidden": true
        }))
        .unwrap();
        let row = task("a", "L", &api);
        assert_eq!(row.due_date.as_deref(), Some("2026-11-12"));
        assert_eq!(row.notes, None);
        assert_eq!(row.parent.as_deref(), Some("p"));
        assert_eq!(row.completed_ms, ms(Some("2026-11-10T08:30:00Z")));
        assert!(row.hidden);
        assert_eq!(row.status, "completed");
        assert_eq!(rfc3339(row.updated_ms), "2026-11-10T08:30:00.000Z");
    }

    #[test]
    fn due_dates_round_trip() {
        let d = NaiveDate::from_ymd_opt(2026, 1, 5).unwrap();
        assert_eq!(due_time(&d), "2026-01-05T00:00:00.000Z");
        assert_eq!(due_date(Some(&due_time(&d))).as_deref(), Some("2026-01-05"));
        assert_eq!(due_date(Some("nonsense")), None);
        assert_eq!(due_date(None), None);
    }
}
