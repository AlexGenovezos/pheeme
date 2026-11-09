//! Which attachments the preview panel can show, and which Pheeme will hand to the user's
//! default app. Mirrors `src/mail/preview/kinds.ts`; the extension decides first because
//! senders often label every file `application/octet-stream`.

/// Extensions the preview panel draws itself.
const PREVIEWABLE: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "txt", "md", "log", "json",
    "xml", "csv", "tsv", "docx", "xlsx", "pptx",
];

/// Extensions safe to open in the default app: documents, images and media. Executables,
/// scripts, installers, archives, web pages and anything that imports data on open (calendar
/// invites, contacts) are left out, since a file Pheeme writes carries no quarantine mark.
const OPENABLE: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff",
    "txt", "md", "log", "csv", "tsv", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt",
    "ods", "odp", "pages", "numbers", "key", "mp3", "m4a", "wav", "aac", "flac", "ogg", "mp4",
    "mov", "m4v", "webm",
];

/// MIME types (without parameters) that stand for a previewable kind when the name has no
/// known extension.
const PREVIEWABLE_MIME: &[&str] = &[
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/avif",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

/// The lowercased extension of a file name, if it has one.
pub fn extension(filename: Option<&str>) -> Option<String> {
    let name = filename?.rsplit(['/', '\\']).next()?;
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty() && !ext.is_empty()).then(|| ext.to_ascii_lowercase())
}

fn essence(mime: Option<&str>) -> String {
    mime.unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// Whether the preview panel can show this file.
pub fn previewable(filename: Option<&str>, mime: Option<&str>) -> bool {
    match extension(filename) {
        Some(ext) if PREVIEWABLE.contains(&ext.as_str()) => true,
        // A known extension that isn't previewable wins over a hopeful MIME type.
        Some(ext) if OPENABLE.contains(&ext.as_str()) => false,
        _ => PREVIEWABLE_MIME.contains(&essence(mime).as_str()),
    }
}

/// Whether Pheeme will open this file in the default app. Goes by extension only: the
/// operating system picks the app by extension, whatever the MIME type claims.
pub fn openable(filename: Option<&str>) -> bool {
    extension(filename).is_some_and(|ext| OPENABLE.contains(&ext.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_is_the_last_dotted_part_lowercased() {
        assert_eq!(extension(Some("Plan.PDF")).as_deref(), Some("pdf"));
        assert_eq!(extension(Some("a.tar.gz")).as_deref(), Some("gz"));
        assert_eq!(extension(Some(".bashrc")), None);
        assert_eq!(extension(Some("README")), None);
        assert_eq!(extension(Some("dir.d/notes")), None);
        assert_eq!(extension(None), None);
    }

    #[test]
    fn previewable_prefers_the_extension() {
        assert!(previewable(
            Some("Meeting 31Aug24.pdf"),
            Some("application/octet-stream")
        ));
        assert!(previewable(Some("budget.xlsx"), None));
        assert!(previewable(Some("scan"), Some("image/jpeg; name=scan")));
        assert!(previewable(Some("deck.PPTX"), Some("application/octet-stream")));
        assert!(!previewable(Some("slides.ppt"), Some("application/pdf")));
        assert!(!previewable(Some("archive.zip"), Some("application/zip")));
        assert!(!previewable(Some("page.html"), Some("text/html")));
        assert!(!previewable(None, Some("text/html")));
    }

    #[test]
    fn only_documents_and_media_open_in_the_default_app() {
        for ok in ["a.pdf", "b.DOCX", "c.xls", "d.key", "e.mov", "f.heic"] {
            assert!(openable(Some(ok)), "{ok}");
        }
        for no in [
            "setup.exe",
            "run.command",
            "x.sh",
            "Thing.app",
            "a.dmg",
            "a.zip",
            "page.html",
            "image.svg",
            "invite.ics",
            "macro.docm",
            "noext",
        ] {
            assert!(!openable(Some(no)), "{no}");
        }
        assert!(!openable(None));
    }
}
