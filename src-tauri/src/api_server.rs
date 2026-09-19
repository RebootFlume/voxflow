//! HTTP API Server（OpenAI 兼容 ASR/TTS 端点）
//!
//! 启动 `tiny_http` 监听线程，提供：
//! - `GET  /health`
//! - `POST /v1/audio/transcriptions`（ASR）
//! - `POST /v1/audio/speech`（TTS）
//!
//! 单线程串行处理（tiny_http 内部队列），与现有 `reqwest::blocking` 风格一致。

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::json;

use crate::inference::engine::AsrEngine;
use crate::tts::traits::TtsEngine;

// ─── 类型 ──────────────────────────────────────────────────────────────────

/// API 服务配置（由命令层构造，含 TTS 句柄）
#[derive(Clone)]
pub struct ApiConfig {
    pub host: String,
    pub port: u16,
    pub api_key: String,
    pub tts: Arc<Mutex<crate::tts::registry::TtsRegistry>>,
}

// ─── 单例状态 ──────────────────────────────────────────────────────────────

struct RunningServer {
    handle: std::thread::JoinHandle<()>,
    shutdown: Arc<AtomicBool>,
}

static SERVER: LazyLock<Mutex<Option<RunningServer>>> = LazyLock::new(|| Mutex::new(None));

fn server_state() -> &'static Mutex<Option<RunningServer>> {
    &*SERVER
}

// ─── 公开 API ──────────────────────────────────────────────────────────────

pub fn start(cfg: ApiConfig) -> Result<(), String> {
    let mut guard = server_state().lock();
    if guard.is_some() {
        return Err("API service already running".into());
    }

    let http_server = tiny_http::Server::http(format!("{}:{}", cfg.host, cfg.port))
        .map_err(|e| e.to_string())?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown2 = shutdown.clone();

    let handle = std::thread::Builder::new()
        .name("api-server".into())
        .spawn(move || {
            server_loop(http_server, &cfg, &shutdown2);
        })
        .map_err(|e| e.to_string())?;

    *guard = Some(RunningServer { handle, shutdown });
    Ok(())
}

pub fn stop() -> bool {
    let mut guard = server_state().lock();
    if let Some(rs) = guard.take() {
        rs.shutdown.store(true, Ordering::Relaxed);
        drop(guard);
        let _ = rs.handle.join();
        true
    } else {
        false
    }
}

pub fn is_running() -> bool {
    server_state().lock().is_some()
}

// ─── 监听线程 ──────────────────────────────────────────────────────────────

fn server_loop(server: tiny_http::Server, cfg: &ApiConfig, shutdown: &AtomicBool) {
    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match server.recv_timeout(Duration::from_millis(200)) {
            Ok(Some(request)) => {
                let cfg = cfg.clone();
                std::thread::Builder::new()
                    .name("api-req".into())
                    .spawn(move || handle_request(request, &cfg))
                    .ok();
            }
            Ok(None) => {
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
            }
            Err(_) => {
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
            }
        }
    }
}

// ─── 请求路由 ──────────────────────────────────────────────────────────────

fn handle_request(mut request: tiny_http::Request, cfg: &ApiConfig) {
    // 鉴权（在读 body 之前检查，避免不必要的 IO）
    if let Some(resp) = check_auth(&request, &cfg.api_key) {
        let _ = request.respond(resp);
        return;
    }

    let method = request.method().as_str().to_uppercase();
    let url = request.url().to_string();

    // POST 请求读取 body + 提取 Content-Type
    let mut body = Vec::new();
    let content_type = if method == "POST" {
        let ct = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("content-type"))
            .map(|h| h.value.to_string())
            .unwrap_or_default();
        let _ = request.as_reader().read_to_end(&mut body);
        ct
    } else {
        String::new()
    };

    let resp = match (method.as_str(), url.as_str()) {
        ("GET", "/health") => json_response(200, json!({"status": "ok"})),
        ("POST", "/v1/audio/transcriptions") => handle_asr(&body, &content_type),
        ("POST", "/v1/audio/speech") => handle_tts(&body, cfg),
        _ => json_response(404, error_json(404, "Not Found")),
    };

    let _ = request.respond(resp);
}

// ─── 鉴权 ──────────────────────────────────────────────────────────────────

