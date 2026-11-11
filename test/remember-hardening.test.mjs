/**
 * 写入侧与宿主接口的回归测试（来自一次代码审查，每一节都对应一个真实复现过的缺陷）：
 *
 *   · memory_remember 的 needs-slug 闸门：标题含非 ASCII 字符又没给英文 slug → 什么都不写
 *   · supersedes：前缀不唯一就拒写；slug 与被取代的 id 相同 → 原地更新，不写出 `-2`；
 *     低置信度 + supersedes → 草稿带着 supersedes，收下时才取代
 *   · validateMemoryPatch：单行字段拒绝换行；非 ASCII 的 slug 是错误，不是悄悄换名
 *   · 所有工具输出都是 lossless JSON（没有 undefined / NaN / Infinity）
 *   · tools/post-execute：只给被接受的结果加料，且保留结果的其它字段
 *   · 命令：全局草稿收下的提示、无参命令缺 rawInput 不抛
 *   · 工作区注册表：每次解析都重读，读不到时保持上一次
 *
 * 全部在临时目录里跑；agentsFile / memoryDir 经 apply 的 rawConfig 传入（见 fake-host.mjs）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeHost, makeReporter } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const { listMemories, listPending, listHistory, validateMemoryPatch, writeMemory, writePending, acceptPending } = mod

/** 找出会让宿主报 `value is not lossless JSON` 的值。 */
function lossyPaths(value, at = '$') {
  if (value === undefined) return [`${at}=undefined`]
  if (typeof value === 'number' && !Number.isFinite(value)) return [`${at}=${value}`]
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
    check('slug 参数的说明写明了：含非 ASCII 标题时必填、缺了会得到 needs-slug', /REQUIRED/.test(slugDoc) && /needs-slug/.test(slugDoc), slugDoc)

    for (const [label, args] of [
      ['没给 slug', { title: '界面不要加解释文案', body: '正文', description: 'd' }],
      ['slug 是空串', { title: '界面不要加解释文案', slug: '', body: '正文', description: 'd' }],
      ['slug 全是空白', { title: '界面不要加解释文案', slug: '   ', body: '正文', description: 'd' }],
      ['slug 本身是中文', { title: '界面不要加解释文案', slug: '中文文件名', body: '正文', description: 'd' }],
      ['低置信度（本来会进待确认）', { title: '界面不要加解释文案', body: '正文', confidence: 0.3 }],
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
    check('纯 ASCII 标题不要求 slug', typeof ascii.id === 'string' && !ascii.reason, JSON.stringify(ascii))
    const globalCn = await host.tool('memory_remember', { title: '全局中文规则', body: '正文', scope: 'global', newChapter: true })
    check('全局 scope（写 AGENTS.md）不受 slug 闸门影响', globalCn.reason !== 'needs-slug', JSON.stringify(globalCn))
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

section('低置信度 + supersedes：草稿带着 supersedes，收下时才取代')
{
  const host = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    await host.tool('memory_remember', { slug: 'rule-b', title: 'Rule B', body: 'old rule b body', description: 'b' })
    const queued = await host.tool('memory_remember', { slug: 'rule-c', title: 'Rule C', body: 'new rule c body', description: 'c', supersedes: 'rule-b', confidence: 0.4 })
    check('低置信度 → 进待确认，text 说明收下会取代谁', queued.pending === true && /replace rule-b/.test(queued.text), JSON.stringify(queued))
    check('  …库里此刻一个字没动', mdFiles(host.memoryDir).join() === 'rule-b.md')
    const draft = listPending(host.memoryDir)[0]
    check('  …草稿里记着 supersedes', draft?.meta.supersedes === 'rule-b', JSON.stringify(draft?.meta))

    const accepted = await acceptPending(host.memoryDir, draft.id)
    check('收下 → 取代旧条（不是新旧并存）', accepted.ok === true && accepted.replaced === 'rule-b' && mdFiles(host.memoryDir).join() === 'rule-c.md', JSON.stringify(accepted))

    const missing = await host.tool('memory_remember', { slug: 'rule-d', title: 'Rule D', body: 'd body', supersedes: 'nope', confidence: 0.4 })
    check('低置信度时 supersedes 指向不存在的 id → 直接报错，不排队', missing.reason === 'supersedes-not-found' && listPending(host.memoryDir).length === 0)

    writeMemory(host.memoryDir, { slug: 'rule-x1', title: 'X1', description: 'x1', body: 'x1 body', type: 'project' })
    writeMemory(host.memoryDir, { slug: 'rule-x2', title: 'X2', description: 'x2', body: 'x2 body', type: 'project' })
    const ambiguousQueued = await host.tool('memory_remember', { slug: 'rule-e', title: 'Rule E', body: 'e body', supersedes: 'rule-x', confidence: 0.4 })
    check('低置信度时前缀歧义同样拒写，不排队', ambiguousQueued.reason === 'supersedes-ambiguous' && listPending(host.memoryDir).length === 0, JSON.stringify(ambiguousQueued))
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

    // 手写文件里 hits 不是数字：库满分支要列出淘汰候选，hits 不能是 NaN
    const file = path.join(host.memoryDir, 'first.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('confidence: 0.8', 'confidence: 0.8\nhits: lots\nlastHit: [x]'), 'utf8')
    const full = await run('memory_remember', { slug: 'second', title: 'Second unrelated', body: 'completely different text', newMemory: true })
    check('库满分支返回 library-full', full.reason === 'library-full', JSON.stringify(full))
    check('  …candidates[].hits 是有限数字（hits: lots → 0）', full.candidates?.[0]?.hits === 0 && Number.isFinite(full.candidates[0].hits), JSON.stringify(full.candidates))

    await run('memory_remember', { title: '中文标题', body: 'x' })
    await run('memory_remember', { slug: 'x-ambig', title: 'x', body: 'x', supersedes: 'f' })
    await run('memory_remember', { slug: 'lowconf', title: 'low conf', body: 'x', confidence: 0.1 })
    await run('memory_remember', { slug: 'dup', title: 'First memory', body: 'alpha beta gamma delta', description: 'first' })
    await run('memory_remember', { title: 'GG', body: 'y', scope: 'global' })
    await run('memory_recall', { query: 'alpha beta' })
    await run('memory_recall', { query: 'nothing matches zzzqqq' })
    await run('memory_forget', { id: 'nope' })
    await run('memory_forget', { id: '../x' })
    await run('memory_status', {})
    const bad = outputs.filter(([, out]) => lossyPaths(out).length > 0)
    check(`${outputs.length} 个分支的输出都没有 undefined / NaN / Infinity`, bad.length === 0, bad.map(([label, out]) => `${label}: ${lossyPaths(out).join(',')}`))

    // 置信度被限在 0..1
    const clamp = makeHost(mod, { config: { duplicateCheck: false } })
    try {
      await clamp.tool('memory_remember', { slug: 'pct', title: 'Pct', body: 'percent confidence', confidence: 85 })
      check('confidence 85（百分数）→ 限到 1', listMemories(clamp.memoryDir).find((m) => m.id === 'pct')?.meta.confidence === '1')
    } finally {
      clamp.cleanup()
    }

    // 召回出来的数字也是有限的（hits / confidence 写坏的手写文件）
    const recallOut = await host.tool('memory_recall', { query: 'alpha beta gamma' })
    check('手写坏数字的记忆被召回时，results 里没有 NaN', lossyPaths(recallOut).length === 0, lossyPaths(recallOut))
    const ui = await host.http('/api/dsh-workspace-memory/list')
    check('面板的 list 里 hits / confidence 也是有限数字', ui.body.memories.every((m) => Number.isFinite(m.hits) && Number.isFinite(m.confidence)), JSON.stringify(ui.body.memories.map((m) => [m.hits, m.confidence])))
  } finally {
    host.cleanup()
  }
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

section('tools/post-execute：只给被接受的结果加料，保留其它字段')
{
  const host = makeHost(mod)
  try {
    writeMemory(host.memoryDir, { slug: 'pkg-three', title: 'Package three', description: 'd', body: 'about package three', type: 'project', paths: ['pkg3/index.js'] })
    const exec = (file = 'D:\\ws\\pkg3\\index.js') => ({ name: 'read', arguments: { path: file }, agent: { id: 'agent-1' } })
    const original = { kind: 'accept', content: [{ type: 'text', text: 'file body' }], value: { lines: 3 }, metadata: { truncated: false }, extra: 'keep-me' }

    const { result, passed } = await host.fire('tools/post-execute', exec(), { ...original })
    check('命中路径：返回加了提示的结果', passed === false && result.kind === 'accept' && result.content.length === 2 && /pkg-three/.test(result.content[1].text), JSON.stringify(result))
    check('  …原有 content 在前、原样保留', result.content[0].text === 'file body')
    check('  …value / metadata / 未知字段全部保留', result.value?.lines === 3 && result.metadata?.truncated === false && result.extra === 'keep-me', JSON.stringify(Object.keys(result)))

    const again = await host.fire('tools/post-execute', exec(), { ...original })
    check('同一轮同一条只提示一次', again.passed === true)

    // 回合结束（状态离开 running）会清掉「本轮已提示过」的记录
    const endTurn = () => host.listeners.get('agent/status')[0]({ status: 'idle', agent: { id: 'agent-1' } })
    for (const kind of ['reject', 'error', 'deny']) {
      endTurn()
      const res = await host.fire('tools/post-execute', exec(), { kind, content: [{ type: 'text', text: 'nope' }] })
      check(`kind:'${kind}' 的结果原样放行（next），不被改成 accept`, res.passed === true)
    }
    endTurn()
    const failed = await host.fire('tools/post-execute', exec(), { isError: true, content: [{ type: 'text', text: 'boom' }] })
    check('isError 的结果原样放行', failed.passed === true)

    endTurn()
    const bare = await host.fire('tools/post-execute', exec(), { content: [{ type: 'text', text: 'no kind' }] })
    check('没有 kind 字段的结果（旧形状）也会被加料', bare.passed === false && bare.result.content.length === 2)
  } finally {
    host.cleanup()
  }
}

section('命令：全局草稿收下的提示、缺 rawInput 不抛、库满返回原因')
{
  const host = makeHost(mod, { config: { maxMemoryCount: 1 } })
  try {
    host.write(host.agentsFile, '# Rules\n\n## 1. First\n\nkeep me\n')

    const noInput = await host.command('memory_pending', undefined)
    check('memory_pending 缺 rawInput：不抛，正常回应', noInput.kind === 'success', JSON.stringify(noInput))
    const noExtractInput = await host.command('memory_extract', undefined)
    check('memory_extract 缺 rawInput：不抛', typeof noExtractInput.kind === 'string')
    const noInvocation = await host.commands.get('memory').handler(undefined)
    check('invocation 整个是 undefined 也不抛', noInvocation.kind === 'error', JSON.stringify(noInvocation))
    const overview = await host.command('memory', '')
    check('空输入 = 总览', overview.kind === 'success' && /Memories: 0/.test(overview.text))

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

summary()
