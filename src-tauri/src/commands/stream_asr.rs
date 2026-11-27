use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

struct MoonshineWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

static MOONSHINE_WORKER: OnceLock<Mutex<Option<MoonshineWorker>>> = OnceLock::new();

const MOONSHINE_WORKER_PY: &str = r#"
import sys, json, base64, struct
import moonshine_voice as mv

model_path, model_arch = mv.get_model_for_language("en", mv.ModelArch.SMALL_STREAMING)
transcriber = mv.Transcriber(model_path=model_path, model_arch=model_arch)

active_stream = None
active_sid = None
lines_map = {}

def attach_listener(st):
    lines_map.clear()
    def on_evt(ev):
        line = getattr(ev, "line", None)
        if line is None:
            return
        lid = getattr(line, "line_id", None)
        txt = (getattr(line, "text", "") or "").strip()
        if lid is not None:
            lines_map[lid] = txt
    st.add_listener(on_evt)

def current_text():
    return " ".join(v for v in lines_map.values() if v).strip()

def close_active():
    global active_stream, active_sid
    if active_stream is not None:
        try:
            active_stream.close()
        except Exception:
            pass
    active_stream = None
    active_sid = None
    lines_map.clear()

for raw_line in sys.stdin:
    raw_line = raw_line.strip()
    if not raw_line:
        continue
    try:
        req = json.loads(raw_line)
        cmd = req.get("cmd")
        sid = req.get("sid")
        if cmd == "warmup":
            print(json.dumps({"ok": True}), flush=True)
        elif cmd == "start":
            close_active()
            active_stream = transcriber.create_stream(update_interval=0.2)
            active_sid = sid
            attach_listener(active_stream)
            active_stream.start()
            print(json.dumps({"ok": True}), flush=True)
        elif cmd == "push":
            if active_stream is None or active_sid != sid:
                print(json.dumps({"ok": True, "text": ""}), flush=True)
                continue
            raw_pcm = base64.b64decode(req.get("pcm_b64", ""))
            n = len(raw_pcm) // 2
            if n > 0:
                ints = struct.unpack(f"<{n}h", raw_pcm[: n * 2])
                samples = [v / 32768.0 for v in ints]
                active_stream.add_audio(samples, 16000)
            print(json.dumps({"ok": True, "text": current_text()}), flush=True)
        elif cmd == "finish":
            if active_stream is None or active_sid != sid:
                print(json.dumps({"ok": True, "text": ""}), flush=True)
                continue
            tr = active_stream.stop()
            txt = ""
            if tr is not None and getattr(tr, "lines", None):
                txt = " ".join((l.text or "").strip() for l in tr.lines if (l.text or "").strip()).strip()
            if not txt:
                txt = current_text()
            close_active()
            print(json.dumps({"ok": True, "text": txt}), flush=True)
        else:
            print(json.dumps({"ok": False, "err": "unknown cmd"}), flush=True)
    except Exception as e:
        print(json.dumps({"ok": False, "err": str(e)}), flush=True)
"#;

fn configure_hidden_cmd(cmd: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

fn resolve_moonshine_python(app: &tauri::AppHandle) -> Option<PathBuf> {
    let base = app.path().app_data_dir().ok()?.join("moonshine");
    #[cfg(target_os = "windows")]
    let py = base.join("venv").join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let py = base.join("venv").join("bin").join("python");
    if py.is_file() {
        Some(py)
    } else {
        None
    }
}

fn spawn_moonshine_worker(py_bin: &std::path::Path) -> Option<MoonshineWorker> {
    let mut cmd = Command::new(py_bin);
    configure_hidden_cmd(&mut cmd);
    let mut child = cmd
        .args(["-u", "-c", MOONSHINE_WORKER_PY])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdin = child.stdin.take()?;
    let stdout = BufReader::new(child.stdout.take()?);
    Some(MoonshineWorker {
        child,
        stdin,
        stdout,
    })
}

fn send_moonshine_cmd(
    py_bin: &std::path::Path,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let lock = MOONSHINE_WORKER.get_or_init(|| Mutex::new(None));
    let mut guard = lock
        .lock()
        .map_err(|_| "Moonshine 流式识别锁异常".to_string())?;
    let serialized = payload.to_string();

    for _attempt in 0..2 {
        if guard.is_none() {
            *guard = spawn_moonshine_worker(py_bin);
        }
        let Some(worker) = guard.as_mut() else {
            return Err("无法启动 Moonshine 流式识别进程".into());
        };
        if writeln!(worker.stdin, "{serialized}").is_err() || worker.stdin.flush().is_err() {
            let _ = worker.child.kill();
            *guard = None;
            continue;
        }
        let mut line = String::new();
        match worker.stdout.read_line(&mut line) {
            Ok(n) if n > 0 => {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                    if val.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                        return Ok(val);
                    }
                    let err = val
                        .get("err")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Moonshine 执行失败");
                    return Err(err.to_string());
                }
            }
            _ => {
                let _ = worker.child.kill();
                *guard = None;
            }
        }
    }
    Err("Moonshine 流式识别无响应".into())
}

#[tauri::command]
pub async fn speak_stream_asr_warmup(app: tauri::AppHandle) -> Result<bool, String> {
    let Some(py_bin) = resolve_moonshine_python(&app) else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        send_moonshine_cmd(&py_bin, &serde_json::json!({ "cmd": "warmup" })).map(|_| true)
    })
    .await
    .map_err(|e| format!("流式识别预热中断：{e}"))?
}

#[tauri::command]
pub async fn speak_stream_asr_start(app: tauri::AppHandle, sid: String) -> Result<bool, String> {
    let Some(py_bin) = resolve_moonshine_python(&app) else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        send_moonshine_cmd(&py_bin, &serde_json::json!({ "cmd": "start", "sid": sid })).map(|_| true)
    })
    .await
    .map_err(|e| format!("启动流式识别中断：{e}"))?
}

#[tauri::command]
pub async fn speak_stream_asr_push(
    app: tauri::AppHandle,
    sid: String,
    pcm_base64: String,
) -> Result<String, String> {
    let Some(py_bin) = resolve_moonshine_python(&app) else {
        return Ok(String::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let res = send_moonshine_cmd(
            &py_bin,
            &serde_json::json!({ "cmd": "push", "sid": sid, "pcm_b64": pcm_base64 }),
        )?;
        Ok(res
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    })
    .await
    .map_err(|e| format!("推送流式音频中断：{e}"))?
}

#[tauri::command]
pub async fn speak_stream_asr_finish(app: tauri::AppHandle, sid: String) -> Result<String, String> {
    let Some(py_bin) = resolve_moonshine_python(&app) else {
        return Ok(String::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let res = send_moonshine_cmd(
            &py_bin,
            &serde_json::json!({ "cmd": "finish", "sid": sid }),
        )?;
        Ok(res
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    })
    .await
    .map_err(|e| format!("结束流式识别中断：{e}"))?
}
