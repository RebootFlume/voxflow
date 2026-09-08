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

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    // 运行时目录：exe 同级 libs（llama_runtime_dir 统一解析）
    let runtime = crate::inference::runtime_paths::llama_runtime_dir();

    // 模型目录（GGUF + mmproj 必须同时存在）: 统一走 model_manager 的 modelRoot（config.json）:
    //   1. modelRoot/<模型目录>
    //   2. modelRoot/<模型名>（旧目录名兼容）
    let model_root = crate::model_manager::get_model_root();
    let model_name = if model_subdir.contains("1.7") {
        "Qwen3-ASR-1.7B"
    } else {
        "Qwen3-ASR-0.6B"
    };
    let gguf = format!("{model_name}-Q8_0.gguf");
    let model = {
        let d = model_root.join(model_subdir);
        (d.join(&gguf).exists()).then_some(d)
    }
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
/// 本进程成功 spawn 的 server 配置记录。
/// 只有「本进程以相同配置启动过」的 server 才允许快速接管（running_matches）；
/// 外部启动/上次崩溃残留的 server 无法验证其 -ngl 等加载参数 → 一律杀重启，
/// 保证「切模型/切设备」真实生效，杜绝假成功。
#[derive(Debug, Clone, PartialEq)]
struct LaunchRec {
    model_path: PathBuf,
    mmproj_path: PathBuf,
    n_gpu_layers: i32,
}

impl LaunchRec {
    fn from_cfg(cfg: &LlamaServerConfig) -> Self {
        Self {
            model_path: cfg.model_path.clone(),
            mmproj_path: cfg.mmproj_path.clone(),
            n_gpu_layers: cfg.n_gpu_layers,
        }
    }

    fn matches(&self, cfg: &LlamaServerConfig) -> bool {
        paths_equal(&self.model_path, &cfg.model_path)
            && paths_equal(&self.mmproj_path, &cfg.mmproj_path)
            && self.n_gpu_layers == cfg.n_gpu_layers
    }
}

/// 内部状态：
/// - `child` Mutex 持有子进程句柄
/// - `client` reqwest HTTP 客户端（多线程复用）
/// - 启动后常驻，每次 `infer` 不重启
pub struct LlamaServerEngine {
    config: Mutex<LlamaServerConfig>,
    child: Mutex<Option<Child>>,
    /// 本进程最后一次成功 spawn 的配置（用于接管身份验证）
    launched: Mutex<Option<LaunchRec>>,
    /// 单线程 HTTP 客户端（Tauri 主线程同步调用）
    client: reqwest::blocking::Client,
}

impl LlamaServerEngine {
    /// 创建新实例（不自动启动子进程，调用 `load` 时启动）
    pub fn new() -> Self {
        Self::with_config(LlamaServerConfig::default())
    }

