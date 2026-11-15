/**
 * memory_remember 的去向（scope × load）与来源分流，走完整的工具调用。
 *
 * | scope   | load      | 去向 |
 * |---------|-----------|------|
 * | project | on-demand | 项目库 |
 * | global  | on-demand | 全局按需库（新增）；type 是 user / feedback 时按 §15.1 改成 always（见末尾一节） |
 * | global  | always    | ~/.dsh/AGENTS.md 的一章：一律先进待确认，收下才写（第五轮） |
 * | project | always    | 插件不写：belongs-in-project-agents，指向项目自己的 AGENTS.md |
 *
 * 来源（按需写入）：user + 证据核对通过且与标题/摘要沾边 → 直写；否则 evidence-not-found；
 * agent → agentWrites（默认 review → agent-review）。常驻（always）不论来源一律 always-needs-user。
 *
 * 全部在临时目录；AGENTS.md / 两个库都经 apply 传入，结束时比对真实文件的哈希。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { makeHost, makeReporter, realFilesGuard, userEvent } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()

const AGENTS = '# 全局约定\n\n## 1. 已有的一章\n\n原有内容。\n'
const SAID = '以后每次改完插件都先跑测试再提交，别再忘了。'
const mdFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').sort() : [])

/** 每个用例一个新宿主：默认 review，用户在会话里说过 SAID。 */
function host(config = {}) {
  // 工作区注册表：每次解析都会重读，所以宿主建好之后再把它的工作区登记进去即可
  const roots = []
  const h = makeHost(mod, {
    config: { agentWrites: 'review', duplicateCheck: false, ...config },
    registry: { list: () => roots.map((p) => ({ path: p })) },
  })
  roots.push(h.workspace)
  h.write(h.agentsFile, AGENTS)
  h.state.events.push(userEvent(SAID))
  return h
}

const snapshot = (h) => JSON.stringify([mdFiles(h.memoryDir), mdFiles(h.globalDir), h.read(h.agentsFile), mod.listPending(h.memoryDir).map((d) => d.id)])

