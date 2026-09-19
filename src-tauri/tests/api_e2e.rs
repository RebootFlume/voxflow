//! 全流程 e2e（应用对外 HTTP API 面，TTS 侧）
//!
//! 串起完整链路：HTTP 请求 → api_server → TtsRegistry → 描述符路由 → 引擎子进程 → WAV 响应。
//! 覆盖点：未加载报错、registry 路由、真实采样率落盘（WAV 头 = 引擎返回值）。
//!
//! 前置：Kokoro-v1_0 已下载 + sherpa-onnx 运行时可用。
//! 运行：cargo test --test api_e2e -- --ignored --nocapture

use std::sync::Arc;

use parking_lot::Mutex;

fn models_root() -> std::path::PathBuf {
    voxflow_lib::model_manager::get_model_root()
}

/// WAV 头采样率（offset 24，小端）
fn wav_sample_rate(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]])
}

/// HTTP POST（reqwest 处理 chunked / content-length）
fn http_post(port: u16, path: &str, content_type: &str, body: &[u8]) -> (u16, Vec<u8>) {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .expect("client");
    let resp = client
        .post(format!("http://127.0.0.1:{port}{path}"))
        .header("Content-Type", content_type)
        .body(body.to_vec())
        .send()
        .expect("request");
    let status = resp.status().as_u16();
    let bytes = resp.bytes().expect("body").to_vec();
    (status, bytes)
}

#[test]
#[ignore = "needs models + runtime; run with --ignored"]
fn test_api_tts_full_flow() {
    // 动态选空闲端口（避免上个测试/残留进程占用固定端口导致 10048）
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind free port");
        l.local_addr().expect("addr").port()
    };
    eprintln!("[api] using port {port}");

    // 1. 起 API 服务（TTS 注册表注入，与 main.rs 同构）
    let tts = Arc::new(Mutex::new(voxflow_lib::tts::registry::TtsRegistry::new()));
    voxflow_lib::api_server::start(voxflow_lib::api_server::ApiConfig {
        host: "127.0.0.1".to_string(),
        port,
        api_key: String::new(),
        tts: tts.clone(),
    })
    .expect("API 服务启动失败");
    // 等待监听就绪
    for _ in 0..50 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    // 2. TTS：未加载模型 → 明确报错（不 panic）
    let (status, body) = http_post(
        port,
        "/v1/audio/speech",
        "application/json",
        r#"{"input":"你好","voice":"45"}"#.as_bytes(),
    );
    assert_eq!(status, 500, "未加载模型应 500，body={}", String::from_utf8_lossy(&body));

    // 3. TTS：加载 Kokoro → 合成 → 校验 WAV 头采样率 = 引擎真实采样率
    if !models_root().join("kokoro-multi-lang-v1_0").exists() {
        eprintln!("[skip] Kokoro 未下载");
        return;
    }
    let (_fw, name) = tts.lock().load("Kokoro-v1_0", "cpu").expect("TTS 加载失败");
    eprintln!("[tts] loaded {name}");
    let expect_rate = {
        let guard = tts.lock();
        guard
            .active()
            .unwrap()
            .synthesize("测试", "45")
            .expect("直接合成失败")
            .sample_rate
    };
    let (status, wav) = http_post(
        port,
        "/v1/audio/speech",
        "application/json",
        r#"{"input":"今天下午三点开会","voice":"45"}"#.as_bytes(),
    );
    assert_eq!(status, 200, "合成应 200，body={}", String::from_utf8_lossy(&wav));
    assert_eq!(&wav[0..4], b"RIFF", "应返回 WAV");
    assert_eq!(wav_sample_rate(&wav), expect_rate, "WAV 头采样率应与引擎一致");
    eprintln!("[tts] API WAV {} bytes @ {}Hz", wav.len(), wav_sample_rate(&wav));

    // 注：ASR 的 /v1/audio/transcriptions 路径本次重构未改动（api_server 仅 TTS 侧
    // 改为 registry + 真实采样率），其覆盖由引擎级冒烟承担（见 llama_server_integration）。

    // 4. 收尾
    tts.lock().unload().ok();
}
