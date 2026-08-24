//! TTS Tauri 命令桥接（前端 IPC）
//!
//! 从 lib.rs 抽出：`rust_load_tts_model` / `rust_synthesize` /
//! `rust_set_tts_language` / `rust_list_tts_voices`。
//! 引擎实例经 `State<AppState>` 注入（见 app_state.rs），不再用静态全局变量。

use std::collections::{HashMap, HashSet};

use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;
use crate::tts::traits::TtsEngine;

/// 加载 TTS 模型
/// 支持传入模型名称（如 "Kokoro-82M"）或完整文件路径
/// 优先在 modelRoot 下查找，失败后自动回退到 workspace/models（开发期镜像）
#[tauri::command]
pub fn rust_load_tts_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model_path: String,
    device: String,
) -> Result<serde_json::Value, String> {
    let name = model_path.clone();
    // 判断是模型名还是文件路径
    let actual_path = if std::path::Path::new(&model_path).exists() {
        std::path::PathBuf::from(&model_path)
    } else {
        let primary = crate::model_manager::model_dir(&model_path);
        let found = crate::model_manager::find_main_model_file(
            &primary,
            &crate::model_manager::ModelFormat::Onnx,
        )
        .or_else(|| {
            // 开发期回退：workspace/models 下的镜像
            let fallback = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../models/Kokoro-82M/onnx");
            crate::model_manager::find_main_model_file(
                &fallback,
                &crate::model_manager::ModelFormat::Onnx,
            )
        });
        match found {
            Some(f) => f,
            None => return Err(format!("model file not found for: {model_path}")),
        }
    };

    let result: Result<serde_json::Value, String> = {
        let mut guard = state.tts.lock();
        guard.load(&actual_path, &device).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "status": "loaded",
            "model": guard.name(),
            "device": device,
        }))
    };

    match &result {
        Ok(_) => {
            let _ = app.emit(
                "sidecar://event",
                serde_json::json!({"status": "model_ready", "model": name, "device": device}),
            );
        }
        Err(e) => {
            let _ = app.emit(
                "sidecar://event",
                serde_json::json!({"status": "model_error", "model": name, "msg": e.to_string()}),
            );
        }
    }
    result
}

/// TTS 语音合成并保存为 WAV 文件
#[tauri::command]
pub fn rust_synthesize(
    state: State<'_, AppState>,
    text: String,
    voice: String,
    rate: f64,
    export_dir: String,
) -> Result<serde_json::Value, String> {
    if text.is_empty() {
        return Err("text is empty".into());
    }

    let samples: Vec<i16> = {
        let mut guard = state.tts.lock();
        if !guard.is_loaded() {
            return Err("TTS model not loaded. Please load a model first.".into());
        }
        guard.infer(&text, &voice, rate).map_err(|e| e.to_string())?
    };
    if samples.is_empty() {
        return Err("合成音频为空".into());
    }

    // 保存为 WAV（24kHz 单声道 i16）
    let out_dir = std::path::Path::new(&export_dir);
    if !out_dir.exists() {
        std::fs::create_dir_all(out_dir).map_err(|e| format!("create dir failed: {e}"))?;
    }

    let ts = chrono::Local::now().format("%H%M%S").to_string();
    let safe_text: String = text
        .chars()
        .take(20)
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c >= '\u{4e00}' && *c <= '\u{9fff}')
        .collect();
    let file_name = if safe_text.trim().is_empty() {
        format!("tts_{}.wav", ts)
    } else {
        format!("{}_{}.wav", safe_text.trim(), ts)
    };
    let out_path = out_dir.join(&file_name);

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 24000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&out_path, spec)
        .map_err(|e| format!("WAV create failed: {e}"))?;
    for &s in &samples {
        writer.write_sample(s).map_err(|e| format!("WAV write failed: {e}"))?;
    }
    writer.finalize().map_err(|e| format!("WAV finalize failed: {e}"))?;

    let file_size = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    let size_str = if file_size > 1024 * 1024 {
        format!("{:.1} MB", file_size as f64 / 1024.0 / 1024.0)
    } else {
        format!("{} KB", file_size / 1024)
    };

    Ok(serde_json::json!({
        "text": text,
        "voice": voice,
        "rate": rate,
        "duration": samples.len() as f64 / 24000.0,
        "saved_path": out_path.to_string_lossy(),
        "size": size_str,
    }))
}

/// 切换 TTS 语言（轻量换 voice embedding + G2P voice，不重载模型）
#[tauri::command]
pub fn rust_set_tts_language(
    state: State<'_, AppState>,
    language: String,
) -> Result<serde_json::Value, String> {
    let lang = language.trim().to_lowercase();
    let lang = match lang.as_str() {
        "zh" | "en" | "ja" => lang,
        _ => "zh".to_string(),
    };
    let mut g = state.tts.lock();
    g.set_language(&lang).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "language": lang }))
}

/// 扫描 voices 目录，按前缀分组为语言 → 音色列表（前端下拉数据源）
#[tauri::command]
pub fn rust_list_tts_voices() -> serde_json::Value {
    let mut all: HashSet<String> = HashSet::new();
    let push_dir = |dir: std::path::PathBuf, out: &mut HashSet<String>| {
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if let Some(n) = e.file_name().to_str() {
                    if n.ends_with(".pt") || n.ends_with(".bin") {
                        if let Some(stem) = n.strip_suffix(".pt").or_else(|| n.strip_suffix(".bin")) {
                            out.insert(stem.to_string());
                        }
                    }
                }
            }
        }
    };
    let mut dirs = vec![];
    dirs.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../models/Kokoro-82M/voices"));
    dirs.push(crate::model_manager::model_dir("Kokoro-82M").join("voices"));
    let classify = |name: &str| -> &'static str {
        if name.starts_with("zf_") || name.starts_with("zm_") {
            "zh"
        } else if name.starts_with("jf_") || name.starts_with("jm_") {
            "ja"
        } else {
            "en"
        }
    };
    let mut seen: HashSet<String> = HashSet::new();
    for d in dirs {
        let mut cur: HashSet<String> = Default::default();
        push_dir(d, &mut cur);
        for v in cur {
            if seen.insert(v.clone()) {
                all.insert(v);
            }
        }
    }
    let mut voices_by_lang: HashMap<String, Vec<String>> = HashMap::new();
    for v in &all {
        let lang = classify(v).to_string();
        voices_by_lang.entry(lang).or_default().push(v.clone());
    }
    for vs in voices_by_lang.values_mut() {
        vs.sort();
    }
    let mut languages: Vec<String> = voices_by_lang.keys().cloned().collect();
    languages.sort();
    if languages.is_empty() {
        // 未扫到任何 voices → 默认提供中英，保证下拉可用
        languages = vec!["zh".to_string(), "en".to_string()];
        voices_by_lang.insert("zh".to_string(), vec![]);
        voices_by_lang.insert("en".to_string(), vec![]);
    }
    let default_lang = if voices_by_lang.contains_key("zh") {
        "zh".to_string()
    } else {
        "en".to_string()
    };
    serde_json::json!({
        "languages": languages,
        "voices_by_lang": voices_by_lang,
        "default_lang": default_lang,
    })
}
