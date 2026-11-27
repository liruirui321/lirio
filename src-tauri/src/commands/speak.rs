use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Manager;

fn build_http_agent(_timeout_secs: u64) -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(45))
            .max_idle_connections_per_host(6)
            .build()
    })
}

fn configure_hidden_cmd(cmd: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

use super::corpus::CorpusAudioResult;

type PendingEdgeMap = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<(), String>>>>>;

struct ConcurrentEdgeWorker {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: PendingEdgeMap,
    alive: Arc<AtomicBool>,
    next_id: AtomicU64,
}

impl ConcurrentEdgeWorker {
    fn kill_process(&self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
        }
    }
}

static EDGE_WORKER: OnceLock<Mutex<Option<Arc<ConcurrentEdgeWorker>>>> = OnceLock::new();

const EDGE_WORKER_PY: &str = r#"
import sys, json, asyncio, edge_tts

async def handle(req):
    rid = req.get("id")
    try:
        comm = edge_tts.Communicate(req["text"], req["voice"])
        await comm.save(req["out"])
        print(json.dumps({"id": rid, "ok": True}), flush=True)
    except Exception as e:
        print(json.dumps({"id": rid, "ok": False, "err": str(e).replace("\n", " ")}), flush=True)

async def main():
    loop = asyncio.get_running_loop()
    tasks = set()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        t = asyncio.create_task(handle(req))
        tasks.add(t)
        t.add_done_callback(tasks.discard)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

asyncio.run(main())
"#;

fn spawn_edge_worker() -> Option<Arc<ConcurrentEdgeWorker>> {
    let mut child = ["python3", "python"]
        .into_iter()
        .find_map(|py| {
            let mut cmd = Command::new(py);
            configure_hidden_cmd(&mut cmd);
            cmd.args(["-u", "-c", EDGE_WORKER_PY])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .ok()
        })?;
    let stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let pending: PendingEdgeMap = Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(AtomicBool::new(true));

    let pending_reader = Arc::clone(&pending);
    let alive_reader = Arc::clone(&alive);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                        continue;
                    };
                    let Some(id) = val.get("id").and_then(|v| v.as_u64()) else {
                        continue;
                    };
                    let ok = val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                    let res = if ok {
                        Ok(())
                    } else {
                        Err(val
                            .get("err")
                            .and_then(|v| v.as_str())
                            .unwrap_or("神经语音合成失败")
                            .to_string())
                    };
                    if let Ok(mut map) = pending_reader.lock() {
                        if let Some(tx) = map.remove(&id) {
                            let _ = tx.send(res);
                        }
                    }
                }
            }
        }
        alive_reader.store(false, Ordering::SeqCst);
        if let Ok(mut map) = pending_reader.lock() {
            for (_, tx) in map.drain() {
                let _ = tx.send(Err("神经语音进程已退出".into()));
            }
        }
    });

    Some(Arc::new(ConcurrentEdgeWorker {
        stdin: Mutex::new(stdin),
        child: Mutex::new(child),
        pending,
        alive,
        next_id: AtomicU64::new(1),
    }))
}

fn get_or_spawn_edge_worker() -> Option<Arc<ConcurrentEdgeWorker>> {
    let lock = EDGE_WORKER.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().ok()?;
    let stale = guard
        .as_ref()
        .map(|w| !w.alive.load(Ordering::SeqCst))
        .unwrap_or(true);
    if stale {
        *guard = spawn_edge_worker();
    }
    guard.as_ref().map(Arc::clone)
}

fn reset_edge_worker_if_same(target: &Arc<ConcurrentEdgeWorker>) {
    target.kill_process();
    if let Some(lock) = EDGE_WORKER.get() {
        if let Ok(mut guard) = lock.lock() {
            if guard.as_ref().is_some_and(|w| Arc::ptr_eq(w, target)) {
                *guard = None;
            }
        }
    }
}

