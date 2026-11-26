use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

use super::corpus::CorpusAudioResult;

struct EdgeWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

static EDGE_WORKER: OnceLock<Mutex<Option<EdgeWorker>>> = OnceLock::new();

const EDGE_WORKER_PY: &str = r#"
import sys, json, asyncio, edge_tts

async def synth(text, voice, out_path):
    comm = edge_tts.Communicate(text, voice)
    await comm.save(out_path)

async def main():
    loop = asyncio.get_event_loop()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            await synth(req["text"], req["voice"], req["out"])
            print("OK", flush=True)
        except Exception as e:
            print("ERR:" + str(e).replace("\n", " "), flush=True)

asyncio.run(main())
"#;

fn spawn_edge_worker() -> Option<EdgeWorker> {
    let mut child = ["python3", "python"]
        .into_iter()
        .find_map(|py| {
            Command::new(py)
                .args(["-u", "-c", EDGE_WORKER_PY])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .ok()
        })?;
    let stdin = child.stdin.take()?;
    let stdout = BufReader::new(child.stdout.take()?);
    Some(EdgeWorker { child, stdin, stdout })
}

fn synth_via_persistent_edge_worker(text: &str, voice: &str, out_path: &std::path::Path) -> Result<Vec<u8>, String> {
    let lock = EDGE_WORKER.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().map_err(|_| "TTS 锁异常".to_string())?;

    for _attempt in 0..2 {
        if guard.is_none() {
            *guard = spawn_edge_worker();
        }
        let Some(worker) = guard.as_mut() else {
            return Err("无法启动神经语音进程".into());
        };
        let payload = serde_json::json!({
            "text": text,
            "voice": voice,
            "out": out_path.to_string_lossy(),
        })
        .to_string();

        if writeln!(worker.stdin, "{payload}").is_err() || worker.stdin.flush().is_err() {
            let _ = worker.child.kill();
            *guard = None;
            continue;
        }

        let mut resp = String::new();
        match worker.stdout.read_line(&mut resp) {
            Ok(n) if n > 0 && resp.trim() == "OK" => {
                if let Ok(bytes) = fs::read(out_path) {
                    let _ = fs::remove_file(out_path);
                    if bytes.len() > 300 {
                        return Ok(bytes);
                    }
                }
                let _ = fs::remove_file(out_path);
                return Err("神经语音输出为空".into());
            }
            _ => {
                let _ = worker.child.kill();
                *guard = None;
                let _ = fs::remove_file(out_path);
            }
        }
    }
    Err("神经语音合成失败".into())
}

