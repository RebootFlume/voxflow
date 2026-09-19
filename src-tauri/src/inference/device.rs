//! 共享基础设施：推理设备枚举 + 引擎子进程监督（端口守卫）
//!
//! 从 `inference/engine.rs` 与 `inference/llama_server.rs` 抽出，
//! 供所有引擎（llama-server / sherpa / 未来 C-API worker / pytorch）共用。
//! 纯搬运，行为不变；`engine.rs` / `llama_server.rs` 以 re-export 保持旧调用点兼容。

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 推理设备
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Cpu,
    Cuda(u32), // GPU 设备 ID
    Metal,     // Apple Silicon
    Directml,  // Windows DirectML
}

impl Device {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "cuda" | "gpu" => Self::Cuda(0),
            "metal" | "mps" => Self::Metal,
            "directml" | "dml" => Self::Directml,
            _ => Self::Cpu,
        }
    }

    pub fn to_str(&self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Cuda(_) => "cuda",
            Self::Metal => "metal",
            Self::Directml => "directml",
        }
    }
}

/// 路径规范化（比较用）：Windows 大小写不敏感 + 分隔符归一
fn norm_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// 该进程是否由本软件自己的 runtime（exe 旁 libs/）启动。
/// 只清理"自己的引擎进程"（本实例启动或本软件历史会话残留），
/// 绝不杀用户/第三方自装的引擎 —— 即使它恰好监听同一端口。
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
/// - 用户或第三方自装的引擎（路径不在本软件目录）→ 不杀
/// - 无法读取路径的进程 → 保守不杀（宁可让后续走"端口被占"逻辑，也不误伤）
pub(crate) fn kill_port_owner(port: u16) {
    #[cfg(windows)]
    {
        let mut netstat_cmd = std::process::Command::new("netstat");
        crate::process_hidden::hide_console_window(&mut netstat_cmd);
        let out = netstat_cmd.args(["-ano", "-p", "tcp"]).output();
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
            let _ = kill.args(["/PID", &pid.to_string(), "/F"]).status();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = port;
    }
}

/// 连接探测的超时：无人监听时 `connect` 可能等 SYN 重传超时（本机实测 ≈2s，
/// 被安全软件拦 SYN 的机器更久），所以任何"探活"都必须带超时。
/// 与 `llama_server` 深度诊断用的 500ms 保持一致。
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// 端口是否有服务在监听（**带超时**的 connect 探测；探活语义）
pub(crate) fn port_serving(port: u16, timeout: Duration) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), timeout).is_ok()
}

/// 端口是否可被独占绑定（**瞬时**：被占用会立刻返回 AddrInUse）
///
/// 这才是"端口已释放"的正确判定：原实现用 connect 探测，遇到"仍被绑定未监听 /
/// TIME_WAIT"的端口会误判为已释放（connect 连不上），而我们要问的正是
/// "新进程现在能不能 bind"。
pub(crate) fn port_bindable(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// 从 start 起找第一个可绑定端口（bind 探测，瞬时）
pub(crate) fn find_free_port(start: u16) -> Option<u16> {
    (start..start + 200).find(|p| port_bindable(*p))
}

/// 等待端口可被绑定（旧进程刚杀后，避免新进程 bind 冲突）
pub(crate) fn wait_port_closed(port: u16, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if port_bindable(port) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    log::warn!("[port-guard] 等待端口 {port} 释放超时");
}
