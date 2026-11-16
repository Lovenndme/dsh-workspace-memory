/**
 * 写入侧与宿主接口的回归测试（来自一次代码审查，每一节都对应一个真实复现过的缺陷）：
 *
 *   · memory_remember 的 needs-slug 闸门：标题含非 ASCII 字符又没给英文 slug → 什么都不写
 *   · supersedes：前缀不唯一就拒写；slug 与被取代的 id 相同 → 原地更新，不写出 `-2`；
 *     进待确认 + supersedes → 草稿带着 supersedes，收下时才取代
 *   · validateMemoryPatch：单行字段拒绝换行；非 ASCII 的 slug 是错误，不是悄悄换名
 *   · 所有工具输出都是 lossless JSON（没有 undefined / NaN / Infinity / -0）；手改成 `hits: -0` 的文件不让库满候选判错
 *   · tools/post-execute：一律经过 next()，只在下游「接受」的决定上换 content（官方契约）
 *   · 命令：全局草稿收下的提示、无参命令缺 rawInput 不抛
 *   · 工作区注册表：每次解析都重读，读不到时保持上一次
 *
 * 全部在临时目录里跑；agentsFile / memoryDir 经 apply 的 rawConfig 传入（见 fake-host.mjs）。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeHost, makeReporter, realFilesGuard, schemaProblems } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()
const { listMemories, listPending, listHistory, validateMemoryPatch, writeMemory, writePending, acceptPending } = mod

/** 找出会让宿主报 `value is not lossless JSON` 的值（宿主的数字口径：有限且不是 -0）。 */
function lossyPaths(value, at = '$') {
  if (value === undefined) return [`${at}=undefined`]
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return [`${at}=${Object.is(value, -0) ? '-0' : value}`]
  if (Array.isArray(value)) return value.flatMap((item, i) => lossyPaths(item, `${at}[${i}]`))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, inner]) => lossyPaths(inner, `${at}.${key}`))
  return []
}

const mdFiles = (dir) => readdirSync(dir).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md').sort()

section('needs-slug：中文标题没有英文 slug → 什么都不写')
{
  const host = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    const stateDir = path.join(host.root, 'proj', '.memory-state')
    const tool = host.tools.get('memory_remember')
    const slugDoc = tool.parameters.properties.slug.description
    // 第四轮：slug 进了 required（评测里 8 次写入有 6 次第一次漏填、被拒后重试）；说明就是 SLUG_RULE。
    // 宿主不替 raw JSON-Schema 工具校验 required，所以下面的 needs-slug 拒写仍是模型漏填时的兜底，逐条断言保留。
    check('slug 在 required 里，说明就是 SLUG_RULE', tool.parameters.required.includes('slug') && slugDoc === mod.SLUG_RULE, slugDoc)

    for (const [label, args] of [
      ['没给 slug', { title: '界面不要加解释文案', body: '正文', description: 'd' }],
      ['slug 是空串', { title: '界面不要加解释文案', slug: '', body: '正文', description: 'd' }],
      ['slug 全是空白', { title: '界面不要加解释文案', slug: '   ', body: '正文', description: 'd' }],
      ['slug 本身是中文', { title: '界面不要加解释文案', slug: '中文文件名', body: '正文', description: 'd' }],
      ['证据对不上（本来会进待确认）', { title: '界面不要加解释文案', body: '正文', source: 'user', evidence: '用户从没说过这句' }],
      ['带 supersedes', { title: '界面不要加解释文案', body: '正文', supersedes: 'whatever' }],
    ]) {
      const res = await host.tool('memory_remember', args)
      check(`${label} → needs-slug、written:false、没有 id`, res.reason === 'needs-slug' && res.written === false && res.id === undefined && !('id' in res), JSON.stringify(res))
      check(`  …输出是 lossless JSON，text 指明了怎么重试`, lossyPaths(res).length === 0 && /slug/.test(res.text) && /English/.test(res.text))
    }
    check('记忆目录里没有任何文件', mdFiles(host.memoryDir).length === 0, mdFiles(host.memoryDir).join(','))
    check('待确认队列也没有（连 .memory-state 都没创建）', !existsSync(stateDir))

    const ok = await host.tool('memory_remember', { title: '界面不要加解释文案', slug: 'no-explanatory-text-in-ui', body: '正文', description: 'd' })
    check('带了英文 slug 就正常写入，文件名就是 slug', ok.id === 'no-explanatory-text-in-ui' && existsSync(path.join(host.memoryDir, 'no-explanatory-text-in-ui.md')), JSON.stringify(ok))
    const normalized = await host.tool('memory_remember', { title: '另一条', slug: 'Use PNPM Only!', body: '正文二', description: 'd2' })
    check('slug 会被规整成 kebab-case', normalized.id === 'use-pnpm-only', JSON.stringify(normalized))
    const ascii = await host.tool('memory_remember', { title: 'Plain ASCII title', body: 'ascii body', description: 'd3' })
    check('（漏填兜底）纯 ASCII 标题仍可由标题派生文件名，不拒写', typeof ascii.id === 'string' && !ascii.reason, JSON.stringify(ascii))
    const globalCn = await host.tool('memory_remember', { title: '全局中文规则', body: '正文', scope: 'global', load: 'always', newChapter: true })
    check('写 AGENTS.md（global + always）不受 slug 闸门影响：章节没有文件名', globalCn.reason !== 'needs-slug', JSON.stringify(globalCn))
    const globalOnDemand = await host.tool('memory_remember', { title: '全局按需中文规则', body: '正文', scope: 'global' })
    check('全局按需库同样要英文 slug（它也是一条一个文件）', globalOnDemand.reason === 'needs-slug' && globalOnDemand.written === false, JSON.stringify(globalOnDemand))
    check('  …全局按需库什么都没写', !existsSync(host.globalDir))
  } finally {
    host.cleanup()
  }
}

