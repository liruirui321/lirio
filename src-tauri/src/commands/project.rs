use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub const MANAGED_DATA_SUBDIRS: [&str; 5] = [
    "lirio_state",
    "library",
    "submissions",
    "corpus_audio",
    "podcasts",
];

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StorageConfig {
    custom_data_dir: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub active_dir: String,
    pub default_dir: String,
    pub is_custom: bool,
    pub exists: bool,
    pub total_bytes: u64,
    pub file_count: u64,
    pub migrated_files: u64,
}

fn read_custom_data_dir_from(default_root: &Path) -> Option<PathBuf> {
    let cfg_path = default_root.join("storage_config.json");
    let raw = fs::read_to_string(cfg_path).ok()?;
    let parsed: StorageConfig = serde_json::from_str(&raw).ok()?;
    let trimmed = parsed.custom_data_dir?.trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

fn write_custom_data_dir_to(default_root: &Path, custom: Option<&Path>) -> Result<(), String> {
    fs::create_dir_all(default_root).map_err(|e| format!("无法创建默认配置目录：{e}"))?;
    let cfg = StorageConfig {
        custom_data_dir: custom.map(|p| p.to_string_lossy().to_string()),
    };
    let target = default_root.join("storage_config.json");
    let tmp = default_root.join(format!("storage_config.{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?;
    fs::write(&tmp, bytes).map_err(|e| format!("写入存储配置失败：{e}"))?;
    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("保存存储配置失败：{e}"));
    }
    Ok(())
}

pub fn has_custom_data_root(app: &tauri::AppHandle) -> bool {
    let Ok(default_root) = app.path().app_data_dir() else {
        return false;
    };
    read_custom_data_dir_from(&default_root).is_some()
}

pub fn resolve_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let default_root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if let Some(custom) = read_custom_data_dir_from(&default_root) {
        if custom.is_dir() || fs::create_dir_all(&custom).is_ok() {
            return Ok(custom);
        }
    }
    Ok(default_root)
}

fn normalize_for_cmp(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| {
        if let (Some(parent), Some(name)) = (p.parent(), p.file_name()) {
            if let Ok(canon_parent) = fs::canonicalize(parent) {
                return canon_parent.join(name);
            }
        }
        p.to_path_buf()
    })
}

fn is_same_or_nested(a: &Path, b: &Path) -> bool {
    let ca = normalize_for_cmp(a);
    let cb = normalize_for_cmp(b);
    ca == cb || ca.starts_with(&cb) || cb.starts_with(&ca)
}

fn collect_stats_in_dir(dir: &Path, bytes: &mut u64, count: &mut u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with("._") || name.ends_with(".tmp") || name.starts_with(".lirio_write_probe_") {
            continue;
        }
        if p.is_dir() {
            collect_stats_in_dir(&p, bytes, count);
        } else if let Ok(meta) = p.metadata() {
            if meta.is_file() {
                *bytes += meta.len();
                *count += 1;
            }
        }
    }
}

