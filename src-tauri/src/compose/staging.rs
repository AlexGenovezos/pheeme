//! Attachment bytes for messages being written, kept on disk under the app cache so each
//! draft save or send reads them locally instead of re-reading the user's file or
//! downloading a forwarded attachment again. Handles are random ids, never paths.

use super::{StagedAttachment, MAX_ATTACHMENT_BYTES};
use crate::gmail::mime::clean_content_id;
use crate::mail::{safe_file_name, MailError};
use crate::storage::{EncryptedFiles, StorageKey};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(Clone)]
pub struct Staging {
    dir: PathBuf,
    files: EncryptedFiles,
}

fn io(e: std::io::Error) -> MailError {
    MailError::from(anyhow::Error::new(e))
}

/// A Content-ID the compose window made for an image pasted into the text: up to 64 letters
/// and digits at `pheeme.app`. Nothing else goes into the header, so it can't break it.
pub fn is_pasted_content_id(id: &str) -> bool {
    id.strip_suffix("@pheeme.app").is_some_and(|local| {
        (1..=64).contains(&local.len()) && local.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

impl Staging {
    pub fn new(cache_dir: &Path, key: StorageKey) -> Self {
        let files = EncryptedFiles::compose(cache_dir, key);
        Self {
            dir: files.root().to_path_buf(),
            files,
        }
    }

    /// Only ids this module issued (UUIDs) map to a file; anything else is not found.
    fn path_of(&self, id: &str) -> Result<PathBuf, MailError> {
        let id = uuid::Uuid::parse_str(id).map_err(|_| MailError::NotFound)?;
        Ok(self.dir.join(id.simple().to_string()))
    }

    /// A fresh id and the path its bytes go to.
    async fn slot(&self) -> Result<(String, PathBuf), MailError> {
        tokio::fs::create_dir_all(&self.dir).await.map_err(io)?;
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.path_of(&id)?;
        Ok((id, path))
    }

    /// Copy a file the user picked (or dropped) into the staging area.
    pub async fn stage_file(&self, source: &Path) -> Result<StagedAttachment, MailError> {
        let meta = tokio::fs::metadata(source)
            .await
            .map_err(|_| MailError::Invalid(format!("Couldn't read {}.", source.display())))?;
        if !meta.is_file() {
            return Err(MailError::Invalid(format!(
                "{} isn't a file.",
                source.display()
            )));
        }
        if meta.len() > MAX_ATTACHMENT_BYTES {
            return Err(MailError::Invalid(
                "Attachments can add up to 25 MB at most.".into(),
            ));
        }
        let name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mime = mime_guess::from_path(source)
            .first_or_octet_stream()
            .essence_str()
            .to_owned();
        let (id, path) = self.slot().await?;
        let bytes = tokio::fs::read(source).await.map_err(io)?;
        if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
            return Err(MailError::Invalid(
                "Attachments can add up to 25 MB at most.".into(),
            ));
        }
        self.files.write(&path, &bytes).await.map_err(io)?;
        let size = bytes.len() as u64;
        Ok(StagedAttachment {
            id,
            filename: safe_file_name(Some(&name)),
            mime_type: mime,
            size,
            content_id: None,
        })
    }

    /// Stage a file the window holds as bytes, not a path (an image pasted from the clipboard).
    /// The type comes from the window when it's a valid MIME type, else from the name. An
    /// image pasted into the message's text comes with the Content-ID its `cid:` URL names
    /// there (see [`is_pasted_content_id`]).
    pub async fn stage_pasted(
        &self,
        name: &str,
        mime_type: &str,
        bytes: &[u8],
        content_id: Option<&str>,
    ) -> Result<StagedAttachment, MailError> {
        if content_id.is_some_and(|id| !is_pasted_content_id(id)) {
            return Err(MailError::Invalid("That image couldn't be added.".into()));
        }
        if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
            return Err(MailError::Invalid(
                "Attachments can add up to 25 MB at most.".into(),
            ));
        }
        let mime = match mime_type.parse::<mime_guess::mime::Mime>() {
            Ok(m) => m.essence_str().to_owned(),
            Err(_) => mime_guess::from_path(name)
                .first_or_octet_stream()
                .essence_str()
                .to_owned(),
        };
        self.stage_bytes(name, &mime, content_id.map(str::to_owned), bytes)
            .await
    }

    pub async fn stage_bytes(
        &self,
        filename: &str,
        mime_type: &str,
        content_id: Option<String>,
        bytes: &[u8],
    ) -> Result<StagedAttachment, MailError> {
        let (id, path) = self.slot().await?;
        self.files.write(&path, bytes).await.map_err(io)?;
        Ok(StagedAttachment {
            id,
            filename: safe_file_name(Some(filename)),
            mime_type: mime_type.to_owned(),
            size: bytes.len() as u64,
            content_id: content_id.as_deref().and_then(clean_content_id),
        })
    }

    pub async fn read(&self, att: &StagedAttachment) -> Result<Vec<u8>, MailError> {
        self.read_named(&att.id, &att.filename).await
    }

    /// A staged file's bytes by its handle (for the editor to show an inline image).
    pub async fn read_id(&self, id: &str) -> Result<Vec<u8>, MailError> {
        self.read_named(id, "That image").await
    }

    async fn read_named(&self, id: &str, filename: &str) -> Result<Vec<u8>, MailError> {
        match self.files.read(&self.path_of(id)?).await {
            Ok(bytes) => Ok(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(MailError::Invalid(format!(
                "{filename} is no longer available; attach it again."
            ))),
            Err(e) => Err(io(e)),
        }
    }

    pub async fn discard(&self, ids: &[String]) {
        for id in ids {
            if let Ok(path) = self.path_of(id) {
                let _ = tokio::fs::remove_file(path).await;
            }
        }
    }

    /// Remove files staged longer ago than `age` (compose windows closed without cleanup).
    pub async fn sweep(&self, age: Duration) {
        let Ok(mut entries) = tokio::fs::read_dir(&self.dir).await else {
            return;
        };
        let cutoff = SystemTime::now() - age;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let old = entry
                .metadata()
                .await
                .and_then(|m| m.modified())
                .is_ok_and(|t| t < cutoff);
            if old {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stage_read_discard_and_reject_foreign_ids() {
        let dir = tempfile::tempdir().unwrap();
        let staging = Staging::new(&dir.path().join("compose"), crate::storage::test_key());
        let src = dir.path().join("Report Q3.pdf");
        std::fs::write(&src, b"%PDF").unwrap();

        let att = staging.stage_file(&src).await.unwrap();
        assert_eq!(
            (att.filename.as_str(), att.mime_type.as_str(), att.size),
            ("Report Q3.pdf", "application/pdf", 4)
        );
        assert_eq!(staging.read(&att).await.unwrap(), b"%PDF");

        let mut forged = att.clone();
        forged.id = "../../etc/passwd".into();
        assert!(matches!(
            staging.read(&forged).await,
            Err(MailError::NotFound)
        ));

        staging.discard(std::slice::from_ref(&att.id)).await;
        assert!(matches!(
            staging.read(&att).await,
            Err(MailError::Invalid(_))
        ));
        assert!(staging.stage_file(dir.path()).await.is_err(), "not a file");
    }

    #[tokio::test]
    async fn stage_pasted_keeps_a_valid_type_and_guesses_a_bad_one() {
        let dir = tempfile::tempdir().unwrap();
        let staging = Staging::new(dir.path(), crate::storage::test_key());
        let att = staging
            .stage_pasted("image.png", "image/png", b"\x89PNG", None)
            .await
            .unwrap();
        assert_eq!(att.content_id, None);
        assert_eq!(
            (att.filename.as_str(), att.mime_type.as_str(), att.size),
            ("image.png", "image/png", 4)
        );
        assert_eq!(staging.read(&att).await.unwrap(), b"\x89PNG");

        let guessed = staging
            .stage_pasted("shot.jpg", "not a type\r\nX: y", b"j", None)
            .await
            .unwrap();
        assert_eq!(guessed.mime_type, "image/jpeg");

        let big = vec![0u8; MAX_ATTACHMENT_BYTES as usize + 1];
        assert!(matches!(
            staging
                .stage_pasted("big.png", "image/png", &big, None)
                .await,
            Err(MailError::Invalid(_))
        ));
    }

    #[tokio::test]
    async fn inline_pastes_keep_a_valid_content_id_and_read_back_by_id() {
        let dir = tempfile::tempdir().unwrap();
        let staging = Staging::new(dir.path(), crate::storage::test_key());
        let att = staging
            .stage_pasted(
                "image.png",
                "image/png",
                b"\x89PNG",
                Some("abc123@pheeme.app"),
            )
            .await
            .unwrap();
        assert_eq!(att.content_id.as_deref(), Some("abc123@pheeme.app"));
        assert_eq!(staging.read_id(&att.id).await.unwrap(), b"\x89PNG");
        assert!(matches!(
            staging.read_id("../../etc/passwd").await,
            Err(MailError::NotFound)
        ));
        for bad in [
            "abc@evil.example",
            "@pheeme.app",
            "a b@pheeme.app",
            "a>\r\nBcc: x@pheeme.app",
            &format!("{}@pheeme.app", "a".repeat(65)),
        ] {
            assert!(
                matches!(
                    staging
                        .stage_pasted("i.png", "image/png", b"x", Some(bad))
                        .await,
                    Err(MailError::Invalid(_))
                ),
                "{bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn sweep_removes_only_old_files() {
        let dir = tempfile::tempdir().unwrap();
        let staging = Staging::new(dir.path(), crate::storage::test_key());
        let att = staging
            .stage_bytes("a.txt", "text/plain", None, b"x")
            .await
            .unwrap();
        staging.sweep(Duration::from_secs(3600)).await;
        assert!(staging.read(&att).await.is_ok());
        staging.sweep(Duration::ZERO).await;
        assert!(staging.read(&att).await.is_err());
    }
}
