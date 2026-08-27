//! Windows 子进程控制台窗口隐藏工具
//!
//! 所有 spawn 外部程序（llama-server / sherpa / tar / powershell / ffmpeg 等）
//! 都应调用 `hide_console_window`，避免黑窗口弹出闪过。
//! 打包后（windows_subsystem = windows）尤其重要：子进程不隐藏会弹控制台。

#[cfg(windows)]
pub use std::os::windows::process::CommandExt;

/// Windows 上给 Command 加 CREATE_NO_WINDOW 标志（隐藏子进程控制台窗口）。
/// 非 Windows 平台为 no-op。
pub fn hide_console_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}
