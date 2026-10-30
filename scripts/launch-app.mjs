/**
 * 直接在本机启动应用（用于真机测试）。
 *
 * 为什么要这个脚本：从 shell 里直接 `electron.exe ...` 时，GUI 子系统的 exe
 * 会让 PowerShell 立即返回、且拿不到 stdout；这里用 Node 的 spawn（stdio inherit，
 * 不走管道 —— 受限沙箱下管道会 EPERM）稳定拉起并保持等待。
 *
 * 用法：
 *   node scripts/launch-app.mjs                 # 启动（带 9222 调试端口）
 *   node scripts/launch-app.mjs 9333            # 自定义端口
 */
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = process.argv[2] ?? '9222'
const electronBin = process.platform === 'win32'
  ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(root, 'node_modules', '.bin', 'electron')

const env = { ...process.env }
// 本会话从 Electron GUI 继承 ELECTRON_RUN_AS_NODE=1：不清掉 electron.exe 会退化成 node
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_NO_ATTACH_CONSOLE

const child = spawn(
  electronBin,
  ['.', `--remote-debugging-port=${port}`, '--remote-allow-origins=*'],
  { cwd: root, env, stdio: 'inherit', windowsHide: false }
)

console.log(`[launch] electron pid=${child.pid} port=${port}`)
child.on('exit', (code, signal) => {
  console.log(`[launch] electron 退出 code=${code} signal=${signal}`)
})
process.on('SIGINT', () => child.kill())
