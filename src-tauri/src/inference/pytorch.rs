//! PyTorch 运行时 worker 客户端（长驻 Python 子进程 + JSON 行协议）
//!
//! 边界（与 llama-server / sherpa-onnx 同一原则）：
//! - Rust **不加载**任何 Python/PyTorch DLL，只通过 stdin/stdout 与子进程通信；
//! - 运行时目录由 `runtime_download` 的包表解析（按设备选 CPU / CUDA 变体），
//!   本模块不硬编码目录名；
//! - worker 崩溃 / 卡死 / 超时都不得影响主程序：每个请求带超时，进程状态可查，
//!   错误信息附带 stderr 尾部，便于定位"缺 DLL / 驱动不兼容 / 模型加载失败"。
//!
//! 协议（worker_protocol = 1）：一行一个 JSON 请求，一行一个 JSON 响应，
//! 响应带同 `id`；`ok=false` 时带 `error.kind` + `error.message`。

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::inference::runtime_download;

/// worker 协议版本（与 runtime-manifest.json / worker.py 的 PROTOCOL_VERSION 一致）
pub const PROTOCOL_VERSION: u64 = 1;

/// 普通请求超时（ping / 已加载模型的命令）
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// 冷启动超时：首次 `import torch` + 初始化 CUDA 在机械盘/低端机可能超过 30s
const WARMUP_TIMEOUT: Duration = Duration::from_secs(180);
/// 模型加载超时（读权重 + 建 module；CUDA 首次分配可能较慢）
const MODEL_LOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// 单次推理超时（转写/合成；长音频由上层分段，这里留足余量）
const INFERENCE_TIMEOUT: Duration = Duration::from_secs(600);
/// stderr 保留的最大字节数（只留尾部用于报错）
const STDERR_TAIL_LIMIT: usize = 8 * 1024;

/// 一次请求的原始响应
#[derive(Debug)]
struct Reply {
    ok: bool,
    result: Value,
    error_kind: String,
    error_message: String,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    stderr_tail: Arc<Mutex<String>>,
}

/// 长驻 worker 句柄。
///
/// 懒启动：`new` 只解析运行时目录，真正的进程在第一次 `call` 时拉起。
/// 进程退出/崩溃后下一次 `call` 会自动重启（上层无感，但已加载的模型会丢，
/// 因此引擎层必须在重启后重新 `load_model`）。
pub struct PyTorchWorker {
    dir: PathBuf,
    device: String,
    inner: Mutex<Option<Running>>,
    next_id: AtomicU64,
}

impl PyTorchWorker {
    /// 按设备解析运行时并创建句柄（不启动进程）。
    ///
    /// `device`: "cpu" 或 "cuda"。CUDA 包在设备能力上覆盖 CPU，因此 CUDA 请求
    /// 只接受 `supports_cuda` 的包，CPU 请求优先复用已安装的 CUDA 包。
    pub fn new(device: &str) -> Result<Self, String> {
        let pkg = runtime_download::installed_runtime_for_device("pytorch", device).ok_or_else(
            || {
                let want = if is_cuda(device) { "CUDA" } else { "CPU" };
                format!(
                    "PyTorch {want} 运行时未安装：请先在「推理框架」页下载对应运行时包"
                )
            },
        )?;
        Ok(Self {
            dir: runtime_download::runtime_dir_for(pkg),
            device: if is_cuda(device) { "cuda".into() } else { "cpu".into() },
            inner: Mutex::new(None),
            next_id: AtomicU64::new(1),
        })
    }

    /// 运行时目录（libs/pytorch-<variant>）
    pub fn runtime_dir(&self) -> &PathBuf {
        &self.dir
    }

