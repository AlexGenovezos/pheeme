//! Forward as attachment (Gmail web's): one new message carrying each chosen message whole,
//! as a `message/rfc822` file named after its subject. The files are staged like any other,
//! so drafts and sends carry them the usual way.

use super::build::FORWARDED_MESSAGE;
use super::{template, ComposeDraft, ComposeService, MAX_ATTACHMENT_BYTES};
use crate::db::messages;
use crate::gmail::MessageFormat;
use crate::mail::MailError;
use futures::stream::{self, StreamExt};
use std::collections::HashSet;

/// Most messages one forward carries: each is a Gmail request, and past this the files
/// would rarely fit in 25 MB anyway.
pub const MAX_FORWARDED: usize = 100;
/// Downloads in flight at once.
const DOWNLOADS_AT_ONCE: usize = 4;
/// A file name's length before `.eml`, in characters.
const MAX_NAME_CHARS: usize = 80;

fn too_big() -> MailError {
    MailError::Invalid(
        "These messages add up to more than 25 MB, Gmail's limit. Forward fewer at a time.".into(),
    )
}

/// A message to attach: its id, and Gmail's estimate of its size when known.
struct Pick {
    id: String,
    size: u64,
}

impl ComposeService {
    /// A new message (from the account, no recipients yet) with every message of
    /// `thread_ids` (oldest first, drafts left out) and each of `message_ids` attached as an
    /// `.eml` file. One conversation gives the subject `Fwd: …`; several leave it empty,
    /// as Gmail does.
    pub async fn forward_as_attachment(
        &self,
        account_id: &str,
        thread_ids: &[String],
        message_ids: &[String],
    ) -> Result<ComposeDraft, MailError> {
        let picks = self
            .forwarded_messages(account_id, thread_ids, message_ids)
            .await?;
        if picks.is_empty() {
            return Err(MailError::Invalid("There's nothing to forward.".into()));
        }
        if picks.len() > MAX_FORWARDED {
            return Err(MailError::Invalid(format!(
                "Forward up to {MAX_FORWARDED} messages at a time."
            )));
        }
        if picks.iter().map(|p| p.size).sum::<u64>() > MAX_ATTACHMENT_BYTES {
            return Err(too_big());
        }

        let count = picks.len();
        let api = self.api(account_id);
        let mut downloads = stream::iter(picks.into_iter().map(|p| p.id))
            .map(|id| {
                let api = api.clone();
                async move { api.message_raw(&id).await }
            })
            .buffered(DOWNLOADS_AT_ONCE);
        let mut names = Names::default();
        let mut subjects = Vec::with_capacity(count);
        let mut attachments = Vec::with_capacity(count);
        let mut total = 0u64;
        while let Some(raw) = downloads.next().await {
            let staged = async {
                let raw = raw?;
                total += raw.len() as u64;
                if total > MAX_ATTACHMENT_BYTES {
                    return Err(too_big());
                }
                let subject = subject_of(&raw);
                let name = names.next(subject.as_deref());
                subjects.push(subject);
                self.staging
                    .stage_bytes(&name, FORWARDED_MESSAGE, None, &raw)
                    .await
            }
            .await;
            match staged {
                Ok(staged) => attachments.push(staged),
                Err(e) => {
                    drop(downloads);
                    self.discard_staged(&attachments).await;
                    return Err(e);
                }
            }
        }

        let one_conversation = thread_ids.len() + message_ids.len() == 1;
        let subject = match subjects.first() {
            Some(first) if one_conversation => {
                template::prefixed(first.as_deref(), "Fwd: ", &["fwd:", "fw:"])
            }
            _ => String::new(),
        };
        Ok(ComposeDraft {
            subject,
            attachments,
            ..ComposeDraft::default()
        })
    }

    /// The messages to attach, in order and each once: a conversation's as Gmail has it (the
    /// cache may hold only part of it), drafts left out; sizes from Gmail, else the cache.
    async fn forwarded_messages(
        &self,
        account_id: &str,
        thread_ids: &[String],
        message_ids: &[String],
    ) -> Result<Vec<Pick>, MailError> {
        let mut picks = Vec::new();
        let mut seen = HashSet::new();
        let mut add = |id: String, size: Option<u64>| {
            if seen.insert(id.clone()) {
                picks.push(Pick {
                    id,
                    size: size.unwrap_or(0),
                });
            }
        };
        let is_draft = |labels: &[String]| labels.iter().any(|l| l == "DRAFT");
        let cached_size = |m: Option<messages::DbMessage>| {
            m.and_then(|m| m.size_estimate)
                .and_then(|s| u64::try_from(s).ok())
        };
        for thread_id in thread_ids {
            let thread = self
                .api(account_id)
                .get_thread(thread_id, MessageFormat::Minimal)
                .await?;
            for m in thread.messages {
                if is_draft(&m.label_ids) {
                    continue;
                }
                let size = match m.size_estimate {
                    Some(size) => Some(size),
                    None => cached_size(messages::get_message(&self.db, account_id, &m.id).await?),
                };
                add(m.id, size);
            }
        }
        for id in message_ids {
            let size = cached_size(messages::get_message(&self.db, account_id, id).await?);
            add(id.clone(), size);
        }
        Ok(picks)
    }
}

/// The message's own Subject header, decoded.
fn subject_of(raw: &[u8]) -> Option<String> {
    use mailparse::MailHeaderMap;
    let (headers, _) = mailparse::parse_headers(raw).ok()?;
    headers
        .get_first_value("Subject")
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// `.eml` file names from subjects: safe on every system, at most [`MAX_NAME_CHARS`] before
/// the extension, and each different (`Plans.eml`, `Plans (2).eml`) so saving them all keeps
/// every one.
#[derive(Default)]
struct Names {
    taken: HashSet<String>,
}

impl Names {
    fn next(&mut self, subject: Option<&str>) -> String {
        let stem = eml_stem(subject);
        let mut name = format!("{stem}.eml");
        let mut n = 1;
        while !self.taken.insert(name.to_lowercase()) {
            n += 1;
            name = format!("{stem} ({n}).eml");
        }
        name
    }
}

fn eml_stem(subject: Option<&str>) -> String {
    let cleaned: String = subject
        .unwrap_or("")
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:<>\"|?*".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let words = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let short: String = words.chars().take(MAX_NAME_CHARS).collect();
    let stem = short.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if stem.is_empty() {
        "(no subject)".to_owned()
    } else {
        stem.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe_short_and_distinct() {
        let mut names = Names::default();
        assert_eq!(names.next(Some("Re: Q3 plans")), "Re Q3 plans.eml");
        assert_eq!(names.next(Some("re: q3 PLANS")), "re q3 PLANS (2).eml");
        assert_eq!(names.next(Some("Re: Q3 plans")), "Re Q3 plans (3).eml");
        assert_eq!(names.next(None), "(no subject).eml");
        assert_eq!(names.next(Some(" ..  ")), "(no subject) (2).eml");
        assert_eq!(
            names.next(Some("a/b\\c<d>e\"f|g?h*i\r\nj")),
            "a b c d e f g h i j.eml"
        );
        let long = names.next(Some(&"é".repeat(200)));
        assert_eq!(long.chars().count(), MAX_NAME_CHARS + 4);
    }

    #[test]
    fn subject_comes_from_the_message_decoded() {
        let raw = b"From: a@x\r\nSubject: =?UTF-8?B?Q2Fmw6k=?=\r\n\r\nbody";
        assert_eq!(subject_of(raw).as_deref(), Some("Caf\u{e9}"));
        assert_eq!(subject_of(b"From: a@x\r\n\r\nbody"), None);
    }
}
