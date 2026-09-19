//! TTS Tauri 命令桥接（前端 IPC）
//!
//! P2 重构（方案文档 4.2）：
//! - 单命令 `rust_load_tts_model`（registry 路由，删 `rust_switch_e2e_tts_model` / `parse_model_id`）。
//! - 重活走 `spawn_blocking`（同步命令阻塞主线程 → UI 冻结，已修）。
//! - 能力数据来自 `spec.rs` 描述符（语言 / 音色 / 克隆），不扫废弃目录。
//! - `rust_synthesize` 按引擎返回的真实采样率写盘（不再硬编码 24k）。
//!
//! 删除项：`rust_switch_e2e_tts_model`、`rust_list_tts_voices`（扫描已废弃的 Kokoro-82M 目录）。

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;
use crate::tts::registry::TtsRegistry;
use crate::tts::spec::{ModelKind, ModelSpec, PresetSpec, VoiceMode};

/// 加载 TTS 模型（唯一权威路由：展示名 / 引擎 id / 目录名均可）
#[tauri::command]
pub async fn rust_load_tts_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model_path: String,
    device: String,
) -> Result<serde_json::Value, String> {
    let registry = state.tts.clone();
    let model = model_path.clone();
    let dev = device.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let guard = registry.lock();
        guard.load(&model, &dev)
    })
    .await
    .map_err(|e| format!("load task failed: {e}"))?;

    match &result {
        Ok((framework, name)) => {
            let _ = app.emit(
                "sidecar://event",
                serde_json::json!({
                    "status": "model_ready",
                    "kind": "tts",
                    "model": name,
                    "framework": framework,
                    "device": device,
                }),
            );
        }
        Err(e) => {
            let _ = app.emit(
                "sidecar://event",
                serde_json::json!({
                    "status": "model_error",
                    "kind": "tts",
                    "model": model_path,
                    "msg": e,
                }),
            );
        }
    }

    let (framework, name) = result?;
    Ok(serde_json::json!({
        "status": "loaded",
        "model": name,
        "framework": framework,
        "device": device,
    }))
}

/// 卸载当前 TTS 模型（释放引擎，可随后删除模型）
///
/// async + 阻塞池：卸载含杀子进程 + 等端口关闭，不可占主线程。
#[tauri::command]
pub async fn rust_unload_tts_model(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let registry = state.tts.clone();
    tauri::async_runtime::spawn_blocking(move || {
        registry.lock().unload()?;
        Ok(serde_json::json!({ "status": "unloaded" }))
    })
    .await
    .map_err(|e| format!("unload task failed: {e}"))?
}

/// 设置语音克隆参数（参考音频 + 参考文本；仅克隆模型支持，其余引擎默认拒绝）
///
/// async + 阻塞池：写参考音频 + 引擎侧克隆（触达引擎，可能起子进程）。
#[tauri::command]
pub async fn rust_set_tts_clone_voice(
    state: State<'_, AppState>,
    audio_path: String,
    reference_text: String,
) -> Result<serde_json::Value, String> {
    let registry = state.tts.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = registry.lock();
        let engine = guard.active().ok_or("TTS 模型未加载")?;
        engine
            .set_clone_voice(std::path::Path::new(&audio_path), &reference_text)
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "status": "ok",
            "reference_audio": audio_path,
            "reference_text": reference_text,
        }))
    })
    .await
    .map_err(|e| format!("clone voice task failed: {e}"))?
}

/// 清除语音克隆参数（回到预设音色模式）
///
/// 两处都要清，缺一不可：
/// - 引擎侧（`clear_clone_voice`）——否则合成仍带着参考音；
/// - 音色库的 `active_id`——否则下次 TTS 模型就绪时按它恢复，会把用户**刚取消的克隆装回来**。
///
/// async + 阻塞池：引擎状态变更（与 set_clone_voice 同上下文，避免异步体内触达引擎）。
#[tauri::command]
pub async fn rust_clear_tts_clone_voice(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let registry = state.tts.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(engine) = registry.lock().active() {
            engine.clear_clone_voice();
        }
        crate::tts::voices::clear_active(&voices_dir(&app))?;
        Ok(serde_json::json!({ "status": "ok" }))
    })
    .await
    .map_err(|e| format!("clear clone voice task failed: {e}"))?
}

/// TTS 语音合成并保存为 WAV 文件（端到端：文本 → 波形；采样率取引擎真实输出）
#[tauri::command]
pub async fn rust_synthesize(
    state: State<'_, AppState>,
    text: String,
    voice: String,
    export_dir: String,
) -> Result<serde_json::Value, String> {
    let registry = state.tts.clone();
    tauri::async_runtime::spawn_blocking(move || synthesize_blocking(&registry, &text, &voice, &export_dir))
        .await
        .map_err(|e| format!("synthesize task failed: {e}"))?
}

