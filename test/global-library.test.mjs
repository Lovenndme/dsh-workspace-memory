/**
 * 全局按需库（scope: global + load: on-demand）以及「两个库并存」的各条路径。
 *
 * 为什么有这个库：「任何项目都成立、但只在特定场景才用」的知识以前只能进常驻的 AGENTS.md
 * （审计里全局 AGENTS.md 约 46% 是这类场景性知识），每轮都在付它的上下文成本。
 *
 * 覆盖：写入与索引、召回合并（带 scope）、按 id 取全文、forget 的歧义拒绝、moveMemory、跨库查重、
 * 待确认（查重在分流之前、同 slug 覆盖、旧草稿兼容、按 scope 收下）、注入（空库 context 为空串、全局索引行数上限）、
 * HTTP 路由（list / save 换库 / forget / promote）、/memory list、memory_status、promoteToAgents。
 *
 * 全部在临时目录；结束时比对真实 ~/.dsh/AGENTS.md 与 ~/.dsh/global-memory 的哈希。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { makeHost, makeReporter, realFilesGuard, userEvent } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()
const { writeMemory, listMemories, listPending, listHistory, writePending, acceptPending, moveMemory } = mod
const API = '/api/dsh-workspace-memory'
const ids = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').map((n) => n.slice(0, -3)).sort() : [])
const AGENTS = '# 全局约定\n\n## 1. 已有的一章\n\n原有内容。\n'

section('写入、索引、召回合并（每行带 scope）')
{
  const host = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    await host.tool('memory_remember', { slug: 'npm-publish', title: 'npm 发布只走 CI', description: 'npm 发布节奏', body: '不要手动 npm publish，用 GitHub Actions 批量发布。', type: 'project', source: 'agent' })
    // 测的是全局按需库的写入与召回，所以用不被 §15.1 强制常驻的类型（feedback / user + global 现在进全局 AGENTS.md）
    await host.tool('memory_remember', { slug: 'notepad-bom', title: '记事本存的 JSON 带 BOM', description: 'Windows 记事本保存的 JSON 开头有 BOM，JSON.parse 会失败', body: 'Windows 记事本保存的 JSON 文件开头带 BOM，直接 JSON.parse 会报错；读入后先去掉开头的 BOM。', type: 'pitfall', source: 'agent', scope: 'global' })
    check('项目库与全局库各一条', ids(host.memoryDir).join() === 'npm-publish' && ids(host.globalDir).join() === 'notepad-bom')
    check('全局库的状态目录与项目库同构（MEMORY.md 在 memory/ 里）', existsSync(path.join(host.globalDir, 'MEMORY.md')))

    const found = await host.tool('memory_recall', { query: '记事本保存的 JSON 解析失败' })
    const row = found.results.find((r) => r.id === 'notepad-bom')
    check('召回能命中全局库的条目，并标明 scope', row?.scope === 'global', JSON.stringify(found.results.map((r) => [r.id, r.scope])))
    check('  …文本里标出「all projects」', /all projects/.test(found.text))
    const both = await host.tool('memory_recall', { query: 'npm 发布 JSON BOM', limit: 5 })
    check('合并结果每行都带 scope', both.results.every((r) => r.scope === 'project' || r.scope === 'global'), JSON.stringify(both.results))
    // 前两次召回都可能命中它，所以只断言「记到了全局库的文件里」，不卡具体次数
    check('全局条目的 hits 记在全局库的文件里', Number(listMemories(host.globalDir).find((m) => m.id === 'notepad-bom')?.meta.hits) >= 1)
    check('  …项目库条目的 hits 记在项目库里，不串库', listMemories(host.memoryDir).every((m) => m.id !== 'notepad-bom'))

    // 按 id 取全文：先项目库后全局库，两处都有就都给
    writeMemory(host.globalDir, { slug: 'npm-publish', title: '全局同名', body: '全局库里的同名条目。', scope: 'global' })
    const byId = await host.tool('memory_recall', { query: 'npm-publish' })
    check('精确 id → 直接给全文（mode: id）', byId.mode === 'id' && byId.results.length === 2, JSON.stringify(byId.results?.map((r) => r.scope)))
    check('  …项目库在前、全局库在后', byId.results[0].scope === 'project' && byId.results[1].scope === 'global')
    const single = await host.tool('memory_recall', { query: 'notepad-bom' })
    check('只在全局库里的 id 也能取到', single.mode === 'id' && single.results.length === 1 && single.results[0].scope === 'global')
  } finally {
    host.cleanup()
  }
}

section('memory_forget：同一 id 两个库都有且未传 scope → 拒绝并列出两处')
{
  const host = makeHost(mod)
  try {
    writeMemory(host.memoryDir, { slug: 'twin', title: 'Twin P', body: 'project twin' })
    writeMemory(host.globalDir, { slug: 'twin', title: 'Twin G', body: 'global twin', scope: 'global' })
    writeMemory(host.globalDir, { slug: 'only-global', title: 'Only G', body: 'only in global', scope: 'global' })

    const ambiguous = await host.tool('memory_forget', { id: 'twin' })
    check('拒绝：scope-ambiguous，removed:false', ambiguous.removed === false && ambiguous.reason === 'scope-ambiguous', JSON.stringify(ambiguous))
    check('  …列出两处', ambiguous.locations?.map((l) => l.scope).join() === 'project,global' && /\[project\]/.test(ambiguous.text) && /\[global\]/.test(ambiguous.text))
    check('  …两条都还在', ids(host.memoryDir).includes('twin') && ids(host.globalDir).includes('twin'))

    const scoped = await host.tool('memory_forget', { id: 'twin', scope: 'global' })
    check('带 scope 就删那一处', scoped.removed === true && scoped.scope === 'global' && !ids(host.globalDir).includes('twin') && ids(host.memoryDir).includes('twin'), JSON.stringify(scoped))
    check('  …删除前留了历史（在全局库自己的 history 里）', listHistory(host.globalDir, 'twin').length === 1)

    const unique = await host.tool('memory_forget', { id: 'only-global' })
    check('只在一个库里：不带 scope 也能删', unique.removed === true && unique.scope === 'global')

    const http = await host.http(`${API}/forget`, { method: 'POST', body: { id: 'twin', scope: 'nowhere' } })
    check('HTTP forget：非法 scope → 400 invalid-scope', http.status === 400 && http.body?.reason === 'invalid-scope', JSON.stringify(http.body))
  } finally {
    host.cleanup()
  }
}

section('moveMemory：两个按需库之间移动')
{
  const host = makeHost(mod)
  try {
    writeMemory(host.memoryDir, { slug: 'move-me', title: 'Move me', body: 'moving body', tags: ['t'] })
    const raw = host.read(path.join(host.memoryDir, 'move-me.md'))
    const moved = moveMemory(host.memoryDir, host.globalDir, 'move-me', { toScope: 'global' })
    check('移动成功', moved.ok === true, JSON.stringify(moved))
    check('  …源库没了、目标库有了，两边索引都更新', !ids(host.memoryDir).includes('move-me') && ids(host.globalDir).includes('move-me') &&
      !host.read(path.join(host.memoryDir, 'MEMORY.md')).includes('move-me') && host.read(path.join(host.globalDir, 'MEMORY.md')).includes('(move-me.md)'))
    check('  …移动前在源库留档', listHistory(host.memoryDir, 'move-me').length === 1 && readFileSync(listHistory(host.memoryDir, 'move-me')[0].file, 'utf8') === raw)
    check('  …只改了 scope 一行，其余字节原样', host.read(path.join(host.globalDir, 'move-me.md')) === raw.replace(/^scope: project$/m, 'scope: global'))

    writeMemory(host.memoryDir, { slug: 'move-me', title: 'Same id again', body: 'another' })
    const clash = moveMemory(host.memoryDir, host.globalDir, 'move-me', { toScope: 'global' })
    check('目标库已有同 id → target-exists，两边都不动', clash.ok === false && clash.reason === 'target-exists' && ids(host.memoryDir).includes('move-me'), JSON.stringify(clash))
    check('不存在 → not-found', moveMemory(host.memoryDir, host.globalDir, 'ghost').reason === 'not-found')
    check('不安全的 id → invalid-id', moveMemory(host.memoryDir, host.globalDir, '../x').reason === 'invalid-id')
    check('同一个库 → same-library', moveMemory(host.memoryDir, host.memoryDir, 'move-me').reason === 'same-library')
  } finally {
    host.cleanup()
  }

  const full = makeHost(mod, { config: { maxMemoryCount: 1 } })
  try {
    writeMemory(full.memoryDir, { slug: 'a', title: 'A', body: 'a' })
    writeMemory(full.globalDir, { slug: 'b', title: 'B', body: 'b', scope: 'global' })
    const res = moveMemory(full.memoryDir, full.globalDir, 'a', { toScope: 'global' })
    check('目标库满（两个库分别计数）→ library-full', res.ok === false && res.reason === 'library-full' && ids(full.memoryDir).includes('a'), JSON.stringify(res))
  } finally {
    full.cleanup()
  }
}

section('跨库查重：命中另一个库的条目同样拒写，候选标出所在的库')
{
  const host = makeHost(mod, { config: { duplicateCheck: true } })
  try {
    writeMemory(host.memoryDir, {
      slug: 'publish-github-actions-only',
      title: '发布只用 GitHub Actions 且每 4 小时批量',
      description: '发布节奏与渠道',
      body: '规则：每 4 小时批量发布，只用 GitHub Actions。',
    })
    const res = await host.tool('memory_remember', {
      slug: 'publish-cadence-global',
      title: '发布只用 GitHub Actions，每 4 小时批量发',
      description: '发布节奏与渠道（修订）',
      body: '规则：每 4 小时批量发布，只用 GitHub Actions。',
      type: 'project',
      source: 'agent',
      scope: 'global',
    })
    check('写全局库时命中项目库的同主题 → needs-review', res.reason === 'needs-review' && res.written === false, JSON.stringify(res))
    check('  …候选带 scope: project', res.candidates?.some((c) => c.id === 'publish-github-actions-only' && c.scope === 'project'), JSON.stringify(res.candidates))
    // 2026-11-14 第二轮：supersedes 能跨库（官方 user-actions.md：面板能做的换库，工具也要能做），
    // 所以文本改成「supersedes 两个库都能取代」，不再让模型换 scope 重来。跨库取代本身见 official-alignment.test.mjs。
    check('  …文本标出 [project]，并说明 supersedes 在两个库都能用', /\[project\]/.test(res.text) && /in either library/.test(res.text), res.text)
    check('  …全局库什么都没写', ids(host.globalDir).length === 0)

    const notFound = await host.tool('memory_remember', { slug: 'x', title: 'x', body: 'x', type: 'project', source: 'agent', scope: 'global', supersedes: 'nothing-like-this' })
    check('两个库都没有 → supersedes-not-found，什么都没写', notFound.reason === 'supersedes-not-found' && notFound.written === false && ids(host.globalDir).length === 0, JSON.stringify(notFound))
  } finally {
    host.cleanup()
  }
}

section('待确认：查重在分流之前；同 slug 草稿覆盖；条数上限同样先拦')
{
  const host = makeHost(mod, { config: { duplicateCheck: true, agentWrites: 'review', maxMemoryCount: 2 } })
  try {
    writeMemory(host.memoryDir, { slug: 'publish-github-actions-only', title: '发布只用 GitHub Actions 且每 4 小时批量', description: '发布节奏与渠道', body: '规则：每 4 小时批量发布，只用 GitHub Actions。' })
    const dup = await host.tool('memory_remember', { slug: 'dup-draft', title: '发布只用 GitHub Actions，每 4 小时批量发', description: '发布节奏与渠道（修订）', body: 'x', type: 'project', source: 'agent' })
    check('本该进待确认的写入先被查重拦下（needs-review，不入队）', dup.reason === 'needs-review' && listPending(host.memoryDir).length === 0, JSON.stringify(dup))

    const first = await host.tool('memory_remember', { slug: 'deploy-window', title: 'Deploy window', description: 'first', body: '周五不发版。', type: 'project', source: 'agent' })
    const second = await host.tool('memory_remember', { slug: 'deploy-window', title: 'Deploy window v2', description: 'second', body: '周五与节假日前一天都不发版。', type: 'project', source: 'agent' })
    check('同 slug 第二次 → 覆盖原草稿（id 不变）', second.pending === true && second.id === first.id && second.replacedDraft === first.id, JSON.stringify(second))
    check('  …队列里只有一条，内容是新版', listPending(host.memoryDir).length === 1 && listPending(host.memoryDir)[0].body.includes('节假日'))
    check('  …文本告诉模型覆盖了旧草稿', /overwrote the earlier draft/.test(second.text))

    writeMemory(host.memoryDir, { slug: 'second-one', title: 'Second', body: 'second' })
    const full = await host.tool('memory_remember', { slug: 'third', title: 'Third', body: 'completely unrelated zebra', type: 'project', source: 'agent', newMemory: true })
    check('库满时进待确认的写入同样被拦（library-full，不入队）', full.reason === 'library-full' && listPending(host.memoryDir).length === 1, JSON.stringify(full))
    const globalOk = await host.tool('memory_remember', { slug: 'third', title: 'Third', body: 'completely unrelated zebra', type: 'project', source: 'agent', scope: 'global', newMemory: true })
    check('两个库分别计数：全局库没满就照常入队', globalOk.pending === true && globalOk.scope === 'global', JSON.stringify(globalOk))
  } finally {
    host.cleanup()
  }
}

section('收下草稿：按 scope + load 落地；旧草稿兼容')
{
  const host = makeHost(mod)
  try {
    host.write(host.agentsFile, AGENTS)
    // 旧草稿：没有 load、scope: global —— 旧版的 global 只有 AGENTS.md 一个去处
    writePending(host.memoryDir, { id: 'dr_legacy', title: '旧的全局草稿', body: '旧草稿正文。', scope: 'global', slug: 'legacy' })
    check('writePending 没给 load 时不写这个字段（保留旧含义）', listPending(host.memoryDir)[0].meta.load === undefined)
    const legacy = await acceptPending(host.memoryDir, 'dr_legacy')
    check('旧草稿收下后进 AGENTS.md', legacy.ok === true && legacy.load === 'always' && host.read(host.agentsFile).includes('旧的全局草稿'), JSON.stringify(legacy))
    check('  …两个记忆库都没写', ids(host.memoryDir).length === 0 && ids(host.globalDir).length === 0)

    writePending(host.memoryDir, { id: 'dr_global', slug: 'global-draft', title: 'Global draft', body: '全局按需草稿。', scope: 'global', load: 'on-demand', source: 'user', evidence: '原话' })
    const onDemand = await acceptPending(host.memoryDir, 'dr_global')
    check('global + on-demand 草稿 → 全局按需库', onDemand.ok === true && onDemand.scope === 'global' && ids(host.globalDir).join() === 'global-draft', JSON.stringify(onDemand))
    const meta = listMemories(host.globalDir)[0].meta
    check('  …source / evidence 沿用到正式记忆', meta.source === 'user' && meta.evidence === '原话' && meta.status === 'confirmed', JSON.stringify(meta))
    check('  …草稿从项目队列里清掉', listPending(host.memoryDir).length === 0)

    writePending(host.memoryDir, { id: 'dr_bad', title: '本项目常驻', body: 'x', scope: 'project', load: 'always' })
    const bad = await acceptPending(host.memoryDir, 'dr_bad')
    check('project + always 草稿 → 不收（belongs-in-project-agents），草稿留着', bad.ok === false && bad.reason === 'belongs-in-project-agents' && listPending(host.memoryDir).length === 1, JSON.stringify(bad))
    const http = await host.http(`${API}/accept`, { method: 'POST', body: { id: 'dr_bad' } })
    check('  …HTTP accept 同样拒绝（400）', http.status === 400 && http.body?.reason === 'belongs-in-project-agents', `${http.status} ${JSON.stringify(http.body)}`)

    // /memory pending 标出去向
    writePending(host.memoryDir, { id: 'dr_show', title: '展示用', body: 'x', scope: 'global', load: 'on-demand', source: 'agent' })
    const pending = await host.command('memory', 'pending')
    check('/memory pending 标出去向与来源（面板的叫法：通用记忆 / 项目指令 / Agent 总结）', /→ 通用记忆 · Agent 总结 · dr_show$/m.test(pending.text) && /→ 项目指令（.* · dr_bad$/m.test(pending.text), pending.text)
    const accepted = await host.command('memory', 'accept dr_show')
    check('/memory accept 说明落到了哪个库', accepted.kind === 'success' && /→ 通用记忆 /.test(accepted.text), accepted.text)
  } finally {
    host.cleanup()
  }
}

section('注入：两个库都为空时 context 为空串（写入指引在系统提示段里）；全局索引有自己的行数上限')
{
  const empty = makeHost(mod)
  try {
    // 2026-11-14 第二轮：行为指引移进 ctx.systemPrompt.section（MEMORY_SECTION），动态 context 只放索引，
    // 两个库都空且没有预取时不贡献任何文本（官方 system-prompt.md：Empty text contributes nothing）
    check('两个库都空：context 是空串', empty.contextText() === '', JSON.stringify(empty.contextText().slice(0, 80)))
    const section = empty.sections.find((def) => def.name === 'workspace-memory')
    check('  …写入指引仍在：注册了 workspace-memory 系统提示段', section?.text === mod.MEMORY_SECTION)
  } finally {
    empty.cleanup()
  }

  const one = makeHost(mod)
  try {
    writeMemory(one.memoryDir, { slug: 'local-only', title: 'Local only', description: 'local entry', body: 'x' })
    const text = one.contextText()
    check('有条目时首行以 [workspace-memory] 开头', text.startsWith('[workspace-memory]'), text.slice(0, 60))
    check('  …空的全局小节省略', text.includes('## 本工作区') && !text.includes('## 所有项目'))
    check('  …context 里不含系统提示段的内容', !text.includes(mod.MEMORY_SECTION) && !text.includes('记忆与知识沉淀'))
  } finally {
    one.cleanup()
  }

  const host = makeHost(mod, { config: { maxMemoryCount: 0, globalIndexMaxLines: 10 } })
  try {
    writeMemory(host.memoryDir, { slug: 'local-one', title: 'Local', description: 'local entry', body: 'x' })
    for (let i = 0; i < 30; i += 1) writeMemory(host.globalDir, { slug: `g-${String(i).padStart(2, '0')}`, title: `G${i}`, description: `global ${i}`, body: `b${i}`, scope: 'global' })
    const text = host.contextText()
    const local = text.indexOf('## 本工作区')
    const shared = text.indexOf('## 所有项目（按需）')
    check('两个小节都在，项目库在前', local > 0 && shared > local, text.slice(0, 300))
    const section = text.slice(shared).split('\n').slice(1)
    check('全局小节不超过 globalIndexMaxLines 行', section.length <= 10, `${section.length} 行`)
    const warning = /\[WARNING\] (\d+) of 30 memory entries are NOT listed above/.exec(text.slice(shared))
    const listed = (text.slice(shared).match(/^- \[/gm) ?? []).length
    check('  …超出时写警告并报出省略条数（不静默截断）', warning && Number(warning[1]) === 30 - listed && listed > 0, warning?.[0])
    check('  …项目库的索引不受这个上限影响', text.slice(local, shared).includes('(local-one.md)'))
  } finally {
    host.cleanup()
  }

  const off = makeHost(mod, { config: { globalIndexMaxLines: 0 } })
  try {
    writeMemory(off.globalDir, { slug: 'g', title: 'G', description: 'global', body: 'zebra quartz marker', scope: 'global' })
    check('globalIndexMaxLines: 0 → 不注入全局索引', !off.contextText().includes('## 所有项目'))
    await off.fire('agent/pre-step', { agent: { id: 'agent-1' }, messages: [{ role: 'user', source: { kind: 'user' }, content: 'zebra quartz marker' }], turn: 1 })
    check('  …但预取仍能把全局条目带出来，并标出「所有项目」', /\[相关记忆\][\s\S]*- g — G（所有项目）/.test(off.contextText()), off.contextText())
  } finally {
    off.cleanup()
  }
}

section('paths 提示：两个库都查')
{
  const host = makeHost(mod)
  try {
    writeMemory(host.globalDir, { slug: 'global-path', title: '全局的路径记忆', body: 'x', scope: 'global', paths: ['pkg/global.js'] })
    // result 是 ToolExecutionResult 的形状（isError / value / content），没有 kind
    const { result, passed } = await host.fire('tools/post-execute', { name: 'read', arguments: { path: 'D:\\ws\\pkg\\global.js' }, agent: { id: 'agent-1' } }, { isError: false, value: 'file', content: [{ type: 'text', text: 'file' }] })
    check('全局库的 paths 命中 → 提示 id 与标题，并标出「所有项目」（下游 next() 照常被调用）', passed === true && /global-path — 全局的路径记忆（所有项目）/.test(result.content[1].text), JSON.stringify(result))
  } finally {
    host.cleanup()
  }
}

section('HTTP：list 返回两个库；save 改 scope 时换库；promote 支持全局库')
{
  const host = makeHost(mod)
  try {
    host.write(host.agentsFile, AGENTS)
    writeMemory(host.memoryDir, { slug: 'p-one', title: 'P one', body: 'project body' })
    writeMemory(host.memoryDir, { slug: 'legacy-hint', title: 'Legacy hint', body: 'legacy', scope: 'global' })
    writeMemory(host.globalDir, { slug: 'g-one', title: 'G one', body: 'global body', scope: 'global', source: 'user', evidence: '原话' })
    writePending(host.memoryDir, { id: 'dr_x', title: 'Draft', body: 'd', scope: 'global', load: 'on-demand', source: 'agent' })

    const list = await host.http(`${API}/list`)
    const byId = new Map(list.body.memories.map((m) => [m.id, m]))
    check('list 含两个库的条目，scope = 所在的库', byId.get('p-one')?.scope === 'project' && byId.get('g-one')?.scope === 'global', JSON.stringify(list.body.memories.map((m) => [m.id, m.scope])))
    check('  …带 globalRoot 与 agentWrites', list.body.globalRoot === host.globalDir && list.body.agentWrites === 'direct')
    check('  …项目库里写着 scope: global 的旧条目：scope 仍报 project', byId.get('legacy-hint')?.scope === 'project')
    // 2026-11-15 起 promotable = 「是已确认条目」：/promote 两个库都接受，普通项目记忆也可升为全局指令
    check('  …已确认条目一律 promotable: true（含普通项目记忆）', byId.get('legacy-hint')?.promotable === true && byId.get('p-one')?.promotable === true && byId.get('g-one')?.promotable === true)
    check('  …source / evidence / load 字段', byId.get('g-one')?.source === 'user' && byId.get('g-one')?.evidence === '原话' && byId.get('g-one')?.load === 'on-demand' && byId.get('p-one')?.source === null)
    check('  …草稿带自己的 scope / load', list.body.pending[0]?.scope === 'global' && list.body.pending[0]?.load === 'on-demand' && list.body.pending[0]?.status === 'draft')
    check('  …新条目不再编造 confidence', !('confidence' in byId.get('p-one')))

    const moved = await host.http(`${API}/save`, { method: 'POST', body: { id: 'p-one', patch: { scope: 'global', title: 'P one (now global)' } } })
    check('save 改 scope → 换到全局库并应用其余字段', moved.status === 200 && moved.body.moved === true && moved.body.previousScope === 'project' && moved.body.scope === 'global' && moved.body.memory?.scope === 'global' && moved.body.memory?.title === 'P one (now global)', JSON.stringify(moved.body))
    check('  …文件真的搬了，源库留了历史', ids(host.globalDir).includes('p-one') && !ids(host.memoryDir).includes('p-one') && listHistory(host.memoryDir, 'p-one').length === 1)

    const same = await host.http(`${API}/save`, { method: 'POST', body: { id: 'legacy-hint', patch: { scope: 'project', body: 'edited legacy' } } })
    check('scope 没变 → 原地保存，不移动；旧的 scope: global 提示不被悄悄改掉', same.status === 200 && !same.body.moved && listMemories(host.memoryDir).find((m) => m.id === 'legacy-hint')?.meta.scope === 'global', JSON.stringify(same.body))

    writeMemory(host.memoryDir, { slug: 'g-one', title: 'clash', body: 'clash' })
    const clash = await host.http(`${API}/save`, { method: 'POST', body: { id: 'g-one', scope: 'project', patch: { scope: 'global' } } })
    check('换库时目标库已有同 id → 409 target-exists，什么都不动', clash.status === 409 && clash.body.reason === 'target-exists' && ids(host.memoryDir).includes('g-one'), JSON.stringify(clash.body))
    const ambiguous = await host.http(`${API}/save`, { method: 'POST', body: { id: 'g-one', patch: { body: 'x' } } })
    check('两个库都有、没带 scope → 409 scope-ambiguous', ambiguous.status === 409 && ambiguous.body.reason === 'scope-ambiguous', JSON.stringify(ambiguous.body))
    const invalid = await host.http(`${API}/save`, { method: 'POST', body: { id: 'g-one', scope: 'project', patch: { scope: 'everywhere' } } })
    check('patch.scope 非法 → 400，什么都不动', invalid.status === 400 && ids(host.memoryDir).includes('g-one'), JSON.stringify(invalid.body))

    const promoted = await host.http(`${API}/promote`, { method: 'POST', body: { id: 'p-one', scope: 'global' } })
    check('全局库条目可以提升为 AGENTS.md 的一章', promoted.status === 200 && promoted.body.ok === true && host.read(host.agentsFile).includes('P one (now global)') && !ids(host.globalDir).includes('p-one'), JSON.stringify(promoted.body))
    const legacyPromote = await host.http(`${API}/promote`, { method: 'POST', body: { id: 'legacy-hint' } })
    check('项目库里写着 scope: global 的旧条目仍可提升', legacyPromote.status === 200 && legacyPromote.body.ok === true, JSON.stringify(legacyPromote.body))
    writeMemory(host.memoryDir, { slug: 'plain-project', title: 'Plain project', body: 'x' })
    // 2026-11-15 起项目记忆可以一步升为全局指令，不再返回 scope-not-global（详见 test/panel-routes.test.mjs）
    const plain = await host.http(`${API}/promote`, { method: 'POST', body: { id: 'plain-project', scope: 'project' } })
    check('普通项目库条目也能一步升为全局指令（fromScope: project）', plain.status === 200 && plain.body.ok === true && plain.body.fromScope === 'project' && !ids(host.memoryDir).includes('plain-project'), JSON.stringify(plain.body))

    const forget = await host.http(`${API}/forget`, { method: 'POST', body: { id: 'g-one' } })
    check('HTTP forget 两个库都有 → 409 scope-ambiguous', forget.status === 409 && forget.body.reason === 'scope-ambiguous')
    const forgetGlobal = await host.http(`${API}/forget`, { method: 'POST', body: { id: 'g-one', scope: 'global' } })
    check('带 scope → 删那一处，响应带 scope', forgetGlobal.status === 200 && forgetGlobal.body.scope === 'global' && ids(host.memoryDir).includes('g-one'), JSON.stringify(forgetGlobal.body))
  } finally {
    host.cleanup()
  }
}

section('/memory list、/memory forget、memory_status 覆盖两个库')
{
  const host = makeHost(mod, { config: { agentWrites: 'review' } })
  try {
    writeMemory(host.memoryDir, { slug: 'p-one', title: 'P one', body: 'p' })
    writeMemory(host.globalDir, { slug: 'g-one', title: 'G one', body: 'g', scope: 'global' })
    const list = await host.command('memory', 'list')
    const projectAt = list.text.indexOf('项目记忆（project）1 条：')
    const globalAt = list.text.indexOf('通用记忆（global）1 条：')
    check('/memory list 两个库分组列出，组标题带库名与条数', projectAt >= 0 && globalAt > projectAt && list.text.indexOf('p-one') > projectAt && list.text.indexOf('p-one') < globalAt && list.text.indexOf('g-one') > globalAt, list.text)
    const status = await host.tool('memory_status', {})
    check('memory_status 分别报两个库的条数与 agentWrites', /\[project\] memories: 1/.test(status.text) && /\[global\] memories: 1/.test(status.text) && /agentWrites: review/.test(status.text), status.text)
    check('  …没有置信度门槛', !/confidence/i.test(status.text))
    const forgot = await host.command('memory', 'forget g-one')
    check('/memory forget 能删全局库的条目', forgot.kind === 'success' && !ids(host.globalDir).includes('g-one'), forgot.text)
  } finally {
    host.cleanup()
  }
}

section('真实文件未被本次测试改动')
check('~/.dsh/AGENTS.md 与 ~/.dsh/global-memory 的存在性与哈希不变', guard.unchanged())

summary()
