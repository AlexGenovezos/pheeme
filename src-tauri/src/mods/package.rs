use super::schema::{ensure, Manifest, MAX_JSON};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path},
};

pub const MAX_PACKAGE: u64 = 2 * 1024 * 1024;

/// Read through an already-opened handle with a cap: file growth cannot evade limits.
pub fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    ensure(
        bytes.len() as u64 <= limit,
        "Mod file exceeds the size limit",
    )?;
    Ok(bytes)
}

pub fn relative_path(path: &str) -> Result<(), String> {
    ensure(
        !path.is_empty() && !path.contains('\\') && !path.contains(':'),
        "Invalid package path",
    )?;
    ensure(
        Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_))),
        "Package paths must stay inside the mod folder",
    )
}

/// Staging copies bytes, never follows symlinks, and never executes package scripts.
pub fn stage(source: &Path, destination: &Path) -> Result<Manifest, String> {
    ensure(
        !fs::symlink_metadata(source)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink(),
        "Mod folder cannot be a symbolic link",
    )?;
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    let mut count = 0;
    let mut remaining = MAX_PACKAGE;
    copy(source, destination, 0, &mut count, &mut remaining)?;
    let manifest: Manifest = serde_json::from_slice(&read_limited(
        &destination.join("manifest.json"),
        MAX_JSON as u64,
    )?)
    .map_err(|e| format!("Invalid manifest: {e}"))?;
    manifest.validate()?;
    relative_path(&manifest.entry)?;
    ensure(
        destination.join(&manifest.entry).is_file(),
        "Mod entry file does not exist",
    )?;
    String::from_utf8(read_limited(
        &destination.join(&manifest.entry),
        MAX_PACKAGE,
    )?)
    .map_err(|_| "Mod entry must be UTF-8 JavaScript")?;
    Ok(manifest)
}

fn copy(
    source: &Path,
    destination: &Path,
    depth: usize,
    count: &mut usize,
    remaining: &mut u64,
) -> Result<(), String> {
    ensure(depth <= 8, "Mod folders are nested too deeply")?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        *count += 1;
        ensure(*count <= 128, "A mod may contain at most 128 files and folders; install a built package without node_modules")?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            fs::create_dir(&target).map_err(|e| e.to_string())?;
            copy(&entry.path(), &target, depth + 1, count, remaining)?;
        } else {
            ensure(
                kind.is_file(),
                "Symbolic links and special files are not allowed in mod packages",
            )?;
            let bytes = read_limited(&entry.path(), *remaining)?;
            *remaining -= bytes.len() as u64;
            fs::write(target, bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn atomic_json(path: &Path, value: &impl serde::Serialize) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
