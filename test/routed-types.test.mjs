/**
 * 归宿判断改用「调用时必须归类」（设计说明 §13）。
 *
 * 三版提示词在代理模型上，「用户没明说去处」的归宿场景始终不稳；模型判错时自己在正文里写着「所有 agent 都必须遵守」，
 * 然后仍存成 type: project 的记忆——它知道答案，只是调用时没被要求表态。所以 memory_remember 的 type 多了三个
 * 「不是记忆」的取值：procedure → skill、repo-rule → 项目 AGENTS.md、docs → README。选了它们工具什么都不保存，
 * 只告诉模型该写到哪、路径、格式、先向用户提议。MEMORY_TYPES 仍是五个：存储、面板、抽取都不认这三类。
 *
 * 全部在临时目录（DSH_HOME 也是临时的）；结束时比对真实文件的哈希。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { makeHost, makeReporter, realFilesGuard, snapshotTree, userEvent } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()
const API = '/api/dsh-workspace-memory'
const AGENTS = '# 全局\n\n## 1. 已有\n\n内容\n'

section('枚举：type 八个取值；ROUTED_TYPES 三个；MEMORY_TYPES 仍是五个')
{
  const h = makeHost(mod)
  try {
    const typeSchema = h.tools.get('memory_remember').parameters.properties.type
    check('type 枚举是五种记忆 + 三种改道', typeSchema.enum.join() === 'user,feedback,project,reference,pitfall,procedure,repo-rule,docs', typeSchema.enum.join())
    check('ROUTED_TYPES = procedure / repo-rule / docs', JSON.stringify(mod.ROUTED_TYPES) === JSON.stringify(['procedure', 'repo-rule', 'docs']))
    // MEMORY_TYPES 不导出；从它的使用处看：面板的类型校验只认五种
    const patch = mod.validateMemoryPatch({ type: 'procedure' })
    check('MEMORY_TYPES 仍是五个：面板校验的允许值只列五种', patch.ok === false && patch.errors.some((e) => /user \/ feedback \/ project \/ reference \/ pitfall$/.test(e)), JSON.stringify(patch.errors))
    check('type 说明就是 TYPE_RULES，且讲了三种不是记忆的取值', typeSchema.description === mod.TYPE_RULES && /Three kinds are not memories/.test(mod.TYPE_RULES))
  } finally {
    h.cleanup()
  }
}

/** 一个带 .git 的工作区：instructionsRootFor 会认它为项目根。返回宿主与「什么都没变」的快照函数。 */
function repoHost(config = {}) {
  const h = makeHost(mod, { config: { agentWrites: 'direct', duplicateCheck: true, ...config } })
  mkdirSync(path.join(h.workspace, '.git'), { recursive: true })
  h.write(h.agentsFile, AGENTS)
  const snap = () => JSON.stringify(snapshotTree(h.root))
  return { h, snap }
}

section('三种改道：什么都不保存，告诉模型该写到哪')
{
  for (const [type, home, pathParts] of [
    ['procedure', 'skill', [/\.dsh[\\/]skills[\\/]<name>[\\/]SKILL\.md/, /\$DSH_HOME\/skills\/<name>\/SKILL\.md/]],
    ['repo-rule', 'agents', [/AGENTS\.md/, /AGENTS\.local\.md/]],
    ['docs', 'readme', [/README\.md/]],
  ]) {
    const { h, snap } = repoHost()
    try {
      h.state.events.push(userEvent('以后发布都按这几步来'))
      const before = snap()
      // 只给 title / body / type：不给 slug、source、evidence、scope——归类是第一道判断，不能先因为缺它们而拒写
      const r = await h.tool('memory_remember', { title: '发布流程（中文标题、没给 slug）', body: '第一步……第二步……', type })
      check(`${type} → written: false、reason: belongs-elsewhere、home: ${home}`, r.written === false && r.reason === 'belongs-elsewhere' && r.home === home, JSON.stringify(r))
      check('  …库、待确认队列、AGENTS.md、工作区一个文件都没变', snap() === before && mod.listPending(h.memoryDir).length === 0 && h.read(h.agentsFile) === AGENTS)
      check('  …文本给出路径', pathParts.every((re) => re.test(r.text)), r.text)
      check('  …文本以那一句结尾', r.text.endsWith(mod.ROUTED_TELL_TEXT) && /Tell the user now where this belongs/.test(mod.ROUTED_TELL_TEXT), r.text)
      check('  …末句不与「用户已明确要求就直接写」矛盾', /unless they already asked/.test(mod.ROUTED_TELL_TEXT), mod.ROUTED_TELL_TEXT)
      check('  …不说「已生效」「在面板里等」，也不叫它存进记忆', !r.text.includes(mod.ACTIVE_NOW_TEXT) && !/waiting in the memory panel/.test(r.text) && /Do not also save it to memory/.test(r.text), r.text)
      const status = await h.tool('memory_status', {})
      check('  …没有做证据核对（memory_status 仍是 none）', status.evidenceSource === 'none', status.evidenceSource)
    } finally {
      h.cleanup()
    }
  }
}