fn collect_dir_stats(root: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut count = 0u64;
    for sub in MANAGED_DATA_SUBDIRS {
        let sub_path = root.join(sub);
        if sub_path.is_dir() {
            collect_stats_in_dir(&sub_path, &mut bytes, &mut count);
        }
    }
    (bytes, count)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<u64, String> {
    if !src.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(dst).map_err(|e| format!("无法创建目标目录 {}：{e}", dst.display()))?;
    let mut copied = 0u64;
    let entries = fs::read_dir(src).map_err(|e| format!("读取源目录 {} 失败：{e}", src.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let name = src_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with("._") || name.ends_with(".tmp") || name.starts_with(".lirio_write_probe_") {
            continue;
        }
        let dst_path = dst.join(name);
        if src_path.is_dir() {
            copied += copy_dir_recursive(&src_path, &dst_path)?;
        } else if src_path.is_file() {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("复制文件 {} 失败：{e}", src_path.display()))?;
            copied += 1;
        }
    }
    Ok(copied)
}

fn migrate_managed_subdirs(from_root: &Path, to_root: &Path) -> Result<u64, String> {
    let from_cmp = normalize_for_cmp(from_root);
    let to_cmp = normalize_for_cmp(to_root);
    if from_cmp == to_cmp {
        return Ok(0);
    }
    if is_same_or_nested(from_root, to_root) {
        return Err("目标文件夹不能位于当前数据目录内部或包含当前目录，请选择独立文件夹。".into());
    }
    let mut total = 0u64;
    for sub in MANAGED_DATA_SUBDIRS {
        let src_sub = from_root.join(sub);
        if src_sub.is_dir() {
            let dst_sub = to_root.join(sub);
            total += copy_dir_recursive(&src_sub, &dst_sub)?;
        }
    }
    Ok(total)
}

fn verify_dir_writable(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("无法创建目标文件夹：{e}"))?;
    let probe = dir.join(format!(".lirio_write_probe_{}", uuid::Uuid::new_v4()));
    fs::write(&probe, b"ok").map_err(|e| format!("所选目录不可写，请更换有写入权限的文件夹：{e}"))?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

fn build_storage_info(app: &tauri::AppHandle, migrated_files: u64) -> Result<StorageInfo, String> {
    let default_root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let active_root = resolve_data_root(app)?;
    let is_custom = normalize_for_cmp(&active_root) != normalize_for_cmp(&default_root)
        && read_custom_data_dir_from(&default_root).is_some();
    let exists = active_root.is_dir();
    let (total_bytes, file_count) = if exists {
        collect_dir_stats(&active_root)
    } else {
        (0, 0)
    };
    Ok(StorageInfo {
        active_dir: active_root.to_string_lossy().to_string(),
        default_dir: default_root.to_string_lossy().to_string(),
        is_custom,
        exists,
        total_bytes,
        file_count,
        migrated_files,
    })
}

#[tauri::command]
pub async fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    resolve_data_root(&app).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_storage_info(app: tauri::AppHandle) -> Result<StorageInfo, String> {
    build_storage_info(&app, 0)
}

#[tauri::command]
pub fn set_storage_dir(
    app: tauri::AppHandle,
    new_dir: String,
    migrate: bool,
) -> Result<StorageInfo, String> {
    let trimmed = new_dir.trim();
    if trimmed.is_empty() {
        return Err("请选择有效的文件夹路径。".into());
    }
    let target = PathBuf::from(trimmed);
    if !target.is_absolute() {
        return Err("请选择绝对路径文件夹。".into());
    }
    verify_dir_writable(&target)?;

    let old_active = resolve_data_root(&app)?;
    let default_root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let migrated = if migrate {
        migrate_managed_subdirs(&old_active, &target)?
    } else {
        0
    };

    if normalize_for_cmp(&target) == normalize_for_cmp(&default_root) {
        write_custom_data_dir_to(&default_root, None)?;
    } else {
        write_custom_data_dir_to(&default_root, Some(&target))?;
    }
    build_storage_info(&app, migrated)
}

#[tauri::command]
pub fn reset_storage_dir(app: tauri::AppHandle, migrate: bool) -> Result<StorageInfo, String> {
    let default_root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let old_active = resolve_data_root(&app)?;
    verify_dir_writable(&default_root)?;
    let migrated = if migrate {
        migrate_managed_subdirs(&old_active, &default_root)?
    } else {
        0
    };
    write_custom_data_dir_to(&default_root, None)?;
    build_storage_info(&app, migrated)
}

#[tauri::command]
pub fn open_storage_dir(app: tauri::AppHandle) -> Result<(), String> {
    let active = resolve_data_root(&app)?;
    fs::create_dir_all(&active).map_err(|e| format!("无法打开目录：{e}"))?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&active)
            .spawn()
            .map_err(|e| format!("无法在访达中打开：{e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&active)
            .spawn()
            .map_err(|e| format!("无法在资源管理器中打开：{e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android"), not(target_os = "ios")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&active)
            .spawn()
            .map_err(|e| format!("无法打开文件夹：{e}"))?;
        return Ok(());
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        Err("移动端暂不支持直接打开系统文件管理器".into())
    }
}

/// Inspect metadata before reading, so a cloud placeholder cannot silently block import.
#[tauri::command]
pub fn inspect_audio_file(path: String) -> Result<u64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("无法访问音频文件：{e}"))?;
    if !meta.is_file() {
        return Err("请选择音频文件，而不是文件夹。".into());
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        if meta.st_flags() & 0x40000000 != 0 {
            return Err("此音频是云端占位文件，内容尚未下载到这台 Mac。请先下载到本机，再打开本地副本。".into());
        }
    }
    if meta.len() == 0 {
        return Err("此文件为空，无法作为音频打开。".into());
    }
    Ok(meta.len())
}

