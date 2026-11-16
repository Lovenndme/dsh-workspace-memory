/**
 * 新写入按 scope 选记忆库，按来源决定直写或待确认，旧 load 实参只产生兼容提示。
 * 历史常驻草稿直接构造，保留收下写 AGENTS.md、取代旧条与失败时不删旧条的覆盖。
 * AGENTS.md / 两个库都经 apply 传入临时路径。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { makeHost, makeReporter, realFilesGuard, userEvent, legacyAlwaysDraft, schemaProblems } from './fake-host.mjs'

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

section('scope 决定记忆库，旧 load: always 不改变去向')
{
  for (const scope of ['project', 'global']) {
    const h = host()
    try {
      const result = await h.tool('memory_remember', {
        slug: 'test-first', title: 'Test first', body: '先跑测试再提交。', description: '改完插件先跑测试再提交',
        type: 'feedback', source: 'user', evidence: '改完插件都先跑测试…别再忘了', scope, load: 'always', newChapter: true,
      })
      const dir = scope === 'global' ? h.globalDir : h.memoryDir
      check(scope + ' + always → 证据通过直写记忆库', !result.pending && result.scope === scope && mdFiles(dir).join() === 'test-first.md', JSON.stringify(result))
      check('旧 load 返回兼容提示，放在全文最后', result.loadIgnored === true && result.text.endsWith(mod.LOAD_IGNORED_TEXT), result.text)
      check('正式记忆带来源和证据', mod.listMemories(dir)[0]?.meta.source === 'user' && mod.listMemories(dir)[0]?.meta.evidenceVerified === 'true')
      check('没有草稿，AGENTS.md 原样不变', mod.listPending(h.memoryDir).length === 0 && h.read(h.agentsFile) === AGENTS)
    } finally { h.cleanup() }
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

section('全局 AGENTS.md 不存在时，新记忆仍可入队和收下')
{
  const h = makeHost(mod, { config: { agentWrites: 'review', duplicateCheck: false } })
  try {
    const result = await h.tool('memory_remember', { slug: 'without-agents', title: 'Without agents', body: 'x', type: 'feedback', source: 'agent', scope: 'global', load: 'always' })
    check('缺指令文件不影响按需入队', result.pending === true && result.load === 'on-demand' && result.loadIgnored === true && !existsSync(h.agentsFile), JSON.stringify(result))
    const accepted = await mod.acceptPending(h.memoryDir, result.id)
    check('收下只写跨项目库，不创建 AGENTS.md', accepted.ok && mdFiles(h.globalDir).includes('without-agents.md') && !existsSync(h.agentsFile), JSON.stringify(accepted))
  } finally {
    h.cleanup()
  }
}

section('source: agent —— 默认进待确认；agentWrites: direct 时写记忆库')
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
    const always = await direct.tool('memory_remember', { slug: 'agent-always', title: '模型的全局常驻规则', body: 'x', type: 'feedback', source: 'agent', scope: 'global', load: 'always', newChapter: true })
    check('agentWrites: direct + 旧 always → 全局记忆库，不写 AGENTS.md', !always.pending && always.scope === 'global' && always.loadIgnored === true && mdFiles(direct.globalDir).includes(always.id + '.md') && direct.read(direct.agentsFile) === AGENTS, JSON.stringify(always))
    check('兼容提示说明 AGENTS.md 由用户写', always.text.endsWith(mod.LOAD_IGNORED_TEXT), always.text)
  } finally {
    direct.cleanup()
  }
}

section('user / feedback + global 按来源写跨项目库，不再强制常驻')
{
  for (const type of ['user', 'feedback']) {
    const h = host()
    try {
      const base = { title: '回答先给结论', body: '回答先给结论，再给理由。', type, scope: 'global' }
      h.state.events.push(userEvent('以后回答先给结论，再给理由。'))
      const saved = await h.tool('memory_remember', { ...base, slug: type + '-saved', source: 'user', evidence: '以后回答先给结论，再给理由。' })
      check(type + ' + global + 核实原话 → 直写跨项目库', !saved.pending && saved.scope === 'global' && mdFiles(h.globalDir).includes(saved.id + '.md'), JSON.stringify(saved))
      check('没传 load 不返回 loadIgnored，也不加兼容提示', !('loadIgnored' in saved) && !saved.text.includes(mod.LOAD_IGNORED_TEXT))
      const agent = await h.tool('memory_remember', { ...base, slug: type + '-agent', source: 'agent' })
      check(type + ' + global + agent → 按需草稿', agent.pending === true && agent.reason === 'agent-review' && agent.load === 'on-demand', JSON.stringify(agent))
      const unknown = await h.tool('memory_remember', { ...base, slug: type + '-unknown', source: 'user', evidence: '用户没说过的话' })
      check(type + ' + global + 未核实原话 → 按需草稿', unknown.reason === 'evidence-not-found' && unknown.load === 'on-demand', JSON.stringify(unknown))
      check('所有新草稿都是 on-demand，收下后仍不写 AGENTS.md', mod.listPending(h.memoryDir).every(d => d.meta.load === 'on-demand'))
      await mod.acceptPending(h.memoryDir, agent.id)
      check('收下写跨项目库，AGENTS.md 没动', mdFiles(h.globalDir).includes(type + '-agent.md') && h.read(h.agentsFile) === AGENTS)
    } finally { h.cleanup() }
  }
}

section('任意非空旧 load 都忽略；空值不产生提示，返回值符合 schema')
{
  const h = host({ agentWrites: 'direct' })
  try {
    check('输入 schema 没有 load；输出 schema 的 loadIgnored 是布尔', !('load' in h.tools.get('memory_remember').parameters.properties) && h.tools.get('memory_remember').output.schema.properties.loadIgnored?.type === 'boolean')
    for (const [i, load] of ['always', 'on-demand', 'sometimes', 42, false, {}, [], NaN, Infinity, undefined, null, '', '  '].entries()) {
      const ignored = i < 9
      const result = await h.tool('memory_remember', { slug: 'compat-' + i, title: 'Compatibility ' + i, body: '固定在 abc1234 这个提交。', type: 'feedback', source: 'agent', scope: 'global', load, chapter: 999, newChapter: true })
      check('旧 load #' + i + ' 正常保存，不受章节参数影响', !result.pending && mdFiles(h.globalDir).includes(result.id + '.md'), JSON.stringify(result))
      check('兼容标志与非空值一致 #' + i, ignored ? result.loadIgnored === true && result.text.endsWith(mod.LOAD_IGNORED_TEXT) : !('loadIgnored' in result) && !result.text.includes(mod.LOAD_IGNORED_TEXT), result.text)
      check('lossless JSON 与 output schema #' + i, schemaProblems(h.tools.get('memory_remember').output.schema, result, { strict: true }).length === 0)
    }
    const review = host()
    try {
      const result = await review.tool('memory_remember', { slug: 'compat-review', title: 'Review', body: 'x', type: 'feedback', source: 'agent', scope: 'project', load: 'always' })
      check('旧 always + agent 默认按需入队且有提示', result.pending === true && result.load === 'on-demand' && result.reason === 'agent-review' && result.loadIgnored === true && result.text.endsWith(mod.LOAD_IGNORED_TEXT), JSON.stringify(result))
      check('草稿不带章节字段', mod.listPending(review.memoryDir).every(d => d.meta.load === 'on-demand' && d.meta.chapter === undefined && d.meta.newChapter === undefined))
      await mod.acceptPending(review.memoryDir, result.id)
      check('项目草稿收下仍只写项目库', mdFiles(review.memoryDir).includes('compat-review.md') && review.read(review.agentsFile) === AGENTS)
    } finally { review.cleanup() }
  } finally { h.cleanup() }
}

section('自动抽取忽略候选里的 load，全部生成按需草稿')
{
  const ex = host({ extractMaxPerTurn: 5 })
  try {
    const candidates = [
      { slug: 'ex-feedback', title: '回答先给结论', body: '回答时先给结论，再给理由。', type: 'feedback', scope: 'global', load: 'always', source: 'agent' },
      { slug: 'ex-user', title: '用户是后端工程师', body: '用户主要写 Java 后端，前端经验少。', type: 'user', scope: 'global', load: 'always', source: 'user', evidence: '用户主要写 Java 后端，前端经验少。' },
      { slug: 'ex-pitfall', title: 'Windows rename EPERM', body: '杀毒软件占着文件时 rename 会报 EPERM，稍等重试。', type: 'pitfall', scope: 'global', load: 'invalid', source: 'agent' },
      { slug: 'ex-project', title: '项目截止日期', body: '交付日期是十一月底。', type: 'project', scope: 'project', load: 'always', source: 'agent' },
    ]
    const session = { snapshotEvents: () => [userEvent('用户主要写 Java 后端，前端经验少。' + '随便说点什么'.repeat(40))], requestContext: () => ({ provider: 'p', model: 'm' }) }
    const llm = { stream: () => (async function* () { yield { type: 'text-delta', text: JSON.stringify(candidates) } })() }
    const ctx = { get: key => key === 'llm' ? llm : undefined, sessions: { get: () => session } }
    const result = await mod.extractFromTurn(ctx, { id: 'x' }, ex.memoryDir, { manual: true, globalDir: ex.globalDir })
    const drafts = mod.listPending(ex.memoryDir)
    check('四条候选全部按需入队，两个库和 AGENTS.md 未变', result.queued === 4 && drafts.length === 4 && drafts.every(d => d.meta.load === 'on-demand') && mdFiles(ex.memoryDir).length === 0 && mdFiles(ex.globalDir).length === 0 && ex.read(ex.agentsFile) === AGENTS, JSON.stringify(result))
    check('抽取核实的全局用户原话也只是按需草稿', drafts.some(d => d.meta.slug === 'ex-user' && d.meta.evidenceVerified === 'true' && d.meta.load === 'on-demand'))
    for (const draft of drafts) {
      const accepted = await mod.acceptPending(ex.memoryDir, draft.id)
      check('收下抽取草稿 ' + draft.meta.slug + ' → 记忆库', accepted.ok && ex.read(ex.agentsFile) === AGENTS, JSON.stringify(accepted))
    }
    check('抽取提示不再声明 load', !mod.EXTRACTION_SYSTEM.includes('"load":') && !mod.EXTRACTION_SYSTEM.includes('load: '))
  } finally { ex.cleanup() }
}

section('常驻草稿取代按需库里的旧条：收下时先写章节、写成功后归档删除旧条（第十一轮）')
{
  // 升级前遗留的常驻草稿仍须支持取代旧条；新调用不会再生成这种草稿。
  const API = '/api/dsh-workspace-memory'
  const oldPref = (h, dir = h.globalDir, scope = 'global') =>
    mod.writeMemory(dir, { slug: 'old-pref', title: '旧的回答偏好', description: '回答先讲背景', body: '回答先讲背景。', type: 'feedback', scope })
  const call = (h, extra = {}) =>
    legacyAlwaysDraft(mod, h, { slug: 'answer-first', title: '回答先给结论', body: '回答先给结论，再给理由。', type: 'feedback', source: 'agent', scope: 'global', load: 'always', supersedes: 'old-pref', supersedesScope: 'global', newChapter: true, ...extra })
  const inGlobal = (h) => mod.listMemories(h.globalDir).map((m) => m.id)

  const h = host()
  try {
    oldPref(h)
    const res = await call(h)
    check('历史常驻草稿保留在待确认', res.pending === true && mod.listPending(h.memoryDir)[0]?.meta.load === 'always', JSON.stringify(res))
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
    const res = await call(cross, { supersedesScope: 'project' })
    check('旧条在项目库 → 历史草稿保留 supersedesScope: project', res.pending === true && mod.listPending(cross.memoryDir)[0]?.meta.supersedesScope === 'project')
    const accepted = await mod.acceptPending(cross.memoryDir, res.id, { globalDir: cross.globalDir })
    check('  …收下后从项目库删掉', accepted.ok === true && accepted.replacedScope === 'project' && mod.listMemories(cross.memoryDir).length === 0, JSON.stringify(accepted))

    const notFound = await cross.tool('memory_remember', { title: 'Replace', body: 'x', type: 'feedback', source: 'agent', scope: 'global', slug: 'nf', supersedes: 'nothing-like-this' })
    check('解析不到 → supersedes-not-found，不入队（不静默忽略）', notFound.reason === 'supersedes-not-found' && mod.listPending(cross.memoryDir).length === 0, JSON.stringify(notFound))
    mod.writeMemory(cross.globalDir, { slug: 'pref-a', title: 'A', body: 'a', type: 'feedback', scope: 'global' })
    mod.writeMemory(cross.globalDir, { slug: 'pref-b', title: 'B', body: 'b', type: 'feedback', scope: 'global' })
    const ambiguous = await cross.tool('memory_remember', { title: 'Replace', body: 'x', type: 'feedback', source: 'agent', scope: 'global', slug: 'amb', supersedes: 'pref-' })
    check('目标库前缀多条 → supersedes-ambiguous，不入队', ambiguous.reason === 'supersedes-ambiguous' && ambiguous.candidates?.length === 2 && mod.listPending(cross.memoryDir).length === 0, JSON.stringify(ambiguous))
    mod.writeMemory(cross.memoryDir, { slug: 'proj-only-pref', title: 'P', body: 'p', type: 'feedback' })
    const prefixOther = await cross.tool('memory_remember', { title: 'Replace', body: 'x', type: 'feedback', source: 'agent', scope: 'global', slug: 'po', supersedes: 'proj-only' })
    check('只在另一个库前缀命中 → supersedes-ambiguous（跨库只认精确 id）', prefixOther.reason === 'supersedes-ambiguous' && prefixOther.candidates?.[0]?.scope === 'project', JSON.stringify(prefixOther))
  } finally {
    cross.cleanup()
  }

  const intents = host()
  try {
    oldPref(intents)
    const withOld = await call(intents)
    const without = await intents.tool('memory_remember', { slug: 'answer-first', title: '回答先给结论', body: '回答先给结论。', type: 'feedback', source: 'agent', scope: 'global', load: 'always' })
    check('draftIntent：同 slug，一条取代旧条、一条不取代 → 不互相覆盖，两条都在', without.pending === true && !without.replacedDraft && without.sameSlugDrafts?.includes(withOld.id) && mod.listPending(intents.memoryDir).length === 2, JSON.stringify(without))
    const again = await intents.tool('memory_remember', { slug: 'answer-first', title: '回答先给结论', body: '回答先给结论，再给理由。', type: 'feedback', source: 'agent', scope: 'global' })
    check('新按需草稿只覆盖同意图的按需草稿，旧常驻草稿保留', again.replacedDraft === without.id && mod.listPending(intents.memoryDir).length === 2 && mod.listPending(intents.memoryDir).some(d => d.id === withOld.id && d.meta.load === 'always'), JSON.stringify(again))
    const cmd = await intents.command('memory', `accept ${withOld.id}`)
    check('/memory accept 的文字说明删除了旧记忆', cmd.kind === 'success' && /删除了旧记忆 old-pref/.test(cmd.text) && !inGlobal(intents).includes('old-pref'), JSON.stringify(cmd))
  } finally {
    intents.cleanup()
  }
}

section('真实文件未被本次测试改动')
check('~/.dsh/AGENTS.md 与 ~/.dsh/global-memory 的存在性与哈希不变', guard.unchanged())

summary()