section('各自的要点')
{
  const { h } = repoHost()
  try {
    const skill = await h.tool('memory_remember', { title: 'Release steps', body: 'x', type: 'procedure' })
    check('procedure：项目级路径在 git 根下的 .dsh/skills', skill.text.includes(path.join(h.workspace, '.dsh', 'skills', '<name>', 'SKILL.md')), skill.text)
    check('  …用户级路径用主目录的显示形式（不泄露绝对路径）', skill.text.includes(`${mod.dshHomeDisplay()}/skills/<name>/SKILL.md`) && !skill.text.includes(mod.dshHome()), skill.text)
    check('  …格式：YAML frontmatter，必填 name（kebab-case、与目录名一致）与 description', /YAML frontmatter/.test(skill.text) && /name \(kebab-case, the same as the directory name\)/.test(skill.text) && /description/.test(skill.text), skill.text)
    check('  …共享文件，先向用户提议；用户已经明确要求时直接创建', /once they agree/.test(skill.text) && /at once if they already asked/.test(skill.text), skill.text)

    const rule = await h.tool('memory_remember', { title: 'No force push', body: 'x', type: 'repo-rule' })
    check('repo-rule：git 根下的 AGENTS.md 路径及其是否存在', rule.text.includes(path.join(h.workspace, 'AGENTS.md')) && /does not exist yet/.test(rule.text), rule.text)
    check('  …提示个人偏好改用 type: "feedback" 或 "user"', /type: "feedback" or "user"/.test(rule.text), rule.text)
    check('  …先征得同意', /once they agree/.test(rule.text))

    h.write(path.join(h.workspace, 'README.md'), '# Project\n')
    const docs = await h.tool('memory_remember', { title: 'Why it is built this way', body: 'x', type: 'docs' })
    check('docs：git 根下 README.md 的路径，且如实说存在', docs.text.includes(path.join(h.workspace, 'README.md')) && /\(it exists\)/.test(docs.text), docs.text)
    check('  …README 没被改', h.read(path.join(h.workspace, 'README.md')) === '# Project\n')
  } finally {
    h.cleanup()
  }
}

section('入参校验仍在归类之前；project + always 的拒写不变')
{
  const { h } = repoHost()
  try {
    const noBody = await h.tool('memory_remember', { title: 'X', body: '  ', type: 'procedure' })
    check('title / body 缺失仍按入参校验拒绝（invalid-argument）', noBody.reason === 'invalid-argument' && noBody.argument === 'body', JSON.stringify(noBody))
    const badScope = await h.tool('memory_remember', { title: 'X', body: 'y', type: 'docs', scope: 'workspace' })
    check('非法 scope 同样先拒（入参校验通过后才归类）', badScope.reason === 'invalid-argument' && badScope.argument === 'scope', JSON.stringify(badScope))
    const always = await h.tool('memory_remember', { slug: 'p-always', title: 'P always', body: 'y', type: 'feedback', source: 'agent', scope: 'project', load: 'always' })
    check('project + always 仍是 belongs-in-project-agents', always.reason === 'belongs-in-project-agents' && always.written === false, JSON.stringify(always))
  } finally {
    h.cleanup()
  }
}

section('面板保存路由仍然拒绝把类型改成这三类')
{
  const h = makeHost(mod)
  try {
    mod.writeMemory(h.memoryDir, { slug: 'keep-type', title: 'Keep type', body: 'x', type: 'feedback' })
    for (const type of mod.ROUTED_TYPES) {
      const r = await h.http(`${API}/save`, { method: 'POST', body: { id: 'keep-type', scope: 'project', patch: { type } } })
      check(`save 改成 ${type} → 400`, r.status === 400 && r.body?.ok === false, `${r.status} ${JSON.stringify(r.body)}`)
    }
    check('  …条目类型没变', mod.listMemories(h.memoryDir)[0].meta.type === 'feedback')
  } finally {
    h.cleanup()
  }
}