fn synth_via_persistent_edge_worker(text: &str, voice: &str, out_path: &std::path::Path) -> Result<Vec<u8>, String> {
    let mut last_err = String::from("神经语音合成失败");
    for _attempt in 0..2 {
        let Some(worker) = get_or_spawn_edge_worker() else {
            return Err("无法启动神经语音进程".into());
        };
        let id = worker.next_id.fetch_add(1, Ordering::Relaxed);
        let payload = serde_json::json!({
            "id": id,
            "text": text,
            "voice": voice,
            "out": out_path.to_string_lossy(),
        })
        .to_string();

        let (tx, rx) = mpsc::channel();
        {
            let mut map = worker
                .pending
                .lock()
                .map_err(|_| "TTS 队列锁异常".to_string())?;
            map.insert(id, tx);
        }

        let write_ok = {
            let mut stdin_guard = worker
                .stdin
                .lock()
                .map_err(|_| "TTS 输入锁异常".to_string())?;
            writeln!(stdin_guard, "{payload}").is_ok() && stdin_guard.flush().is_ok()
        };

        if !write_ok {
            if let Ok(mut map) = worker.pending.lock() {
                map.remove(&id);
            }
            reset_edge_worker_if_same(&worker);
            let _ = fs::remove_file(out_path);
            continue;
        }

        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(())) => {
                if let Ok(bytes) = fs::read(out_path) {
                    let _ = fs::remove_file(out_path);
                    if bytes.len() > 300 {
                        return Ok(bytes);
                    }
                }
                let _ = fs::remove_file(out_path);
                return Err("神经语音输出为空".into());
            }
            Ok(Err(e)) => {
                let _ = fs::remove_file(out_path);
                last_err = e;
                if !worker.alive.load(Ordering::SeqCst) {
                    reset_edge_worker_if_same(&worker);
                    continue;
                }
                return Err(last_err);
            }
            Err(_) => {
                if let Ok(mut map) = worker.pending.lock() {
                    map.remove(&id);
                }
                let _ = fs::remove_file(out_path);
                reset_edge_worker_if_same(&worker);
                last_err = "神经语音合成超时".into();
            }
        }
    }
    Err(last_err)
}