fn check_auth(
    request: &tiny_http::Request,
    api_key: &str,
) -> Option<tiny_http::Response<Cursor<Vec<u8>>>> {
    if api_key.is_empty() {
        return None;
    }
    let ok = request.headers().iter().any(|h| {
        h.field.equiv("authorization") && h.value == format!("Bearer {api_key}")
    });
    if ok {
        None
    } else {
        Some(json_response(
            401,
            json!({
                "error": {
                    "code": 401,
                    "message": "invalid or missing API key",
                    "type": "invalid_request_error"
                }
            }),
        ))
    }
}

// ─── ASR 处理 ──────────────────────────────────────────────────────────────

fn handle_asr(body: &[u8], content_type: &str) -> tiny_http::Response<Cursor<Vec<u8>>> {
    // 1. 提取 multipart boundary
    let boundary = match parse_boundary(content_type) {
        Some(b) => b,
        None => return json_response(400, error_json(400, "missing multipart boundary")),
    };

    // 2. 解析 multipart
    let parts = match parse_multipart(body, &boundary) {
        Ok(p) => p,
        Err(e) => return json_response(400, error_json(400, &e)),
    };

    // 3. 找 file part
    let file_entry = parts.iter().find(|(name, _, _)| name == "file");
    let file_data = match file_entry.map(|(_, _, data)| data.as_slice()) {
        Some(d) if !d.is_empty() => d,
        _ => return json_response(400, error_json(400, "missing or empty 'file' field")),
    };
    let filename = file_entry
        .and_then(|(_, fn_, _)| fn_.clone())
        .unwrap_or_default();

    // 4. 解码音频
    let (samples, sample_rate) = if is_wav(file_data) {
        // WAV → 内存解码（不写临时文件）
        match crate::audio::wav::decode_audio(file_data) {
            Ok(r) => r,
            Err(e) => return json_response(500, error_json(500, &e)),
        }
    } else {
        // 非 WAV（MP3/FLAC 等）→ ffmpeg 子进程
        if !crate::audio::ffmpeg_decoder::ffmpeg_available() {
            return json_response(
                415,
                error_json(415, "unsupported format (ffmpeg not available)"),
            );
        }
        let ext = std::path::Path::new(&filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let tmp = std::env::temp_dir().join(format!("voxflow_api_upload.{ext}"));
        if std::fs::write(&tmp, file_data).is_err() {
            return json_response(500, error_json(500, "failed to write temp file"));
        }
        match crate::audio::ffmpeg_decoder::decode_with_ffmpeg(&tmp) {
            Ok(r) => r,
            Err(e) => return json_response(500, error_json(500, &e)),
        }
    };

    // 5. 空采样 → 直接返回空文本
    if samples.is_empty() {
        return json_response(200, json!({"text": ""}));
    }

    // 6. 引擎就绪：复用当前已加载引擎（任意框架）；无则按用户上次选择加载
    let engine = {
        let registry = crate::inference::registry::registry();
        match registry.active_engine() {
            Some(e) => e,
            None => {
                if let Err(e) = registry.load_requested_asr(&mut |_| {}) {
                    return json_response(
                        500,
                        error_json(500, &format!("ASR engine load failed: {e}")),
                    );
                }
                match registry.active_engine() {
                    Some(e) => e,
                    None => {
                        return json_response(
                            500,
                            error_json(500, "ASR engine load failed: no engine available"),
                        )
                    }
                }
            }
        }
    };

    // 7. 转写（长音频按 60s 分段：外部客户端可 POST 任意长度音频，
    //    一次性发送会超过 llama-server ctx 报 400；engine.transcribe 已剥前缀）
    match crate::inference::transcribe_chunks::transcribe_long(
        engine.as_ref(),
        &samples,
        sample_rate,
        &mut |_, _| {},
    ) {
        Ok(text) => json_response(200, json!({"text": text})),
        Err(e) => json_response(500, error_json(500, &format!("transcription failed: {e}"))),
    }
}

// ─── TTS 处理 ──────────────────────────────────────────────────────────────

fn handle_tts(body: &[u8], cfg: &ApiConfig) -> tiny_http::Response<Cursor<Vec<u8>>> {
    // 1. 解析 JSON body
    let payload: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return json_response(400, error_json(400, "invalid JSON")),
    };

    let input = payload
        .get("input")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if input.is_empty() {
        return json_response(400, error_json(400, "missing or empty 'input' field"));
    }

    let voice = payload
        .get("voice")
        .and_then(|v| v.as_str())
        .unwrap_or("default");

    // 2. 合成（采样率取引擎真实输出）
    // try_lock 避免与 UI 主线程 Tauri 命令争锁：忙时返回 503
    let tts = match cfg.tts.try_lock() {
        Some(g) => g,
        None => return json_response(503, error_json(503, "TTS engine busy")),
    };
    let Some(engine) = tts.active() else {
        return json_response(500, error_json(500, "TTS model not loaded"));
    };
    match engine.synthesize(input, voice) {
        Ok(audio) => {
            if audio.samples.is_empty() {
                return json_response(500, error_json(500, "TTS returned empty audio"));
            }
            // 3. 编码为 WAV（采样率与 PCM 一致）
            match wav_from_i16(&audio.samples, audio.sample_rate) {
                Ok(wav_bytes) => {
                    let len = wav_bytes.len();
                    tiny_http::Response::new(
                        tiny_http::StatusCode(200),
                        vec![tiny_http::Header::from_bytes("Content-Type", "audio/wav")
                            .unwrap()],
                        Cursor::new(wav_bytes),
                        Some(len),
                        None,
                    )
                }
                Err(e) => json_response(500, error_json(500, &e)),
            }
        }
        Err(e) => {
            json_response(500, error_json(500, &format!("TTS inference failed: {e}")))
        }
    }
}

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

