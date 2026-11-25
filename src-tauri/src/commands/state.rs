use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 64
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("无效的状态键名".into());
    }
    Ok(())
}

fn state_path_in(dir: &Path, key: &str) -> Result<PathBuf, String> {
    validate_key(key)?;
    Ok(dir.join(format!("{key}.json")))
}

fn save_to_dir(dir: &Path, key: &str, value: &str) -> Result<(), String> {
    let target = state_path_in(dir, key)?;
    fs::create_dir_all(dir).map_err(|e| format!("创建状态目录失败：{e}"))?;
    let tmp = dir.join(format!("{key}.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&tmp, value.as_bytes()).map_err(|e| format!("写入状态失败：{e}"))?;
    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("提交状态文件失败：{e}"));
    }
    Ok(())
}

fn load_from_dir(dir: &Path, key: &str) -> Result<Option<String>, String> {
    let target = state_path_in(dir, key)?;
    if !target.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&target).map_err(|e| format!("读取状态失败：{e}"))?;
    Ok(Some(content))
}

#[tauri::command]
pub fn app_state_load(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("lirio_state");
    load_from_dir(&dir, &key)
}

#[tauri::command]
pub fn app_state_save(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("lirio_state");
    save_to_dir(&dir, &key, &value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_loads_valid_state_key() {
        let dir = std::env::temp_dir().join(format!("lirio-state-test-{}", uuid::Uuid::new_v4()));
        assert_eq!(load_from_dir(&dir, "corpus_state_v1").unwrap(), None);
        save_to_dir(&dir, "corpus_state_v1", "{\"ok\":true}").unwrap();
        assert_eq!(
            load_from_dir(&dir, "corpus_state_v1").unwrap(),
            Some("{\"ok\":true}".to_string())
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_invalid_state_key() {
        let dir = std::env::temp_dir().join(format!("lirio-state-invalid-{}", uuid::Uuid::new_v4()));
        assert!(save_to_dir(&dir, "../evil", "{}").is_err());
        assert!(load_from_dir(&dir, "foo/bar").is_err());
        assert!(load_from_dir(&dir, "").is_err());
    }
}