#[derive(Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn find_edge_tts() -> Option<String> {
    for cand in [
        "/opt/homebrew/bin/edge-tts",
        "/usr/local/bin/edge-tts",
        "/Users/cherry/Library/Python/3.9/bin/edge-tts",
        "/Users/cherry/Library/Python/3.11/bin/edge-tts",
        "/Users/cherry/Library/Python/3.12/bin/edge-tts",
    ] {
        if std::path::Path::new(cand).is_file() {
            return Some(cand.to_string());
        }
    }
    #[cfg(target_os = "windows")]
    let probe_cmd = "where";
    #[cfg(not(target_os = "windows"))]
    let probe_cmd = "which";
    if let Ok(out) = Command::new(probe_cmd).arg("edge-tts").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn speak_transcribe(
    app: tauri::AppHandle,
    wav_bytes: Vec<u8>,
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<String, String> {
    if wav_bytes.len() < 100 {
        return Err("录音内容为空，请重新说话。".into());
    }
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let use_openai = provider.as_deref() == Some("openai");

    if use_openai {
        let key = api_key.unwrap_or_default().trim().to_string();
        if key.is_empty() {
            return Err("已在全局设置中选择 OpenAI Whisper 识别，请先填写语音 API Key。".into());
        }
        let endpoint = format!(
            "{}/audio/transcriptions",
            base_url
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("https://api.openai.com/v1")
                .trim_end_matches('/')
        );
        return tauri::async_runtime::spawn_blocking(move || {
            fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
            let id = uuid::Uuid::new_v4().to_string();
            let wav_path = cache.join(format!("speak-oa-{id}.wav"));
            fs::write(&wav_path, &wav_bytes).map_err(|e| format!("写入录音失败：{e}"))?;

            let output = Command::new("curl")
                .args(["-sS", "--max-time", "45", "-X", "POST"])
                .arg("-H")
                .arg(format!("Authorization: Bearer {key}"))
                .arg("-F")
                .arg(format!("file=@{}", wav_path.to_string_lossy()))
                .args(["-F", "model=whisper-1", "-F", "language=en"])
                .arg(&endpoint)
                .output();
            let _ = fs::remove_file(&wav_path);

            let out = output.map_err(|e| format!("调用云端语音识别失败：{e}"))?;
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(format!("云端语音识别请求失败：{err}"));
            }
            let raw = String::from_utf8_lossy(&out.stdout).to_string();
            let val: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| format!("云端语音识别解析失败：{e}"))?;
            if let Some(err) = val.get("error") {
                let msg = err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("API 返回错误");
                return Err(format!("Whisper API 错误：{msg}"));
            }
            let cleaned = val["text"].as_str().unwrap_or("").trim().to_string();
            if cleaned.is_empty() {
                return Err("未识别到清晰语音，请靠近麦克风再试一次。".into());
            }
            Ok(cleaned)
        })
        .await
        .map_err(|e| format!("识别任务中断：{e}"))?;
    }

    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources/asr");
    #[cfg(target_os = "windows")]
    const WHISPER_BIN: &str = "whisper-cli.exe";
    #[cfg(not(target_os = "windows"))]
    const WHISPER_BIN: &str = "whisper-cli";
    let cli = resources.join(WHISPER_BIN);
    let model = resources.join("model.bin");
    if !cli.is_file() || !model.is_file() {
        return Err("本地离线语音识别模型缺失。".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let wav_path = cache.join(format!("speak-{id}.wav"));
        let out_base = cache.join(format!("speak-{id}"));
        fs::write(&wav_path, &wav_bytes).map_err(|e| format!("写入录音失败：{e}"))?;

        let threads = std::thread::available_parallelism()
            .map(|n| n.get().clamp(4, 8))
            .unwrap_or(6)
            .to_string();
        let status = Command::new(&cli)
            .args(["-m"])
            .arg(&model)
            .arg("-f")
            .arg(&wav_path)
            .args(["-l", "auto", "-bs", "1", "-bo", "1", "-t", &threads, "-np", "-nt", "-otxt", "-of"])
            .arg(&out_base)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("启动语音识别失败：{e}"))?;

        let txt_path = out_base.with_extension("txt");
        let text = if status.success() && txt_path.exists() {
            fs::read_to_string(&txt_path).unwrap_or_default()
        } else {
            String::new()
        };

        let _ = fs::remove_file(&wav_path);
        let _ = fs::remove_file(&txt_path);

        let cleaned = text
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && !(l.starts_with('[') && l.ends_with(']')))
            .collect::<Vec<_>>()
            .join(" ");

        if cleaned.is_empty() {
            return Err("未识别到清晰语音，请靠近麦克风再试一次。".into());
        }
        Ok(cleaned)
    })
    .await
    .map_err(|e| format!("识别任务中断：{e}"))?
}

#[tauri::command]
pub async fn speak_chat_remote(
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    temperature: Option<f32>,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "temperature": temperature.unwrap_or(0.7),
    })
    .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("curl");
        cmd.args([
            "-sS",
            "--max-time",
            "45",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
        ]);
        if !api_key.trim().is_empty() {
            cmd.arg("-H").arg(format!("Authorization: Bearer {}", api_key.trim()));
        }
        cmd.arg("-d").arg(&body).arg(&url);

        let output = cmd.output().map_err(|e| format!("网络请求启动失败：{e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("请求失败：{err}"));
        }
        let raw = String::from_utf8_lossy(&output.stdout).to_string();
        let val: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("响应解析失败：{e}"))?;
        if let Some(err) = val.get("error") {
            let msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("API 返回错误");
            return Err(format!("API 错误：{msg}"));
        }
        let content = val["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| "API 响应中缺少回复内容".to_string())?;
        Ok(content.trim().to_string())
    })
    .await
    .map_err(|e| format!("对话任务中断：{e}"))?
}