section('supersedes：精确 id → 唯一前缀；前缀不唯一就拒写')
{
  const host = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    for (const [slug, body] of [['no-force-push', 'never force push to main'], ['no-explanatory-text', 'no explanatory text in ui'], ['pnpm-only', 'use pnpm only']]) {
      writeMemory(host.memoryDir, { slug, title: slug, description: slug, body, type: 'feedback' })
    }
    const snapshot = () => JSON.stringify(mdFiles(host.memoryDir).map((name) => [name, readFileSync(path.join(host.memoryDir, name), 'utf8')]))
    const before = snapshot()

    const ambiguous = await host.tool('memory_remember', { slug: 'new-rule', title: 'New rule', body: 'brand new rule body', description: 'n', supersedes: 'no-' })
    check('歧义前缀 → supersedes-ambiguous、written:false', ambiguous.reason === 'supersedes-ambiguous' && ambiguous.written === false, JSON.stringify(ambiguous))
    check('  …列出全部候选', ambiguous.candidates?.map((c) => c.id).sort().join() === 'no-explanatory-text,no-force-push', JSON.stringify(ambiguous.candidates))
    check('  …一个字都没写、没删', snapshot() === before)
    check('  …输出是 lossless JSON', lossyPaths(ambiguous).length === 0)

    const missing = await host.tool('memory_remember', { slug: 'new-rule', title: 'New rule', body: 'brand new rule body', supersedes: 'zzz' })
    check('不存在 → supersedes-not-found，且什么都没写', missing.reason === 'supersedes-not-found' && snapshot() === before)

    const blank = await host.tool('memory_remember', { slug: 'blank-super', title: 'Blank', body: 'blank supersedes means none', supersedes: '   ', newMemory: true })
    check('supersedes 全是空白 → 当作没传（不会匹配到所有记忆）', typeof blank.id === 'string' && !blank.replaced && mdFiles(host.memoryDir).length === 4, JSON.stringify(blank))

    const unique = await host.tool('memory_remember', { slug: 'force-push-v2', title: 'Force push v2', body: 'force push only with lease', description: 'v2', supersedes: 'no-f' })
    check('唯一前缀可用：取代 no-force-push', unique.replaced === 'no-force-push' && !existsSync(path.join(host.memoryDir, 'no-force-push.md')) && existsSync(path.join(host.memoryDir, 'force-push-v2.md')), JSON.stringify(unique))
    check('  …旧版进了历史', listHistory(host.memoryDir, 'no-force-push').length === 1)
    check('  …另一条 no- 开头的原封不动', existsSync(path.join(host.memoryDir, 'no-explanatory-text.md')))
    check('  …新条记着取代了谁', listMemories(host.memoryDir).find((m) => m.id === 'force-push-v2')?.meta.supersedes === 'no-force-push')

    const exact = await host.tool('memory_remember', { slug: 'pnpm-strict', title: 'pnpm strict', body: 'pnpm strict mode only', description: 'p', supersedes: 'pnpm-only' })
    check('精确 id 优先', exact.replaced === 'pnpm-only')
  } finally {
    host.cleanup()
  }
}

