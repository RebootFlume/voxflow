//! llama-server 子进程 + HTTP 桥接
//!
//! 架构：Tauri 主进程 → 启动 `llama-server.exe` 子进程 → HTTP/JSON 调用
//! - 崩溃隔离：子进程 crash 不会拉垮主进程
//! - 部署友好：只依赖一个 `llama-server.exe` + 模型文件，无 C++ 编译链
//! - 性能：已实测 ~92ms（2s 短句）/RTF 0.045，见 `benchmarks/BENCHMARK-RESULTS.md`
//!
//! 启动参数（已通过 benchmarks 验证，勿随意调整）：
//!   -m <model.gguf> --mmproj <mmproj.gguf> --port 8931
//!   -ngl 99 --ctx-size 8192 --parallel 1 --no-webui
//!
//! 重要：默认 ctx 大小会让 8GB 显存爆掉（→ 慢 500 倍），必须显式限制。

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Deserialize;

use super::engine::{Device, EngineKind, InferInput, InferOutput, InferenceEngine};
use super::errors::{InferenceError, InferenceResult};

/// 默认 HTTP 端口（与启动参数一致）
pub const DEFAULT_PORT: u16 = 8931;
/// 默认健康检查路径
pub const HEALTH_PATH: &str = "/health";
/// 默认转写 API 路径（OpenAI 兼容）
pub const TRANSCRIBE_PATH: &str = "/v1/audio/transcriptions";
/// 启动后等待就绪的最长时间
pub const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// 健康检查轮询间隔
pub const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 启动参数配置
#[derive(Debug, Clone)]
pub struct LlamaServerConfig {
    /// llama-server 可执行文件路径（绝对或相对于工作目录）
    pub server_path: PathBuf,
    /// GGUF 主模型路径
    pub model_path: PathBuf,
    /// mmproj 视觉/音频投影模型路径（Qwen3-ASR 必须）
    pub mmproj_path: PathBuf,
    /// 监听端口
    pub port: u16,
    /// GPU 层卸载数量（99 = 全部卸载到 GPU）
    pub n_gpu_layers: i32,
    /// 上下文窗口大小（必须显式限制，否则小显存会爆）
    pub ctx_size: u32,
    /// 并行槽数（输入法场景必须 = 1）
    pub parallel: u32,
    /// 是否禁用 web UI
    pub no_webui: bool,
}

impl Default for LlamaServerConfig {
    fn default() -> Self {
        // 架构：模型与推理框架分离
        //   - 推理框架（llama-server.exe + CUDA/ggml DLL）→ libs/llama-cpp
        //   - 模型文件（GGUF + mmproj）→ models/qwen3-asr-0.6b-gguf
        // 环境变量 LLAMA_CPP_DIR / VOXFLOW_MODEL_ROOT / VOXFLOW_LIBS_DIR 可覆盖
        let (runtime, model) = llama_paths();
        Self {
            server_path: runtime.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" }),
            model_path: model.join("Qwen3-ASR-0.6B-Q8_0.gguf"),
            mmproj_path: model.join("mmproj-Qwen3-ASR-0.6B-Q8_0.gguf"),
            port: DEFAULT_PORT,
            n_gpu_layers: 99,
            ctx_size: 8192,
            parallel: 1,
            no_webui: true,
        }
    }
}

