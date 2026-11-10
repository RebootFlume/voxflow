// VoxFlow 启动器（InnoSetup 版根目录 exe）
//
// 为什么需要它：InnoSetup 打出来的根目录 exe 只是一层壳，Electron 本体在 bin\ 下。
// 壳要做的事很窄 —— 找到 bin\ 里的 Electron、把它拉起来、转发退出码。
// 故意不碰别的事：单实例、托盘、数据根全部由 Electron 自己管。
//
// ── 为什么不能省 ────────────────────────────────────────────────────────
// InnoSetup 本身是原生程序、不需要 .NET，但**它不会替你造启动器**。
// 目录布局要求 exe 在根、Electron 在 bin\ —— 根目录那个 exe 必须由别的东西产生。
// 两个选择：C#（本文件，csc 编译，需 .NET Framework）或原生 C（需 MSVC）。
// 选 C# 是因为 csc 是 Windows 自带组件，打包机零安装；MSVC 要多装 2GB。
//
// 若哪天放弃「根 exe + bin\」布局，改让 Electron 主程序直接放根目录，
// 这个文件连同 appRootDir() 都能删掉 —— electron-builder 原生就是这样。
//
// 编译：.NET Framework 4 的 csc（系统自带）
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
//   /target:winexe /win32icon:build\icon.ico /out:VoxFlowLauncher.exe VoxFlowLauncher.cs
//
// 为什么要 winexe：带 /target:winexe 就不弹控制台窗口。
//
// 关键约定（与 src/main/core/data-root.ts 对应）：
//   - Electron 在 <root>\bin\ 下
//   - 数据根/运行时在 <root>\ 下：data\ 、libs\ 、portable.txt
//   - 启动器从 exe 所在目录往上找 bin\ ，找到即认定 <root>

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class VoxFlowLauncher
{
    /// <summary>根目录：exe 所在目录的父目录（InnoSetup 把 exe 放在根、Electron 放在 bin\）。</summary>
    private static string FindRoot()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;

        // 正常形态：<root>\VoxFlow.exe + <root>\bin\VoxFlow.exe
        for (int i = 0; i < 4; i++)
        {
            string candidate = Path.Combine(dir, "bin");
            if (Directory.Exists(candidate) && HasElectron(candidate))
            {
                return dir;
            }
            DirectoryInfo parent = Directory.GetParent(dir);
            if (parent == null) break;
            dir = parent.FullName;
        }
        return null;
    }

    /// <summary>bin\ 下是否有 Electron 可执行文件。</summary>
    private static bool HasElectron(string binDir)
    {
        foreach (string name in new[] { "VoxFlow.exe", "voxflow.exe", "electron.exe" })
        {
            if (File.Exists(Path.Combine(binDir, name))) return true;
        }
        return false;
    }

    private static string FindElectron(string binDir)
    {
        foreach (string name in new[] { "VoxFlow.exe", "voxflow.exe", "electron.exe" })
        {
            string p = Path.Combine(binDir, name);
            if (File.Exists(p)) return p;
        }
        return null;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModeID(string appID);

    [STAThread]
    private static int Main(string[] args)
    {
        // 与 electron-builder 的 appId 一致：让任务栏/Alt+Tab 归到同一个应用，
        // 否则 Electron 窗口会被归到 "electron.exe" 分组。
        try { SetCurrentProcessExplicitAppUserModeID("com.voxflow.app"); }
        catch { /* 老系统不支持，忽略 */ }

        string root = FindRoot();
        if (root == null)
        {
            MessageBox.Show(
                "找不到 bin\\ 目录下的 VoxFlow.exe。\n\n" +
                "请确认安装完整（安装版请重新安装，便携版请重新解压整个压缩包）。",
                "VoxFlow", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        string binDir = Path.Combine(root, "bin");
        string exe = FindElectron(binDir);
        if (exe == null)
        {
            MessageBox.Show(
                "bin\\ 下没有可执行文件（VoxFlow.exe）。\n\n请重新安装或重新解压。",
                "VoxFlow", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        // 工作目录设为 bin\：Electron 里 process.cwd() 会指向它。
        // 注意这**不影响**数据根 —— 数据根由 portable.txt 决定，与 cwd 无关。
        ProcessStartInfo psi = new ProcessStartInfo
        {
            FileName = exe,
            WorkingDirectory = binDir,
            UseShellExecute = false
        };
        // 原样转发命令行参数
        foreach (string a in args) psi.Arguments = AppendArg(psi.Arguments, a);

        try
        {
            using (Process proc = Process.Start(psi))
            {
                if (proc == null) return 1;
                proc.WaitForExit();
                return proc.ExitCode;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "启动失败：" + ex.Message,
                "VoxFlow", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    /// <summary>拼接命令行参数（加引号，避免路径含空格时被拆开）。</summary>
    private static string AppendArg(string existing, string arg)
    {
        string piece = "\"" + arg.Replace("\"", "\\\"") + "\"";
        return string.IsNullOrEmpty(existing) ? piece : existing + " " + piece;
    }
}