const ALLOWED_AUDIO_EXTS: [&str; 9] = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "aif", "aiff", "mp4"];

/// Read raw audio bytes for local or drag-dropped paths outside plugin-fs home scopes.
#[tauri::command]
pub fn read_audio_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if !ALLOWED_AUDIO_EXTS.contains(&ext.as_str()) {
        return Err("仅支持读取常见音频文件（MP3 / M4A / WAV / MP4 / FLAC / OGG）。".into());
    }
    inspect_audio_file(path.clone())?;
    let bytes = std::fs::read(&path).map_err(|e| format!("读取音频文件失败：{e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_write_custom_data_dir_roundtrip() {
        let base = std::env::temp_dir().join(format!("lirio-cfg-{}", uuid::Uuid::new_v4()));
        assert_eq!(read_custom_data_dir_from(&base), None);
        let target = base.join("custom_store");
        write_custom_data_dir_to(&base, Some(&target)).unwrap();
        assert_eq!(read_custom_data_dir_from(&base), Some(target));
        write_custom_data_dir_to(&base, None).unwrap();
        assert_eq!(read_custom_data_dir_from(&base), None);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn migrate_managed_subdirs_copies_all_managed_folders_and_stats() {
        let base = std::env::temp_dir().join(format!("lirio-mig-{}", uuid::Uuid::new_v4()));
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("lirio_state")).unwrap();
        fs::create_dir_all(src.join("library")).unwrap();
        fs::create_dir_all(src.join("submissions")).unwrap();
        fs::write(src.join("lirio_state/speak_state_v2.json"), b"{\"ok\":true}").unwrap();
        fs::write(src.join("lirio_state/._appledouble"), b"ignored").unwrap();
        fs::write(src.join("library/sample.meta.json"), b"{\"id\":\"1\"}").unwrap();
        fs::write(src.join("submissions/rec.json"), b"{\"id\":\"r1\"}").unwrap();

        let copied = migrate_managed_subdirs(&src, &dst).unwrap();
        assert_eq!(copied, 3);
        assert!(dst.join("lirio_state/speak_state_v2.json").is_file());
        assert!(!dst.join("lirio_state/._appledouble").exists());
        assert!(dst.join("library/sample.meta.json").is_file());
        assert!(dst.join("submissions/rec.json").is_file());

        let (bytes, files) = collect_dir_stats(&dst);
        assert_eq!(files, 3);
        assert!(bytes >= 31);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn migrate_rejects_nested_destination() {
        let base = std::env::temp_dir().join(format!("lirio-nest-{}", uuid::Uuid::new_v4()));
        let src = base.join("root");
        let nested = src.join("sub");
        fs::create_dir_all(&src).unwrap();
        assert!(migrate_managed_subdirs(&src, &nested).is_err());
        let _ = fs::remove_dir_all(&base);
    }
}