/// 定位 llama-cpp 推理框架目录 + 模型目录（分离架构）
/// 返回 (运行时目录, 模型目录)
fn llama_paths() -> (PathBuf, PathBuf) {
    let proj = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    // 运行时目录优先级：
    //   1. 环境变量 LLAMA_CPP_DIR（指向含 llama-server.exe 的目录）
    //   2. 项目 libs/llama-cpp
    //   3. 项目 libs（旧布局：llama-server.exe 直接放 libs/）
    let runtime_candidates = vec![
        std::env::var("LLAMA_CPP_DIR").ok().map(PathBuf::from),
        Some(proj.join("libs/llama-cpp")),
        Some(proj.join("libs")),
    ];
    let runtime = runtime_candidates
        .into_iter()
        .flatten()
        .find(|d| {
            d.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" })
                .exists()
        })
        .unwrap_or_else(|| proj.join("libs/llama-cpp"));

    // 模型目录优先级（GGUF + mmproj 必须同时存在）:
    //   1. 环境变量 VOXFLOW_MODEL_ROOT/<模型目录>
    //   2. modelRoot/qwen3-asr-0.6b-gguf（统一数据根，与 model_manager 一致）
    //   3. modelRoot/Qwen3-ASR-0.6B（旧目录名兼容）
    let model_root = crate::model_manager::get_model_root();
    let model = std::env::var("VOXFLOW_MODEL_ROOT")
        .ok()
        .map(|r| PathBuf::from(r).join("qwen3-asr-0.6b-gguf"))
        .filter(|d| d.join("Qwen3-ASR-0.6B-Q8_0.gguf").exists())
        .or_else(|| {
            let d = model_root.join("qwen3-asr-0.6b-gguf");
            (d.join("Qwen3-ASR-0.6B-Q8_0.gguf").exists()).then_some(d)
        })
        .or_else(|| {
            let d = model_root.join("Qwen3-ASR-0.6B");
            (d.join("Qwen3-ASR-0.6B-Q8_0.gguf").exists()).then_some(d)
        })
        .unwrap_or_else(|| model_root.join("qwen3-asr-0.6b-gguf"));
    if !model.join("Qwen3-ASR-0.6B-Q8_0.gguf").exists() {
        // 回退：模型和运行时同目录（旧布局 / benchmarks）
        let legacy = runtime.join("Qwen3-ASR-0.6B-Q8_0.gguf");
        if legacy.exists() {
            return (runtime.clone(), runtime);
        }
    }
    (runtime, model)
}

impl LlamaServerConfig {
    /// 健康检查 URL
    pub fn health_url(&self) -> String {
        format!("http://127.0.0.1:{}{}", self.port, HEALTH_PATH)
    }
    /// 转写 API URL
    pub fn transcribe_url(&self) -> String {
        format!("http://127.0.0.1:{}{}", self.port, TRANSCRIBE_PATH)
    }
}

/// llama-server 子进程 + HTTP 客户端封装
///
/// 内部状态：
/// - `child` Mutex 持有子进程句柄
/// - `client` reqwest HTTP 客户端（多线程复用）
/// - 启动后常驻，每次 `infer` 不重启
pub struct LlamaServerEngine {
    config: LlamaServerConfig,
    child: Mutex<Option<Child>>,
    /// 单线程 HTTP 客户端（Tauri 主线程同步调用）
    client: reqwest::blocking::Client,
}

impl LlamaServerEngine {
    /// 创建新实例（不自动启动子进程，调用 `load` 时启动）
    pub fn new() -> Self {
        Self::with_config(LlamaServerConfig::default())
    }

