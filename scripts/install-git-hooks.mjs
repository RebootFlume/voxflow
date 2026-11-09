#!/usr/bin/env node
/**
 * 把 scripts/git-hooks/* 装进 .git/hooks（postinstall 自动跑）。
 *
 * 为什么不直接提交 .git/hooks：它不进版本库，每个 clone 都是空的。
 * 也不用 husky：这里只需要挂一个 pre-commit，一个 30 行的安装脚本比多一个依赖划算。
 *
 * 已存在**非本脚本管理的** hook 时不覆盖，只在末尾提示 —— 用户的 hook 不该被悄悄顶掉。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'scripts', 'git-hooks')
const GIT_DIR = join(ROOT, '.git')
const DEST = join(GIT_DIR, 'hooks')

/** 本脚本管理的 hook 都带这个标记，用于识别「能否安全覆盖」 */
const MARKER = 'scripts/git-hooks/'

if (!existsSync(GIT_DIR)) {
  console.log('[hooks] 不是 git 仓库，跳过')
  process.exit(0)
}
if (!existsSync(SRC)) process.exit(0)

mkdirSync(DEST, { recursive: true })

/**
 * `--force`：覆盖已存在的同名 hook。
 * 首次引入本机制时 .git/hooks 里可能已有旧版本（不带归属标记），需要手动强装一次。
 */
const FORCE = process.argv.includes('--force') || process.argv.includes('-f')

const installed = []
const skipped = []

for (const name of readdirSync(SRC)) {
  const from = join(SRC, name)
  const to = join(DEST, name)
  if (existsSync(to)) {
    let existing = ''
    try {
      existing = readFileSync(to, 'utf-8')
    } catch {
      // 读不到就当别人的 hook，不碰
    }
    if (!existing.includes(MARKER) && !FORCE) {
      skipped.push(name)
      continue
    }
  }
  // autocrlf 在各机器上配置不同，checkout 出来的 hook 可能是 CRLF —— CRLF 会让
  // `#!/bin/sh` 变成 `#!/bin/sh\r`，git 报 "bad interpreter" 后**静默跳过** hook。
  // 直接在安装时统一成 LF，比要求每台机器配 gitattributes 更可靠。
  const raw = readFileSync(from, 'utf-8').replace(/\r\n/g, '\n')
  writeFileSync(to, raw, 'utf-8')
  try {
    chmodSync(to, 0o755)
  } catch {
    // Windows 上 chmod 基本无意义，git 会按内容识别 shebang
  }
  installed.push(name)
}

if (installed.length > 0) console.log(`[hooks] 已安装: ${installed.join(', ')}`)
if (skipped.length > 0) {
  console.log(`[hooks] 已存在同名 hook 且不是本仓库管理的，未覆盖: ${skipped.join(', ')}`)
  console.log(`[hooks] 如需启用检查，请手动把这些文件的内容合并进去`)
}
