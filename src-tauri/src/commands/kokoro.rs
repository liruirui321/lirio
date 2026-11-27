pub fn resolve_kokoro_voice(requested_voice: Option<&str>) -> (&'static str, &'static str) {
    let lower = requested_voice.unwrap_or("").trim().to_ascii_lowercase();
    if lower.contains("am_michael") || lower.contains("andrew") || lower == "echo" {
        return ("am_michael", "en-us");
    }
    if lower.contains("bm_george") || lower.contains("ryan") || lower == "fable" {
        return ("bm_george", "en-gb");
    }
    ("af_heart", "en-us")
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
mod native {
    use super::resolve_kokoro_voice;
    use misaki_rs::{Language, G2P};
    use ort::session::{builder::GraphOptimizationLevel, Session};
    use ort::value::Tensor;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};
    use tauri::Manager;
    #[cfg(any(target_os = "android", target_os = "ios"))]
    use tauri_plugin_fs::FsExt;

    const EXPECTED_VOICE_BYTES: usize = 510 * 256 * 4;
    const MAX_PHONEME_WINDOW: usize = 500;
    const SAMPLE_RATE: u32 = 24_000;

    pub(crate) struct KokoroEngine {
        session: Session,
        g2p_us: G2P,
        g2p_gb: G2P,
        voices: HashMap<&'static str, Vec<f32>>,
        warmed: bool,
    }

    static ENGINE: OnceLock<Mutex<Option<KokoroEngine>>> = OnceLock::new();

    pub(crate) fn phoneme_to_token(ch: char) -> Option<i64> {
        let id = match ch {
            ';' => 1,
            ':' => 2,
            ',' => 3,
            '.' => 4,
            '!' => 5,
            '?' => 6,
            '—' => 9,
            '…' => 10,
            '"' => 11,
            '(' => 12,
            ')' => 13,
            '“' => 14,
            '”' => 15,
            ' ' => 16,
            '\u{0303}' => 17,
            'ʣ' => 18,
            'ʥ' => 19,
            'ʦ' => 20,
            'ʨ' => 21,
            'ᵝ' => 22,
            '\u{AB67}' => 23,
            'A' => 24,
            'I' => 25,
            'O' => 31,
            'Q' => 33,
            'S' => 35,
            'T' => 36,
            'W' => 39,
            'Y' => 41,
            'ᵊ' => 42,
            'a' => 43,
            'b' => 44,
            'c' => 45,
            'd' => 46,
            'e' => 47,
            'f' => 48,
            'h' => 50,
            'i' => 51,
            'j' => 52,
            'k' => 53,
            'l' => 54,
            'm' => 55,
            'n' => 56,
            'o' => 57,
            'p' => 58,
            'q' => 59,
            'r' => 60,
            's' => 61,
            't' => 62,
            'u' => 63,
            'v' => 64,
            'w' => 65,
            'x' => 66,
            'y' => 67,
            'z' => 68,
            'ɑ' => 69,
            'ɐ' => 70,
            'ɒ' => 71,
            'æ' => 72,
            'β' => 75,
            'ɔ' => 76,
            'ɕ' => 77,
            'ç' => 78,
            'ɖ' => 80,
            'ð' => 81,
            'ʤ' => 82,
            'ə' => 83,
            'ɚ' => 85,
            'ɛ' => 86,
            'ɜ' => 87,
            'ɟ' => 90,
            'ɡ' => 92,
            'ɥ' => 99,
            'ɨ' => 101,
            'ɪ' => 102,
            'ʝ' => 103,
            'ɯ' => 110,
            'ɰ' => 111,
            'ŋ' => 112,
            'ɳ' => 113,
            'ɲ' => 114,
            'ɴ' => 115,
            'ø' => 116,
            'ɸ' => 118,
            'θ' => 119,
            'œ' => 120,
            'ɹ' => 123,
            'ɾ' => 125,
            'ɻ' => 126,
            'ʁ' => 128,
            'ɽ' => 129,
            'ʂ' => 130,
            'ʃ' => 131,
            'ʈ' => 132,
            'ʧ' => 133,
            'ʊ' => 135,
            'ʋ' => 136,
            'ʌ' => 138,
            'ɣ' => 139,
            'ɤ' => 140,
            'χ' => 142,
            'ʎ' => 143,
            'ʒ' => 147,
            'ʔ' => 148,
            'ˈ' => 156,
            'ˌ' => 157,
            'ː' => 158,
            'ʰ' => 162,
            'ʲ' => 164,
            '↓' => 169,
            '→' => 171,
            '↗' => 172,
            '↘' => 173,
            'ᵻ' => 177,
            _ => return None,
        };
        Some(id)
    }

    pub(crate) fn parse_voice_f32(raw: &[u8], name: &str) -> Result<Vec<f32>, String> {
        if raw.len() != EXPECTED_VOICE_BYTES {
            return Err(format!(
                "Kokoro 音色文件 {name} 大小异常：{} != {}",
                raw.len(),
                EXPECTED_VOICE_BYTES
            ));
        }
        let mut out = Vec::with_capacity(raw.len() / 4);
        for chunk in raw.chunks_exact(4) {
            out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        Ok(out)
    }

    pub(crate) fn split_phoneme_tokens(phonemes: &str, max_len: usize) -> Vec<Vec<i64>> {
        let tokens: Vec<i64> = phonemes.chars().filter_map(phoneme_to_token).collect();
        if tokens.is_empty() {
            return Vec::new();
        }
        if tokens.len() <= max_len {
            return vec![tokens];
        }
        let mut windows = Vec::new();
        let mut start = 0;
        while start < tokens.len() {
            let max_end = (start + max_len).min(tokens.len());
            if max_end == tokens.len() {
                windows.push(tokens[start..max_end].to_vec());
                break;
            }
            let min_split = start + max_len / 2;
            let mut split_at = None;
            for i in (min_split..max_end).rev() {
                if matches!(tokens[i], 4 | 5 | 6 | 1 | 2 | 3) {
                    split_at = Some(i + 1);
                    break;
                }
            }
            if split_at.is_none() {
                for i in (min_split..max_end).rev() {
                    if tokens[i] == 16 {
                        split_at = Some(i + 1);
                        break;
                    }
                }
            }
            let end = split_at.unwrap_or(max_end);
            windows.push(tokens[start..end].to_vec());
            start = end;
        }
        windows
    }

    pub(crate) fn encode_wav_pcm16_24k(samples: &[f32]) -> Vec<u8> {
        let data_bytes = (samples.len() * 2) as u32;
        let riff_size = 36u32.saturating_add(data_bytes);
        let byte_rate = SAMPLE_RATE * 2;
        let mut out = Vec::with_capacity(44 + data_bytes as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&riff_size.to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&1u16.to_le_bytes()); // mono
        out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes()); // block align
        out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_bytes.to_le_bytes());
        for &s in samples {
            let clamped = s.clamp(-1.0, 1.0);
            let q = if clamped < 0.0 {
                (clamped * 32768.0) as i16
            } else {
                (clamped * 32767.0) as i16
            };
            out.extend_from_slice(&q.to_le_bytes());
        }
        out
    }

    fn ort_env() -> Result<&'static ort::environment::Environment, String> {
        static ENV: OnceLock<Result<ort::environment::Environment, String>> = OnceLock::new();
        match ENV.get_or_init(|| {
            ort::init()
                .with_name("lirio-kokoro")
                .build()
                .map_err(|e| format!("初始化 ONNX Runtime 环境失败：{e}"))
        }) {
            Ok(env) => Ok(env),
            Err(e) => Err(e.clone()),
        }
    }

    fn build_session_from_file(model_path: &Path) -> Result<Session, String> {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().clamp(2, 6))
            .unwrap_or(4);
        Session::builder(ort_env()?)
            .map_err(|e| format!("创建 Kokoro ONNX 会话失败：{e}"))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("配置 Kokoro ONNX 优化失败：{e}"))?
            .with_intra_threads(threads)
            .map_err(|e| format!("配置 Kokoro ONNX 线程失败：{e}"))?
            .commit_from_file(model_path)
            .map_err(|e| format!("加载 Kokoro ONNX 模型失败：{e}"))
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    fn build_session_from_memory(bytes: &[u8]) -> Result<Session, String> {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().clamp(2, 4))
            .unwrap_or(2);
        Session::builder(ort_env()?)
            .map_err(|e| format!("创建 Kokoro ONNX 会话失败：{e}"))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("配置 Kokoro ONNX 优化失败：{e}"))?
            .with_intra_threads(threads)
            .map_err(|e| format!("配置 Kokoro ONNX 线程失败：{e}"))?
            .commit_from_memory(bytes)
            .map_err(|e| format!("加载内存 Kokoro ONNX 模型失败：{e}"))
    }

    fn load_desktop_tts_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
        if let Ok(res_dir) = app.path().resource_dir() {
            let bundled = res_dir.join("resources").join("tts");
            if bundled.join("kokoro-v1.0.int8.onnx").is_file() {
                return Some(bundled);
            }
        }
        if let Ok(data_dir) = app.path().app_data_dir() {
            let local = data_dir.join("tts");
            if local.join("kokoro-v1.0.int8.onnx").is_file() {
                return Some(local);
            }
        }
        None
    }

    fn init_engine(app: &tauri::AppHandle) -> Result<KokoroEngine, String> {
        let voice_names = ["af_heart", "am_michael", "bm_george"];

        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        let (session, voices) = {
            let tts_dir = load_desktop_tts_dir(app)
                .ok_or_else(|| "未找到内置 Kokoro TTS 模型资源".to_string())?;
            let session = build_session_from_file(&tts_dir.join("kokoro-v1.0.int8.onnx"))?;
            let mut voices = HashMap::new();
            for name in voice_names {
                let raw = std::fs::read(tts_dir.join(format!("{name}.bin")))
                    .map_err(|e| format!("读取 Kokoro 音色 {name} 失败：{e}"))?;
                voices.insert(name, parse_voice_f32(&raw, name)?);
            }
            (session, voices)
        };

        #[cfg(any(target_os = "android", target_os = "ios"))]
        let (session, voices) = {
            let res_dir = app
                .path()
                .resource_dir()
                .map_err(|e| format!("无法获取资源目录：{e}"))?;
            let tts_dir = res_dir.join("resources").join("tts");
            let model_bytes = app
                .fs()
                .read(tts_dir.join("kokoro-v1.0.int8.onnx"))
                .map_err(|e| format!("读取移动端 Kokoro 模型失败：{e}"))?;
            let session = build_session_from_memory(&model_bytes)?;
            let mut voices = HashMap::new();
            for name in voice_names {
                let raw = app
                    .fs()
                    .read(tts_dir.join(format!("{name}.bin")))
                    .map_err(|e| format!("读取移动端 Kokoro 音色 {name} 失败：{e}"))?;
                voices.insert(name, parse_voice_f32(&raw, name)?);
            }
            (session, voices)
        };

        let g2p_us = G2P::new(Language::EnglishUS);
        let g2p_gb = G2P::new(Language::EnglishGB);

        Ok(KokoroEngine {
            session,
            g2p_us,
            g2p_gb,
            voices,
            warmed: false,
        })
    }

    pub(crate) fn infer_engine(
        engine: &mut KokoroEngine,
        text: &str,
        voice_name: &'static str,
        lang: &'static str,
    ) -> Result<Vec<f32>, String> {
        let g2p = if lang == "en-gb" {
            &engine.g2p_gb
        } else {
            &engine.g2p_us
        };
        let (phonemes, _) = g2p
            .g2p(text)
            .map_err(|e| format!("Kokoro 音素转换失败：{e}"))?;
        let windows = split_phoneme_tokens(&phonemes, MAX_PHONEME_WINDOW);
        if windows.is_empty() {
            return Err("无法为当前文本生成有效音素序列".into());
        }
        let voice_vec = engine
            .voices
            .get(voice_name)
            .ok_or_else(|| format!("缺少 Kokoro 音色向量：{voice_name}"))?;

        let mut all_samples: Vec<f32> = Vec::new();
        for window in windows {
            let n_tokens = window.len();
            let row = n_tokens.clamp(1, 510) - 1;
            let style_slice = voice_vec[row * 256..(row + 1) * 256].to_vec();

            let mut padded = Vec::with_capacity(n_tokens + 2);
            padded.push(0i64);
            padded.extend_from_slice(&window);
            padded.push(0i64);

            let tokens_tensor = Tensor::from_array(([1usize, padded.len()], padded))
                .map_err(|e| format!("构建 tokens 张量失败：{e}"))?;
            let style_tensor = Tensor::from_array(([1usize, 256usize], style_slice))
                .map_err(|e| format!("构建 style 张量失败：{e}"))?;
            let speed_tensor = Tensor::from_array(([1usize], vec![1.0f32]))
                .map_err(|e| format!("构建 speed 张量失败：{e}"))?;

            let outputs = engine
                .session
                .run(ort::inputs![
                    "tokens" => tokens_tensor,
                    "style" => style_tensor,
                    "speed" => speed_tensor
                ])
                .map_err(|e| format!("Kokoro ONNX 推理失败：{e}"))?;
            let (_shape, audio_slice) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("提取 Kokoro 音频输出失败：{e}"))?;
            all_samples.extend_from_slice(audio_slice);
        }

        if all_samples.len() < 240 {
            return Err("Kokoro 输出音频过短".into());
        }
        Ok(all_samples)
    }

    pub fn warmup(app: &tauri::AppHandle) -> Result<bool, String> {
        let lock = ENGINE.get_or_init(|| Mutex::new(None));
        let mut guard = lock.lock().map_err(|_| "Kokoro 引擎锁异常".to_string())?;
        if guard.is_none() {
            *guard = Some(init_engine(app)?);
        }
        let Some(engine) = guard.as_mut() else {
            return Ok(false);
        };
        if !engine.warmed {
            let _ = infer_engine(engine, "Hi.", "af_heart", "en-us");
            engine.warmed = true;
        }
        Ok(true)
    }

    pub fn synthesize(
        app: &tauri::AppHandle,
        text: &str,
        requested_voice: Option<&str>,
    ) -> Result<(Vec<u8>, &'static str), String> {
        let (voice_name, lang) = resolve_kokoro_voice(requested_voice);
        let lock = ENGINE.get_or_init(|| Mutex::new(None));
        let mut guard = lock.lock().map_err(|_| "Kokoro 引擎锁异常".to_string())?;
        if guard.is_none() {
            *guard = Some(init_engine(app)?);
        }
        let engine = guard
            .as_mut()
            .ok_or_else(|| "Kokoro 引擎未初始化".to_string())?;
        let samples = infer_engine(engine, text, voice_name, lang)?;
        engine.warmed = true;
        Ok((encode_wav_pcm16_24k(&samples), voice_name))
    }

    #[cfg(test)]
    pub(crate) fn test_init_from_dir(dir: &Path) -> Result<KokoroEngine, String> {
        let session = build_session_from_file(&dir.join("kokoro-v1.0.int8.onnx"))?;
        let mut voices = HashMap::new();
        for name in ["af_heart", "am_michael", "bm_george"] {
            let raw = std::fs::read(dir.join(format!("{name}.bin")))
                .map_err(|e| format!("read {name}: {e}"))?;
            voices.insert(name, parse_voice_f32(&raw, name)?);
        }
        Ok(KokoroEngine {
            session,
            g2p_us: G2P::new(Language::EnglishUS),
            g2p_gb: G2P::new(Language::EnglishGB),
            voices,
            warmed: false,
        })
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
pub fn warmup(app: &tauri::AppHandle) -> Result<bool, String> {
    native::warmup(app)
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
pub fn synthesize(
    app: &tauri::AppHandle,
    text: &str,
    requested_voice: Option<&str>,
) -> Result<(Vec<u8>, &'static str), String> {
    native::synthesize(app, text, requested_voice)
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub fn warmup(_app: &tauri::AppHandle) -> Result<bool, String> {
    Ok(false)
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub fn synthesize(
    _app: &tauri::AppHandle,
    _text: &str,
    _requested_voice: Option<&str>,
) -> Result<(Vec<u8>, &'static str), String> {
    Err("Intel Mac fallback to edge-tts".into())
}

#[cfg(test)]
mod tests {
    use super::resolve_kokoro_voice;

    #[test]
    fn voice_routing_maps_clara_and_examiner_to_af_heart() {
        assert_eq!(
            resolve_kokoro_voice(Some("en-US-AvaMultilingualNeural")),
            ("af_heart", "en-us")
        );
        assert_eq!(
            resolve_kokoro_voice(Some("en-US-AndrewMultilingualNeural")),
            ("am_michael", "en-us")
        );
        assert_eq!(
            resolve_kokoro_voice(Some("en-GB-RyanNeural")),
            ("bm_george", "en-gb")
        );
        assert_eq!(resolve_kokoro_voice(None), ("af_heart", "en-us"));
        assert_eq!(resolve_kokoro_voice(Some("bf_emma")), ("af_heart", "en-us"));
    }

    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    #[test]
    fn native_g2p_wav_and_optional_onnx_bench() {
        use super::native::{
            encode_wav_pcm16_24k, infer_engine, phoneme_to_token, split_phoneme_tokens,
            test_init_from_dir,
        };
        use misaki_rs::{Language, G2P};
        use std::path::PathBuf;
        use std::time::Instant;

        assert_eq!(phoneme_to_token(' '), Some(16));
        assert_eq!(phoneme_to_token('ə'), Some(83));

        let wav = encode_wav_pcm16_24k(&[0.0, 0.5, -0.5]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(wav.len(), 44 + 6);

        let g2p_us = G2P::new(Language::EnglishUS);
        let (ph_us, _) = g2p_us.g2p("Oh nice! How did you find that spot?").unwrap();
        let wins = split_phoneme_tokens(&ph_us, 500);
        assert!(!wins.is_empty() && !wins[0].is_empty());

        let tts_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("tts");
        if tts_dir.join("kokoro-v1.0.int8.onnx").is_file() {
            let t0 = Instant::now();
            let mut engine = test_init_from_dir(&tts_dir).expect("load bundled kokoro");
            let load_ms = t0.elapsed().as_millis();
            let _ = infer_engine(&mut engine, "Hi.", "af_heart", "en-us").expect("warmup");

            let t1 = Instant::now();
            let samples = infer_engine(
                &mut engine,
                "Oh nice! That actually sounds super relaxing—how did you end up finding that spot?",
                "af_heart",
                "en-us",
            )
            .expect("clara synth");
            let gen_ms = t1.elapsed().as_millis();
            let audio_sec = samples.len() as f32 / 24_000.0;
            println!(
                "[native-kokoro-bench] load_ms={load_ms} gen_ms={gen_ms} audio_sec={audio_sec:.2}"
            );
            assert!(audio_sec > 1.5);
        }
    }
}