section('supersedes：slug 与被取代的 id 相同 → 原地更新')
{
  const host = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    await host.tool('memory_remember', { slug: 'rule-a', title: 'Rule A', body: 'old body text alpha', description: 'old', tags: ['keep'], paths: ['pkg/a.js'] })
    await host.tool('memory_recall', { query: 'old body text alpha' })
    const before = listMemories(host.memoryDir).find((m) => m.id === 'rule-a')

    const res = await host.tool('memory_remember', { slug: 'rule-a', title: 'Rule A v2', body: 'new body text beta', description: 'new', supersedes: 'rule-a' })
    check('id 不变、标成原地更新、没有 replaced', res.id === 'rule-a' && res.updated === true && !('replaced' in res), JSON.stringify(res))
    check('  …输出是 lossless JSON', lossyPaths(res).length === 0)
    check('  …库里只有这一个文件，没有 `-2`', mdFiles(host.memoryDir).join() === 'rule-a.md', mdFiles(host.memoryDir).join())
    const after = listMemories(host.memoryDir).find((m) => m.id === 'rule-a')
    check('  …正文与标题已更新', after.body === 'new body text beta' && after.meta.title === 'Rule A v2')
    check('  …created 与 hits 保留', after.meta.created === before.meta.created && after.meta.hits === before.meta.hits && after.meta.hits === '1', `${after.meta.created} / ${after.meta.hits}`)
    check('  …没传的 tags / paths 沿用原值', after.meta.tags?.join() === 'keep' && after.meta.paths?.join() === 'pkg/a.js')
    const history = listHistory(host.memoryDir, 'rule-a')
    check('  …旧版留进历史', history.length === 1 && readFileSync(history[0].file, 'utf8').includes('old body text alpha'))

    // 大小写不同也算同一个文件（Windows 不分大小写）
    const cased = await host.tool('memory_remember', { slug: 'RULE-A', title: 'Rule A v3', body: 'third body text gamma', description: 'third', supersedes: 'rule-a' })
    check('slug 只差大小写 → 仍是原地更新', cased.id === 'rule-a' && cased.updated === true && mdFiles(host.memoryDir).join() === 'rule-a.md', JSON.stringify(cased))

    const different = await host.tool('memory_remember', { slug: 'rule-b', title: 'Rule B', body: 'fourth body text delta', description: 'b', supersedes: 'rule-a' })
    check('slug 不同 → 新写一条再删旧的（旧版留档）', different.id === 'rule-b' && different.replaced === 'rule-a' && mdFiles(host.memoryDir).join() === 'rule-b.md')
  } finally {
    host.cleanup()
  }
}