section('四种 scope × load 组合（user 原话、证据通过：按需直写，常驻进待确认）')
{
  // 证据要与标题或摘要沾边（evidenceRelates，第五轮）：摘要写的就是这条记忆本身
  const base = { type: 'feedback', source: 'user', evidence: '改完插件都先跑测试…别再忘了', description: '改完插件先跑测试再提交' }

  const a = host()
  try {
    const res = await a.tool('memory_remember', { ...base, slug: 'test-first', title: 'Test first', body: '先跑测试再提交。', scope: 'project', load: 'on-demand' })
    check('project + on-demand → 项目库', res.scope === 'project' && mdFiles(a.memoryDir).join() === 'test-first.md' && mdFiles(a.globalDir).length === 0, JSON.stringify(res))
    const meta = mod.listMemories(a.memoryDir)[0].meta
    check('  …frontmatter 带 source / evidence，不再写 confidence', meta.source === 'user' && /先跑测试/.test(meta.evidence) && meta.confidence === undefined, JSON.stringify(meta))
  } finally {
    a.cleanup()
  }

  const b = host()
  try {
    // §15.1 起 feedback / user + global 一律常驻：这里测全局按需库这条去向，用不被强制的类型
    const res = await b.tool('memory_remember', { ...base, type: 'project', slug: 'test-first', title: 'Test first', body: '先跑测试再提交。', scope: 'global', load: 'on-demand' })
    check('global + on-demand → 全局按需库', res.scope === 'global' && mdFiles(b.globalDir).join() === 'test-first.md' && mdFiles(b.memoryDir).length === 0, JSON.stringify(res))
    check('  …全局库有自己的 MEMORY.md 索引', /\(test-first\.md\)/.test(b.read(path.join(b.globalDir, 'MEMORY.md'))))
    check('  …文件里记着 scope: global', mod.listMemories(b.globalDir)[0].meta.scope === 'global')
    check('  …AGENTS.md 没动', b.read(b.agentsFile) === AGENTS)
  } finally {
    b.cleanup()
  }

  const c = host()
  try {
    const res = await c.tool('memory_remember', { ...base, title: '先跑测试再提交', body: '先跑测试再提交。', scope: 'global', load: 'always', newChapter: true })
    // 第五轮设计变更：常驻一律进待确认，证据核对得上也一样
    check('global + always → 进待确认（always-needs-user），AGENTS.md 没动', res.pending === true && res.reason === 'always-needs-user' && c.read(c.agentsFile) === AGENTS, JSON.stringify(res))
    check('  …两个记忆库都没写', mdFiles(c.memoryDir).length === 0 && mdFiles(c.globalDir).length === 0)
    check('  …文本说在面板里等确认，不说「已生效」', /waiting in the memory panel/.test(res.text) && !res.text.includes(mod.ACTIVE_NOW_TEXT), res.text)
    const accepted = await mod.acceptPending(c.memoryDir, res.id)
    check('  …收下后 AGENTS.md 新增一章', accepted.ok === true && accepted.action === 'added' && c.read(c.agentsFile).includes('## 2. 先跑测试再提交'), JSON.stringify(accepted))
  } finally {
    c.cleanup()
  }

  const d = host()
  try {
    // 宿主只从「往上最近的 .git 目录」往下加载项目指令（官方 dsh-agent-instructions：findProjectRoot）。
    // 在工作区里放一个 .git，让「项目根」是确定的，不依赖临时目录的上级里有没有 .git。
    mkdirSync(path.join(d.workspace, '.git'))
    const projectAgents = path.join(d.workspace, 'AGENTS.md')
    const before = snapshot(d)
    const res = await d.tool('memory_remember', { ...base, slug: 'test-first', title: 'Test first', body: '先跑测试再提交。', scope: 'project', load: 'always' })
    check('project + always → belongs-in-project-agents、written:false', res.reason === 'belongs-in-project-agents' && res.written === false, JSON.stringify(res))
    check('  …文本给出项目根（含 .git 的目录）下 AGENTS.md 的绝对路径', res.text.includes(projectAgents), res.text)
    check('  …并说明它当前不存在', /does not exist yet/.test(res.text))
    check('  …说明共享文件要先征得同意、个人偏好改 scope 或 load', /once they agree/.test(res.text) && /scope: "global"/.test(res.text) && /load: "on-demand"/.test(res.text))
    check('  …只对当前用户成立的项目规则写同目录的 AGENTS.local.md', /AGENTS\.local\.md in the same directory/.test(res.text), res.text)
    check('  …什么都没写（两个库、草稿、全局 AGENTS.md、项目 AGENTS.md）', snapshot(d) === before && !existsSync(projectAgents))

    // 会话在子目录里：往上找到最近的 .git，而不是停在工作目录
    const deep = path.join(d.workspace, 'pkg', 'src')
    mkdirSync(deep, { recursive: true })
    d.state.cwd = deep
    const fromDeep = await d.tool('memory_remember', { ...base, slug: 'test-first', title: 'Test first', body: '先跑测试再提交。', scope: 'project', load: 'always' })
    check('  …工作目录在子目录：仍指向含 .git 的根下的 AGENTS.md', fromDeep.text.includes(projectAgents) && !fromDeep.text.includes(path.join(deep, 'AGENTS.md')), fromDeep.text)
    // 子目录自己是一个 git 仓库（工作区里的子仓库）：指向它自己的 AGENTS.md
    mkdirSync(path.join(d.workspace, 'pkg', '.git'))
    const fromSubRepo = await d.tool('memory_remember', { ...base, slug: 'test-first', title: 'Test first', body: '先跑测试再提交。', scope: 'project', load: 'always' })
    check('  …最近的 .git 在子仓库：指向子仓库的 AGENTS.md', fromSubRepo.text.includes(path.join(d.workspace, 'pkg', 'AGENTS.md')), fromSubRepo.text)
    d.state.cwd = d.workspace
    d.write(projectAgents, '# 项目规则\n')
    const again = await d.tool('memory_remember', { ...base, slug: 'test-first', title: 'Test first', body: '先跑测试再提交。', scope: 'project', load: 'always' })
    check('  …项目 AGENTS.md 存在时如实说存在，且不改它', /it exists/.test(again.text) && d.read(projectAgents) === '# 项目规则\n', again.text)
    const agent = await d.tool('memory_remember', { slug: 'x', title: 'X', body: 'x', type: 'project', source: 'agent', scope: 'project', load: 'always' })
    check('  …不论来源都同样拒绝（不进待确认）', agent.reason === 'belongs-in-project-agents' && mod.listPending(d.memoryDir).length === 0)
  } finally {
    d.cleanup()
  }
}