    pub fn with_config(config: LlamaServerConfig) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .expect("reqwest client build");
        Self {
            config,
            child: Mutex::new(None),
            client,
        }
    }

    /// 检查 8931 端口的 llama-server 是否已经在跑（外部启动场景）
    fn is_external_running(&self) -> bool {
        if let Ok(resp) = self.client.get(self.config.health_url()).send() {
            return resp.status().is_success();
        }
        false
    }

    /// 启动子进程 + 等待健康检查通过
    pub fn load(&self) -> InferenceResult<()> {
        // 0. 已加载就直接返回
        if self.is_loaded() {
            return Ok(());
        }
        // 1. 如果外部已启动，直接接管
        if self.is_external_running() {
            log::info!("[llama-server] 检测到已在运行，直接接管");
            return Ok(());
        }

        // 2. 检查可执行文件
        if !self.config.server_path.exists() {
            return Err(InferenceError::LoadFailed(format!(
                "llama-server 可执行文件不存在: {}",
                self.config.server_path.display()
            )));
        }
        if !self.config.model_path.exists() {
            return Err(InferenceError::LoadFailed(format!(
                "模型文件不存在: {}",
                self.config.model_path.display()
            )));
        }
        if !self.config.mmproj_path.exists() {
            return Err(InferenceError::LoadFailed(format!(
                "mmproj 文件不存在: {}",
                self.config.mmproj_path.display()
            )));
        }

        // 3. 启动子进程
        log::info!(
            "[llama-server] 启动子进程: {} -m {} --mmproj {} --port {} -ngl {} --ctx-size {} --parallel {}",
            self.config.server_path.display(),
            self.config.model_path.display(),
            self.config.mmproj_path.display(),
            self.config.port,
            self.config.n_gpu_layers,
            self.config.ctx_size,
            self.config.parallel,
        );

        let mut cmd = Command::new(&self.config.server_path);
        cmd.arg("-m").arg(&self.config.model_path);
        cmd.arg("--mmproj").arg(&self.config.mmproj_path);
        cmd.arg("--port").arg(self.config.port.to_string());
        cmd.arg("-ngl").arg(self.config.n_gpu_layers.to_string());
        cmd.arg("--ctx-size").arg(self.config.ctx_size.to_string());
        cmd.arg("--parallel").arg(self.config.parallel.to_string());
        if self.config.no_webui {
            cmd.arg("--no-webui");
        }
        // 隐藏子进程控制台窗口（仅 Windows）
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        // 不继承 stdio，否则子进程会接管 Tauri 控制台
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = cmd.spawn().map_err(|e| {
            InferenceError::LoadFailed(format!("spawn llama-server 失败: {e}"))
        })?;

        *self.child.lock() = Some(child);

        // 4. 等待健康检查
        let start = std::time::Instant::now();
        while start.elapsed() < READY_TIMEOUT {
            if self.is_external_running() {
                log::info!(
                    "[llama-server] 就绪，耗时 {}ms",
                    start.elapsed().as_millis()
                );
                return Ok(());
            }
            // 检查子进程是否提前退出
            if let Some(c) = self.child.lock().as_mut() {
                if let Ok(Some(_)) = c.try_wait() {
                    *self.child.lock() = None;
                    return Err(InferenceError::LoadFailed(
                        "llama-server 启动后立即退出，请检查模型路径和 GPU".to_string(),
                    ));
                }
            }
            std::thread::sleep(POLL_INTERVAL);
        }

        // 超时：清理
        if let Some(mut c) = self.child.lock().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        Err(InferenceError::LoadFailed(format!(
            "llama-server 启动超时（{}s）",
            READY_TIMEOUT.as_secs()
        )))
    }

    /// 停止子进程
    pub fn unload(&self) -> InferenceResult<()> {
        if let Some(mut c) = self.child.lock().take() {
            log::info!("[llama-server] 停止子进程 PID={:?}", c.id());
            let _ = c.kill();
            let _ = c.wait();
        }
        Ok(())
    }

    /// 子进程是否在运行
    pub fn is_loaded(&self) -> bool {
        // 优先查 HTTP 端口（外部已启动的 llama-server 也算已加载）
        if self.is_external_running() {
            return true;
        }
        // 兜底：查子进程句柄（id > 0 表示有效）
        if let Some(c) = self.child.lock().as_mut() {
            if c.id() > 0 {
                // 确认子进程没有退出
                if let Ok(Some(_)) = c.try_wait() {
                    return false;
                }
                return true;
            }
        }
        false
    }

    /// 转写一段音频
    /// - `samples`: 16kHz 单声道 float32 PCM
    /// - `sample_rate`: 通常 16000
    /// - 返回识别文本
    pub fn transcribe(&self, samples: &[f32], sample_rate: u32) -> InferenceResult<String> {
        if !self.is_loaded() {
            return Err(InferenceError::NotInitialized);
        }

        // 1. float32 → 原始 WAV 字节（multipart 直接发二进制，不是 base64）
        let wav_bytes = encode_pcm_to_wav(samples, sample_rate)
            .map_err(|e| InferenceError::InferenceFailed(format!("编码 WAV 失败: {e}")))?;

        // 2. 构造 multipart 表单（与 curl -F file=@xxx.wav 等价）
        let form = reqwest::blocking::multipart::Form::new()
            .text("response_format", "json")
            .part(
                "file",
                reqwest::blocking::multipart::Part::bytes(wav_bytes)
                    .file_name("audio.wav")
                    .mime_str("audio/wav")
                    .map_err(|e| InferenceError::InferenceFailed(e.to_string()))?,
            );

        // 3. 发送请求
        let resp = self
            .client
            .post(self.config.transcribe_url())
            .multipart(form)
            .send()
            .map_err(|e| InferenceError::InferenceFailed(format!("HTTP 失败: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(InferenceError::InferenceFailed(format!(
                "llama-server 返回 {status}: {body}"
            )));
        }

        // 4. 解析响应
        let body: TranscribeResponse = resp
            .json()
            .map_err(|e| InferenceError::InferenceFailed(format!("解析响应失败: {e}")))?;

        // llama-server 响应里可能包含 language Chinese<asr_text>xxx 这种前缀
        // 提取 <asr_text> 之后的内容
        Ok(extract_asr_text(&body.text))
    }
}

