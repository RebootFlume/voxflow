/**
 * 前置脚本：切到「语音合成」模块（TTS 面板）并展开音色库。
 * 由 screenshot.mjs 读取执行，执行完再截图。
 */
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  // 活动栏里的按钮按 aria-label / title 找 TTS 入口
  const buttons = [...document.querySelectorAll('button, [role="button"]')]
  const ttsBtn = buttons.find((b) => {
    const t = `${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`
    return /语音合成|TTS|合成/.test(t)
  })
  if (!ttsBtn) {
    return { ok: false, reason: '未找到 TTS 入口按钮', buttons: buttons.length }
  }
  ttsBtn.click()
  await wait(600)
  return { ok: true, label: ttsBtn.getAttribute('aria-label') ?? ttsBtn.textContent?.slice(0, 20) }
})()
