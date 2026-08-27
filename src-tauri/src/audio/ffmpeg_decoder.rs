//! FFmpeg 子进程音频解码（多格式：mp3/flac/ogg/m4a/webm/mp4 等）
//!
//! 设计原则：
//! - **子进程隔离**：ffmpeg 崩溃不影响主进程（符合项目「崩溃隔离」原则）
//! - **可插拔**：作为 `audio::decoder` 的 ffmpeg 解码器，WAV 走 hound 快速路径，
//!   其他格式回退到 ffmpeg
//! - 输出：16kHz 单声道 float32（与 `decode_audio` 契约一致）
//!
//! ffmpeg 子进程：`ffmpeg -i <input> -f s16le -ac 1 -ar 16000 pipe:1`
//! （输出裸 PCM，不经过 WAV 头，避免 ffmpeg 的 LIST 块干扰 hound 解析）

use std::io::Read;
use std::process::{Command, Stdio};

/// 检测 ffmpeg 是否可用（PATH 或常见安装位置）
pub fn ffmpeg_available() -> bool {
    let mut cmd = Command::new("ffmpeg");
    crate::process_hidden::hide_console_window(&mut cmd);
    cmd.arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 用 ffmpeg 解码音频文件为 16kHz 单声道 float32。
///
/// 内部：ffmpeg 输出裸 PCM（s16le）到 stdout → 收集字节 → 转 float32。
/// 返回 (samples, 16000)
pub fn decode_with_ffmpeg(path: &std::path::Path) -> Result<(Vec<f32>, u32), String> {
    let mut cmd = Command::new("ffmpeg");
    crate::process_hidden::hide_console_window(&mut cmd);
    let mut child = cmd
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-f", "s16le", "-ac", "1", "-ar", "16000", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg 启动失败: {e}"))?;

    // 收集 stdout（PCM 字节）
    let mut pcm_bytes: Vec<u8> = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        out.read_to_end(&mut pcm_bytes)
            .map_err(|e| format!("ffmpeg 读取输出失败: {e}"))?;
    }

    // 等进程结束，检查 stderr（解码错误信息）
    let status = child
        .wait()
        .map_err(|e| format!("ffmpeg 等待失败: {e}"))?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            e.read_to_string(&mut err).ok();
        }
        return Err(format!(
            "ffmpeg 解码失败: {}",
            err.trim().lines().last().unwrap_or("未知错误")
        ));
    }

    // 裸 PCM s16le → float32
    if pcm_bytes.is_empty() {
        return Err("ffmpeg 输出为空（音频可能损坏或无声音）".into());
    }
    if pcm_bytes.len() % 2 != 0 {
        // 容错：截断到偶数长度
        pcm_bytes.truncate(pcm_bytes.len() - pcm_bytes.len() % 2);
    }
    let samples: Vec<f32> = pcm_bytes
        .chunks_exact(2)
        .map(|b| {
            let v = i16::from_le_bytes([b[0], b[1]]);
            v as f32 / 32768.0
        })
        .collect();

    Ok((samples, 16_000))
}
