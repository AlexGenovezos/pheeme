//! Event templates: an event's details saved under a name ("Gym", "1:1 with Sam"), so a new
//! event from one needs only a time. Local only: nothing here talks to Google, and an event made
//! from a template is created like any other. Tauri-free; `commands/calendar.rs` is the adapter,
//! and an assistant tool can call the same functions.
//!
//! A template holds what doesn't depend on when the event is: no start, no repeat. Its calendar
//! may be gone by the time it's used (an account removed); the frontend falls back to the default
//! calendar then, so templates aren't tied to accounts here.

use crate::db::{self, templates::TemplateRow};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// The longest template name.
pub const MAX_NAME: usize = 80;
/// Google's limits on reminders: five of them, at most four weeks ahead.
const MAX_REMINDERS: usize = 5;
const MAX_REMINDER_MINUTES: u32 = 4 * 7 * 24 * 60;
const MAX_GUESTS: usize = 200;
const MAX_TEXT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReminderMethod {
    #[default]
    Popup,
    Email,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Transparency {
    #[default]
    Opaque,
    Transparent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    #[default]
    Default,
    Public,
    Private,
    Confidential,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateGuest {
    #[serde(default)]
    pub name: Option<String>,
    pub address: String,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateReminder {
    #[serde(default)]
    pub method: ReminderMethod,
    pub minutes: u32,
}

const fn yes() -> bool {
    true
}

/// What a template fills in, as the event editor holds it. Every field but `length` has a
/// default, so a template saved by an older version still reads after a field is added.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFields {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub all_day: bool,
    /// Timed: the length in minutes. All-day: in days.
    pub length: u32,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub calendar_id: Option<String>,
    #[serde(default)]
    pub guests: Vec<TemplateGuest>,
    #[serde(default)]
    pub guests_can_modify: bool,
    #[serde(default = "yes")]
    pub guests_can_invite_others: bool,
    #[serde(default = "yes")]
    pub guests_can_see_other_guests: bool,
    /// A new Google Meet link for each event made from it.
    #[serde(default)]
    pub meet: bool,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub description: String,
    /// `""` for the calendar's colour, else `"1"` to `"11"`.
    #[serde(default)]
    pub color_id: String,
    #[serde(default = "yes")]
    pub reminders_default: bool,
    #[serde(default)]
    pub reminders: Vec<TemplateReminder>,
    #[serde(default)]
    pub transparency: Transparency,
    #[serde(default)]
    pub visibility: Visibility,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTemplate {
    pub id: String,
    pub name: String,
    pub fields: TemplateFields,
    pub updated_ms: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum TemplateError {
    #[error("{0}")]
    Invalid(String),
    /// Another template already has this name (ignoring capitals); the text names it.
    #[error("There's already a template called “{0}”.")]
    Exists(String),
    #[error("That template isn't there any more.")]
    NotFound,
    #[error("Pheeme couldn't save the template: {0}")]
    Db(#[from] anyhow::Error),
}

impl TemplateError {
    pub fn code(&self) -> &str {
        match self {
            TemplateError::Invalid(_) => "invalid_input",
            TemplateError::Exists(_) => "exists",
            TemplateError::NotFound => "not_found",
            TemplateError::Db(_) => "internal",
        }
    }
}

impl From<sqlx::Error> for TemplateError {
    fn from(e: sqlx::Error) -> Self {
        TemplateError::Db(e.into())
    }
}

type Result<T> = std::result::Result<T, TemplateError>;

/// The name as it's kept: trimmed, not empty, not too long.
fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(TemplateError::Invalid("Give the template a name.".into()));
    }
    if name.chars().count() > MAX_NAME {
        return Err(TemplateError::Invalid(format!(
            "A template's name can be at most {MAX_NAME} characters."
        )));
    }
    Ok(name.to_owned())
}

fn invalid(message: &str) -> TemplateError {
    TemplateError::Invalid(message.to_owned())
}

/// Why these fields can't be saved, if they can't.
fn check(fields: &TemplateFields) -> Result<()> {
    if fields.length == 0 {
        return Err(invalid(
            "The template's length isn't one an event can have.",
        ));
    }
    if [&fields.summary, &fields.location, &fields.description]
        .iter()
        .any(|text| text.len() > MAX_TEXT)
    {
        return Err(invalid("The template's text is too long."));
    }
    if fields.guests.len() > MAX_GUESTS {
        return Err(invalid("A template can have at most 200 guests."));
    }
    if fields
        .guests
        .iter()
        .any(|g| !g.address.contains('@') || g.address.len() > 320)
    {
        return Err(invalid(
            "One of the template's guests has no email address.",
        ));
    }
    if fields.reminders.len() > MAX_REMINDERS
        || fields
            .reminders
            .iter()
            .any(|r| r.minutes > MAX_REMINDER_MINUTES)
    {
        return Err(invalid(
            "A template can have five reminders, each at most four weeks before.",
        ));
    }
    let colour_ok = fields.color_id.is_empty()
        || fields
            .color_id
            .parse::<u8>()
            .is_ok_and(|n| (1..=11).contains(&n));
    if !colour_ok {
        return Err(invalid(
            "The template's colour isn't one Google Calendar has.",
        ));
    }
    Ok(())
}

/// A stored row as the frontend gets it; `None` for one whose fields no longer read.
fn template(row: TemplateRow) -> Option<EventTemplate> {
    match serde_json::from_str(&row.fields) {
        Ok(fields) => Some(EventTemplate {
            id: row.id,
            name: row.name,
            fields,
            updated_ms: row.updated_ms,
        }),
        Err(e) => {
            tracing::warn!(error = %e, "skipping an event template that doesn't read");
            None
        }
    }
}

fn encode(fields: &TemplateFields) -> Result<String> {
    serde_json::to_string(fields).map_err(|e| TemplateError::Db(e.into()))
}

/// Every template, by name.
pub async fn list(pool: &SqlitePool) -> Result<Vec<EventTemplate>> {
    Ok(db::templates::list(pool)
        .await?
        .into_iter()
        .filter_map(template)
        .collect())
}

/// Save `fields` as the template `name`. A template with that name already (ignoring capitals)
/// fails with [`TemplateError::Exists`], unless `replace`: then it's saved over, keeping its id.
pub async fn save(
    pool: &SqlitePool,
    name: &str,
    fields: TemplateFields,
    replace: bool,
    now_ms: i64,
) -> Result<EventTemplate> {
    let name = clean_name(name)?;
    check(&fields)?;
    let json = encode(&fields)?;
    let mut tx = db::begin_write(pool).await?;
    let id = match db::templates::by_name(&mut *tx, &name).await? {
        Some(existing) if !replace => return Err(TemplateError::Exists(existing.name)),
        Some(existing) => {
            db::templates::update(&mut *tx, &existing.id, &name, &json, now_ms).await?;
            existing.id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            db::templates::insert(
                &mut *tx,
                &TemplateRow {
                    id: id.clone(),
                    name: name.clone(),
                    fields: json,
                    created_ms: now_ms,
                    updated_ms: now_ms,
                },
            )
            .await?;
            id
        }
    };
    tx.commit().await?;
    Ok(EventTemplate {
        id,
        name,
        fields,
        updated_ms: now_ms,
    })
}

/// Give template `id` a new name (changing only its capitals is fine).
pub async fn rename(pool: &SqlitePool, id: &str, name: &str, now_ms: i64) -> Result<EventTemplate> {
    let name = clean_name(name)?;
    let mut tx = db::begin_write(pool).await?;
    let row = db::templates::get(&mut *tx, id)
        .await?
        .ok_or(TemplateError::NotFound)?;
    if let Some(other) = db::templates::by_name(&mut *tx, &name).await? {
        if other.id != id {
            return Err(TemplateError::Exists(other.name));
        }
    }
    db::templates::rename(&mut *tx, id, &name, now_ms).await?;
    tx.commit().await?;
    template(TemplateRow {
        name,
        updated_ms: now_ms,
        ..row
    })
    .ok_or(TemplateError::NotFound)
}

/// Delete template `id`. Undo saves the template the frontend still holds again.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    if db::templates::delete(pool, id).await? {
        Ok(())
    } else {
        Err(TemplateError::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;

    fn gym() -> TemplateFields {
        serde_json::from_value(serde_json::json!({
            "summary": "Gym",
            "allDay": false,
            "length": 45,
            "accountId": "acct",
            "calendarId": "primary",
            "location": "The gym",
            "reminders": [{ "method": "popup", "minutes": 10 }],
            "remindersDefault": false,
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn saves_lists_by_name_and_reads_back_the_fields() {
        let db = TestDb::new().await;
        save(&db.pool, "  Gym  ", gym(), false, 1).await.unwrap();
        let mut standup = gym();
        standup.summary = "Standup".into();
        standup.meet = true;
        save(&db.pool, "standup", standup.clone(), false, 2)
            .await
            .unwrap();

        let all = list(&db.pool).await.unwrap();
        let names: Vec<_> = all.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["Gym", "standup"]);
        assert_eq!(all[0].fields, gym());
        assert_eq!(all[1].fields, standup);
    }

    #[test]
    fn missing_fields_take_their_defaults() {
        let fields: TemplateFields = serde_json::from_str(r#"{"length": 30}"#).unwrap();
        assert_eq!(fields.summary, "");
        assert!(fields.guests_can_invite_others && fields.guests_can_see_other_guests);
        assert!(fields.reminders_default);
        assert_eq!(fields.transparency, Transparency::Opaque);
        assert_eq!(fields.visibility, Visibility::Default);
    }

    #[tokio::test]
    async fn a_taken_name_is_refused_unless_replacing() {
        let db = TestDb::new().await;
        let first = save(&db.pool, "Gym", gym(), false, 1).await.unwrap();

        let err = save(&db.pool, "GYM", gym(), false, 2).await.unwrap_err();
        assert_eq!(err.code(), "exists");
        assert_eq!(err.to_string(), "There's already a template called “Gym”.");

        let mut longer = gym();
        longer.length = 90;
        let replaced = save(&db.pool, "GYM", longer.clone(), true, 3)
            .await
            .unwrap();
        assert_eq!(replaced.id, first.id);
        let all = list(&db.pool).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "GYM");
        assert_eq!(all[0].fields, longer);
    }

    #[tokio::test]
    async fn rename_keeps_names_unique() {
        let db = TestDb::new().await;
        let gym_t = save(&db.pool, "Gym", gym(), false, 1).await.unwrap();
        save(&db.pool, "Run", gym(), false, 1).await.unwrap();

        assert_eq!(
            rename(&db.pool, &gym_t.id, "run", 2)
                .await
                .unwrap_err()
                .code(),
            "exists"
        );
        // Its own name in other capitals is fine.
        let renamed = rename(&db.pool, &gym_t.id, "GYM", 2).await.unwrap();
        assert_eq!(renamed.name, "GYM");
        assert_eq!(renamed.fields, gym());
        assert_eq!(
            rename(&db.pool, "nope", "x", 2).await.unwrap_err().code(),
            "not_found"
        );
    }

    #[tokio::test]
    async fn delete_removes_it_once() {
        let db = TestDb::new().await;
        let t = save(&db.pool, "Gym", gym(), false, 1).await.unwrap();
        delete(&db.pool, &t.id).await.unwrap();
        assert!(list(&db.pool).await.unwrap().is_empty());
        assert_eq!(
            delete(&db.pool, &t.id).await.unwrap_err().code(),
            "not_found"
        );
    }

    #[tokio::test]
    async fn bad_names_and_fields_are_refused() {
        let db = TestDb::new().await;
        let refused = |r: Result<EventTemplate>| r.unwrap_err().code().to_owned();

        assert_eq!(
            refused(save(&db.pool, "  ", gym(), false, 1).await),
            "invalid_input"
        );
        let long = "x".repeat(MAX_NAME + 1);
        assert_eq!(
            refused(save(&db.pool, &long, gym(), false, 1).await),
            "invalid_input"
        );

        let mut zero = gym();
        zero.length = 0;
        let mut colour = gym();
        colour.color_id = "12".into();
        let mut reminders = gym();
        reminders.reminders = vec![
            TemplateReminder {
                method: ReminderMethod::Popup,
                minutes: 5,
            };
            6
        ];
        let mut guest = gym();
        guest.guests = vec![TemplateGuest {
            name: Some("Sam".into()),
            address: "sam".into(),
            optional: false,
        }];
        for fields in [zero, colour, reminders, guest] {
            assert_eq!(
                refused(save(&db.pool, "Bad", fields, false, 1).await),
                "invalid_input"
            );
        }
        assert!(list(&db.pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_row_that_no_longer_reads_is_skipped() {
        let db = TestDb::new().await;
        save(&db.pool, "Gym", gym(), false, 1).await.unwrap();
        db::templates::insert(
            &db.pool,
            &TemplateRow {
                id: "broken".into(),
                name: "Broken".into(),
                fields: "{".into(),
                created_ms: 1,
                updated_ms: 1,
            },
        )
        .await
        .unwrap();
        let names: Vec<_> = list(&db.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert_eq!(names, ["Gym"]);
    }
}
