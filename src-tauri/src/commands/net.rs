use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

fn validate_lirio_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    let allowed = lower.starts_with("https://lirio.deltae.tech/")
        || lower == "https://lirio.deltae.tech"
        || lower.starts_with("http://127.0.0.1:")
        || lower.starts_with("http://localhost:");
    if !allowed {
        return Err("仅支持直连 Lirio 官方或本机调试服务。".into());
    }
    Ok(trimmed.to_string())
}

fn configure_hidden_cmd(cmd: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectHttpResponse {
    pub status: u16,
    pub content_type: String,
    pub body_text: Option<String>,
    pub body_bytes: Option<Vec<u8>>,
}

#[tauri::command]
pub async fn lirio_direct_request(
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    body_text: Option<String>,
    body_bytes: Option<Vec<u8>>,
    timeout_secs: Option<u64>,
) -> Result<DirectHttpResponse, String> {
    let clean_url = validate_lirio_url(&url)?;
    let timeout = timeout_secs.unwrap_or(45).clamp(3, 120);
    let method_upper = method.trim().to_ascii_uppercase();
    let hdrs = headers.unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        // Explicit direct builder ignores OS HTTP/HTTPS/SOCKS proxy settings.
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(timeout))
            .build();
        let mut req = agent.request(&method_upper, &clean_url);
        for (k, v) in hdrs {
            req = req.set(&k, &v);
        }

        let outcome = if let Some(bytes) = body_bytes {
            req.send_bytes(&bytes)
        } else if let Some(txt) = body_text {
            req.send_string(&txt)
        } else {
            req.call()
        };

        let (status, resp) = match outcome {
            Ok(r) => (r.status(), r),
            Err(ureq::Error::Status(code, r)) => (code, r),
            Err(e) => return Err(format!("直连请求失败：{e}")),
        };

        let content_type = resp.header("content-type").unwrap_or("").to_string();
        let is_binary = content_type.to_ascii_lowercase().starts_with("audio/")
            || content_type.to_ascii_lowercase().starts_with("application/octet-stream");

        if is_binary {
            let mut buf = Vec::new();
            resp.into_reader()
                .take(16 * 1024 * 1024)
                .read_to_end(&mut buf)
                .map_err(|e| format!("读取直连音频响应失败：{e}"))?;
            Ok(DirectHttpResponse {
                status,
                content_type,
                body_text: None,
                body_bytes: Some(buf),
            })
        } else {
            let mut buf = Vec::new();
            resp.into_reader()
                .take(8 * 1024 * 1024)
                .read_to_end(&mut buf)
                .map_err(|e| format!("读取直连响应失败：{e}"))?;
            let text = String::from_utf8_lossy(&buf).to_string();
            Ok(DirectHttpResponse {
                status,
                content_type,
                body_text: Some(text),
                body_bytes: None,
            })
        }
    })
    .await
    .map_err(|e| format!("网络任务中断：{e}"))?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectStreamEvent {
    stream_id: String,
    delta: Option<String>,
    done: Option<bool>,
    content: Option<String>,
    error: Option<String>,
    status: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectStreamResult {
    pub status: u16,
    pub content: String,
}

#[tauri::command]
pub async fn lirio_direct_chat_stream(
    app: tauri::AppHandle,
    stream_id: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    body_text: String,
) -> Result<DirectStreamResult, String> {
    let clean_url = validate_lirio_url(&url)?;
    let hdrs = headers.unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(12))
            .timeout_read(Duration::from_secs(60))
            .build();
        let mut req = agent.post(&clean_url);
        for (k, v) in hdrs {
            req = req.set(&k, &v);
        }

        let resp = match req.send_string(&body_text) {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) => {
                let err_body = r.into_string().unwrap_or_default();
                let msg = serde_json::from_str::<serde_json::Value>(&err_body)
                    .ok()
                    .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|s| s.to_string()))
                    .unwrap_or_else(|| format!("请求失败 ({code})"));
                let _ = app.emit(
                    "lirio-chat-stream",
                    DirectStreamEvent {
                        stream_id: stream_id.clone(),
                        delta: None,
                        done: Some(true),
                        content: None,
                        error: Some(msg.clone()),
                        status: Some(code),
                    },
                );
                return Err(format!("HTTP_{code}:{msg}"));
            }
            Err(e) => return Err(format!("直连流式失败：{e}")),
        };

        let status = resp.status();
        let ctype = resp.header("content-type").unwrap_or("").to_ascii_lowercase();
        if !ctype.contains("text/event-stream") {
            let txt = resp.into_string().map_err(|e| format!("读取响应失败：{e}"))?;
            let content = serde_json::from_str::<serde_json::Value>(&txt)
                .ok()
                .and_then(|v| v.get("content").and_then(|c| c.as_str()).map(|s| s.to_string()))
                .unwrap_or_default();
            if !content.is_empty() {
                let _ = app.emit(
                    "lirio-chat-stream",
                    DirectStreamEvent {
                        stream_id: stream_id.clone(),
                        delta: Some(content.clone()),
                        done: Some(true),
                        content: Some(content.clone()),
                        error: None,
                        status: Some(status),
                    },
                );
            }
            return Ok(DirectStreamResult { status, content });
        }

        let mut reader = BufReader::new(resp.into_reader());
        let mut line = String::new();
        let mut assembled = String::new();
        let mut final_content = String::new();

        loop {
            line.clear();
            let n = reader.read_line(&mut line).map_err(|e| format!("读取流失败：{e}"))?;
            if n == 0 {
                break;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() || !trimmed.starts_with("data:") {
                continue;
            }
            let raw_json = trimmed[5..].trim();
            if raw_json.is_empty() || raw_json == "[DONE]" {
                continue;
            }
            let Ok(evt) = serde_json::from_str::<serde_json::Value>(raw_json) else {
                continue;
            };
            if let Some(err_str) = evt.get("error").and_then(|v| v.as_str()) {
                let _ = app.emit(
                    "lirio-chat-stream",
                    DirectStreamEvent {
                        stream_id: stream_id.clone(),
                        delta: None,
                        done: Some(true),
                        content: None,
                        error: Some(err_str.to_string()),
                        status: Some(status),
                    },
                );
                return Err(err_str.to_string());
            }
            if let Some(delta) = evt.get("delta").and_then(|v| v.as_str()) {
                if !delta.is_empty() {
                    assembled.push_str(delta);
                    let _ = app.emit(
                        "lirio-chat-stream",
                        DirectStreamEvent {
                            stream_id: stream_id.clone(),
                            delta: Some(delta.to_string()),
                            done: None,
                            content: None,
                            error: None,
                            status: Some(status),
                        },
                    );
                }
            }
            if evt.get("done").and_then(|v| v.as_bool()) == Some(true) {
                if let Some(c) = evt.get("content").and_then(|v| v.as_str()) {
                    final_content = c.to_string();
                }
            }
        }

        let result_content = if final_content.trim().is_empty() {
            assembled.trim().to_string()
        } else {
            final_content.trim().to_string()
        };
        let _ = app.emit(
            "lirio-chat-stream",
            DirectStreamEvent {
                stream_id,
                delta: None,
                done: Some(true),
                content: Some(result_content.clone()),
                error: None,
                status: Some(status),
            },
        );
        Ok(DirectStreamResult {
            status,
            content: result_content,
        })
    })
    .await
    .map_err(|e| format!("流式对话任务中断：{e}"))?
}

