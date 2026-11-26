//! Attachment bytes: reading through the disk cache, downloading from Gmail, saving and
//! opening copies, the `pheeme-att` inline images, calendar invitation parts and the file
//! names these produce.

use super::{MailError, MailService};
use crate::attachment_kind;
use crate::db::attachments::{self, DbAttachment};
use crate::gmail::MessageFormat;
use crate::render;
use crate::sync::engine::SyncError;
use crate::sync::MailApi;
use std::path::{Path, PathBuf};

/// An attachment's content with what is needed to serve or save it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentBytes {
    pub filename: Option<String>,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// What the `pheeme-att` protocol answers with; the Tauri adapter only converts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

impl InlineResponse {
    pub fn not_found() -> Self {
        Self {
            status: 404,
            content_type: None,
            body: Vec::new(),
        }
    }
}

/// A file name that is safe to create in a directory: only the last path component,
/// without `:`, control characters or invisible bidirectional formatting (which can make
/// `gnp.exe` display as `exe.png`), no leading/trailing dots or spaces.
pub fn safe_file_name(name: Option<&str>) -> String {
    let last = name
        .unwrap_or_default()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default();
    let cleaned: String = last
        .chars()
        .filter(|c| *c != ':' && !c.is_control() && !is_bidi_format(*c))
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() {
        "attachment".to_owned()
    } else {
        cleaned.to_owned()
    }
}

/// Invisible characters that reorder how text displays: LRM/RLM, the embeddings and
/// overrides (U+202A-U+202E), the isolates (U+2066-U+2069) and the Arabic letter mark.
fn is_bidi_format(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// [`safe_file_name`], also valid on Windows: `<>"|?*` become `_` and a reserved device name
/// (`CON.pdf`, `com1.txt`) gets a leading `_`. Used for copies opened in the default app, which
/// only need to keep the extension.
pub(super) fn openable_file_name(name: Option<&str>) -> String {
    let name: String = safe_file_name(name)
        .chars()
        .map(|c| if "<>\"|?*".contains(c) { '_' } else { c })
        .collect();
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || matches!(stem.as_bytes(), [b'C', b'O', b'M', d] | [b'L', b'P', b'T', d] if d.is_ascii_digit());
    if reserved {
        format!("_{name}")
    } else {
        name
    }
}

/// `dir/name`, or `dir/name (1).ext`, `dir/name (2).ext`, … if that already exists.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    // `symlink_metadata` (not `exists`) so a dangling symlink counts as occupied.
    let taken = |p: &Path| std::fs::symlink_metadata(p).is_ok();
    let first = dir.join(name);
    if !taken(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => name.split_at(i),
        _ => (name, ""),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !taken(p))
        .expect("an unused name exists")
}

impl MailService {
    /// An attachment's bytes: from the disk cache, else downloaded from Gmail once.
    pub async fn attachment(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_row_id: &str,
    ) -> Result<AttachmentBytes, MailError> {
        let row = attachments::get_one(&self.db, account_id, message_id, attachment_row_id)
            .await?
            .ok_or(MailError::NotFound)?;
        self.bytes_of(row).await
    }