impl Default for LlamaServerEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for LlamaServerEngine {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.lock().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

// ─── InferenceEngine trait 实现 ──────────────────────────────────────────────

impl InferenceEngine for LlamaServerEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::LlamaServer
    }

    fn load(&mut self, _model_path: &Path, _device: Device) -> InferenceResult<()> {
        // 配置已在 new() 时固定，_model_path 参数忽略
        LlamaServerEngine::load(self)
    }

    fn unload(&mut self) -> InferenceResult<()> {
        LlamaServerEngine::unload(self)
    }

    fn is_loaded(&self) -> bool {
        LlamaServerEngine::is_loaded(self)
    }

    fn model_name(&self) -> Option<&str> {
        Some("Qwen3-ASR-0.6B-Q8_0 (via llama-server)")
    }

    fn device(&self) -> Device {
        if self.config.n_gpu_layers > 0 {
            Device::Cuda(0)
        } else {
            Device::Cpu
        }
    }

    fn infer(&mut self, input: &InferInput) -> InferenceResult<InferOutput> {
        match input {
            InferInput::Audio { samples, sample_rate } => {
                let text = self.transcribe(samples, *sample_rate)?;
                Ok(InferOutput::Transcript {
                    text,
                    language: Some("zh".to_string()),
                })
            }
            InferInput::Text(_) => Err(InferenceError::InvalidInput(
                "LlamaServerEngine 仅支持 Audio 输入".to_string(),
            )),
        }
    }
}

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

/// llama-server 转写响应（OpenAI 兼容）
#[derive(Debug, Deserialize)]
struct TranscribeResponse {
    text: String,
}

/// 把 samples 编码为原始 WAV 字节（multipart 直接发送二进制）
fn encode_pcm_to_wav(samples: &[f32], sample_rate: u32) -> anyhow::Result<Vec<u8>> {
    use hound::{SampleFormat, WavSpec, WavWriter};
    use std::io::Cursor;

    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut buf = Cursor::new(Vec::<u8>::new());
    {
        let mut w = WavWriter::new(&mut buf, spec)?;
        for &s in samples {
            // 限幅 + 量化
            let s = s.clamp(-1.0, 1.0);
            let v = (s * i16::MAX as f32) as i16;
            w.write_sample(v)?;
        }
        w.finalize()?;
    }
    Ok(buf.into_inner())
}