#[tauri::command]
pub async fn speak_chat_local(_app: tauri::AppHandle, _prompt: String) -> Result<String, String> {
    Err("内置本地 Qwen 已移除以精简安装包体积，请使用 Lirio 官方 DeepSeek 按量余额或配置自定义 API Key。".into())
}

#[tauri::command]
pub async fn speak_tts(
    app: tauri::AppHandle,
    text: String,
    accent: String,
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    voice: Option<String>,
) -> Result<CorpusAudioResult, String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("朗读内容不能为空".into());
    }
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let prov = provider.unwrap_or_else(|| "edge".to_string());

    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();

        // 0. Optional Custom / OpenAI-compatible Cloud TTS
        if prov == "openai" || prov == "custom" {
            let key = api_key.unwrap_or_default().trim().to_string();
            if key.is_empty() {
                return Err("已选择自定义语音 API，请先填写语音合成 API Key。".into());
            }
            let endpoint = format!(
                "{}/audio/speech",
                base_url
                    .as_deref()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("https://api.openai.com/v1")
                    .trim_end_matches('/')
            );
            let chosen_model = model
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("tts-1")
                .to_string();
            let chosen_voice = voice
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or(if accent == "uk" { "fable" } else { "alloy" })
                .to_string();
            let mp3_path: PathBuf = cache.join(format!("speak-oa-tts-{id}.mp3"));
            let body = serde_json::json!({
                "model": &chosen_model,
                "input": &trimmed,
                "voice": &chosen_voice,
                "response_format": "mp3",
            })
            .to_string();
            let status = Command::new("curl")
                .args(["-sS", "--max-time", "30", "-X", "POST", "-H", "Content-Type: application/json"])
                .arg("-H")
                .arg(format!("Authorization: Bearer {key}"))
                .arg("-d")
                .arg(&body)
                .arg("-o")
                .arg(&mp3_path)
                .arg(&endpoint)
                .status()
                .map_err(|e| format!("调用 OpenAI TTS 失败：{e}"))?;
            if status.success() && mp3_path.is_file() {
                let bytes = fs::read(&mp3_path).unwrap_or_default();
                let _ = fs::remove_file(&mp3_path);
                if bytes.starts_with(b"{") {
                    if let Ok(err_val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        if let Some(msg) = err_val["error"]["message"].as_str() {
                            return Err(format!("OpenAI TTS 错误：{msg}"));
                        }
                    }
                }
                if bytes.len() > 300 {
                    return Ok(CorpusAudioResult {
                        bytes,
                        mime: "audio/mpeg".into(),
                        source: format!("openai-{chosen_voice}"),
                    });
                }
            }
            let _ = fs::remove_file(&mp3_path);
            return Err("OpenAI TTS 合成失败，请检查 Key 或网络。".into());
        }

        if prov != "macos" {
            // 1. Prefer persistent Python edge-tts worker (zero cold-start latency)
            let default_neural_voice = match accent.as_str() {
                "uk" => "en-GB-SoniaNeural",
                "us" => "en-US-AndrewMultilingualNeural",
                "au" => "en-AU-NatashaNeural",
                "in" => "en-IN-NeerjaNeural",
                _ => "en-GB-SoniaNeural",
            };
            let neural_voice = voice
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty() && s.contains("Neural"))
                .unwrap_or(default_neural_voice);
            let mp3_path: PathBuf = cache.join(format!("speak-tts-{id}.mp3"));
            if let Ok(bytes) = synth_via_persistent_edge_worker(&trimmed, neural_voice, &mp3_path) {
                return Ok(CorpusAudioResult {
                    bytes,
                    mime: "audio/mpeg".into(),
                    source: format!("edge-fast-{neural_voice}"),
                });
            }

            // 1b. CLI fallback if persistent worker unavailable
            if let Some(edge_bin) = find_edge_tts() {
                let ok = Command::new(&edge_bin)
                    .args(["--voice", neural_voice, "--text", &trimmed, "--write-media"])
                    .arg(&mp3_path)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if ok && mp3_path.exists() {
                    if let Ok(bytes) = fs::read(&mp3_path) {
                        let _ = fs::remove_file(&mp3_path);
                        if bytes.len() > 300 {
                            return Ok(CorpusAudioResult {
                                bytes,
                                mime: "audio/mpeg".into(),
                                source: format!("edge-{neural_voice}"),
                            });
                        }
                    }
                }
                let _ = fs::remove_file(&mp3_path);
            }
        }

        // 2. Offline fallback: macOS native `say` + `afconvert`, Windows PowerShell SAPI, mobile guidance
        #[cfg(target_os = "macos")]
        {
            let voice = match accent.as_str() {
                "uk" => "Daniel",
                "us" => "Samantha",
                "au" => "Karen",
                "in" => "Rishi",
                _ => "Daniel",
            };
            let aiff = cache.join(format!("speak-tts-{id}.aiff"));
            let wav = cache.join(format!("speak-tts-{id}.wav"));
            let s1 = Command::new("say")
                .args(["-v", voice, "-o"])
                .arg(&aiff)
                .arg("--")
                .arg(&trimmed)
                .status()
                .map_err(|e| format!("语音合成失败：{e}"))?;
            if !s1.success() {
                let _ = fs::remove_file(&aiff);
                return Err("系统语音合成失败".into());
            }
            let s2 = Command::new("afconvert")
                .args(["-f", "WAVE", "-d", "LEI16@22050"])
                .arg(&aiff)
                .arg(&wav)
                .status()
                .map_err(|e| format!("音频格式转换失败：{e}"))?;
            let _ = fs::remove_file(&aiff);
            if !s2.success() {
                let _ = fs::remove_file(&wav);
                return Err("音频转换失败".into());
            }
            let bytes = fs::read(&wav).map_err(|e| e.to_string())?;
            let _ = fs::remove_file(&wav);
            return Ok(CorpusAudioResult {
                bytes,
                mime: "audio/wav".into(),
                source: format!("macos-{voice}"),
            });
        }
        #[cfg(target_os = "windows")]
        {
            let wav = cache.join(format!("speak-tts-{id}.wav"));
            let culture = match accent.as_str() {
                "us" => "en-US",
                "au" => "en-AU",
                "in" => "en-IN",
                _ => "en-GB",
            };
            let ps_script = r#"
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq $env:LIRIO_TTS_CULTURE } | Select-Object -First 1
if (-not $v) { $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'en' } | Select-Object -First 1 }
if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }
$s.SetOutputToWaveFile($env:LIRIO_TTS_OUT)
$s.Speak($env:LIRIO_TTS_TEXT)
$s.Dispose()
"#;
            let status = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
                .env("LIRIO_TTS_CULTURE", culture)
                .env("LIRIO_TTS_OUT", wav.to_string_lossy().as_ref())
                .env("LIRIO_TTS_TEXT", &trimmed)
                .status()
                .map_err(|e| format!("Windows 语音合成失败：{e}"))?;
            if !status.success() {
                let _ = fs::remove_file(&wav);
                return Err("Windows 本地语音合成失败".into());
            }
            let bytes = fs::read(&wav).map_err(|e| e.to_string())?;
            let _ = fs::remove_file(&wav);
            return Ok(CorpusAudioResult {
                bytes,
                mime: "audio/wav".into(),
                source: format!("win-sapi-{accent}"),
            });
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Err("当前移动平台请联网或使用可选云端语音服务。".into())
        }
    })
    .await
    .map_err(|e| format!("朗读任务中断：{e}"))?
}

