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
    /// 采样温度：ASR 用 greedy（0）最准，llama-server 默认 0.8 会引入随机噪声
    pub temperature: f32,
    /// 是否禁用 web UI
    pub no_webui: bool,
    /// mmproj 投影塔是否卸载到 GPU（cuda 时 true，cpu 时 false）
    pub mmproj_offload: bool,
}

impl LlamaServerConfig {
    /// 按模型名构造配置（0.6B / 1.7B），mmproj 优先 bf16（无损编码器）
    pub fn for_model(model_prefix: &str, model_dir: &str) -> Self {
        let (runtime, model) = llama_paths_for(model_dir);
        Self {
            server_path: runtime.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" }),
            model_path: model.join(format!("{model_prefix}-Q8_0.gguf")),
            mmproj_path: pick_mmproj(&model, model_prefix),
            port: DEFAULT_PORT,
            n_gpu_layers: 99,
            ctx_size: 8192,
            parallel: 1,
            temperature: 0.0,
            no_webui: true,
            mmproj_offload: true,
        }
    }
}

impl Default for LlamaServerConfig {
    fn default() -> Self {
        // 从注册表动态解析 0.6B（默认 ASR 模型）
        llama_config_for_model("Qwen3-ASR-0.6B", "cuda")
            .unwrap_or_else(|_| llama_config_fallback())
    }
}

/// 兜底配置（解析失败时，避免构造 panic）
fn llama_config_fallback() -> LlamaServerConfig {
    let (runtime, model) = llama_paths();
    LlamaServerConfig {
        server_path: runtime.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" }),
        model_path: model.join("Qwen3-ASR-0.6B-Q8_0.gguf"),
        mmproj_path: model.join("mmproj-Qwen3-ASR-0.6B-Q8_0.gguf"),
        port: DEFAULT_PORT,
        n_gpu_layers: 99,
        ctx_size: 8192,
        parallel: 1,
        temperature: 0.0,
        no_webui: true,
        mmproj_offload: true,
    }
}

/// 选择 mmproj：优先 bf16（无损编码器，转写更准），回退 Q8_0（量化）。
/// 同一目录下可能存在多个版本的 mmproj（下载更新后旧文件残留）。
fn pick_mmproj(model_dir: &Path, model_name: &str) -> PathBuf {
    let bf16 = model_dir.join(format!("mmproj-{model_name}-bf16.gguf"));
    if bf16.exists() {
        return bf16;
    }
    model_dir.join(format!("mmproj-{model_name}-Q8_0.gguf"))
}

/// 定位 llama-cpp 推理框架目录 + 模型目录（分离架构）
/// 返回 (运行时目录, 模型目录)
fn llama_paths() -> (PathBuf, PathBuf) {
    llama_paths_for("qwen3-asr-0.6b-gguf")
}