fn json_response(status: u16, body: serde_json::Value) -> tiny_http::Response<Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(
            tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
        )
}

fn error_json(code: u16, message: &str) -> serde_json::Value {
    json!({
        "error": {
            "code": code,
            "message": message,
            "type": "invalid_request_error"
        }
    })
}

fn is_wav(data: &[u8]) -> bool {
    data.len() >= 4 && &data[..4] == b"RIFF"
}

/// i16 PCM → 内存 WAV（采样率由调用方传入，与 rust_synthesize 落盘一致）
fn wav_from_i16(samples: &[i16], sample_rate: u32) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: sample_rate.max(1),
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut buf = Cursor::new(Vec::<u8>::new());
    {
        let mut w =
            hound::WavWriter::new(&mut buf, spec).map_err(|e| format!("WAV encode failed: {e}"))?;
        for &s in samples {
            w.write_sample(s)
                .map_err(|e| format!("WAV write failed: {e}"))?;
        }
        w.finalize()
            .map_err(|e| format!("WAV finalize failed: {e}"))?;
    }
    Ok(buf.into_inner())
}

// ─── Multipart 解析（手写：tiny_http 无内置 multipart）──────────────────────

fn parse_boundary(content_type: &str) -> Option<String> {
    content_type.split(';').find_map(|part| {
        let part = part.trim();
        part.strip_prefix("boundary=")
            .map(|v| v.trim().to_string())
    })
}

/// 解析 `multipart/form-data` body → `Vec<(field_name, Option<filename>, data)>`
fn parse_multipart(
    body: &[u8],
    boundary: &str,
) -> Result<Vec<(String, Option<String>, Vec<u8>)>, String> {
    let start_marker = format!("--{boundary}");
    let delimiter = format!("\r\n--{boundary}");
    let end_marker = format!("\r\n--{boundary}--");

    // 去掉开头 `--boundary`
    let body = body
        .strip_prefix(start_marker.as_bytes())
        .ok_or("body does not start with boundary")?;

    // 去掉结尾 `\r\n--boundary--`
    let body = if let Some(idx) = find_subseq(body, end_marker.as_bytes()) {
        &body[..idx]
    } else {
        body
    };

    let mut result = Vec::new();
    let mut remaining = body;

    loop {
        let next = find_subseq(remaining, delimiter.as_bytes());
        let chunk = match next {
            Some(idx) => {
                let c = &remaining[..idx];
                remaining = &remaining[idx + delimiter.len()..];
                c
            }
            None => {
                let c = remaining;
                remaining = &[];
                c
            }
        };

        // 每个 chunk 以 `\r\n` 开头（part 分隔符），去掉
        let chunk = chunk.strip_prefix(b"\r\n").unwrap_or(chunk);
        if chunk.is_empty() {
            continue;
        }

        // 分离 headers 和 body：`\r\n\r\n` 为分隔符
        let sep = b"\r\n\r\n";
        let hdr_end = find_subseq(chunk, sep)
            .ok_or_else(|| "malformed multipart part: missing header/body separator".to_string())?;
        let headers = &chunk[..hdr_end];
        let mut data = &chunk[hdr_end + sep.len()..];

        // 去掉 data 末尾可能的 `\r\n`（boundary 前的换行）
        if data.ends_with(b"\r\n") {
            data = &data[..data.len() - 2];
        }

        let headers_str = std::str::from_utf8(headers).unwrap_or("");
        let name = extract_disposition_field(headers_str, "name")
            .ok_or_else(|| "missing 'name' in Content-Disposition".to_string())?;
        let filename = extract_disposition_field(headers_str, "filename");

        result.push((name, filename, data.to_vec()));
    }
}

