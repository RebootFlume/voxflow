//! 推理引擎 Tauri 命令桥接
//!
//! llama-server 子进程命令（ASR 主力路线）。
//! 旧 AsrEngine（llama-cpp-2 占位）已移除，ASR 走 llama-server / sherpa 子进程。

use super::llama_server::{global_engine, LlamaAsrAdapter};
use super::engine::InferenceEngine;
use super::transcribe_chunks::transcribe_long;
use super::super::audio;

// ============================================================
// llama-server 子进程命令
// ============================================================

/// 启动 llama-server 子进程
///
/// 前端调用：`invoke('rust_start_llama_server', { model, device })`
/// 返回：`{"ok": true, "loaded": true}` 或错误信息
/// model 为空时用默认（Qwen3-ASR-0.6B）；device: "cuda" / "cpu"
pub fn start_llama_server_with_stage(
    model: Option<&str>,
    device: &str,
    on_stage: &mut dyn FnMut(&str),
) -> Result<serde_json::Value, String> {
    let model = model.unwrap_or("Qwen3-ASR-0.6B");
    let name = super::llama_server::load_asr_model_with_stage(model, device, on_stage)
        .map_err(|e| e.to_string())?;
    let engine = global_engine();
    Ok(serde_json::json!({
        "ok": true,
        "loaded": engine.is_loaded(),
        "model": name,
    }))
}

/// 无阶段回调版本（兼容）
pub fn start_llama_server(model: Option<&str>) -> Result<serde_json::Value, String> {
    start_llama_server_with_stage(model, "cuda", &mut |_| {})
}

/// 停止 llama-server 子进程
pub fn stop_llama_server() -> Result<serde_json::Value, String> {
    let engine = global_engine();
    engine.unload().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"ok": true, "loaded": false}))
}

/// 查询 llama-server 状态
pub fn llama_server_status() -> serde_json::Value {
    let engine = global_engine();
    serde_json::json!({
        "loaded": engine.is_loaded(),
        "model": engine.model_name().unwrap_or(""),
    })
}

/// 通过 llama-server 转写文件
///
/// 路径仅作保留调用接口，底层走 HTTP：
///   1. 解码音频到 16kHz float32
///   2. POST /v1/audio/transcriptions （OpenAI 兼容）
///   3. 解析 {"text": "..."}
pub fn transcribe_file_via_llama_server(
    file_path: &str,
    export_dir: Option<&str>,
    export_format: Option<&str>,
) -> Result<serde_json::Value, String> {
    transcribe_file_with_progress(file_path, export_dir, export_format, &mut |_, _| {})
}

/// 带进度回调的转写：长音频分批转写，每段完成后回调（done_sec, total_sec）
pub fn transcribe_file_with_progress(
    file_path: &str,
    export_dir: Option<&str>,
    export_format: Option<&str>,
    on_progress: &mut dyn FnMut(f64, f64),
) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        return Err(format!("file not found: {}", file_path));
    }

    // 1. 解码音频（多格式：WAV 走 hound，其他走 ffmpeg 子进程）
    let data = std::fs::read(path).map_err(|e| format!("read file failed: {e}"))?;
    let (samples, sample_rate) = audio::decode_any(&data, path)?;
    if samples.is_empty() {
        return Ok(serde_json::json!({"text": "", "duration": 0.0}));
    }
    let duration = samples.len() as f64 / sample_rate as f64;

    // 2. 启动子进程（如未运行）
    let engine = global_engine();
    engine.load().map_err(|e| e.to_string())?;

    // 3. 转写：长音频自动分批（≤60s 单次，>60s 滑动窗口 60s+4s 重叠）
    let adapter = LlamaAsrAdapter::new();
    let text = transcribe_long(&adapter, &samples, sample_rate, on_progress)
        .map_err(|e| e.to_string())?;

    // 4. 导出（txt/srt/vtt/json/lrc）——可选，指定导出目录才写文件
    let saved_path = export_dir.map(|dir| {
        save_transcript(&text, path, dir, export_format.unwrap_or("txt"), duration)
    }).transpose()?;

    Ok(serde_json::json!({
        "text": text,
        "duration": (duration * 100.0).round() / 100.0,
        "model": engine.model_name().unwrap_or(""),
        "saved_path": saved_path,
    }))
}

