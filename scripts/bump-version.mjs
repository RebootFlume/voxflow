#!/usr/bin/env node
/**
 * 版本号同步脚本 —— 事实源 = package.json 的 version 字段。
 *
 * 发版流程：
 *   1. 编辑 package.json 的 "version"（唯一要改的地方）
 *   2. 运行 npm run version:sync
 *   3. npm run bundle 打包
 *
 * Electron 版相比 Tauri 版少了两处需要分发的地方：
 *   - tauri.conf.json → 由 electron-builder.yml 取代；产物名用 ${version} 占位，直接读 package.json
 *   - Cargo.toml / Cargo.lock → Rust 侧已移除（推理引擎全部跑在独立子进程）
 * 因此本脚本只做「校验 + 可选更新」，并把版本写进 electron-builder.yml 的注释里做人工核对。
 *
 * 可选：npm run version:sync -- 0.4.0 会先更新 package.json 再校验（等价于手动编辑）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

let ver = pkg.version
const arg = process.argv[2]
if (arg) {
  if (!/^\d+\.\d+\.\d+$/.test(arg)) {
    console.error(`版本号格式应为 x.y.z（不带 v），收到: ${arg}`)
    process.exit(1)
  }
  if (arg !== ver) {
    writeFileSync(pkgPath, JSON.stringify({ ...pkg, version: arg }, null, 2) + '\n', 'utf-8')
    console.log(`✓ package.json（事实源）→ ${arg}`)
    ver = arg
  }
}

// 校验：electron-builder 产物名用 ${version}，必须能从 package.json 解析出
const builderPath = path.join(root, 'electron-builder.yml')
const builder = readFileSync(builderPath, 'utf-8')
if (!builder.includes('${version}')) {
  console.error('✗ electron-builder.yml: 产物名未使用 ${version} 占位符')
  process.exit(1)
}
if (!/^\d+\.\d+\.\d+$/.test(ver)) {
  console.error(`✗ package.json: 版本号格式应为 x.y.z，收到: ${ver}`)
  process.exit(1)
}

// 校验：前端构建注入的版本号来源必须是 package.json
const viteConfig = readFileSync(path.join(root, 'electron.vite.config.ts'), 'utf-8')
if (!viteConfig.includes('__APP_VERSION__') || !viteConfig.includes('package.json')) {
  console.error('✗ electron.vite.config.ts: __APP_VERSION__ 未从 package.json 注入')
  process.exit(1)
}

console.log(`\n完成：版本号统一为 ${ver}（事实源 package.json）。下一步：npm run bundle。`)
