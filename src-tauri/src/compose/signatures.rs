//! Each account's signature choices (Settings › Signatures): Gmail's signature, the
//! account's own, or none, for new messages and for replies and forwards. Kept in
//! `app_settings` so anything that writes mail for the user, the compose panel and AI
//! assistants' drafts alike, signs it the same way.

use super::{same_address, template, ComposeService};
use crate::compose::build::html_to_text;
use crate::db::settings;
use crate::mail::MailError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SignatureChoice {
    #[default]
    Gmail,
    Custom,
    None,
}

/// What Settings › Signatures saved for an account (the frontend's `AccountSignatures`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SignatureSettings {
    pub new_messages: SignatureChoice,
    pub replies: SignatureChoice,
    /// The account's own signature (editor HTML), used where `custom` is chosen.
    pub custom: String,
}

/// Longest custom signature kept.
const MAX_CUSTOM: usize = 64 * 1024;

/// Whether `html` shows anything: text, or an image (a logo-only signature).
fn has_content(html: &str) -> bool {
    !html_to_text(html).trim().is_empty() || html.to_ascii_lowercase().contains("<img")
}

/// The block a signature takes in a message body, as the compose editor writes it.
pub fn signature_block(html: &str) -> String {
    format!("<div class=\"gmail_signature\" data-smartmail=\"gmail_signature\">{html}</div>")
}

impl ComposeService {
    /// The account's saved choices, or `None` if Settings never saved any.
    pub async fn signature_settings(
        &self,
        account_id: &str,
    ) -> Result<Option<SignatureSettings>, MailError> {
        Ok(settings::signatures(&self.db, account_id)
            .await?
            .and_then(|json| serde_json::from_str(&json).ok()))
    }

    pub async fn set_signature_settings(
        &self,
        account_id: &str,
        choices: &SignatureSettings,
    ) -> Result<(), MailError> {
        if choices.custom.len() > MAX_CUSTOM {
            return Err(MailError::Invalid("That signature is too long.".into()));
        }
        let json = serde_json::to_string(choices).map_err(|e| MailError::Invalid(e.to_string()))?;
        Ok(settings::set_signatures(&self.db, account_id, &json).await?)
    }

    /// The signature (sanitized HTML) to start a message from `from` (else Gmail's default
    /// address) with, or `None` for none: `reply` picks the replies-and-forwards choice. With
    /// Gmail's chosen, an alias takes its own Gmail signature, as in the compose panel.
    pub async fn signature_for(
        &self,
        account_id: &str,
        reply: bool,
        from: Option<&str>,
    ) -> Result<Option<String>, MailError> {
        let choices = self
            .signature_settings(account_id)
            .await?
            .unwrap_or_default();
        let picked = if reply {
            choices.replies
        } else {
            choices.new_messages
        };
        let html = match picked {
            SignatureChoice::None => None,
            SignatureChoice::Custom => Some(template::clean_html(&choices.custom)),
            SignatureChoice::Gmail => {
                let me = self.sender(account_id).await?;
                let list = self.fetch_send_as(account_id).await?;
                // Without a From, the message goes out from Gmail's default address.
                let sending = match from {
                    Some(f) => list.iter().find(|s| same_address(&s.send_as_email, f)),
                    None => list.iter().find(|s| s.is_default),
                };
                let own = || {
                    list.iter()
                        .find(|s| same_address(&s.send_as_email, &me.address))
                        .or_else(|| list.iter().find(|s| s.is_primary))
                };
                sending
                    .or_else(own)
                    .and_then(|s| s.signature.as_deref())
                    .map(template::clean_html)
            }
        };
        Ok(html.filter(|h| has_content(h)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_read_the_frontends_shape_and_default_to_gmail() {
        let s: SignatureSettings = serde_json::from_str(
            r#"{"newMessages":"custom","replies":"none","custom":"<b>A</b>"}"#,
        )
        .unwrap();
        assert_eq!(s.new_messages, SignatureChoice::Custom);
        assert_eq!(s.replies, SignatureChoice::None);
        let empty: SignatureSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, SignatureSettings::default());
        assert_eq!(empty.new_messages, SignatureChoice::Gmail);
        assert_eq!(
            serde_json::to_value(&s).unwrap()["newMessages"],
            serde_json::json!("custom")
        );
    }

    #[test]
    fn blank_signatures_have_no_content_but_a_logo_does() {
        assert!(!has_content("<div><br></div>"));
        assert!(!has_content("<p>&nbsp;</p>"));
        assert!(has_content("<p>Sam</p>"));
        assert!(has_content("<img src=\"https://x/logo.png\">"));
    }
}