section('抽取候选给了这三类：跳过，计入 routed')
{
  const h = makeHost(mod, { config: { enableExtraction: true, dedupeThreshold: 1, extractMaxPerTurn: 5 } })
  try {
    const candidates = [
      { slug: 'release-steps', title: '发布流程', body: '第一步…', type: 'procedure', source: 'agent' },
      { slug: 'no-force', title: '禁止强推', body: '所有人都不许强推。', type: 'repo-rule', source: 'agent' },
      { slug: 'why-design', title: '为什么这样设计', body: '因为……', type: 'docs', source: 'agent' },
      { slug: 'real-memory', title: 'Windows 上 rename 会 EPERM', body: '编辑器占着文件时 rename 会 EPERM。', type: 'pitfall', source: 'agent' },
    ]
    const session = { snapshotEvents: () => [userEvent('随便说点什么'.repeat(40))], requestContext: () => ({ provider: 'p', model: 'm' }) }
    const llm = { stream: () => (async function* () { yield { type: 'text-delta', text: JSON.stringify(candidates) } })() }
    const ctx = { get: (key) => (key === 'llm' ? llm : undefined), sessions: { get: () => session } }
    const r = await mod.extractFromTurn(ctx, { id: 'x' }, h.memoryDir, { manual: true, globalDir: h.globalDir })
    check('三条「不是记忆」的被跳过并计入 routed，真正的记忆照常入队', r.routed === 3 && r.queued === 1 && mod.listPending(h.memoryDir).map((d) => d.meta.slug).join() === 'real-memory', JSON.stringify(r))
    check('  …队列里没有任何一条以 procedure / repo-rule / docs（或回落成 project）存下', mod.listPending(h.memoryDir).every((d) => d.meta.type === 'pitfall'))
  } finally {
    h.cleanup()
  }
}

section('结构守卫：工具说明换了那一句，其余不变')
{
  check('REMEMBER_DESCRIPTION 用 type 表态的那一句（§13.3）', mod.REMEMBER_DESCRIPTION.includes('Say what kind of thing it is with type: memories are saved; for a procedure, a repo-wide rule or project documentation the tool tells you where it belongs instead.'))
  check('  …不再引用系统提示段（the workspace-memory section says how to choose）', !/workspace-memory section/.test(mod.REMEMBER_DESCRIPTION))
  check('  …长度仍 < 1000', mod.REMEMBER_DESCRIPTION.length < 1000, String(mod.REMEMBER_DESCRIPTION.length))
  check('抽取提示词复用新的 TYPE_RULES', mod.EXTRACTION_SYSTEM.includes(mod.TYPE_RULES))
}