/// 从 llama-server 输出中提取纯文本
/// 输入示例：`"language Chinese<asr_text>今天下午三点开会。"` 或 `"今天下午三点开会。"`
fn extract_asr_text(raw: &str) -> String {
    if let Some(start) = raw.find("<asr_text>") {
        let after = &raw[start + "<asr_text>".len()..];
        // 截到 < 或字符串末尾
        if let Some(end) = after.find('<') {
            return after[..end].trim().to_string();
        }
        return after.trim().to_string();
    }
    // 去掉 "language Chinese" 前缀
    if let Some(pos) = raw.find("language ") {
        // 找第一个 "Chinese" 或 "English" 之后
        if let Some(rest_pos) = raw[pos + 9..].find(|c: char| !c.is_ascii_alphabetic()) {
            return raw[pos + 9 + rest_pos..].trim().to_string();
        }
    }
    raw.trim().to_string()
}

// ─── 全局单例（Tauri State 共享）────────────────────────────────────────────

use std::sync::OnceLock;

/// 全局 llama-server 引擎（仅在需要时初始化）
static LLAMA_ENGINE: OnceLock<Arc<LlamaServerEngine>> = OnceLock::new();

/// 获取全局引擎（懒加载）
pub fn global_engine() -> Arc<LlamaServerEngine> {
    LLAMA_ENGINE
        .get_or_init(|| Arc::new(LlamaServerEngine::new()))
        .clone()
}

/// 用自定义配置初始化（仅第一次有效）
pub fn init_global(config: LlamaServerConfig) -> Arc<LlamaServerEngine> {
    if let Some(e) = LLAMA_ENGINE.get() {
        return e.clone();
    }
    let _ = LLAMA_ENGINE.set(Arc::new(LlamaServerEngine::with_config(config)));
    global_engine()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_asr_text() {
        assert_eq!(
            extract_asr_text("language Chinese<asr_text>今天下午三点开会。"),
            "今天下午三点开会。"
        );
        assert_eq!(extract_asr_text("language English<asr_text>Hello world"), "Hello world");
        assert_eq!(extract_asr_text("纯文本"), "纯文本");
    }

    #[test]
    fn test_encode_wav() {
        let samples = vec![0.0_f32; 1600];
        let wav = encode_pcm_to_wav(&samples, 16000).unwrap();
        assert!(!wav.is_empty());
        // WAV 文件头是 "RIFF"
        assert_eq!(&wav[0..4], b"RIFF");
    }

    #[test]
    fn test_config_default_paths() {
        let cfg = LlamaServerConfig::default();
        assert!(cfg.port == DEFAULT_PORT);
        assert!(cfg.ctx_size == 8192);
        assert!(cfg.parallel == 1);
        // 分离架构：运行时在 libs/llama-cpp，模型在 models/qwen3-asr-0.6b-gguf
        // 这些路径在开发机存在（随项目落地），但 CI/其它机器可能没有，故用存在性宽松断言
        eprintln!("[test] server_path={}", cfg.server_path.display());
        eprintln!("[test] model_path={}", cfg.model_path.display());
        eprintln!("[test] mmproj_path={}", cfg.mmproj_path.display());
    }

    #[test]
    fn test_llama_paths_separated() {
        let (runtime, model) = llama_paths();
        eprintln!("[test] runtime={}", runtime.display());
        eprintln!("[test] model={}", model.display());
        // 开发环境下：runtime 应在 libs/llama-cpp，model 应在 models/qwen3-asr-0.6b-gguf
        let runtime_str = runtime.display().to_string().replace('\\', "/");
        let model_str = model.display().to_string().replace('\\', "/");
        assert!(runtime_str.contains("libs/llama-cpp"), "runtime 应在 libs/llama-cpp，实际: {runtime_str}");
        assert!(model_str.contains("models/qwen3-asr-0.6b-gguf"), "model 应在 models/qwen3-asr-0.6b-gguf，实际: {model_str}");
    }
}
