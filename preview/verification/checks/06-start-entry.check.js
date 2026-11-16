// query: w=640
// 右侧栏「开始」页的「记忆」入口与 /memory_list 命令卡的按钮：
// 插件向 sidebarRightTabs 登记的页签定义带 guide 入口（宿主照它画「开始」页），按宿主的排法它在内置入口之后、「更多工具」之前；
// 点入口 = 宿主按 kind 打开页签，而这个 kind 对应的页签 id 正是面板本体在 sidebar.right.pane.tab 下注册的 key；
// 命令卡上的「打开记忆面板」走 layout.openRightbar + sidebarRight.openTab(同一个 kind)。卸载后登记撤回。
// 注意：「开始」页是仿真（内置入口写死、点击由仿真代替宿主记下 openTab），没有在真实 DSH 里验证。
async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = []
  const check = (label, cond) => out.push((cond ? 'PASS ' : 'FAIL ') + label)
  const H = window.__harness
  const def = H.tabs.find((d) => d.kind === 'memory-list')
  check('the memory tab type is registered with sidebarRightTabs', !!def && H.tabs.length === 1)
  const entry = def && def.guide && def.guide[0]
  check('the definition carries exactly one guide entry', !!entry && def.guide.length === 1)
  check('the entry is titled from the dictionary (zh: 记忆)', !!entry && entry.title() === '记忆')
  check('the entry has a glyph component and no shortcut', !!entry && typeof entry.icon === 'function' && !('commandId' in entry))
  check('the pane body is registered under the definition id (what the host mounts for that kind)', !!def && H.registeredKeys().includes(def.id))

  const stage = H.showGuide()
  await w(150)
  const rows = Array.from(stage.querySelectorAll('.hg-entry'))
  const mine = stage.querySelector('[data-guide-plugin="true"]')
  check('the start page shows the memory entry', !!mine && mine.textContent.trim() === '记忆')
  check('it sits after every built-in entry and right above More tools', rows.indexOf(mine) === rows.length - 2 && rows[rows.length - 1].hasAttribute('data-guide-more'))
  const svg = mine && mine.querySelector('svg')
  check('glyph: 22px, viewBox 16, stroke currentColor (inherits the host icon ink)', !!svg && svg.getAttribute('width') === '22' && svg.getAttribute('viewBox') === '0 0 16 16' && svg.getAttribute('stroke') === 'currentColor')
  check('glyph: no literal colours', !!svg && !/#[0-9a-f]{3,8}\b|rgba?\(/i.test(svg.outerHTML))
  const ink = svg && getComputedStyle(svg).color
  const titleInk = mine && getComputedStyle(mine.querySelector('.hg-icon')).color
  check('glyph colour comes from the host icon cell', !!ink && ink === titleInk)

  const before = H.hostCalls.length
  mine.click()
  await w(50)
  const picked = H.hostCalls.slice(before)
  check('picking the entry opens the memory tab by kind (host openTab, replaceTab)', picked.length === 1 && picked[0][0] === 'guide.openTab' && picked[0][1] === 'memory-list' && picked[0][2].replaceTab === true)

  const card = stage.querySelector('[data-guide-card] button')
  check('/memory_list card renders its open-panel button', !!card && card.textContent.trim() === '打开记忆面板')
  const beforeCard = H.hostCalls.length
  card.click()
  await w(50)
  const opened = H.hostCalls.slice(beforeCard)
  check('the card button opens the right bar and the same tab kind', opened.some((c) => c[0] === 'layout.openRightbar') && opened.some((c) => c[0] === 'sidebarRight.openTab' && c[1] === 'memory-list'))

  const left = H.unmount()
  check('the tab registration is withdrawn on release', left.tabsLeft === 0)
  return out.join('\n')
}