    pub fn with_config(config: LlamaServerConfig) -> Self {
        // 禁用空闲连接复用（pool_idle_timeout=0）：llama-server 空闲后可能关闭
        // keep-alive 连接，池化 client 复用 stale 连接会报 "error sending request" /
        // /health 探测失败 → is_loaded 假阴性。本地回环新连接开销毫秒级，可靠优先。
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::ZERO)
            .build()
            .expect("reqwest client build");
        Self {
            config: Mutex::new(config),
            child: Mutex::new(None),
            launched: Mutex::new(None),
            client,
        }
    }

    /// 端口探测：任何进程在监听即 true（不判所有权）——仅供端口层（占用/冲突判断）使用。
    /// 绝不直接当作"已加载"：那是 is_loaded()（所有权+验证语义）的职责。
    fn port_alive(&self, port: u16) -> bool {
        let url = format!("http://127.0.0.1:{port}{HEALTH_PATH}");
        if let Ok(resp) = self.client.get(&url).send() {
            return resp.status().is_success();
        }
        false
    }

    /// 查询端口上已运行 server 实际加载的模型路径（llama-server 的 GET /props → model_path）
    fn running_model_path(&self, port: u16) -> Option<PathBuf> {
        let url = format!("http://127.0.0.1:{port}/props");
        let resp = self.client.get(&url).send().ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let v: serde_json::Value = resp.json().ok()?;
        let p = v
            .get("model_path")
            .or_else(|| v.get("model"))
            .and_then(|s| s.as_str())
            .map(PathBuf::from)?;
        p.is_file().then_some(p)
    }

    /// 查询已运行 server 的解码温度（/props.default_generation_settings.params.temperature）。
    /// 用于识别"残留进程是默认采样（temp 0.8）→ ASR 输出随机/整句乱码"的情况。
    fn running_temperature(&self, port: u16) -> Option<f32> {
        let url = format!("http://127.0.0.1:{port}/props");
        let resp = self.client.get(&url).send().ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let v: serde_json::Value = resp.json().ok()?;
        let t = v
            .get("default_generation_settings")?
            .get("params")?
            .get("temperature")?
            .as_f64()?;
        Some(t as f32)
    }

    /// 端口上的 server 是否「确实是目标模型 + 正确采样 + 本进程以相同配置启动过」。
    /// 任一环节无法确认 → false → 走杀重启（保证切换真实生效）。
    pub(crate) fn running_matches(&self, cfg: &LlamaServerConfig) -> bool {
        if !self.port_alive(cfg.port) {
            return false;
        }
        // 1. 模型身份必须一致
        match self.running_model_path(cfg.port) {
            Some(p) if paths_equal(&p, &cfg.model_path) => {}
            _ => return false,
        }
        // 2. 采样参数必须一致（temp 0 = greedy；残留默认 temp 0.8 → ASR 随机）
        match self.running_temperature(cfg.port) {
            Some(t) if (t - cfg.temperature).abs() < 1e-4 => {}
            _ => return false,
        }
        // 3. 必须是本进程以相同配置启动过的（-ngl / mmproj 无法从 /props 验证）
        match &*self.launched.lock() {
            Some(l) => l.matches(cfg),
            None => false,
        }
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
        mut cfg: LlamaServerConfig,
        on_stage: &mut dyn FnMut(&str),
    ) -> InferenceResult<()> {
        // 0. 记录新配置（后续 transcribe / health 用新端口和路径）
        *self.config.lock() = cfg.clone();

        // 1. 已有 server 在跑：只有「模型 + 采样 + 本进程启动参数」全部验证一致才接管，
        //    否则杀掉重启 —— 杜绝把残留的旧模型/默认采样进程当成目标模型（假成功/整句乱码）。
        if self.running_matches(&cfg) {
            log::info!(
                "[llama-server] 已在运行且验证一致（模型/采样/启动参数），直接接管: {}",
                cfg.model_path.display()
            );
            return Ok(());
        }
        if self.port_alive(cfg.port) {
            let running = self.running_model_path(cfg.port);
            log::warn!(
                "[llama-server] 端口 {} 已有 server 但与目标不一致（运行: {}，目标: {}），清理后重启",
                cfg.port,
                running.map(|p| p.display().to_string()).unwrap_or_else(|| "未知".into()),
                cfg.model_path.display(),
            );
            // 清掉本进程残留 child 句柄
            if let Some(mut c) = self.child.lock().take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            kill_port_owner(cfg.port);
            wait_port_closed(cfg.port, Duration::from_secs(3));

            // 外部进程（非本软件引擎，路径判定拒杀）仍占用 → 不杀，自动换空闲端口。
            // 端口对本应用是私有内部值：选定即本会话使用，不回归默认、不反复扫描。
            if self.port_alive(cfg.port) {
                if let Some(p) = find_free_port(cfg.port + 1) {
                    log::warn!(
                        "[llama-server] 端口 {} 被外部进程占用（不误杀），改用空闲端口 {}",
                        cfg.port,
                        p
                    );
                    cfg.port = p;
                    // 同步回 config：后续 health/转写/身份验证都用新端口
                    *self.config.lock() = cfg.clone();
                } else {
                    return Err(InferenceError::LoadFailed(format!(
                        "端口 {} 被外部进程占用且无空闲端口可用",
                        cfg.port
                    )));
                }
            }
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

        // 4. 等待就绪：必须是「我们 spawn 的子进程还活着」且「端口在服务」
        //    （只查端口会被外部进程抢先占口造成"假就绪"）
        let start = std::time::Instant::now();
        while start.elapsed() < READY_TIMEOUT {
            // 转发 stderr 解析出的细粒度阶段（读模型/加载投影/初始化）
            while let Ok(stage) = stage_rx.try_recv() {
                on_stage(&stage);
            }
            // 子进程提前退出？
            if let Some(c) = self.child.lock().as_mut() {
                if let Ok(Some(_)) = c.try_wait() {
                    *self.child.lock() = None;
                    return Err(InferenceError::LoadFailed(
                        "llama-server 启动后立即退出：可能端口被外部进程占用，或模型路径/GPU 问题".to_string(),
                    ));
                }
            }
            // 端口在服务且子进程存活 → 真就绪
            let child_alive = self
                .child
                .lock()
                .as_mut()
                .map(|c| c.try_wait().map(|s| s.is_none()).unwrap_or(true))
                .unwrap_or(false);
            if child_alive && self.port_alive(cfg.port) {
                log::info!(
                    "[llama-server] 就绪，耗时 {}ms",
                    start.elapsed().as_millis()
                );
                // 记录本次成功启动的配置（后续 running_matches 身份验证用）
                *self.launched.lock() = Some(LaunchRec::from_cfg(&cfg));
                on_stage("ready");
                return Ok(());
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
        // 兜底：外部启动 / 上次崩溃残留的 llama-server 一并清掉，保证下次 load 干净。
        let port = self.config.lock().port;
        kill_port_owner(port);
        wait_port_closed(port, Duration::from_secs(3));
        *self.launched.lock() = None;
        Ok(())
    }

    /// 引擎是否"已加载"（所有权语义）：
    /// 仅当 ①本进程成功启动过（launched 记录）且 ②该端口仍在服务时返回 true。
    /// 外部进程/用户自装的 llama-server 即使监听同一端口，也不被视为"我们的已加载引擎"。
    pub fn is_loaded(&self) -> bool {
        // 本进程从未成功启动过 → 不是我们的引擎
        let launched = self.launched.lock();
        if launched.is_none() {
            return false;
        }
        let port = self.config.lock().port;
        // port_alive 用池化 client——已禁用空闲复用（每次新连接），不会再因 stale 假阴性。
        // 端口是权威判据：只要 /health 响应 = 引擎在服务 = 已加载。
        // child 句柄只作参考（可能过期误报），不否决端口结论。
        let port_alive = self.port_alive(port);
        let child_says_alive = match self.child.lock().as_mut() {
            Some(c) => match c.try_wait() {
                Ok(Some(_)) => false,   // 句柄说已退出（可能 stale，仅参考）
                Ok(None) => true,
                Err(e) => {
                    log::warn!("[llama-server] is_loaded: child.try_wait() 错误: {e}");
                    true
                }
            },
            None => true, // 接管场景无 child 句柄
        };
        if !port_alive {
            // 端口不通：深度诊断（引擎真死 vs 连接异常）
            let tcp_ok = std::net::TcpStream::connect_timeout(
                &format!("127.0.0.1:{port}").parse().unwrap_or_else(|_| "127.0.0.1:1".parse().unwrap()),
                std::time::Duration::from_millis(500),
            )
            .is_ok();
            let fresh_health = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_millis(1500))
                .build()
                .ok()
                .and_then(|c| {
                    c.get(format!("http://127.0.0.1:{port}{HEALTH_PATH}"))
                        .send()
                        .ok()
                })
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            log::info!(
                "[llama-server] is_loaded=false: port={port} pooled_health=false tcp={tcp_ok} fresh_health={fresh_health} child_alive={child_says_alive}"
            );
            return false;
        }
        // 端口通：即使 child 句柄 stale 也视为已加载（接管/句柄过期场景的正确语义）
        if !child_says_alive {
            log::debug!("[llama-server] child 句柄已退出但端口 {port} 在服务 → 视为已加载");
        }
        true
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

        // 构造 multipart 表单（辅助函数：失败重试时重建）
        let build_form = |bytes: Vec<u8>| {
            reqwest::blocking::multipart::Form::new()
                .text("response_format", "json")
                .part(
                    "file",
                    reqwest::blocking::multipart::Part::bytes(bytes)
                        .file_name("audio.wav")
                        .mime_str("audio/wav")
                        .expect("mime 常量合法"),
                )
        };

        // 2. 发送请求（失败自动重试一次：用全新 client 绕过连接池——
        //    llama-server 空闲后可能关闭 keep-alive，复用池里的 stale 连接会报
        //    "error sending request"，重建连接即恢复）
        let url = self.config.lock().transcribe_url();
        let resp = match self.client.post(&url).multipart(build_form(wav_bytes.clone())).send() {
            Ok(r) => Ok(r),
            Err(first_err) => {
                log::warn!(
                    "[llama-server] transcribe 首次请求失败（可能连接池 stale），用新连接重试: {url} — {first_err}"
                );
                let fresh = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(120))
                    .build()
                    .map_err(|e| InferenceError::InferenceFailed(format!("重建 client 失败: {e}")))?;
                fresh
                    .post(&url)
                    .multipart(build_form(wav_bytes))
                    .send()
                    .map_err(|e| InferenceError::InferenceFailed(format!("HTTP 失败: {e}")))
            }
        };
        let resp = resp?;

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

    /// 当前生效设备（cuda/cpu），供状态快照与前端展示
    pub fn device_label(&self) -> &'static str {
        if self.config.lock().n_gpu_layers > 0 {
            "cuda"
        } else {
            "cpu"
        }
    }

    /// 本进程当前使用的引擎端口（换口后返回实际端口；未启动时返回配置端口）
    pub fn current_port(&self) -> u16 {
        self.config.lock().port
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

    fn model_name(&self) -> Option<String> {
        // 从当前配置的真实模型文件取名，不再硬编码（此前无论加载什么都显示 0.6B）
        let p = self.config.lock().model_path.clone();
        let fname = p.file_name()?.to_string_lossy().into_owned();
        Some(format!("{fname} (via llama-server)"))
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

/// 两个模型路径是否指向同一文件（Windows 大小写不敏感 + 分隔符归一）
fn paths_equal(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").to_lowercase();
    norm(a) == norm(b)
}

/// 路径规范化（比较用）：Windows 大小写不敏感 + 分隔符归一
fn norm_path(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// 该进程是否由本软件自己的 runtime（exe 旁 libs/）启动。
/// 只清理"自己的引擎进程"（本实例启动或本软件历史会话残留），
/// 绝不杀用户/第三方自装的 llama-server —— 即使它恰好监听同一端口。
fn is_our_engine_exe(exe: &Path) -> bool {
    let libs = crate::inference::runtime_paths::libs_dir();
    let e = norm_path(exe);
    let l = norm_path(&libs);
    e.starts_with(&l)
}

/// 取进程可执行文件路径（PowerShell；仅 Windows 有效）
fn process_exe_path(pid: u32) -> Option<PathBuf> {
    let mut cmd = std::process::Command::new("powershell");
    crate::process_hidden::hide_console_window(&mut cmd);
    let out = cmd
        .args([
            "-NoProfile",
            "-Command",
            &format!("(Get-Process -Id {pid} -ErrorAction SilentlyContinue).Path"),
        ])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        return None;
    }
    Some(PathBuf::from(s))
}

/// 杀掉占用指定端口的「本软件引擎」进程（仅 Windows）。
/// 判定依据 = 进程可执行文件是否在本软件 libs 目录下（路径归属），不是图像名：
/// - 自己的引擎 / 历史会话残留 → 杀掉（防止死进程占着固定端口造成"端口通=假就绪"）
/// - 用户或第三方自装的 llama-server / sherpa（路径不在本软件目录）→ 不杀
/// - 无法读取路径的进程 → 保守不杀（宁可让后续走"端口被占"逻辑，也不误伤）
pub(crate) fn kill_port_owner(port: u16) {
    #[cfg(windows)]
    {
        let mut netstat_cmd = std::process::Command::new("netstat");
        crate::process_hidden::hide_console_window(&mut netstat_cmd);
        let out = netstat_cmd
            .args(["-ano", "-p", "tcp"])
            .output();
        let Ok(out) = out else { return };
        if !out.status.success() {
            return;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let needle = format!(":{port}");
        let mut pids: Vec<u32> = Vec::new();
        for line in text.lines() {
            if !line.contains(&needle) || !line.contains("LISTENING") {
                continue;
            }
            if let Some(pid) = line.split_whitespace().next_back().and_then(|s| s.parse::<u32>().ok()) {
                if !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
        }
        for pid in pids {
            let exe = match process_exe_path(pid) {
                Some(e) => e,
                None => {
                    log::warn!("[port-guard] 端口 {port} 的 PID={pid} 无法确认路径，保守跳过（不误杀）");
                    continue;
                }
            };
            if !is_our_engine_exe(&exe) {
                log::warn!(
                    "[port-guard] 端口 {port} 被外部进程占用（{}，非本软件引擎），不杀 —— 需要走换端口/报错逻辑",
                    exe.display()
                );
                continue;
            }
            log::warn!("[port-guard] 清理本软件残留引擎 PID={pid}（{}）", exe.display());
            let mut kill = std::process::Command::new("taskkill");
            crate::process_hidden::hide_console_window(&mut kill);
            let _ = kill
                .args(["/PID", &pid.to_string(), "/F"])
                .status();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = port;
    }
}

/// 从 start 起找第一个空闲端口（探测：无法建立 TCP 连接即视为空闲）
pub(crate) fn find_free_port(start: u16) -> Option<u16> {
    (start..start + 200).find(|p| TcpStream::connect(("127.0.0.1", *p)).is_err())
}

/// 等待端口完全释放（旧进程刚杀后，避免 bind 冲突）
pub(crate) fn wait_port_closed(port: u16, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_err() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    log::warn!("[llama-server] 等待端口 {port} 释放超时");
}

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

/// 最近一次被「显式请求」加载的模型名（来自 load_asr_model_with_stage 的参数，
/// 即用户在 UI 的当前选择）。热键兜底 / 文件转写兜底用它，避免硬编码 0.6B
/// 造成「UI 显示 1.7B、后台实际跑 0.6B」。
static LAST_REQUESTED: parking_lot::Mutex<Option<(String, String)>> =
    parking_lot::Mutex::new(None);

/// 获取全局引擎（懒加载）
pub fn global_engine() -> Arc<LlamaServerEngine> {
    LLAMA_ENGINE
        .get_or_init(|| Arc::new(LlamaServerEngine::new()))
        .clone()
}

/// 获取"最近一次被请求"的 (模型, 设备)（注册表兜底用）
pub fn last_requested_model() -> Option<(String, String)> {
    LAST_REQUESTED.lock().clone()
}

/// 记录最近一次被请求的 (模型, 设备) —— 任意框架成功路由都应调用
/// （registry.load_asr_by_name），否则兜底加载会退回默认 llama。
pub fn record_last_requested(name: &str, device: &str) {
    *LAST_REQUESTED.lock() = Some((name.to_string(), device.to_string()));
}

/// 加载「最近一次被请求的模型+设备」；无任何请求记录时用注册表默认（0.6B）。
/// 供热键兜底 / 文件转写兜底调用：兜底行为与用户在 UI 的选择保持一致。
/// 走 registry.load_requested_asr → 查注册表路由，保证与 UI 切换共用互斥逻辑，不绕过。
pub fn load_requested() -> InferenceResult<String> {
    crate::inference::registry::registry()
        .load_requested_asr(&mut |_| {})
        .map(|(_fw, name)| name)
        .map_err(|e| InferenceError::LoadFailed(e))
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
    *LAST_REQUESTED.lock() = Some((name.to_string(), device.to_string()));
    let engine = global_engine();
    let mut cfg = llama_config_for_model(name, device)?;

    // 会话内端口延续：本进程因外部占用换过口后，后续加载沿用当前实际端口，
    // 避免每次都回默认口探测而在同一进程内重复起第二台 server。
    if cfg.port == DEFAULT_PORT {
        let cur = engine.current_port();
        if cur != DEFAULT_PORT && engine.is_loaded() {
            cfg.port = cur;
        }
    }

    // 已加载同模型（含采样/启动参数一致，以「真实运行的 server」为准）→ 直接返回
    if engine.running_matches(&cfg) {
        return Ok(engine.model_name().unwrap_or_else(|| name.to_string()));
    }

    // 换模型：先卸载旧进程（stage 带出旧模型名，便于日志追踪）
    if engine.is_loaded() {
        let old = engine.model_name().unwrap_or_default();
        let stage = if old.is_empty() { "unload".to_string() } else { format!("unload:{old}") };
        on_stage(&stage);
        let _ = engine.unload();
        on_stage("loading");
    } else {
        on_stage("loading");
    }

    engine.load_with_config(cfg, on_stage)?;
    on_stage("ready");
    Ok(engine.model_name().unwrap_or_else(|| name.to_string()))
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
        self.engine.model_name().unwrap_or_default()
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
