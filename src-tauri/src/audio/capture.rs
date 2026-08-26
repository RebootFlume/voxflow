//! 音频采集（麦克风输入）— cpal 实现
//!
//! 替代 Python 的 sounddevice.InputStream。
//! `start()` 创建 cpal 输入流并持续采集到内存 buffer（自动重采样到 16kHz mono），
//! `stop()` 停止采集并返回全部采样。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::resample::resample_linear;
use super::to_mono;

/// 录音状态（仅在工作线程内使用，无需 Send）
pub struct AudioCapture {
    recording: Arc<AtomicBool>,
    chunks: Arc<Mutex<Vec<Vec<f32>>>>,
    sample_rate: u32,
    stream: Option<cpal::Stream>,
}

impl AudioCapture {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            recording: Arc::new(AtomicBool::new(false)),
            chunks: Arc::new(Mutex::new(Vec::new())),
            sample_rate,
            stream: None,
        }
    }

    /// 开始录音（创建 cpal 输入流，持续采集到 chunks）
    pub fn start(&mut self) -> Result<(), String> {
        if self.recording.load(Ordering::SeqCst) {
            return Ok(());
        }

        // 清理上次残留
        self.chunks.lock().map_err(|e| e.to_string())?.clear();

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "no default input device".to_string())?;
        let config = device
            .default_input_config()
            .map_err(|e| format!("input config: {e}"))?;

        let input_rate = config.sample_rate().0;
        let channels = config.channels() as usize;
        let target_rate = self.sample_rate;
        let recording = self.recording.clone();
        let chunks = self.chunks.clone();

        let err_fn = move |err| {
            eprintln!("[capture] stream error: {err}");
        };

        // 构建输入流回调：收集样本 → mono → 重采样到目标采样率 → push chunk
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _| {
                        if !recording.load(Ordering::SeqCst) {
                            return;
                        }
                        let mono = if channels > 1 { to_mono(data, channels) } else { data.to_vec() };
                        let out = resample_linear(&mono, input_rate, target_rate);
                        if let Ok(mut c) = chunks.lock() {
                            c.push(out);
                        }
                    },
                    err_fn,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                device.build_input_stream(
                    &config.into(),
                    move |data: &[i16], _| {
                        if !recording.load(Ordering::SeqCst) {
                            return;
                        }
                        let mono = if channels > 1 {
                            to_mono_i16(data, channels)
                        } else {
                            data.to_vec()
                        };
                        let f: Vec<f32> = mono.iter().map(|&s| s as f32 / 32768.0).collect();
                        let out = resample_linear(&f, input_rate, target_rate);
                        if let Ok(mut c) = chunks.lock() {
                            c.push(out);
                        }
                    },
                    err_fn,
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                device.build_input_stream(
                    &config.into(),
                    move |data: &[u16], _| {
                        if !recording.load(Ordering::SeqCst) {
                            return;
                        }
                        let mono = if channels > 1 { to_mono_u16(data, channels) } else { data.to_vec() };
                        let f: Vec<f32> = mono.iter().map(|&s| s as f32 / 32768.0 - 1.0).collect();
                        let out = resample_linear(&f, input_rate, target_rate);
                        if let Ok(mut c) = chunks.lock() {
                            c.push(out);
                        }
                    },
                    err_fn,
                    None,
                )
            }
            other => {
                return Err(format!("unsupported sample format: {other:?}"));
            }
        }
        .map_err(|e| format!("build input stream: {e}"))?;

        stream
            .play()
            .map_err(|e| format!("stream play: {e}"))?;

        self.stream = Some(stream);
        self.recording.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// 停止录音，返回所有录音数据（float32 mono, 目标采样率）
    pub fn stop(&mut self) -> Result<Vec<f32>, String> {
        self.recording.store(false, Ordering::SeqCst);
        if let Some(stream) = self.stream.take() {
            let _ = stream.pause();
        }
        let mut chunks = self.chunks.lock().map_err(|e| e.to_string())?;
        let all: Vec<f32> = chunks.drain(..).flatten().collect();
        Ok(all)
    }

    /// 是否正在录音
    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::SeqCst)
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

fn to_mono_i16(data: &[i16], channels: usize) -> Vec<i16> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|frame| frame.iter().sum::<i16>() / channels as i16)
        .collect()
}

fn to_mono_u16(data: &[u16], channels: usize) -> Vec<u16> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|frame| frame.iter().sum::<u16>() / channels as u16)
        .collect()
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
