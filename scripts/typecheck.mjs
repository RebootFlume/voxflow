#!/usr/bin/env node
/**
 * 类型与一致性检查的**唯一入口**。
 *
 * 为什么不写成 `npm run typecheck:node && npm run typecheck:web`：
 * 1. npm 在某些 shell（git-bash 下的 nvm shim）里不可用，链式 npm 会直接失败；
 * 2. dev / start / build / git hook 都要调它，四处各写一遍链式命令必然会漂移。
 *
 * 任何「改完代码该跑什么」的场景都调这里：`node scripts/typecheck.mjs`。
 * 顺序：一致性（快，秒级）→ node 侧 tsc → web 侧 tsc（慢，先跑快的早报错）。
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const STEPS = [
  ['一致性检查', ['scripts/check-consistency.mjs']],
  ['类型检查（main / preload）', ['./node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.node.json', '--composite', 'false']],
  ['类型检查（renderer）', ['./node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.web.json', '--composite', 'false']]
]

for (const [label, args] of STEPS) {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
  if (res.status !== 0) {
    console.error(`\n✗ ${label}失败`)
    process.exit(res.status ?? 1)
  }
}

console.log('\n✓ 全部检查通过')
