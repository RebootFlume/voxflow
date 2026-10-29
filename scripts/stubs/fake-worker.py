"""假 PyTorch worker —— 只实现 JSON 协议，不依赖 torch。

用于验证 Electron 版 worker 客户端的握手 / 错误 / 超时 / 崩溃 / 协议不符等路径
（对齐 Rust 版 `pytorch.rs` 测试里的 "假 worker + 真解释器" 做法）。

行为由环境变量 `FAKE_MODE` 决定：
  ok            正常响应（默认）
  hang          收到任何请求都不回应（测超时）
  bad_protocol  响应里 protocol 写 2（测协议版本不符）
  crash         收到 transcribe 立刻退出（测崩溃）
  noisy         先 print 几行非协议内容再响应（测"非协议输出不当成响应"）
"""

from __future__ import annotations

import json
import os
import struct
import sys
import time
import wave

PROTOCOL_VERSION = 1
MODE = os.environ.get("FAKE_MODE", "ok")


def reply(req_id, ok=True, result=None, error=None):
    payload = {"id": req_id, "ok": ok, "protocol": PROTOCOL_VERSION}
    if ok:
        payload["result"] = result
    else:
        payload["error"] = error or {"kind": "worker_error", "message": "unknown"}
    return payload


def write_wav(path, frames, rate=24000):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<%dh" % len(frames), *frames))


def handle(req):
    method = req.get("method")
    params = req.get("params") or {}
    rid = req.get("id")

    if method == "ping":
        return reply(rid, result={"status": "ready"})
    if method == "runtime_info":
        return reply(
            rid,
            result={
                "python": "3.11.0",
                "torch": "2.14.0",
                "cuda_available": False,
                "cuda_version": None,
                "device_count": 0,
                "adapters": ["kokoro", "whisper"],
                "loaded": "",
                "loaded_model_dir": "",
                "loaded_device": "",
            },
        )
    if method == "load_model":
        adapter = str(params.get("adapter") or "")
        if adapter not in ("whisper", "kokoro"):
            return reply(
                rid,
                ok=False,
                error={
                    "kind": "unsupported_adapter",
                    "message": f"unknown adapter {adapter!r}",
                },
            )
        return reply(
            rid,
            result={
                "adapter": adapter,
                "device": params.get("device"),
                "model_dir": params.get("model_dir"),
                "load_seconds": 0.01,
            },
        )
    if method == "unload_model":
        return reply(rid, result={"unloaded": True})
    if method == "transcribe":
        if MODE == "crash":
            os._exit(1)
        return reply(
            rid,
            result={
                "adapter": "whisper",
                "sample_count": 16000,
                "text": "假 worker 的识别结果",
                "seconds": 0.01,
            },
        )
    if method == "synthesize":
        out = str(params.get("out_wav") or "")
        frames = [0] * 2400
        write_wav(out, frames)
        return reply(
            rid,
            result={
                "adapter": "kokoro",
                "wav": out,
                "sample_rate": 24000,
                "audio_seconds": 0.1,
                "voice": (params.get("options") or {}).get("voice", ""),
            },
        )
    if method == "shutdown":
        return reply(rid, result={"status": "stopping"})
    return reply(
        rid,
        ok=False,
        error={"kind": "unsupported_command", "message": f"unknown method {method!r}"},
    )


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            if MODE == "hang":
                time.sleep(120)
            if MODE == "noisy":
                print("some third-party library noise", flush=True)
                print("not json at all", flush=True)
            payload = handle(req)
            if MODE == "bad_protocol":
                payload["protocol"] = 2
            print(json.dumps(payload, ensure_ascii=False), flush=True)
            if req.get("method") == "shutdown":
                return 0
        except Exception as exc:  # 任何异常都变成结构化错误
            print(
                json.dumps(
                    reply(
                        rid,
                        ok=False,
                        error={"kind": "worker_error", "message": f"{type(exc).__name__}: {exc}"},
                    ),
                    ensure_ascii=False,
                ),
                flush=True,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
