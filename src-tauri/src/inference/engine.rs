//! 推理引擎统一抽象 trait

use std::path::Path;

use super::errors::InferenceResult;

/// 推理引擎类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineKind {
    /// ONNX Runtime 推理（TTS、小模型）
    Onnx,
    /// llama.cpp GGUF 推理（LLM、ASR）
    LlamaCpp,
    /// llama-server 子进程（HTTP 推理）
    LlamaServer,
    /// Candle（纯 Rust，如 qwen3-asr-rs）
    Candle,
}

/// 推理设备
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Cpu,
    Cuda(u32),  // GPU 设备 ID
    Metal,       // Apple Silicon
    Directml,   // Windows DirectML
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

/// 推理输入
#[derive(Debug, Clone)]
pub enum InferInput {
    /// 音频数据（16kHz 单声道 float32）
    Audio {
        samples: Vec<f32>,
        sample_rate: u32,
    },
    /// 文本输入（用于 TTS）
    Text(String),
}

/// 推理输出
#[derive(Debug, Clone)]
pub enum InferOutput {
    /// ASR 转写文本
    Transcript {
        text: String,
        language: Option<String>,
    },
    /// TTS 合成音频（PCM 16bit, 24kHz mono）
    Audio {
        samples: Vec<i16>,
        sample_rate: u32,
    },
    /// 流式识别的中间结果
    PartialTranscript {
        text: String,
        is_final: bool,
    },
}

/// 推理引擎 trait：所有引擎实现此接口
pub trait InferenceEngine: Send + Sync {
    /// 引擎类型
    fn kind(&self) -> EngineKind;

    /// 加载模型
    fn load(&mut self, model_path: &Path, device: Device) -> InferenceResult<()>;

    /// 卸载模型（释放显存/内存）
    fn unload(&mut self) -> InferenceResult<()>;

    /// 模型是否已加载
    fn is_loaded(&self) -> bool;

    /// 获取当前模型名称
    fn model_name(&self) -> Option<&str>;

    /// 获取当前推理设备
    fn device(&self) -> Device;

    /// 执行推理
    fn infer(&mut self, input: &InferInput) -> InferenceResult<InferOutput>;
}

/// 音频处理器 trait：音频预处理（重采样、格式转换等）
pub trait AudioProcessor: Send + Sync {
    /// 音频格式解码（支持多种格式的字节流输入）
    fn decode(&self, data: &[u8]) -> InferenceResult<Vec<f32>>;

    /// 重采样到目标采样率
    fn resample(&self, samples: &[f32], from_rate: u32, to_rate: u32) -> InferenceResult<Vec<f32>>;

    /// float32 → int16 转换
    fn float_to_int16(samples: &[f32]) -> Vec<i16>;
}

/// ASR 引擎统一抽象：所有 ASR 框架（llama-server / sherpa-onnx / 未来 PyTorch）
/// 实现此 trait，注册到 `registry` 后即可被统一路由（加载/卸载/转写/显存估算）。
///
/// 设计目标（横向扩展）：新增一个 ASR 框架 = 新建一个文件实现此 trait +
/// 在 `registry::register` 注册一行。lib.rs / hotkey.rs / get_vram_status 等
/// 调用方只依赖此 trait + registry，不感知具体框架。
pub trait AsrEngine: Send + Sync {
    /// 引擎框架标识（gguf / onnx / pytorch）
    fn framework(&self) -> &'static str;

    /// 加载模型（按名称从注册表动态解析路径）
    fn load_model(&self, name: &str) -> Result<(), String>;

    /// 带设备参数的加载（cpu / cuda）。默认转发到 `load_model`（无设备感知），
    /// 支持设备切换的引擎覆写此方法（如 llama 的 -ngl、sherpa 的 --provider）。
    fn load_model_with_device(&self, name: &str, device: &str) -> Result<(), String> {
        let _ = device;
        self.load_model(name)
    }

    /// 带阶段回调的加载：stage ∈ {"unload", "loading", "ready"}
    fn load_model_with_stage(
        &self,
        name: &str,
        _on_stage: &mut dyn FnMut(&str),
    ) -> Result<(), String> {
        self.load_model(name)
    }

    /// 带阶段回调 + 设备的加载。默认转发到 `load_model_with_stage`（无设备感知），
    /// 支持设备切换的引擎覆写此方法。
    fn load_model_with_stage_and_device(
        &self,
        name: &str,
        device: &str,
        on_stage: &mut dyn FnMut(&str),
    ) -> Result<(), String> {
        let _ = device;
        self.load_model_with_stage(name, on_stage)
    }

    /// 卸载模型（释放显存/内存）
    fn unload(&self) -> Result<(), String>;

    /// 模型是否已加载（且可转写）
    fn is_loaded(&self) -> bool;

    /// 当前已加载模型名（空 = 未加载）
    fn current_model(&self) -> String;

    /// 转写音频
    fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String>;

    /// 估算当前模型显存占用（MB），用于显存监控（无权限时回退估算）
    fn vram_estimate_mb(&self) -> Option<u64>;
}
