//! 统一 ONNX 推理器
//!
//! 只负责「按 ModelManifest 组装输入 Tensor + 执行推理 + 提取音频」，
//! 不含任何模型特例（张量名、是否绑定 style/speed、输出节点名均来自 manifest）。

use super::super::config::ModelManifest;
use crate::errors::AppError;

/// 统一 ONNX 推理器（持有 session + manifest）
pub struct GenericOnnxEngine {
    session: ort::session::Session,
    manifest: ModelManifest,
}

impl GenericOnnxEngine {
    pub fn new(session: ort::session::Session, manifest: ModelManifest) -> Self {
        Self { session, manifest }
    }

    pub fn manifest(&self) -> &ModelManifest {
        &self.manifest
    }

    /// 按 manifest 组装输入并推理，返回 float32 音频采样
    pub fn run(
        &mut self,
        token_ids: &[i64],
        style: Option<&[f32]>,
        speed: Option<f32>,
    ) -> Result<Vec<f32>, AppError> {
        let mut inputs: Vec<(&str, ort::session::SessionInputValue)> = Vec::with_capacity(3);

        // tokens 张量（i64, [1, len]）
        let tokens_tensor = ort::value::Tensor::<i64>::from_array((
            [1, token_ids.len()],
            token_ids.to_vec().into_boxed_slice(),
        ))
        .map_err(|e| AppError::InferenceFailed(format!("tokens tensor: {e}")))?;
        inputs.push((self.manifest.inputs.tokens.name.as_str(), tokens_tensor.into()));

        // style 张量（可选；manifest 声明则必填 voice embedding）
        if let Some(spec) = &self.manifest.inputs.style {
            let data = style.ok_or_else(|| {
                AppError::InferenceFailed(
                    "manifest declares style input but no voice embedding available".to_string(),
                )
            })?;
            let t = ort::value::Tensor::<f32>::from_array(([1, 256], data.to_vec().into_boxed_slice()))
                .map_err(|e| AppError::InferenceFailed(format!("style tensor: {e}")))?;
            inputs.push((spec.name.as_str(), t.into()));
        }

        // speed 张量（可选）
        if let Some(spec) = &self.manifest.inputs.speed {
            let v = speed.unwrap_or(1.0);
            let t = ort::value::Tensor::<f32>::from_array(([1], vec![v].into_boxed_slice()))
                .map_err(|e| AppError::InferenceFailed(format!("speed tensor: {e}")))?;
            inputs.push((spec.name.as_str(), t.into()));
        }

        let output_names: Vec<String> = self.session.outputs().iter().map(|o| o.name().to_string()).collect();
        let outputs = self
            .session
            .run(inputs)
            .map_err(|e| AppError::InferenceFailed(format!("infer: {e}")))?;

        // 提取音频：优先 manifest.outputs 候选，其次任意第一个输出
        let audio_output = self
            .manifest
            .outputs
            .iter()
            .find_map(|name| outputs.get(name))
            .or_else(|| outputs.get("logits"))
            .or_else(|| output_names.first().and_then(|name| outputs.get(name.as_str())))
            .ok_or_else(|| {
                AppError::InferenceFailed(format!(
                    "no audio output tensor, available: {:?}",
                    output_names
                ))
            })?;

        let (_shape, audio_data) = audio_output
            .try_extract_tensor::<f32>()
            .map_err(|e| AppError::InferenceFailed(format!("extract: {e}")))?;

        Ok(audio_data.to_vec())
    }
}
