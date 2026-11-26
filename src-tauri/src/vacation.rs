//! The vacation responder (Gmail's out-of-office auto reply), one-to-one with Gmail's
//! `users.settings.vacation`: read when asked and saved straight to Gmail (not the outbox, like
//! labels), never cached, so every device shows the same responder. Tauri-free; the commands in
//! `commands/vacation.rs` are thin adapters over [`VacationService`].

use crate::db::accounts;
use crate::gmail::vacation::VacationSettings;
use crate::mail::MailError;
use crate::sync::manager::SyncManager;
use crate::sync::MailApi;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

/// The responder as Settings and the corner notice see it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VacationDto {
    pub enabled: bool,
    pub subject: String,
    /// The message, as HTML (a plain-text one set elsewhere is turned into HTML).
    pub html: String,
    pub only_contacts: bool,
    /// Only for Workspace accounts; always `false` for a personal one.
    pub only_domain: bool,
    /// When it starts replying (epoch ms); `None` means as soon as it's on.
    pub start_ms: Option<i64>,
    /// It replies only to mail received before this (epoch ms); `None` means until turned off.
    pub end_ms: Option<i64>,
    /// Whether the account is a Workspace one, which can limit replies to its domain. Ignored
    /// when saving.
    #[serde(default)]
    pub workspace: bool,
}

pub struct VacationService {
    db: SqlitePool,
    sync: Arc<SyncManager>,
}

impl VacationService {
    pub fn new(db: SqlitePool, sync: Arc<SyncManager>) -> Self {
        Self { db, sync }
    }

    fn api(&self, account_id: &str) -> Arc<dyn MailApi> {
        self.sync.api(account_id)
    }

    /// The account's responder as Gmail has it now.
    pub async fn get(&self, account_id: &str) -> Result<VacationDto, MailError> {
        let workspace = self.workspace(account_id).await?;
        let settings = self.api(account_id).get_vacation().await?;
        Ok(dto_of(&settings, workspace))
    }

    /// Replace the account's responder; answers with what Gmail saved.
    pub async fn set(&self, account_id: &str, dto: &VacationDto) -> Result<VacationDto, MailError> {
        let workspace = self.workspace(account_id).await?;
        let settings = settings_of(dto, workspace)?;
        let saved = self.api(account_id).update_vacation(&settings).await?;
        Ok(dto_of(&saved, workspace))
    }

    /// Turn the responder off and keep everything else as Gmail has it now (Gmail's End now),
    /// so a message changed on another device isn't overwritten with an older one.
    pub async fn end(&self, account_id: &str) -> Result<VacationDto, MailError> {
        let workspace = self.workspace(account_id).await?;
        let api = self.api(account_id);
        let mut settings = api.get_vacation().await?;
        settings.enable_auto_reply = false;
        let saved = api.update_vacation(&settings).await?;
        Ok(dto_of(&saved, workspace))
    }

    async fn workspace(&self, account_id: &str) -> Result<bool, MailError> {
        let account = accounts::get_account(&self.db, account_id)
            .await?
            .ok_or_else(|| MailError::Invalid("That account isn't connected any more.".into()))?;
        Ok(is_workspace(&account.email))
    }
}

/// A Google account on its own domain is a Workspace one; personal Gmail is `gmail.com` (or the
/// older `googlemail.com`).
fn is_workspace(email: &str) -> bool {
    let domain = email
        .rsplit_once('@')
        .map(|(_, d)| d.trim().to_ascii_lowercase());
    !matches!(
        domain.as_deref(),
        None | Some("gmail.com" | "googlemail.com")
    )
}

fn dto_of(s: &VacationSettings, workspace: bool) -> VacationDto {
    let html = match s.response_body_html.as_deref() {
        Some(html) if !html.trim().is_empty() => html.to_owned(),
        _ => html_of_text(s.response_body_plain_text.as_deref().unwrap_or_default()),
    };
    VacationDto {
        enabled: s.enable_auto_reply,
        subject: s.response_subject.clone().unwrap_or_default(),
        html,
        only_contacts: s.restrict_to_contacts,
        only_domain: workspace && s.restrict_to_domain,
        start_ms: s.start_time.as_deref().and_then(|t| t.parse().ok()),
        end_ms: s.end_time.as_deref().and_then(|t| t.parse().ok()),
        workspace,
    }
}

fn settings_of(dto: &VacationDto, workspace: bool) -> Result<VacationSettings, MailError> {
    if let (Some(start), Some(end)) = (dto.start_ms, dto.end_ms) {
        if end <= start {
            return Err(MailError::Invalid(
                "The last day can't be before the first day.".into(),
            ));
        }
    }
    Ok(VacationSettings {
        enable_auto_reply: dto.enabled,
        response_subject: Some(dto.subject.trim().to_owned()),
        // Gmail uses the HTML when it has it, as Gmail on the web sends it.
        response_body_html: Some(dto.html.clone()),
        response_body_plain_text: None,
        restrict_to_contacts: dto.only_contacts,
        restrict_to_domain: workspace && dto.only_domain,
        start_time: dto.start_ms.map(|t| t.to_string()),
        end_time: dto.end_ms.map(|t| t.to_string()),
    })
}

