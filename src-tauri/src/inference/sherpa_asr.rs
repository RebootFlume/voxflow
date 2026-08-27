//! sherpa-onnx ASR 引擎（离线 websocket server 常驻）
//!
//! 架构：子进程 `sherpa-onnx-offline-websocket-server.exe` 常驻 + WebSocket 二进制帧转写。
//! - 崩溃隔离：推理在独立子进程，崩溃不影响 Tauri
//! - 协议（sherpa offline websocket server）：
//!   1. 二进制帧：前 8 字节（int32 sample_rate + int32 byte_size）+ float32 PCM
//!   2. 文本帧 "Done"：结束标记，服务器转写后回文本帧（JSON）
//! - 模型：SenseVoice（--sense-voice-model） / Paraformer（--paraformer）均支持

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tungstenite::Message;

use crate::model_manager::{ModelFormat, find_model_info};

/// websocket server 可执行文件名
const SHERPA_WS_EXE: &str = "sherpa-onnx-offline-websocket-server.exe";
/// 默认端口（可被占用则自动探测）
const DEFAULT_PORT: u16 = 9002;

/// sherpa ASR 引擎状态
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SherpaState {
    Uninitialized,
    Loading,
    Ready,
    Error(String),
}

struct Inner {
    child: Option<Child>,
    port: u16,
    model: String,
    state: SherpaState,
    model_dir: PathBuf,
}

pub struct SherpaAsrEngine {
    inner: Mutex<Inner>,
}

impl Default for SherpaAsrEngine {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                child: None,
                port: DEFAULT_PORT,
                model: String::new(),
                state: SherpaState::Uninitialized,
                model_dir: PathBuf::new(),
            }),
        }
    }
}

impl SherpaAsrEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> SherpaState {
        self.inner.lock().state.clone()
    }

    pub fn model(&self) -> String {
        self.inner.lock().model.clone()
    }

    /// 定位 websocket server 可执行文件
    fn server_exe() -> PathBuf {
        // 运行时目录：环境变量 → exe 同级 libs（打包后）→ 项目 libs（开发时）
        crate::inference::runtime_paths::sherpa_runtime_dir().join(SHERPA_WS_EXE)
    }

    fn server_exe_exists() -> bool {
        Self::server_exe().exists()
    }

    /// 加载模型：启动 websocket server 子进程
    /// `device`: "cuda" → --provider=cuda；"cpu" → --provider=cpu
    pub fn load(&self, model_name: &str, device: &str) -> Result<(), String> {
        let mut inner = self.inner.lock();
        if inner.state == SherpaState::Ready && inner.model == model_name {
            return Ok(()); // 幂等：已加载同一模型
        }
        // 先停旧进程
        self.unload_locked(&mut inner);

        let info = find_model_info(model_name)
            .ok_or_else(|| format!("unknown model: {model_name}"))?;
        if info.format() != &ModelFormat::Onnx {
            return Err(format!("{model_name} 不是 sherpa 模型"));
        }
        let model_dir = crate::model_manager::model_dir(model_name);
        if !model_dir.exists() {
            return Err(format!("模型 {model_name} 目录不存在: {}", model_dir.display()));
        }
        // 找主 onnx 文件 + tokens.txt
        let main_file = crate::model_manager::find_main_model_file(&model_dir, &ModelFormat::Onnx)
            .ok_or_else(|| format!("模型 {model_name} 缺少 ONNX 文件"))?;
        let tokens = model_dir.join("tokens.txt");
        if !tokens.exists() {
            return Err(format!("模型 {model_name} 缺少 tokens.txt"));
        }

        let exe = Self::server_exe();
        if !exe.exists() {
            return Err(format!("sherpa server 未找到: {}", exe.display()));
        }

        // 参数：SenseVoice 用 --sense-voice-model，Paraformer 用 --paraformer
        let is_sense_voice = model_name.contains("SenseVoice") || main_file.to_string_lossy().contains("sense-voice");
        let mut cmd = Command::new(&exe);
        if is_sense_voice {
            cmd.arg(format!("--sense-voice-model={}", main_file.display()));
        } else {
            cmd.arg(format!("--paraformer={}", main_file.display()));
        }
        cmd.arg(format!("--tokens={}", tokens.display()))
            // 设备生效：cpu → --provider=cpu；其他（cuda 等）→ --provider=cuda
            .arg(match device.to_ascii_lowercase().trim() {
                "cpu" => "--provider=cpu",
                _ => "--provider=cuda",
            })
            .arg("--port=9002")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // 隐藏子进程控制台窗口（避免黑窗口闪过）
        crate::process_hidden::hide_console_window(&mut cmd);

        inner.state = SherpaState::Loading;
        drop(inner);
        let child = cmd.spawn().map_err(|e| format!("sherpa server 启动失败: {e}"))?;
        let mut inner = self.inner.lock();
        inner.child = Some(child);
        inner.port = DEFAULT_PORT;
        inner.model = model_name.to_string();
        inner.model_dir = model_dir;

        // 等待端口就绪（最多 30s）
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if TcpStream::connect(("127.0.0.1", inner.port)).is_ok() {
                inner.state = SherpaState::Ready;
                return Ok(());
            }
            if Instant::now() > deadline {
                inner.state = SherpaState::Error("sherpa server 启动超时".into());
                return Err("sherpa server 启动超时（30s）".into());
            }
            // 检查子进程是否已退出
            if let Some(child) = inner.child.as_mut() {
                if let Ok(Some(_)) = child.try_wait() {
                    inner.state = SherpaState::Error("sherpa server 进程退出".into());
                    return Err("sherpa server 进程提前退出".into());
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    fn unload_locked(&self, inner: &mut Inner) {
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        inner.model = String::new();
        inner.state = SherpaState::Uninitialized;
    }

    /// 卸载：杀进程
    pub fn unload(&self) {
        let mut inner = self.inner.lock();
        self.unload_locked(&mut inner);
    }

    /// 转写：samples 是 16k float32 单声道 PCM
    pub fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String> {
        let inner = self.inner.lock();
        if inner.state != SherpaState::Ready {
            return Err("sherpa ASR 未加载".into());
        }
        let port = inner.port;
        drop(inner);

        // 连接 websocket
        let url = format!("ws://127.0.0.1:{port}/asr");
        let (mut ws, _) = tungstenite::connect(&url)
            .map_err(|e| format!("websocket 连接失败: {e}"))?;

        // 构建二进制帧：int32 sample_rate + int32 byte_size + float32 samples
        let mut payload = Vec::with_capacity(8 + samples.len() * 4);
        payload.extend_from_slice(&sample_rate.to_le_bytes());
        payload.extend_from_slice(&(samples.len() as u32 * 4).to_le_bytes());
        for s in samples {
            payload.extend_from_slice(&s.to_le_bytes());
        }
        ws.send(Message::Binary(payload))
            .map_err(|e| format!("发送音频失败: {e}"))?;

        // 等结果（服务器解码完会回文本帧）
        let result = loop {
            match ws.read() {
                Ok(Message::Text(t)) => {
                    // 收到结果后发 Done 收尾
                    let _ = ws.send(Message::Text("Done".into()));
                    let _ = ws.close(None);
                    break t;
                }
                Ok(Message::Binary(b)) => {
                    // 不应出现，跳过
                    eprintln!("[sherpa-asr] unexpected binary: {} bytes", b.len());
                    continue;
                }
                Ok(_) => continue,
                Err(e) => return Err(format!("websocket 读取失败: {e}")),
            }
        };

        // 解析 JSON，提取 text
        parse_result(&result)
    }
}

/// 解析 sherpa 返回的 JSON，提取 text 字段
fn parse_result(raw: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| format!("转写结果解析失败: {e}"))?;
    let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err("转写结果为空".into());
    }
    Ok(text)
}

