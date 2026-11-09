/**
 * 统一数据根目录（安装模式 vs 便携模式）——对齐 Rust 版 `src-tauri/src/data_root.rs`。
 *
 * 判定依据：exe 旁是否存在 `portable.txt` 标记文件（打包便携版时放入）。
 * - 便携模式：有 portable.txt → 数据根 = `<exe>\data\`（首次运行自动创建）
 * - 安装模式：无 → 数据根 = `%APPDATA%\com.voxflow.app\`
 *
 * 所有用户数据（models / config.json / history / logs）都从这一个根派生。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { projectRoot } from './paths'

/** 配置文件（数据根下） */
export const CONFIG_FILE = 'config.json'

/** 便携标记文件名（打包便携版时与 exe 同级放入） */
export const PORTABLE_MARKER = 'portable.txt'

/** 应用目录名（与 Tauri identifier 一致 ⇒ 同一数据根，两版可共存） */
export const APP_DIR_NAME = 'com.voxflow.app'

/**
 * exe 所在目录。
 * - 开发态：项目根（向上找 package.json；兼容 `electron-vite dev` 与
 *   `electron out/main/index.js` 两种启动方式）
 * - 生产态：打包后 exe 所在目录（便携版的 portable.txt 与 data\ 都在这里）
 */
export function exeDir(): string {
  if (app.isPackaged) return dirname(app.getPath('exe'))
  return projectRoot()
}

/**
 * **应用根目录** —— data\ / libs\ / portable.txt 所在的那一层。
 *
 * 为什么与 exeDir 分开：InnoSetup 版把 Electron 塞进 `bin\`，根目录只放一个启动器 exe。
 * 此时 `app.getPath('exe')` 指向 `bin\`，若按老逻辑用 exe 旁目录，
 * data\ 与 libs\ 就会跑到 `bin\` 下面，与用户要求的目录结构不符。
 *
 * 判定：exe 所在目录名为 `bin` → 根目录取它的上一级。
 * 认 `bin` 这个名字是因为 InnoSetup 脚本里 Electron 固定解到 `{app}\bin`。
 * 认不出来时退回 exeDir()（electron-builder 原生打包仍按老规则工作）。
 */
export function appRootDir(): string {
  const dir = exeDir()
  if (basename(dir).toLowerCase() !== 'bin') return dir
  const parent = dirname(dir)
  // 上级存在同名 bin 的兄弟目录（Electron 本体所在）→ 确认是 InnoSetup 布局
  return parent
}

/** 当前是否便携模式（应用根目录旁有 portable.txt） */
export function isPortable(): boolean {
  return existsSync(join(appRootDir(), PORTABLE_MARKER))
}

/** 计算统一数据根目录（便携 marker + AppData 兜底） */
export function getDataRoot(): string {
  if (isPortable()) {
    const portable = join(appRootDir(), 'data')
    mkdirSync(join(portable, 'models'), { recursive: true })
    return portable
  }
  // 安装模式：%APPDATA%\com.voxflow.app（与 Tauri app_data_dir() 一致）
  const root = join(app.getPath('appData'), APP_DIR_NAME)
  mkdirSync(join(root, 'models'), { recursive: true })
  return root
}

/** 数据根下的 models 目录 */
export function modelsDir(): string {
  return join(getDataRoot(), 'models')
}

/** 默认模型根：便携=exe旁data\models，安装=%APPDATA%\com.voxflow.app\models */
export function defaultModelRoot(): string {
  return modelsDir()
}

/** 从 config.json 读取原始 modelRoot 字符串（未解析） */
function rawSavedModelRoot(dataRoot: string): string | null {
  try {
    const text = readFileSync(join(dataRoot, CONFIG_FILE), 'utf-8')
    const v = JSON.parse(text) as { models?: { modelRoot?: string } }
    const root = v.models?.modelRoot?.trim()
    return root ? root : null
  } catch {
    return null
  }
}

/**
 * 解析保存的 modelRoot → 绝对路径（含相对路径支持）。
 *  1. 空 / 无 modelRoot → null（用默认：数据根/models）
 *  2. 相对路径 → 相对「数据根」解析
 *  3. 绝对路径 → 原样采用
 * 相对路径禁止 ".." 逃逸。
 */
export function resolveSavedModelRoot(dataRoot: string): string | null {
  const raw = rawSavedModelRoot(dataRoot)
  if (!raw) return null
  if (isAbsolute(raw)) return raw
  const normalized = raw.replace(/\//g, sep)
  if (normalized.split(/[\\/]+/).includes('..')) {
    console.warn(`[data_root] modelRoot 含非法 .. 逃逸，已回退默认: ${raw}`)
    return null
  }
  return resolve(dataRoot, normalized)
}

/** 读取 config.json 中保存的 modelRoot（绝对路径或 null） */
export function readSavedModelRoot(): string | null {
  return resolveSavedModelRoot(getDataRoot())
}

/**
 * modelRoot 存储形式（saveConfig 落盘前调用）：
 * 路径在数据根内 → 存相对（换目录自动跟随）；在数据根外（用户选的外部目录）→ 存绝对。
 * - root == data_root → 存 "."（即数据根本身）
 * - 非绝对路径输入 → 原样返回
 */
export function relativizeModelRoot(root: string, dataRoot: string): string {
  const abs = resolve(root)
  const rel = relative(dataRoot, abs)
  if (rel === '') return '.'
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
  return abs.split(sep).join('/')
}

/**
 * 数据根信息（便携/安装判定 + 模型目录）—— 对齐 Rust 版 `lib.rs::get_data_root_info`。
 * 模型根：优先已保存的用户选择，否则便携/安装各自默认。
 */
export function getDataRootInfo(): {
  portable: boolean
  data_root: string
  model_root: string
} {
  const dataRoot = getDataRoot()
  const modelRoot = readSavedModelRoot() ?? defaultModelRoot()
  return {
    portable: isPortable(),
    data_root: dataRoot,
    model_root: modelRoot
  }
}

/**
 * Tauri 命令语义：`rust_storage_model_root`
 * 数据根内 → 相对（"models" / "." / "模型库B"）；数据根外 → 绝对。
 */
export function storageModelRoot(root: string): string {
  const raw = root.trim()
  if (!raw) return 'models'
  if (isAbsolute(raw)) return relativizeModelRoot(raw, getDataRoot())
  const normalized = raw.replace(/\//g, sep)
  if (normalized.split(/[\\/]+/).includes('..')) {
    throw new Error(`model root 相对路径禁止 .. 逃逸: ${raw}`)
  }
  return raw.split(sep).join('/')
}
