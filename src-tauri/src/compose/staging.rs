//! Attachment bytes for messages being written, kept on disk under the app cache so each
//! draft save or send reads them locally instead of re-reading the user's file or
//! downloading a forwarded attachment again. Handles are random ids, never paths.

use super::{StagedAttachment, MAX_ATTACHMENT_BYTES};
use crate::mail::{safe_file_name, MailError};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(Clone)]
pub struct Staging {
    dir: PathBuf,
}

fn io(e: std::io::Error) -> MailError {
    MailError::from(anyhow::Error::new(e))
}

impl Staging {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
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
        let size = tokio::fs::copy(source, &path).await.map_err(io)?;
        Ok(StagedAttachment {
            id,
            filename: safe_file_name(Some(&name)),
            mime_type: mime,
            size,
            content_id: None,
        })
    }

    pub async fn stage_bytes(
        &self,
        filename: &str,
        mime_type: &str,
        content_id: Option<String>,
        bytes: &[u8],
    ) -> Result<StagedAttachment, MailError> {
        let (id, path) = self.slot().await?;
        tokio::fs::write(&path, bytes).await.map_err(io)?;
        Ok(StagedAttachment {
            id,
            filename: safe_file_name(Some(filename)),
            mime_type: mime_type.to_owned(),
            size: bytes.len() as u64,
            content_id,
        })
    }

    pub async fn read(&self, att: &StagedAttachment) -> Result<Vec<u8>, MailError> {
        match tokio::fs::read(self.path_of(&att.id)?).await {
            Ok(bytes) => Ok(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(MailError::Invalid(format!(
                "{} is no longer available; attach it again.",
                att.filename
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
        let staging = Staging::new(dir.path().join("compose"));
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
    async fn sweep_removes_only_old_files() {
        let dir = tempfile::tempdir().unwrap();
        let staging = Staging::new(dir.path().to_path_buf());
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
