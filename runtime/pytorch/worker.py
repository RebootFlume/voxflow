"""VoxFlow PyTorch runtime worker.

长驻子进程：Rust 主程序通过 stdin/stdout 逐行 JSON 与之通信。

设计约束（与 docs/PyTorch推理框架技术方案.md 一致）：
- 模型目录**不得携带可执行代码**：worker 只接受编译进本文件的 adapter 白名单 id，
  由 Rust 侧的模型描述符下发；模型目录只提供权重与配置。
- 音频走临时 WAV 路径（首版），不引入 torchaudio（2.14.0 无 Windows 轮子）。
- 所有权重读取都用 `weights_only=True`，不反序列化任意对象。
- 任何异常都转成结构化错误（kind + message），绝不把 traceback 直接当协议输出。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import wave
from typing import Any, Callable, Optional

PROTOCOL_VERSION = 1

# 采样率约定
ASR_SAMPLE_RATE = 16000
TTS_SAMPLE_RATE = 24000


def response(request_id: Any, *, ok: bool, result: Any = None, error: Any = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"id": request_id, "ok": ok, "protocol": PROTOCOL_VERSION}
    if ok:
        payload["result"] = result
    else:
        payload["error"] = error or {"kind": "worker_error", "message": "unknown worker error"}
    return payload


class WorkerError(Exception):
    """带错误类别的业务异常（协议里以 kind 暴露给上层）"""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


def runtime_info() -> dict[str, Any]:
    import torch

    return {
        "python": sys.version.split()[0],
        "torch": torch.__version__,
        "cuda_available": bool(torch.cuda.is_available()),
        "cuda_version": torch.version.cuda,
        "device_count": torch.cuda.device_count(),
    }


def smoke_test() -> dict[str, Any]:
    import torch

    left = torch.tensor([1.0, 2.0, 3.0])
    right = torch.tensor([4.0, 5.0, 6.0])
    result = torch.sum(left * right).item()
    if result != 32.0:
        raise RuntimeError(f"unexpected tensor result: {result}")
    return {"status": "ready", "tensor_result": result, **runtime_info()}


# ── 音频 ──────────────────────────────────────────────────────────────────────


def read_wav(path: str, target_rate: int) -> "Any":
    """读单声道 WAV；必要时线性重采样到 target_rate（不引入 torchaudio）。"""
    import numpy as np

    with wave.open(path, "rb") as w:
        channels, width, rate, frames = (
            w.getnchannels(),
            w.getsampwidth(),
            w.getframerate(),
            w.getnframes(),
        )
        raw = w.readframes(frames)
    if width != 2:
        raise WorkerError("io_error", f"只支持 16-bit PCM WAV，实际 {width * 8} bit")
    audio = np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != target_rate and audio.size > 1:
        n = int(round(audio.size * target_rate / rate))
        audio = np.interp(
            np.linspace(0.0, audio.size - 1, n), np.arange(audio.size), audio
        ).astype("float32")
    return audio


def write_wav(path: str, samples: "Any", rate: int) -> None:
    import numpy as np

    clipped = np.clip(np.asarray(samples, dtype="float32"), -1.0, 1.0)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((clipped * 32767.0).astype("<i2").tobytes())


# ── 模型适配器（白名单；模型目录不得携带代码）────────────────────────────────


class Adapter:
    id: str = ""

    def __init__(self, device: str):
        import torch

        self.device = device
        self.torch = torch

    def load(self, model_dir: str, options: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def unload(self) -> None:
        self.model = None

    def _target_device(self):
        if self.device == "cuda":
            if not self.torch.cuda.is_available():
                raise WorkerError("device_unavailable", "CUDA 不可用（驱动或设备问题）")
            return self.torch.device("cuda")
        return self.torch.device("cpu")


class WhisperAdapter(Adapter):
    """Whisper（transformers）ASR 适配器。"""

    id = "whisper"

    def load(self, model_dir: str, options: dict[str, Any]) -> dict[str, Any]:
        from transformers import WhisperForConditionalGeneration, WhisperProcessor

        if not (model_dir and __import__("os").path.isdir(model_dir)):
            raise WorkerError("model_load_failed", f"模型目录不存在: {model_dir}")
        t0 = time.time()
        self.processor = WhisperProcessor.from_pretrained(model_dir)
        dtype = self.torch.float16 if self.device == "cuda" else self.torch.float32
        self.model = WhisperForConditionalGeneration.from_pretrained(model_dir, dtype=dtype)
        self.model.to(self._target_device()).eval()
        return {"load_seconds": round(time.time() - t0, 2), "dtype": str(dtype).split(".")[-1]}

    def transcribe(self, samples: "Any", options: dict[str, Any]) -> dict[str, Any]:
        t0 = time.time()
        features = self.processor(
            samples, sampling_rate=ASR_SAMPLE_RATE, return_tensors="pt"
        ).input_features.to(self._target_device())
        if self.device == "cuda":
            features = features.half()
        kwargs: dict[str, Any] = {"max_new_tokens": 256}
        language = options.get("language")
        if language:
            kwargs.update(generate_kwargs_language(language))
        prompt = options.get("context")
        if prompt:
            kwargs["prompt_ids"] = self.processor.get_prompt_ids(prompt, return_tensors="pt").to(
                self._target_device()
            )
        with self.torch.no_grad():
            ids = self.model.generate(features, **kwargs)
        text = self.processor.batch_decode(ids, skip_special_tokens=True)[0].strip()
        return {"text": text, "seconds": round(time.time() - t0, 2)}

    def unload(self) -> None:
        self.model = None
        self.processor = None
        if self.torch.cuda.is_available():
            self.torch.cuda.empty_cache()


def generate_kwargs_language(language: str) -> dict[str, Any]:
    """Whisper 的语言参数名随版本变化（language / forced_decoder_ids），两版都兼容。"""
    code = {"zh": "chinese", "en": "english"}.get(language.lower(), language)
    return {"language": code, "task": "transcribe"}


class KokoroAdapter(Adapter):
    """Kokoro-82M (PyTorch) TTS 适配器：vendored KModel + misaki 中文 G2P。"""

    id = "kokoro"

    def load(self, model_dir: str, options: dict[str, Any]) -> dict[str, Any]:
        import os

        import torch

        from voxflow_kokoro import KModel

        config = os.path.join(model_dir, "config.json")
        weights = None
        for name in os.listdir(model_dir) if os.path.isdir(model_dir) else []:
            if name.endswith(".pth"):
                weights = os.path.join(model_dir, name)
                break
        if not (os.path.isfile(config) and weights):
            raise WorkerError(
                "model_load_failed", f"Kokoro 模型目录缺少 config.json 或 *.pth: {model_dir}"
            )
        t0 = time.time()
        self.model = KModel(config=config, model=weights).to(self._target_device()).eval()
        self.voice_dir = os.path.join(model_dir, "voices")
        self.voices: dict[str, Any] = {}
        self.g2p = None
        return {
            "load_seconds": round(time.time() - t0, 2),
            "has_voices": os.path.isdir(self.voice_dir),
        }

    def _g2p(self):
        if self.g2p is None:
            try:
                from misaki import zh
            except ImportError as exc:  # pragma: no cover - 运行时缺依赖时的可读错误
                raise WorkerError(
                    "model_load_failed", f"缺少中文 G2P 依赖 misaki[zh]: {exc}"
                ) from exc
            self.g2p = zh.ZHG2P()
        return self.g2p

    def _voice(self, name: str):
        import os

        if name in self.voices:
            return self.voices[name]
        path = os.path.join(self.voice_dir, f"{name}.pt")
        if not os.path.isfile(path):
            raise WorkerError("bad_request", f"音色不存在: {path}")
        pack = self.torch.load(path, weights_only=True)
        self.voices[name] = pack
        return pack

    def synthesize(self, text: str, options: dict[str, Any]) -> dict[str, Any]:
        t0 = time.time()
        voice = options.get("voice") or "zf_xiaobei"
        speed = float(options.get("speed") or 1.0)
        pack = self._voice(voice)
        phonemes, _ = self._g2p()(text)
        phonemes = phonemes[:510]
        if not phonemes:
            raise WorkerError("bad_request", "文本转换后没有音素（可能全是标点/空白）")
        with self.torch.no_grad():
            out = self.model(phonemes, pack[len(phonemes) - 1], speed, return_output=True)
        audio = out.audio.detach().cpu().numpy().astype("float32")
        return {
            "samples": audio,
            "sample_rate": TTS_SAMPLE_RATE,
            "seconds": round(time.time() - t0, 2),
            "phonemes": len(phonemes),
            "voice": voice,
        }

    def unload(self) -> None:
        self.model = None
        self.voices = {}
        if self.torch.cuda.is_available():
            self.torch.cuda.empty_cache()


ADAPTERS: dict[str, type[Adapter]] = {
    "whisper": WhisperAdapter,
    "kokoro": KokoroAdapter,
}


# ── 会话状态（单线程循环，无需加锁）──────────────────────────────────────────


class Session:
    def __init__(self) -> None:
        self.adapter: Optional[Adapter] = None
        self.model_dir: str = ""
        self.device: str = ""

    def load(self, params: dict[str, Any]) -> dict[str, Any]:
        adapter_id = str(params.get("adapter") or "")
        if adapter_id not in ADAPTERS:
            raise WorkerError(
                "unsupported_adapter",
                f"未知适配器 {adapter_id!r}；运行时内置: {sorted(ADAPTERS)}",
            )
        model_dir = str(params.get("model_dir") or "")
        device = str(params.get("device") or "cpu").lower()
        if device not in ("cpu", "cuda"):
            raise WorkerError("bad_request", f"不支持的设备: {device}")
        # 幂等：同 adapter + 同目录 + 同设备直接复用
        if (
            self.adapter is not None
            and self.adapter.id == adapter_id
            and self.model_dir == model_dir
            and self.device == device
        ):
            return {"adapter": adapter_id, "device": device, "model_dir": model_dir, "reused": True}
        self.unload()
        adapter = ADAPTERS[adapter_id](device)
        extra = adapter.load(model_dir, params.get("options") or {})
        self.adapter, self.model_dir, self.device = adapter, model_dir, device
        return {"adapter": adapter_id, "device": device, "model_dir": model_dir, **extra}

    def unload(self) -> dict[str, Any]:
        had = self.adapter is not None
        if self.adapter is not None:
            self.adapter.unload()
        self.adapter, self.model_dir, self.device = None, "", ""
        return {"unloaded": had}

    def _require(self, task: str) -> Adapter:
        if self.adapter is None:
            raise WorkerError("not_loaded", "尚未加载模型，请先调用 load_model")
        want = {"transcribe": (WhisperAdapter,), "synthesize": (KokoroAdapter,)}.get(task, ())
        if want and not isinstance(self.adapter, want):
            raise WorkerError(
                "bad_request",
                f"当前适配器 {self.adapter.id} 不支持 {task}",
            )
        return self.adapter

    def transcribe(self, params: dict[str, Any]) -> dict[str, Any]:
        adapter = self._require("transcribe")
        wav = str(params.get("wav") or "")
        if not wav:
            raise WorkerError("bad_request", "缺少 wav 路径")
        samples = read_wav(wav, ASR_SAMPLE_RATE)
        out = adapter.transcribe(samples, params.get("options") or {})
        return {"adapter": adapter.id, "sample_count": int(samples.size), **out}

    def synthesize(self, params: dict[str, Any]) -> dict[str, Any]:
        adapter = self._require("synthesize")
        text = str(params.get("text") or "").strip()
        if not text:
            raise WorkerError("bad_request", "缺少待合成文本")
        out_wav = str(params.get("out_wav") or "")
        if not out_wav:
            raise WorkerError("bad_request", "缺少 out_wav 路径")
        out = adapter.synthesize(text, params.get("options") or {})
        write_wav(out_wav, out.pop("samples"), out["sample_rate"])
        out["wav"] = out_wav
        out["audio_seconds"] = round(
            _wav_frames(out_wav) / float(out["sample_rate"]), 2
        )
        return {"adapter": adapter.id, **out}


def _wav_frames(path: str) -> int:
    with wave.open(path, "rb") as w:
        return w.getnframes()


SESSION = Session()


def handle(request: dict[str, Any]) -> dict[str, Any]:
    request_id = request.get("id")
    method = request.get("method")
    params = request.get("params") or {}
    if not isinstance(params, dict):
        raise WorkerError("bad_request", "params 必须是对象")

    if method == "ping":
        return response(request_id, ok=True, result={"status": "ready"})
    if method == "runtime_info":
        return response(request_id, ok=True, result={**runtime_info(), **_state()})
    if method == "smoke_test":
        return response(request_id, ok=True, result=smoke_test())
    if method == "load_model":
        return response(request_id, ok=True, result=SESSION.load(params))
    if method == "unload_model":
        return response(request_id, ok=True, result=SESSION.unload())
    if method == "transcribe":
        return response(request_id, ok=True, result=SESSION.transcribe(params))
    if method == "synthesize":
        return response(request_id, ok=True, result=SESSION.synthesize(params))
    if method == "shutdown":
        SESSION.unload()
        return response(request_id, ok=True, result={"status": "stopping"})
    raise WorkerError("unsupported_command", f"未知命令: {method!r}")


def _state() -> dict[str, Any]:
    return {
        "adapters": sorted(ADAPTERS),
        "loaded": SESSION.adapter.id if SESSION.adapter is not None else "",
        "loaded_model_dir": SESSION.model_dir,
        "loaded_device": SESSION.device,
    }


def serve() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id: Any = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise WorkerError("bad_request", "请求必须是 JSON 对象")
            request_id = request.get("id")
            payload = handle(request)
            print(json.dumps(payload, ensure_ascii=False, default=str), flush=True)
            if request.get("method") == "shutdown":
                return 0
        except WorkerError as exc:
            print(
                json.dumps(
                    response(request_id, ok=False, error={"kind": exc.kind, "message": exc.message}),
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as exc:  # 任何未预期异常都必须变成结构化错误
            print(
                json.dumps(
                    response(
                        request_id,
                        ok=False,
                        error={"kind": "worker_error", "message": f"{type(exc).__name__}: {exc}"},
                    ),
                    ensure_ascii=False,
                ),
                flush=True,
            )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="VoxFlow PyTorch runtime worker")
    parser.add_argument("--smoke-test", action="store_true")
    args = parser.parse_args()
    if args.smoke_test:
        try:
            result = smoke_test()
            print(json.dumps({"ok": True, "protocol": PROTOCOL_VERSION, "result": result}), flush=True)
            return 0
        except Exception as exc:
            print(json.dumps(response(None, ok=False, error={"kind": "smoke_test_failed", "message": str(exc)})), flush=True)
            return 1
    return serve()


if __name__ == "__main__":
    raise SystemExit(main())