/// 全局单例
pub fn global_engine() -> Arc<SherpaAsrEngine> {
    static ENGINE: once_cell::sync::Lazy<Arc<SherpaAsrEngine>> =
        once_cell::sync::Lazy::new(|| Arc::new(SherpaAsrEngine::new()));
    ENGINE.clone()
}

// ─── AsrEngine trait 适配器（注册到 registry）───────────────────────────────

/// sherpa-onnx 的 AsrEngine 适配：包装现有全局单例，供 registry 统一路由。
/// 与 LlamaAsrAdapter 同模式：新增 PyTorch 引擎时照此写 adapter。
pub struct SherpaAsrAdapter {
    engine: Arc<SherpaAsrEngine>,
}

impl SherpaAsrAdapter {
    pub fn new() -> Self {
        Self {
            engine: global_engine(),
        }
    }
}

impl Default for SherpaAsrAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl super::engine::AsrEngine for SherpaAsrAdapter {
    fn framework(&self) -> &'static str {
        "onnx"
    }

    fn load_model(&self, name: &str) -> Result<(), String> {
        self.engine.load(name, "cuda")
    }

    fn load_model_with_device(&self, name: &str, device: &str) -> Result<(), String> {
        self.engine.load(name, device)
    }

    fn unload(&self) -> Result<(), String> {
        self.engine.unload();
        Ok(())
    }

    fn is_loaded(&self) -> bool {
        matches!(
            self.engine.state(),
            crate::inference::sherpa_asr::SherpaState::Ready
        )
    }

    fn current_model(&self) -> String {
        self.engine.model()
    }

    fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String> {
        self.engine.transcribe(samples, sample_rate)
    }

    fn vram_estimate_mb(&self) -> Option<u64> {
        let model = self.engine.model();
        if model.is_empty() {
            return None;
        }
        let dir = crate::model_manager::model_dir(&model);
        let mut total: u64 = 0;
        fn walk(d: &std::path::Path, total: &mut u64) {
            if let Ok(rd) = std::fs::read_dir(d) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        walk(&p, total);
                    } else if let Ok(md) = e.metadata() {
                        *total += md.len();
                    }
                }
            }
        }
        walk(&dir, &mut total);
        if total > 0 {
            Some(total / (1024 * 1024))
        } else {
            None
        }
    }
}

// ── 测试 ──

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_server_exe_located() {
        // 验证解析逻辑：路径应指向 exe 旁 libs\sherpa-onnx
        // （不再断言文件存在——开发环境 libs 是否复制取决于开发者，
        //   统一逻辑：libs 永远在 exe 旁）
        let dir = crate::inference::runtime_paths::sherpa_runtime_dir();
        assert!(dir.to_string_lossy().contains("sherpa-onnx"));
        assert!(!dir.as_os_str().is_empty());
    }

    #[test]
    fn test_parse_result() {
        let raw = r#"{"lang":"<|zh|>","emotion":"<|NEUTRAL|>","event":"<|Speech|>","text":"今天下午三点开会","timestamps":[0.12,0.30]}"#;
        assert_eq!(parse_result(raw).unwrap(), "今天下午三点开会");
        assert!(parse_result("not json").is_err());
    }
}
