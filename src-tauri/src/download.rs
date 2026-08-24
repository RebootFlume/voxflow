//! Hugging Face 模型下载模块
//!
//! 提供同步方式从 Hugging Face Hub 下载模型文件。
//! 代理：环境变量（HTTP_PROXY/HTTPS_PROXY/NO_PROXY，reqwest system-proxy 自动读取）
//! 镜像：HFClientBuilder::endpoint() / HF_ENDPOINT
//! Token：HF_TOKEN / HF_TOKEN_PATH / $HF_HOME/token（resolve_token 自动检索）
//! 并发安全：写入环境变量 + 创建 HFClient 的整段受 ENV_SCOPE_LOCK 保护。

use std::path::PathBuf;
use anyhow::{anyhow, Result};

/// 创建 HFClient 前必须外层持有：保证“写入环境变量 + build_sync”原子化。
/// 细节见 lib.rs 的防污染/作用域说明。
/// 下载配置
#[derive(Debug, Clone)]
pub struct DownloadConfig {
    /// Hugging Face 模型 ID (如 "bert-base-uncased" 或 "openai-community/gpt2")
    pub model_id: String,
    /// 要下载的文件名 (如 "config.json", "model.safetensors")
    pub filename: String,
    /// 可选的 Token (用于私有模型)
    pub token: Option<String>,
    /// 本地缓存目录 (默认 ~/.cache/huggingface)
    pub cache_dir: Option<PathBuf>,
}

impl DownloadConfig {
    /// 创建新的下载配置
    pub fn new(model_id: impl Into<String>, filename: impl Into<String>) -> Self {
        Self {
            model_id: model_id.into(),
            filename: filename.into(),
            token: None,
            cache_dir: None,
        }
    }

    /// 设置 Token
    pub fn with_token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    /// 设置缓存目录
    pub fn with_cache_dir(mut self, cache_dir: impl Into<PathBuf>) -> Self {
        self.cache_dir = Some(cache_dir.into());
        self
    }

    /// 从环境变量获取 Token
    pub fn with_env_token(mut self) -> Self {
        if let Ok(token) = std::env::var("HF_TOKEN") {
            self.token = Some(token);
        }
        self
    }
}

/// 同步下载器
pub struct SyncDownloader {
    client: hf_hub::HFClientSync,
}

impl SyncDownloader {
    /// 创建新的同步下载器
    /// 重要：调用前应已在 ENV_SCOPE_LOCK 内完成 apply_proxy_env/apply_mirror_env；
    /// 若未持锁，代理/镜像的环境写入可能被并发 build 覆盖。
    pub fn new(config: &DownloadConfig) -> Result<Self> {
        let mut builder = hf_hub::HFClient::builder();

        // 显式 token（UI 传入的私有模型 token）；无则走 resolve_token 链
        if let Some(ref token) = config.token {
            builder = builder.token(token);
        }

        // 显式端点优先，其次 HF_ENDPOINT，缺省 huggingface.co
        // with_env_token 链也同时靠 HF_TOKEN/HF_TOKEN_PATH 环境生效
        
        // 设置缓存目录
        if let Some(ref cache_dir) = config.cache_dir {
            builder = builder.cache_dir(cache_dir);
        }

        let client = builder
            .build_sync()
            .map_err(|e| anyhow!("Failed to build HF API client: {}", e))?;

        Ok(Self { client })
    }

    /// 带镜像端点的快捷创建（endpoint 为空则等价于 new）。
    /// 调用前需已在 ENV_SCOPE_LOCK 内按需调用 apply_proxy_env/apply_mirror_env。
    #[allow(dead_code)]
    pub fn new_with_endpoint(config: &DownloadConfig, endpoint: Option<&str>) -> Result<Self> {
        let mut builder = hf_hub::HFClient::builder();
        if let Some(ep) = endpoint.and_then(|s| { let t=s.trim(); if t.is_empty(){None}else{Some(t)}}) {
            builder = builder.endpoint(ep);
        }
        if let Some(ref token) = config.token {
            builder = builder.token(token);
        }
        if let Some(ref cache_dir) = config.cache_dir {
            builder = builder.cache_dir(cache_dir);
        }
        let client = builder.build_sync().map_err(|e| anyhow!("Failed to build HF API client: {}", e))?;
        Ok(Self { client })
    }

    /// 下载单个文件
    ///
    /// 返回下载后的本地文件路径
    pub fn download_file(&self, config: &DownloadConfig) -> Result<PathBuf> {
        // 解析 model_id 为 (owner, name)
        let (owner, name) = hf_hub::split_id(&config.model_id);

        let model = self.client.model(owner, name);

        let path = model
            .download_file()
            .filename(&config.filename)
            .send()
            .map_err(|e| {
                anyhow!(
                    "Failed to download {} from {}: {}",
                    config.filename,
                    config.model_id,
                    e
                )
            })?;

        Ok(path)
    }

    /// 下载多个文件
    pub fn download_files(
        &self,
        model_id: &str,
        filenames: &[String],
    ) -> Result<Vec<PathBuf>> {
        let mut paths = Vec::new();

        for filename in filenames {
            let config = DownloadConfig::new(model_id, filename);
            let path = self.download_file(&config)?;
            paths.push(path);
        }

        Ok(paths)
    }

    /// 下载模型并读取为字符串 (适用于 JSON 配置文件)
    pub fn download_as_string(&self, config: &DownloadConfig) -> Result<String> {
        let path = self.download_file(config)?;
        let content = std::fs::read_to_string(&path)
            .map_err(|e| anyhow!("Failed to read downloaded file {:?}: {}", path, e))?;
        Ok(content)
    }

    /// 下载模型并读取为字节 (适用于二进制文件)
    #[allow(dead_code)]
    pub fn download_as_bytes(&self, config: &DownloadConfig) -> Result<Vec<u8>> {
        let path = self.download_file(config)?;
        let content = std::fs::read(&path)
            .map_err(|e| anyhow!("Failed to read downloaded file {:?}: {}", path, e))?;
        Ok(content)
    }
}

/// 便捷函数：同步下载文件
#[allow(dead_code)]
pub fn download_file_sync(
    model_id: &str,
    filename: &str,
    token: Option<&str>,
) -> Result<PathBuf> {
    let mut config = DownloadConfig::new(model_id, filename).with_env_token();

    if let Some(t) = token {
        config = config.with_token(t);
    }

    let downloader = SyncDownloader::new(&config)?;
    downloader.download_file(&config)
}

/// 获取默认缓存目录
#[allow(dead_code)]
pub fn default_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("huggingface")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_download_config_builder() {
        let config = DownloadConfig::new("openai-community/gpt2", "config.json")
            .with_token("test-token");

        assert_eq!(config.model_id, "openai-community/gpt2");
        assert_eq!(config.filename, "config.json");
        assert_eq!(config.token, Some("test-token".to_string()));
    }

    #[test]
    fn test_default_cache_dir() {
        let dir = default_cache_dir();
        assert!(dir.to_string_lossy().contains("huggingface"));
    }

    #[test]
    fn test_split_id() {
        let (owner, name) = hf_hub::split_id("openai-community/gpt2");
        assert_eq!(owner, "openai-community");
        assert_eq!(name, "gpt2");

        // 短格式（没有 owner）
        let (owner, name) = hf_hub::split_id("gpt2");
        assert_eq!(owner, "");
        assert_eq!(name, "gpt2");
    }
}
