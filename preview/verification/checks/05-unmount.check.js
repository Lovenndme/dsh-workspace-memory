// query: w=640
// 卸载与释放：面板卸载、插件 ctx.effect 的清理函数执行后，面板 DOM 与注入的样式表都不在了，之后的键盘事件不报错。
async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = []
  const check = (label, cond) => out.push((cond ? 'PASS ' : 'FAIL ') + label)
  check('stylesheet injected while mounted', !!document.querySelector('style[data-dsh-workspace-memory]'))
  check('panel mounted', !!document.querySelector('.wsm-panel'))
  const left = window.__harness.unmount()
  await w(100)
  check('panel removed after unmount', !left.panelLeft && !document.querySelector('.wsm-panel'))
  check('stylesheet removed by the ctx.effect cleanup', !left.styleLeft)
  let error = null
  const onError = (e) => {
    error = e.message
  }
  window.addEventListener('error', onError)
  for (const k of ['a', 'j', 's', 'Escape', '/']) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: k === 's', bubbles: true, cancelable: true }))
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  window.dispatchEvent(new Event('resize'))
  await w(3500)
  window.removeEventListener('error', onError)
  check('no errors from leftover listeners or timers after unmount', !error)
  return out.join('\n')
}
