//! TTS Tauri 命令桥接（前端 IPC）
//!
//! 从 lib.rs 抽出：`rust_load_tts_model` / `rust_synthesize` /
//! `rust_set_tts_language` / `rust_list_tts_voices` /
//! `rust_list_e2e_tts_models` / `rust_switch_e2e_tts_model`。
//! 引擎实例经 `State<AppState>` 注入（见 app_state.rs），不再用静态全局变量。

use std::collections::{HashMap, HashSet};

use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;
use crate::tts::engine::e2e_registry::{E2eTtsModel, E2eTtsModelInfo};
use crate::tts::traits::TtsEngine;

/// 列出所有可切换的纯 E2E TTS 模型（Kokoro/Matcha/ZipVoice/Pocket/Supertonic/Kitten）
/// 返回模型元数据 + 本地是否已下载模型文件
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn rust_list_e2e_tts_models() -> serde_json::Value {
    let infos: Vec<serde_json::Value> = E2eTtsModel::all()
        .into_iter()
        .map(|m| {
            let info: E2eTtsModelInfo = m.into();
            let dir = crate::model_manager::get_model_root().join(&info.default_dir);
            let downloaded = dir.exists();
            serde_json::json!({
                "id": info.id,
                "name": info.name,
                "cli_prefix": info.cli_prefix,
                "default_dir": info.default_dir,
                "is_chinese_optimized": info.is_chinese_optimized,
                "languages": info.languages,
                "supports_speaker": info.supports_speaker,
                "language_mode": info.language_mode,
                "downloaded": downloaded,
            })
        })
        .collect();
    serde_json::json!({ "models": infos })
}

/// 切换 E2E TTS 模型（按 id，如 "kokoro-v1_1" / "matcha"）
/// 先卸载当前，再加载新模型
#[tauri::command]
pub fn rust_switch_e2e_tts_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model_id: String,
    device: String,
) -> Result<serde_json::Value, String> {
    let m: E2eTtsModel = parse_model_id(&model_id)
        .ok_or_else(|| format!("未知 E2E 模型 id '{model_id}'"))?;

    // 模型根目录：统一数据根（get_model_root），无 workspace 回退
    let model_root = crate::model_manager::get_model_root();
    let model_path = model_root.join(m.default_model_dir());
    if !model_path.exists() {
        return Err(format!(
            "模型 {} 未下载，请先下载: {}",
            m.id(),
            model_path.display()
        ));
    }

    // 找到主模型文件（encoder.onnx / model.onnx 等）
    let main_file = crate::model_manager::find_main_model_file(
        &model_path,
        &crate::model_manager::ModelFormat::Onnx,
    )
    .ok_or_else(|| format!("模型 {} 缺少 ONNX 文件", m.id()))?;

    let result: Result<serde_json::Value, String> = {
        let mut guard = state.tts.lock();
        guard.load(&main_file, &device).map_err(|e| e.to_string())?;
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
                serde_json::json!({"status": "model_ready", "model": model_id, "device": device}),
            );
        }
        Err(e) => {
            let _ = app.emit(
                "sidecar://event",
                serde_json::json!({"status": "model_error", "model": model_id, "msg": e.to_string()}),
            );
        }
    }
    result
}

/// 卸载当前 TTS 模型（释放引擎，可随后删除模型）
#[tauri::command]
pub fn rust_unload_tts_model(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut guard = state.tts.lock();
    guard.unload().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": "unloaded" }))
}

/// 设置语音克隆参数（参考音频 + 参考文本）
/// 仅 ZipVoice / PocketTTS 等克隆模型支持
#[tauri::command]
pub fn rust_set_tts_clone_voice(
    state: State<'_, AppState>,
    audio_path: String,
    reference_text: String,
) -> Result<serde_json::Value, String> {
    let audio = std::path::Path::new(&audio_path);
    let mut guard = state.tts.lock();
    let sherpa = guard
        .as_mut_sherpa()
        .ok_or("当前 TTS 模型不支持语音克隆")?;
    sherpa
        .set_clone_voice(audio, &reference_text)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "status": "ok",
        "reference_audio": audio_path,
        "reference_text": reference_text,
    }))
}

/// 清除语音克隆参数（回到预设音色模式）
#[tauri::command]
pub fn rust_clear_tts_clone_voice(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut guard = state.tts.lock();
    if let Some(sherpa) = guard.as_mut_sherpa() {
        sherpa.clear_clone_voice();
    }
    Ok(serde_json::json!({ "status": "ok" }))
}