fn extract_deepseek_key_from_text(text: &str) -> Option<String> {
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let cleaned = line.strip_prefix("export ").unwrap_or(line).trim();
        let rest = if let Some(v) = cleaned.strip_prefix("DEEPSEEK_API_KEY:") {
            Some(v)
        } else if let Some(v) = cleaned.strip_prefix("DEEPSEEK_API_KEY=") {
            Some(v)
        } else {
            None
        };
        if let Some(val) = rest {
            let trimmed = val
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim()
                .to_string();
            if trimmed.starts_with("sk-") && trimmed.len() > 12 {
                return Some(trimmed);
            }
        }
    }
    None
}

#[tauri::command]
pub fn speak_auto_detect_deepseek() -> Result<Option<String>, String> {
    if let Ok(v) = std::env::var("DEEPSEEK_API_KEY") {
        let t = v.trim().to_string();
        if t.starts_with("sk-") && t.len() > 12 {
            return Ok(Some(t));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let candidates = [
            format!("{home}/.dsh/.credentials.yaml"),
            format!("{home}/.config/novel2comic/deepseek.env"),
            format!("{home}/.zshrc"),
        ];
        for p in candidates {
            if let Ok(content) = fs::read_to_string(&p) {
                if let Some(key) = extract_deepseek_key_from_text(&content) {
                    return Ok(Some(key));
                }
            }
        }
    }
    Ok(None)
}

#[derive(Serialize)]
pub struct PodcastDownloadResult {
    pub path: String,
    pub title: String,
}

fn extract_tag_content(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    let mut inner = xml[start..end].trim().to_string();
    if let Some(s) = inner.strip_prefix("<![CDATA[") {
        if let Some(s2) = s.strip_suffix("]]>") {
            inner = s2.trim().to_string();
        }
    }
    Some(inner)
}

fn extract_enclosure_url(item_xml: &str) -> Option<String> {
    let enc_pos = item_xml.find("<enclosure")?;
    let slice = &item_xml[enc_pos..];
    let end_tag = slice.find('>')?;
    let tag_str = &slice[..end_tag];
    let url_pos = tag_str.find("url=")?;
    let after = &tag_str[url_pos + 4..];
    let quote = after.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &after[1..];
    let close = rest.find(quote)?;
    let url = rest[..close].replace("&amp;", "&");
    if url.starts_with("http") {
        Some(url)
    } else {
        None
    }
}

#[tauri::command]
pub async fn podcast_download_latest(
    app: tauri::AppHandle,
    rss_url: String,
    slug: String,
) -> Result<PodcastDownloadResult, String> {
    let target_dir = if crate::commands::project::has_custom_data_root(&app) {
        crate::commands::project::resolve_data_root(&app)?.join("podcasts")
    } else if std::path::Path::new("/Volumes/PortableSSD").is_dir() {
        PathBuf::from("/Volumes/PortableSSD/AbobooMac/podcasts")
    } else {
        crate::commands::project::resolve_data_root(&app)?.join("podcasts")
    };

    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&target_dir).map_err(|e| format!("无法创建播客目录：{e}"))?;

        let rss_out = Command::new("curl")
            .args(["-fsSL", "--max-time", "20", &rss_url])
            .output()
            .map_err(|e| format!("获取播客订阅失败：{e}"))?;
        if !rss_out.status.success() {
            return Err("无法访问该播客 RSS，请检查网络连接。".into());
        }
        let xml = String::from_utf8_lossy(&rss_out.stdout).to_string();
        let item_start = xml.find("<item").ok_or("订阅源中未找到音频节目")?;
        let item_xml = &xml[item_start..];
        let item_end = item_xml.find("</item>").unwrap_or(item_xml.len());
        let first_item = &item_xml[..item_end];

        let title = extract_tag_content(first_item, "title").unwrap_or_else(|| slug.clone());
        let audio_url = extract_enclosure_url(first_item).ok_or("未找到最新一集的音频下载链接")?;

        let safe_slug: String = slug
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let dest = target_dir.join(format!("{safe_slug}-latest.mp3"));

        let dl = Command::new("curl")
            .args(["-fsSL", "--max-time", "90", "-o"])
            .arg(&dest)
            .arg(&audio_url)
            .status()
            .map_err(|e| format!("下载播客音频失败：{e}"))?;
        if !dl.success() || !dest.is_file() {
            return Err("播客音频下载失败，请稍后重试。".into());
        }

        Ok(PodcastDownloadResult {
            path: dest.to_string_lossy().to_string(),
            title,
        })
    })
    .await
    .map_err(|e| format!("下载任务中断：{e}"))?
}

#[tauri::command]
pub fn open_mic_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .status()
            .map_err(|e| format!("无法打开系统设置：{e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:privacy-microphone"])
            .status()
            .map_err(|e| format!("无法打开系统设置：{e}"))?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("请在系统「设置 → 应用权限 → 麦克风」中允许 Lirio 访问麦克风。".into())
    }
}
