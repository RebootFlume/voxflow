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

use crate::app_state::{AppState, TtsCancel};
use crate::tts::chunk;
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
///
/// 长文本按 `chunk::split_text` 分段、逐段合成后拼接成一个文件（短文本单段，
/// 与改造前完全等价）。每段完成后经 `sidecar://event` 发 `tts_progress` 供界面显示。
#[tauri::command]
pub async fn rust_synthesize(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    voice: String,
    export_dir: String,
) -> Result<serde_json::Value, String> {
    let registry = state.tts.clone();
    let cancel = state.tts_cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        synthesize_blocking(&registry, &cancel, &text, &voice, &export_dir, |done, total| {
            // 单段（短文本）不发进度：与「短文本免分段」一致，界面上不该冒出「第 1/1 段」
            if total > 1 {
                let _ = app.emit("sidecar://event", tts_progress_payload(done, total));
            }
        })
    })
    .await
    .map_err(|e| format!("synthesize task failed: {e}"))?
}

/// 进度事件 payload。
///
/// 形状是前后端契约（前端 `useSidecarEvents` 按 `status` 字段分发、按 `chunk/chunks` 显示），
/// 所以抽出来加测试钉住：字符串写错时前端会**静默忽略**，肉眼看不出来。
fn tts_progress_payload(done: usize, total: usize) -> serde_json::Value {
    serde_json::json!({
        "status": "tts_progress",
        "chunk": done,
        "chunks": total,
        "progress": done as f64 / total.max(1) as f64,
    })
}

/// 取消正在进行的合成（段边界生效）。
///
/// 引擎的一次 `synthesize` 是不可中断的子进程调用（`Command::output()`，不保留 Child
/// 句柄），所以取消最多等当前段跑完（默认 120 字/段）。返回是否确有合成被标记取消。
///
/// 体里只翻一个 `AtomicBool`：无 IO、无进程、无等待，**同步执行不会卡主线程**。
/// 审计（§11.3）会因 `load`/`store` 这类通用方法名与引擎侧同名函数求并集而误报，
/// 已按工具设计登记到 `scripts/audit-command-context.py` 的例外名单。
#[tauri::command]
pub fn rust_cancel_tts(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({ "cancelled": state.tts_cancel.request() })
}

/// 合成 + 落盘（阻塞线程内执行；注册表锁覆盖整个合成，保持 API server 的 503 忙碌语义）
///
/// **任一段最终失败 ⇒ 整单失败、不落盘**：宁可什么都不产出，也不写出缺段或顺序错的音频。
fn synthesize_blocking(
    registry: &Arc<Mutex<TtsRegistry>>,
    cancel: &TtsCancel,
    text: &str,
    voice: &str,
    export_dir: &str,
    on_progress: impl FnMut(usize, usize),
) -> Result<serde_json::Value, String> {
    if text.is_empty() {
        return Err("text is empty".into());
    }

    let chunks = chunk::split_text(text, chunk::MAX_CHARS_PER_CHUNK);
    if chunks.is_empty() {
        return Err("text is empty".into());
    }

    let (samples, sample_rate, cancelled) = {
        let guard = registry.lock();
        let engine = guard
            .active()
            .ok_or("TTS 模型未加载，请先在「模型与设备」中加载模型")?;
        cancel.begin();
        let outcome = synthesize_chunks(&engine, cancel, &chunks, voice, on_progress);
        cancel.end();
        outcome?
    };

    if cancelled {
        // 被取消：不写文件、不算失败（前端按 cancelled 标记任务为「已取消」）
        return Ok(serde_json::json!({
            "text": text,
            "voice": voice,
            "chunks": chunks.len(),
            "cancelled": true,
        }));
    }
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
        "chunks": chunks.len(),
        "cancelled": false,
    }))
}