/// 保存转写结果到导出目录（txt/srt/vtt/json/lrc）
/// 文件名 = 源音频文件名 + 格式后缀
fn save_transcript(
    text: &str,
    src: &std::path::Path,
    export_dir: &str,
    format: &str,
    duration: f64,
) -> Result<String, String> {
    let dir = std::path::Path::new(export_dir);
    std::fs::create_dir_all(dir).map_err(|e| format!("创建导出目录失败: {e}"))?;

    // 源文件名（去扩展名）
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "transcript".to_string());
    let out_path = dir.join(format!("{stem}.{format}"));

    let content = match format {
        "srt" => to_srt(text, duration),
        "vtt" => to_vtt(text, duration),
        "json" => format!(
            "{{\"text\": {},\"duration\": {:.2},\"source\": {}}}",
            serde_json::to_string(text).unwrap_or_default(),
            duration,
            serde_json::to_string(&src.to_string_lossy()).unwrap_or_default()
        ),
        "lrc" => to_lrc(text, duration),
        _ => text.to_string(), // txt 默认
    };

    std::fs::write(&out_path, content).map_err(|e| format!("写入导出文件失败: {e}"))?;
    Ok(out_path.to_string_lossy().into_owned())
}

/// 简单 SRT 字幕：整段文本作为一条（0 → 音频时长）
fn to_srt(text: &str, duration: f64) -> String {
    let end = format_srt_time(duration);
    format!("1\n00:00:00,000 --> {end}\n{}\n", text.trim())
}

/// 简单 VTT：整段文本作为一条
fn to_vtt(text: &str, duration: f64) -> String {
    let end = format_vtt_time(duration);
    format!("WEBVTT\n\n00:00:00.000 --> {end}\n{}\n", text.trim())
}

/// 简单 LRC：整段文本作为一条
fn to_lrc(text: &str, duration: f64) -> String {
    let mm = (duration / 60.0) as u64;
    let ss = (duration % 60.0) as u64;
    format!("[{:02}:{:02}.00]{}\n", mm, ss, text.trim())
}

fn format_srt_time(secs: f64) -> String {
    let total_ms = (secs * 1000.0) as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let m = (total_s / 60) % 60;
    let h = total_s / 3600;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
}

fn format_vtt_time(secs: f64) -> String {
    let total_ms = (secs * 1000.0) as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let m = (total_s / 60) % 60;
    let h = total_s / 3600;
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_srt_time() {
        assert_eq!(format_srt_time(0.0), "00:00:00,000");
        assert_eq!(format_srt_time(61.5), "00:01:01,500");
        assert_eq!(format_srt_time(3723.456), "01:02:03,456");
    }

    #[test]
    fn test_format_vtt_time() {
        assert_eq!(format_vtt_time(61.5), "00:01:01.500");
    }

    #[test]
    fn test_to_srt() {
        let srt = to_srt("你好世界", 2.5);
        assert!(srt.contains("1\n00:00:00,000 --> 00:00:02,500"));
        assert!(srt.contains("你好世界"));
    }

    #[test]
    fn test_to_lrc() {
        let lrc = to_lrc("你好世界", 61.0);
        assert!(lrc.contains("[01:01.00]"));
        assert!(lrc.contains("你好世界"));
    }

    #[test]
    fn test_to_vtt() {
        let vtt = to_vtt("hello", 3.0);
        assert!(vtt.starts_with("WEBVTT"));
        assert!(vtt.contains("00:00:00.000 --> 00:00:03.000"));
    }

    #[test]
    fn test_save_transcript_txt() {
        let dir = std::env::temp_dir().join("voxflow_export_test");
        let src = std::env::temp_dir().join("my_audio.wav");
        let path = save_transcript("测试文本", &src, dir.to_str().unwrap(), "txt", 3.0).unwrap();
        assert!(path.ends_with("my_audio.txt"));
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "测试文本");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