/// 解析模型 ID：大小写不敏感，且支持前端展示名（如 "Kokoro-v1_1" / "Kokoro-v1_0"）
fn parse_model_id(input: &str) -> Option<E2eTtsModel> {
    let lower = input.to_lowercase();
    // 1. 精确匹配 id
    for m in E2eTtsModel::all() {
        if m.id() == lower || m.id() == input {
            return Some(m);
        }
    }
    // 2. 归一化匹配：去掉 - 和 _（"kokoro-v1_0" → "kokorov10"）
    let norm = |s: &str| s.to_lowercase().replace(['-', '_'], "");
    let input_norm = norm(input);
    for m in E2eTtsModel::all() {
        if norm(m.id()) == input_norm {
            return Some(m);
        }
    }
    // 3. 族 + 版本匹配（Kokoro 系列展示名含版本号）
    //    优先匹配更具体的族（Matcha / ZipVoice / Pocket / Supertonic / Kitten）
    if lower.contains("kokoro") {
        if lower.contains("v1_1") || lower.contains("v1-1") {
            return Some(E2eTtsModel::KokoroV1_1);
        }
        if lower.contains("v1_0") || lower.contains("v1-0") {
            return Some(E2eTtsModel::KokoroV1_0);
        }
        // 无版本号 → 英文版（v0_19）或默认 v1_0
        return Some(E2eTtsModel::KokoroEn);
    }
    // 4. 族前缀匹配（最低兜底）
    let prefix = lower.split(|c: char| !c.is_alphanumeric()).next().unwrap_or("");
    E2eTtsModel::all()
        .into_iter()
        .find(|m| {
            let fam = m.id().split('-').next().unwrap_or("");
            lower.starts_with(fam) || prefix.starts_with(fam)
        })
}

/// 加载 TTS 模型
/// 支持传入模型名称或完整文件路径
/// 在 modelRoot 下查找模型（统一数据根，无 workspace 回退）
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
        );
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

/// TTS 语音合成并保存为 WAV 文件（端到端：文本 → 波形，无音素/语速/时长参数）
#[tauri::command]
pub fn rust_synthesize(
    state: State<'_, AppState>,
    text: String,
    voice: String,
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
        guard.infer(&text, &voice).map_err(|e| e.to_string())?
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

/// 查询当前 TTS 模型的说话人列表（供 Voice Settings 展示）
#[tauri::command]
pub fn rust_list_tts_speakers(
    state: State<'_, AppState>,
) -> serde_json::Value {
    let guard = state.tts.lock();
    let model_name = guard.name().to_string();
    drop(guard);
    let lower = model_name.to_lowercase();
    let model_root = crate::model_manager::get_model_root();
    for m in E2eTtsModel::all() {
        if lower.contains(m.id()) || lower.contains(m.default_model_dir()) {
            let speakers: Vec<serde_json::Value> = m
                .speaker_list_from_dir(&model_root)
                .iter()
                .map(|(sid, name)| serde_json::json!({ "sid": sid, "name": name }))
                .collect();
            return serde_json::json!({
                "model": model_name,
                "num_speakers": m.num_speakers(),
                "speakers": speakers,
            });
        }
    }
    serde_json::json!({ "model": model_name, "num_speakers": 0, "speakers": [] })
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
    // 通用 ONNX 引擎模型的 voices 目录（旧 Kokoro-82M 布局已废弃，这里保留接口）
    dirs.push(crate::model_manager::model_dir("Kokoro-82M").join("voices"));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_model_id_exact() {
        assert_eq!(parse_model_id("kokoro-v1_0"), Some(E2eTtsModel::KokoroV1_0));
        assert_eq!(parse_model_id("matcha"), Some(E2eTtsModel::Matcha));
        assert_eq!(parse_model_id("supertonic"), Some(E2eTtsModel::Supertonic));
    }

    #[test]
    fn test_parse_model_id_display_name() {
        // 前端 ModelSelector 展示名（大小写 + 下划线）
        assert_eq!(parse_model_id("Kokoro-v1_0"), Some(E2eTtsModel::KokoroV1_0));
        assert_eq!(parse_model_id("Kokoro-v1_1"), Some(E2eTtsModel::KokoroV1_1));
        assert_eq!(parse_model_id("Kokoro-en-v0_19"), Some(E2eTtsModel::KokoroEn));
        assert_eq!(parse_model_id("ZipVoice-distill"), Some(E2eTtsModel::ZipVoice));
        assert_eq!(parse_model_id("PocketTTS-int8"), Some(E2eTtsModel::PocketTts));
        assert_eq!(parse_model_id("Kitten-nano-en"), Some(E2eTtsModel::Kitten));
    }

    #[test]
    fn test_parse_model_id_unknown() {
        assert_eq!(parse_model_id("bogus-model"), None);
    }
}