    /// 测试专用：绕过"运行时必须已安装"的解析，直接指向一个目录。
    /// 用于验证协议/超时/崩溃路径（用一个假 worker.py + 真解释器）。
    #[cfg(test)]
    pub(crate) fn with_dir(dir: PathBuf, device: &str) -> Self {
        Self {
            dir,
            device: if is_cuda(device) { "cuda".into() } else { "cpu".into() },
            inner: Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }

    /// 目标设备（cpu / cuda）
    pub fn device(&self) -> &str {
        &self.device
    }

    /// worker 子进程 PID（未启动或已退出 → None）。显存监控按 PID 取真值用。
    pub fn pid(&self) -> Option<u32> {
        let mut guard = self.inner.lock();
        let running = guard.as_mut()?;
        match running.child.try_wait() {
            Ok(None) => Some(running.child.id()),
            _ => {
                *guard = None;
                None
            }
        }
    }

    /// 进程当前是否存活（会顺带回收已退出的句柄）
    pub fn is_running(&self) -> bool {
        self.pid().is_some()
    }

    /// 查询运行时信息：Python / torch 版本、CUDA 是否可用、设备数。
    ///
    /// 这是"设备是否真的能用"的唯一判据：装了 CUDA 包但驱动不兼容时，
    /// `cuda_available` 为 false —— 上层据此决定是否回退 CPU 或报错。
    pub fn runtime_info(&self) -> Result<Value, String> {
        let reply = self.call("runtime_info", json!({}), WARMUP_TIMEOUT)?;
        Ok(reply)
    }

    /// 探活（不加载模型，不初始化 CUDA）
    pub fn ping(&self) -> Result<(), String> {
        self.call("ping", json!({}), REQUEST_TIMEOUT).map(|_| ())
    }

    /// 加载模型。
    ///
    /// `adapter` 必须是运行时内置白名单里的 id（worker 会拒绝其它值）；
    /// 模型目录只提供权重与配置，不携带可执行代码。
    pub fn load_model(
        &self,
        model_dir: &std::path::Path,
        adapter: &str,
        language: &str,
        voice: &str,
    ) -> Result<Value, String> {
        let params = json!({
            "model_dir": model_dir.display().to_string(),
            "adapter": adapter,
            "device": self.device,
            "options": { "language": language, "voice": voice },
        });
        self.call("load_model", params, MODEL_LOAD_TIMEOUT)
    }

    /// 卸载模型（保留 worker 进程；换模型/换设备由调用方决定是否 `shutdown`）
    pub fn unload_model(&self) -> Result<Value, String> {
        self.call("unload_model", json!({}), REQUEST_TIMEOUT)
    }

    /// 转写：音频以临时 WAV 路径传入（`options` 透传给适配器：language / context）
    pub fn transcribe(&self, wav: &std::path::Path, options: Value) -> Result<Value, String> {
        let params = json!({ "wav": wav.display().to_string(), "options": options });
        self.call("transcribe", params, INFERENCE_TIMEOUT)
    }

    /// 合成：worker 直接写出 WAV（`options`: voice / speed / language）
    pub fn synthesize(
        &self,
        text: &str,
        out_wav: &std::path::Path,
        options: Value,
    ) -> Result<Value, String> {
        let params = json!({
            "text": text,
            "out_wav": out_wav.display().to_string(),
            "options": options,
        });
        self.call("synthesize", params, INFERENCE_TIMEOUT)
    }

    /// 请求 worker 退出；随后强制回收，避免残留进程占着 DLL。
    pub fn shutdown(&self) {
        let _ = self.call("shutdown", json!({}), Duration::from_secs(5));
        self.kill();
    }

    /// 立即结束子进程（等待 2s 后强杀）
    pub fn kill(&self) {
        let mut guard = self.inner.lock();
        if let Some(mut running) = guard.take() {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                match running.child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(50))
                    }
                    _ => {
                        let _ = running.child.kill();
                        let _ = running.child.wait();
                        break;
                    }
                }
            }
        }
    }

    /// stderr 尾部（报错附带上，便于定位 DLL / 驱动问题）
    pub fn stderr_tail(&self) -> String {
        self.inner
            .lock()
            .as_ref()
            .map(|r| r.stderr_tail.lock().clone())
            .unwrap_or_default()
    }

    /// 发一条请求并等响应（含懒启动、崩溃重启、超时诊断）
    fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut guard = self.inner.lock();
        self.ensure_running(&mut guard)?;
        let running = guard.as_mut().expect("ensure_running 之后必然存在");

        let line = json!({ "id": id, "method": method, "params": params }).to_string();
        writeln!(running.stdin, "{line}").map_err(|e| format!("worker 写入失败: {e}"))?;
        running.stdin.flush().map_err(|e| format!("worker 刷新失败: {e}"))?;

        let deadline = std::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                // 注意：不能调用 self.stderr_tail()（它要再取一次同一把锁 → 自死锁）；用已借到的 running
                let tail = tail_of(running);
                return Err(format!(
                    "worker 超时（{method}，{}s）{}",
                    timeout.as_secs(),
                    if tail.is_empty() { String::new() } else { format!("；stderr: {tail}") }
                ));
            }
            match running.lines.recv_timeout(left) {
                Ok(text) => {
                    let value: Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        // 非协议输出（例如第三方库直接 print）不当作响应，继续等
                        Err(_) => continue,
                    };
                    let reply_id = value.get("id").and_then(|v| v.as_u64());
                    // 只认自己的响应：id 不符（含运行时主动上报）不消费给本请求
                    if reply_id.is_some() && reply_id != Some(id) {
                        continue;
                    }
                    let reply = parse_reply(value, id)?;
                    if reply.ok {
                        return Ok(reply.result);
                    }
                    let tail = tail_of(running);
                    return Err(format!(
                        "worker 返回错误（{method}，{}: {}）{}",
                        reply.error_kind,
                        reply.error_message,
                        if tail.is_empty() { String::new() } else { format!("；stderr: {tail}") }
                    ));
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    let status = running.child.try_wait().ok().flatten();
                    let tail = tail_of(running);
                    return Err(format!(
                        "worker 已退出（{}）{}: {tail}",
                        method,
                        status.map(|s| format!("状态 {s}")).unwrap_or_default()
                    ));
                }
            }
        }
    }

    /// 确保进程存活：未启动 → 拉起；已退出 → 重启（并清空旧管道）
    fn ensure_running(&self, guard: &mut Option<Running>) -> Result<(), String> {
        if let Some(running) = guard.as_mut() {
            match running.child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(status)) => {
                    let tail = running.stderr_tail.lock().clone();
                    log::warn!("[pytorch] worker 已退出（{status}），将重启：{tail}");
                }
                Err(e) => log::warn!("[pytorch] worker 状态查询失败（{e}），将重启"),
            }
        }
        *guard = Some(self.spawn()?);
        Ok(())
    }

    /// 启动 `python.exe worker.py`（工作目录 = 运行时目录，隐藏控制台）
    fn spawn(&self) -> Result<Running, String> {
        let exe = self.dir.join(if cfg!(windows) { "python.exe" } else { "python" });
        if !exe.exists() {
            return Err(format!(
                "PyTorch 运行时缺少 {}：请重新下载运行时包",
                exe.display()
            ));
        }
        let script = self.dir.join("worker.py");
        if !script.exists() {
            return Err(format!("PyTorch 运行时缺少 {}：请重新下载运行时包", script.display()));
        }
        let mut cmd = Command::new(&exe);
        crate::process_hidden::hide_console_window(&mut cmd);
        cmd.arg("worker.py")
            .current_dir(&self.dir)
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("VOXFLOW_DEVICE", &self.device)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 PyTorch worker 失败: {e}"))?;

        let stdin = child.stdin.take().ok_or("无法接入 worker stdin")?;
        let stdout = child.stdout.take().ok_or("无法接入 worker stdout")?;
        let stderr = child.stderr.take().ok_or("无法接入 worker stderr")?;

        // stdout 行读取线程：阻塞读 + channel，使请求侧可以带超时
        let (tx, lines) = std::sync::mpsc::channel::<String>();
        std::thread::Builder::new()
            .name("pytorch-worker-stdout".into())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            if tx.send(l).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| format!("启动 worker stdout 读取线程失败: {e}"))?;

        // stderr 排水线程：保留尾部，防管道写满阻塞 worker
        let tail = Arc::new(Mutex::new(String::new()));
        let tail_writer = tail.clone();
        std::thread::Builder::new()
            .name("pytorch-worker-stderr".into())
            .spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    let Ok(l) = line else { break };
                    let mut buf = tail_writer.lock();
                    buf.push_str(&l);
                    buf.push('\n');
                    if buf.len() > STDERR_TAIL_LIMIT {
                        let cut = buf.len() - STDERR_TAIL_LIMIT;
                        // 按字符边界截断（stderr 可能是 UTF-8 多字节）
                        let cut = (cut..buf.len()).find(|i| buf.is_char_boundary(*i)).unwrap_or(cut);
                        *buf = buf[cut..].to_string();
                    }
                }
            })
            .map_err(|e| format!("启动 worker stderr 读取线程失败: {e}"))?;

        log::info!(
            "[pytorch] worker 启动：{} worker.py（device={}，pid={}）",
            exe.display(),
            self.device,
            child.id()
        );
        Ok(Running { child, stdin, lines, stderr_tail: tail })
    }
}

