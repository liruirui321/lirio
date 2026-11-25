use std::path::{Path, PathBuf};
use std::process::Command;
use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
pub struct CorpusAudioResult {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub source: String,
}

fn sanitize_key(word: &str) -> String {
    let mut out = String::with_capacity(word.len());
    for ch in word.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if ch == ' ' || ch == '-' || ch == '_' || ch == '\'' {
            out.push('_');
        }
    }
    if out.is_empty() {
        "word".into()
    } else {
        out.chars().take(80).collect()
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn cache_dir(app: &tauri::AppHandle, accent: &str) -> Result<PathBuf, String> {
    let ssd_root = PathBuf::from("/Volumes/PortableSSD/AbobooMac/corpus_audio");
    let base = if Path::new("/Volumes/PortableSSD").is_dir() {
        ssd_root
    } else {
        app.path().app_data_dir().map_err(|e| e.to_string())?.join("corpus_audio")
    };
    let dir = base.join(accent);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建音频缓存目录：{e}"))?;
    Ok(dir)
}

fn fetch_youdao(word: &str, youdao_type: &str, dest: &Path) -> Result<Vec<u8>, String> {
    let url = format!(
        "https://dict.youdao.com/dictvoice?audio={}&type={}",
        urlencode(word),
        youdao_type
    );
    let tmp = dest.with_extension("tmp");
    let status = Command::new("curl")
        .args(["-fsSL", "--max-time", "8", "-o"])
        .arg(&tmp)
        .arg(&url)
        .status()
        .map_err(|e| format!("curl 启动失败：{e}"))?;

    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err("词典发音请求失败".into());
    }

    let bytes = std::fs::read(&tmp).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);

    // Basic sanity check: valid audio should be > 400 bytes and not HTML.
    if bytes.len() < 400 || bytes.starts_with(b"<") || bytes.starts_with(b"{") {
        return Err("词典返回的不是有效音频".into());
    }

    let _ = std::fs::write(dest, &bytes);
    Ok(bytes)
}

fn synth_macos_say(word: &str, voice: &str, dest_wav: &Path) -> Result<Vec<u8>, String> {
    let tmp_aiff = dest_wav.with_extension("aiff");
    let status = Command::new("say")
        .args(["-v", voice, "-o"])
        .arg(&tmp_aiff)
        .arg("--")
        .arg(word)
        .status()
        .map_err(|e| format!("系统语音合成启动失败：{e}"))?;

    if !status.success() {
        let _ = std::fs::remove_file(&tmp_aiff);
        return Err(format!("系统语音合成失败（voice={voice}）"));
    }

    let conv = Command::new("afconvert")
        .args(["-f", "WAVE", "-d", "LEI16@22050"])
        .arg(&tmp_aiff)
        .arg(dest_wav)
        .status()
        .map_err(|e| format!("音频转换失败：{e}"))?;
    let _ = std::fs::remove_file(&tmp_aiff);

    if !conv.success() {
        let _ = std::fs::remove_file(dest_wav);
        return Err("afconvert 转换 WAV 失败".into());
    }

    std::fs::read(dest_wav).map_err(|e| format!("读取合成音频失败：{e}"))
}

#[tauri::command]
pub async fn corpus_fetch_audio(
    app: tauri::AppHandle,
    word: String,
    accent: String,
) -> Result<CorpusAudioResult, String> {
    let trimmed = word.trim().to_string();
    if trimmed.is_empty() {
        return Err("单词不能为空".into());
    }
    let acc = match accent.as_str() {
        "uk" | "us" | "au" | "in" => accent.clone(),
        _ => "uk".to_string(),
    };
    let dir = cache_dir(&app, &acc)?;
    let key = sanitize_key(&trimmed);
    let mp3_path = dir.join(format!("{key}.mp3"));
    let wav_path = dir.join(format!("{key}.wav"));

    if mp3_path.exists() {
        if let Ok(bytes) = std::fs::read(&mp3_path) {
            if bytes.len() > 400 {
                return Ok(CorpusAudioResult {
                    bytes,
                    mime: "audio/mpeg".into(),
                    source: "cache-dict".into(),
                });
            }
        }
    }
    if wav_path.exists() {
        if let Ok(bytes) = std::fs::read(&wav_path) {
            if bytes.len() > 400 {
                return Ok(CorpusAudioResult {
                    bytes,
                    mime: "audio/wav".into(),
                    source: "cache-tts".into(),
                });
            }
        }
    }

    // Run blocking network / subprocess calls on a blocking thread.
    tauri::async_runtime::spawn_blocking(move || {
        if acc == "uk" || acc == "us" {
            let ytype = if acc == "uk" { "1" } else { "2" };
            if let Ok(bytes) = fetch_youdao(&trimmed, ytype, &mp3_path) {
                return Ok(CorpusAudioResult {
                    bytes,
                    mime: "audio/mpeg".into(),
                    source: "youdao".into(),
                });
            }
        }

        let voice = match acc.as_str() {
            "uk" => "Daniel",
            "us" => "Samantha",
            "au" => "Karen",
            "in" => "Rishi",
            _ => "Daniel",
        };
        let bytes = synth_macos_say(&trimmed, voice, &wav_path)?;
        Ok(CorpusAudioResult {
            bytes,
            mime: "audio/wav".into(),
            source: format!("macos-{voice}"),
        })
    })
    .await
    .map_err(|e| format!("音频任务中断：{e}"))?
}