/// A plain-text message as HTML: escaped, a paragraph per blank-line break, `<br>` per line.
fn html_of_text(text: &str) -> String {
    let text = text.replace("\r\n", "\n");
    text.split("\n\n")
        .map(|p| p.trim_matches('\n'))
        .filter(|p| !p.trim().is_empty())
        .map(|p| {
            let lines: Vec<String> = p.lines().map(|l| escape(l)).collect();
            format!("<p>{}</p>", lines.join("<br>"))
        })
        .collect()
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;
    use crate::sync::events::RecordingEvents;
    use crate::sync::fake::FakeGmail;

    struct Harness {
        _db: TestDb,
        fake: Arc<FakeGmail>,
        service: VacationService,
    }

    async fn setup() -> Harness {
        // `TestDb::with_account` connects me@example.com: a Workspace account.
        let db = TestDb::with_account("a1").await;
        let pool = db.pool.clone();
        let fake = Arc::new(FakeGmail::new());
        let api = fake.clone();
        let sync = SyncManager::new(
            pool.clone(),
            Arc::new(move |_| api.clone() as Arc<dyn MailApi>),
            Arc::new(RecordingEvents::default()),
        );
        Harness {
            _db: db,
            service: VacationService::new(pool, sync),
            fake,
        }
    }

    fn away() -> VacationDto {
        VacationDto {
            enabled: true,
            subject: " Out of office ".into(),
            html: "<p>Back <b>Monday</b></p>".into(),
            only_contacts: true,
            only_domain: true,
            start_ms: Some(1_764_633_600_000),
            end_ms: Some(1_765_238_400_000),
            workspace: false,
        }
    }

    #[tokio::test]
    async fn saving_writes_gmails_shape_and_reads_back_the_same() {
        let h = setup().await;
        let saved = h.service.set("a1", &away()).await.unwrap();
        let held = h.fake.vacation();
        assert!(held.enable_auto_reply);
        assert_eq!(held.response_subject.as_deref(), Some("Out of office"));
        assert_eq!(
            held.response_body_html.as_deref(),
            Some("<p>Back <b>Monday</b></p>")
        );
        assert!(held.restrict_to_contacts && held.restrict_to_domain);
        assert_eq!(held.start_time.as_deref(), Some("1764633600000"));
        assert_eq!(held.end_time.as_deref(), Some("1765238400000"));
        let expected = VacationDto {
            subject: "Out of office".into(),
            workspace: true,
            ..away()
        };
        assert_eq!(saved, expected);
        assert_eq!(h.service.get("a1").await.unwrap(), expected);
    }

    #[tokio::test]
    async fn a_last_day_before_the_first_is_refused_without_calling_gmail() {
        let h = setup().await;
        let wrong = VacationDto {
            end_ms: Some(1_764_633_600_000 - 1),
            ..away()
        };
        let err = h.service.set("a1", &wrong).await.unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(h.fake.calls("update_vacation"), 0);
    }

    #[tokio::test]
    async fn end_now_turns_it_off_and_keeps_what_gmail_has() {
        let h = setup().await;
        h.service.set("a1", &away()).await.unwrap();
        let ended = h.service.end("a1").await.unwrap();
        assert!(!ended.enabled);
        assert_eq!(ended.subject, "Out of office");
        assert_eq!(ended.end_ms, Some(1_765_238_400_000));
        assert!(!h.fake.vacation().enable_auto_reply);
    }

    #[test]
    fn personal_accounts_never_limit_replies_to_a_domain() {
        assert!(!is_workspace("me@gmail.com"));
        assert!(!is_workspace("Me@GoogleMail.com"));
        assert!(is_workspace("me@company.com"));
        let s = settings_of(&away(), false).unwrap();
        assert!(!s.restrict_to_domain);
        let read = VacationSettings {
            restrict_to_domain: true,
            ..Default::default()
        };
        assert!(!dto_of(&read, false).only_domain);
    }

    #[test]
    fn a_plain_text_message_from_elsewhere_reads_as_html() {
        let read = VacationSettings {
            response_body_plain_text: Some("Away <until> Monday\r\nCall Sam\r\n\r\nThanks".into()),
            ..Default::default()
        };
        assert_eq!(
            dto_of(&read, false).html,
            "<p>Away &lt;until&gt; Monday<br>Call Sam</p><p>Thanks</p>"
        );
        assert_eq!(dto_of(&VacationSettings::default(), false).html, "");
    }
}
