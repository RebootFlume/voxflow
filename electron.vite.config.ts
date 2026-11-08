import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 版本单一事实源 = package.json（与 Tauri 版保持一致，见 AGENT.md 规则 13）
const pkg = JSON.parse(readFileSync(resolve(__dirname, './package.json'), 'utf-8'))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // 进程内 FFI 推理 worker：主进程 fork 它，把原生 DLL 的崩溃隔离在子进程里。
          // 每种框架一个入口文件（worker 只服务一个引擎，互不牵连）。
          worker: resolve(__dirname, 'src/main/inference/llama-ffi/worker.ts'),
          'sherpa-asr-worker': resolve(__dirname, 'src/main/inference/sherpa-ffi/asr-worker.ts'),
          'sherpa-tts-worker': resolve(__dirname, 'src/main/inference/sherpa-ffi/tts-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // 打包后以 file:// 加载，资源路径必须是相对路径
    base: './',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
})
