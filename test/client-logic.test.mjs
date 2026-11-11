/**
 * client.js 的纯逻辑：校验、失败原因码 → 文案、章节定位、列表回写、i18n 键对称，
 * 以及 Markdown 行内解析的线性复杂度。
 *
 * 取函数的办法与 markdown.test.mjs 相同：client.js 是浏览器脚本，只能伪造
 * window.__ModuleLoader__ 与 require('react')，再经 __wsmCollectPure 钩子取出 factory 内部的纯函数。
 * 面板组件本身（React 状态、effect）在 Node 里跑不起来，见 HANDOFF 第六节的渲染脚手架。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

let captured = null
globalThis.__wsmCollectPure = (helpers) => {
  captured = helpers
}
let definition = null
globalThis.window = {
  __ModuleLoader__: { load: (value) => { definition = value } },
  localStorage: { getItem: () => null, setItem: () => {} },
}
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} }

const source = readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')
new Function('window', 'globalThis', source)(globalThis.window, globalThis)
if (!definition) {
  console.error('无法捕获插件定义')
  process.exit(1)
}
definition.factory((name) => {
  if (name === 'react') return { createElement: () => null, useState: () => [null, () => {}] }
  throw new Error(`unexpected require: ${name}`)
})
if (!captured) {
  console.error('纯函数未导出')
  process.exit(1)
}

const {
  validateDraft, singleLine, isImeEvent, bareTitle, locateSection, replaceMemory, removeMemory,
  reasonText, toDraft, renderMarkdown, KNOWN_REASONS, dictionaries,
} = captured
const { ZH, EN } = dictionaries

console.log('== i18n 键对称 ==')
{
  const zhKeys = Object.keys(ZH)
  const enKeys = Object.keys(EN)
  check('ZH 与 EN 键数一致', zhKeys.length === enKeys.length, `${zhKeys.length} vs ${enKeys.length}`)
  check('ZH 有而 EN 没有：无', zhKeys.filter((key) => !(key in EN)).length === 0, zhKeys.filter((key) => !(key in EN)).join(', '))
  check('EN 有而 ZH 没有：无', enKeys.filter((key) => !(key in ZH)).length === 0, enKeys.filter((key) => !(key in ZH)).join(', '))
  check('没有空文案', [...zhKeys, ...enKeys].every((key) => String((ZH[key] ?? EN[key])).trim() !== ''))

  // 代码里字面量写出的键都必须在字典里（含三元表达式里的）
  const prefixes = 'action|tab|search|count|field|hint|confidence|scope|agents|editor|meta|state|error|pending|detail|file|guard|confirm|promote|reason|type|panel'
  const literals = new Set([...source.matchAll(new RegExp(`'((?:${prefixes})\\.[A-Za-z-]+)'`, 'g'))].map((m) => m[1]))
  const stylesheetFree = [...literals].filter((key) => !key.startsWith('file.location') || key in ZH)
  const missing = stylesheetFree.filter((key) => !(key in ZH) || !(key in EN))
  check('代码里引用的 i18n 键都存在于 ZH 与 EN', missing.length === 0, missing.join(', '))

  // 失败原因码必须走 reason.* 查表，不能再拼 `promote.${reason}` 这种缺键时会露出原码的写法
  check('不再动态拼 promote.<原因码>', !/t\(\s*`promote\.\$\{/.test(source))
  check('没有遗留的 promote.<原因码> 字典项', !Object.keys(ZH).some((key) => /^promote\.(already|scope|agents|not-found|write|read)/.test(key)))
}

console.log('\n== 失败原因码 → 文案（原码绝不外露）==')
{
  const hostReasons = [
    'invalid-id', 'invalid-index', 'not-found', 'section-not-found', 'section-moved', 'only-chapter',
    'scope-not-global', 'agents-missing', 'agents-full', 'already-present', 'empty-title', 'empty-body',
    'library-full', 'read-failed', 'write-failed', 'launch-failed',
  ]
  check('KNOWN_REASONS 覆盖宿主已知的全部原因码', hostReasons.every((code) => KNOWN_REASONS.includes(code)),
    hostReasons.filter((code) => !KNOWN_REASONS.includes(code)).join(', '))
  for (const code of KNOWN_REASONS) {
    check(`reason.${code} 在 ZH 与 EN 中都有`, `reason.${code}` in ZH && `reason.${code}` in EN)
    const text = reasonText({ ok: false, reason: code }, 'FALLBACK')
    check(`reason ${code} 译成人话`, text !== code && text !== 'FALLBACK' && !text.startsWith('reason.') && !text.includes(code), text)
  }
  check('error 字段里的原因码同样被翻译（acceptPending 会这样返回）',
    reasonText({ ok: false, error: 'agents-full' }, 'F') === ZH['reason.agents-full'])
  check('agents-full 带字节数时给出具体数字',
    reasonText({ reason: 'agents-full', bytes: 9100, limit: 9000 }, 'F').includes('9100'))
  check('未知原因码不外露，落到宿主给的 errors[0]',
    reasonText({ reason: 'weird-code', errors: ['宿主说明'] }, 'F') === '宿主说明')
  check('未知原因码且无任何文本时用兜底', reasonText({ reason: 'weird-code' }, 'F') === 'F')
  check('error 是普通消息时原样给出', reasonText({ error: '待确认队列里没有 dr_x' }, 'F') === '待确认队列里没有 dr_x')
  check('空对象 / null / 非对象都用兜底', reasonText({}, 'F') === 'F' && reasonText(null, 'F') === 'F' && reasonText('x', 'F') === 'F')
}

console.log('\n== 标题 / 摘要必须单行 ==')
{
  const base = { title: 't', description: '', type: 'project', scope: 'project', tags: [], slug: 'a-b', body: 'b' }
  check('标题含 \\n 报错', Boolean(validateDraft({ ...base, title: 'a\nb' }).title))
  check('标题含 \\r\\n 报错', Boolean(validateDraft({ ...base, title: 'a\r\nb' }).title))
  check('摘要含 \\n 报错', Boolean(validateDraft({ ...base, description: 'x\nscope: global' }).description))
  check('单行标题与摘要不报错', Object.keys(validateDraft({ ...base, title: '单行标题', description: '单行摘要' })).length === 0)
  check('正文仍然允许换行', Object.keys(validateDraft({ ...base, body: 'a\n\nb' })).length === 0)
  check('singleLine 把换行压成空格', singleLine('a\r\nb\nc') === 'a b c', JSON.stringify(singleLine('a\r\nb\nc')))
  check('singleLine 对 null 安全', singleLine(null) === '')
}

console.log('\n== 输入法组字判定 ==')
{
  check('原生 isComposing', isImeEvent({ isComposing: true }) === true)
  check('React 合成事件只有 nativeEvent.isComposing', isImeEvent({ nativeEvent: { isComposing: true } }) === true)
  check('keyCode 229 视为组字', isImeEvent({ keyCode: 229 }) === true)
  check('普通回车不是组字', isImeEvent({ key: 'Enter', nativeEvent: { isComposing: false }, keyCode: 13 }) === false)
  check('空事件安全', isImeEvent(undefined) === false)
}

console.log('\n== AGENTS.md 章节定位 ==')
{
  check('bareTitle 去掉章号', bareTitle('3. 标题') === '标题' && bareTitle('3.2. 子标题') === '子标题')
  check('bareTitle 不动没有编号的标题', bareTitle('  Plain  ') === 'Plain' && bareTitle('2024 年计划') === '2024 年计划')
  const sections = [{ title: '1. 甲' }, { title: '2. 乙' }, { title: '3. 丙' }]
  check('位置没变：仍是原位置', locateSection(sections, '2. 乙', 1) === 1)
  check('外部在前面插了一章：编号变了也能按标题找回', locateSection([{ title: '1. 新' }, { title: '2. 甲' }, { title: '3. 乙' }], '2. 乙', 1) === 2)
  check('编号不同但标题相同视为同一章', locateSection([{ title: '5. 乙' }], '2. 乙', 1) === 0)
  check('章被删掉：返回 -1', locateSection(sections, '9. 丁', 0) === -1)
  check('非数组安全', locateSection(null, 'x', 0) === -1)
}

console.log('\n== 列表回写 ==')
{
  const data = {
    loading: false, error: null, root: '/r', pendingEnabled: false,
    memories: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    pending: [{ id: 'dr_1', title: 'P' }],
  }
  const renamed = replaceMemory(data, 'a', { id: 'a-2', title: 'A2' })
  check('改名后按旧 id 替换成宿主返回的新记忆', renamed.memories[0].id === 'a-2' && renamed.memories[1].id === 'b')
  check('replaceMemory 不改动原对象与待确认列表', data.memories[0].id === 'a' && renamed.pending === data.pending)
  const dropped = removeMemory(data, 'dr_1')
  check('removeMemory 摘掉待确认项', dropped.pending.length === 0 && dropped.memories.length === 2)
  check('removeMemory 摘掉已确认项', removeMemory(data, 'b').memories.map((m) => m.id).join() === 'a')
}

console.log('\n== toDraft：文件名 id 优先于 frontmatter name ==')
{
  check('name 与文件名不一致时 slug 取文件名', toDraft({ id: 'file-id', name: 'My Display Name', title: 't' }).slug === 'file-id')
  check('只有 name 时退回 name', toDraft({ name: 'only-name' }).slug === 'only-name')
  check('显式 slug 最优先', toDraft({ slug: 's', id: 'i', name: 'n' }).slug === 's')
}

console.log('\n== Markdown 行内解析保持线性 ==')
{
  const time = (text) => {
    const begin = performance.now()
    renderMarkdown(text)
    return performance.now() - begin
  }
  const worst = Math.max(time('['.repeat(120000)), time('[a'.repeat(60000)), time('[a](b'.repeat(24000)))
  check('12 万个未闭合的 [ 在 1 秒内渲染完（改前是平方复杂度：2 万个 118ms、20 万个 33 秒）', worst < 1000, `${worst.toFixed(0)}ms`)
  check('空行分段：a 空行 b 渲染成两个 <p>，而不是 <br><br>', renderMarkdown('a\n\nb') === '<p>a</p>\n<p>b</p>', renderMarkdown('a\n\nb'))
  check('段内单个换行仍是 <br>', renderMarkdown('a\nb') === '<p>a<br>b</p>', renderMarkdown('a\nb'))
  check('正常链接仍然渲染', renderMarkdown('[文本](https://example.com/a)').includes('<a href="https://example.com/a"'))
  check('超长链接文本不再被当成链接（按字面输出，仍已转义）',
    !renderMarkdown(`[${'x'.repeat(400)}](https://example.com)`).includes('<a '))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