/// 从 Content-Disposition 行提取字段值
/// 例：`Content-Disposition: form-data; name="file"; filename="test.wav"`
fn extract_disposition_field(headers: &str, field: &str) -> Option<String> {
    headers.lines().find_map(|line| {
        if !line.to_lowercase().starts_with("content-disposition") {
            return None;
        }
        let pattern = format!("{field}=");
        let idx = line.find(&pattern)?;
        let rest = &line[idx + pattern.len()..];
        if rest.starts_with('"') {
            let end = rest[1..].find('"')?;
            Some(rest[1..1 + end].to_string())
        } else {
            let end = rest.find([';', ' ']).unwrap_or(rest.len());
            Some(rest[..end].to_string())
        }
    })
}

fn find_subseq(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ─── 测试 ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::registry::TtsRegistry;

    /// 最小 ApiConfig：不调 `start()`，不监听端口（纯 handler 级测试）。
    fn test_cfg(tts: Arc<Mutex<TtsRegistry>>) -> ApiConfig {
        ApiConfig {
            host: "127.0.0.1".into(),
            port: 0,
            api_key: String::new(),
            tts,
        }
    }

    /// OpenAI 兼容 TTS 请求体（`handle_tts` 真正读取的字段：input / voice）。
    fn speech_body(input: &str, voice: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({"input": input, "voice": voice})).expect("body 序列化")
    }

    /// 状态码 + 已解析 JSON body（`handle_tts` 的 body 是内存 Cursor，可无损取出）。
    fn status_and_json(resp: tiny_http::Response<Cursor<Vec<u8>>>) -> (u16, serde_json::Value) {
        let status = resp.status_code().0;
        let cursor = resp.into_reader();
        let value = serde_json::from_slice(cursor.get_ref()).expect("响应体应为 JSON");
        (status, value)
    }

    /// §5.1 硬约束：`try_lock` 503 语义保留 —— 引擎忙（锁被持有）必须立刻 503，
    /// 既不能阻塞等待，也不能降级成 500。改回阻塞/别的状态码时此测试必须失败。
    #[test]
    fn tts_busy_returns_503() {
        let tts = Arc::new(Mutex::new(TtsRegistry::new()));
        let cfg = test_cfg(tts.clone());
        let busy = tts.lock(); // 模拟 UI 主线程正持有引擎

        let (status, body) = status_and_json(handle_tts(&speech_body("你好", "45"), &cfg));

        assert_eq!(
            status, 503,
            "引擎忙必须 503（try_lock 语义），实际 {status}，body={body}"
        );
        assert_eq!(body["error"]["code"], json!(503));
        assert_eq!(body["error"]["message"], "TTS engine busy");
        assert_eq!(body["error"]["type"], "invalid_request_error");

        drop(busy);
    }

    /// 反向断言（不得误报 503）：锁空闲时走正常路径 —— 未加载模型应 500，
    /// 而不是把「无模型」误判成「引擎忙」。无需真实模型 / 网络 / 端口。
    #[test]
    fn tts_unlocked_is_not_503() {
        let tts = Arc::new(Mutex::new(TtsRegistry::new()));
        let cfg = test_cfg(tts.clone());

        // 前置：锁确实空闲（排除 try_lock 偶发失败导致的假 503）
        assert!(tts.try_lock().is_some(), "测试前置：锁应为空闲");

        let (status, body) = status_and_json(handle_tts(&speech_body("你好", "45"), &cfg));

        assert_ne!(status, 503, "锁空闲时不应报引擎忙，body={body}");
        assert_eq!(status, 500, "未加载模型应 500，body={body}");
        assert_eq!(body["error"]["code"], json!(500));
        assert_eq!(body["error"]["message"], "TTS model not loaded");
        assert!(
            cfg.tts.try_lock().is_some(),
            "handler 返回后不应残留锁（guard 已释放）"
        );
    }
}
