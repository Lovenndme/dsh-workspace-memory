// query: w=960&delay=300
// 记忆的身份与在途锁：partially-saved（已换库、其余没存）时选中项跟着走、错误留在这一条、焦点不丢；改名后焦点不丢；
// 升为全局指令在途时编辑区锁住、不能换条目，完成后条目移出。
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
  const selected = () => $('.wsm-row[aria-selected="true"]')?.getAttribute('data-key')

  $$('.wsm-tab')[3].click()
  await w(300)
  const k0 = selected()
  const id = k0.split(':')[1]
  // 宿主回 409 partially-saved：条目已移到所有项目（fixture 里同步挪过去），其余字段没写
  const orig = window.fetch
  let partial = true
  window.fetch = (u, i) => {
    if (partial && /\/save\?/.test(String(u))) {
      partial = false
      const b = JSON.parse(i.body)
      FX.list.memories.find((x) => x.id === b.id && x.scope === b.scope).scope = b.patch.scope
      return new Promise((r) => setTimeout(() => r({ ok: false, status: 409, json: async () => ({ ok: false, reason: 'partially-saved', moved: true, scope: b.patch.scope, previousScope: b.scope, errors: ['写入其余字段失败'] }) }), 300))
    }
    return orig(u, i)
  }
  const title = $('.wsm-doc-title')
  title.focus()
  input(title, title.value + '（改）')
  await w(40)
  $('[data-menu-anchor="mm-scope"]').click()
  await w(80)
  $$('.wsm-menu-item').find((b) => b.textContent.includes('所有项目')).click()
  await w(80)
  $('.wsm-doc-title').focus()
  key($('.wsm-doc-title'), 's', { ctrlKey: true })
  await w(1200)
  window.fetch = orig
  check('partially-saved: the selection follows the entry to its new library', selected() === 'global:' + id)
  check('partially-saved: the error is shown on that entry', /已移到另一个库/.test($('.wsm-savebar-msg')?.textContent || ''))
  check('partially-saved: focus stays in the title', document.activeElement === $('.wsm-doc-title'))
  check('partially-saved: the unsaved title edit is kept', $('.wsm-doc-title').value.endsWith('（改）'))

  const slug = $('.wsm-slug input')
  slug.focus()
  input(slug, 'renamed-entry')
  await w(40)
  key(slug, 's', { ctrlKey: true })
  await w(1300)
  check('rename: the selection is the new id', selected() === 'global:renamed-entry')
  check('rename: focus stays in the file name field', document.activeElement === $('.wsm-slug input'))
  check('rename: saved (no unsaved changes left)', !$('.wsm-savebar'))

  // 升为全局指令在途
  $('[data-menu-anchor="mem-more"]').click()
  await w(100)
  $$('.wsm-menu-item')[0].click()
  await w(150)
  $$('dialog[open] .wsm-dialog-foot .wsm-btn')[1].click()
  await w(100)
  check('promote in flight: title, summary and body are read-only', $('.wsm-doc-title').readOnly && $('.wsm-doc-desc').readOnly && $('.wsm-editor textarea.wsm-field').readOnly)
  $$('.wsm-row').find((r) => r.getAttribute('data-key') !== 'global:renamed-entry').click()
  await w(80)
  check('promote in flight: cannot switch entries', selected() === 'global:renamed-entry' && !$('dialog[open]'))
  await w(1500)
  check('promote done: the entry left the memories', !$$('.wsm-row').some((r) => r.getAttribute('data-key') === 'global:renamed-entry'))
  check('promote done: a chapter was appended', FX.agentsSections.sections.some((s) => /（改）$/.test(s.title)))
  return out.join('\n')
}
