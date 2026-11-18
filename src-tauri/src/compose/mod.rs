//! Writing mail: new messages, Reply / Reply All / Forward, Gmail drafts, and sends with
//! an undo window. Tauri-free; commands are thin adapters over [`ComposeService`].
//!
//! Messages are built here ([`build`]). Sends go through the outbox like every other
//! change (so they survive going offline and are never sent twice); drafts are saved
//! straight to Gmail's drafts API, and the UI keeps the content if that fails.

pub mod build;
pub mod signatures;
pub mod staging;
pub mod template;

use crate::db::messages::DbMessage;
use crate::db::{accounts, attachments, messages};
use crate::gmail::mime::{self, EmailAddress};
use crate::gmail::types::SendAs;
use crate::lock::lock;
use crate::mail::{MailError, MailService};
use crate::sync::engine::now_ms;
use crate::sync::manager::SyncManager;
use crate::sync::outbox::{self, FailedSend, ReturnedDraft, SendOptions};
use crate::sync::MailApi;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use staging::Staging;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use template::Original;

/// Gmail's limit on attachments per message.
pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
/// Longest undo-send window accepted.
pub const MAX_UNDO_MS: u64 = 60_000;
/// Staged attachment files older than this are swept at startup.
const STAGING_MAX_AGE: Duration = Duration::from_secs(3 * 24 * 60 * 60);
/// How long a send, a save or a reply template waits for the account's send-as addresses
/// before going on without them.
const SEND_AS_WAIT: Duration = Duration::from_secs(5);
/// How long a failed send-as lookup is remembered, so the ones after it don't wait again.
const SEND_AS_RETRY: Duration = Duration::from_secs(120);

/// A message being written, as the compose panel holds it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ComposeDraft {
    /// The address it goes out from: the account's own or one of its send-as aliases.
    /// `None` is the account's default send-as address.
    pub from: Option<EmailAddress>,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub bcc: Vec<EmailAddress>,
    pub subject: String,
    /// The editor's HTML.
    pub body_html: String,
    /// Reply/forward: the quoted original, sent below `body_html` (shown collapsed).
    pub quote_html: Option<String>,
    pub attachments: Vec<StagedAttachment>,
    /// Threading headers (`Message-ID`s with angle brackets).
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    /// Gmail thread a reply belongs in.
    pub thread_id: Option<String>,
    /// The saved Gmail draft this message updates (and replaces when sent).
    pub draft_id: Option<String>,
}

/// An attachment's bytes, held for the compose panel (see [`staging`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedAttachment {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    /// Images the quoted HTML shows through `cid:`; sent inline.
    #[serde(default)]
    pub content_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComposeMode {
    Reply,
    ReplyAll,
    Forward,
}

