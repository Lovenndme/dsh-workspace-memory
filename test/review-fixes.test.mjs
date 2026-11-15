/**
 * 第五轮：独立代码审查发现的问题，每条一组反例（设计说明 §10）。括号里的 v1–v7 是独立审查的复现脚本编号。
 *
 *   F1 跨库取代只认精确 id（v7：supersedes: "npm" 搬走了全局库里不相关的 npm-publish-cadence）
 *   F2 常驻一律进待确认；证据要与标题/摘要有字面交集（evidenceRelates）；只认明确标记为用户的消息（v3 T1、T6）
 *   F3 待确认的「更新第 N 章」草稿保留章号与章标题，收下时核对（v5：收下后 AGENTS.md 出现两份）
 *   F4 直写成功后清掉同 slug、同去向的旧草稿（v4：之后收下旧草稿多出 xxx-2）
 *   F6 拒绝危险的库目录配置（v6：globalMemoryDir = 主目录时 AGENTS.md 被当成记忆删掉）
 *   F7 移库失败不留两份；换库成功而补丁失败时响应带条目现在所在的库（v3 T3、T4）
 *   F8 近似匹配设上限（v1、v2：极端输入同步算数秒）
 *   F9 草稿覆盖要看去向（v3 T2：常驻 + 取代 X 的草稿被同 slug 的普通草稿整个盖掉）
 *   F11 抽取去重比对全局按需库；核对状态按 agent 记；预取查询只用人写的文本
 * F5（测试隔离）由每个测试文件第一行的 isolate-home.mjs 落实；这里只断言它确实生效了。
 *
 * 全部在临时目录（DSH_HOME 也是临时的）；结束时比对真实文件的哈希。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT, injectedEvent, makeHost, makeReporter, realFilesGuard, userEvent } from './fake-host.mjs'
import { ORIGINAL_DSH_HOME, TEST_DSH_HOME } from './isolate-home.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()
const API = '/api/dsh-workspace-memory'
const ids = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').map((n) => n.slice(0, -3)).sort() : [])

section('F5 测试隔离：DSH_HOME 指向本文件独占的临时目录')
{
  check('DSH_HOME 是临时目录，不是真实主目录', process.env.DSH_HOME === TEST_DSH_HOME && TEST_DSH_HOME.startsWith(os.tmpdir()) && TEST_DSH_HOME !== ORIGINAL_DSH_HOME, `${TEST_DSH_HOME}`)
  mod.configure(undefined)
  check('不传 globalMemoryDir / agentsFile 时，默认路径都落在临时主目录下',
    mod.globalMemoryDirOf().startsWith(TEST_DSH_HOME) && mod.dshHome() === path.resolve(TEST_DSH_HOME), mod.globalMemoryDirOf())
}

section('F1 跨库 supersedes 只认精确 id；前缀命中不执行')
{
  const h = makeHost(mod, { config: { agentWrites: 'review', duplicateCheck: false } })
  try {
    mod.writeMemory(h.globalDir, { slug: 'npm-publish-cadence', title: 'npm 发布节奏', body: '每个项目发布前都先打 tag。', type: 'feedback', scope: 'global' })
    h.state.events.push(userEvent('这个项目里 npm 脚本统一用 pnpm 跑'))
    const res = await h.tool('memory_remember', {
      slug: 'use-pnpm-scripts', title: 'npm 脚本统一用 pnpm 跑', body: 'Run npm scripts with pnpm in this repo.', type: 'project',
      source: 'user', evidence: 'npm 脚本统一用 pnpm 跑', supersedes: 'npm',
    })
    check('另一个库里只有前缀命中 → supersedes-ambiguous，什么都不写', res.reason === 'supersedes-ambiguous' && res.written === false && ids(h.memoryDir).length === 0, JSON.stringify(res))
    check('  …候选带所在的库', res.candidates?.length === 1 && res.candidates[0].id === 'npm-publish-cadence' && res.candidates[0].scope === 'global', JSON.stringify(res.candidates))
    check('  …全局库里那条原样还在', ids(h.globalDir).join() === 'npm-publish-cadence')
    check('  …文本说明跨库要精确 id', /exact id/.test(res.text), res.text)

    mod.writeMemory(h.globalDir, { slug: 'npm-other', title: 'npm 其它', body: 'x', type: 'feedback', scope: 'global' })
    const many = await h.tool('memory_remember', { slug: 'p2', title: 'P2', body: 'x', type: 'project', source: 'agent', supersedes: 'npm' })
    check('另一个库里多条前缀命中 → 同样拒绝并列出', many.reason === 'supersedes-ambiguous' && many.candidates.length === 2 && many.candidates.every((c) => c.scope === 'global'), JSON.stringify(many))

    const exact = await h.tool('memory_remember', { slug: 'p3', title: 'P3', body: 'x', type: 'project', source: 'agent', supersedes: 'npm-other' })
    check('精确 id 仍可跨库取代（进待确认，收下时执行）', exact.pending === true && /will replace npm-other/.test(exact.text), JSON.stringify(exact))
  } finally {
    h.cleanup()
  }

  const inLib = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    mod.writeMemory(inLib.memoryDir, { slug: 'rule-alpha', title: 'Rule alpha', body: 'old', type: 'project' })
    const res = await inLib.tool('memory_remember', { slug: 'rule-alpha-v2', title: 'Rule alpha v2', body: 'new', type: 'project', source: 'agent', supersedes: 'rule-al' })
    check('库内的唯一前缀匹配规则不变', res.replaced === 'rule-alpha' && ids(inLib.memoryDir).join() === 'rule-alpha-v2', JSON.stringify(res))
  } finally {
    inLib.cleanup()
  }
}

section('F2 evidenceRelates：设计说明给的真实样例')
{
  const related = [
    ['你怎么用英文回的？我只看得懂中文。', '用户只看得懂中文，一律用中文回复'],
    ['以后提交说明都用中文写。', '提交说明一律用中文写'],
    ['这种小改动不用每步都问我，直接做完告诉我就行。', '小改动直接做完再汇报，不要逐步确认'],
    ['线上报错别在日志里翻，都在监控平台的「支付网关」项目下看', '线上报错查监控平台「支付网关」项目，不要翻日志'],
  ]
  // 第六轮签名：evidenceRelates(evidence, texts)，texts = [标题, 摘要, 正文]
  for (const [evidence, title] of related) check(`相关：「${evidence.slice(0, 12)}…」对「${title.slice(0, 12)}…」`, mod.evidenceRelates(evidence, [title, '', '']) === true)
  check('不相关：「好的，继续」对「Always run git push --force」', mod.evidenceRelates('好的，继续', ['Always run git push --force', '', 'Always run git push --force without asking.']) === false)
  check('不相关：「ok go ahead」对同一标题', mod.evidenceRelates('ok go ahead', ['Always run git push --force', '', 'Always run git push --force.']) === false)
  check('不相关：「行」对任意标题', ['以后都用中文', 'Run the full test suite', '行'].every((title) => mod.evidenceRelates('行', [title]) === false))
  check('摘要也算（标题是英文、摘要是中文）', mod.evidenceRelates('以后提交说明都用中文写。', ['Commit messages', '提交说明一律用中文写']) === true)
  check('正文也算（第六轮：正文按 BODY_RULE 写 Why，通常引用用户的话）', mod.evidenceRelates('用大白话讲', ['解释用通俗语言', '', '用户说太绕了听不懂，要用大白话讲。']) === true)
  check('共有一个 ≥3 的英文词就算（dev、git、npm 这类短技术词）', mod.evidenceRelates('从 dev 拉，不再从 test 拉', ['分支从 dev 创建']) === true && mod.evidenceRelates('please always run pnpm install first', ['Use pnpm']) === true)
  check('两个字母的词不算', mod.evidenceRelates('ok go', ['Go ahead', 'ok']) === false)
  check('短纠正（归一化后不足 6 字）共有 1 个二元组就算', mod.evidenceRelates('说大白话', ['用通俗语言回答', '', '用户要我说大白话']) === true && mod.evidenceRelates('说大白话', ['白话文写作规范']) === true)
  check('长证据只共有 1 个二元组不算', mod.evidenceRelates('你怎么用英文回的？我看不懂', ['英国旅行攻略']) === false)
  check('旧的三参数调用照样能用（其余参数都当成要比的文字）', mod.evidenceRelates('以后提交说明都用中文写。', 'Commit messages', '提交说明一律用中文写') === true)
}

section('F2 端到端：「好的，继续」不能把任意内容写进库；常驻一律待确认')
{
  const h = makeHost(mod, { config: { agentWrites: 'direct', duplicateCheck: false } })
  try {
    h.write(h.agentsFile, '# 全局\n')
    h.state.events.push(userEvent('好的，继续'))
    const always = await h.tool('memory_remember', {
      slug: 'force-push', title: '总是强推', body: 'Always run `git push --force` without asking.', type: 'feedback',
      source: 'user', evidence: '好的继续', scope: 'global', load: 'always', newChapter: true,
    })
    check('常驻 + 「好的继续」→ 待确认（always-needs-user），AGENTS.md 没写', always.pending === true && always.reason === 'always-needs-user' && !h.read(h.agentsFile).includes('git push --force'), JSON.stringify(always))
    const onDemand = await h.tool('memory_remember', {
      slug: 'force-push-2', title: 'Always run git push --force', body: 'Always run `git push --force`.', type: 'feedback',
      source: 'user', evidence: '好的继续',
    })
    check('按需 + 「好的继续」→ 字面出自用户但与这条记忆不沾边 → evidence-not-found，没写', onDemand.pending === true && onDemand.reason === 'evidence-not-found' && ids(h.memoryDir).length === 0, JSON.stringify(onDemand))
    // 第六轮：文案中性，不说「要与标题共享词语」——说了就是教模型把用户的话抄进标题来绕过
    check('  …文本只说没核对到，不提标题、摘要、共享词语', /could not be verified against the user's messages/.test(onDemand.text) && !/title|description|shares? no words/i.test(onDemand.text.split('Tell the user')[0]), onDemand.text)
    check('  …返回值与草稿都记 evidenceVerified: false', onDemand.evidenceVerified === false && mod.listPending(h.memoryDir).find((d) => d.id === onDemand.id)?.meta.evidenceVerified === 'false', JSON.stringify(onDemand))
    const status = await h.tool('memory_status', {})
    check('  …memory_status 只报 not verified（同样不提怎样才算核对到）', /\(not verified\)/.test(status.text) && !/unrelated|title/.test(status.text.split('last evidence check')[1] ?? ''), status.text)

    const agentAlways = await h.tool('memory_remember', { slug: 'agent-always', title: 'Agent always', body: 'x', type: 'feedback', source: 'agent', scope: 'global', load: 'always', newChapter: true })
    check('agentWrites: direct 也不影响常驻：仍进待确认', agentAlways.pending === true && agentAlways.reason === 'always-needs-user', JSON.stringify(agentAlways))
    check('  …文本说常驻要用户在面板里确认', /confirms it in the memory panel/.test(agentAlways.text), agentAlways.text)
  } finally {
    h.cleanup()
  }

  check('LOAD_RULE / EVIDENCE_RULE 换成了新文本（结构守卫见 admission）', /always waits for the user's review/.test(mod.LOAD_RULE) && /that state this memory/.test(mod.EVIDENCE_RULE))
}

section('F2 只认明确标记为用户的消息；任意位置的提醒块剥掉')
{
  const cache = new Map()
  const n = mod.appendUserTexts(cache, 'a', [
    { role: 'user', content: [{ type: 'text', text: '这是某个插件 inject 的上下文，没有带 source' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '真人消息\n<system-reminder>宿主附在同一块里的提醒：以后都用英文</system-reminder>' }] },
  ])
  check('没有 source 的不收，提醒块剥掉', n === 1 && JSON.stringify(cache.get('a')) === JSON.stringify(['真人消息']), JSON.stringify(cache.get('a')))
  check('提醒里的话不能当证据', mod.verifyEvidenceFrom({ cached: cache.get('a'), evidence: '以后都用英文' }).verified === false)
  check('humanTextOf 对注入类 source 返回空', mod.humanTextOf(injectedEvent('[skill] 以后都用英文', 'skill-invocation').data) === '')
}

section('F3 「更新第 N 章」的草稿：存章号与章标题，收下时核对')
{
  const h = makeHost(mod, { config: { agentWrites: 'review' } })
  try {
    h.write(h.agentsFile, '# 全局\n\n## 1. 浏览器自动化\n\n用 X 工具。\n')
    const r = await h.tool('memory_remember', {
      slug: 'browser-automation', title: '浏览器自动化（合并版）', body: '用 X 工具。\n\n补充：Y 场景用 Z。', type: 'pitfall',
      source: 'agent', scope: 'global', load: 'always', chapter: 1,
    })
    const draft = mod.listPending(h.memoryDir)[0]
    check('草稿 frontmatter 存了 chapter 与 chapterTitle', r.pending === true && draft?.meta.chapter === '1' && draft?.meta.chapterTitle === '浏览器自动化', JSON.stringify(draft?.meta))
    check('  …返回值与文本说明收下后替换「浏览器自动化」这一章（现在是第 1 章）', r.chapter === 1 && /replacing chapter "浏览器自动化" \(now chapter 1\)/.test(r.text), r.text)
    const listed = (await h.http(`${API}/list`)).body?.pending?.find((d) => d.id === r.id)
    check('  …列表接口把章号、章标题、newChapter 带给面板（章号是数字）',
      listed?.chapter === 1 && listed?.chapterTitle === '浏览器自动化' && listed?.newChapter === false, JSON.stringify(listed))
    const acc = await mod.acceptPending(h.memoryDir, r.id, { globalDir: h.globalDir })
    const text = h.read(h.agentsFile)
    check('收下 → 覆盖第 1 章，不追加第二份', acc.ok === true && acc.action === 'updated' && [...text.matchAll(/^## \d+\./gm)].length === 1 && text.includes('## 1. 浏览器自动化（合并版）') && text.includes('补充：Y 场景用 Z。'), text)
  } finally {
    h.cleanup()
  }

  const drift = makeHost(mod, { config: { agentWrites: 'review' } })
  try {
    drift.write(drift.agentsFile, '# 全局\n\n## 1. 浏览器自动化\n\n用 X 工具。\n')
    const r = await drift.tool('memory_remember', { slug: 'browser-v2', title: '浏览器自动化 v2', body: '新正文。', type: 'pitfall', source: 'agent', scope: 'global', load: 'always', chapter: 1 })
    // 第六轮：按章标题定位。草稿入队之后有人在前面插了一章，「浏览器自动化」变成了第 2 章——仍然能收下，更新的是它
    const shifted = '# 全局\n\n## 1. 新插进来的一章\n\n别的内容。\n\n## 2. 浏览器自动化\n\n用 X 工具。\n'
    drift.write(drift.agentsFile, shifted)
    const r2 = await drift.tool('memory_remember', { slug: 'browser-v3', title: '浏览器自动化 v3', body: '再新的正文。', type: 'pitfall', source: 'agent', scope: 'global', load: 'always', chapter: 2 })
    const acc = await mod.acceptPending(drift.memoryDir, r.id, { globalDir: drift.globalDir })
    const after = drift.read(drift.agentsFile)
    check('编号漂移（前面插了一章）→ 按标题找到，更新现在的第 2 章', acc.ok === true && acc.action === 'updated' && acc.agents?.chapter === 2 &&
      after.includes('## 1. 新插进来的一章') && after.includes('## 2. 浏览器自动化 v2') && after.includes('新正文。') && [...after.matchAll(/^## \d+\./gm)].length === 2, after)

    // 那一章已经被上面那条草稿改了名（「浏览器自动化」→「浏览器自动化 v2」）：再收下 r2 → 找不到 → section-moved，不写
    const before = drift.read(drift.agentsFile)
    const renamed = await mod.acceptPending(drift.memoryDir, r2.id, { globalDir: drift.globalDir })
    check('那一章被改名 → section-moved，不写', renamed.ok === false && renamed.reason === 'section-moved' && drift.read(drift.agentsFile) === before, JSON.stringify(renamed))
    check('  …草稿仍在队列里', mod.listPending(drift.memoryDir).some((d) => d.id === r2.id))
    const http = await drift.http(`${API}/accept`, { method: 'POST', body: { id: r2.id } })
    check('  …HTTP accept → 409 + reason section-moved', http.status === 409 && http.body?.reason === 'section-moved', `${http.status} ${JSON.stringify(http.body)}`)

    // 有两个同名章：不知道该更新哪一个 → section-moved
    const twins = '# 全局\n\n## 1. 新插进来的一章\n\n甲\n\n## 2. 新插进来的一章\n\n乙\n'
    drift.write(drift.agentsFile, twins)
    const r3 = await drift.tool('memory_remember', { slug: 'twin-a', title: '新插进来的一章（改）', body: '丙', type: 'pitfall', source: 'agent', scope: 'global', load: 'always', chapter: 1 })
    const dup = await mod.acceptPending(drift.memoryDir, r3.id, { globalDir: drift.globalDir })
    check('有两个同名章 → section-moved，不写', dup.ok === false && dup.reason === 'section-moved' && drift.read(drift.agentsFile) === twins, JSON.stringify(dup))

    // 章被删掉同样是 section-moved
    drift.write(drift.agentsFile, '# 全局\n')
    const gone = await mod.acceptPending(drift.memoryDir, r2.id, { globalDir: drift.globalDir })
    check('那一章被删了 → 同样 section-moved，不写', gone.ok === false && gone.reason === 'section-moved' && drift.read(drift.agentsFile) === '# 全局\n', JSON.stringify(gone))

    // 只有章号、没有章标题的手写草稿：无从定位
    mod.writePending(drift.memoryDir, { id: 'dr_hand', title: '手写的', body: 'x', scope: 'global', load: 'always', chapter: 1 })
    drift.write(drift.agentsFile, '# 全局\n\n## 1. 某章\n\n内容\n')
    const hand = await mod.acceptPending(drift.memoryDir, 'dr_hand', { globalDir: drift.globalDir })
    check('只有章号没有章标题的手写草稿 → section-moved，不盲写', hand.ok === false && hand.reason === 'section-moved' && drift.read(drift.agentsFile).includes('## 1. 某章'), JSON.stringify(hand))
  } finally {
    drift.cleanup()
  }

  const fresh = makeHost(mod, { config: { agentWrites: 'review' } })
  try {
    fresh.write(fresh.agentsFile, '# 全局\n\n## 1. 已有\n\n内容\n')
    const r = await fresh.tool('memory_remember', { slug: 'brand-new', title: '全新主题', body: '正文。', type: 'feedback', source: 'agent', scope: 'global', load: 'always', newChapter: true })
    check('newChapter 草稿存 newChapter: true，不存章号', mod.listPending(fresh.memoryDir)[0]?.meta.newChapter === 'true' && mod.listPending(fresh.memoryDir)[0]?.meta.chapter === undefined)
    const listed = (await fresh.http(`${API}/list`)).body?.pending?.find((d) => d.id === r.id)
    check('  …列表接口给面板 newChapter: true、没有 chapter / chapterTitle',
      listed?.newChapter === true && !('chapter' in listed) && !('chapterTitle' in listed), JSON.stringify(listed))
    const acc = await mod.acceptPending(fresh.memoryDir, r.id, { globalDir: fresh.globalDir })
    check('  …收下按新章追加', acc.ok === true && acc.action === 'added' && fresh.read(fresh.agentsFile).includes('## 2. 全新主题'), JSON.stringify(acc))
    mod.writePending(fresh.memoryDir, { id: 'dr_legacy', title: '旧草稿', body: '旧正文。', scope: 'global' })
    const legacy = await mod.acceptPending(fresh.memoryDir, 'dr_legacy', { globalDir: fresh.globalDir })
    check('旧草稿（没有这些字段）行为不变：按新章追加', legacy.ok === true && legacy.action === 'added' && fresh.read(fresh.agentsFile).includes('旧草稿'), JSON.stringify(legacy))
  } finally {
    fresh.cleanup()
  }
}

section('F4 直写成功后清掉同 slug、同去向的旧草稿')
{
  const h = makeHost(mod, { config: { agentWrites: 'review', duplicateCheck: true } })
  try {
    h.state.events.push(userEvent('提交信息用中文写，别再用英文了'))
    const base = { slug: 'commit-msg-chinese', title: 'Commit messages in Chinese', description: '提交信息用中文写', body: 'Write commit messages in Chinese.', type: 'feedback', source: 'user' }
    const first = await h.tool('memory_remember', { ...base, evidence: '提交信息必须用中文写' })
    check('第一次抄错 → 待确认', first.pending === true && first.reason === 'evidence-not-found', JSON.stringify(first))
    // 同 slug 但去向不同的草稿：不该被清。§15.1 起 feedback + global 一律进全局 AGENTS.md 常驻，所以另一个去向是常驻新章
    h.write(h.agentsFile, '# 全局\n\n## 1. 已有的一章\n\n内容\n')
    const otherTarget = await h.tool('memory_remember', { ...base, scope: 'global', newChapter: true, evidence: '提交信息必须用中文写' })
    check('  …另一个去向的草稿进了待确认（常驻）', otherTarget.pending === true && otherTarget.load === 'always', JSON.stringify(otherTarget))
    const second = await h.tool('memory_remember', { ...base, evidence: '提交信息用中文写' })
    check('第二次抄对 → 直写', typeof second.id === 'string' && second.pending !== true, JSON.stringify(second))
    check('  …同 slug、同去向的旧草稿被清掉，并在返回里说明', second.clearedDrafts?.join() === first.id && /Removed the earlier pending draft/.test(second.text), JSON.stringify(second))
    const left = mod.listPending(h.memoryDir).map((d) => d.id)
    check('  …去向不同的同 slug 草稿还在', left.length === 1 && left[0] === otherTarget.id, JSON.stringify(left))
    check('  …项目库只有一条，不会再收出 xxx-2', ids(h.memoryDir).join() === 'commit-msg-chinese')
  } finally {
    h.cleanup()
  }
}

section('F6 危险的库目录配置：记 issue，回落默认')
{
  const home = mod.dshHome()
  for (const [label, dir] of [['主目录本身', home], ['主目录的上级', path.dirname(home)]]) {
    for (const key of ['globalMemoryDir', 'memoryDir']) {
      const r = mod.resolveConfig({ [key]: dir })
      check(`${key} = ${label} → issue，回落默认`, r.config[key] === '' && r.issues.some((i) => i.startsWith(`${key}:`)), JSON.stringify(r.issues))
    }
  }
  const agentsDir = path.join(os.tmpdir(), 'wsm-agents-dir-probe')
  const same = mod.resolveConfig({ agentsFile: path.join(agentsDir, 'AGENTS.md'), memoryDir: agentsDir })
  check('memoryDir = AGENTS.md 所在目录 → issue，回落默认', same.config.memoryDir === '' && same.issues.some((i) => i.startsWith('memoryDir:')), JSON.stringify(same.issues))
  const fine = mod.resolveConfig({ memoryDir: path.join(home, 'elsewhere', 'memory'), globalMemoryDir: path.join(os.tmpdir(), 'wsm-ok', 'memory') })
  check('普通目录照常接受', fine.issues.length === 0 && fine.config.memoryDir !== '' && fine.config.globalMemoryDir !== '', JSON.stringify(fine.issues))

  // v6 的端到端：globalMemoryDir 配成主目录 → 回落默认，AGENTS.md 不会被当成记忆删掉
  const agentsFile = path.join(home, 'AGENTS.md')
  writeFileSync(agentsFile, '# 全局\n\n## 1. 一章\n\n内容\n')
  const h = makeHost(mod, { config: { agentsFile, globalMemoryDir: home } })
  try {
    const list = await h.http(`${API}/list`)
    check('面板列表里没有把 AGENTS.md 当成全局记忆', !list.body.memories.some((m) => m.id === 'AGENTS'), JSON.stringify(list.body.memories.map((m) => m.id)))
    const r = await h.tool('memory_forget', { id: 'AGENTS', scope: 'global' })
    check('memory_forget AGENTS 删不到它，文件还在', r.removed === false && existsSync(agentsFile), JSON.stringify(r))
  } finally {
    h.cleanup()
  }
}

section('F7 移库：删源失败回滚目标；索引重建失败不报错；换库后补丁失败如实回报')
{
  const h = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    mod.writeMemory(h.memoryDir, { slug: 'stuck', title: 'Stuck', body: 'body', type: 'feedback' })
    const restore = mod.setRemoveFileForTests(() => {
      throw new Error('EBUSY: file is locked')
    })
    let moved
    try {
      moved = mod.moveMemory(h.memoryDir, h.globalDir, 'stuck', { toScope: 'global' })
    } finally {
      restore()
    }
    check('删源失败 → ok:false（move-failed）', moved.ok === false && moved.reason === 'move-failed', JSON.stringify(moved))
    check('  …目标库的那份已回滚，源库原样', ids(h.globalDir).length === 0 && ids(h.memoryDir).join() === 'stuck')

    // 面板保存换库时同样：409 move-failed，响应带条目仍在的库（不用 write-failed——面板把那个码译成「写入 AGENTS.md 失败」）
    const restore2 = mod.setRemoveFileForTests(() => {
      throw new Error('EBUSY: file is locked')
    })
    let http
    try {
      http = await h.http(`${API}/save`, { method: 'POST', body: { id: 'stuck', scope: 'project', patch: { scope: 'global' } } })
    } finally {
      restore2()
    }
    check('  …save 换库删源失败 → 409 move-failed，scope 仍是 project，没有两份', http.status === 409 && http.body?.reason === 'move-failed' && http.body?.scope === 'project' && ids(h.globalDir).length === 0 && ids(h.memoryDir).join() === 'stuck', `${http.status} ${JSON.stringify(http.body)}`)
  } finally {
    h.cleanup()
  }

  const idx = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    mod.writeMemory(idx.memoryDir, { slug: 'move-me', title: 'Move me', body: 'body', type: 'feedback' })
    mkdirSync(path.join(idx.globalDir, 'MEMORY.md'), { recursive: true }) // 让目标库的索引写不进去
    const r = await idx.http(`${API}/save`, { method: 'POST', body: { id: 'move-me', scope: 'project', patch: { scope: 'global' } } })
    check('目标库索引重建失败：移库照常完成（不是 500）', r.status === 200 && r.body?.moved === true, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
    check('  …只有一份（在全局库）', ids(idx.memoryDir).length === 0 && ids(idx.globalDir).join() === 'move-me', JSON.stringify([ids(idx.memoryDir), ids(idx.globalDir)]))
    const forget = await idx.http(`${API}/forget`, { method: 'POST', body: { id: 'move-me' } })
    check('  …之后不带 scope 删除不会 scope-ambiguous', forget.status === 200, `${forget.status} ${JSON.stringify(forget.body)}`)
  } finally {
    idx.cleanup()
  }

  const patch = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    mod.writeMemory(patch.memoryDir, { slug: 'mv2', title: 'Mv2', body: 'body', type: 'feedback' })
    mkdirSync(path.join(patch.globalDir, 'renamed.md'), { recursive: true }) // 让换库后的改名写入失败
    const r = await patch.http(`${API}/save`, { method: 'POST', body: { id: 'mv2', scope: 'project', patch: { scope: 'global', slug: 'renamed', body: 'new body' } } })
    check('换库成功、补丁失败 → 409（不是 500）', r.status === 409 && r.body?.ok === false && r.body?.reason === 'partially-saved', `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
    check('  …响应带条目现在所在的库与 moved', r.body?.scope === 'global' && r.body?.moved === true && r.body?.previousScope === 'project', JSON.stringify(r.body))
    check('  …条目确实在全局库里（只有一份）', ids(patch.memoryDir).length === 0 && ids(patch.globalDir).includes('mv2'))
  } finally {
    patch.cleanup()
  }
}

section('F8 近似匹配的上限：超长段只做精确；只看最近 50 条消息')
{
  check('常量', mod.EVIDENCE_APPROX_MAX_SEGMENT === 500 && mod.EVIDENCE_APPROX_RECENT_MESSAGES === 50)
  const sentence = '以后不用每步都问我直接做完再汇报'
  const slipped = '以后不用每步问我直接做完再汇报'
  // 超过 500 字的证据段：原样能精确通过，有一字出入就不做近似
  const longText = Array.from({ length: 40 }, (_, i) => `第${i}段：${sentence}`).join('')
  check('超长证据原样 → exact', mod.verifyEvidence([longText], longText).match === 'exact')
  const longSlipped = longText.replace('第0段：以后不用每步都问我', '第0段：以后不用每步问我')
  check('超长证据（>500 字）有一字出入 → 不做近似，不通过', mod.verifyEvidence([longText], longSlipped).verified === false)
  // 只在最近 50 条消息上做近似
  const filler = Array.from({ length: 59 }, (_, i) => `无关的第 ${i} 条消息`)
  check('漏字的原话在第 1 条（60 条之前）→ 不做近似，不通过', mod.verifyEvidence([sentence, ...filler], slipped).verified === false)
  check('同一句在最近 50 条里 → approx', mod.verifyEvidence([...filler, sentence], slipped).match === 'approx')
  check('精确匹配不受这两道上限', mod.verifyEvidence([sentence, ...filler], sentence).match === 'exact')

  // 审查的极端输入（低熵、近似但超出 k）：现在同步核对在秒级以下
  const unit = '错误重试'
  const msg = unit.repeat(5000)
  const msgs = Array.from({ length: 200 }, () => msg)
  let ev = ''
  for (let i = 0; i < 1000; i += 1) ev += i % 5 === 4 ? '成' : unit[i % 4]
  const started = Date.now()
  const events = Array.from({ length: 400 }, () => ({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: msg }] } }))
  const r = mod.verifyEvidenceFrom({ cached: msgs, getSession: () => ({ snapshotEvents: () => events }), evidence: ev })
  const ms = Date.now() - started
  console.log(`        审查 v2 的最坏输入（缓存 200 + 快照 400，1000 字证据）：${ms} ms`)
  check('审查 v2 的最坏输入 < 2 秒（原来近 10 秒）', r.verified === false && ms < 2000, `${ms} ms`)
}

section('F9 草稿覆盖要看去向与 supersedes')
{
  const h = makeHost(mod, { config: { agentWrites: 'review', duplicateCheck: false } })
  try {
    h.write(h.agentsFile, '# 全局\n')
    mod.writeMemory(h.memoryDir, { slug: 'old-x', title: 'Old X', body: 'old body', type: 'feedback' })
    const a = await h.tool('memory_remember', { slug: 'rule-a', title: 'Rule A', body: 'A body (global always)', type: 'feedback', source: 'agent', scope: 'global', load: 'always', newChapter: true })
    const b = await h.tool('memory_remember', { slug: 'rule-a', title: 'Rule A v2', body: 'B body', type: 'feedback', source: 'agent', supersedes: 'old-x' })
    const drafts = mod.listPending(h.memoryDir)
    check('同 slug、去向不同 → 两条都留，没有互相覆盖', drafts.length === 2 && a.id !== b.id && b.replacedDraft === undefined, JSON.stringify(drafts.map((d) => [d.id, d.meta.scope, d.meta.load, d.meta.supersedes])))
    const c = await h.tool('memory_remember', { slug: 'rule-a', title: 'Rule A v3', body: 'C body', type: 'feedback', source: 'agent', supersedes: 'old-x' })
    check('同 slug、同去向、同 supersedes → 覆盖上一条', c.replacedDraft === b.id && mod.listPending(h.memoryDir).length === 2, JSON.stringify(c))
    const d = await h.tool('memory_remember', { slug: 'rule-a', title: 'Rule A v4', body: 'D body', type: 'feedback', source: 'agent' })
    check('同 slug、同去向但 supersedes 不同 → 新的一条', d.replacedDraft === undefined && mod.listPending(h.memoryDir).length === 3, JSON.stringify(d))
  } finally {
    h.cleanup()
  }
}

section('F11 核对状态按 agent 记；预取查询只用人写的文本；抽取去重比对全局按需库')
{
  const h = makeHost(mod, { config: { agentWrites: 'review', duplicateCheck: false } })
  try {
    h.state.events.push(userEvent('以后回答都用中文'))
    await h.tool('memory_remember', { slug: 'zh', title: '回答都用中文', body: 'x', type: 'feedback', source: 'user', evidence: '以后回答都用中文' })
    const mine = await h.tools.get('memory_status').execute({}, { agent: AGENT })
    // 「另一个 agent 看到 none」在 evidence-cache.test.mjs：那里的小宿主能给任意 agent 解析出工作目录
    check('做过核对的 agent 看到自己的状态', mine.evidenceSource !== 'none', mine.evidenceSource)
  } finally {
    h.cleanup()
  }

  const p = makeHost(mod, { config: { prefetchRecall: true } })
  try {
    mod.writeMemory(p.memoryDir, { slug: 'zebra-quartz', title: 'zebra quartz marker', description: 'zebra quartz marker', body: 'zebra quartz marker body', type: 'project' })
    await p.fire('agent/pre-step', { agent: AGENT, messages: [injectedEvent('zebra quartz marker', 'runtime-context').data], turn: 1, step: 1 })
    check('只有注入的消息 → 不预取', !p.contextText().includes('[相关记忆]'), p.contextText().slice(-200))
    await p.fire('agent/pre-step', { agent: AGENT, messages: [userEvent('tell me about the zebra quartz marker').data], turn: 1, step: 1 })
    check('人写的消息 → 照常预取', p.contextText().includes('[相关记忆]') && p.contextText().includes('zebra-quartz'), p.contextText().slice(-200))
  } finally {
    p.cleanup()
  }

  const embedder = await mod.resolveEmbedder()
  if (!embedder) {
    check('抽取去重比对全局按需库（没装 leanvec，向量去重不可用，跳过）', true)
  } else {
    const e = makeHost(mod, { config: { enableExtraction: true, dedupeThreshold: 0.9, extractMaxPerTurn: 3 } })
    try {
      const title = '改完插件要先跑测试'
      const body = '用户明确要求：每次改完插件先跑测试再提交。理由：避免把坏版本推上线。'
      mod.writeMemory(e.globalDir, { slug: 'test-first', title, body, type: 'feedback', scope: 'global' })
      const reply = JSON.stringify([{ slug: 'test-first-again', title, body, type: 'feedback', source: 'agent' }])
      const session = { snapshotEvents: () => [userEvent('以后每次改完插件都要先跑测试再提交，别再忘了。'.repeat(12))], requestContext: () => ({ provider: 'p', model: 'm' }) }
      const llm = { stream: () => (async function* () { yield { type: 'text-delta', text: reply } })() }
      const ctx = { get: (key) => (key === 'llm' ? llm : undefined), sessions: { get: () => session } }
      const r = await mod.extractFromTurn(ctx, { id: 'x' }, e.memoryDir, { globalDir: e.globalDir })
      check('全局按需库里已有同一条 → 抽取去重，不入队', r.deduped === 1 && r.queued === 0 && mod.listPending(e.memoryDir).length === 0, JSON.stringify(r))
    } finally {
      e.cleanup()
    }
  }
}

section('真实文件未被本次测试改动')
check('真实 AGENTS.md 与全局按需库的存在性与哈希不变', guard.unchanged())

summary()