/// 合成 + 落盘（阻塞线程内执行；锁覆盖整个合成，保持 API server 的 503 忙碌语义）
fn synthesize_blocking(
    registry: &Arc<Mutex<TtsRegistry>>,
    text: &str,
    voice: &str,
    export_dir: &str,
) -> Result<serde_json::Value, String> {
    if text.is_empty() {
        return Err("text is empty".into());
    }

    let (samples, sample_rate) = {
        let guard = registry.lock();
        let engine = guard
            .active()
            .ok_or("TTS model not loaded. Please load a model first.")?;
        let audio = engine.synthesize(text, voice).map_err(|e| e.to_string())?;
        (audio.samples, audio.sample_rate)
    };
    if samples.is_empty() {
        return Err("合成音频为空".into());
    }

    let out_dir = std::path::Path::new(export_dir);
    if !out_dir.exists() {
        std::fs::create_dir_all(out_dir).map_err(|e| format!("create dir failed: {e}"))?;
    }

    let ts = chrono::Local::now().format("%H%M%S").to_string();
    let safe_text: String = text
        .chars()
        .take(20)
        .filter(|c| c.is_alphanumeric() || *c == ' ' || ('\u{4e00}'..='\u{9fff}').contains(c))
        .collect();
    let file_name = if safe_text.trim().is_empty() {
        format!("tts_{}.wav", ts)
    } else {
        format!("{}_{}.wav", safe_text.trim(), ts)
    };
    let out_path = out_dir.join(&file_name);

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: sample_rate.max(1),
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&out_path, spec)
        .map_err(|e| format!("WAV create failed: {e}"))?;
    for &s in &samples {
        writer
            .write_sample(s)
            .map_err(|e| format!("WAV write failed: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("WAV finalize failed: {e}"))?;

    let file_size = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    let size_str = if file_size > 1024 * 1024 {
        format!("{:.1} MB", file_size as f64 / 1024.0 / 1024.0)
    } else {
        format!("{} KB", file_size / 1024)
    };

    Ok(serde_json::json!({
        "text": text,
        "voice": voice,
        "sample_rate": sample_rate,
        "saved_path": out_path.to_string_lossy(),
        "size": size_str,
    }))
}

/// 切换 TTS 语言（按模型描述符校验；不在命令层硬编码白名单）
///
/// async + 阻塞池：切换 voice embedding 会触达引擎。
#[tauri::command]
pub async fn rust_set_tts_language(
    state: State<'_, AppState>,
    language: String,
) -> Result<serde_json::Value, String> {
    let registry = state.tts.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lang = language.trim().to_lowercase();
        let guard = registry.lock();
        let engine = guard.active().ok_or("TTS 模型未加载")?;
        engine.set_language(&lang).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "language": lang }))
    })
    .await
    .map_err(|e| format!("set language task failed: {e}"))?
}

/// 查询当前 TTS 模型的说话人列表（描述符驱动：speakers.json 优先，数量 = 列表长度）
///
/// async + 阻塞池：扫描 voices 目录（文件 IO）。
/// 有 State → 返回 `Result`；业务性失败（未知模型 / 空列表）仍是 `Ok`，形状不变。
#[tauri::command]
pub async fn rust_list_tts_speakers(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let registry = state.tts.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = registry.lock();
        let model = guard.loaded_model();
        let Some(spec) = ModelSpec::find(&model).filter(|s| s.kind == ModelKind::Tts) else {
            return Ok(serde_json::json!({ "model": model, "num_speakers": 0, "speakers": [] }));
        };
        let speakers = match spec.voice_mode {
            VoiceMode::Preset(p) | VoiceMode::PresetAndClone(p, _) => {
                speaker_list(&guard.model_dir(spec.id), p)
            }
            _ => Vec::new(),
        };
        let entries: Vec<serde_json::Value> = speakers
            .iter()
            .map(|(sid, name)| serde_json::json!({ "sid": sid, "name": name }))
            .collect();
        Ok(serde_json::json!({
            "model": spec.name,
            "num_speakers": entries.len(),
            "speakers": entries,
        }))
    })
    .await
    .map_err(|e| format!("list speakers task failed: {e}"))?
}

// ─── 克隆音色库（录音/上传 → 命名 + 说明 → 条目 → 试用即用）──────────────────
//
// 用户诉求（对标 Voicebox）：音色要能"攒起来"——录/传一个、起名字写说明、存成条目，
// 之后在条目之间挑，点一下就用；而不是每次重新录一遍、重新贴一遍参考文本。

/// 音色库目录（数据根下 `tts-voices/`；安装版/便携版由 data_root 统一处理）
fn voices_dir(app: &AppHandle) -> std::path::PathBuf {
    crate::data_root::get_data_root(app).join(crate::tts::voices::DIR_NAME)
}

fn voice_json(dir: &std::path::Path, v: &crate::tts::voices::Voice) -> serde_json::Value {
    serde_json::json!({
        "id": v.id,
        "name": v.name,
        "note": v.note,
        "reference_text": v.reference_text,
        "audio_path": crate::tts::voices::path_of(dir, v).to_string_lossy(),
        "created_ms": v.created_ms,
    })
}