fn detect_system_proxy_types() -> String {
    let mut kinds: Vec<&'static str> = Vec::new();
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
        if std::env::var(key).map(|v| !v.trim().is_empty()).unwrap_or(false) {
            if !kinds.contains(&"env") {
                kinds.push("env");
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = Command::new("scutil").arg("--proxy").output() {
            let txt = String::from_utf8_lossy(&out.stdout);
            if txt.contains("HTTPEnable : 1") {
                kinds.push("http");
            }
            if txt.contains("HTTPSEnable : 1") {
                kinds.push("https");
            }
            if txt.contains("SOCKSEnable : 1") {
                kinds.push("socks");
            }
            if txt.contains("ProxyAutoConfigEnable : 1") {
                kinds.push("pac");
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("reg");
        configure_hidden_cmd(&mut cmd);
        if let Ok(out) = cmd
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
                "/v",
                "ProxyEnable",
            ])
            .output()
        {
            let txt = String::from_utf8_lossy(&out.stdout);
            if txt.contains("0x1") {
                kinds.push("win-inet");
            }
        }
    }

    if kinds.is_empty() {
        "none".to_string()
    } else {
        kinds.join("+")
    }
}

fn check_local_edge_tts() -> bool {
    for py in ["python3", "python"] {
        let mut cmd = Command::new(py);
        configure_hidden_cmd(&mut cmd);
        if let Ok(st) = cmd
            .args(["-c", "import edge_tts"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            if st.success() {
                return true;
            }
        }
    }
    false
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentDiagnostics {
    pub os: String,
    pub arch: String,
    pub has_local_whisper: bool,
    pub has_local_edge_tts: bool,
    pub system_proxy: String,
    pub direct_health_ok: bool,
    pub direct_health_status: Option<u16>,
    pub direct_health_ms: u64,
    pub direct_health_error: Option<String>,
}

#[tauri::command]
pub async fn diagnose_environment(
    app: tauri::AppHandle,
    server_url: String,
) -> Result<EnvironmentDiagnostics, String> {
    let clean_base = server_url.trim().trim_end_matches('/').to_string();
    let health_url = format!("{clean_base}/api/health");
    let valid_url = validate_lirio_url(&health_url).ok();

    let has_local_whisper = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| {
            let asr = dir.join("resources/asr");
            #[cfg(target_os = "windows")]
            let bin = "whisper-cli.exe";
            #[cfg(not(target_os = "windows"))]
            let bin = "whisper-cli";
            asr.join(bin).is_file() && asr.join("model.bin").is_file()
        })
        .unwrap_or(false);

    tauri::async_runtime::spawn_blocking(move || {
        let system_proxy = detect_system_proxy_types();
        let has_local_edge_tts = check_local_edge_tts();

        let (direct_health_ok, direct_health_status, direct_health_ms, direct_health_error) =
            if let Some(target_url) = valid_url {
                let t0 = Instant::now();
                let agent = ureq::AgentBuilder::new()
                    .timeout(Duration::from_secs(6))
                    .build();
                match agent.get(&target_url).call() {
                    Ok(r) => (
                        r.status() < 400,
                        Some(r.status()),
                        t0.elapsed().as_millis() as u64,
                        None,
                    ),
                    Err(ureq::Error::Status(code, _)) => (
                        false,
                        Some(code),
                        t0.elapsed().as_millis() as u64,
                        Some(format!("HTTP {code}")),
                    ),
                    Err(e) => (
                        false,
                        None,
                        t0.elapsed().as_millis() as u64,
                        Some(e.to_string()),
                    ),
                }
            } else {
                (false, None, 0, Some("non-official-url".into()))
            };

        Ok(EnvironmentDiagnostics {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            has_local_whisper,
            has_local_edge_tts,
            system_proxy,
            direct_health_ok,
            direct_health_status,
            direct_health_ms,
            direct_health_error,
        })
    })
    .await
    .map_err(|e| format!("诊断任务中断：{e}"))?
}