section('§13 补丁：改道不能让旧记忆变成过期的——supersedes 指向已有记忆时更新留在原处')
{
  // 代理模型评测里的真实情形：库里有「开发分支从 test 拉」，用户说规则变了；模型带着 supersedes 却选了 repo-rule
  const { h } = repoHost({ agentWrites: 'review' })
  try {
    mod.writeMemory(h.memoryDir, { slug: 'branch-from-test', title: '开发分支从 test 拉', description: '开发分支从 test 拉', body: '新分支从 test 拉。', type: 'feedback', source: 'user', evidence: '从 test 拉' })
    h.state.events.push(userEvent('分支规则变了，现在从 dev 拉，不再从 test 拉'))
    const r = await h.tool('memory_remember', {
      slug: 'branch-from-test', title: '开发分支从 dev 拉', description: '开发分支从 dev 拉，不再从 test 拉',
      body: '新分支从 dev 拉。\nWhy: 用户说分支规则变了。', type: 'repo-rule', source: 'user', evidence: '现在从 dev 拉，不再从 test 拉', supersedes: 'branch-from-test',
    })
    const items = mod.listMemories(h.memoryDir)
    check('没有改道，旧记忆被原地更新：库里只有一条', r.reason !== 'belongs-elsewhere' && r.updated === true && items.length === 1 && items[0].id === 'branch-from-test', JSON.stringify(r))
    check('  …类型是旧记忆的类型（feedback），不是 repo-rule、也没回落成 project', items[0].meta.type === 'feedback', items[0].meta.type)
    check('  …正文是新的', /从 dev 拉/.test(items[0].body) && !/从 test 拉。$/.test(items[0].body), items[0].body)
    check('  …证据核对照常做（核实了，所以直写）', r.evidenceVerified === true && r.pending !== true, JSON.stringify(r))
    check('  …返回值带 keptAsMemory: true', r.keptAsMemory === true, JSON.stringify(r))
    check('  …文本说明：因为更新已有记忆而保留为记忆；若该写进仓库就向用户提议、写好后删掉这条',
      /Kept as a memory because it updates the existing memory branch-from-test/.test(r.text) && /propose writing it there to the user, and delete this memory once that is written/.test(r.text), r.text)
  } finally {
    h.cleanup()
  }

  // supersedes 解析不到：照旧改道，库不变，不报 supersedes-not-found
  for (const [label, wanted, projectSeeds, globalSeeds] of [
    ['不存在', 'no-such-memory', [], []],
    ['前缀有歧义', 'rule', ['rule-a', 'rule-b'], []],
    ['只在另一个库里前缀命中', 'glob', [], ['global-rule']],
  ]) {
    const { h, snap } = repoHost()
    try {
      for (const slug of projectSeeds) mod.writeMemory(h.memoryDir, { slug, title: slug, body: 'x', type: 'project' })
      for (const slug of globalSeeds) mod.writeMemory(h.globalDir, { slug, title: slug, body: 'x', type: 'project', scope: 'global' })
      const before = snap()
      const r = await h.tool('memory_remember', { title: 'X', body: 'y', type: 'repo-rule', supersedes: wanted })
      check(`supersedes ${label} → 照旧改道（belongs-elsewhere），不报 supersedes-not-found`, r.reason === 'belongs-elsewhere' && r.home === 'agents' && r.keptAsMemory === undefined, JSON.stringify(r))
      check('  …库不变', snap() === before)
    } finally {
      h.cleanup()
    }
  }

  // 被取代的记忆在另一个库（精确 id）：同样按更新处理（跨库取代）
  const x = repoHost()
  try {
    mod.writeMemory(x.h.globalDir, { slug: 'release-steps', title: '发布步骤', body: '旧步骤', type: 'reference', scope: 'global' })
    const r = await x.h.tool('memory_remember', { slug: 'release-steps', title: '发布步骤（新）', body: '新步骤', type: 'procedure', source: 'agent', supersedes: 'release-steps' })
    const moved = mod.listMemories(x.h.memoryDir)
    check('另一个库的精确 id → 按更新处理：搬进目标库并原地更新，类型是旧记忆的类型', r.keptAsMemory === true && r.replacedFrom === 'global' && moved.length === 1 && moved[0].meta.type === 'reference' && moved[0].body === '新步骤' && mod.listMemories(x.h.globalDir).length === 0, JSON.stringify(r))
  } finally {
    x.h.cleanup()
  }

  // 被取代的记忆没有合法的 type（手写文件）：按 project 处理
  const y = repoHost()
  try {
    y.h.write(path.join(y.h.memoryDir, 'hand-written.md'), '---\ntitle: 手写的\ndescription: d\ntype: whatever\n---\n\n旧正文\n')
    const r = await y.h.tool('memory_remember', { slug: 'hand-written', title: '手写的（新）', body: '新正文', type: 'docs', source: 'agent', supersedes: 'hand-written' })
    const item = mod.listMemories(y.h.memoryDir).find((m) => m.id === 'hand-written')
    check('被取代的记忆 type 不合法 → 按 project 处理', r.keptAsMemory === true && item?.meta.type === 'project' && item?.body === '新正文', JSON.stringify(r))
  } finally {
    y.h.cleanup()
  }

  // 走到待确认（agent 来源 + review）时同样带说明与字段；常驻被固定为按需，不会被引去 AGENTS.md
  const z = repoHost({ agentWrites: 'review' })
  try {
    mod.writeMemory(z.h.memoryDir, { slug: 'no-force', title: '不要强推', body: '旧', type: 'feedback' })
    const r = await z.h.tool('memory_remember', { slug: 'no-force', title: '不要强推（新）', body: '新', type: 'repo-rule', source: 'agent', scope: 'global', load: 'always', supersedes: 'no-force' })
    check('进待确认时：keptAsMemory、说明照带，加载方式固定为 on-demand（不进 AGENTS.md）', r.pending === true && r.keptAsMemory === true && r.load === 'on-demand' && /Kept as a memory because it updates the existing memory no-force/.test(r.text) && z.h.read(z.h.agentsFile) === AGENTS, JSON.stringify(r))
  } finally {
    z.h.cleanup()
  }
}

section('MEMORY_SECTION：自己验证过的坑不用先问（补的那一句）')
{
  check('含「你自己踩到并验证过的坑不用先问，直接存」', mod.MEMORY_SECTION.includes('你自己踩到并验证过的坑不用先问，直接存：它会进待确认，由用户决定收不收。'))
  check('五个关键词仍在', ['skill', 'AGENTS.md', 'AGENTS.local.md', 'README', 'memory_remember'].every((word) => mod.MEMORY_SECTION.includes(word)))
}

section('真实文件未被本次测试改动')
check('真实 AGENTS.md 与全局按需库的存在性与哈希不变', guard.unchanged())

summary()
