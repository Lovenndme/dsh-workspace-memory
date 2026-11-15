/**
 * Markdown 渲染与标签校验的安全测试。
 *
 * 为什么必须测：面板把用户可编辑的正文渲染成 HTML（预览页、编辑器高亮层）。
 * 这类代码只靠截图看不出来问题——必须逐条验证恶意输入不会变成可执行内容。
 *
 * 做法：给 client.js 注入一个收集钩子，把 factory 内部的纯函数拿出来测。
 * client.js 是浏览器脚本，所以要先伪造 window.__ModuleLoader__ 和 require('react')。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
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

// ---- 加载 client.js 并取出纯函数 ----
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

const clientPath = path.join(import.meta.dirname, '..', 'client.js')
const source = readFileSync(clientPath, 'utf8')
// client.js 是普通脚本：直接在函数里 eval，避免顶层 const 泄漏到模块作用域
new Function('window', 'globalThis', source)(globalThis.window, globalThis)

if (!definition) {
  console.error('无法捕获插件定义：client.js 未调用 window.__ModuleLoader__.load')
  process.exit(1)
}

definition.factory((name) => {
  if (name === 'react') return { createElement: () => null, useState: () => [null, () => {}] }
  throw new Error(`unexpected require: ${name}`)
})

if (!captured) {
  console.error('纯函数未导出：__wsmCollectPure 没有被调用')
  process.exit(1)
}

const { escapeHTML, safeLink, inlineMarkdown, renderMarkdown, normalizeTag, validateDraft } = captured

console.log('== HTML 转义 ==')
{
  check('尖括号被转义', escapeHTML('<script>') === '&lt;script&gt;', escapeHTML('<script>'))
  check('引号被转义', escapeHTML('a"b') === 'a&quot;b', escapeHTML('a"b'))
  check('单引号被转义', escapeHTML("a'b") === 'a&#39;b', escapeHTML("a'b"))
  check('& 优先转义', escapeHTML('&lt;') === '&amp;lt;', escapeHTML('&lt;'))
}

console.log('\n== 链接协议白名单 ==')
{
  check('放行 https', safeLink('https://example.com/a') === 'https://example.com/a', safeLink('https://example.com/a'))
  check('放行 http', safeLink('http://example.com').startsWith('http://example.com'), safeLink('http://example.com'))
  check('放行 mailto', safeLink('mailto:a@b.com') === 'mailto:a@b.com')
  check('放行页内锚点', safeLink('#section-1') === '#section-1')
  check('拦截 javascript:', safeLink('javascript:alert(1)') === '', safeLink('javascript:alert(1)'))
  check('拦截大小写变体', safeLink('JaVaScRiPt:alert(1)') === '')
  check('拦截 data:', safeLink('data:text/html,<script>') === '')
  check('拦截 file:', safeLink('file:///C:/Windows') === '')
  check('拦截 vbscript:', safeLink('vbscript:msgbox') === '')
  check('拦截带换行的伪装', safeLink('java\nscript:alert(1)') === '')
  check('拦截带前导空白的伪装', safeLink(' javascript:alert(1)') === '')
}

console.log('\n== 行内 Markdown 不产出可执行 HTML ==')
{
  const out1 = inlineMarkdown('<img src=x onerror=alert(1)>')
  check('原始标签被转义', !out1.includes('<img'), out1)

  const out2 = inlineMarkdown('[点我](javascript:alert(1))')
  check('javascript: 链接降级为纯文本', !out2.includes('href='), out2)

  const out3 = inlineMarkdown('[安全](https://example.com)')
  // URL 规范化会补尾斜杠，所以只断言主机部分
  check('正常链接仍生成 <a>', out3.includes('href=') && out3.includes('example.com'), out3)
  check('外链带 noopener', out3.includes('rel="noopener noreferrer"'), out3)

  const out4 = inlineMarkdown('**粗体** 与 `代码`')
  check('加粗与行内代码仍生效', out4.includes('<strong>粗体</strong>') && out4.includes('<code>代码</code>'), out4)

  const out5 = inlineMarkdown('<script>alert(1)</script>')
  check('script 标签被转义', !out5.includes('<script>'), out5)
}

console.log('\n== 块级 Markdown 安全与结构 ==')
{
  const html1 = renderMarkdown('# 标题\n\n正文 **加粗**')
  check('生成 h1', html1.includes('<h1>标题</h1>'), html1)
  check('生成 p + strong', html1.includes('<p>') && html1.includes('<strong>加粗</strong>'), html1)

  const html2 = renderMarkdown('<iframe src="javascript:alert(1)"></iframe>')
  check('iframe 被转义', !html2.includes('<iframe'), html2)

  const html3 = renderMarkdown('- a\n- b')
  check('无序列表', html3.includes('<ul>') && html3.includes('<li>a</li>'), html3)

  const html4 = renderMarkdown('1. a\n2. b')
  check('有序列表', html4.includes('<ol>') && html4.includes('<li>b</li>'), html4)

  const html5 = renderMarkdown('```js\nconst a = "<b>"\n```')
  check('代码块内容被转义', html5.includes('&lt;b&gt;') && !html5.includes('<b>'), html5)

  const html6 = renderMarkdown('[x](javascript:alert(1))')
  check('块级里也不放行 javascript:', !html6.includes('href='), html6)

  const html7 = renderMarkdown('> 引用')
  check('引用块', html7.includes('<blockquote>'), html7)

  const deep = renderMarkdown('> '.repeat(8) + '深层')
  check('深层嵌套不崩溃', typeof deep === 'string' && deep.length > 0)

  const empty = renderMarkdown('')
  check('空输入返回空串', empty === '', JSON.stringify(empty))
}

console.log('\n== 标签规范化（与服务端规则一致）==')
{
  check('去空白', normalizeTag('  a  ').tag === 'a')
  check('拒绝空', normalizeTag('   ').ok === false)
  check('拒绝英文逗号', normalizeTag('a,b').ok === false)
  check('拒绝右方括号', normalizeTag('a]b').ok === false)
  check('拒绝超长', normalizeTag('x'.repeat(41)).ok === false)
  check('允许中文', normalizeTag('发布').ok === true)
}

console.log('\n== 字段校验（与服务端对齐的部分）==')
{
  const base = { title: 't', description: '', type: 'project', scope: 'project', tags: [], slug: 'a-b', body: 'b' }
  check('合法草稿无错误', Object.keys(validateDraft(base)).length === 0, JSON.stringify(validateDraft(base)))
  check('空标题报错', Boolean(validateDraft({ ...base, title: '  ' }).title))
  check('空正文报错', Boolean(validateDraft({ ...base, body: '' }).body))
  check('非法 slug 报错', Boolean(validateDraft({ ...base, slug: '中文' }).slug))
  check('超长摘要报错', Boolean(validateDraft({ ...base, description: 'x'.repeat(121) }).description))
  check('非法 scope 报错', Boolean(validateDraft({ ...base, scope: 'wild' }).scope))
  check('标签超 20 报错', Boolean(validateDraft({ ...base, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).tags))
  check('标签含逗号报错', Boolean(validateDraft({ ...base, tags: ['a,b'] }).tags))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