/// 列出音色库（含当前选中 id）
#[tauri::command]
pub async fn rust_tts_voices_list(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = voices_dir(&app);
        let lib = crate::tts::voices::load(&dir);
        let voices: Vec<serde_json::Value> =
            lib.voices.iter().map(|v| voice_json(&dir, v)).collect();
        Ok(serde_json::json!({
            "dir": dir.to_string_lossy(),
            "active_id": lib.active_id,
            "voices": voices,
        }))
    })
    .await
    .map_err(|e| format!("list voices task failed: {e}"))?
}

/// 把一个音频（录音草稿或用户上传）收进音色库：命名后成为可复用条目
#[tauri::command]
pub async fn rust_tts_voice_add(
    app: AppHandle,
    source_path: String,
    name: String,
    note: String,
    reference_text: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = voices_dir(&app);
        let voice = crate::tts::voices::add(
            &dir,
            std::path::Path::new(&source_path),
            &name,
            &note,
            &reference_text,
        )?;
        Ok(serde_json::json!({ "id": voice.id }))
    })
    .await
    .map_err(|e| format!("add voice task failed: {e}"))?
}

/// 改名 / 改说明 / 改参考文本
#[tauri::command]
pub async fn rust_tts_voice_update(
    app: AppHandle,
    id: String,
    name: String,
    note: String,
    reference_text: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = voices_dir(&app);
        crate::tts::voices::update(&dir, &id, &name, &note, &reference_text)?;
        Ok(serde_json::json!({ "ok": true }))
    })
    .await
    .map_err(|e| format!("update voice task failed: {e}"))?
}

/// 删除条目。若删的正是当前选中：**先清引擎的克隆参数，再删库**
/// （否则库里没了、引擎还在用旧的参考音合成）。
#[tauri::command]
pub async fn rust_tts_voice_remove(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> Result<serde_json::Value, String> {
    let registry = state.tts.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = voices_dir(&app);
        let lib = crate::tts::voices::load(&dir);
        if lib.active_id.as_deref() == Some(id.as_str()) {
            if let Some(engine) = registry.lock().active() {
                engine.clear_clone_voice();
            }
        }
        crate::tts::voices::remove(&dir, &id)?;
        Ok(serde_json::json!({ "ok": true }))
    })
    .await
    .map_err(|e| format!("remove voice task failed: {e}"))?
}

/// 应用某个音色：**先把参数成功下发给引擎，才记为"当前选中"**。
///
/// 顺序不可反（否则库里显示已选中、引擎里根本没有这份参数 = 谎报）；
/// 引擎侧能力校验（非克隆模型拒绝）失败时，这里直接返回错误、不落库。
#[tauri::command]
pub async fn rust_tts_voice_use(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> Result<serde_json::Value, String> {
    let registry = state.tts.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = voices_dir(&app);
        let lib = crate::tts::voices::load(&dir);
        let voice = lib
            .voices
            .iter()
            .find(|v| v.id == id)
            .cloned()
            .ok_or_else(|| format!("音色不存在: {id}"))?;
        let path = crate::tts::voices::path_of(&dir, &voice);
        {
            let guard = registry.lock();
            let engine = guard.active().ok_or("TTS 模型未加载")?;
            engine
                .set_clone_voice(&path, &voice.reference_text)
                .map_err(|e| e.to_string())?;
        }
        crate::tts::voices::set_active(&dir, &id)?;
        Ok(serde_json::json!({ "ok": true, "name": voice.name }))
    })
    .await
    .map_err(|e| format!("use voice task failed: {e}"))?
}

// ─── 辅助 ──────────────────────────────────────────────────────────────────

/// 说话人列表：speakers.json 优先（名字 + 数量 = 列表长度），否则生成 0..count 编号
fn speaker_list(dir: &std::path::Path, preset: PresetSpec) -> Vec<(i32, String)> {
    if let Some(file) = preset.speakers_file {
        let path = dir.join(file);
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(list) = serde_json::from_str::<Vec<SpeakerEntry>>(&data) {
                if !list.is_empty() {
                    return list.into_iter().map(|e| (e.sid, e.name)).collect();
                }
            }
        }
    }
    (0..preset.count)
        .map(|i| (i as i32, format!("speaker {i}")))
        .collect()
}

#[derive(serde::Deserialize)]
struct SpeakerEntry {
    sid: i32,
    name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_speaker_list_generic_fallback() {
        let dir = std::path::Path::new("nonexistent-dir");
        let list = speaker_list(
            dir,
            PresetSpec {
                count: 3,
                speakers_file: None,
                per_language: false,
            },
        );
        assert_eq!(list.len(), 3);
        assert_eq!(list[2], (2, "speaker 2".to_string()));
    }
}
