/**
 * Hugging Face 下载模块 - TypeScript 前端封装
 *
 * 提供类型安全的 API 调用接口，用于从 Hugging Face 下载模型文件。
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * 下载结果
 */
export interface DownloadResult {
  /** 下载后的本地文件路径 */
  path: string;
  /** 模型 ID */
  model_id: string;
  /** 文件名 */
  filename: string;
}

/**
 * 内容下载结果
 */
export interface DownloadContentResult {
  /** 文件内容 */
  content: string;
  /** 模型 ID */
  model_id: string;
  /** 文件名 */
  filename: string;
}

/**
 * 批量下载结果
 */
export interface DownloadMultipleResult {
  /** 下载的文件路径列表 */
  paths: string[];
  /** 模型 ID */
  model_id: string;
  /** 下载的文件数量 */
  count: number;
}

/**
 * 下载配置选项
 */
export interface DownloadOptions {
  /** Hugging Face Token (用于私有模型) */
  token?: string;
  /** 本地缓存目录 */
  cacheDir?: string;
}

/**
 * 从 Hugging Face 下载文件
 *
 * @param modelId - 模型 ID (如 "bert-base-uncased")
 * @param filename - 文件名 (如 "config.json")
 * @param options - 可选配置
 * @returns 下载结果
 *
 * @example
 * ```typescript
 * const result = await hfDownloadFile('bert-base-uncased', 'config.json');
 * console.log('Downloaded to:', result.path);
 * ```
 */
export async function hfDownloadFile(
  modelId: string,
  filename: string,
  options?: DownloadOptions
): Promise<DownloadResult> {
  return invoke<DownloadResult>('hf_download_file', {
    modelId,
    filename,
    token: options?.token ?? null,
    cacheDir: options?.cacheDir ?? null,
  });
}

/**
 * 从 Hugging Face 下载文件并返回内容
 *
 * @param modelId - 模型 ID
 * @param filename - 文件名
 * @param options - 可选配置
 * @returns 包含文件内容的结果
 *
 * @example
 * ```typescript
 * const result = await hfDownloadAsString('bert-base-uncased', 'config.json');
 * const config = JSON.parse(result.content);
 * console.log(config);
 * ```
 */
export async function hfDownloadAsString(
  modelId: string,
  filename: string,
  options?: DownloadOptions
): Promise<DownloadContentResult> {
  return invoke<DownloadContentResult>('hf_download_as_string', {
    modelId,
    filename,
    token: options?.token ?? null,
  });
}

/**
 * 从 Hugging Face 批量下载多个文件
 *
 * @param modelId - 模型 ID
 * @param filenames - 文件名列表
 * @param options - 可选配置
 * @returns 批量下载结果
 *
 * @example
 * ```typescript
 * const result = await hfDownloadMultiple('bert-base-uncased', [
 *   'config.json',
 *   'tokenizer.json',
 *   'model.safetensors',
 * ]);
 * console.log(`Downloaded ${result.count} files`);
 * ```
 */
export async function hfDownloadMultiple(
  modelId: string,
  filenames: string[],
  options?: DownloadOptions
): Promise<DownloadMultipleResult> {
  return invoke<DownloadMultipleResult>('hf_download_multiple', {
    modelId,
    filenames,
    token: options?.token ?? null,
  });
}

/**
 * 下载模型配置文件并解析为 JSON
 *
 * @param modelId - 模型 ID
 * @param options - 可选配置
 * @returns 解析后的配置对象
 *
 * @example
 * ```typescript
 * const config = await hfDownloadModelConfig('bert-base-uncased');
 * console.log(config.model_type); // "bert"
 * ```
 */
export async function hfDownloadModelConfig<T = Record<string, unknown>>(
  modelId: string,
  options?: DownloadOptions
): Promise<T> {
  const result = await hfDownloadAsString(modelId, 'config.json', options);
  return JSON.parse(result.content) as T;
}

/**
 * 检查模型文件是否已缓存
 *
 * 注意：此函数需要后端支持，目前仅作为示例
 */
export async function hfCheckCached(
  _modelId: string,
  _filename: string
): Promise<boolean> {
  // TODO: 实现缓存检查功能
  // 需要在 Rust 后端添加相应命令
  console.warn('hfCheckCached not implemented yet');
  return false;
}