section('进待确认 + supersedes：草稿带着 supersedes，收下时才取代')
{
  // agentWrites: review —— 模型自己得出的内容进待确认（取代旧的「低置信度进待确认」）
  const host = makeHost(mod, { config: { duplicateCheck: false, agentWrites: 'review' } })
  try {
    writeMemory(host.memoryDir, { slug: 'rule-b', title: 'Rule B', body: 'old rule b body', description: 'b', type: 'feedback' })
    const queued = await host.tool('memory_remember', { slug: 'rule-c', title: 'Rule C', body: 'new rule c body', description: 'c', type: 'feedback', source: 'agent', supersedes: 'rule-b' })
    check('agent 来源 → 进待确认，text 说明收下会取代谁', queued.pending === true && queued.reason === 'agent-review' && /replace rule-b/.test(queued.text), JSON.stringify(queued))
    check('  …库里此刻一个字没动', mdFiles(host.memoryDir).join() === 'rule-b.md')
    const draft = listPending(host.memoryDir)[0]
    check('  …草稿里记着 supersedes', draft?.meta.supersedes === 'rule-b', JSON.stringify(draft?.meta))

    const accepted = await acceptPending(host.memoryDir, draft.id)
    check('收下 → 取代旧条（不是新旧并存）', accepted.ok === true && accepted.replaced === 'rule-b' && mdFiles(host.memoryDir).join() === 'rule-c.md', JSON.stringify(accepted))

    const missing = await host.tool('memory_remember', { slug: 'rule-d', title: 'Rule D', body: 'd body', source: 'agent', supersedes: 'nope' })
    check('要进待确认时 supersedes 指向不存在的 id → 直接报错，不排队', missing.reason === 'supersedes-not-found' && listPending(host.memoryDir).length === 0)

    writeMemory(host.memoryDir, { slug: 'rule-x1', title: 'X1', description: 'x1', body: 'x1 body', type: 'project' })
    writeMemory(host.memoryDir, { slug: 'rule-x2', title: 'X2', description: 'x2', body: 'x2 body', type: 'project' })
    const ambiguousQueued = await host.tool('memory_remember', { slug: 'rule-e', title: 'Rule E', body: 'e body', source: 'agent', supersedes: 'rule-x' })
    check('要进待确认时前缀歧义同样拒写，不排队', ambiguousQueued.reason === 'supersedes-ambiguous' && listPending(host.memoryDir).length === 0, JSON.stringify(ambiguousQueued))
  } finally {
    host.cleanup()
  }
}

