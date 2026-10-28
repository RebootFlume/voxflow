/**
 * 前置脚本：读取运行时日志与引擎状态（排障用）。
 * 由 screenshot.mjs 读取执行。
 */
(() => {
  const store = window.__voxflowStore
  if (!store) {
    // Zustand 不挂全局，退回从 DOM 抓可见错误文案
    const text = document.body.innerText.replace(/\s+/g, ' ')
    return { note: 'store 未挂全局', snippet: text.slice(0, 400) }
  }
  const s = store.getState()
  return {
    engines: s.engines,
    tts: s.tts,
    logs: (s.runtimeLogs ?? []).slice(-6)
  }
})()
