/**
 * 数据文件持久化 —— 对齐 Rust 版 `src-tauri/src/persistence.rs`。
 * 全部落在统一数据根下，文件名由前端传入（相对路径）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'path'
import { getDataRoot } from './data-root'

/** 把前端传入的文件名解析到数据根下，并阻止越界（.. 逃逸） */
function resolveInDataRoot(filename: string): string {
  const root = getDataRoot()
  const target = isAbsolute(filename) ? filename : join(root, filename)
  const rel = relative(root, resolve(target))
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`数据文件路径越界: ${filename}`)
  }
  return normalize(target)
}

/** 读取数据根下的文件；不存在返回 null */
export function readDataFile(filename: string): string | null {
  const path = resolveInDataRoot(filename)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8')
}

/** 写入数据根下的文件（自动创建父目录，如 logs/、history/） */
export function writeDataFile(filename: string, content: string): void {
  const path = resolveInDataRoot(filename)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

/** 删除数据根下的文件（不存在时静默成功） */
export function removeDataFile(filename: string): void {
  const path = resolveInDataRoot(filename)
  if (existsSync(path)) rmSync(path, { force: true })
}

/** 数据根绝对路径 */
export function getDataDir(): string {
  const dir = getDataRoot()
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 数据根下的绝对路径（供内部模块使用，不做越界检查） */
export function dataPath(...segments: string[]): string {
  return join(getDataRoot(), ...segments)
}

export { sep }