section('工具输出全是 lossless JSON')
{
  const host = makeHost(mod, { config: { duplicateCheck: true, maxMemoryCount: 1 } })
  try {
    const outputs = []
    const run = async (name, args) => {
      const out = await host.tool(name, args)
      outputs.push([`${name} ${JSON.stringify(args).slice(0, 50)}`, out])
      return out
    }
    await run('memory_remember', { slug: 'first', title: 'First memory', body: 'alpha beta gamma delta', description: 'first' })

    // 手写文件里 hits 不是数字：库满分支要列出淘汰候选，hits 不能是 NaN。
    // 新文件不再写 confidence，所以锚在 type 那一行后面塞坏值（旧文件里的坏 confidence 一并覆盖到）
    const file = path.join(host.memoryDir, 'first.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^type: .*$/m, (line) => `${line}\nhits: lots\nlastHit: [x]\nconfidence: lots`), 'utf8')
    check('  …坏值确实写进去了（否则下面的断言测不到东西）', /^hits: lots$/m.test(readFileSync(file, 'utf8')))
    const full = await run('memory_remember', { slug: 'second', title: 'Second unrelated', body: 'completely different text', newMemory: true })
    check('库满分支返回 library-full', full.reason === 'library-full', JSON.stringify(full))
    check('  …candidates[].hits 是有限数字（hits: lots → 0）', full.candidates?.[0]?.hits === 0 && Number.isFinite(full.candidates[0].hits), JSON.stringify(full.candidates))

    await run('memory_remember', { title: '中文标题', body: 'x' })
    await run('memory_remember', { slug: 'x-ambig', title: 'x', body: 'x', supersedes: 'f' })
    await run('memory_remember', { slug: 'unverified', title: 'unverified', body: 'x', source: 'user', evidence: 'never said' })
    await run('memory_remember', { slug: 'proj-always', title: 'project always', body: 'x', load: 'always' })
    await run('memory_remember', { slug: 'stale', title: 'stale values', body: 'pinned to abc1234 and v1.2.3', source: 'user', evidence: 'nope' })
    await run('memory_remember', { slug: 'dup', title: 'First memory', body: 'alpha beta gamma delta', description: 'first' })
    await run('memory_remember', { title: 'GG', body: 'y', scope: 'global', load: 'always' })
    await run('memory_remember', { slug: 'gg', title: 'GG on demand', body: 'zebra on demand', scope: 'global' })
    await run('memory_recall', { query: 'alpha beta' })
    await run('memory_recall', { query: 'first' })
    await run('memory_recall', { query: 'nothing matches zzzqqq' })
    await run('memory_forget', { id: 'nope' })
    await run('memory_forget', { id: '../x' })
    await run('memory_status', {})
    const bad = outputs.filter(([, out]) => lossyPaths(out).length > 0)
    check(`${outputs.length} 个分支的输出都没有 undefined / NaN / Infinity`, bad.length === 0, bad.map(([label, out]) => `${label}: ${lossyPaths(out).join(',')}`))

    // output.schema 如实声明（官方 tools.md：宿主按它校验每个成功返回值）。strict = 没声明的字段也算错，
    // 用来守「实际会出现的字段都声明了」；运行时 schema 写的是 additionalProperties: true（理由见 index.js）。
    const undeclared = outputs
      .map(([label, out]) => [label, schemaProblems(host.tools.get(label.split(' ')[0]).output.schema, out, { strict: true })])
      .filter(([, problems]) => problems.length > 0)
    check(`${outputs.length} 个分支的输出都符合声明的 output.schema（含字段完整性）`, undeclared.length === 0, undeclared.map(([label, p]) => `${label}: ${p.join('; ')}`))

    // confidence 参数已删除（分流改为按来源）：传了也不写进文件
    const legacy = makeHost(mod, { config: { duplicateCheck: false } })
    try {
      await legacy.tool('memory_remember', { slug: 'pct', title: 'Pct', body: 'percent confidence', confidence: 85 })
      check('传 confidence 85：不写进文件', listMemories(legacy.memoryDir).find((m) => m.id === 'pct')?.meta.confidence === undefined)
    } finally {
      legacy.cleanup()
    }

    // 召回出来的数字也是有限的（hits / confidence 写坏的手写文件）
    const recallOut = await host.tool('memory_recall', { query: 'alpha beta gamma' })
    check('手写坏数字的记忆被召回时，results 里没有 NaN', lossyPaths(recallOut).length === 0, lossyPaths(recallOut))
    const ui = await host.http('/api/dsh-workspace-memory/list')
    check('面板的 list 里 hits 是有限数字；confidence 只在是有限数字时才出现（坏值不给）',
      ui.body.memories.every((m) => Number.isFinite(m.hits) && (m.confidence === undefined || Number.isFinite(m.confidence))) &&
        ui.body.memories.find((m) => m.id === 'first')?.confidence === undefined,
      JSON.stringify(ui.body.memories.map((m) => [m.hits, m.confidence])))
  } finally {
    host.cleanup()
  }
}

section('手改成 hits: -0：库满候选里的 hits 是 0，输出照样符合 schema')
{
  // 宿主的校验器只收「有限且不是 -0」的数字：以前 Number('-0') 原样进了 candidates[].hits，库满的拒写回复整条判错
  const host = makeHost(mod, { config: { duplicateCheck: false, maxMemoryCount: 1 } })
  try {
    writeMemory(host.memoryDir, { slug: 'neg-zero', title: 'Neg zero', description: 'n', body: 'n body', type: 'project' })
    const file = path.join(host.memoryDir, 'neg-zero.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^type: .*$/m, (line) => `${line}\nhits: -0`), 'utf8')
    check('  …坏值确实写进去了', /^hits: -0$/m.test(readFileSync(file, 'utf8')))
    const full = await host.tool('memory_remember', { slug: 'other', title: 'Other', body: 'other body', type: 'project', source: 'agent', scope: 'project' })
    check('库满 → library-full，候选的 hits 是 +0（不是 -0）', full.reason === 'library-full' && Object.is(full.candidates?.[0]?.hits, 0), JSON.stringify(full.candidates))
    check('  …输出没有 lossless 问题', lossyPaths(full).length === 0, lossyPaths(full))
    check('  …符合声明的 output.schema（含字段完整性）', schemaProblems(host.tools.get('memory_remember').output.schema, full, { strict: true }).length === 0,
      schemaProblems(host.tools.get('memory_remember').output.schema, full, { strict: true }))
  } finally {
    host.cleanup()
  }
  check('仓库自己的检查器也认 -0 为错（与宿主同口径）', schemaProblems({ type: 'number' }, -0).length === 1 && schemaProblems({ type: 'number' }, 0).length === 0)
}

section('validateMemoryPatch：单行字段拒绝换行；非 ASCII slug 是错误')
{
  for (const sep of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const label = JSON.stringify(sep)
    for (const [field, value] of [
      ['title', `Line1${sep}type: user`],
      ['description', `x${sep}---${sep}y`],
      ['tags', [`a${sep}b`]],
      ['paths', [`src/a${sep}b.js`]],
    ]) {
      const result = validateMemoryPatch({ [field]: value })
      check(`${field} 含 ${label} → 拒绝`, result.ok === false && result.errors.some((e) => e.startsWith(`${field}:`)), JSON.stringify(result.errors))
    }
  }
  check('首尾的换行会被 trim，不算内部换行', validateMemoryPatch({ title: '  标题\n', description: '摘要\r\n' }).ok === true)

  for (const slug of ['中文文件名', '   ', '', '!!!', 'a', 'foo中文', 'ｆｏｏ']) {
    const result = validateMemoryPatch({ slug })
    check(`slug ${JSON.stringify(slug)} → 错误（不是悄悄换成 memory-<时间戳>）`, result.ok === false && result.value.slug === undefined && result.errors.some((e) => e.startsWith('slug:')), JSON.stringify(result))
  }
  check('slug 大写 / 空格会被规整', validateMemoryPatch({ slug: ' No Force Push ' }).value.slug === 'no-force-push')
  check('合法 slug 原样通过', validateMemoryPatch({ slug: 'no-explanatory-text-in-ui' }).value.slug === 'no-explanatory-text-in-ui')
  check('逗号、括号不再破坏落盘（序列化器会加引号）：paths 允许', validateMemoryPatch({ paths: ['src/*.{ts,tsx}'] }).ok === true)
  const good = validateMemoryPatch({ title: ' 标题 ', description: '摘要', tags: ['a', 'a', ' b '], paths: [' src/a.js ', ''] })
  check('正常输入照常归一化', good.ok && good.value.title === '标题' && good.value.tags.join() === 'a,b' && good.value.paths.join() === 'src/a.js', JSON.stringify(good))
}

section('tools/post-execute：按官方契约——一律经过 next()，只在下游「接受」的决定上换 content')
{
  // 2026-11-14 第二轮改写。旧断言守的是与官方契约相反的行为：命中时不调 next()（跳过下游监听器）、
  // 返回 `{...result, content}` 同时带着 value（PostToolDecision 里 content 与 value 只能二选一）、
  // 拿结果对象上并不存在的 `result.kind` 做判断（result 是 ToolExecutionResult，决定才有 kind）。
  // 新契约见 tools.md「Post-dispatch decision」与 practices.md「Stability」；同一组场景逐条重写，覆盖面不减。
  const host = makeHost(mod)
  try {
    writeMemory(host.memoryDir, { slug: 'pkg-three', title: 'Package three', description: 'd', body: 'about package three', type: 'project', paths: ['pkg3/index.js'] })
    const exec = (file = 'D:\\ws\\pkg3\\index.js') => ({ name: 'read', arguments: { path: file }, agent: { id: 'agent-1' } })
    // ToolExecutionSuccess 的形状：isError / value / content / meta
    const original = { isError: false, value: { lines: 3 }, content: [{ type: 'text', text: 'file body' }], meta: { truncated: false } }
    const endTurn = () => host.listeners.get('agent/status')[0]({ status: 'idle', agent: { id: 'agent-1' } })

    const { result, passed } = await host.fire('tools/post-execute', exec(), { ...original })
    check('命中路径：先调用了下游 next()', passed === true)
    check('  …返回 kind: accept、content 末尾加了提示', result.kind === 'accept' && result.content.length === 2 && /pkg-three/.test(result.content[1].text), JSON.stringify(result))
    check('  …原有 content 在前、原样保留', result.content[0].text === 'file body')
    check('  …不带 value 键（content 与 value 只能二选一；value 由宿主保留）', !('value' in result) && Object.keys(result).sort().join() === 'content,kind', JSON.stringify(Object.keys(result)))

    const again = await host.fire('tools/post-execute', exec(), { ...original })
    check('同一轮同一条只提示一次：原样返回 next() 的结果', again.passed === true && again.result === again.nextResult)

    // 下游 block → 原样透传，不改它的决定，也不算「本轮提示过」
    endTurn()
    const block = { kind: 'block', feedback: [{ type: 'text', text: 'denied downstream' }] }
    const blocked = await host.fireWith('tools/post-execute', () => block, exec(), { ...original })
    check('next() 返回 block → 原样透传', blocked.calls === 1 && blocked.result === block, JSON.stringify(blocked.result))
    const afterBlock = await host.fire('tools/post-execute', exec(), { ...original })
    check('  …被拦掉的那次不算提示过，下次仍会提示', afterBlock.result.content?.length === 2)

    // 下游换了 value → 原样透传（不能再同时换 content）
    endTurn()
    const replaced = { kind: 'accept', value: { lines: 99 } }
    const valued = await host.fireWith('tools/post-execute', () => replaced, exec(), { ...original })
    check('next() 已经替换了 value → 原样透传', valued.result === replaced, JSON.stringify(valued.result))

    // 下游换了 content、带了 additionalContexts → 在下游的 content 上加，并把 additionalContexts 带上
    endTurn()
    const extra = [{ id: 'ctx-1', role: 'user', content: [{ type: 'text', text: 'ctx' }], source: { kind: 'test' } }]
    const enriched = await host.fireWith('tools/post-execute', () => ({ kind: 'accept', content: [{ type: 'text', text: 'downstream body' }], additionalContexts: extra }), exec(), { ...original })
    check('下游给了 content：在它后面加提示', enriched.result.content[0].text === 'downstream body' && /pkg-three/.test(enriched.result.content[1].text), JSON.stringify(enriched.result))
    check('  …下游的 additionalContexts 原样带上，仍不带 value', enriched.result.additionalContexts === extra && !('value' in enriched.result))

    endTurn()
    const failed = await host.fire('tools/post-execute', exec(), { isError: true, error: { message: 'boom' }, content: [{ type: 'text', text: 'boom' }] })
    check('isError 的结果不加提示：原样返回 next() 的结果', failed.passed === true && failed.result === failed.nextResult)

    // next() 返回的东西坏了（不是对象）：不加料、原样交回，不抛
    endTurn()
    const weird = await host.fireWith('tools/post-execute', () => undefined, exec(), { ...original })
    check('next() 返回空值 → 原样交回、不抛', weird.calls === 1 && weird.result === undefined)
  } finally {
    host.cleanup()
  }
}

section('命令：全局草稿收下的提示、缺 rawInput 不抛、库满返回原因')
{
  const host = makeHost(mod, { config: { maxMemoryCount: 1 } })
  try {
    host.write(host.agentsFile, '# Rules\n\n## 1. First\n\nkeep me\n')

    // 2026-11-16 起 /memory_pending、/memory_extract 不再单独注册（收回成 /memory 的子命令），这里改测 /memory 本身
    const noInput = await host.command('memory', undefined)
    check('memory 缺 rawInput：不抛，按总览回应', noInput.kind === 'success' && noInput.text.startsWith('记忆总览'), JSON.stringify(noInput))
    const noInvocation = await host.commands.get('memory').handler(undefined)
    check('invocation 整个是 undefined 也不抛', noInvocation.kind === 'error', JSON.stringify(noInvocation))
    const overview = await host.command('memory', '')
    check('空输入 = 总览', overview.kind === 'success' && overview.text.startsWith('记忆总览') && /^  项目记忆  还没有记忆$/m.test(overview.text), overview.text)

    writePending(host.memoryDir, { title: 'Global rule', body: 'rule body', scope: 'global', slug: 'g' })
    const gid = listPending(host.memoryDir)[0].id
    const accepted = await host.command('memory', `accept ${gid}`)
    check('收下全局草稿：提示里没有 undefined', accepted.kind === 'success' && !/undefined|NaN/.test(accepted.text), accepted.text)
    check('  …说明进了 AGENTS.md', /AGENTS\.md/.test(accepted.text))
    check('  …AGENTS.md 里确实多了一章', readFileSync(host.agentsFile, 'utf8').includes('Global rule'))

    await host.tool('memory_remember', { slug: 'only-one', title: 'Only one', body: 'the only memory', description: 'x' })
    writePending(host.memoryDir, { title: 'Second', body: 'second body', slug: 'second' })
    const draftId = listPending(host.memoryDir)[0].id
    const full = await host.command('memory', `accept ${draftId}`)
    check('库满时 /memory accept 回错误与原因（不是 undefined）', full.kind === 'error' && /上限/.test(full.text) && !/undefined/.test(full.text), full.text)
    const http = await host.http('/api/dsh-workspace-memory/accept', { method: 'POST', body: { id: draftId } })
    check('HTTP accept 库满 → 409 library-full', http.status === 409 && http.body?.reason === 'library-full', `${http.status} ${JSON.stringify(http.body)}`)
    check('  …草稿仍在队列里', listPending(host.memoryDir).length === 1)

    const normal = await host.command('memory', `accept ${draftId}x`)
    check('不存在的草稿 → 错误提示', normal.kind === 'error')
  } finally {
    host.cleanup()
  }
}

section('工作区注册表：每次重读，读不到时保持上一次')
{
  const base = path.join(os.tmpdir(), 'wsm-roots')
  const wsRoot = path.join(base, 'ws')
  const sub = path.join(wsRoot, 'pkg', 'inner')
  let list = []
  let mode = 'ok'
  const ctx = {
    get: (name) =>
      name === 'workspaceRegistry'
        ? {
            list: () => {
              if (mode === 'throw') throw new Error('registry down')
              if (mode === 'promise') return Promise.resolve(list)
              return list
            },
          }
        : undefined,
  }

  mod.refreshWorkspaceRoots({ get: () => undefined })
  check('注册表还没填好：回落到 cwd 自己', mod.projectRootFor(sub) === path.resolve(sub))
  list = [{ path: wsRoot }, { path: 42 }, null, { path: '' }]
  check('之后才注册的工作区也能看到', mod.refreshWorkspaceRoots(ctx).join() === wsRoot)
  check('  …projectRootFor 用上了新注册的根', mod.projectRootFor(sub) === path.resolve(wsRoot))
  mode = 'throw'
  check('注册表抛错 → 保持上一次的结果', mod.refreshWorkspaceRoots(ctx).join() === wsRoot && mod.projectRootFor(sub) === path.resolve(wsRoot))
  mode = 'promise'
  check('返回的不是数组 → 保持上一次的结果', mod.refreshWorkspaceRoots(ctx).join() === wsRoot)
  mode = 'ok'
  list = []
  check('注册表清空（工作区被移除）→ 跟着清空', mod.refreshWorkspaceRoots(ctx).length === 0 && mod.projectRootFor(sub) === path.resolve(sub))
  mod.refreshWorkspaceRoots({ get: () => undefined })
}

section('真实文件未被本次测试改动')
check('~/.dsh/AGENTS.md 与 ~/.dsh/global-memory 的存在性与哈希不变', guard.unchanged())

summary()