/// 定位运行时 + 指定模型子目录（0.6B / 1.7B 通用）
fn llama_paths_for(model_subdir: &str) -> (PathBuf, PathBuf) {
    // 运行时目录：环境变量 → exe 同级 libs（打包后）→ 项目 libs（开发时）
    let runtime = crate::inference::runtime_paths::llama_runtime_dir();

    // 模型目录优先级（GGUF + mmproj 必须同时存在）:
    //   1. 环境变量 VOXFLOW_MODEL_ROOT/<模型目录>
    //   2. modelRoot/<模型目录>（统一数据根，与 model_manager 一致）
    //   3. modelRoot/<模型名>（旧目录名兼容）
    let model_root = crate::model_manager::get_model_root();
    let model_name = if model_subdir.contains("1.7") {
        "Qwen3-ASR-1.7B"
    } else {
        "Qwen3-ASR-0.6B"
    };
    let gguf = format!("{model_name}-Q8_0.gguf");
    let model = std::env::var("VOXFLOW_MODEL_ROOT")
        .ok()
        .map(|r| PathBuf::from(r).join(model_subdir))
        .filter(|d| d.join(&gguf).exists())
        .or_else(|| {
            let d = model_root.join(model_subdir);
            (d.join(&gguf).exists()).then_some(d)
        })
        .or_else(|| {
            let d = model_root.join(model_name);
            (d.join(&gguf).exists()).then_some(d)
        })
        .unwrap_or_else(|| model_root.join(model_subdir));
    if !model.join(&gguf).exists() {
        // 回退：模型和运行时同目录（旧布局 / benchmarks）
        let legacy = runtime.join(&gguf);
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
    config: Mutex<LlamaServerConfig>,
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
            config: Mutex::new(config),
            child: Mutex::new(None),
            client,
        }
    }

    /// 检查 8931 端口的 llama-server 是否已经在跑（外部启动场景）
    fn is_external_running(&self) -> bool {
        if let Ok(resp) = self.client.get(self.config.lock().health_url()).send() {
            return resp.status().is_success();
        }
        false
    }

    /// 启动子进程 + 等待健康检查通过
    pub fn load(&self) -> InferenceResult<()> {
        let cfg = self.config.lock().clone();
        self.load_with_config(cfg, &mut |_| {})
    }

    /// 用指定配置启动（支持换模型：先 unload 再调本方法）
    /// `on_stage`: 细粒度加载阶段回调（reading_model/loading_mmproj/initializing/model_loaded）
    pub fn load_with_config(
        &self,
        cfg: LlamaServerConfig,
        on_stage: &mut dyn FnMut(&str),
    ) -> InferenceResult<()> {
        // 0. 记录新配置（后续 transcribe / health 用新端口和路径）
        *self.config.lock() = cfg.clone();
        // 1. 已加载就直接返回
        if self.is_loaded() {
            return Ok(());
        }
        // 1. 如果外部已启动，直接接管
        if self.is_external_running() {
            log::info!("[llama-server] 检测到已在运行，直接接管");
            return Ok(());
        }

        // 2. 检查可执行文件
        if !cfg.server_path.exists() {
            return Err(InferenceError::LoadFailed(format!(
                "llama-server 可执行文件不存在: {}",
                cfg.server_path.display()
            )));
        }
        if !cfg.model_path.exists() {
            return Err(InferenceError::LoadFailed(format!(
                "模型文件不存在: {}",
                cfg.model_path.display()
            )));
        }
        if !cfg.mmproj_path.exists() {
            return Err(InferenceError::LoadFailed(format!(
                "mmproj 文件不存在: {}",
                cfg.mmproj_path.display()
            )));
        }

        // 3. 启动子进程
        log::info!(
            "[llama-server] 启动子进程: {} -m {} --mmproj {} --port {} -ngl {} --ctx-size {} --parallel {} --temp {}",
            cfg.server_path.display(),
            cfg.model_path.display(),
            cfg.mmproj_path.display(),
            cfg.port,
            cfg.n_gpu_layers,
            cfg.ctx_size,
            cfg.parallel,
            cfg.temperature,
        );

        let mut cmd = Command::new(&cfg.server_path);
        cmd.arg("-m").arg(&cfg.model_path);
        cmd.arg("--mmproj").arg(&cfg.mmproj_path);
        cmd.arg("--port").arg(cfg.port.to_string());
        cmd.arg("-ngl").arg(cfg.n_gpu_layers.to_string());
        cmd.arg("--ctx-size").arg(cfg.ctx_size.to_string());
        cmd.arg("--parallel").arg(cfg.parallel.to_string());
        cmd.arg("--temp").arg(cfg.temperature.to_string());
        if cfg.no_webui {
            cmd.arg("--no-webui");
        }
        // mmproj 投影塔：跟随设备配置（cuda → GPU，cpu → CPU）
        if cfg.mmproj_offload {
            cmd.arg("--mmproj-offload");
        } else {
            cmd.arg("--no-mmproj-offload");
        }
        // 隐藏子进程控制台窗口（仅 Windows）
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        // 捕获 stderr：解析 llama-server 加载日志 → 细粒度阶段（读模型/加载投影/初始化）
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            InferenceError::LoadFailed(format!("spawn llama-server 失败: {e}"))
        })?;

        // stderr 解析线程 → mpsc channel（安全：不借用 self，主线程转发）
        // 阶段码是「框架无关」的通用集合：loading / initializing / ready
        // （各框架实现可映射自己的内部日志到这些通用码，前端只认这一套）
        let (stage_tx, stage_rx) = std::sync::mpsc::channel::<String>();
        if let Some(stderr) = child.stderr.take() {
            std::thread::Builder::new()
                .name("llama-stderr-parser".into())
                .spawn(move || {
                    use std::io::BufRead;
                    let reader = std::io::BufReader::new(stderr);
                    for line in reader.lines() {
                        let Ok(line) = line else { break };
                        // llama-server 日志 → 通用阶段（框架无关）
                        if line.contains("loading model '") || line.contains("loaded multimodal model") {
                            let _ = stage_tx.send("loading".into());
                        } else if line.contains("initializing, n_slots") {
                            let _ = stage_tx.send("initializing".into());
                        } else if line.contains("model loaded") {
                            let _ = stage_tx.send("ready".into());
                        }
                    }
                })
                .ok();
        }

        *self.child.lock() = Some(child);

        // 4. 等待健康检查
        let start = std::time::Instant::now();
        while start.elapsed() < READY_TIMEOUT {
            // 转发 stderr 解析出的细粒度阶段（读模型/加载投影/初始化）
            while let Ok(stage) = stage_rx.try_recv() {
                on_stage(&stage);
            }
            if self.is_external_running() {
                log::info!(
                    "[llama-server] 就绪，耗时 {}ms",
                    start.elapsed().as_millis()
                );
                on_stage("ready");
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
            .post(self.config.lock().transcribe_url())
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

    /// 当前加载的模型文件路径（换模型后同步更新）
    pub fn current_model_path(&self) -> PathBuf {
        self.config.lock().model_path.clone()
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
        if self.config.lock().n_gpu_layers > 0 {
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

/// 按模型名加载 ASR 引擎（llama-server）。
/// 模型路径从注册表动态解析：
///   - 目录 = engine_dir.unwrap_or(name)（如 "Qwen3-ASR-1.7B" → "Qwen3-ASR-1.7B"）
///   - GGUF 主模型 = 目录内 *-Q8_0.gguf / *-bf16.gguf（按名字段匹配）
///   - mmproj = 同名 bf16（无损）优先，回退 Q8_0
/// 若当前已加载同模型且同设备则直接返回；否则先卸载旧进程再启动新模型。
pub fn load_asr_model(name: &str) -> InferenceResult<String> {
    load_asr_model_with_stage(name, "cuda", &mut |_| {})
}

/// 带阶段回调的加载：on_stage 在「卸载旧模型 / 启动进程 / 等待就绪」阶段触发，
/// 供命令层 emit 到前端展示进度。
/// `device`: "cuda"（全 GPU，n_gpu_layers=99）或 "cpu"（全 CPU，n_gpu_layers=0）
pub fn load_asr_model_with_stage(
    name: &str,
    device: &str,
    on_stage: &mut dyn FnMut(&str),
) -> InferenceResult<String> {
    let engine = global_engine();
    let cfg = llama_config_for_model(name, device)?;

    // 当前已加载同模型 → 直接返回
    if engine.is_loaded() && engine.current_model_path() == cfg.model_path {
        return Ok(engine.model_name().unwrap_or(name).to_string());
    }

    // 换模型：先卸载旧进程
    if engine.is_loaded() {
        on_stage("unload");
        let _ = engine.unload();
        on_stage("loading");
    } else {
        on_stage("loading");
    }

    engine.load_with_config(cfg, on_stage)?;
    on_stage("ready");
    Ok(engine.model_name().unwrap_or(name).to_string())
}

/// 从注册表解析模型目录 + 模型/投影文件路径（不硬编码模型名）
fn llama_config_for_model(name: &str, device: &str) -> InferenceResult<LlamaServerConfig> {
    let (runtime, _) = llama_paths_for(name);
    // 目录 = model_dir(name)（内部处理 engine_dir：如 "Qwen3-ASR-0.6B" → "qwen3-asr-0.6b-gguf"）
    let dir = crate::model_manager::model_dir(name);

    // 目录内动态找 GGUF 主模型（Q8_0 优先，bf16 次之）
    let model_path = find_gguf_in(&dir, name, "-Q8_0", false)
        .or_else(|| find_gguf_in(&dir, name, "-bf16", false))
        .ok_or_else(|| {
            InferenceError::LoadFailed(format!(
                "在 {} 未找到模型文件（{}-Q8_0.gguf）",
                dir.display(),
                name
            ))
        })?;
    // mmproj：bf16（无损）优先，回退 Q8_0
    let mmproj = find_gguf_in(&dir, name, "-bf16", true)
        .or_else(|| find_gguf_in(&dir, name, "-Q8_0", true))
        .ok_or_else(|| {
            InferenceError::LoadFailed(format!(
                "在 {} 未找到 mmproj 文件（mmproj-{}-*.gguf）",
                dir.display(),
                name
            ))
        })?;

    Ok(LlamaServerConfig {
        server_path: runtime.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" }),
        model_path,
        mmproj_path: mmproj,
        port: DEFAULT_PORT,
        // 设备生效：cpu → 全 CPU（0 层）；其他（cuda 等）→ 全 GPU（99 层）
        n_gpu_layers: match device.to_ascii_lowercase().trim() {
            "cpu" => 0,
            _ => 99,
        },
        ctx_size: 8192,
        parallel: 1,
        temperature: 0.0,
        no_webui: true,
        mmproj_offload: device.to_ascii_lowercase().trim() != "cpu",
    })
}

/// 在目录内找匹配的 GGUF 文件。
/// - is_mmproj=true：找 mmproj-{name}{quant}.gguf
/// - is_mmproj=false：找 {name}{quant}.gguf（非 mmproj- 前缀）
fn find_gguf_in(dir: &Path, name: &str, quant: &str, is_mmproj: bool) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let want = format!("{name}{quant}.gguf");
    let want_mm = format!("mmproj-{name}{quant}.gguf");
    for e in entries.flatten() {
        let fname = e.file_name().to_string_lossy().to_string();
        if is_mmproj && fname == want_mm {
            return Some(e.path());
        }
        if !is_mmproj && !fname.starts_with("mmproj-") && fname == want {
            return Some(e.path());
        }
    }
    None
}

/// 用自定义配置初始化（仅第一次有效）
pub fn init_global(config: LlamaServerConfig) -> Arc<LlamaServerEngine> {
    if let Some(e) = LLAMA_ENGINE.get() {
        return e.clone();
    }
    let _ = LLAMA_ENGINE.set(Arc::new(LlamaServerEngine::with_config(config)));
    global_engine()
}

// ─── AsrEngine trait 适配器（注册到 registry）───────────────────────────────

/// llama-server 的 AsrEngine 适配：包装现有全局单例，供 registry 统一路由。
/// 新增 PyTorch 引擎时照此模式写一个 adapter 即可，无需改动上层。
pub struct LlamaAsrAdapter {
    engine: Arc<LlamaServerEngine>,
}

impl LlamaAsrAdapter {
    pub fn new() -> Self {
        Self {
            engine: global_engine(),
        }
    }
}

impl Default for LlamaAsrAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl super::engine::AsrEngine for LlamaAsrAdapter {
    fn framework(&self) -> &'static str {
        "gguf"
    }

    fn load_model(&self, name: &str) -> Result<(), String> {
        load_asr_model(name).map(|_| ()).map_err(|e| e.to_string())
    }

    fn load_model_with_device(&self, name: &str, device: &str) -> Result<(), String> {
        load_asr_model_with_stage(name, device, &mut |_| {}).map(|_| ()).map_err(|e| e.to_string())
    }

    fn load_model_with_stage(
        &self,
        name: &str,
        on_stage: &mut dyn FnMut(&str),
    ) -> Result<(), String> {
        load_asr_model_with_stage(name, "cuda", on_stage).map(|_| ()).map_err(|e| e.to_string())
    }

    fn load_model_with_stage_and_device(
        &self,
        name: &str,
        device: &str,
        on_stage: &mut dyn FnMut(&str),
    ) -> Result<(), String> {
        load_asr_model_with_stage(name, device, on_stage).map(|_| ()).map_err(|e| e.to_string())
    }

    fn unload(&self) -> Result<(), String> {
        self.engine.unload().map_err(|e| e.to_string())
    }

    fn is_loaded(&self) -> bool {
        self.engine.is_loaded()
    }

    fn current_model(&self) -> String {
        self.engine.model_name().unwrap_or("").to_string()
    }

    fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String> {
        self.engine
            .transcribe(samples, sample_rate)
            .map_err(|e| e.to_string())
    }

    fn vram_estimate_mb(&self) -> Option<u64> {
        // 无权限时回退：取当前模型目录大小估算
        let p = self.engine.current_model_path();
        p.parent().map(|d| {
            let mut total: u64 = 0;
            fn walk(dir: &std::path::Path, total: &mut u64) {
                if let Ok(rd) = std::fs::read_dir(dir) {
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
            walk(&d, &mut total);
            total / (1024 * 1024)
        })
    }
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