    /// The text of the message's calendar invitation (its `text/calendar` part, else an `.ics`
    /// file), from the disk cache or Gmail; `None` when it has none.
    pub async fn invite_text(
        &self,
        account_id: &str,
        message_id: &str,
    ) -> Result<Option<String>, MailError> {
        let rows =
            attachments::get_attachments_for_message(&self.db, account_id, message_id).await?;
        let Some(row) = invite_part(&rows) else {
            return Ok(None);
        };
        let bytes = self.bytes_of(row.clone()).await?.bytes;
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// The text of a calendar file in the message: the attachment `attachment_row_id` (an
    /// `.ics` the user clicked), else the message's invitation part. `None` without either.
    pub async fn calendar_file_text(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_row_id: Option<&str>,
    ) -> Result<Option<String>, MailError> {
        let Some(id) = attachment_row_id else {
            return self.invite_text(account_id, message_id).await;
        };
        let bytes = self.attachment(account_id, message_id, id).await?.bytes;
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// The image behind a `cid:` reference; anything that isn't an `image/*` is `NotFound`.
    pub async fn inline_image(
        &self,
        account_id: &str,
        message_id: &str,
        content_id: &str,
    ) -> Result<AttachmentBytes, MailError> {
        let row = attachments::get_by_content_id(&self.db, account_id, message_id, content_id)
            .await?
            .filter(|r| {
                r.mime_type
                    .as_deref()
                    .is_some_and(|m| m.trim().to_ascii_lowercase().starts_with("image/"))
            })
            .ok_or(MailError::NotFound)?;
        self.bytes_of(row).await
    }

    /// Answers a `pheeme-att` request. The URI is parsed and its signature verified before
    /// anything else is touched; every failure is a bare 404.
    pub async fn serve_inline_image(&self, uri: &str) -> InlineResponse {
        let Some((account, message, cid)) = render::parse_attachment_request(uri) else {
            return InlineResponse::not_found();
        };
        match self.inline_image(&account, &message, &cid).await {
            // The type comes from the sender's MIME headers; it must be a valid header value.
            Ok(image) if !is_header_safe(&image.mime_type) => InlineResponse::not_found(),
            Ok(image) => InlineResponse {
                status: 200,
                content_type: Some(image.mime_type),
                body: image.bytes,
            },
            Err(e) => {
                tracing::debug!(error = %e, "inline image not served");
                InlineResponse::not_found()
            }
        }
    }

    /// Writes an attachment into `dir` under a sanitized, collision-free name and returns
    /// the path.
    pub async fn save_attachment(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_row_id: &str,
        dir: &Path,
    ) -> Result<PathBuf, MailError> {
        let att = self
            .attachment(account_id, message_id, attachment_row_id)
            .await?;
        let name = safe_file_name(att.filename.as_deref());
        write_unique(dir, &name, &att.bytes).await
    }

    async fn bytes_of(&self, row: DbAttachment) -> Result<AttachmentBytes, MailError> {
        let mime_type = row
            .mime_type
            .clone()
            .unwrap_or_else(|| "application/octet-stream".to_owned());
        let cached = self
            .attachments
            .path(&row.account_id, &row.message_id, &row.id);
        let _fetching = self.attachments.lock(&cached).await;
        let bytes = match self.attachments.read(&cached).await {
            Some(bytes) => bytes,
            None => self.download(&row, &cached).await?,
        };
        Ok(AttachmentBytes {
            filename: row.filename,
            mime_type,
            bytes,
        })
    }

    /// Fetch an attachment from Gmail and cache it at `cached`. Hold the file's
    /// [`AttachmentCache::lock`].
    async fn download(&self, row: &DbAttachment, cached: &Path) -> Result<Vec<u8>, MailError> {
        let api = self.sync.api(&row.account_id);
        let bytes = match row.attachment_id.as_deref() {
            Some(gmail_id) => api
                .get_attachment(&row.message_id, gmail_id)
                .await
                .map_err(SyncError::from)?,
            // Small parts travel inside the message: re-read it and take the part
            // at this row's index (rows are numbered in parse order).
            None => embedded_bytes(api.as_ref(), row).await?,
        };
        if let Err(e) = self.attachments.write(cached, &bytes).await {
            tracing::warn!(error = %e, "couldn't cache an attachment");
        }
        Ok(bytes)
    }

    /// Download the previewable attachments of these messages into the cache, so opening a
    /// preview is instant. Files already cached, inline images, files of unknown size and
    /// files over [`PREFETCH_MAX_FILE`] are skipped; the run stops at [`PREFETCH_MAX_TOTAL`].
    /// Failures (offline, a deleted message) are logged and skipped. Returns how many files
    /// were downloaded.
    pub async fn prefetch_attachments(&self, account_id: &str, message_ids: &[String]) -> usize {
        let mut budget = PREFETCH_MAX_TOTAL;
        let mut fetched = 0;
        for message_id in message_ids {
            let rows =
                match attachments::get_attachments_for_message(&self.db, account_id, message_id)
                    .await
                {
                    Ok(rows) => rows,
                    Err(e) => {
                        tracing::debug!(error = %e, "couldn't list attachments to prefetch");
                        continue;
                    }
                };
            for row in rows {
                let Some(size) = row.size.and_then(|s| u64::try_from(s).ok()) else {
                    continue;
                };
                if row.is_inline != 0
                    || size > PREFETCH_MAX_FILE
                    || !attachment_kind::previewable(
                        row.filename.as_deref(),
                        row.mime_type.as_deref(),
                    )
                {
                    continue;
                }
                if size > budget {
                    return fetched;
                }
                let cached = self
                    .attachments
                    .path(&row.account_id, &row.message_id, &row.id);
                let _fetching = self.attachments.lock(&cached).await;
                if self.attachments.contains(&cached).await {
                    continue;
                }
                budget -= size;
                match self.download(&row, &cached).await {
                    Ok(_) => fetched += 1,
                    Err(e) => tracing::debug!(error = %e, "couldn't prefetch an attachment"),
                }
            }
        }
        fetched
    }

    /// Copy an attachment into a fresh folder under `dir` for the default app to open, and
    /// return its path. Only documents and media qualify ([`attachment_kind::openable`]).
    /// Copies older than a day are cleared out first.
    pub async fn open_copy(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_row_id: &str,
        dir: &Path,
    ) -> Result<PathBuf, MailError> {
        let row = attachments::get_one(&self.db, account_id, message_id, attachment_row_id)
            .await?
            .ok_or(MailError::NotFound)?;
        if !attachment_kind::openable(row.filename.as_deref()) {
            return Err(MailError::Invalid(
                "Pheeme doesn't open this kind of file. Download it instead.".into(),
            ));
        }
        clear_old_copies(dir).await;
        let att = self.bytes_of(row).await?;
        let folder = dir.join(uuid::Uuid::new_v4().to_string());
        crate::storage::private_dir(dir).map_err(io_error)?;
        crate::storage::private_dir(&folder).map_err(io_error)?;
        let path = folder.join(openable_file_name(att.filename.as_deref()));
        tokio::fs::write(&path, &att.bytes)
            .await
            .map_err(io_error)?;
        Ok(path)
    }
}

/// Invitations bigger than this aren't read (a real one is a few kilobytes).
pub(super) const INVITE_MAX_BYTES: i64 = 1024 * 1024;

/// Whether an attachment is a calendar file, and how good a source of the invitation it is:
/// the `text/calendar` part Google and Outlook put beside the body (`2`) beats a named `.ics`
/// file (`1`), which may be a forwarded copy.
fn invite_rank(a: &DbAttachment) -> Option<u8> {
    let mime = a
        .mime_type
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let ics_name = a
        .filename
        .as_deref()
        .is_some_and(|f| f.to_ascii_lowercase().ends_with(".ics"));
    if a.size.is_some_and(|s| s > INVITE_MAX_BYTES) {
        return None;
    }
    if mime == "text/calendar" && !ics_name {
        Some(2)
    } else if mime == "text/calendar" || mime == "application/ics" || ics_name {
        Some(1)
    } else {
        None
    }
}

/// The attachment row to read a message's invitation from.
pub fn invite_part(rows: &[DbAttachment]) -> Option<&DbAttachment> {
    rows.iter()
        .filter_map(|a| Some((invite_rank(a)?, a)))
        .max_by_key(|(rank, _)| *rank)
        .map(|(_, a)| a)
}

/// Bytes of an attachment that has no Gmail attachment id, from the full message.
async fn embedded_bytes(api: &dyn MailApi, row: &DbAttachment) -> Result<Vec<u8>, MailError> {
    let index: usize = row.id.parse().map_err(|_| MailError::NotFound)?;
    let (_, fetched) = api
        .batch_get_messages(std::slice::from_ref(&row.message_id), MessageFormat::Full)
        .await
        .into_iter()
        .next()
        .ok_or(MailError::NotFound)?;
    let parsed = fetched
        .map_err(SyncError::from)?
        .parse()
        .map_err(SyncError::from)?;
    parsed
        .attachments
        .into_iter()
        .nth(index)
        .and_then(|a| a.data)
        .filter(|bytes| !bytes.is_empty())
        .ok_or(MailError::NotFound)
}

/// Writes `bytes` into `dir` (created if missing) as `name`, or `name (1)`, … if that is taken,
/// and returns the path.
pub(super) async fn write_unique(
    dir: &Path,
    name: &str,
    bytes: &[u8],
) -> Result<PathBuf, MailError> {
    use tokio::io::AsyncWriteExt;
    tokio::fs::create_dir_all(dir).await.map_err(io_error)?;
    // Each collision re-scans, and every occupied entry (even a dangling symlink) is
    // skipped, so this makes progress; the cap only guards against a runaway.
    for _ in 0..1000 {
        let path = unique_path(dir, name);
        // `create_new` so a file that appears after the check is never overwritten.
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(mut file) => {
                file.write_all(bytes).await.map_err(io_error)?;
                file.flush().await.map_err(io_error)?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_error(e)),
        }
    }
    Err(MailError::Invalid(
        "Couldn't find a free file name in Downloads.".into(),
    ))
}

/// Printable ASCII only: nothing that could end a header line or fail response building.
fn is_header_safe(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| (0x20..0x7f).contains(&b))
}

/// Largest single file [`MailService::prefetch_attachments`] downloads (Gmail's own limit).
pub const PREFETCH_MAX_FILE: u64 = 25 * 1024 * 1024;
/// Most one prefetch run downloads, so a thread full of attachments can't fill the cache.
pub const PREFETCH_MAX_TOTAL: u64 = 100 * 1024 * 1024;
/// Copies handed to the default app are kept this long (the app may still have one open).
pub(super) const OPEN_COPY_MAX_AGE: std::time::Duration =
    std::time::Duration::from_secs(24 * 60 * 60);

/// Remove folders under `dir` made by [`MailService::open_copy`] more than a day ago.
async fn clear_old_copies(dir: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let old = entry
            .metadata()
            .await
            .and_then(|m| m.modified())
            .is_ok_and(|t| t.elapsed().is_ok_and(|age| age > OPEN_COPY_MAX_AGE));
        if old {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}

fn io_error(e: std::io::Error) -> MailError {
    MailError::File(e.to_string())
}
