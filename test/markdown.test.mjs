/**
 * Markdown 渲染与标签校验的安全测试。
 *
 * 为什么必须测：面板把正文渲染成 HTML（记忆的预览、待确认卡片、全局指令各章、只读的项目指令，含裸网址自动成链接）。
 * 这类代码只靠截图看不出来问题——必须逐条验证恶意输入不会变成可执行内容。
 *
 * 做法：给 client.js 注入一个收集钩子，把 factory 内部的纯函数拿出来测。
 * client.js 是浏览器脚本，所以要先伪造 window.__ModuleLoader__ 和 require('react')。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Node 18 没有 import.meta.dirname（20.11 才加），统一用它替代
const HERE = path.dirname(fileURLToPath(import.meta.url))

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

const clientPath = path.join(HERE, '..', 'client.js')
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

const { escapeHTML, safeLink, autoLink, inlineMarkdown, renderMarkdown, validateTag, validateDraft, normalizeLimits } = captured

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

console.log('\n== 裸网址自动成链接（预览的渲染器）：仍过白名单、不产出可执行 HTML ==')
{
  const out1 = renderMarkdown('文档在 https://example.com/docs?a=1&b=2 里')
  check('裸 https 网址变成链接', out1.includes('<a href="https://example.com/docs?a=1&amp;b=2"') && out1.includes('rel="noopener noreferrer"'), out1)
  check('中文标点不并进网址', renderMarkdown('见 https://example.com，然后').includes('href="https://example.com/"'))
  check('javascript: 不会被自动识别成链接', !renderMarkdown('javascript:alert(1)').includes('<a '))
  // 在原文上识别网址：转义后的 &gt; &quot; &#39; 与句末标点都不能进 href
  const hrefOf = (html) => {
    const m = /<a href="([^"]*)"/.exec(html)
    return m ? m[1].replace(/&amp;/g, '&') : null
  }
  check('<网址>：尖括号不进 href', hrefOf(renderMarkdown('<https://github.com/x>')) === 'https://github.com/x', renderMarkdown('<https://github.com/x>'))
  check('双引号包着的网址：引号不进 href', hrefOf(renderMarkdown('见 "https://example.com/a" 这里')) === 'https://example.com/a')
  check('单引号包着的网址：引号不进 href', hrefOf(renderMarkdown("at 'https://example.com/a' ok")) === 'https://example.com/a')
  check('句末句号不进 href，留在链接外面', hrefOf(renderMarkdown('See https://example.com/a.')) === 'https://example.com/a' && renderMarkdown('See https://example.com/a.').includes('</a>.'))
  check('句末的 , ; : ! ? 都不进 href', ['，', ',', ';', ':', '!', '?'].every((p) => hrefOf(renderMarkdown('https://example.com/a' + p)) === 'https://example.com/a'))
  check('括号包着的网址：右括号不进 href', hrefOf(renderMarkdown('(https://example.com/a)')) === 'https://example.com/a')
  check('网址里成对的括号保留（维基式链接）', hrefOf(renderMarkdown('https://en.wikipedia.org/wiki/Foo_(bar)')) === 'https://en.wikipedia.org/wiki/Foo_(bar)')
  const out2 = autoLink('https://x.example/"onmouseover=alert(1)')
  check('网址后紧跟的引号不进属性：href 正确、引号在链接外面被转义', hrefOf(out2) === 'https://x.example/' && out2.includes('</a>&quot;onmouseover'), out2)
  check('autoLink 转义网址前后的文字', autoLink('<b>https://a.example</b>').startsWith('&lt;b&gt;<a href="https://a.example/"'))
  check('只有协议头的不算网址', !renderMarkdown('https:// 和 http://').includes('<a '))
  const out3 = inlineMarkdown('[https://a.example](https://b.example)')
  check('链接文字里的网址不再套一层 <a>', (out3.match(/<a /g) || []).length === 1, out3)
  check('代码里的网址不变成链接', !renderMarkdown('`https://example.com`').includes('<a '))
}

console.log('\n== 标签校验（与服务端规则一致；上限来自宿主 limits）==')
{
  const limits = normalizeLimits({ maxTags: 20, maxTagChars: 40 })
  check('去空白后合法', validateTag('  a  ', [], limits) === '')
  check('拒绝空', validateTag('   ', [], limits) !== '')
  check('拒绝英文逗号', validateTag('a,b', [], limits) !== '')
  check('拒绝右方括号', validateTag('a]b', [], limits) !== '')
  check('拒绝超长', validateTag('x'.repeat(41), [], limits) !== '')
  check('拒绝重复', validateTag('a', ['a'], limits) !== '')
  check('允许中文', validateTag('发布', [], limits) === '')
}

console.log('\n== 字段校验（与服务端对齐的部分）==')
{
  const limits = normalizeLimits({ maxTitleChars: 200, maxDescriptionChars: 120, maxBodyChars: 20000, maxTags: 20, maxTagChars: 40 })
  const base = { title: 't', description: '', type: 'project', scope: 'project', tags: [], slug: 'a-b', body: 'b' }
  check('合法草稿无错误', Object.keys(validateDraft(base, limits, base)).length === 0, JSON.stringify(validateDraft(base, limits, base)))
  check('空标题报错', Boolean(validateDraft({ ...base, title: '  ' }, limits, base).title))
  check('空正文报错', Boolean(validateDraft({ ...base, body: '' }, limits, base).body))
  check('改成非法 slug 报错', Boolean(validateDraft({ ...base, slug: '中文' }, limits, base).slug))
  check('超长摘要报错', Boolean(validateDraft({ ...base, description: 'x'.repeat(121) }, limits, base).description))
  check('非法 scope 报错', Boolean(validateDraft({ ...base, scope: 'wild' }, limits, base).scope))
  check('标签超 20 报错', Boolean(validateDraft({ ...base, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, limits, base).tags))
  check('标签含逗号报错', Boolean(validateDraft({ ...base, tags: ['a,b'] }, limits, base).tags))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
