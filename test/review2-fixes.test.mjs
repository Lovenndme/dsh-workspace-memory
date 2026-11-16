/**
 * 第六轮：复审发现的问题，每条一组反例（设计说明 §11.1 / §11.3）。括号里的 v8–v15 是复审的复现脚本编号。
 *
 *   N1 evidenceRelates 放宽（比对加正文、短技术词、短纠正低门槛、文案中性）；抽取里核对不过的以「未核实」入队
 *      （复审 v10：改述式标题约两成真实纠正被误判、6 个绕过样例；v11：抽取把核对不过的候选整条丢掉）
 *   N2 章节草稿按章标题定位，不按章号（复审 v8：删掉前面的章之后草稿永远收不下）
 *   N3 草稿清理与覆盖用同一个判据（draftIntent）；同 slug 不同意图的草稿在返回文本里点名
 *      （复审 v8：不带 supersedes 的直写把「取代 X」的草稿一起清掉；v13：两条都收下后多出 xxx-2）
 *   N4 证据是否核实存进 evidenceVerified（草稿与正式记忆），列表接口返回它；常驻写入也做一次核对
 *      （复审 v13：没核对过的证据照样存成 source: user，面板显示成「用户原话」）
 *   N5 索引重建失败要能被看见（indexStale；memory_status 比对条目数）（复审 v12：写入结果与 status 都看不出索引没更新）
 *   N6 回滚失败用单独的原因码 move-partial（复审 v8：回滚也失败时两库各一份，却仍报 move-failed）
 *   N7 目录配置检查补上共享 agents 根（复审 v14：库目录配成 ~/.agents 不报 issue）
 *
 * 全部在临时目录（DSH_HOME 也是临时的）；结束时比对真实文件的哈希。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT, makeHost, makeReporter, realFilesGuard, userEvent, legacyAlwaysDraft } from './fake-host.mjs'
import { BYPASSES, CORRECTIONS, UNRELATED } from './relates-samples.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()
const API = '/api/dsh-workspace-memory'
const ids = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').map((n) => n.slice(0, -3)).sort() : [])

section('N1 evidenceRelates：复审的 22 条纠正（改述式标题 + 带 Why 的正文）')
{
  const rel = mod.evidenceRelates
  const missed = (pick) => CORRECTIONS.filter((c) => !rel(c[0], pick(c))).map((c) => c[0])
  const full = missed(([, t, d, b]) => [t, d, b])
  const noDesc = missed(([, t, , b]) => [t, '', b])
  const oldScope = missed(([, t, d]) => [t, d])
  console.log(`        标题+摘要+正文：误判 ${full.length}/22（${full.join(' | ')}）`)
  console.log(`        没写摘要（标题+正文）：误判 ${noDesc.length}/22；只比标题+摘要：误判 ${oldScope.length}/22`)
  // 锁住实测：正文用自己的话转述 Why（不抄原话）这种最严的写法下，仍只剩 3 条完全改写的漏判
  check('标题+摘要+正文：22 条里误判 ≤ 3（第五轮只比标题+摘要、门槛更高时约两成）', full.length <= 3, full.join(' | '))
  check('没写摘要时（标题+正文）误判 ≤ 5（第五轮是一半）', noDesc.length <= 5, noDesc.join(' | '))
  check('正文里引用了用户原话时 22 条全过', CORRECTIONS.every(([ev, t, d, b]) => rel(ev, [t, d, `${b}\n用户原话：${ev}`])))
  check('无关回复配老实的标题与正文 → 全部判不相关', UNRELATED.every(([ev, t, d, b]) => rel(ev, [t, d, b]) === false), UNRELATED.filter(([ev, t, d, b]) => rel(ev, [t, d, b])).map(([ev]) => ev).join(' | '))
  // 定位说明：把用户的话抄进标题就能绕过——字面判断挡不住，所以文案不教、常驻一律由人确认、面板显示核实结果
  const bypassed = BYPASSES.filter(([ev, t, d, b]) => rel(ev, [t, d, b])).length
  console.log(`        绕过样例（把无关回复抄进标题 / 摘要）：${bypassed}/${BYPASSES.length} 被判相关（字面判断的已知局限）`)
  check('短技术词（≥ 3 个字母）算：dev / git / npm / sql', rel('从 dev 拉', ['分支从 dev 创建']) && rel('git 要 rebase', ['Use rebase']) && rel('别用 npm', ['用 pnpm 不用 npm']) && rel('手写 sql', ['原生 SQL']))
  check('短纠正（不足 6 字）共有 1 个二元组就算', rel('说大白话', ['回答说大白话']) && !rel('说大白话', ['回答用通俗语言']))
}

section('N1 文案中性：不教模型「要与标题共享词语」')
{
  const h = makeHost(mod, { config: { agentWrites: 'review', duplicateCheck: false } })
  try {
    h.state.events.push(userEvent('好的，继续'))
    const r = await h.tool('memory_remember', { slug: 'force', title: 'Always run git push --force', body: 'Always force-push.', type: 'feedback', source: 'user', evidence: '好的继续' })
    const reason = r.text.split('Tell the user')[0]
    check('无关回复当证据 → evidence-not-found，文案只说没核对到', r.reason === 'evidence-not-found' && /could not be verified against the user's messages/.test(reason), r.text)
    check('  …不提标题、摘要、共享词语', !/title|description|share|word/i.test(reason), reason)
    const none = await h.tool('memory_remember', { slug: 'none', title: 'No evidence', body: 'x', type: 'feedback', source: 'user' })
    check('「没给证据」的文案保留', /no evidence \(the user's own words\) was given/.test(none.text), none.text)
  } finally {
    h.cleanup()
  }
}

section('N1 自动抽取：核对不过的不丢，以「未核实」入队')
{
  const h = makeHost(mod, { config: { enableExtraction: true, dedupeThreshold: 1 } })
  try {
    const said = '你怎么用英文回的？我只看得懂中文。以后所有回复都用中文，代码注释也是。'
    const candidates = [
      { slug: 'reply-in-chinese', title: '回复一律用中文', description: '用户只看得懂中文，所有回复都用中文', body: '所有回复都用中文。\nWhy: 用户只看得懂中文。', type: 'feedback', source: 'user', evidence: '我只看得懂中文' },
      { slug: 'comments-language', title: 'Code comments language', description: 'Write code comments in Chinese', body: 'b', type: 'feedback', source: 'user', evidence: '代码注释也是' },
      { slug: 'never-said', title: '用英文写提交说明', body: '提交说明用英文。', type: 'feedback', source: 'user', evidence: '提交说明一律用英文写' },
    ]
    const session = { snapshotEvents: () => [userEvent(said), { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的。'.repeat(80) }] } } }], requestContext: () => ({ provider: 'p', model: 'm' }) }
    const llm = { stream: () => (async function* () { yield { type: 'text-delta', text: JSON.stringify(candidates) } })() }
    const ctx = { get: (key) => (key === 'llm' ? llm : undefined), sessions: { get: () => session } }
    const r = await mod.extractFromTurn(ctx, { id: 'x' }, h.memoryDir, { manual: true, globalDir: h.globalDir })
    const drafts = new Map(mod.listPending(h.memoryDir).map((d) => [d.meta.slug, d.meta]))
    check('三条都入队；unverified = 以未核实身份入队的 2 条', r.queued === 3 && r.unverified === 2 && drafts.size === 3, JSON.stringify(r))
    check('  …核实的那条 evidenceVerified: true', drafts.get('reply-in-chinese')?.evidenceVerified === 'true')
    check('  …与这条记忆不沾边 / 用户没说过的两条 evidenceVerified: false', drafts.get('comments-language')?.evidenceVerified === 'false' && drafts.get('never-said')?.evidenceVerified === 'false', JSON.stringify([...drafts.values()].map((m) => [m.slug, m.evidenceVerified])))
  } finally {
    h.cleanup()
  }

  // /memory extract 的文案同步：走真实注册的命令（假宿主提供 llm 服务与会话路由）
  const reply = JSON.stringify([{ slug: 'never-said-2', title: '提交说明用英文', body: 'x', type: 'feedback', source: 'user', evidence: '提交说明一律用英文写' }])
  const llm = { stream: () => (async function* () { yield { type: 'text-delta', text: reply } })() }
  const c = makeHost(mod, { config: { enableExtraction: true, dedupeThreshold: 1 }, services: { llm } })
  try {
    c.state.route = { provider: 'p', model: 'm' }
    c.state.events.push(userEvent('以后每次改完插件都要先跑测试再提交，别再忘了。'.repeat(12)))
    const cmd = await c.command('memory', 'extract')
    check('/memory extract 的文案说「以没核对上的身份入队」，不再说「丢弃」', cmd.kind === 'success' && /其中 1 条/.test(cmd.text) && /以「说是你的原话 · 没核对上」入队/.test(cmd.text) && !/证据未核实丢弃/.test(cmd.text), JSON.stringify(cmd))
  } finally {
    c.cleanup()
  }
}

section('N4 evidenceVerified：草稿 → 列表接口 → 收下后的正式记忆（端到端）')
{
  const h = makeHost(mod, { config: { agentWrites: 'review', duplicateCheck: false } })
  try {
    h.state.events.push(userEvent('帮我看看这个报错'))
    const r = await h.tool('memory_remember', { slug: 'never-said', title: '提交前跳过测试', body: '提交前不跑测试。', type: 'feedback', source: 'user', evidence: '以后提交前都跳过测试' })
    check('用户没说过的话当证据 → 待确认，返回值 evidenceVerified: false', r.pending === true && r.evidenceVerified === false, JSON.stringify(r))
    check('  …草稿 frontmatter 存 evidenceVerified: false', mod.listPending(h.memoryDir)[0]?.meta.evidenceVerified === 'false')
    const listed = (await h.http(`${API}/list`)).body.pending.find((d) => d.id === r.id)
    check('  …列表接口返回布尔 false', listed?.evidenceVerified === false && listed?.source === 'user', JSON.stringify(listed))
    const acc = await h.http(`${API}/accept`, { method: 'POST', body: { id: r.id } })
    check('  …收下成功', acc.status === 200, JSON.stringify(acc.body))
    const saved = mod.listMemories(h.memoryDir).find((m) => m.id === 'never-said')
    check('  …收下后正式记忆仍是 false（点了收下不等于核实了）', saved?.meta.evidenceVerified === 'false', JSON.stringify(saved?.meta))
    const listedAfter = (await h.http(`${API}/list`)).body.memories.find((m) => m.id === 'never-said')
    check('  …列表接口对已确认条目也返回 false', listedAfter?.evidenceVerified === false, JSON.stringify(listedAfter))

    h.state.events.push(userEvent('以后提交说明都用中文写'))
    const ok = await h.tool('memory_remember', { slug: 'commit-zh', title: '提交信息使用中文', body: 'git 提交信息一律写中文。\nWhy: 用户要求提交说明用中文。', type: 'feedback', source: 'user', evidence: '以后提交说明都用中文写' })
    check('核实通过的直写：返回值与文件都是 evidenceVerified: true', ok.evidenceVerified === true && mod.listMemories(h.memoryDir).find((m) => m.id === 'commit-zh')?.meta.evidenceVerified === 'true', JSON.stringify(ok))
    const agentMade = await h.tool('memory_remember', { slug: 'agent-made', title: 'Agent made', body: 'x', type: 'pitfall', source: 'agent' })
    check('agent 来源不带 evidenceVerified', !('evidenceVerified' in agentMade) && mod.listPending(h.memoryDir).find((d) => d.id === agentMade.id)?.meta.evidenceVerified === undefined, JSON.stringify(agentMade))

    mod.writeMemory(h.memoryDir, { slug: 'legacy', title: 'Legacy', body: 'old', type: 'feedback', source: 'user', evidence: '旧数据' })
    const legacy = (await h.http(`${API}/list`)).body.memories.find((m) => m.id === 'legacy')
    check('没有该字段的旧数据：列表接口不返回这个键', legacy && !('evidenceVerified' in legacy), JSON.stringify(legacy))
  } finally {
    h.cleanup()
  }

  const a = makeHost(mod, { config: { agentWrites: 'review' } })
  try {
    a.write(a.agentsFile, '# 全局\n')
    a.state.events.push(userEvent('以后所有项目都用中文回答我'))
    const yes = await a.tool('memory_remember', { slug: 'zh-all', title: '所有项目都用中文回答', body: '始终用中文回答。', type: 'feedback', source: 'user', evidence: '以后所有项目都用中文回答我', scope: 'global', load: 'always', newChapter: true })
    const no = await a.tool('memory_remember', { slug: 'force', title: '总是强推', body: 'git push --force', type: 'feedback', source: 'user', evidence: '你以后推送一律加 --force', scope: 'global', load: 'always', newChapter: true })
    check('旧 always + 核实原话 → 直写跨项目库，evidenceVerified: true', !yes.pending && yes.scope === 'global' && yes.evidenceVerified === true && yes.loadIgnored === true && a.read(a.agentsFile) === '# 全局\n', JSON.stringify(yes))
    check('  …核对不到的 evidenceVerified: false，按需待确认', no.pending === true && no.reason === 'evidence-not-found' && no.load === 'on-demand' && no.evidenceVerified === false, JSON.stringify(no))
    const listed = (await a.http(`${API}/list`)).body.pending.find((d) => d.id === no.id)
    check('  …列表接口给面板 false（面板不再把它标成「用户原话」）', listed?.evidenceVerified === false, JSON.stringify(listed))
    const status = await a.tool('memory_status', {})
    check('  …常驻写入的核对也记进 memory_status', status.evidenceSource !== 'none', status.text)
  } finally {
    a.cleanup()
  }
}

section('N4 收尾：/memory pending 的来源标签与面板同一套规则')
{
  const h = makeHost(mod)
  try {
    mod.writePending(h.memoryDir, { id: 'dr_user_ok', title: '核实过的', body: 'x', source: 'user', evidence: '原话', evidenceVerified: true })
    mod.writePending(h.memoryDir, { id: 'dr_user_no', title: '没核实的', body: 'x', source: 'user', evidence: '原话', evidenceVerified: false })
    mod.writePending(h.memoryDir, { id: 'dr_user_old', title: '旧草稿没有字段', body: 'x', source: 'user', evidence: '原话' })
    mod.writePending(h.memoryDir, { id: 'dr_agent', title: '模型自己的', body: 'x', source: 'agent' })
    mod.writePending(h.memoryDir, { id: 'dr_none', title: '没有来源的', body: 'x' })
    const out = await h.command('memory', 'pending')
    // 2026-11-15 起每条两行，第二行是「→ 去向 · 来源 · id」：取那一行、去掉末尾的 id，来源就在行尾
    const line = (id) => out.text.split('\n').find((l) => l.endsWith(` · ${id}`))?.slice(0, -` · ${id}`.length) ?? ''
    // 2026-11-15 起用面板的叫法：你的原话 · 已核对 / 说是你的原话 · 没核对上 / 你的原话 · 旧条目未核对 / Agent 总结
    check('source: user 且 evidenceVerified: true →「你的原话 · 已核对」', /你的原话 · 已核对$/.test(line('dr_user_ok')), line('dr_user_ok'))
    check('source: user 但 evidenceVerified: false →「说是你的原话 · 没核对上」，不说成已核对', /说是你的原话 · 没核对上$/.test(line('dr_user_no')) && !line('dr_user_no').includes('已核对'), line('dr_user_no'))
    check('source: user、没有该字段的旧草稿 →「你的原话 · 旧条目未核对」', /你的原话 · 旧条目未核对$/.test(line('dr_user_old')), line('dr_user_old'))
    check('source: agent →「Agent 总结」', /Agent 总结$/.test(line('dr_agent')), line('dr_agent'))
    check('没有来源 → 不标', !/你的原话|Agent 总结/.test(line('dr_none')), line('dr_none'))
    check('sourceLabel 只认布尔真或字符串 true（手写的 yes 不算核实）', mod.sourceLabel({ source: 'user', evidenceVerified: 'yes' }) === '  你的原话 · 旧条目未核对' && mod.sourceLabel({ source: 'user', evidenceVerified: 'true' }) === '  你的原话 · 已核对')
  } finally {
    h.cleanup()
  }
}

section('N2 章节草稿按标题定位：删掉前面的章之后仍能收下')
{
  const AGENTS3 = '# 全局\n\n## 1. 甲章\n\n甲内容\n\n## 2. 乙章\n\n乙内容\n\n## 3. 丙章\n\n丙内容\n'
  const h = makeHost(mod, { config: { agentWrites: 'review' } })
  try {
    h.write(h.agentsFile, AGENTS3)
    const q = legacyAlwaysDraft(mod, h, { slug: 'merge-b', title: '乙章（合并版）', body: '乙内容\n补充', type: 'feedback', source: 'agent', scope: 'global', load: 'always', chapter: 2 })
    mod.deleteAgentsSection(0, { expectedTitle: '1. 甲章' }) // 用户删掉第 1 章：乙章变成第 1 章
    const acc = await mod.acceptPending(h.memoryDir, q.id, { globalDir: h.globalDir })
    const titles = mod.readAgentsDocument().sections.map((s) => s.title)
    check('删掉前面一章 → 按标题找到乙章（现在是第 1 章）并更新', acc.ok === true && acc.action === 'updated' && JSON.stringify(titles) === JSON.stringify(['1. 乙章（合并版）', '2. 丙章']), JSON.stringify({ acc, titles }))
  } finally {
    h.cleanup()
  }

  const ws = makeHost(mod, { config: { agentWrites: 'review' } })
  try {
    ws.write(ws.agentsFile, AGENTS3)
    const q = legacyAlwaysDraft(mod, ws, { slug: 'merge-b', title: '乙章（合并版）', body: '新', type: 'feedback', source: 'agent', scope: 'global', load: 'always', chapter: 2 })
    // 手改文件：去掉编号、多了空格、全角数字前缀——NFKC 与去编号后仍是同一个标题
    ws.write(ws.agentsFile, AGENTS3.replace('## 2. 乙章', '## ２.  乙章 '))
    const acc = await mod.acceptPending(ws.memoryDir, q.id, { globalDir: ws.globalDir })
    check('标题前后多了空格、编号写成全角 → 仍按标题找到', acc.ok === true && acc.action === 'updated', JSON.stringify(acc))
  } finally {
    ws.cleanup()
  }
}

section('N3 清理与覆盖用同一个判据；同 slug 不同意图的草稿在返回文本里点名')
{
  const h = makeHost(mod, { config: { agentWrites: 'review', duplicateCheck: false } })
  try {
    mod.writeMemory(h.memoryDir, { slug: 'old-x', title: '旧的提交规范', body: 'old', type: 'feedback' })
    h.state.events.push(userEvent('以后提交说明都用中文写'))
    const common = { slug: 'commit-in-chinese', title: '提交说明用中文写', description: '提交说明一律用中文', body: 'b', type: 'feedback' }
    const d1 = await h.tool('memory_remember', { ...common, source: 'agent', supersedes: 'old-x' })
    const d2 = await h.tool('memory_remember', { ...common, source: 'agent' })
    check('第二条草稿的返回文本点名同 slug、意图不同的那条', d2.sameSlugDrafts?.join() === d1.id && d2.text.includes(d1.id), JSON.stringify(d2))
    const w = await h.tool('memory_remember', { ...common, source: 'user', evidence: '以后提交说明都用中文写' })
    check('不带 supersedes 的直写只清掉不带 supersedes 的那条草稿', typeof w.id === 'string' && w.clearedDrafts?.join() === d2.id, JSON.stringify(w))
    check('  …「取代 old-x」的草稿留着（这次写入没做它要做的事）', mod.listPending(h.memoryDir).map((d) => d.id).join() === d1.id && ids(h.memoryDir).includes('old-x'))
  } finally {
    h.cleanup()
  }
}

section('N5 索引重建失败要能被看见')
{
  const h = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    await h.tool('memory_remember', { slug: 'first', title: 'First', description: 'first one', body: 'b', type: 'feedback', source: 'agent' })
    const index = path.join(h.memoryDir, 'MEMORY.md')
    rmSync(index, { force: true })
    mkdirSync(path.join(index, 'blocker'), { recursive: true }) // MEMORY.md 变成目录：重建一定失败
    const r = await h.tool('memory_remember', { slug: 'second', title: 'Second', description: 'second one', body: 'b', type: 'feedback', source: 'agent' })
    check('写入成功但索引没更新 → indexStale: true，文本说明', typeof r.id === 'string' && r.indexStale === true && /rebuilding the index \(MEMORY\.md\) failed/.test(r.text), JSON.stringify(r))
    const st = await h.tool('memory_status', {})
    check('memory_status 比对条目数，写明不一致并给出 /memory reindex', st.indexStale === true && st.staleLibraries?.includes('project') && /index out of date/.test(st.text) && /\/memory reindex/.test(st.text), st.text)
    const f = await h.tool('memory_forget', { id: 'first' })
    check('memory_forget 同样带 indexStale', f.removed === true && f.indexStale === true && /rebuilding the index \(MEMORY\.md\) failed/.test(f.text), JSON.stringify(f))

    rmSync(index, { recursive: true, force: true })
    const fixed = await h.tool('memory_remember', { slug: 'third', title: 'Third', description: 'third one', body: 'b', type: 'feedback', source: 'agent' })
    const st2 = await h.tool('memory_status', {})
    check('障碍去掉、下一次写入成功重建 → 不再 indexStale，status 也恢复', fixed.indexStale === undefined && st2.indexStale === undefined && !/index out of date/.test(st2.text), `${JSON.stringify(fixed)}\n${st2.text}`)
    check('  …索引里条目数与文件数一致', readFileSync(index, 'utf8').split('\n').filter((l) => l.startsWith('- [')).length === ids(h.memoryDir).length)
  } finally {
    h.cleanup()
  }
}

section('N6 回滚失败用单独的原因码 move-partial')
{
  const h = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    mod.writeMemory(h.memoryDir, { slug: 'mv', title: 'Mv', body: 'b', type: 'feedback' })
    const restore = mod.setRemoveFileForTests(() => {
      // 删源失败的同时让目标变成非空目录：回滚（删目标）也会失败
      const target = path.join(h.globalDir, 'mv.md')
      rmSync(target, { force: true })
      mkdirSync(path.join(target, 'x'), { recursive: true })
      throw Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' })
    })
    let r
    try {
      r = await h.http(`${API}/save`, { method: 'POST', body: { id: 'mv', scope: 'project', patch: { scope: 'global' } } })
    } finally {
      restore()
    }
    check('删源失败、回滚也失败 → 409 move-partial（不是 move-failed）', r.status === 409 && r.body?.reason === 'move-partial', `${r.status} ${JSON.stringify(r.body)}`)
    const plain = mod.setRemoveFileForTests(() => {
      throw new Error('EBUSY: simulated')
    })
    mod.writeMemory(h.memoryDir, { slug: 'mv2', title: 'Mv2', body: 'b', type: 'feedback' })
    let r2
    try {
      r2 = mod.moveMemory(h.memoryDir, h.globalDir, 'mv2', { toScope: 'global' })
    } finally {
      plain()
    }
    check('回滚成功的仍是 move-failed，条目只在原库', r2.ok === false && r2.reason === 'move-failed' && !existsSync(path.join(h.globalDir, 'mv2.md')), JSON.stringify(r2))
  } finally {
    h.cleanup()
  }
}

section('N7 目录配置检查补上共享 agents 根')
{
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DSH_AGENTS_HOME')
  const saved = process.env.DSH_AGENTS_HOME
  try {
    delete process.env.DSH_AGENTS_HOME
    check('没设 DSH_AGENTS_HOME → ~/.agents', mod.sharedAgentsHome() === path.join(os.homedir(), '.agents'))
    for (const key of ['globalMemoryDir', 'memoryDir']) {
      const r = mod.resolveConfig({ [key]: path.join(os.homedir(), '.agents') })
      check(`${key} = ~/.agents → issue，回落默认`, r.config[key] === '' && r.issues.some((i) => i.startsWith(`${key}:`)), JSON.stringify(r.issues))
    }
    const custom = path.join(os.tmpdir(), 'wsm-agents-home-probe')
    process.env.DSH_AGENTS_HOME = custom
    check('设了 DSH_AGENTS_HOME → 用它', mod.sharedAgentsHome() === path.resolve(custom))
    const same = mod.resolveConfig({ globalMemoryDir: custom })
    check('库目录 = $DSH_AGENTS_HOME → issue', same.config.globalMemoryDir === '' && same.issues.length === 1, JSON.stringify(same.issues))
    const above = mod.resolveConfig({ memoryDir: path.dirname(custom) })
    check('库目录包含 $DSH_AGENTS_HOME（是它的上级）→ issue', above.config.memoryDir === '' && above.issues.length === 1, JSON.stringify(above.issues))
    const inside = mod.resolveConfig({ memoryDir: path.join(custom, 'memory') })
    check('在它里面的子目录可以（库是平铺的，不会把 agents 根的 AGENTS.md 当成记忆）', inside.config.memoryDir !== '' && inside.issues.length === 0, JSON.stringify(inside.issues))
  } finally {
    if (had) process.env.DSH_AGENTS_HOME = saved
    else delete process.env.DSH_AGENTS_HOME
  }
}

section('收尾：agentsFileDisplay 看配置的 agentsFile（真实模型写入离线重放时发现）')
{
  try {
    mod.configure({})
    check('没配置 → <主目录符号>/AGENTS.md（测试里 DSH_HOME 是临时目录，所以是 $DSH_HOME）', mod.agentsFileDisplay() === `${mod.dshHomeDisplay()}/AGENTS.md` && mod.agentsFileDisplay() === '$DSH_HOME/AGENTS.md', mod.agentsFileDisplay())
    mod.configure({ agentsFile: path.join(mod.dshHome(), 'custom', 'AGENTS.md') })
    check('配置在 DSH 主目录之下 → 主目录前缀换成符号形式', mod.agentsFileDisplay() === '$DSH_HOME/custom/AGENTS.md', mod.agentsFileDisplay())
    const outside = path.join(os.tmpdir(), 'wsm-elsewhere-agents', 'AGENTS.md')
    mod.configure({ agentsFile: outside })
    check('配置在主目录之外 → 原样显示配置的路径', mod.agentsFileDisplay() === outside, mod.agentsFileDisplay())
    // 没设 DSH_HOME 时主目录是 ~/.dsh：只算字符串，不碰那里的任何文件
    const saved = process.env.DSH_HOME
    try {
      delete process.env.DSH_HOME
      mod.configure({ agentsFile: path.join(os.homedir(), '.dsh', 'custom', 'AGENTS.md') })
      check('主目录是默认的 ~/.dsh 时 → ~/.dsh/custom/AGENTS.md', mod.agentsFileDisplay() === '~/.dsh/custom/AGENTS.md', mod.agentsFileDisplay())
    } finally {
      process.env.DSH_HOME = saved
    }
  } finally {
    mod.configure(undefined)
  }

  // 端到端：配置在主目录之下的自定义 AGENTS.md，常驻草稿的提示里写的就是它
  const agentsFile = path.join(mod.dshHome(), 'custom', 'AGENTS.md')
  const h = makeHost(mod, { config: { agentWrites: 'review', agentsFile } })
  try {
    mkdirSync(path.dirname(agentsFile), { recursive: true })
    h.write(agentsFile, '# 全局\n\n## 1. 已有\n\n内容\n')
    const r = await h.tool('memory_remember', { slug: 'custom-agents', title: '新主题', body: 'x', type: 'feedback', source: 'agent', scope: 'global', load: 'always', newChapter: true })
    check('新按需草稿不再指向自定义 AGENTS.md，该文件原样保留', r.load === 'on-demand' && r.text.endsWith(mod.LOAD_IGNORED_TEXT) && !r.text.includes('writes it into $DSH_HOME/custom/AGENTS.md') && h.read(agentsFile) === '# 全局\n\n## 1. 已有\n\n内容\n', r.text)
  } finally {
    h.cleanup()
    rmSync(path.dirname(agentsFile), { recursive: true, force: true })
  }
}

section('旧章节参数不再触发 AGENTS.md 章节协议')
{
  const h = makeHost(mod, { config: { agentWrites: 'review', duplicateCheck: false } })
  try {
    const original = '# 全局\n\n## 1. 安全\n\n甲\n\n## 2. 临时文件\n\n乙\n\n## 杂项\n\n丙\n'
    h.write(h.agentsFile, original)
    const r = await h.tool('memory_remember', { slug: 'new-topic', title: '一个新主题', body: 'x', type: 'feedback', source: 'agent', scope: 'global', load: 'always', chapter: 999 })
    check('不再要求章节确认，越界章号也不改变按需去向', r.pending === true && r.reason === 'agent-review' && r.load === 'on-demand' && r.loadIgnored === true, JSON.stringify(r))
    const draft = mod.listPending(h.memoryDir)[0]
    check('新草稿没有章节字段，AGENTS.md 未变', draft?.meta.chapter === undefined && draft?.meta.chapterTitle === undefined && draft?.meta.newChapter === undefined && h.read(h.agentsFile) === original)
  } finally { h.cleanup() }
}

section('其它：HTTP 路由处写明「宿主网页服务无鉴权」；status 拿不到工作目录时也带 evidenceSource')
{
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  check('注释写明宿主网页服务不提供鉴权（官方 dsh-host-webserver README）', source.includes('No server-wide authentication or origin policy'))
  const h = makeHost(mod)
  try {
    const other = await h.tools.get('memory_status').execute({}, { agent: { id: 'agent-without-session' } })
    check('拿不到工作目录的 agent：evidenceSource 是 none，不是缺键', other.evidenceSource === 'none', JSON.stringify(other))
    const mine = await h.tools.get('memory_status').execute({}, { agent: AGENT })
    check('  …当前 agent 照常', typeof mine.evidenceSource === 'string')
  } finally {
    h.cleanup()
  }
}

section('真实文件未被本次测试改动')
check('真实 AGENTS.md 与全局按需库的存在性与哈希不变', guard.unchanged())

summary()
