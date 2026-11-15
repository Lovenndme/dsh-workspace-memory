/**
 * client.js 的纯逻辑（2026-11-15 面板重设计之后）：i18n 键对称与占位符、失败原因码 → 文案、来源分类、可能过时、
 * 草稿去向与「为什么要你确认」、字段 / 标签 / 章标题校验、新旧对比、每轮开销、宿主响应的归一化（含旧宿主缺字段时的降级）、
 * 收下后的提示、样式表的作用域，以及语言注册。
 *
 * 取函数的办法与 markdown.test.mjs 相同：client.js 是浏览器脚本，只能伪造 window.__ModuleLoader__ 与 require('react')，
 * 再经 __wsmCollectPure 钩子取出 factory 内部的纯函数。面板组件本身用 preview/verification/render-harness.html 渲染验收。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail !== undefined ? `\n        ${detail}` : ''}`)
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
const requireStub = (name) => {
  if (name === 'react') return { createElement: () => null, useState: () => [null, () => {}] }
  throw new Error(`unexpected require: ${name}`)
}
definition.factory(requireStub)
if (!captured) {
  console.error('纯函数未导出')
  process.exit(1)
}

const {
  validateDraft, validateTag, checkChapterTitle, singleLine, isImeEvent, bareTitle, locateSection, reasonText, sourceKind, staleInfo,
  destOf, whyOf, toDraft, sameDraft, normalizeLimits, normalizeAgents, normalizeProject, normalizeWorkspace, historyDirOf, diffRows,
  inlineDiff, bytesOf, kb, tokensOf, relTime, absTime, homeShort, costParts, withUids, acceptOutcome, acceptErrorText, chapterBytes,
  demoteHeadings, estimatePromotedBytes, styleObj, renderMarkdown, KNOWN_REASONS, TYPES, STYLESHEET, dictionaries,
} = captured
const { ZH, EN } = dictionaries
const DAY = 864e5
const NOW = Date.parse('2026-11-14T03:00:00.000Z')
const ago = (days) => new Date(NOW - days * DAY).toISOString()

console.log('== i18n：键对称、占位符一致、代码里引用的键都存在 ==')
{
  const zhKeys = Object.keys(ZH)
  const enKeys = Object.keys(EN)
  check('ZH 与 EN 键数一致', zhKeys.length === enKeys.length, `${zhKeys.length} vs ${enKeys.length}`)
  check('ZH 有而 EN 没有：无', zhKeys.filter((key) => !(key in EN)).length === 0, zhKeys.filter((key) => !(key in EN)).join(', '))
  check('EN 有而 ZH 没有：无', enKeys.filter((key) => !(key in ZH)).length === 0, enKeys.filter((key) => !(key in ZH)).join(', '))
  check('没有空文案', [...zhKeys, ...enKeys].every((key) => String(ZH[key] ?? EN[key]).trim() !== ''))
  const holes = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
  const mismatched = zhKeys.filter((key) => key in EN && holes(ZH[key]) !== holes(EN[key]))
  check('中英文案的占位符一一对应', mismatched.length === 0, mismatched.join(', '))

  // 代码里以字面量写出的键（含多段，如 'ov.cell.open'）都必须在字典里
  const prefixes = 'tab|action|nav|act|focus|layer|axis|type|src|time|unit|ov|pd|in|mm|guard|err|toast|st|dlg|reason'
  const literals = new Set([...source.matchAll(new RegExp(`'((?:${prefixes})\\.[A-Za-z.-]*[A-Za-z-])'`, 'g'))].map((m) => m[1]))
  const missing = [...literals].filter((key) => !(key in ZH) || !(key in EN))
  check(`代码里引用的 ${literals.size} 个字面量键都存在于 ZH 与 EN`, missing.length === 0, missing.join(', '))

  // 拼接出来的键（'type.' + ty 之类）字面量扫描看不到，逐族点名
  const families = [
    ...TYPES.flatMap((ty) => [`type.${ty}`, `type.${ty}.tip`]),
    ...['verified', 'mismatch', 'legacy', 'agent', 'confidence'].flatMap((k) => [`src.${k}`, `src.${k}.tip`]),
    ...['global', 'agent', 'unverified', 'review'].map((k) => `pd.why.${k}`),
    ...['globalInstr', 'projInstr', 'globalMem', 'projMem'].flatMap((k) => [`layer.${k}`, `layer.${k}.desc`]),
    ...['team', 'local'].flatMap((k) => [`layer.${k}`, `layer.${k}.short`, `layer.${k}.desc`]),
    ...['always', 'ondemand', 'all', 'project'].map((k) => `axis.${k}`),
    ...['overview', 'pending', 'instructions', 'memories'].map((k) => `nav.${k}`),
    'layer.skill', 'layer.none',
  ]
  const gaps = families.filter((key) => !(key in ZH) || !(key in EN))
  check('拼接出来的键族（类型、来源、去向、层、轴、导航）都齐全', gaps.length === 0, gaps.join(', '))

  // 用户拍板的新叫法（2026-11-15）
  check('type 显示名是新叫法', ZH['type.user'] === '关于你' && ZH['type.feedback'] === '做事要求' && ZH['type.project'] === '项目决定' && ZH['type.reference'] === '资料位置' && ZH['type.pitfall'] === '踩坑经验')
  const zhValues = Object.values(ZH).join('\n')
  check('旧的类型叫法不再出现', !/用户偏好|纠正反馈|项目决策|参考索引/.test(zhValues))
  // 「跨项目」只允许出现在流程图里那句「看是否跨项目成立」（说的是判断条件，不是库名）
  const labelValues = Object.entries(ZH).filter(([key]) => key !== 'ov.flow.restNote').map(([, v]) => v).join('\n')
  check('不再用「跨项目」「记忆库」当界面叫法', !/跨项目|记忆库/.test(labelValues))
  check('章节一律叫「章」：没有「第 N 节」「N 节」', !/[第\d]\s*节/.test(zhValues))
  check('来源标签的「·」两侧有空格', ['src.verified', 'src.mismatch', 'src.legacy'].every((key) => ZH[key].includes(' · ')))
  check('「升为全局指令」是动作名', ZH['mm.menu.promote'] === '升为全局指令' && ZH['mm.promote.ok'] === '升为全局指令')
  check('不承诺界面上不存在的「可回退」', !/可回退/.test(zhValues))
}

console.log('\n== 失败原因码 → 文案（原码绝不外露）==')
{
  // 宿主的原因码不手写：从 index.js 读出来——REASON_STATUS 的键 + HTTP 路由（register(`${API}/…`)）里、以及路由
  // 一路调用到的函数里出现的 `reason: '…'` 与 `RequestError(状态, '…')`。只给模型看的工具结果（memory_remember 的
  // needs-slug 之类）不经过路由，不在其中。宿主新增一个面板能收到的码而客户端没认，这里就会失败。
  const hostSource = readFileSync(path.join(import.meta.dirname, '..', 'index.js'), 'utf8')
  const braceBlock = (from) => {
    const start = hostSource.indexOf('{', from)
    let depth = 0
    for (let j = start; j >= 0 && j < hostSource.length; j += 1) {
      if (hostSource[j] === '{') depth += 1
      else if (hostSource[j] === '}' && --depth === 0) return hostSource.slice(start, j + 1)
    }
    return ''
  }
  const reasonsIn = (text) => [
    ...[...text.matchAll(/reason:\s*'([a-z][a-z-]+)'/g)].map((m) => m[1]),
    ...[...text.matchAll(/RequestError\(\s*\d+\s*,\s*'([a-z][a-z-]+)'/g)].map((m) => m[1]),
  ]
  const fns = new Map()
  for (const m of hostSource.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/gm)) {
    // 函数体从参数表之后的 `) {` 起算：参数默认值里的 {} 不是函数体
    const re = /\)\s*\{/g
    re.lastIndex = m.index
    const at = re.exec(hostSource)
    fns.set(m[1], at ? braceBlock(at.index) : '')
  }
  for (const m of hostSource.matchAll(/\bconst\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g)) {
    const arrow = hostSource.indexOf('=>', m.index)
    if (arrow > 0 && hostSource.indexOf('{', arrow) - arrow < 4 && !fns.has(m[1])) fns.set(m[1], braceBlock(arrow))
  }
  const hostReasons = new Set(
    [...braceBlock(hostSource.indexOf('REASON_STATUS = {')).matchAll(/'([a-z][a-z-]+)'\s*:/g)].map((m) => m[1]),
  )
  const seen = new Set()
  const queue = []
  const visit = (text) => {
    reasonsIn(text).forEach((code) => hostReasons.add(code))
    for (const m of text.matchAll(/\b([A-Za-z0-9_]+)\s*\(/g)) {
      if (fns.has(m[1]) && !seen.has(m[1])) {
        seen.add(m[1])
        queue.push(m[1])
      }
    }
  }
  let routeCount = 0
  for (const m of hostSource.matchAll(/register\(\s*`\$\{API\}\/[^`]+`/g)) {
    let depth = 0
    let j = hostSource.indexOf('(', m.index)
    for (; j < hostSource.length; j += 1) {
      if (hostSource[j] === '(') depth += 1
      else if (hostSource[j] === ')' && --depth === 0) break
    }
    routeCount += 1
    visit(hostSource.slice(m.index, j + 1))
  }
  for (const name of ['readJsonBody', 'getRoute', 'postRoute']) if (fns.has(name)) visit(fns.get(name))
  while (queue.length) visit(fns.get(queue.shift()))
  const codes = [...hostReasons].sort()
  // 解析器自身的守卫：路由和几个已知的码必须找得到，否则是正则失效了
  check(`从 index.js 读到 ${routeCount} 个路由、${codes.length} 个面板可能收到的原因码`, routeCount >= 12 && codes.length >= 25)
  check('读到的码里有 section-moved / already-exists / file-missing / invalid-target / no-session',
    ['section-moved', 'already-exists', 'file-missing', 'invalid-target', 'no-session'].every((code) => hostReasons.has(code)), codes.join(' '))
  check('KNOWN_REASONS 覆盖宿主路由可能返回的全部原因码', codes.every((code) => KNOWN_REASONS.includes(code)),
    codes.filter((code) => !KNOWN_REASONS.includes(code)).join(', '))
  for (const code of KNOWN_REASONS) {
    check(`reason.${code} 在 ZH 与 EN 中都有`, `reason.${code}` in ZH && `reason.${code}` in EN)
    const text = reasonText({ ok: false, reason: code }, 'FALLBACK')
    check(`reason ${code} 译成人话`, text !== code && text !== 'FALLBACK' && !text.startsWith('reason.') && !text.includes(code), text)
  }
  check('error 字段里的原因码同样被翻译', reasonText({ ok: false, error: 'agents-full' }, 'F') === ZH['reason.agents-full'])
  check('agents-full 带字节数时给出具体数字', reasonText({ reason: 'agents-full', bytes: 9100, limit: 9000 }, 'F').includes('9100'))
  check('按原因码处理，不看 HTTP 状态（already-exists 是 400 还是 409 都一样）', reasonText({ ok: false, status: 409, reason: 'already-exists' }, 'F') === ZH['reason.already-exists'])
  check('未知原因码不外露，落到宿主给的 errors[0]', reasonText({ reason: 'weird-code', errors: ['宿主说明'] }, 'F') === '宿主说明')
  check('未知原因码且无任何文本时用兜底', reasonText({ reason: 'weird-code' }, 'F') === 'F')
  check('error 是普通消息时原样给出', reasonText({ error: '待确认队列里没有 dr_x' }, 'F') === '待确认队列里没有 dr_x')
  check('空对象 / null / 非对象都用兜底', reasonText({}, 'F') === 'F' && reasonText(null, 'F') === 'F' && reasonText('x', 'F') === 'F')
}

console.log('\n== 来源分类（U7）==')
{
  check('user + evidenceVerified: true → verified', sourceKind({ source: 'user', evidenceVerified: true }) === 'verified')
  check('user + evidenceVerified: false → mismatch', sourceKind({ source: 'user', evidenceVerified: false }) === 'mismatch')
  check('user 但没有这个键（旧数据）→ legacy', sourceKind({ source: 'user', evidence: '记住' }) === 'legacy')
  check('evidenceVerified 只认布尔 true', sourceKind({ source: 'user', evidenceVerified: 'true' }) === 'legacy')
  check('agent → agent（不看 evidenceVerified）', sourceKind({ source: 'agent', evidenceVerified: true }) === 'agent')
  check('只有旧版置信度 → confidence', sourceKind({ confidence: 0.82 }) === 'confidence')
  check('都没有 → none', sourceKind({}) === 'none' && sourceKind(null) === 'none')
  check('置信度不是有限数字 → none', sourceKind({ confidence: NaN }) === 'none')
}

console.log('\n== 可能过时（U17）==')
{
  check('用过、但 61 天前 → unused', staleInfo({ hits: 4, lastHit: ago(61) }, NOW)?.kind === 'unused')
  check('用过、60 天内 → null', staleInfo({ hits: 4, lastHit: ago(60) }, NOW) === null)
  check('从没用过、建了 31 天 → never', staleInfo({ hits: 0, lastHit: null, created: ago(31) }, NOW)?.kind === 'never')
  check('从没用过、建了 30 天 → null', staleInfo({ hits: 0, created: ago(30) }, NOW) === null)
  check('没有 created 时用 modified', staleInfo({ hits: 0, modified: ago(40) }, NOW)?.days === 40)
  check('有 hits 但没有 lastHit（旧数据）→ 不判过时', staleInfo({ hits: 3, created: ago(400) }, NOW) === null)
  check('坏时间不抛错', staleInfo({ hits: 0, created: 'nope' }, NOW) === null && staleInfo(null, NOW) === null)
}

console.log('\n== 草稿去向（inventory §3.2）与为什么要你确认 ==')
{
  const sections = withUids([
    { index: 0, title: '1. 我是谁', body: 'a', bytes: 10 },
    { index: 1, title: '2. 沟通与输出', body: 'b', bytes: 10 },
  ])
  const memories = [
    { id: 'reply-language-zh', scope: 'project', title: '回复用中文' },
    { id: 'old', scope: 'global', title: '旧的' },
  ]
  const ctx = { sections, memories }
  check('常驻 + 本项目 → blocked（项目 AGENTS.md）', destOf({ load: 'always', scope: 'project' }, ctx).kind === 'blocked')
  const append = destOf({ load: 'always', scope: 'global', newChapter: true }, ctx)
  check('常驻 + newChapter → append，章号 = 现有章数 + 1', append.kind === 'append' && append.next === 3 && append.cell === 'globalInstr')
  const ow = destOf({ load: 'always', scope: 'global', newChapter: false, chapter: 2, chapterTitle: '沟通与输出', supersedes: 'reply-language-zh' }, ctx)
  check('常驻 + chapterTitle → overwrite，按标题定位那一章', ow.kind === 'overwrite' && ow.section === sections[1] && ow.sectionNum === 2 && ow.chapter === 2)
  check('常驻覆盖带 supersedes：旧条默认在项目库', ow.alsoRemove?.id === 'reply-language-zh')
  const gone = destOf({ load: 'always', scope: 'global', chapter: 5, chapterTitle: '已经改名的章' }, ctx)
  check('章标题在文件里找不到 → section 为 null（收下会 section-moved）', gone.kind === 'overwrite' && gone.section === null && gone.sectionNum === 0)
  const dup = withUids([{ title: '1. 甲', body: '' }, { title: '2. 甲', body: '' }])
  check('同名章有两个 → 不猜，section 为 null', destOf({ load: 'always', scope: 'global', chapterTitle: '甲' }, { sections: dup, memories }).section === null)
  check('只有章号没有章标题 → 仍是 overwrite（不显示对比）', destOf({ load: 'always', scope: 'global', chapter: 1 }, ctx).kind === 'overwrite')
  check('按需 + 本项目 → 项目记忆 · 新增', destOf({ load: 'on-demand', scope: 'project' }, ctx).cell === 'projMem' && destOf({ scope: 'project' }, ctx).kind === 'add')
  check('按需 + 所有项目 → 通用记忆', destOf({ load: 'on-demand', scope: 'global' }, ctx).cell === 'globalMem')
  check('按需 + supersedes 同库命中', destOf({ scope: 'global', supersedes: 'old' }, ctx).old?.title === '旧的')
  check('按需 + supersedes 在另一个库也找得到', destOf({ scope: 'project', supersedes: 'old' }, ctx).old?.id === 'old')
  check('按需 + supersedes 已经不在 → replace 但 old 为 null', (() => { const d = destOf({ scope: 'project', supersedes: 'gone' }, ctx); return d.kind === 'replace' && d.old === null })())

  const why = (d) => whyOf(d).map(([k, tone]) => k + (tone ? ':' + tone : '')).join(',')
  check('常驻 + 已核对原话 → 只有 global', why({ load: 'always', source: 'user', evidenceVerified: true }) === 'global')
  check('常驻 + Agent 总结 → global,agent', why({ load: 'always', source: 'agent' }) === 'global,agent')
  check('按需 + 没核对上 → unverified（警告色）', why({ load: 'on-demand', source: 'user', evidenceVerified: false }) === 'unverified:warn')
  check('按需 + 已核对（agentWrites=review 才会进来）→ review', why({ load: 'on-demand', source: 'user', evidenceVerified: true }) === 'review')
}

console.log('\n== 字段校验：上限来自宿主 limits，没有就不拦 ==')
{
  const limits = normalizeLimits({ maxMemoryCount: 50, maxTitleChars: 10, maxDescriptionChars: 5, maxBodyChars: 20, maxTags: 2, maxTagChars: 4 })
  const base = { title: 't', description: '', type: 'project', scope: 'project', tags: [], slug: 'a-b', body: 'b' }
  check('合法草稿无错误', Object.keys(validateDraft(base, limits, base)).length === 0, JSON.stringify(validateDraft(base, limits, base)))
  check('空标题报错', Boolean(validateDraft({ ...base, title: '  ' }, limits, base).title))
  check('标题含 \\n / \\r\\n 报错', Boolean(validateDraft({ ...base, title: 'a\nb' }, limits, base).title) && Boolean(validateDraft({ ...base, title: 'a\r\nb' }, limits, base).title))
  check('摘要含换行报错', Boolean(validateDraft({ ...base, description: 'x\nscope: global' }, limits, base).description))
  check('标题超出宿主上限报错（文案带上限数字）', (validateDraft({ ...base, title: 'x'.repeat(11) }, limits, base).title || '').includes('10'))
  check('长度按 trim 后算（与宿主一致）', !validateDraft({ ...base, title: '  ' + 'x'.repeat(10) + '  ' }, limits, base).title)
  check('摘要、正文、标签个数与长度按 limits 拦', Boolean(validateDraft({ ...base, description: '123456' }, limits, base).description)
    && Boolean(validateDraft({ ...base, body: 'x'.repeat(21) }, limits, base).body)
    && Boolean(validateDraft({ ...base, tags: ['a', 'b', 'c'] }, limits, base).tags)
    && Boolean(validateDraft({ ...base, tags: ['abcde'] }, limits, base).tags))
  check('没有 limits（旧宿主）就不拦长度', Object.keys(validateDraft({ ...base, title: 'x'.repeat(500), body: 'y'.repeat(30000) }, normalizeLimits(undefined), base)).length === 0)
  check('pitfall 合法、未知分类报错', !validateDraft({ ...base, type: 'pitfall' }, limits, base).type && Boolean(validateDraft({ ...base, type: 'nonsense' }, limits, base).type))
  check('正文允许换行', !validateDraft({ ...base, body: 'a\n\nb' }, limits, base).body)
  // U16：旧条目的 id 可能是中文或大写，没改文件名就不拦，改了才按规则校验
  const legacy = { ...base, slug: '旧条目' }
  check('文件名没改：旧的中文 id 不挡保存', !validateDraft(legacy, limits, legacy).slug)
  check('文件名改了：按规则校验', Boolean(validateDraft({ ...legacy, slug: 'Bad' }, limits, legacy).slug))
  check('文件名至少 2 个字符（宿主规则）', Boolean(validateDraft({ ...base, slug: 'a' }, limits, base).slug))
  check('没有基线时一律校验文件名', Boolean(validateDraft({ ...base, slug: '中文' }, limits).slug))

  check('新标签：空', validateTag('  ', [], limits) === ZH['err.tag.empty'])
  check('新标签：逗号 / ] / 换行（首尾空白先去掉，与宿主一致）', [',', ']', '\n'].every((ch) => validateTag('a' + ch + 'b', [], limits) === ZH['err.tag.chars']) && validateTag('ab\n', [], limits) === '')
  check('新标签：超长', validateTag('abcde', [], limits).includes('4'))
  check('新标签：重复', validateTag(' a ', ['a'], limits) === ZH['err.tag.dup'])
  check('新标签：个数满了', validateTag('c', ['a', 'b'], limits).includes('2'))
  check('新标签：合法', validateTag('发布', [], limits) === '')
  check('新标签：没有 limits 时不拦长度与个数', validateTag('x'.repeat(100), Array.from({ length: 50 }, (_, i) => 't' + i), normalizeLimits(null)) === '')

  const secs = withUids([{ title: '1. 我是谁', body: '' }, { title: '2. 沟通与输出', body: '' }])
  check('章标题：空白压平后为空报错', checkChapterTitle(' \n ', secs, null).error === ZH['in.err.emptyTitle'])
  check('章标题：与别的章同名报错', checkChapterTitle('沟通与输出', secs, null).error.includes('沟通与输出'))
  check('章标题：与自己同名不算重名', checkChapterTitle('沟通与输出', secs, secs[1].uid).error === '')
  check('章标题：换行压成空格', checkChapterTitle('a\nb', secs, null).title === 'a b')
  check('章标题：开头的编号去掉（宿主写入时也会剥），保存后按它找回那一章', checkChapterTitle('2. 新的一章', secs, null).title === '新的一章')
  check('章标题：带编号的同名也算重名', checkChapterTitle('9. 沟通与输出', secs, null).error.includes('沟通与输出'))
  check('章标题：只有编号等于空', checkChapterTitle('3. ', secs, null).error === ZH['in.err.emptyTitle'])
  check('singleLine 把换行压成空格、对 null 安全', singleLine('a\r\nb\nc') === 'a b c' && singleLine(null) === '')
}

console.log('\n== 输入法组字判断 ==')
{
  check('原生 isComposing', isImeEvent({ isComposing: true }) === true)
  check('React 合成事件只有 nativeEvent.isComposing', isImeEvent({ nativeEvent: { isComposing: true } }) === true)
  check('keyCode 229 视为组字', isImeEvent({ keyCode: 229 }) === true)
  check('普通回车不是组字', isImeEvent({ key: 'Enter', nativeEvent: { isComposing: false }, keyCode: 13 }) === false)
  check('空事件安全', isImeEvent(undefined) === false)
}

console.log('\n== AGENTS.md 章：去编号、按标题找回、uid 稳定 ==')
{
  check('bareTitle 去掉章号', bareTitle('3. 标题') === '标题' && bareTitle('3.2. 子标题') === '子标题')
  check('bareTitle 不动没有编号的标题', bareTitle('  Plain  ') === 'Plain' && bareTitle('2024 年计划') === '2024 年计划')
  const sections = [{ title: '1. 甲' }, { title: '2. 乙' }]
  check('位置没变：仍是原位置', locateSection(sections, '2. 乙', 1) === 1)
  check('前面插了一章：按标题找回', locateSection([{ title: '1. 新' }, { title: '2. 甲' }, { title: '3. 乙' }], '2. 乙', 1) === 2)
  check('章被删掉：返回 -1；非数组安全', locateSection(sections, '9. 丁', 0) === -1 && locateSection(null, 'x', 0) === -1)
  const a = withUids([{ index: 0, title: '1. 甲', body: 'x', bytes: 12 }, { index: 1, title: '2. 甲', body: 'y' }])
  const b = withUids([{ index: 0, title: '1. 新' }, { index: 1, title: '2. 甲', body: 'x' }, { index: 2, title: '3. 甲' }])
  check('withUids 去编号取名、保留宿主的 index 与 bytes', a[0].name === '甲' && a[0].index === 0 && a[0].bytes === 12)
  check('前面插一章后 uid 不变（按标题 + 同名序号）', a[0].uid === b[1].uid && a[1].uid === b[2].uid && a[0].uid !== a[1].uid)
  check('demoteHeadings 把 # / ## 压到 ### 及以下', demoteHeadings('# a\n## b\n### c\ntext') === '### a\n### b\n#### c\ntext')
  const est = estimatePromotedBytes(1871, 9, '标题', '正文', 'some-id')
  check('升级后的大小估算 > 现有大小，且包含来源注释', est > 1871 + chapterBytes(9, '标题', '正文'))
  check('文件不存在时从 0 估算', estimatePromotedBytes(0, 1, 't', 'b', 'i') > 0)
}

console.log('\n== 新旧对比 ==')
{
  const same = diffRows('a\nb', 'a\nb')
  check('相同文本没有增删行', same.every((r) => r.t === '=' || r.t === 'gap'))
  const changed = diffRows('先给结论，再给理由和细节', '先给结论，再给理由、细节和例子')
  check('相近的一行：行内对比（同一对 - / + 行）', changed.length === 2 && changed[0].t === '-' && changed[1].t === '+' && changed[0].inline === true && changed[1].segs.some((s) => s.ch))
  const rewrite = diffRows('完全不同的一句话', 'Something else entirely')
  check('差别太大：整行删 + 整行增，不做碎片对比', rewrite.length === 2 && !rewrite[0].inline)
  const long = diffRows(['1', '2', '3', '4', '5', '6', 'x'].join('\n'), ['1', '2', '3', '4', '5', '6', 'y'].join('\n'))
  check('开头 6 行没变 → 折叠成「n 行没变」，保留紧邻改动的 1 行', long[0].t === 'gap' && long[0].n === 5 && long[1].t === '=' && long[1].segs[0].s === '6')
  check('inlineDiff：改动太碎返回 null', inlineDiff('abcdefgh', '12345678') === null)
  check('null / undefined 安全', Array.isArray(diffRows(null, undefined)))
  const big = Array.from({ length: 900 }, (_, i) => 'line ' + i).join('\n')
  const t0 = performance.now()
  const huge = diffRows(big, big + '\nmore')
  check('900 × 900 行在 1 秒内（超过阈值改为整段对比）', performance.now() - t0 < 1000 && huge.length > 0, `${(performance.now() - t0).toFixed(0)}ms`)
}

console.log('\n== 字节、KB、tokens、时间 ==')
{
  check('bytesOf 按 UTF-8 计', bytesOf('a中') === 4 && bytesOf(null) === 0)
  check('kb：10 KB 以下一位小数，以上去掉多余小数', kb(1871) === '1.9' && kb(12345) === '12.3' && kb(0) === '0' && kb(10000) === '10')
  check('tokens = 字节 ÷ 3.5 取整', tokensOf(3500) === 1000 && tokensOf(undefined) === 0)
  check('relTime：刚刚 / 分钟 / 小时 / 昨天 / 天 / 月', relTime(ago(0), NOW) === '刚刚' && relTime(new Date(NOW - 5 * 60e3).toISOString(), NOW) === '5 分钟前'
    && relTime(new Date(NOW - 3 * 3600e3).toISOString(), NOW) === '3 小时前' && relTime(ago(1), NOW) === '昨天' && relTime(ago(6), NOW) === '6 天前' && relTime(ago(95), NOW) === '3 个月前')
  check('relTime：坏值 / 空值返回空串', relTime('nope', NOW) === '' && relTime(null, NOW) === '')
  check('absTime：同年不写年份，跨年写年份', !absTime('2026-03-01T00:00:00Z', NOW).includes('2026') && absTime('2025-03-01T00:00:00Z', NOW).includes('2025'))
  check('homeShort：Windows 与 POSIX 家目录都缩成 ~', homeShort('C:\\Users\\demo\\.dsh\\AGENTS.md') === '~\\.dsh\\AGENTS.md' && homeShort('/home/demo/.dsh/AGENTS.md') === '~/.dsh/AGENTS.md')
}

console.log('\n== 宿主响应归一化（含旧宿主缺字段时的降级）==')
{
  const L = normalizeLimits({ maxMemoryCount: 0, maxTitleChars: 200, maxTags: -1, maxBodyChars: 'x' })
  check('上限：0 / 负数 / 坏值都当「不限」（null）', L.maxMemoryCount === null && L.maxTags === null && L.maxBodyChars === null && L.maxTitleChars === 200)
  check('没有 limits → 全是 null', Object.values(normalizeLimits(undefined)).every((v) => v === null))

  const ok = normalizeAgents(
    { ok: true, status: 200, payload: { ok: true, path: 'P', bytes: 1871, preamble: '# x', sections: [{ index: 0, title: '1. 甲', body: 'b', bytes: 9 }], limit: 10000, mtime: '2026-11-12T07:20:00.000Z', historyLimit: 20, historyDir: 'H' } },
    { ok: true, status: 200, payload: { ok: true, agents: { path: 'P', exists: true, bytes: 1871, sections: 1 } } },
  )
  check('全局指令：正常读到，带上限 / 修改时间 / 备份份数 / 目录', ok.status === 'ok' && ok.exists && ok.bytes === 1871 && ok.limit === 10000 && ok.historyLimit === 20 && ok.historyDir === 'H' && ok.sections[0].name === '甲')
  const old = normalizeAgents({ ok: true, status: 200, payload: { ok: true, path: 'P', bytes: 10, preamble: '', sections: [] } }, { ok: true, status: 200, payload: { ok: true, agents: { exists: true } } })
  check('旧宿主没有 limit / mtime / historyLimit → null，不显示上限', old.status === 'ok' && old.limit === null && old.mtime === null && old.historyLimit === null)
  check('limit 为 0（不限）→ null', normalizeAgents({ ok: true, payload: { ok: true, sections: [], limit: 0 } }, null).limit === null)
  const missing = normalizeAgents({ ok: false, status: 200, payload: { ok: false, reason: 'agents-missing', path: 'P', limit: 10000 } }, { ok: true, payload: { ok: true, agents: { exists: false } } })
  check('文件不存在 → missing（专门的空状态，不是「读取失败」）', missing.status === 'missing' && !missing.exists && missing.path === 'P' && missing.limit === 10000)
  const broken = normalizeAgents({ ok: false, status: 500, payload: { ok: false, errors: ['读不了'] } }, { ok: false, status: 500, payload: {} })
  check('读失败 → error，带宿主的说明', broken.status === 'error' && broken.error === '读不了')
  const offline = normalizeAgents({ ok: false, status: 0, payload: { ok: false } }, null)
  check('网络失败 → error，不抛错', offline.status === 'error' && typeof offline.error === 'string')

  const proj = normalizeProject({ ok: true, status: 200, payload: { ok: true, workspace: { path: 'D:\\work\\shop', name: 'shop' }, root: { path: 'D:\\work\\shop\\pkg', name: 'pkg' }, team: { path: 'T', exists: true, bytes: 12, mtime: 'M', body: 'x', truncated: true }, local: { path: 'L', exists: false } } })
  check('项目指令：正常读到，root 优先于 workspace', proj.status === 'ok' && proj.root.name === 'pkg' && proj.workspace.name === 'shop' && proj.team.truncated && proj.team.bytes === 12 && !proj.local.exists && proj.local.body === '')
  check('项目指令：没有 root → 回落 workspace', normalizeProject({ ok: true, status: 200, payload: { ok: true, workspace: { path: 'D:\\w\\a' }, team: {}, local: {} } }).root.name === 'a')
  check('项目指令：读出错的文件带 error', normalizeProject({ ok: true, status: 200, payload: { ok: true, team: { exists: true, error: '权限不足' }, local: {} } }).team.error === '权限不足')
  check('旧宿主没有这个路由（404）→ unavailable', normalizeProject({ ok: false, status: 404, payload: {} }).status === 'unavailable')
  check('网络失败 → unavailable', normalizeProject({ ok: false, status: 0, payload: { ok: false } }).status === 'unavailable')
  check('宿主报错（如 no-session）→ error，原因码译成人话', (() => { const r = normalizeProject({ ok: false, status: 400, payload: { ok: false, reason: 'no-session', errors: ['缺少 session'] } }); return r.status === 'error' && r.error === ZH['reason.no-session'] })())
  check('宿主报错且原因码不认得 → error，带宿主的说明', (() => { const r = normalizeProject({ ok: false, status: 500, payload: { ok: false, errors: ['读不了工作区'] } }); return r.status === 'error' && r.error === '读不了工作区' })())
  check('工作区：没有 name 时取路径最后一段；没有 path → null', normalizeWorkspace({ path: '/home/x/proj/' }).name === 'proj' && normalizeWorkspace({}) === null && normalizeWorkspace(null) === null)

  check('历史目录：宿主给了就用', historyDirOf('global', { historyDir: { global: 'G' } }) === 'G')
  check('历史目录：旧宿主按布局推（Windows）', historyDirOf('project', { root: 'C:\\x\\--p--\\memory' }) === 'C:\\x\\--p--\\.memory-state\\history')
  check('历史目录：旧宿主按布局推（POSIX、通用记忆）', historyDirOf('global', { globalRoot: '/h/.dsh/g/memory' }) === '/h/.dsh/g/.memory-state/history')
  check('历史目录：什么都没有 → 空串', historyDirOf('project', {}) === '' && historyDirOf('project', null) === '')
}

console.log('\n== 每轮固定开销 ==')
{
  const D = {
    agents: { exists: true, bytes: 1871 },
    project: { status: 'ok', team: { exists: true, bytes: 500 }, local: { exists: false, bytes: 0 } },
    memories: [{ id: 'a-b', scope: 'project', description: '摘要' }, { id: 'c', scope: 'global', description: '' }],
  }
  const parts = costParts(D)
  check('只列字节数 > 0 的部分（仅你的文件不存在就不列）', parts.map((p) => p.k).join(',') === 'global,team,index', parts.map((p) => p.k).join(','))
  check('全局指令与项目指令用宿主给的真实字节数', parts[0].bytes === 1871 && parts[1].bytes === 500)
  check('索引行数 = 两个库的条数', parts[2].lines === 2 && parts[2].bytes > 0 && parts[2].hatch === true)
  check('读不到项目指令时不计那两段，也不抛错', costParts({ agents: { exists: false }, project: { status: 'unavailable' }, memories: [] }).length === 0)
}

console.log('\n== 收下之后的提示与失败文案 ==')
{
  const before = {
    sections: withUids([{ title: '1. 我是谁' }, { title: '2. 沟通与输出' }]),
    memories: [{ id: 'reply-language-zh', scope: 'project', title: '回复用中文' }, { id: 'docker-old', scope: 'project', title: '旧的 Docker 记忆' }],
  }
  const added = acceptOutcome({ load: 'always', title: '代码评审' }, { ok: true, load: 'always', agents: { action: 'added', title: '代码评审' } }, before, null)
  check('常驻新章（还没重读）→ 第 N+1 章，带「查看」跳到那一章', added.text.includes('第 3 章') && added.goto.kind === 'chapter' && added.goto.index === 2)
  const updated = acceptOutcome({ load: 'always', chapterTitle: '沟通与输出' }, { ok: true, load: 'always', agents: { action: 'updated', chapter: 2 } }, before, null)
  check('常驻覆盖 → 用宿主给的章号', updated.text.includes('第 2 章') && !updated.persistent)
  const failed = acceptOutcome({ load: 'always', chapterTitle: '沟通与输出', supersedesScope: 'project' }, { ok: true, load: 'always', agents: { action: 'updated', chapter: 2 }, replaceFailed: 'reply-language-zh' }, before, null)
  check('旧记忆没删掉 → 常驻警告，点名旧标题，「去删除」跳到那一条', failed.persistent && failed.tone === 'warn' && failed.text.includes('回复用中文') && failed.goto.key === 'project:reply-language-zh')
  const onDemand = acceptOutcome({ load: 'on-demand', scope: 'project', slug: 'expected', supersedes: 'docker-old' }, { ok: true, scope: 'project', load: 'on-demand', file: 'docker-vite-hmr-wsl2.md', replaced: 'docker-old' }, before, null)
  check('按需：新记忆的 id 以宿主回的文件名为准（不信预计的 slug）', onDemand.goto.key === 'project:docker-vite-hmr-wsl2')
  check('按需替换：提示点名被替换的旧标题', onDemand.text.includes('旧的 Docker 记忆') && onDemand.text.includes('项目记忆'))
  check('按需：宿主没回 file 时退回草稿的 slug', acceptOutcome({ scope: 'global', slug: 's' }, { ok: true, scope: 'global' }, before, null).goto.key === 'global:s')

  const d = { load: 'always', scope: 'global', chapterTitle: '沟通与输出', title: 't' }
  check('section-moved → 点名那一章，说明草稿还在', acceptErrorText(d, { reason: 'section-moved' }).includes('沟通与输出'))
  check('belongs-in-project-agents → 专门的说法', acceptErrorText(d, { reason: 'belongs-in-project-agents' }) === ZH['pd.err.blocked'])
  check('agents-full 带字节 → 换算成 KB', acceptErrorText(d, { reason: 'agents-full', bytes: 10230, limit: 10000 }).includes('10.2'))
  check('library-full 带条数 → 点名库', acceptErrorText({ scope: 'project' }, { reason: 'library-full', count: 50, scope: 'project' }).includes('项目记忆'))
  check('其余失败走 reasonText，原码不外露', acceptErrorText(d, { reason: 'not-found' }) === ZH['reason.not-found'] && acceptErrorText(d, {}) === ZH['err.generic'])
}

console.log('\n== 草稿 ↔ 基线 ==')
{
  check('name 与文件名不一致时 slug 取文件名', toDraft({ id: 'file-id', name: 'My Display Name', title: 't' }).slug === 'file-id')
  check('只有 name 时退回 name；显式 slug 最优先', toDraft({ name: 'only-name' }).slug === 'only-name' && toDraft({ slug: 's', id: 'i', name: 'n' }).slug === 's')
  check('非法 type 显示成 project（与宿主一致）', toDraft({ type: 'weird' }).type === 'project')
  check('sameDraft 比较标签顺序与内容', sameDraft(toDraft({ id: 'a', tags: ['x', 'y'] }), toDraft({ id: 'a', tags: ['x', 'y'] })) && !sameDraft(toDraft({ id: 'a', tags: ['x', 'y'] }), toDraft({ id: 'a', tags: ['y', 'x'] })))
  const source1 = { id: 'a', tags: ['x'] }
  const draft = toDraft(source1)
  draft.tags.push('y')
  check('toDraft 复制标签数组（改草稿不改原条目）', source1.tags.length === 1 && draft.tags.length === 2)
}

console.log('\n== 样式表与官方规范 ==')
{
  // 去掉 @keyframes 块后逐条看选择器（@media 里的规则一并检查）
  const css = STYLESHEET.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  const selectors = []
  css.replace(/(^|[{}])\s*([^{}@]+)\{/g, (all, end, sel) => {
    for (const s of sel.split(/,(?![^(]*\))/)) selectors.push(s.trim())
    return all
  })
  const loose = selectors.filter((s) => s && !s.startsWith('.wsm-panel') && !s.startsWith(':where(.wsm-panel)'))
  check(`样式表 ${selectors.length} 个选择器全部限定在 .wsm-panel 下`, selectors.length > 300 && loose.length === 0, loose.slice(0, 5).join(' | '))
  check('不用宿主里不存在的 token', !/--dsw-alias-bg-canvas|--dsw-alias-bg-layer-4|--dsw-font-mono/.test(STYLESHEET))
  check('不写字面颜色（#hex / rgb()），只用 --dsw-alias-*', !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(STYLESHEET))
  check('不改 :root / body / html', !/(^|[\s,}])(:root|body|html)\b/.test(STYLESHEET))
  check('tooltip 在面板内（.wsm-panel .wsm-tooltip），不往 document.body 追加', STYLESHEET.includes('.wsm-panel .wsm-tooltip') && !/document\.body\.(append|insert|prepend)/.test(source))
  check('照顾 reduced-motion', STYLESHEET.includes('prefers-reduced-motion'))
  check('移植后不再有预览专用的数据与固定的「现在」', !/PREVIEW_EXTRA|PREVIEW_NOW/.test(source))
  check('styleObj：短横线转驼峰，自定义属性原样保留', (() => { const o = styleObj('flex-grow:3;--p:76%;margin-top:4px'); return o.flexGrow === '3' && o['--p'] === '76%' && o.marginTop === '4px' })())
}

console.log('\n== Markdown 渲染的几条边界（安全部分见 markdown.test.mjs）==')
{
  check('空行分段：a 空行 b 渲染成两个 <p>', renderMarkdown('a\n\nb') === '<p>a</p>\n<p>b</p>', renderMarkdown('a\n\nb'))
  check('段内单个换行仍是 <br>', renderMarkdown('a\nb') === '<p>a<br>b</p>')
  const t0 = performance.now()
  renderMarkdown('['.repeat(120000))
  const worst = performance.now() - t0
  check('12 万个未闭合的 [ 在 1 秒内渲染完', worst < 1000, `${worst.toFixed(0)}ms`)
  // 链接文字超过 300 字不按 [文字](网址) 解析；后面的裸网址照常自动成链接（预览的渲染器），文字不会进 <a>
  const longLink = renderMarkdown(`[${'x'.repeat(400)}](https://example.com)`)
  check('超长链接文本不当链接文字（按字面输出），裸网址仍过白名单', !longLink.includes('x</a>') && longLink.includes('[' + 'x'.repeat(400) + ']('), longLink.slice(0, 80))
}

console.log('\n== 界面语言：按 dsh-client-locale 的语言 id 注册与选择 ==')
{
  const fakeLocale = (active, { withBind = true, interpolate = true } = {}) => {
    const dicts = new Map()
    const service = {
      ids: () => [...dicts.keys()].sort(),
      getLocale: () => ({ active, locales: [], revision: 0 }),
      register: (ns, locale, dict) => {
        dicts.set(String(locale).toLowerCase(), dict)
        return () => dicts.delete(String(locale).toLowerCase())
      },
    }
    if (withBind) {
      service.bind = () => (key, vars) => {
        for (const id of active === 'en' ? ['en'] : [active, 'en']) {
          const value = dicts.get(id)?.[key]
          if (value !== undefined) return interpolate && vars ? value.replace(/\{(\w+)\}/g, (all, n) => (vars[n] ?? all)) : value
        }
        return key
      }
    }
    return service
  }
  const activate = (locale) => {
    const plugin = definition.factory(requireStub)
    const own = captured
    const ctx = {
      effect: (fn) => {
        try {
          fn()
        } catch {
          // 样式表 effect 在 Node 里没有 document.createElement，吞掉
        }
      },
      get: (name) => (name === 'locale' ? locale : name === 'sidebarRightTabs' ? { register: () => () => {} } : undefined),
      slots: { inject: () => {}, register: () => {} },
    }
    plugin.apply(ctx)
    return own
  }
  const zh = fakeLocale('zh')
  const zhHelpers = activate(zh)
  check('注册的语言 id 是 zh 与 en（不是 zh-CN）', zh.ids().join() === 'en,zh', zh.ids().join())
  check('中文界面取到中文文案', zhHelpers.reasonText({ reason: 'not-found' }, 'F') === ZH['reason.not-found'])
  check('英文界面取到英文文案', activate(fakeLocale('en')).reasonText({ reason: 'not-found' }, 'F') === EN['reason.not-found'])
  check('没有 bind 时按 snapshot.active 选内联字典（en → 英文）', activate(fakeLocale('en', { withBind: false })).reasonText({ reason: 'not-found' }, 'F') === EN['reason.not-found'])
  check('没有 bind 时 zh-* 仍走中文内联字典', activate(fakeLocale('zh-TW', { withBind: false })).reasonText({ reason: 'not-found' }, 'F') === ZH['reason.not-found'])
  check('宿主 bind 不做插值时，占位符由插件补上', activate(fakeLocale('zh', { interpolate: false })).reasonText({ reason: 'agents-full', bytes: 9100, limit: 9000 }, 'F').includes('9100'))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
