//! 多格式音频解码验证（ffmpeg 子进程）
//! 生成测试音频 → decode_any 解码 → 断言非空

use std::process::Command;

fn gen_audio(path: &str, codec_args: &[&str]) {
    // 先用 ffmpeg 生成 WAV（1s 正弦波）
    let wav = std::env::temp_dir().join("voxflow_gen.wav");
    Command::new("ffmpeg")
        .args(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1"])
        .arg(&wav)
        .output()
        .unwrap();
    // 转码到目标格式
    Command::new("ffmpeg")
        .args(["-y", "-i"])
        .arg(&wav)
        .args(codec_args)
        .arg(path)
        .output()
        .unwrap();
}

#[test]
fn test_decode_wav() {
    let p = std::env::temp_dir().join("vf_test.wav");
    gen_audio(p.to_str().unwrap(), &[]);
    let data = std::fs::read(&p).unwrap();
    let (samples, rate) = voxflow_lib::audio::decode_any(&data, &p).unwrap();
    assert_eq!(rate, 16000);
    assert!(samples.len() > 10000, "WAV 解码样本过少: {}", samples.len());
}

#[test]
fn test_decode_mp3() {
    if !voxflow_lib::audio::ffmpeg_decoder::ffmpeg_available() {
        eprintln!("ffmpeg 不可用，跳过 MP3 测试");
        return;
    }
    let p = std::env::temp_dir().join("vf_test.mp3");
    gen_audio(p.to_str().unwrap(), &["-codec:a", "libmp3lame"]);
    let data = std::fs::read(&p).unwrap();
    let (samples, rate) = voxflow_lib::audio::decode_any(&data, &p).unwrap();
    assert_eq!(rate, 16000);
    assert!(samples.len() > 10000, "MP3 解码样本过少: {}", samples.len());
    eprintln!("MP3 解码 OK: {} samples", samples.len());
}

#[test]
fn test_decode_flac() {
    if !voxflow_lib::audio::ffmpeg_decoder::ffmpeg_available() {
        eprintln!("ffmpeg 不可用，跳过 FLAC 测试");
        return;
    }
    let p = std::env::temp_dir().join("vf_test.flac");
    gen_audio(p.to_str().unwrap(), &[]);
    let data = std::fs::read(&p).unwrap();
    let (samples, rate) = voxflow_lib::audio::decode_any(&data, &p).unwrap();
    assert_eq!(rate, 16000);
    assert!(samples.len() > 10000, "FLAC 解码样本过少: {}", samples.len());
    eprintln!("FLAC 解码 OK: {} samples", samples.len());
}
