//! 音频采集（麦克风输入）
//!
//! 替代 Python 的 sounddevice.InputStream
//! 当前使用跨平台方案，后续可接入 cpal

use std::sync::{Arc, Mutex};
use cpal::traits::{HostTrait, DeviceTrait};

/// 录音状态
pub struct AudioCapture {
    recording: Arc<Mutex<bool>>,
    chunks: Arc<Mutex<Vec<Vec<f32>>>>,
    sample_rate: u32,
}

impl AudioCapture {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            recording: Arc::new(Mutex::new(false)),
            chunks: Arc::new(Mutex::new(Vec::new())),
            sample_rate,
        }
    }

    /// 开始录音（记录状态，实际录音由回调填充 chunks）
    pub fn start(&self) -> Result<(), String> {
        let mut recording = self.recording.lock().map_err(|e| e.to_string())?;
        let mut chunks = self.chunks.lock().map_err(|e| e.to_string())?;
        *recording = true;
        chunks.clear();
        Ok(())
    }

    /// 停止录音，返回所有录音数据（float32 mono, 16kHz）
    pub fn stop(&self) -> Result<Vec<f32>, String> {
        {
            let mut recording = self.recording.lock().map_err(|e| e.to_string())?;
            *recording = false;
        }
        let mut chunks = self.chunks.lock().map_err(|e| e.to_string())?;
        let all: Vec<f32> = chunks.drain(..).flatten().collect();
        Ok(all)
    }

    /// 推送音频数据（外部调用，如 sounddevice 回调）
    pub fn push_chunk(&self, data: &[f32]) -> Result<(), String> {
        let recording = self.recording.lock().map_err(|e| e.to_string())?;
        if !*recording {
            return Ok(());
        }
        drop(recording);
        let mut chunks = self.chunks.lock().map_err(|e| e.to_string())?;
        chunks.push(data.to_vec());
        Ok(())
    }

    /// 是否正在录音
    pub fn is_recording(&self) -> bool {
        self.recording.lock().map(|r| *r).unwrap_or(false)
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

/// 音频设备信息
#[derive(Debug, Clone)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub channels: u16,
    pub is_default: bool,
}

/// 列出可用音频输入设备（cpal 实现）
pub fn list_input_devices() -> Vec<AudioDevice> {
    let host = cpal::default_host();
    let default_input = host.default_input_device();
    let default_name = default_input.as_ref().and_then(|d| d.name().ok()).map(String::from);

    host.input_devices()
        .map(|devices| {
            devices
                .filter_map(|device| {
                    let name = device.name().ok()?.to_string();
                    let is_default = default_name.as_deref() == Some(&name);
                    Some(AudioDevice {
                        id: name.clone(),
                        name,
                        channels: device.default_input_config().ok().map(|c| c.channels()).unwrap_or(0),
                        is_default,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 获取默认输入设备名称
pub fn get_default_input_name() -> String {
    cpal::default_host()
        .default_input_device()
        .and_then(|d| d.name().ok().map(String::from))
        .unwrap_or_else(|| "system default".to_string())
}
