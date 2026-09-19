#!/usr/bin/env python3
"""IPC 命令执行上下文审计（护栏）

背景（docs/推理引擎架构重构方案.md 第 11 章）：
  Tauri 2 的**同步命令在主线程内联执行** —— 命令体内任何阻塞 I/O（HTTP 健康检查、起子进程、
  等超时、睡眠、大文件读写）都会冻结 UI（实测：2.1s 的同步命令会让主线程消息泵停摆 2.1s）；
  而**异步命令**在 tokio 上执行，此时构造/析构 `reqwest::blocking::Client`（内部自建 tokio
  Runtime）会 panic: "Cannot drop a runtime in a context where blocking is not allowed"。

规则：
  R1  同步命令（主线程）不得可达阻塞原语 → 须改 async + spawn_blocking（或 std::thread）
  R2  异步命令体内不得在**无线程边界**的情况下构造阻塞 HTTP client

判定方式：按函数名归并源码（同名跨 impl 求并集，过近似多报由 EXEMPT/PENDING 显式收口），
构建传递闭包；遇到后台边界（std::thread::spawn / spawn_blocking / std::thread::scope）停止传播。

用法：python scripts/audit-command-context.py [src-tauri/src]
退出码：0 合规 / 1 有新增违规或白名单过期 / 2 路径错误
"""
from __future__ import annotations

import re
import sys
import pathlib

# ── 待修白名单：已知违规 + 原因。修完后**必须删除条目**（否则脚本报"白名单过期"）──────────
# 当前为空：§11.5 的 IPC 整改已全部落地（同步命令 → async + spawn_blocking；
# 旧 HF 直连死命令 hf_download_file / hf_download_as_string / hf_download_multiple 已删除）。
PENDING: dict[str, str] = {}

# ── 已确认接受的例外 ────────────────────────────────────────────────────────────
# 仅涉及**配置 / 历史等小文件**（KB 级、单次读写）或**纯路径存在性检查**的同步命令：
# 主线程耗时为亚毫秒量级，不构成 UI 冻结风险。若未来出现大文件/网络/进程操作，必须移除本表条目。
EXEMPT: dict[str, str] = {
    "get_data_dir": "仅返回路径字符串（无实际 IO）",
    "read_data_file": "读取配置/历史小文件（KB 级）",
    "write_data_file": "写入配置/历史小文件（KB 级）",
    "remove_data_file": "删除单个小文件",
    "get_data_root_info": "读取数据根配置（小文件）",
    "rust_storage_model_root": "写入模型根配置（小文件）",
    "check_runtime": "仅路径存在性检查（无 HTTP/进程/大文件）",
}

# 允许阻塞的后台边界：据此判定"阻塞工作已交给后台"
BOUNDARIES = ("std::thread::spawn", "spawn_blocking", "std::thread::scope")

# R2 种子：构造阻塞 HTTP client（自带 tokio Runtime）
BLOCKING_CLIENT_BUILD = "reqwest::blocking::Client::builder"


def prims_in(body: str) -> set[str]:
    """R1 种子：主线程禁止的阻塞原语（构造 client 不在此列 —— 主线程构造是安全的）"""
    out: set[str] = set()
    if ".send()" in body:
        out.add("发起 HTTP 请求（阻塞等待响应）")
    if "Command::new" in body:
        out.add("起子进程")
    if "wait_with_output" in body:
        out.add("等子进程结束")
    if "connect_timeout" in body or "TcpStream::connect" in body:
        out.add("TCP 连接等待")
    if "thread::sleep" in body:
        out.add("睡眠")
    if "Instant::now" in body:
        out.add("超时轮询")
    if "fs::read" in body or "fs::write" in body or "std::fs::" in body:
        out.add("文件 IO")
    return out


def extract_fns(root: pathlib.Path) -> tuple[dict[str, str], dict[str, bool]]:
    """函数名 → 函数体（花括号配对）；同名函数体求并集（方法名近似的代价，多报可收口）。"""
    fns: dict[str, str] = {}
    for f in sorted(root.rglob("*.rs")):
        src = f.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r"\bfn\s+(\w+)\s*[(<]", src):
            i = src.find("{", m.end())
            if i < 0:
                continue
            depth = 0
            for j in range(i, len(src)):
                if src[j] == "{":
                    depth += 1
                elif src[j] == "}":
                    depth -= 1
                    if depth == 0:
                        fns[m.group(1)] = fns.get(m.group(1), "") + src[i : j + 1]
                        break
    boundaries = {n: any(b in body for b in BOUNDARIES) for n, body in fns.items()}
    return fns, boundaries


def closure(
    fns: dict[str, str], boundaries: dict[str, bool], seed
) -> dict[str, set[str]]:
    """传递闭包：命令可达的种子集合。被调函数自身带后台边界则停止传播。"""
    reach = {n: seed(b) for n, b in fns.items()}
    changed = True
    while changed:
        changed = False
        for name, body in fns.items():
            for callee in set(re.findall(r"(\w+)\s*\(", body)):
                if callee == name or callee not in reach or boundaries.get(callee):
                    continue
                add = reach[callee] - reach[name]
                if add:
                    reach[name] |= add
                    changed = True
    return reach


def iter_commands(root: pathlib.Path):
    for f in sorted(root.rglob("*.rs")):
        src = f.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r"#\[tauri::command\]", src):
            seg = src[m.end() : m.end() + 600]
            fm = re.search(r"\b(async\s+)?fn\s+(\w+)\s*[(<]", seg)
            if fm:
                yield bool(fm.group(1)), fm.group(2), f.as_posix()


def main() -> int:
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "src-tauri/src")
    if not root.exists():
        print(f"[audit] 路径不存在: {root}", file=sys.stderr)
        return 2

    fns, boundaries = extract_fns(root)
    r1_reach = closure(fns, boundaries, prims_in)
    r2_reach = closure(
        fns, boundaries, lambda b: {BLOCKING_CLIENT_BUILD} if BLOCKING_CLIENT_BUILD in b else set()
    )

    violations: list[tuple[str, str, str]] = []
    for is_async, name, _path in iter_commands(root):
        body = fns.get(name, "")
        if not is_async:
            hits = r1_reach.get(name, set())
            if hits:
                violations.append(("R1", name, " + ".join(sorted(hits))))
        elif not boundaries.get(name) and r2_reach.get(name):
            violations.append(("R2", name, "异步体内构造阻塞 HTTP client（析构即 panic）"))

    new = [v for v in violations if v[1] not in PENDING and v[1] not in EXEMPT]
    exempted = [v for v in violations if v[1] in EXEMPT]
    pending = [v for v in violations if v[1] in PENDING]
    stale = [n for n in PENDING if not any(v[1] == n for v in violations)]

    print(
        f"[audit] {root}：违规 {len(violations)} 个"
        f"（待修白名单 {len(pending)}，例外 {len(exempted)}，新增 {len(new)}）"
    )
    for rule, name, detail in violations:
        if name in PENDING:
            tag = "待修"
        elif name in EXEMPT:
            tag = f"例外·{EXEMPT[name]}"
        else:
            tag = "★ 新增"
        print(f"  [{rule}] {name:<28} {detail}   ({tag})")

    if stale:
        print("\n[audit] 白名单已过期（这些命令已合规，请从 PENDING 删除）：")
        for n in stale:
            print(f"  - {n}")

    if new or stale:
        print(
            "\n[audit] 失败。规则见 docs/推理引擎架构重构方案.md 11.3", file=sys.stderr
        )
        return 1
    print("\n[audit] 通过：无新增违规")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