/// An address the account can send from (Gmail's "Send mail as"), for the From picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAsAddress {
    pub email: String,
    pub name: Option<String>,
    pub is_primary: bool,
    /// Gmail's default for new messages.
    pub is_default: bool,
    /// This address's Gmail signature (sanitized HTML), `None` when it has none.
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDraft {
    pub draft_id: String,
    pub message_id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub draft_id: String,
    pub message_id: String,
    pub thread_id: String,
    /// From the cache; empty until sync has the draft.
    pub subject: Option<String>,
    pub to: Vec<EmailAddress>,
    pub snippet: Option<String>,
    pub date: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedSend {
    /// Outbox op: cancel it with `cancel_send`, follow it via `outbox:send_status`.
    pub op_id: String,
    /// When it leaves (Unix ms); undo is possible until then.
    pub send_at: i64,
}

#[derive(Clone)]
pub struct ComposeService {
    db: SqlitePool,
    sync: Arc<SyncManager>,
    mail: MailService,
    staging: Staging,
    /// Each account's sendable addresses, from the last `sendAs` fetch this session.
    send_as: Arc<Mutex<HashMap<String, Vec<SendAs>>>>,
    /// When each account's last `sendAs` lookup failed (offline, or no settings scope).
    send_as_failed: Arc<Mutex<HashMap<String, Instant>>>,
}

impl ComposeService {
    /// Encrypted staged attachments live under `cache_dir/compose-v1`.
    pub fn new(
        db: SqlitePool,
        sync: Arc<SyncManager>,
        mail: MailService,
        cache_dir: &Path,
        key: crate::storage::StorageKey,
    ) -> Self {
        Self {
            db,
            sync,
            mail,
            staging: Staging::new(cache_dir, key),
            send_as: Arc::default(),
            send_as_failed: Arc::default(),
        }
    }

    /// Clear attachments left staged by compose windows that never cleaned up.
    pub async fn sweep_staging(&self) {
        self.staging.sweep(STAGING_MAX_AGE).await;
    }

    fn api(&self, account_id: &str) -> Arc<dyn MailApi> {
        self.sync.api(account_id)
    }

    async fn sender(&self, account_id: &str) -> Result<EmailAddress, MailError> {
        let account = accounts::get_account(&self.db, account_id)
            .await?
            .ok_or_else(|| MailError::Invalid("That account isn't connected any more.".into()))?;
        Ok(EmailAddress {
            name: account.display_name.filter(|n| !n.trim().is_empty()),
            address: account.email,
        })
    }

    /// Gmail's whole `sendAs` list for the account; the sendable part is kept for later.
    async fn fetch_send_as(&self, account_id: &str) -> Result<Vec<SendAs>, MailError> {
        let me = self.sender(account_id).await?;
        let list = self.api(account_id).list_send_as().await?;
        let sendable = list
            .iter()
            .filter(|s| s.sendable() || same_address(&s.send_as_email, &me.address))
            .cloned()
            .collect();
        lock(&self.send_as).insert(account_id.to_owned(), sendable);
        lock(&self.send_as_failed).remove(account_id);
        Ok(list)
    }

    fn cached_send_as(&self, account_id: &str) -> Option<Vec<SendAs>> {
        lock(&self.send_as).get(account_id).cloned()
    }

    /// The account's sendable addresses: from this session's fetch, else fetched now.
    /// `None` when Gmail can't be asked (offline, or the settings scope wasn't granted).
    ///
    /// Sends, saves and reply templates call this, so it never holds them up for long: it
    /// doesn't ask while Google is known to be unreachable, gives up after [`SEND_AS_WAIT`],
    /// and after a failure doesn't ask again for [`SEND_AS_RETRY`].
    async fn known_send_as(&self, account_id: &str) -> Option<Vec<SendAs>> {
        if let Some(list) = self.cached_send_as(account_id) {
            return Some(list);
        }
        if !self.sync.online() {
            return None;
        }
        let failed_recently = lock(&self.send_as_failed)
            .get(account_id)
            .is_some_and(|at| at.elapsed() < SEND_AS_RETRY);
        if failed_recently {
            return None;
        }
        match tokio::time::timeout(SEND_AS_WAIT, self.fetch_send_as(account_id)).await {
            Ok(Ok(_)) => return self.cached_send_as(account_id),
            Ok(Err(e)) => tracing::info!(error = %e, "send-as addresses unavailable"),
            Err(_) => tracing::info!("send-as addresses took too long; going on without them"),
        }
        lock(&self.send_as_failed).insert(account_id.to_owned(), Instant::now());
        None
    }

    /// The addresses the account can send from (its own first), fetched from Gmail now.
    pub async fn send_as_addresses(
        &self,
        account_id: &str,
    ) -> Result<Vec<SendAsAddress>, MailError> {
        let me = self.sender(account_id).await?;
        self.fetch_send_as(account_id).await?;
        let mut list: Vec<SendAsAddress> = self
            .cached_send_as(account_id)
            .unwrap_or_default()
            .iter()
            .map(|s| SendAsAddress {
                email: s.send_as_email.trim().to_owned(),
                name: alias_address(s, &me).name,
                is_primary: s.is_primary,
                is_default: s.is_default,
                signature: s
                    .signature
                    .as_deref()
                    .map(template::clean_html)
                    .filter(|html| !html.trim().is_empty()),
            })
            .collect();
        list.sort_by_key(|a| !a.is_primary);
        Ok(list)
    }

    /// Who `draft` goes out from: its `from` when the account can send from it (or Gmail
    /// can't be asked), else the account's default send-as address, else its own.
    async fn sending_address(
        &self,
        account_id: &str,
        draft: &ComposeDraft,
    ) -> Result<EmailAddress, MailError> {
        let me = self.sender(account_id).await?;
        let known = self.known_send_as(account_id).await;
        if let Some(from) = draft.from.as_ref().filter(|f| !f.address.trim().is_empty()) {
            let named = |f: &EmailAddress, fallback: Option<String>| EmailAddress {
                name: f.name.clone().filter(|n| !n.trim().is_empty()).or(fallback),
                address: f.address.trim().to_owned(),
            };
            if same_address(&from.address, &me.address) {
                return Ok(named(from, me.name.clone()));
            }
            match known.as_deref() {
                None => return Ok(named(from, None)),
                Some(list) => {
                    if let Some(alias) = list
                        .iter()
                        .find(|s| same_address(&s.send_as_email, &from.address))
                    {
                        return Ok(named(from, alias_address(alias, &me).name));
                    }
                    tracing::warn!("From isn't one of the account's addresses; using the default");
                }
            }
        }
        Ok(known
            .as_deref()
            .and_then(|list| list.iter().find(|s| s.is_default))
            .map(|s| alias_address(s, &me))
            .unwrap_or(me))
    }

    /// The RFC 2822 message for `draft`, sent from the account (or the alias it names).
    async fn render(
        &self,
        account_id: &str,
        draft: &ComposeDraft,
        message_id: &str,
    ) -> Result<Vec<u8>, MailError> {
        let from = self.sending_address(account_id, draft).await?;
        let mut files = Vec::with_capacity(draft.attachments.len());
        for att in &draft.attachments {
            files.push((att.clone(), self.staging.read(att).await?));
        }
        build::build_message(&build::Outgoing {
            from: &from,
            draft,
            attachments: &files,
            message_id,
            date: SystemTime::now(),
        })
    }

    /// A reply, reply-all or forward of a cached message, from the account that has it.
    pub async fn template(
        &self,
        account_id: &str,
        message_id: &str,
        mode: ComposeMode,
    ) -> Result<ComposeDraft, MailError> {
        let mut msg = messages::get_message(&self.db, account_id, message_id)
            .await?
            .ok_or(MailError::NotFound)?;
        if msg.fully_fetched == 0 {
            let engine = self.sync.engine(account_id);
            match engine.load_thread_bodies(&msg.thread_id).await {
                Ok(()) => {
                    if let Some(fresh) =
                        messages::get_message(&self.db, account_id, message_id).await?
                    {
                        msg = fresh;
                    }
                }
                // Offline: quote what's cached (the snippet).
                Err(e) => tracing::info!(error = %e, "replying without the full original"),
            }
        }
        let me = self.sender(account_id).await?;
        let headers = msg.headers();
        let header = |name: &str| {
            headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case(name))
                .map(|h| h.value.as_str())
        };
        let original = Original {
            thread_id: msg.thread_id.clone(),
            from: msg.from_address.clone().map(|address| EmailAddress {
                name: msg.from_name.clone(),
                address,
            }),
            reply_to: header("Reply-To")
                .map(|v| mime::parse_addresses("Reply-To", v))
                .unwrap_or_default(),
            to: msg.to(),
            cc: msg.cc(),
            delivered_to: headers
                .iter()
                .filter(|h| h.name.eq_ignore_ascii_case("Delivered-To"))
                .map(|h| h.value.trim().to_owned())
                .collect(),
            subject: msg.subject.clone(),
            date: msg.date,
            message_id: msg.rfc822_message_id.clone(),
            references: header("References")
                .map(|v| {
                    mime::decode_header_value("References", v)
                        .split_whitespace()
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            body_html: msg.body_html.clone(),
            body_text: msg.body_text.clone(),
            snippet: msg.snippet.clone(),
        };
        // Sent from the address the original came to (Gmail's rule), else the default one.
        let send_as = self.known_send_as(account_id).await.unwrap_or_default();
        let mut mine: Vec<&str> = vec![me.address.as_str()];
        mine.extend(
            send_as
                .iter()
                .map(|s| s.send_as_email.as_str())
                .filter(|a| !same_address(a, &me.address)),
        );
        let mut draft = template::template(mode, &original, &mine, &chrono::Local);
        draft.from = template::reply_from(&original, &mine)
            .and_then(|address| {
                send_as
                    .iter()
                    .find(|s| same_address(&s.send_as_email, address))
                    .map(|s| alias_address(s, &me))
                    .or_else(|| same_address(address, &me.address).then(|| me.clone()))
            })
            .or_else(|| {
                send_as
                    .iter()
                    .find(|s| s.is_default)
                    .map(|s| alias_address(s, &me))
            });

        // The images the quote shows (`cid:`) go along; a forward also carries the files.
        {
            let mut rows =
                attachments::get_attachments_for_message(&self.db, account_id, message_id).await?;
            let forward = mode == ComposeMode::Forward;
            rows.retain(|r| {
                if forward {
                    // The invitation beside the body isn't a file (the invite card stands in
                    // for it), so it isn't forwarded as one.
                    !is_calendar_body_part(r)
                } else {
                    r.is_inline != 0 && r.content_id.is_some()
                }
            });
            rows.sort_by_key(|r| r.id.parse::<u64>().unwrap_or(u64::MAX));
            for row in rows {
                let staged = async {
                    let bytes = self
                        .mail
                        .attachment(account_id, message_id, &row.id)
                        .await?;
                    self.staging
                        .stage_bytes(
                            row.filename.as_deref().unwrap_or("attachment"),
                            &bytes.mime_type,
                            row.content_id.clone().filter(|_| row.is_inline != 0),
                            &bytes.bytes,
                        )
                        .await
                }
                .await;
                match staged {
                    Ok(staged) => draft.attachments.push(staged),
                    // A reply only carries the images its quote shows: without one (offline,
                    // say) the quote goes out with that image missing.
                    Err(e) if !forward => {
                        tracing::info!(error = %e, "replying without an inline image");
                    }
                    Err(e) => {
                        self.discard_staged(&draft.attachments).await;
                        return Err(e);
                    }
                }
            }
        }
        Ok(draft)
    }

    /// The signature set in Gmail for the account's own address (sanitized HTML), or `None`
    /// when it has none.
    pub async fn gmail_signature(&self, account_id: &str) -> Result<Option<String>, MailError> {
        let me = self.sender(account_id).await?;
        let list = self.fetch_send_as(account_id).await?;
        let mine = list
            .iter()
            .find(|s| same_address(&s.send_as_email, &me.address))
            .or_else(|| list.iter().find(|s| s.is_primary));
        Ok(mine
            .and_then(|s| s.signature.as_deref())
            .map(template::clean_html)
            .filter(|html| !html.trim().is_empty()))
    }

    pub async fn stage_file(&self, path: &Path) -> Result<StagedAttachment, MailError> {
        self.staging.stage_file(path).await
    }

    pub async fn stage_pasted(
        &self,
        name: &str,
        mime_type: &str,
        bytes: &[u8],
    ) -> Result<StagedAttachment, MailError> {
        self.staging.stage_pasted(name, mime_type, bytes).await
    }

    /// Drop files staged for a message that won't be opened after all.
    async fn discard_staged(&self, staged: &[StagedAttachment]) {
        let ids: Vec<String> = staged.iter().map(|a| a.id.clone()).collect();
        self.staging.discard(&ids).await;
    }

    /// The compose panel closed (sent, discarded or saved): drop its staged files.
    pub async fn discard_attachments(&self, ids: &[String]) {
        self.staging.discard(ids).await;
    }

    /// Save to Gmail Drafts: a new draft, or the one `draft.draft_id` names (re-created if
    /// it was deleted elsewhere).
    pub async fn save_draft(
        &self,
        account_id: &str,
        draft: &ComposeDraft,
    ) -> Result<SavedDraft, MailError> {
        let raw = self.render(account_id, draft, &new_message_id()).await?;
        let api = self.api(account_id);
        let thread = draft.thread_id.as_deref();
        let saved = match draft.draft_id.as_deref() {
            Some(id) => match api.update_draft(id, &raw, thread).await {
                Err(e) if e.is_not_found() => api.create_draft(&raw, thread).await,
                other => other,
            },
            None => api.create_draft(&raw, thread).await,
        }?;
        self.sync.trigger(Some(account_id.to_owned()));
        let message = saved.message.unwrap_or_default();
        Ok(SavedDraft {
            draft_id: saved.id,
            message_id: message.id,
            thread_id: message.thread_id,
        })
    }

    async fn all_drafts(
        &self,
        api: &dyn MailApi,
    ) -> Result<Vec<crate::gmail::types::Draft>, MailError> {
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let page = api.list_drafts(token.as_deref()).await?;
            out.extend(page.drafts);
            match page.next_page_token {
                Some(t) => token = Some(t),
                None => return Ok(out),
            }
        }
    }

    pub async fn list_drafts(&self, account_id: &str) -> Result<Vec<DraftSummary>, MailError> {
        let api = self.api(account_id);
        let mut out = Vec::new();
        for d in self.all_drafts(api.as_ref()).await? {
            let Some(m) = d.message else { continue };
            let cached = messages::get_message(&self.db, account_id, &m.id).await?;
            out.push(DraftSummary {
                draft_id: d.id,
                message_id: m.id,
                thread_id: m.thread_id,
                subject: cached.as_ref().and_then(|c| c.subject.clone()),
                to: cached.as_ref().map(DbMessage::to).unwrap_or_default(),
                snippet: cached.as_ref().and_then(|c| c.snippet.clone()),
                date: cached.and_then(|c| c.date).unwrap_or(0),
            });
        }
        out.sort_by_key(|d| std::cmp::Reverse(d.date));
        Ok(out)
    }

    /// Open the draft behind a message in Drafts for editing.
    pub async fn open_draft(
        &self,
        account_id: &str,
        message_id: &str,
    ) -> Result<ComposeDraft, MailError> {
        let api = self.api(account_id);
        let draft_id = self
            .all_drafts(api.as_ref())
            .await?
            .into_iter()
            .find(|d| d.message.as_ref().is_some_and(|m| m.id == message_id))
            .map(|d| d.id)
            .ok_or(MailError::NotFound)?;
        let draft = api.get_draft(&draft_id).await?;
        let message = draft.message.ok_or(MailError::NotFound)?;
        let parsed = message.parse()?;
        let header = |name: &str| {
            parsed
                .headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case(name))
                .map(|h| h.value.as_str())
        };
        let mut attachments = Vec::new();
        for att in &parsed.attachments {
            let staged = async {
                let bytes = match (&att.data, att.attachment_id.as_deref()) {
                    (Some(data), _) => data.clone(),
                    (None, Some(id)) => api.get_attachment(&message.id, id).await?,
                    (None, None) => return Ok(None),
                };
                self.staging
                    .stage_bytes(
                        att.filename.as_deref().unwrap_or("attachment"),
                        &att.mime_type,
                        att.content_id.clone().filter(|_| att.is_inline),
                        &bytes,
                    )
                    .await
                    .map(Some)
            }
            .await;
            match staged {
                Ok(Some(staged)) => attachments.push(staged),
                Ok(None) => {}
                Err(e) => {
                    self.discard_staged(&attachments).await;
                    return Err(e);
                }
            }
        }
        let is_reply = parsed.in_reply_to.is_some();
        // The quoted original goes back where the panel keeps it: beside the editor, in the
        // sandboxed frame, never through the editor (which would render and rewrite it).
        let (body_html, quote_html) = match parsed.body_html {
            Some(html) => build::split_quote(&html),
            None => (
                build::text_to_html(parsed.body_text.as_deref().unwrap_or("")),
                None,
            ),
        };
        Ok(ComposeDraft {
            // Reopens from the address it was saved with.
            from: header("From").and_then(|v| mime::parse_addresses("From", v).into_iter().next()),
            to: parsed.to,
            cc: parsed.cc,
            bcc: header("Bcc")
                .map(|v| mime::parse_addresses("Bcc", v))
                .unwrap_or_default(),
            subject: parsed.subject.unwrap_or_default(),
            body_html,
            quote_html,
            attachments,
            in_reply_to: parsed.in_reply_to,
            references: parsed.references,
            // A new message's draft sits in a thread of its own; only replies keep theirs.
            thread_id: is_reply.then_some(parsed.thread_id),
            draft_id: Some(draft_id),
        })
    }

    pub async fn delete_draft(&self, account_id: &str, draft_id: &str) -> Result<(), MailError> {
        match self.api(account_id).delete_draft(draft_id).await {
            Ok(()) => {}
            Err(e) if e.is_not_found() => {}
            Err(e) => return Err(e.into()),
        }
        self.sync.trigger(Some(account_id.to_owned()));
        Ok(())
    }

    /// Queue the message. It leaves after `undo_ms` (capped at [`MAX_UNDO_MS`]) unless
    /// [`Self::cancel_send`] is called first.
    pub async fn send(
        &self,
        account_id: &str,
        draft: &ComposeDraft,
        undo_ms: u64,
    ) -> Result<QueuedSend, MailError> {
        if draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
            return Err(MailError::Invalid("Add at least one recipient.".into()));
        }
        let started = std::time::Instant::now();
        let raw = self.render(account_id, draft, &new_message_id()).await?;
        let render_ms = started.elapsed().as_millis() as u64;
        let undo = undo_ms.min(MAX_UNDO_MS);
        let send_at = if undo == 0 { 0 } else { now_ms() + undo as i64 };
        let op_id = outbox::queue_send(
            &self.db,
            account_id,
            &raw,
            &SendOptions {
                thread_id: draft.thread_id.clone(),
                draft_id: draft.draft_id.clone(),
                send_at,
            },
        )
        .await?;
        tracing::info!(
            op = %op_id,
            undo_ms = undo,
            render_ms,
            preparation_ms = started.elapsed().as_millis() as u64,
            "send queued"
        );
        self.sync
            .trigger_after(account_id, Duration::from_millis(undo));
        Ok(QueuedSend {
            op_id,
            send_at: send_at.max(now_ms()),
        })
    }

    /// Undo send. False when it already left (or may have).
    pub async fn cancel_send(&self, op_id: &str) -> Result<bool, MailError> {
        Ok(outbox::cancel_send(&self.db, op_id).await?)
    }

    /// The account's sends that Gmail refused or never confirmed and are still in the outbox,
    /// oldest first.
    pub async fn failed_sends(&self, account_id: &str) -> Result<Vec<FailedSend>, MailError> {
        Ok(outbox::failed_sends(&self.db, account_id).await?)
    }

    /// Put a failed or unconfirmed send back in the account's Drafts, out of the outbox, and
    /// sync so Drafts shows it. `None` when it went meanwhile.
    pub async fn reopen_failed_send(
        &self,
        account_id: &str,
        op_id: &str,
    ) -> Result<Option<ReturnedDraft>, MailError> {
        let api = self.api(account_id);
        let returned = outbox::move_to_drafts(&self.db, api.as_ref(), account_id, op_id).await?;
        if returned.is_some() {
            self.sync.trigger(Some(account_id.to_owned()));
        }
        Ok(returned)
    }
}

/// The unnamed `text/calendar` part an invitation carries beside its body (what `mail.rs`'s
/// `invite_part` ranks first, and `invitePart.ts` keeps out of the attachment list).
fn is_calendar_body_part(row: &attachments::DbAttachment) -> bool {
    let unnamed = row.filename.as_deref().is_none_or(|f| f.trim().is_empty());
    let mime = row.mime_type.as_deref().unwrap_or("").trim();
    unnamed && mime.eq_ignore_ascii_case("text/calendar")
}

fn same_address(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// A send-as entry as a From address: its display name, else (for the account's own
/// address, whose Gmail entry often has none) the account's name.
fn alias_address(s: &SendAs, me: &EmailAddress) -> EmailAddress {
    let own = same_address(&s.send_as_email, &me.address);
    EmailAddress {
        name: s
            .display_name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .or_else(|| own.then(|| me.name.clone()).flatten()),
        address: s.send_as_email.trim().to_owned(),
    }
}

fn new_message_id() -> String {
    format!("<{}@pheeme.app>", uuid::Uuid::new_v4())
}

#[cfg(test)]
mod tests;
