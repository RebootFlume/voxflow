//! TTS 引擎注册表（路由 + 互斥，镜像 inference::registry）
//!
//! 取代 `TtsService` 大 if/else 分发器（方案文档 4.2）：
//! - 持有 `EngineSlot<dyn TtsEngine>`：按描述符 framework 路由，互斥（同一时间一个引擎）。
//! - 命令层只调本注册表，不感知具体框架（sherpa / 未来 pytorch）。
//! - 加引擎 = 在 `new()` 注册一行（trait + 引擎实现，无 if/else）。

use std::path::PathBuf;
use std::sync::Arc;

use crate::inference::slot::{EngineSlot, SlotEngine};
use crate::model_manager::{ModelFormat, find_main_model_file};
use crate::tts::engine::sherpa::SherpaTtsEngine;
use crate::tts::spec::{BackendSpec, ModelSpec};
use crate::tts::traits::TtsEngine;

/// TtsEngine 接入 EngineSlot 最小接口（按 trait 对象实现，避免与 ASR 的 blanket impl 冲突）
impl SlotEngine for dyn TtsEngine {
    fn slot_loaded(&self) -> bool {
        self.is_loaded()
    }
    fn slot_unload(&self) -> Result<(), String> {
        self.unload().map_err(|e| e.to_string())
    }
    fn slot_model(&self) -> String {
        self.name().to_string()
    }
}

/// TTS 引擎注册表
pub struct TtsRegistry {
    slot: EngineSlot<dyn TtsEngine>,
}

impl Default for TtsRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl TtsRegistry {
    pub fn new() -> Self {
        Self {
            slot: EngineSlot::new(vec![(
                "sherpa",
                Arc::new(SherpaTtsEngine::new()) as Arc<dyn TtsEngine>,
            )]),
        }
    }

    /// 描述符 → 框架标识（路由依据；加新框架在此扩展，模型差异全在 spec）
    fn framework_for(spec: &ModelSpec) -> Option<&'static str> {
        match spec.backend {
            BackendSpec::SherpaTts(_) => Some("sherpa"),
            _ => None,
        }
    }

    /// 加载模型（唯一权威路由）：spec 查找 → 框架 → 互斥卸载其他 → 引擎加载。
    /// `model` 接受展示名 / id / 目录名（归一化，见 spec::find）。
    /// 返回 (framework, model_name)。
    pub fn load(&self, model: &str, device: &str) -> Result<(&'static str, String), String> {
        let spec = ModelSpec::find(model)
            .ok_or_else(|| format!("未知模型: {model}"))?;
        let framework = Self::framework_for(&spec)
            .ok_or_else(|| format!("{model} 不是 TTS 模型"))?;
        let engine = self
            .slot
            .engine(framework)
            .ok_or_else(|| format!("框架 {framework} 未注册"))?;

        // 互斥：先卸载其他框架的引擎
        self.slot.unload_others(framework);

        // 主模型文件（models_root / spec.id / model.onnx 等）
        let dir = crate::model_manager::get_model_root().join(spec.id);
        let main_file = find_main_model_file(&dir, &ModelFormat::Onnx)
            .ok_or_else(|| format!("模型 {} 缺少 ONNX 文件", spec.name))?;

        engine.load(&main_file, device).map_err(|e| e.to_string())?;
        Ok((framework, spec.name.to_string()))
    }

    /// 卸载当前引擎（未加载则 no-op）
    pub fn unload(&self) -> Result<(), String> {
        if let Some((_, engine)) = self.slot.active() {
            engine.unload().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 当前引擎是否已加载
    pub fn is_loaded(&self) -> bool {
        self.slot.active().is_some()
    }

    /// 当前加载的模型名（空 = 未加载）
    pub fn loaded_model(&self) -> String {
        self.slot
            .active()
            .map(|(_, e)| e.name().to_string())
            .unwrap_or_default()
    }

    /// 当前加载的框架标识（"sherpa" / 空）
    pub fn active_framework(&self) -> &'static str {
        self.slot.active().map(|(f, _)| f).unwrap_or("")
    }

    /// 当前引擎（调用方直接调 trait 方法；未加载返回 None）
    pub fn active(&self) -> Option<Arc<dyn TtsEngine>> {
        self.slot.active().map(|(_, e)| e)
    }

    /// 显存估算（MB）
    pub fn vram_mb(&self) -> Option<u64> {
        self.slot.active().and_then(|(_, e)| e.vram_estimate_mb())
    }

    /// 模型目录（供 speakers.json 等按 spec 读取）
    pub fn model_dir(&self, spec_id: &str) -> PathBuf {
        crate::model_manager::get_model_root().join(spec_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_registry_empty() {
        let r = TtsRegistry::new();
        assert!(!r.is_loaded());
        assert_eq!(r.loaded_model(), "");
        assert_eq!(r.active_framework(), "");
    }

    #[test]
    fn test_load_unknown_model_errors() {
        let r = TtsRegistry::new();
        assert!(r.load("bogus-model", "cpu").is_err());
    }

    #[test]
    fn test_framework_for_unknown_backend() {
        // ASR 后端（Llama/SherpaWs）不是 TTS → None
        let spec = ModelSpec::find("Qwen3-ASR-0.6B").unwrap();
        assert_eq!(TtsRegistry::framework_for(spec), None);
        let spec = ModelSpec::find("Kokoro-v1_0").unwrap();
        assert_eq!(TtsRegistry::framework_for(spec), Some("sherpa"));
    }
}
