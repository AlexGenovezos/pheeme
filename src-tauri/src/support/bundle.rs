//! The diagnostics zip: `summary.json` and the newest log text, scrubbed and trimmed to size.

use super::scrub::scrub;
use super::SupportError;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// The log text read at most (the zip is trimmed further to `max_bytes`).
pub const MAX_LOG_BYTES: usize = 20 * 1024 * 1024;

pub struct BundleInput {
    pub note: String,
    pub reply_to: Option<String>,
    pub summary: serde_json::Value,
    pub log_dir: Option<PathBuf>,
    pub own_addresses: Vec<String>,
    pub max_bytes: usize,
}

const LOG_FILE: &str = "pheeme.log";

/// The zip: `summary.json` (the summary plus the note and reply address) and
/// `logs/pheeme.log`, the newest [`MAX_LOG_BYTES`] of log text, scrubbed. While the zip is
/// over `max_bytes` the log is halved, dropping the oldest lines.
pub fn build(input: &BundleInput) -> Result<Vec<u8>, SupportError> {
    let mut summary = input.summary.clone();
    if let Some(fields) = summary.as_object_mut() {
        fields.insert("note".into(), input.note.clone().into());
        fields.insert("replyTo".into(), input.reply_to.clone().into());
    }
    let summary =
        serde_json::to_vec_pretty(&summary).map_err(|e| SupportError::Internal(e.to_string()))?;
    let log = input
        .log_dir
        .as_deref()
        .map(|dir| read_logs(dir, MAX_LOG_BYTES))
        .unwrap_or_default();
    let mut log = scrub(&log, &input.own_addresses, std::env::home_dir().as_deref());
    loop {
        let zip = write_zip(&summary, &log)?;
        if zip.len() <= input.max_bytes {
            return Ok(zip);
        }
        if log.is_empty() {
            return Err(SupportError::TooLarge);
        }
        log = tail(&log, log.len() / 2).to_owned();
    }
}

/// `pheeme.log` and its rotations (`pheeme.log.1` is the newest), oldest first.
fn log_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(u32, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let age = match name.strip_prefix(LOG_FILE)? {
                "" => 0,
                rotation => rotation.strip_prefix('.')?.parse().ok()?,
            };
            Some((age, entry.path()))
        })
        .collect();
    files.sort_by_key(|(age, _)| std::cmp::Reverse(*age));
    files.into_iter().map(|(_, path)| path).collect()
}

/// The newest `max` bytes of the logs in `dir`, oldest line first.
fn read_logs(dir: &Path, max: usize) -> String {
    let mut newest_first = Vec::new();
    let mut total = 0;
    for path in log_files(dir).iter().rev() {
        if total >= max {
            break;
        }
        // A file rotated away meanwhile is skipped.
        if let Ok(bytes) = std::fs::read(path) {
            total += bytes.len();
            newest_first.push(bytes);
        }
    }
    newest_first.reverse();
    let text = String::from_utf8_lossy(&newest_first.concat()).into_owned();
    tail(&text, max).to_owned()
}

/// At most the last `max` bytes of `text`, from the start of a line when it had to cut.
fn tail(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let rest = &text[start..];
    match rest.find('\n') {
        Some(end) => &rest[end + 1..],
        None => rest,
    }
}

fn write_zip(summary: &[u8], log: &str) -> Result<Vec<u8>, SupportError> {
    let failed = |e: &dyn std::fmt::Display| SupportError::Internal(e.to_string());
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("summary.json", options)
        .map_err(|e| failed(&e))?;
    zip.write_all(summary).map_err(|e| failed(&e))?;
    zip.start_file("logs/pheeme.log", options)
        .map_err(|e| failed(&e))?;
    zip.write_all(log.as_bytes()).map_err(|e| failed(&e))?;
    Ok(zip.finish().map_err(|e| failed(&e))?.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn input(log_dir: &std::path::Path, max_bytes: usize) -> BundleInput {
        BundleInput {
            note: "It was slow".into(),
            reply_to: Some("me@gmail.com".into()),
            summary: serde_json::json!({"version": "0.12.0"}),
            log_dir: Some(log_dir.to_path_buf()),
            own_addresses: vec!["me@gmail.com".into()],
            max_bytes,
        }
    }

    fn read(zip: &[u8], name: &str) -> String {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip)).unwrap();
        let mut text = String::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text
    }

    #[test]
    fn bundle_contains_summary_and_newest_logs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pheeme.log.2"), "oldest bob@x.com\n").unwrap();
        std::fs::write(dir.path().join("pheeme.log.1"), "old\n").unwrap();
        std::fs::write(dir.path().join("pheeme.log"), "new\n").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "unrelated\n").unwrap();

        let zip = build(&input(dir.path(), 4_500_000)).unwrap();

        let summary: serde_json::Value = serde_json::from_str(&read(&zip, "summary.json")).unwrap();
        assert_eq!(summary["version"], "0.12.0");
        assert_eq!(summary["note"], "It was slow");
        assert_eq!(summary["replyTo"], "me@gmail.com");
        let log = read(&zip, "logs/pheeme.log");
        assert_eq!(log, "oldest <email>\nold\nnew\n");
    }

    #[test]
    fn bundle_without_logs_still_has_a_summary() {
        let dir = tempfile::tempdir().unwrap();
        let zip = build(&input(&dir.path().join("missing"), 4_500_000)).unwrap();
        assert_eq!(read(&zip, "logs/pheeme.log"), "");
        assert!(read(&zip, "summary.json").contains("0.12.0"));
    }

    #[test]
    fn tail_starts_at_a_line() {
        assert_eq!(tail("one\ntwo\nthree\n", 100), "one\ntwo\nthree\n");
        assert_eq!(tail("one\ntwo\nthree\n", 8), "three\n");
        assert_eq!(tail("ééé", 3), "é");
    }

    #[test]
    fn bundle_trims_to_max_bytes() {
        use rand::RngCore;
        let dir = tempfile::tempdir().unwrap();
        let mut rng = rand::thread_rng();
        let mut log = String::new();
        let mut bytes = [0u8; 50];
        while log.len() < 10 * 1024 * 1024 {
            rng.fill_bytes(&mut bytes);
            for b in bytes {
                log.push_str(&format!("{b:02x}"));
            }
            log.push('\n');
        }
        log.push_str("the newest line\n");
        std::fs::write(dir.path().join("pheeme.log"), &log).unwrap();

        let zip = build(&input(dir.path(), 1024 * 1024)).unwrap();

        assert!(zip.len() <= 1024 * 1024, "{} bytes", zip.len());
        let kept = read(&zip, "logs/pheeme.log");
        assert!(kept.ends_with("the newest line\n"));
        assert!(kept.len() > 256 * 1024, "kept only {} bytes", kept.len());
    }
}