/// 逐段合成并拼接 PCM。返回 (样本, 采样率, 是否被取消)。
///
/// - 取消只在**段与段之间**生效（引擎边界，见 `TtsCancel`）；命中即返回空样本 + true，
///   调用方不落盘。
/// - 单段失败重试一次（子进程偶发启动失败）；仍失败 ⇒ 整单失败，错误点名段号与段首文本。
/// - 采样率不一致视为异常（同一模型不该变），直接失败而不是拼出变速音频。
pub(crate) fn synthesize_chunks(
    engine: &Arc<dyn crate::tts::traits::TtsEngine>,
    cancel: &TtsCancel,
    chunks: &[String],
    voice: &str,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<(Vec<i16>, u32, bool), String> {
    let total = chunks.len();
    let mut samples: Vec<i16> = Vec::new();
    let mut sample_rate = 0u32;

    for (i, part) in chunks.iter().enumerate() {
        if cancel.is_cancelled() {
            return Ok((Vec::new(), 0, true));
        }
        let audio = synthesize_once(engine, part, voice).or_else(|first| {
            synthesize_once(engine, part, voice)
                .map_err(|second| format!("{first}；重试一次后仍失败：{second}"))
        });
        let audio = audio.map_err(|e| {
            let head: String = part.chars().take(20).collect();
            format!("第 {}/{} 段合成失败（“{head}…”）：{e}", i + 1, total)
        })?;

        if sample_rate == 0 {
            sample_rate = audio.sample_rate;
        } else if audio.sample_rate != sample_rate {
            return Err(format!(
                "分段采样率不一致（{sample_rate} vs {}），已中止以免拼出变速音频",
                audio.sample_rate
            ));
        }
        samples.extend_from_slice(&audio.samples);
        on_progress(i + 1, total);
    }

    Ok((samples, sample_rate, false))
}

/// 单段合成（一次子进程调用）
fn synthesize_once(
    engine: &Arc<dyn crate::tts::traits::TtsEngine>,
    text: &str,
    voice: &str,
) -> Result<crate::tts::traits::SynthAudio, String> {
    engine.synthesize(text, voice).map_err(|e| e.to_string())
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

// --- 应用内试听（读音频字节）--------------------------------------------------

/// 试听可读的音频扩展名（与音色库 AUDIO_EXTS 同集合）
const LISTEN_EXTS: [&str; 5] = ["wav", "mp3", "flac", "ogg", "m4a"];
/// 单次试听大小上限：约 8 分钟 24kHz/16bit 单声道 ≈ 23MB，留余量
const MAX_LISTEN_BYTES: u64 = 32 * 1024 * 1024;

/// 读取音频文件原始字节，供前端在应用内试听（Blob → `<audio>`）。
///
/// 为什么不沿用 `openPath`：① 它依赖系统默认播放器，`.wav` 无关联时**静默无反应**；
/// ② 它需要 `opener:allow-open-path` 权限，而本项目只申请了 `opener:default`（不含 open_path），
/// 运行时一律被拒 ⇒ 表现就是"点了试听没反应"。
///
/// 护栏（避免这个命令变成任意文件读取入口）：扩展名白名单 + 必须是文件 + 大小上限。
#[tauri::command]
pub async fn rust_read_audio(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || read_audio_bytes(std::path::Path::new(&path)))
        .await
        .map_err(|e| format!("read audio task failed: {e}"))?
        .map(tauri::ipc::Response::new)
}

fn read_audio_bytes(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !LISTEN_EXTS.contains(&ext.as_str()) {
        return Err(format!("不是可试听的音频文件: {}", path.display()));
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("音频文件不可读: {e}"))?;
    if !meta.is_file() {
        return Err(format!("不是文件: {}", path.display()));
    }
    if meta.len() > MAX_LISTEN_BYTES {
        return Err(format!(
            "音频过大（{} MB），无法在应用内试听",
            meta.len() / 1024 / 1024
        ));
    }
    std::fs::read(path).map_err(|e| format!("读取音频失败: {e}"))
}

#[cfg(test)]
mod tests {
    /// 假引擎：按调用序列返回 (样本值, 采样率)，Err 表示该次调用失败
    struct FakeEngine {
        plan: parking_lot::Mutex<Vec<Result<(i16, u32), ()>>>,
        calls: parking_lot::Mutex<Vec<String>>,
    }

    impl crate::tts::traits::TtsEngine for FakeEngine {
        fn name(&self) -> &str {
            "fake"
        }
        fn load(
            &self,
            _model_path: &std::path::Path,
            _device: &str,
        ) -> crate::tts::traits::TtsResult<()> {
            Ok(())
        }
        fn unload(&self) -> crate::tts::traits::TtsResult<()> {
            Ok(())
        }
        fn is_loaded(&self) -> bool {
            true
        }
        fn set_language(&self, _language: &str) -> crate::tts::traits::TtsResult<()> {
            Ok(())
        }
        fn synthesize(
            &self,
            text: &str,
            _voice: &str,
        ) -> crate::tts::traits::TtsResult<crate::tts::traits::SynthAudio> {
            self.calls.lock().push(text.to_string());
            let mut plan = self.plan.lock();
            if plan.is_empty() {
                return Ok(crate::tts::traits::SynthAudio {
                    samples: vec![99, 99],
                    sample_rate: 24000,
                });
            }
            match plan.remove(0) {
                Ok((tag, rate)) => Ok(crate::tts::traits::SynthAudio {
                    samples: vec![tag, tag],
                    sample_rate: rate,
                }),
                Err(()) => Err(crate::errors::AppError::InferenceFailed("模拟失败".into())),
            }
        }
    }

    fn fake(plan: Vec<Result<(i16, u32), ()>>) -> std::sync::Arc<dyn crate::tts::traits::TtsEngine> {
        std::sync::Arc::new(FakeEngine {
            plan: parking_lot::Mutex::new(plan),
            calls: parking_lot::Mutex::new(Vec::new()),
        })
    }

    /// 进度事件形状是前后端契约（写错字符串前端会静默忽略）
    #[test]
    fn tts_progress_payload_shape_is_frozen() {
        let p = super::tts_progress_payload(3, 12);
        assert_eq!(p["status"], "tts_progress");
        assert_eq!(p["chunk"], 3);
        assert_eq!(p["chunks"], 12);
        assert_eq!(p["progress"].as_f64().unwrap(), 0.25);
        // total=0 不得除零（构造上不会出现，但契约上要稳）
        assert_eq!(super::tts_progress_payload(0, 0)["progress"].as_f64().unwrap(), 0.0);
    }

    /// 单段（短文本）⇒ 与改造前的单次调用等价：一次合成、一次进度、样本原样
    #[test]
    fn single_chunk_matches_previous_single_call() {
        let engine = fake(vec![Ok((7, 24000))]);
        let cancel = super::TtsCancel::default();
        let chunks = super::chunk::split_text("你好，世界。", super::chunk::MAX_CHARS_PER_CHUNK);
        assert_eq!(chunks.len(), 1, "短文本必须只有一段");

        let mut progress = Vec::new();
        let (samples, rate, cancelled) =
            super::synthesize_chunks(&engine, &cancel, &chunks, "45", |d, t| progress.push((d, t)))
                .unwrap();
        assert!(!cancelled);
        assert_eq!(rate, 24000);
        assert_eq!(samples, vec![7, 7]);
        assert_eq!(progress, vec![(1, 1)]);
    }

    /// 多段 ⇒ 按段序拼接，进度逐段递增
    #[test]
    fn chunks_concatenate_in_order_with_progress() {
        let chunks = super::chunk::split_text("第一句话。第二句话。第三句话。", 6);
        assert!(chunks.len() >= 2, "应切成多段: {chunks:?}");
        let plan: Vec<Result<(i16, u32), ()>> =
            (1..=chunks.len()).map(|i| Ok((i as i16, 24000))).collect();
        let engine = fake(plan);
        let cancel = super::TtsCancel::default();

        let mut progress = Vec::new();
        let (samples, _rate, cancelled) =
            super::synthesize_chunks(&engine, &cancel, &chunks, "45", |d, t| progress.push((d, t)))
                .unwrap();
        assert!(!cancelled);
        let expected: Vec<i16> = (1..=chunks.len() as i16).flat_map(|i| [i, i]).collect();
        assert_eq!(samples, expected, "拼接顺序必须是段序");
        assert_eq!(progress.first(), Some(&(1, chunks.len())));
        assert_eq!(progress.last(), Some(&(chunks.len(), chunks.len())));
    }

    /// 段间取消：命中后丢弃已合成的音频（不落盘），且不再发起后续段
    #[test]
    fn cancel_between_chunks_discards_audio() {
        let engine = fake(vec![Ok((1, 24000)), Ok((2, 24000)), Ok((3, 24000))]);
        let cancel = std::sync::Arc::new(super::TtsCancel::default());
        cancel.begin();
        let trigger = cancel.clone();
        let chunks: Vec<String> = vec!["甲。".into(), "乙。".into(), "丙。".into()];

        let (samples, _rate, cancelled) =
            super::synthesize_chunks(&engine, &cancel, &chunks, "45", move |_d, _t| {
                trigger.request();
            })
            .unwrap();
        assert!(cancelled, "应报告被取消");
        assert!(samples.is_empty(), "取消后不得返回半截音频");
    }

    /// 单段失败重试一次；仍失败 ⇒ 整单失败且点名段号
    #[test]
    fn retry_once_then_abort_with_chunk_index() {
        // 段1：第一次失败、重试成功；段2：两次都失败
        let engine = fake(vec![Err(()), Ok((1, 24000)), Err(()), Err(())]);
        let cancel = super::TtsCancel::default();
        let chunks: Vec<String> = vec!["甲。".into(), "乙。".into()];

        let err = super::synthesize_chunks(&engine, &cancel, &chunks, "45", |_d, _t| {})
            .expect_err("整单应失败");
        assert!(err.contains("第 2/2 段"), "错误要点名段号: {err}");
        assert!(err.contains("重试"), "错误要说明重试过: {err}");
    }

    /// 采样率变化 ⇒ 中止（不拼出变速音频）
    #[test]
    fn sample_rate_change_aborts() {
        let engine = fake(vec![Ok((1, 24000)), Ok((2, 22050))]);
        let cancel = super::TtsCancel::default();
        let chunks: Vec<String> = vec!["甲。".into(), "乙。".into()];

        let err = super::synthesize_chunks(&engine, &cancel, &chunks, "45", |_d, _t| {})
            .expect_err("采样率不一致应中止");
        assert!(err.contains("采样率不一致"), "{err}");
    }

    /// 取消令牌：没有合成在跑时 request 返回 false（避免误伤下一次合成）
    #[test]
    fn cancel_request_is_noop_when_idle() {
        let cancel = super::TtsCancel::default();
        assert!(!cancel.request());
        cancel.begin();
        assert!(cancel.request());
        assert!(cancel.is_cancelled());
        cancel.end();
        assert!(!cancel.is_cancelled());
        assert!(!cancel.request());
    }

    /// 真引擎长文本实测：用本机已下载的 Kokoro-v1_0 跑一次分段合成，检查
    /// 「切了多段 / 逐段进度 / 时长与字符数匹配（没丢段）/ 非静音」。
    ///
    /// 手动运行：`cargo test --lib real_long_text -- --ignored --nocapture`
    /// 本机没有该模型时直接跳过（不失败）。
    #[ignore = "需要真实模型 + 数十秒 CPU 推理，按需手动运行"]
    #[test]
    fn real_long_text_synthesis_is_chunked_and_complete() {
        let candidates = [
            std::env::var("APPDATA")
                .ok()
                .map(|p| std::path::PathBuf::from(p).join("com.voxflow.app/models")),
            Some(
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("data")
                    .join("models"),
            ),
        ];
        let Some(root) = candidates
            .into_iter()
            .flatten()
            .find(|p| p.join("kokoro-multi-lang-v1_0").is_dir())
        else {
            eprintln!("跳过：本机没有 kokoro-multi-lang-v1_0");
            return;
        };
        crate::model_manager::set_model_root(&root.to_string_lossy()).unwrap();

        let registry = super::TtsRegistry::new();
        registry.load("Kokoro-v1_0", "cpu").expect("加载 Kokoro-v1_0");
        let engine = registry.active().expect("加载后应有引擎");

        let text = "语音合成现在支持长文本分段了。超过一百二十个字符的文本会被按句子切开，\
一段一段合成，再把波形按顺序拼成一个文件。这样做的好处是进度可见，而且随时可以取消。\
第三句话用来把长度顶过阈值，确保真的走了分段路径。第四句继续补充一些内容，让总长度足够切出三段来。\
第五句再加一点：分段只在句末标点处切，所以听起来不会在句子中间断掉。最后一句收尾，感谢使用。";
        let chunks = super::chunk::split_text(text, super::chunk::MAX_CHARS_PER_CHUNK);
        assert!(chunks.len() >= 2, "这段文本应被切成多段: {chunks:?}");

        let cancel = super::TtsCancel::default();
        let mut progress = Vec::new();
        let (samples, rate, cancelled) =
            super::synthesize_chunks(&engine, &cancel, &chunks, "45", |d, t| progress.push((d, t)))
                .unwrap();

        let secs = samples.len() as f64 / rate as f64;
        let chars = text.chars().count();
        println!(
            "段数={} 字符={} 采样率={} 样本={} 时长={:.1}s 进度={:?}",
            chunks.len(),
            chars,
            rate,
            samples.len(),
            secs,
            progress
        );

        assert!(!cancelled);
        assert_eq!(rate, 24000, "Kokoro 输出应为 24kHz");
        assert_eq!(progress.len(), chunks.len(), "每段都应报一次进度");
        assert_eq!(progress.last(), Some(&(chunks.len(), chunks.len())));
        // 中文 TTS 大致 0.15~0.8 秒/字；低于下界说明有段被丢了（拼接不完整）
        let lo = chars as f64 * 0.15;
        assert!(secs > lo, "时长 {secs:.1}s 低于下界 {lo:.1}s，疑似丢段");
        let peak = samples.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
        assert!(peak > 1000, "音频不应为静音: peak={peak}");
    }

    #[test]
    fn read_audio_rejects_non_audio_and_missing() {
        let dir = std::env::temp_dir().join(format!("voxflow-listen-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let txt = dir.join("note.txt");
        std::fs::write(&txt, b"not audio").unwrap();
        assert!(super::read_audio_bytes(&txt).is_err(), "非音频扩展名必须拒绝");
        assert!(
            super::read_audio_bytes(&dir.join("nope.wav")).is_err(),
            "文件不存在必须拒绝"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_audio_reads_bytes_and_caps_size() {
        let dir = std::env::temp_dir().join(format!("voxflow-listen-size-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("ok.wav");
        std::fs::write(&wav, b"RIFFxxxxWAVE").unwrap();
        assert_eq!(super::read_audio_bytes(&wav).unwrap(), b"RIFFxxxxWAVE");

        // 超过上限（set_len 造大文件，不实际写满）
        let big = dir.join("big.wav");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(super::MAX_LISTEN_BYTES + 1).unwrap();
        drop(f);
        let err = super::read_audio_bytes(&big).unwrap_err();
        assert!(err.contains("音频过大"), "超限必须拒绝: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

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