section('source: user —— 证据通过直写，未通过进待确认')
{
  const h = host()
  try {
    const ok = await h.tool('memory_remember', { slug: 'ok', title: 'OK', description: '改完插件先跑测试再提交', body: '先跑测试。', type: 'feedback', source: 'user', evidence: '「以后每次改完插件都先跑测试再提交」' })
    check('证据通过 → 直写', typeof ok.id === 'string' && !ok.pending && mdFiles(h.memoryDir).includes('ok.md'), JSON.stringify(ok))
    check('  …直写文本说「已生效、不用确认」，不说「在面板里等」', ok.text.endsWith(mod.ACTIVE_NOW_TEXT) && !/waiting in the memory panel/.test(ok.text), ok.text)

    for (const [label, evidence] of [
      ['用户没说过的话', '以后都用英文回答'],
      ['没给 evidence', undefined],
      ['只有一个字', '先'],
    ]) {
      const res = await h.tool('memory_remember', { slug: `no-${label.length}`, title: `No ${label.length}`, body: '正文。', type: 'user', source: 'user', ...(evidence === undefined ? {} : { evidence }) })
      check(`${label} → pending / evidence-not-found`, res.pending === true && res.reason === 'evidence-not-found', JSON.stringify(res))
      // 没给证据单独说「没有提供证据」；其余情形（第六轮）只说没核对到，不说怎样才算核对到（不教模型绕过）
      const why = evidence === undefined ? /no evidence \(the user's own words\) was given/ : /could not be verified against the user's messages/
      check(`  …文本一句话说清原因，并让模型告诉用户去面板看`, why.test(res.text) && /Tell the user it is waiting in the memory panel/.test(res.text), res.text)
      check('  …文本不提「与标题共享词语」之类的绕过办法', !/title|description|shares? no words/i.test(res.text.split('Tell the user')[0]), res.text)
      check('  …待确认不说「已生效」', !res.text.includes(mod.ACTIVE_NOW_TEXT), res.text)
    }
    const draft = mod.listPending(h.memoryDir).find((d) => d.meta.evidence === '以后都用英文回答')
    check('草稿 frontmatter 带 scope / load / source / evidence', draft?.meta.scope === 'project' && draft?.meta.load === 'on-demand' && draft?.meta.source === 'user' && draft?.meta.evidence === '以后都用英文回答', JSON.stringify(draft?.meta))
    check('草稿不在任何库里', mdFiles(h.memoryDir).join() === 'ok.md' && mdFiles(h.globalDir).length === 0)

    // 证据只出现在注入块里：不算用户说的
    h.state.events.push(userEvent('[workspace-memory] 记忆索引。以后都用英文回答'))
    const injected = await h.tool('memory_remember', { slug: 'inj', title: 'Inj', body: 'x', type: 'user', source: 'user', evidence: '以后都用英文回答' })
    check('证据只在注入块里 → 不通过', injected.reason === 'evidence-not-found', JSON.stringify(injected))
  } finally {
    h.cleanup()
  }

  const noSession = makeHost(mod, { config: { agentWrites: 'review', duplicateCheck: false } })
  try {
    // 会话里没有任何事件（拿不到原话）
    const res = await noSession.tool('memory_remember', { slug: 'lonely', title: 'Lonely', body: 'x', type: 'user', source: 'user', evidence: '以后每次改完插件都先跑测试' })
    check('会话里没有用户消息 → 不通过，进待确认', res.reason === 'evidence-not-found', JSON.stringify(res))
  } finally {
    noSession.cleanup()
  }
}

section('source: agent —— 默认进待确认；agentWrites: direct 时按需直写，常驻仍要人看')
{
  const review = host()
  try {
    const res = await review.tool('memory_remember', { slug: 'pit', title: 'Pit', body: '编辑器占着文件时 rename 会 EPERM。', type: 'pitfall', source: 'agent' })
    check('agent + on-demand → pending / agent-review', res.pending === true && res.reason === 'agent-review', JSON.stringify(res))
    check('  …文本与设计说明一致', res.text.startsWith(`Queued as pending ${res.id}: this was worked out by the agent rather than stated by the user, so the human reviews it first. Tell the user it is waiting in the memory panel.`), res.text)
    check('  …草稿记着 source: agent、没有 evidence', mod.listPending(review.memoryDir)[0]?.meta.source === 'agent' && mod.listPending(review.memoryDir)[0]?.meta.evidence === undefined)
    const sneaky = await review.tool('memory_remember', { slug: 'sneaky', title: 'Sneaky', body: 'x', type: 'pitfall', source: 'agent', evidence: SAID })
    check('agent 来源带了 evidence 也不直写、不落 evidence', sneaky.reason === 'agent-review' && mod.listPending(review.memoryDir).find((d) => d.meta.slug === 'sneaky')?.meta.evidence === undefined)
    const missing = await review.tool('memory_remember', { slug: 'nosrc', title: 'No source', body: 'x', type: 'project' })
    check('不传 source 按 agent 处理', missing.reason === 'agent-review', JSON.stringify(missing))
  } finally {
    review.cleanup()
  }

  const direct = host({ agentWrites: 'direct' })
  try {
    const res = await direct.tool('memory_remember', { slug: 'pit', title: 'Pit', body: 'rename EPERM。', type: 'pitfall', source: 'agent', scope: 'global' })
    check('agentWrites: direct → agent + on-demand 直写（全局按需库）', typeof res.id === 'string' && res.scope === 'global' && mdFiles(direct.globalDir).join() === 'pit.md', JSON.stringify(res))
    check('  …frontmatter 记着 source: agent', mod.listMemories(direct.globalDir)[0].meta.source === 'agent')
    const always = await direct.tool('memory_remember', { title: '模型的全局常驻规则', body: 'x', type: 'feedback', source: 'agent', scope: 'global', load: 'always', newChapter: true })
    check('agent + always 仍进待确认（always-needs-user）', always.pending === true && always.reason === 'always-needs-user' && direct.read(direct.agentsFile) === AGENTS, JSON.stringify(always))
    // 这里的 agentsFile 配置在临时目录（DSH 主目录之外）：文案显示的就是配置的那个路径，
    // 不是主目录下的 AGENTS.md（以前恒写主目录，配置了自定义路径的用户看到的是一个不存在的文件）
    check('  …文本点明收下后写进配置的那个 AGENTS.md', always.text.includes(`writes it into ${direct.agentsFile}`) && always.text.includes(mod.agentsFileDisplay()), always.text)
  } finally {
    direct.cleanup()
  }
}

section('§15.1 user / feedback + global 一律常驻（代码判定，不交给模型选）')
{
  // 目标模型评测：模型说「已记到全局偏好」，scope 给了 global，load 却留在 on-demand，条目进了按需库
  const base = { source: 'user', evidence: '改完插件都先跑测试…别再忘了', description: '改完插件先跑测试再提交', title: '先跑测试再提交', body: '先跑测试再提交。' }

  for (const type of ['feedback', 'user']) {
    const h = host({ agentWrites: 'direct' })
    try {
      const res = await h.tool('memory_remember', { ...base, slug: `forced-${type}`, type, scope: 'global', load: 'on-demand', newChapter: true })
      check(`${type} + global + on-demand → 进待确认（常驻），loadForced: true`, res.pending === true && res.reason === 'always-needs-user' && res.load === 'always' && res.loadForced === true, JSON.stringify(res))
      check('  …文本带那一句说明', res.text.includes(mod.LOAD_FORCED_TEXT), res.text)
      check('  …两个按需库都没写，AGENTS.md 没动（等用户收下）', mdFiles(h.memoryDir).length === 0 && mdFiles(h.globalDir).length === 0 && h.read(h.agentsFile) === AGENTS)
      check('  …草稿记着 load: always', mod.listPending(h.memoryDir)[0]?.meta.load === 'always', JSON.stringify(mod.listPending(h.memoryDir)[0]?.meta))
    } finally {
      h.cleanup()
    }
  }

  const h = host({ agentWrites: 'direct' })
  try {
    const noLoad = await h.tool('memory_remember', { ...base, slug: 'no-load', type: 'feedback', scope: 'global', newChapter: true })
    check('不传 load → 同样常驻，但不带 loadForced（没有覆盖模型的选择）', noLoad.pending === true && noLoad.load === 'always' && !('loadForced' in noLoad) && !noLoad.text.includes(mod.LOAD_FORCED_TEXT), JSON.stringify(noLoad))
    const explicit = await h.tool('memory_remember', { ...base, slug: 'explicit-always', title: '另一个话题', type: 'feedback', scope: 'global', load: 'always', newChapter: true })
    check('显式 always → 常驻，不带 loadForced', explicit.pending === true && explicit.load === 'always' && !('loadForced' in explicit), JSON.stringify(explicit))
    // 常驻分支本身不变：没给 newChapter / chapter、标题又不同名 → needs-confirmation，照样带 loadForced
    const confirm = await h.tool('memory_remember', { ...base, slug: 'needs-confirm', title: '全新的话题', type: 'feedback', scope: 'global', load: 'on-demand' })
    check('  …常驻分支的拒写（needs-confirmation）也带 loadForced 与说明', confirm.reason === 'needs-confirmation' && confirm.loadForced === true && confirm.text.includes(mod.LOAD_FORCED_TEXT), JSON.stringify(confirm))
    // 过期值提示仍固定在全文最后（§4.6），说明那句在它之前
    const stale = await h.tool('memory_remember', { ...base, slug: 'stale-forced', title: '又一个话题', body: '部署固定在 abc1234 这个提交。', type: 'feedback', scope: 'global', load: 'on-demand', newChapter: true })
    check('  …有过期值时，说明在过期值提示之前', stale.loadForced === true && Array.isArray(stale.staleValues) && stale.text.indexOf(mod.LOAD_FORCED_TEXT) < stale.text.lastIndexOf('abc1234'), stale.text)

    const project = await h.tool('memory_remember', { ...base, slug: 'project-feedback', type: 'feedback', scope: 'project', load: 'on-demand' })
    check('feedback + project + on-demand → 照旧进项目按需库', typeof project.id === 'string' && project.scope === 'project' && !project.pending && !('loadForced' in project) && mdFiles(h.memoryDir).includes('project-feedback.md'), JSON.stringify(project))
    for (const type of ['pitfall', 'reference']) {
      const res = await h.tool('memory_remember', { slug: `global-${type}`, title: `Global ${type}`, body: `${type} body`, type, source: 'agent', scope: 'global', load: 'on-demand' })
      check(`${type} + global + on-demand → 照旧进全局按需库（不被强制）`, typeof res.id === 'string' && res.scope === 'global' && !res.pending && !('loadForced' in res) && mdFiles(h.globalDir).includes(`global-${type}.md`), JSON.stringify(res))
    }

    // 「更新留在原处」（keptAsMemory）：被取代的记忆在全局按需库里，更新仍按按需处理
    mod.writeMemory(h.globalDir, { slug: 'old-global-pref', title: '旧的全局偏好', description: '旧的全局偏好', body: '旧正文。', type: 'feedback', scope: 'global' })
    const kept = await h.tool('memory_remember', { slug: 'old-global-pref', title: '新的全局偏好', body: '新正文。', type: 'repo-rule', source: 'agent', scope: 'global', load: 'on-demand', supersedes: 'old-global-pref' })
    check('keptAsMemory 路径不被强制：原地更新在全局按需库里，没有 loadForced', kept.keptAsMemory === true && kept.updated === true && !kept.pending && !('loadForced' in kept) &&
      mod.listMemories(h.globalDir).find((m) => m.id === 'old-global-pref')?.body === '新正文。', JSON.stringify(kept))
  } finally {
    h.cleanup()
  }

  check('resolveLoad：只有 user / feedback + global 被改成 always；forced 只在显式 on-demand 时为真',
    JSON.stringify(mod.resolveLoad({ type: 'feedback', scope: 'global', load: 'on-demand' })) === '{"load":"always","forced":true}' &&
      JSON.stringify(mod.resolveLoad({ type: 'user', scope: 'global', load: '' })) === '{"load":"always","forced":false}' &&
      JSON.stringify(mod.resolveLoad({ type: 'feedback', scope: 'project', load: 'on-demand' })) === '{"load":"on-demand","forced":false}' &&
      JSON.stringify(mod.resolveLoad({ type: 'pitfall', scope: 'global', load: 'on-demand' })) === '{"load":"on-demand","forced":false}' &&
      JSON.stringify(mod.resolveLoad({ type: 'reference', scope: 'global' })) === '{"load":"on-demand","forced":false}')

  // 自动抽取的候选同一规则：user / feedback + global 按常驻进待确认
  // 每轮最多入队 3 条是默认值，这里有 4 条候选；内容彼此无关，免得被抽取的去重合并
  const ex = host({ extractMaxPerTurn: 5 })
  try {
    const candidates = [
      { slug: 'ex-feedback', title: '回答先给结论', body: '回答时先给结论，再给理由。', type: 'feedback', scope: 'global', load: 'on-demand', source: 'agent' },
      { slug: 'ex-user', title: '用户是后端工程师', body: '用户主要写 Java 后端，前端经验少。', type: 'user', scope: 'global', source: 'agent' },
      { slug: 'ex-pitfall', title: 'Windows 上 rename 偶发 EPERM', body: '杀毒软件占着文件时 rename 会报 EPERM，稍等重试即可。', type: 'pitfall', scope: 'global', load: 'on-demand', source: 'agent' },
      { slug: 'ex-project-feedback', title: '本项目提交说明用中文', body: '这个仓库的提交说明用中文写。', type: 'feedback', scope: 'project', load: 'on-demand', source: 'agent' },
    ]
    const session = { snapshotEvents: () => [userEvent('随便说点什么'.repeat(40))], requestContext: () => ({ provider: 'p', model: 'm' }) }
    const llm = { stream: () => (async function* () { yield { type: 'text-delta', text: JSON.stringify(candidates) } })() }
    const ctx = { get: (key) => (key === 'llm' ? llm : undefined), sessions: { get: () => session } }
    const r = await mod.extractFromTurn(ctx, { id: 'x' }, ex.memoryDir, { manual: true, globalDir: ex.globalDir })
    const loads = Object.fromEntries(mod.listPending(ex.memoryDir).map((d) => [d.meta.slug, d.meta.load]))
    check('抽取：feedback / user + global 的候选按常驻进待确认，其余照旧', r.queued === 4 && loads['ex-feedback'] === 'always' && loads['ex-user'] === 'always' &&
      loads['ex-pitfall'] === 'on-demand' && loads['ex-project-feedback'] === 'on-demand', `${JSON.stringify(r)} ${JSON.stringify(loads)}`)
  } finally {
    ex.cleanup()
  }
}

section('常驻草稿取代按需库里的旧条：收下时先写章节、写成功后归档删除旧条（第十一轮）')
{
  // 第十轮复现：强制常驻 + supersedes，收下后旧条仍在全局按需库——同一条偏好两个出处。
  // 用户的决定：跨项目偏好以全局 AGENTS.md 为唯一出处
  const API = '/api/dsh-workspace-memory'
  const oldPref = (h, dir = h.globalDir, scope = 'global') =>
    mod.writeMemory(dir, { slug: 'old-pref', title: '旧的回答偏好', description: '回答先讲背景', body: '回答先讲背景。', type: 'feedback', scope })
  const call = (h, extra = {}) =>
    h.tool('memory_remember', { slug: 'answer-first', title: '回答先给结论', body: '回答先给结论，再给理由。', type: 'feedback', source: 'agent', scope: 'global', load: 'on-demand', supersedes: 'old-pref', newChapter: true, ...extra })
  const inGlobal = (h) => mod.listMemories(h.globalDir).map((m) => m.id)

  const h = host()
  try {
    oldPref(h)
    const res = await call(h)
    check('强制常驻 + 取代全局按需库里的旧条 → 进待确认', res.pending === true && res.load === 'always' && res.loadForced === true, JSON.stringify(res))
    check('  …文本说明收下后写进全局 AGENTS.md 并删除旧记忆（先归档）',
      res.text.includes(`Accepting it writes it into ${mod.agentsFileDisplay()} as a new chapter and then deletes the old memory old-pref from the all-projects on-demand library (scope "global") (its body is archived in history/ first).`), res.text)
    const draft = mod.listPending(h.memoryDir)[0]
    check('  …草稿记着被取代条目的 id 与所在的库', draft?.meta.supersedes === 'old-pref' && draft?.meta.supersedesScope === 'global', JSON.stringify(draft?.meta))
    check('  …现在什么都没动（旧条还在，AGENTS.md 没变）', inGlobal(h).join() === 'old-pref' && h.read(h.agentsFile) === AGENTS)
    const list = await h.http(`${API}/list`)
    const shown = list.body?.pending?.find((item) => item.id === draft.id)
    check('  …列表接口的草稿带 supersedes / supersedesScope', shown?.supersedes === 'old-pref' && shown?.supersedesScope === 'global', JSON.stringify(shown))

    const accepted = await mod.acceptPending(h.memoryDir, draft.id, { globalDir: h.globalDir })
    check('收下 → AGENTS.md 新增一章', accepted.ok === true && accepted.action === 'added' && h.read(h.agentsFile).includes('回答先给结论'), JSON.stringify(accepted))
    check('  …旧条不在按需库里了，返回 replaced / replacedScope', !inGlobal(h).includes('old-pref') && accepted.replaced === 'old-pref' && accepted.replacedScope === 'global', JSON.stringify(accepted))
    check('  …旧条的正文在全局库的 history 里归档', mod.listHistory(h.globalDir, 'old-pref').some((entry) => readFileSync(entry.file, 'utf8').includes('回答先讲背景')))
    check('  …全局库索引也没有它了', !h.read(path.join(h.globalDir, 'MEMORY.md')).includes('old-pref'))
  } finally {
    h.cleanup()
  }

  const rejected = host()
  try {
    oldPref(rejected)
    const res = await call(rejected)
    const r = mod.rejectPending(rejected.memoryDir, res.id)
    check('丢弃这类草稿 → 旧条原样还在', r.ok === true && inGlobal(rejected).join() === 'old-pref' && mod.listHistory(rejected.globalDir, 'old-pref').length === 0 && rejected.read(rejected.agentsFile) === AGENTS)
  } finally {
    rejected.cleanup()
  }

  const moved = host()
  try {
    oldPref(moved)
    // 草稿要更新「已有的一章」；收下前那一章被改了名 → section-moved：章节没写，旧条也不能删
    const res = await call(moved, { title: '已有的一章', newChapter: undefined })
    check('  （前置）草稿要更新第 1 章', res.pending === true && res.chapter === 1, JSON.stringify(res))
    moved.write(moved.agentsFile, AGENTS.replace('## 1. 已有的一章', '## 1. 改过名的一章'))
    const accepted = await mod.acceptPending(moved.memoryDir, res.id, { globalDir: moved.globalDir })
    check('章节写入失败（section-moved）→ 旧条还在，草稿还在', accepted.ok === false && accepted.reason === 'section-moved' && inGlobal(moved).join() === 'old-pref' && mod.listPending(moved.memoryDir).length === 1, JSON.stringify(accepted))
  } finally {
    moved.cleanup()
  }

  const gone = host()
  try {
    oldPref(gone)
    const res = await call(gone)
    mod.deleteMemory(gone.globalDir, 'old-pref') // 收下前旧条已经被删了
    const accepted = await mod.acceptPending(gone.memoryDir, res.id, { globalDir: gone.globalDir })
    check('旧条事先已被删 → 照样收下（只写章节、不报错），返回里注明旧条已不存在', accepted.ok === true && accepted.action === 'added' && accepted.replacedMissing === 'old-pref' && !('replaced' in accepted) && gone.read(gone.agentsFile).includes('回答先给结论'), JSON.stringify(accepted))
  } finally {
    gone.cleanup()
  }

  const cross = host()
  try {
    oldPref(cross, cross.memoryDir, 'project') // 旧条在项目库：另一个库只认精确 id
    const res = await call(cross)
    check('旧条在项目库（精确 id）→ 草稿记着 supersedesScope: project，文本点明项目库', res.pending === true && mod.listPending(cross.memoryDir)[0]?.meta.supersedesScope === 'project' &&
      /deletes the old memory old-pref from this workspace's library/.test(res.text), res.text)
    const accepted = await mod.acceptPending(cross.memoryDir, res.id, { globalDir: cross.globalDir })
    check('  …收下后从项目库删掉', accepted.ok === true && accepted.replacedScope === 'project' && mod.listMemories(cross.memoryDir).length === 0, JSON.stringify(accepted))

    const notFound = await call(cross, { slug: 'nf', supersedes: 'nothing-like-this' })
    check('解析不到 → supersedes-not-found，不入队（不静默忽略）', notFound.reason === 'supersedes-not-found' && mod.listPending(cross.memoryDir).length === 0, JSON.stringify(notFound))
    mod.writeMemory(cross.globalDir, { slug: 'pref-a', title: 'A', body: 'a', type: 'feedback', scope: 'global' })
    mod.writeMemory(cross.globalDir, { slug: 'pref-b', title: 'B', body: 'b', type: 'feedback', scope: 'global' })
    const ambiguous = await call(cross, { slug: 'amb', supersedes: 'pref-' })
    check('目标库前缀多条 → supersedes-ambiguous，不入队', ambiguous.reason === 'supersedes-ambiguous' && ambiguous.candidates?.length === 2 && mod.listPending(cross.memoryDir).length === 0, JSON.stringify(ambiguous))
    mod.writeMemory(cross.memoryDir, { slug: 'proj-only-pref', title: 'P', body: 'p', type: 'feedback' })
    const prefixOther = await call(cross, { slug: 'po', supersedes: 'proj-only' })
    check('只在另一个库前缀命中 → supersedes-ambiguous（跨库只认精确 id）', prefixOther.reason === 'supersedes-ambiguous' && prefixOther.candidates?.[0]?.scope === 'project', JSON.stringify(prefixOther))
  } finally {
    cross.cleanup()
  }

  const intents = host()
  try {
    oldPref(intents)
    const withOld = await call(intents)
    const without = await call(intents, { supersedes: undefined })
    check('draftIntent：同 slug，一条取代旧条、一条不取代 → 不互相覆盖，两条都在', without.pending === true && !without.replacedDraft && without.sameSlugDrafts?.includes(withOld.id) && mod.listPending(intents.memoryDir).length === 2, JSON.stringify(without))
    const again = await call(intents, { body: '回答先给结论。' })
    check('  …取代对象相同 → 覆盖原来那条', again.replacedDraft === withOld.id && mod.listPending(intents.memoryDir).length === 2, JSON.stringify(again))
    const cmd = await intents.command('memory', `accept ${withOld.id}`)
    check('/memory accept 的文字说明删除了旧记忆', cmd.kind === 'success' && /删除了旧记忆 old-pref/.test(cmd.text) && !inGlobal(intents).includes('old-pref'), JSON.stringify(cmd))
  } finally {
    intents.cleanup()
  }
}

section('真实文件未被本次测试改动')
check('~/.dsh/AGENTS.md 与 ~/.dsh/global-memory 的存在性与哈希不变', guard.unchanged())

summary()