#[derive(Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn find_edge_tts() -> Option<String> {
    let mut cands = vec![
        "/opt/homebrew/bin/edge-tts".to_string(),
        "/usr/local/bin/edge-tts".to_string(),
    ];
    if let Ok(home) = std::env::var("HOME") {
        for py_ver in ["3.9", "3.10", "3.11", "3.12", "3.13"] {
            cands.push(format!("{home}/Library/Python/{py_ver}/bin/edge-tts"));
        }
    }
    for cand in cands {
        if std::path::Path::new(&cand).is_file() {
            return Some(cand);
        }
    }
    #[cfg(target_os = "windows")]
    let probe_cmd = "where";
    #[cfg(not(target_os = "windows"))]
    let probe_cmd = "which";
    if let Ok(out) = {
        let mut cmd = Command::new(probe_cmd);
        configure_hidden_cmd(&mut cmd);
        cmd.arg("edge-tts").output()
    } {
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
    wav_bytes: Option<Vec<u8>>,
    wav_base64: Option<String>,
    language: Option<String>,
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<String, String> {
    let wav_bytes = if let Some(b64) = wav_base64 {
        super::net::decode_base64(&b64)?
    } else {
        wav_bytes.unwrap_or_default()
    };
    if wav_bytes.len() < 100 {
        return Err("录音内容为空，请重新说话。".into());
    }
    let whisper_lang = language
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "en".to_string());
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
            let boundary = format!("----LirioBoundary{}", uuid::Uuid::new_v4().simple());
            let mut body = Vec::with_capacity(wav_bytes.len() + 512);
            let _ = write!(
                body,
                "--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-1\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\nen\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
            );
            body.extend_from_slice(&wav_bytes);
            let _ = write!(body, "\r\n--{boundary}--\r\n");

            let raw = match build_http_agent(45)
                .post(&endpoint)
                .set("Authorization", &format!("Bearer {key}"))
                .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
                .send_bytes(&body)
            {
                Ok(resp) => resp
                    .into_string()
                    .map_err(|e| format!("读取语音识别响应失败：{e}"))?,
                Err(ureq::Error::Status(_, resp)) => {
                    resp.into_string().unwrap_or_else(|_| "API 返回错误状态".into())
                }
                Err(e) => return Err(format!("调用云端语音识别失败：{e}")),
            };
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
        let mut asr_cmd = Command::new(&cli);
        configure_hidden_cmd(&mut asr_cmd);
        let status = asr_cmd
            .args(["-m"])
            .arg(&model)
            .arg("-f")
            .arg(&wav_path)
            .args(["-l", &whisper_lang, "-bs", "1", "-bo", "1", "-t", &threads, "-np", "-nt", "-otxt", "-of"])
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
    });

    tauri::async_runtime::spawn_blocking(move || {
        let agent = build_http_agent(45);
        let mut req = agent.post(&url).set("Content-Type", "application/json");
        if !api_key.trim().is_empty() {
            req = req.set("Authorization", &format!("Bearer {}", api_key.trim()));
        }
        let raw = match req.send_json(body) {
            Ok(resp) => resp
                .into_string()
                .map_err(|e| format!("响应读取失败：{e}"))?,
            Err(ureq::Error::Status(_, resp)) => {
                resp.into_string().unwrap_or_else(|_| "API 返回错误状态".into())
            }
            Err(e) => return Err(format!("网络请求失败：{e}")),
        };
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
pub async fn speak_warmup_tts(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || super::kokoro::warmup(&app))
        .await
        .map_err(|e| format!("预热任务中断：{e}"))?
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
    let app_handle = app.clone();
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
            let body = serde_json::json!({
                "model": &chosen_model,
                "input": &trimmed,
                "voice": &chosen_voice,
                "response_format": "mp3",
            });
            let bytes: Vec<u8> = match build_http_agent(30)
                .post(&endpoint)
                .set("Authorization", &format!("Bearer {key}"))
                .set("Content-Type", "application/json")
                .send_json(body)
            {
                Ok(resp) => {
                    let mut buf = Vec::new();
                    resp.into_reader()
                        .take(16 * 1024 * 1024)
                        .read_to_end(&mut buf)
                        .map_err(|e| format!("读取语音数据失败：{e}"))?;
                    buf
                }
                Err(ureq::Error::Status(_, resp)) => {
                    let err_text = resp.into_string().unwrap_or_default();
                    if let Ok(err_val) = serde_json::from_str::<serde_json::Value>(&err_text) {
                        if let Some(msg) = err_val["error"]["message"].as_str() {
                            return Err(format!("OpenAI TTS 错误：{msg}"));
                        }
                    }
                    return Err(format!("OpenAI TTS 请求失败：{err_text}"));
                }
                Err(e) => return Err(format!("调用 OpenAI TTS 失败：{e}")),
            };
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
            return Err("OpenAI TTS 合成失败，请检查 Key 或网络。".into());
        }

        if prov != "macos" {
            // 0b. Prefer bundled pure-Rust Kokoro-82M neural TTS (zero Python, zero cloud cost)
            if let Ok((bytes, voice_name)) =
                super::kokoro::synthesize(&app_handle, &trimmed, voice.as_deref())
            {
                return Ok(CorpusAudioResult {
                    bytes,
                    mime: "audio/wav".into(),
                    source: format!("kokoro-{voice_name}"),
                });
            }

            // 1. Fallback: persistent Python edge-tts worker (zero cold-start latency)
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
                let mut edge_cmd = Command::new(&edge_bin);
                configure_hidden_cmd(&mut edge_cmd);
                let ok = edge_cmd
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
            let mut ps_cmd = Command::new("powershell");
            configure_hidden_cmd(&mut ps_cmd);
            let status = ps_cmd
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

        let xml = build_http_agent(20)
            .get(&rss_url)
            .call()
            .map_err(|_| "无法访问该播客 RSS，请检查网络连接。".to_string())?
            .into_string()
            .map_err(|e| format!("读取播客订阅内容失败：{e}"))?;
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

        let resp = build_http_agent(90)
            .get(&audio_url)
            .call()
            .map_err(|e| format!("下载播客音频失败：{e}"))?;
        let mut out_file = fs::File::create(&dest).map_err(|e| format!("创建播客文件失败：{e}"))?;
        if let Err(e) = std::io::copy(&mut resp.into_reader().take(200 * 1024 * 1024), &mut out_file) {
            let _ = fs::remove_file(&dest);
            return Err(format!("写入播客音频失败：{e}"));
        }
        if !dest.is_file() {
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
        let mut cmd = Command::new("cmd");
        configure_hidden_cmd(&mut cmd);
        cmd.args(["/C", "start", "", "ms-settings:privacy-microphone"])
            .status()
            .map_err(|e| format!("无法打开系统设置：{e}"))?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("请在系统「设置 → 应用权限 → 麦克风」中允许 Lirio 访问麦克风。".into())
    }
}
