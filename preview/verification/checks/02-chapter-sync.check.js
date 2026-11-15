// query: w=960
// 章节编辑器与文件同步：没改时跟着文件走（收下覆盖草稿、刷新），改过且文件也变时提示冲突、先问再写；
// 没改不发保存；带编号的标题；切到「本项目」时的守卫与快捷键。
async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const $ = (s) => document.querySelector(s)
  const $$ = (s) => Array.from(document.querySelectorAll(s))
  const out = []
  const check = (label, cond) => out.push((cond ? 'PASS ' : 'FAIL ') + label)
  const input = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const key = (el, k, o) => el.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, o || {})))
  const posts = (p) => window.__harness.posts.filter((x) => x.path === p)
  const tab = (i) => $$('.wsm-tab')[i].click()
  const edit = (i) => $$('.wsm-chap')[i].querySelector('.wsm-chap-actions .wsm-btn').click()
  const ta = () => $('.wsm-chap-edit textarea')
  const seg = (i) => $$('.wsm-pagehead .wsm-seg > button')[i]
  const toasts = () => $$('.wsm-toast-text').map((x) => x.textContent).join(' | ')

  tab(2)
  await w(250)
  // (1) 没改的编辑器 → 去待确认收下覆盖第 2 章的草稿 → 回来
  edit(1)
  await w(150)
  const before = ta().value
  tab(1)
  await w(200)
  $$('.wsm-draft').find((c) => c.getAttribute('data-draft') === 'dr_mwkt1f7b_7e21c9').querySelector('.wsm-btn[data-variant="primary"]').click()
  await w(1200)
  tab(2)
  await w(250)
  check('clean editor follows an accepted overwrite of its chapter', !!ta() && ta().value !== before && ta().value === FX.agentsSections.sections[1].body)
  input(ta(), ta().value + '！')
  await w(50)
  key(ta(), 's', { ctrlKey: true })
  await w(500)
  const s1 = posts('/agents/save-section')
  check('saving after that does not roll the accepted chapter back', s1.length === 1 && s1[0].body.body === FX.agentsSections.sections[1].body && s1[0].body.body.startsWith('- 回答一律用简体中文'))

  // (2) 没改的编辑器 + 外部改了文件 + 刷新
  edit(2)
  await w(150)
  FX.agentsSections.sections[2].body = '外部编辑器里改过的新正文'
  $('.wsm-head-actions .wsm-iconbtn').click()
  await w(500)
  check('clean editor follows a refresh', ta()?.value === '外部编辑器里改过的新正文')

  // (3) 改过 + 文件这一章也变了（删掉最后一章触发重读）→ 冲突提示；Ctrl+S 先问，不发请求
  input(ta(), ta().value + '（我的改动）')
  await w(50)
  FX.agentsSections.sections[2].body = '又被外部改了一次'
  const last = $$('.wsm-chap[data-chap]').length - 1
  $$('.wsm-chap')[last].querySelector('[aria-haspopup="menu"]').click()
  await w(120)
  $$('.wsm-menu-item').find((b) => /删除这一章/.test(b.textContent)).click()
  await w(150)
  $$('dialog[open] .wsm-dialog-foot .wsm-btn')[1].click()
  await w(600)
  check('dirty editor + chapter changed in the file → conflict note', !!$('.wsm-chap-edit .wsm-callout[data-tone="warn"]') && ta().value.endsWith('（我的改动）'))
  const n1 = posts('/agents/save-section').length
  key(ta(), 's', { ctrlKey: true })
  await w(200)
  check('saving with a conflict asks first and sends nothing', /覆盖文件里的新内容/.test($('dialog[open] .wsm-dialog-title')?.textContent || '') && posts('/agents/save-section').length === n1)
  $$('dialog[open] .wsm-dialog-foot .wsm-btn')[1].click()
  await w(150)
  check('«use the file version» replaces the draft and clears the conflict', ta()?.value === '又被外部改了一次' && !$('.wsm-chap-edit .wsm-callout'))

  // (4) 没改过：Ctrl+S 不发请求（与禁用的保存按钮一致）；Esc 关闭
  key(ta(), 's', { ctrlKey: true })
  await w(300)
  check('Ctrl+S on an unchanged chapter sends nothing', posts('/agents/save-section').length === n1 && $('.wsm-chap-edit-foot .wsm-btn[data-variant="primary"]').disabled)
  ta().focus()
  key(ta(), 'Escape')
  await w(120)
  check('Esc closes an unchanged editor without asking', !$('.wsm-chap-edit') && !$('dialog[open]'))

  // (5) 标题以「2. 」开头：宿主剥编号，提示里的章号要对
  $('.wsm-addchap').click()
  await w(150)
  input($('[data-chap-input="new"]'), '2. 编号开头的标题')
  input(ta(), '正文')
  await w(50)
  key(ta(), 's', { ctrlKey: true })
  await w(600)
  check('numbered new title: toast names the real chapter number', /已新增第 \d+ 章「编号开头的标题」/.test(toasts()) && !/第 0 章/.test(toasts()))

  // (6) 改着全局的章切到「本项目」：先过守卫；放弃后编辑器关掉；「本项目」页按 Ctrl+S 不发请求
  edit(0)
  await w(150)
  input(ta(), ta().value + '改')
  await w(50)
  seg(1).focus()
  seg(1).click()
  await w(150)
  check('switching to «this project» with unsaved chapter edits asks first', /还没保存/.test($('dialog[open]')?.textContent || '') && !$('.wsm-projcard'))
  $$('dialog[open] .wsm-dialog-foot .wsm-btn')[1].click()
  await w(200)
  const n2 = posts('/agents/save-section').length
  check('after discarding, the project page shows', !!$('.wsm-projcard'))
  key(document.activeElement, 's', { ctrlKey: true })
  await w(300)
  check('Ctrl+S on the project page saves no hidden chapter', posts('/agents/save-section').length === n2)
  seg(0).click()
  await w(150)
  check('the discarded editor is gone when coming back', !$('.wsm-chap-edit'))
  edit(1)
  await w(120)
  seg(1).click()
  await w(150)
  seg(0).click()
  await w(150)
  check('an unchanged editor is closed when switching to «this project»', !$('.wsm-chap-edit') && !$('dialog[open]'))
  return out.join('\n')
}
