/**
 * 用 Vite 的 build API 打包并执行 TypeScript 测试脚本。
 *
 * 项目没有 tsx/esbuild 运行时，借用 vite 自带的打包能力最省事，
 * 也不给运行时引入额外依赖。
 *
 * 用法：node scripts/run-ts-tests.mjs <entry.ts>
 */
import { build } from 'vite'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const entry = resolve(process.argv[2] ?? 'scripts/tts-tests.ts')
// 输出放在项目内（node_modules/.cache）：temp 目录里无法解析 electron 等依赖
const outDir = resolve('node_modules/.cache/voxflow-ts-test')
const stub = resolve('scripts/stubs/electron.ts')

try {
  await build({
    configFile: false,
    logLevel: 'warn',
    // 测试脚本不处理 CSS，关掉 postcss 自动加载（避免加载项目根的 postcss.config.js）
    css: { postcss: { plugins: [] } },
    resolve: {
      alias: [{ find: /^electron$/, replacement: stub }]
    },
    build: {
      outDir,
      emptyOutDir: true,
      ssr: true,
      target: 'node22',
      minify: false,
      rollupOptions: {
        input: entry,
        output: { format: 'es', entryFileNames: 'bundle.mjs' }
      }
    },
    ssr: {
      // node: 内置模块保持 external（否则会被替换成浏览器 polyfill，报 __dirname 未定义）
      target: 'node'
    }
  })

  const bundle = join(outDir, 'bundle.mjs')
  const res = spawnSync(process.execPath, [bundle], { stdio: 'inherit', cwd: process.cwd() })
  process.exit(res.status ?? 1)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
