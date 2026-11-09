//! The themes folder (`{app data}/themes`): theme files dropped there show up in
//! Settings › Appearance, as T3 Code does with `~/.t3/userdata/themes`. Rust only
//! lists and reads the files; the frontend parses them (Pheeme, VS Code or T3 Code).
use super::CommandError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// More files than any real theme collection; bounds the work on a cluttered folder.
const MAX_FILES: usize = 200;
/// A large VS Code theme with syntax colors is ~100 KB.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
pub struct ThemeFolderFile {
    pub name: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct ThemeFolderDto {
    pub path: String,
    pub files: Vec<ThemeFolderFile>,
}

fn error(code: &str, message: String) -> CommandError {
    CommandError {
        code: code.into(),
        message,
    }
}

fn themes_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| error("themes_folder", format!("No app data folder ({e}).")))?
        .join("themes");
    std::fs::create_dir_all(&dir).map_err(|e| {
        error(
            "themes_folder",
            format!("Couldn't create the themes folder ({e})."),
        )
    })?;
    Ok(dir)
}

/// The `.json`/`.jsonc` files directly in `dir`, by name. Unreadable or oversized files are skipped.
pub fn read_theme_files(dir: &Path) -> std::io::Result<Vec<ThemeFolderFile>> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("json") || e.eq_ignore_ascii_case("jsonc"))
        })
        .collect();
    paths.sort();
    Ok(paths
        .into_iter()
        .take(MAX_FILES)
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
                return None;
            }
            Some(ThemeFolderFile {
                name: path.file_name()?.to_string_lossy().into_owned(),
                text: std::fs::read_to_string(&path).ok()?,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn list_theme_folder(app: AppHandle) -> Result<ThemeFolderDto, CommandError> {
    let dir = themes_dir(&app)?;
    let read = dir.clone();
    let files = tauri::async_runtime::spawn_blocking(move || read_theme_files(&read))
        .await
        .map_err(|_| error("themes_folder", "Couldn't read the themes folder.".into()))?
        .map_err(|e| {
            error(
                "themes_folder",
                format!("Couldn't read the themes folder ({e})."),
            )
        })?;
    Ok(ThemeFolderDto {
        path: dir.to_string_lossy().into_owned(),
        files,
    })
}

#[tauri::command]
pub fn open_theme_folder(app: AppHandle) -> Result<(), CommandError> {
    let dir = themes_dir(&app)?;
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| {
        error(
            "open_failed",
            format!("Couldn't open the themes folder ({e})."),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_json_files_in_name_order_and_skips_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("b.json"), "{\"b\":1}").unwrap();
        std::fs::write(dir.path().join("a.JSONC"), "{}").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "no").unwrap();
        std::fs::create_dir(dir.path().join("sub.json")).unwrap();
        let big = vec![b' '; (MAX_FILE_BYTES + 1) as usize];
        std::fs::write(dir.path().join("huge.json"), big).unwrap();

        let files = read_theme_files(dir.path()).unwrap();
        let names: Vec<_> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["a.JSONC", "b.json"]);
        assert_eq!(files[1].text, "{\"b\":1}");
    }
}
