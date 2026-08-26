//! Hugging Face 下载模块使用示例
//!
//! 展示如何使用 download 模块从 Hugging Face 下载模型文件。

use std::path::PathBuf;

use voxflow_lib::download;

/// 示例 1：同步下载单个文件
fn example_sync_download() -> anyhow::Result<()> {
    // 创建下载配置
    let config = download::DownloadConfig::new("openai-community/gpt2", "config.json")
        .with_env_token(); // 从 HF_TOKEN 环境变量读取 Token

    // 创建同步下载器
    let downloader = download::SyncDownloader::new(&config)?;

    // 下载文件
    let path = downloader.download_file(&config)?;
    println!("Downloaded to: {:?}", path);

    // 下载并读取为字符串
    let content = downloader.download_as_string(&config)?;
    println!("Content: {}", &content[..100.min(content.len())]);

    Ok(())
}

/// 示例 2：下载私有模型
fn example_private_model() -> anyhow::Result<()> {
    let config = download::DownloadConfig::new("private-org/private-model", "config.json")
        .with_token("hf_xxxxxxxxxxxxxxxxxxxx");

    let downloader = download::SyncDownloader::new(&config)?;
    let path = downloader.download_file(&config)?;

    println!("Downloaded private model: {:?}", path);

    Ok(())
}

/// 示例 3：下载多个文件
fn example_download_multiple() -> anyhow::Result<()> {
    let config = download::DownloadConfig::new("openai-community/gpt2", "")
        .with_env_token();

    let downloader = download::SyncDownloader::new(&config)?;

    let filenames = vec![
        "config.json".to_string(),
        "tokenizer.json".to_string(),
    ];

    let paths = downloader.download_files("openai-community/gpt2", &filenames)?;

    for path in &paths {
        println!("Downloaded: {:?}", path);
    }

    Ok(())
}

/// 示例 4：自定义缓存目录
fn example_custom_cache() -> anyhow::Result<()> {
    let cache_dir = PathBuf::from("./my_model_cache");

    let config = download::DownloadConfig::new("openai-community/gpt2", "config.json")
        .with_cache_dir(cache_dir)
        .with_env_token();

    let downloader = download::SyncDownloader::new(&config)?;
    let path = downloader.download_file(&config)?;

    println!("Downloaded to custom cache: {:?}", path);

    Ok(())
}

/// 示例 5：便捷函数
fn example_convenience_function() -> anyhow::Result<()> {
    // 使用便捷函数下载
    let path = download::download_file_sync(
        "openai-community/gpt2",
        "config.json",
        None, // 使用 HF_TOKEN 环境变量
    )?;

    println!("Downloaded via convenience function: {:?}", path);

    Ok(())
}

/// 示例 6：在 Tauri 命令中使用
///
/// 在 Tauri 应用中，应该使用注册的命令：
///
/// ```typescript
/// // 前端 TypeScript 代码
/// import { invoke } from '@tauri-apps/api/core';
///
/// // 下载文件
/// const result = await invoke('hf_download_file', {
///     modelId: 'openai-community/gpt2',
///     filename: 'config.json',
///     token: null, // 可选
///     cacheDir: null, // 可选
/// });
/// console.log('Downloaded to:', result.path);
///
/// // 下载并获取内容
/// const contentResult = await invoke('hf_download_as_string', {
///     modelId: 'openai-community/gpt2',
///     filename: 'config.json',
///     token: null,
/// });
/// console.log('Content:', contentResult.content);
/// ```
fn example_tauri_usage() {
    println!("Tauri usage: See comments in source code");
}

fn main() -> anyhow::Result<()> {
    println!("=== Hugging Face Download Examples ===\n");

    // 运行示例
    println!("Example 1: Sync download");
    example_sync_download()?;

    println!("\nExample 2: Private model");
    example_private_model()?;

    println!("\nExample 3: Download multiple files");
    example_download_multiple()?;

    println!("\nExample 4: Custom cache directory");
    example_custom_cache()?;

    println!("\nExample 5: Convenience function");
    example_convenience_function()?;

    println!("\nExample 6: Tauri usage");
    example_tauri_usage();

    println!("\n=== All examples completed ===");

    Ok(())
}