impl Drop for PyTorchWorker {
    fn drop(&mut self) {
        // 主程序退出/引擎卸载时不留孤儿进程（否则下次启动会与残留实例抢显存）
        self.kill();
    }
}

fn is_cuda(device: &str) -> bool {
    matches!(device.trim().to_ascii_lowercase().as_str(), "cuda" | "gpu")
}

/// 读某个已借出的 Running 的 stderr 尾部。
///
/// 必须走这个函数而不是 `self.stderr_tail()`：后者要再取 `self.inner` 锁，
/// 而调用点（`call` 的错误/超时分支）已经持有该锁 —— `parking_lot::Mutex` 不可重入，
/// 直接调用会自死锁，把"worker 报错"变成"调用线程永久挂起"。
fn tail_of(running: &Running) -> String {
    running.stderr_tail.lock().clone()
}

/// 解析响应；协议版本不符视为协议错误（不静默按旧版解释）
fn parse_reply(value: Value, id: u64) -> Result<Reply, String> {
    let protocol = value.get("protocol").and_then(|v| v.as_u64());
    if protocol != Some(PROTOCOL_VERSION) {
        return Err(format!(
            "worker 协议版本不符：期望 {PROTOCOL_VERSION}，实际 {protocol:?}（请更新运行时包）"
        ));
    }
    let ok = value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let error = value.get("error");
    Ok(Reply {
        ok,
        result: value.get("result").cloned().unwrap_or(Value::Null),
        error_kind: error
            .and_then(|e| e.get("kind"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        error_message: error
            .and_then(|e| e.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
    .map(|r| {
        let _ = id;
        r
    })
}

/// 一次性设备探测：拉起 worker → `runtime_info` → 关闭。
///
/// 供「推理框架」页展示"CUDA 是否真的可用"（装了包 ≠ 驱动能用）。
pub fn probe_device(device: &str) -> Result<Value, String> {
    let worker = PyTorchWorker::new(device)?;
    let info = worker.runtime_info();
    worker.shutdown();
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 协议解析：版本不符必须报错，ok=false 要带出 kind/message
    #[test]
    fn test_parse_reply_rejects_wrong_protocol() {
        let err = parse_reply(json!({"protocol": 2, "ok": true}), 1).unwrap_err();
        assert!(err.contains("协议版本不符"), "{err}");
    }

    #[test]
    fn test_parse_reply_extracts_error() {
        let r = parse_reply(
            json!({"protocol": 1, "ok": false, "error": {"kind": "worker_error", "message": "boom"}}),
            7,
        )
        .unwrap();
        assert!(!r.ok);
        assert_eq!(r.error_kind, "worker_error");
        assert_eq!(r.error_message, "boom");
    }

    /// 未安装运行时：必须给出可操作的错误，而不是 panic 或空路径
    #[test]
    fn test_missing_runtime_reports_actionable_error() {
        if runtime_download::installed_runtime_for_device("pytorch", "cuda").is_some() {
            eprintln!("SKIP: 本机已安装 PyTorch CUDA 运行时");
            return;
        }
        let err = match PyTorchWorker::new("cuda") {
            Ok(_) => panic!("本机未安装运行时却解析成功"),
            Err(e) => e,
        };
        assert!(err.contains("未安装"), "{err}");
    }

    /// 真实往返：仅在运行时已安装时执行（CI / 干净机器自动跳过）
    #[test]
    fn test_live_worker_roundtrip_when_installed() {
        let Some(_) = runtime_download::installed_runtime_for_device("pytorch", "cpu") else {
            eprintln!("SKIP: 本机未安装 PyTorch CPU 运行时");
            return;
        };
        let worker = PyTorchWorker::new("cpu").expect("解析运行时");
        worker.ping().expect("ping 应成功");
        assert!(worker.is_running());
        let pid = worker.pid().expect("启动后应有 PID");
        assert!(pid > 0);
        let info = worker.runtime_info().expect("runtime_info 应成功");
        assert!(info["python"].as_str().is_some_and(|v| v.starts_with("3.11")));
        assert!(info["torch"].as_str().is_some_and(|v| v.starts_with("2.14.0")));
        assert_eq!(info["cuda_available"], json!(false));
        worker.shutdown();
        assert!(!worker.is_running(), "shutdown 后不应再有存活进程");
    }

    /// 「检测设备」按钮所走的确切路径：probe_device 的返回必须带前端渲染所需字段
    #[test]
    fn test_probe_device_reports_frontend_contract_fields() {
        if runtime_download::installed_runtime_for_device("pytorch", "cpu").is_none() {
            eprintln!("SKIP: 本机未安装 PyTorch CPU 运行时");
            return;
        }
        let info = probe_device("cpu").expect("probe 应成功");
        for key in ["python", "torch", "cuda_available", "cuda_version", "device_count"] {
            assert!(info.get(key).is_some(), "runtime_info 缺少字段 {key}: {info}");
        }
        assert!(info["cuda_available"].is_boolean());
        assert!(info["device_count"].is_u64());
    }

    // ── 监督路径：用"假 worker + 真解释器"验证超时 / 崩溃 / 协议不符 ──────────────

    /// 造一个最小可用的假 runtime 目录：真 python.exe + 指定行为的 worker.py
    fn fake_runtime(tag: &str, script: &str) -> Option<PathBuf> {
        let src = runtime_download::installed_runtime_for_device("pytorch", "cpu")
            .map(runtime_download::runtime_dir_for)?;
        let dir = std::env::temp_dir().join(format!("voxflow-fake-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).ok()?;
        // 解释器只需要这几个文件即可启动（不 import torch）
        for name in ["python.exe", "python3.dll", "python311.dll", "python311.zip", "python311._pth"] {
            let from = src.join(name);
            if from.exists() {
                std::fs::copy(&from, dir.join(name)).ok()?;
            }
        }
        std::fs::write(dir.join("worker.py"), script).ok()?;
        Some(dir)
    }

    /// 不回应 → 必须超时报错（而不是永久阻塞 UI 线程）
    #[test]
    fn test_worker_timeout_surfaces_as_error() {
        let Some(dir) = fake_runtime(
            "hang",
            "import time\nfor _ in range(60):\n    time.sleep(1)\n",
        ) else {
            eprintln!("SKIP: 未安装运行时，无法取到解释器");
            return;
        };
        let worker = PyTorchWorker::with_dir(dir, "cpu");
        let started = std::time::Instant::now();
        let err = worker
            .call("ping", json!({}), Duration::from_secs(1))
            .unwrap_err();
        assert!(err.contains("超时"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10), "超时应及时返回");
        worker.kill();
        assert!(!worker.is_running(), "kill 后进程必须回收");
    }

    /// 进程秒退 → 报"已退出"并带上 stderr（缺 DLL 那类问题靠它定位）
    #[test]
    fn test_worker_exit_surfaces_stderr() {
        let Some(dir) = fake_runtime(
            "exit",
            "import sys\nprint('boom: missing dependency', file=sys.stderr)\nsys.exit(3)\n",
        ) else {
            eprintln!("SKIP: 未安装运行时，无法取到解释器");
            return;
        };
        let worker = PyTorchWorker::with_dir(dir, "cpu");
        let err = worker.call("ping", json!({}), Duration::from_secs(20)).unwrap_err();
        assert!(err.contains("已退出") || err.contains("超时"), "{err}");
        assert!(err.contains("boom"), "错误里应带 stderr 尾部: {err}");
        worker.kill();
    }

    /// 协议版本不符 → 明确报错，不按旧协议解释
    #[test]
    fn test_worker_protocol_mismatch_is_rejected() {
        let Some(dir) = fake_runtime(
            "proto",
            "import sys, json\nline = sys.stdin.readline()\nreq = json.loads(line)\n\
             print(json.dumps({'id': req['id'], 'protocol': 99, 'ok': True, 'result': {}}), flush=True)\n\
             sys.stdin.readline()\n",
        ) else {
            eprintln!("SKIP: 未安装运行时，无法取到解释器");
            return;
        };
        let worker = PyTorchWorker::with_dir(dir, "cpu");
        let err = worker.call("ping", json!({}), Duration::from_secs(20)).unwrap_err();
        assert!(err.contains("协议版本不符"), "{err}");
        worker.kill();
    }
}
