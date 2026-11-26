//! Google Calendar's task blocks: a Google Task booked onto an hour in Google Calendar comes
//! through the Calendar API as a `focusTime` event whose description ends in the task's link,
//! `https://tasks.google.com/task/<code>`. The same link (plus a query) is the task's
//! `webViewLink`, so the frontend matches a block to its task by it.

use serde_json::Value;

const TASK_URL: &str = "https://tasks.google.com/task/";

/// The task link of a task block (`https://tasks.google.com/task/<code>`, without any query),
/// or `None` for any other event. `raw` is the stored Calendar API resource.
pub fn task_link(raw: &Value, description: Option<&str>) -> Option<String> {
    if raw.get("eventType")?.as_str()? != "focusTime" {
        return None;
    }
    link_in(description?)
}

/// The first task link in `text` that has a code (`[A-Za-z0-9_-]+`).
fn link_in(text: &str) -> Option<String> {
    text.match_indices(TASK_URL).find_map(|(at, _)| {
        let rest = &text[at + TASK_URL.len()..];
        let len = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .unwrap_or(rest.len());
        (len > 0).then(|| format!("{TASK_URL}{}", &rest[..len]))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DESCRIPTION: &str = "Changes made to the title, description, or attachments will not be saved. To make edits, please go to: https://tasks.google.com/task/m6D4f5_SATtUpxoQ";

    #[test]
    fn focus_time_with_task_link_is_a_block() {
        assert_eq!(
            task_link(&json!({"eventType": "focusTime"}), Some(DESCRIPTION)).as_deref(),
            Some("https://tasks.google.com/task/m6D4f5_SATtUpxoQ")
        );
    }

    #[test]
    fn default_event_with_link_is_not() {
        assert_eq!(
            task_link(&json!({"eventType": "default"}), Some(DESCRIPTION)),
            None
        );
        assert_eq!(task_link(&json!({}), Some(DESCRIPTION)), None);
    }

    #[test]
    fn focus_time_without_link_is_not() {
        let raw = &json!({"eventType": "focusTime"});
        assert_eq!(task_link(raw, Some("Deep work")), None);
        assert_eq!(task_link(raw, None), None);
        assert_eq!(
            task_link(raw, Some("https://tasks.google.com/task/")),
            None,
            "a link without its code"
        );
    }

    #[test]
    fn link_stops_at_query_or_space() {
        let raw = &json!({"eventType": "focusTime"});
        assert_eq!(
            task_link(raw, Some("https://tasks.google.com/task/abc_D-9?sa=6 more")).as_deref(),
            Some("https://tasks.google.com/task/abc_D-9")
        );
        assert_eq!(
            task_link(
                raw,
                Some("go to: https://tasks.google.com/task/abc_D-9 more")
            )
            .as_deref(),
            Some("https://tasks.google.com/task/abc_D-9")
        );
    }
}
