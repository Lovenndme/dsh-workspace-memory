/**
 * 两个按需库之间 id 不重复，以及收下草稿失败时的响应形状（2026-11-14 第四轮追加，面板 agent 反馈）。
 *
 * 一、id 不重复：面板按 id 选中条目，两个库各有一条同 id 的记忆时会同时高亮两行、第二条打不开。从源头不让它出现：
 *   · memory_remember 定一个**新 id** 时（新建、换 slug 的取代）同时避开两个库，处理方式与库内重名相同（加 -2）；
 *   · acceptPending 落到某个按需库时同理；面板保存改 slug（重命名）时同理；
 *   · 原地更新保持原 id；moveMemory 的 target-exists 拒绝不变。
 * 二、收下草稿失败：原因码在 `reason`（面板 reasonText 先读 reason 再读 error），状态码走 REASON_STATUS，
 *   表里没有的码 400，只有「草稿不存在」是 404；same-library 登记为 400。
 *
 * 全部在临时目录；结束时比对真实文件的哈希。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { makeHost, makeReporter, realFilesGuard } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()
const API = '/api/dsh-workspace-memory'

const ids = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').map((n) => n.slice(0, -3)).sort() : [])
/** 两个库里有没有同一个 id（不分大小写）。 */
const clashes = (h) => {
  const project = new Set(ids(h.memoryDir).map((id) => id.toLowerCase()))
  return ids(h.globalDir).filter((id) => project.has(id.toLowerCase()))
}
const host = (config = {}) => makeHost(mod, { config: { duplicateCheck: false, agentWrites: 'direct', ...config } })
const seed = (dir, slug, extra = {}) => mod.writeMemory(dir, { slug, title: slug, description: slug, body: `${slug} body`, type: 'project', ...extra })

section('memory_remember：新 id 同时避开另一个按需库')
{
  const h = host()
  try {
    seed(h.globalDir, 'shared-rule', { scope: 'global' })
    const res = await h.tool('memory_remember', { slug: 'shared-rule', title: 'Shared rule', body: 'project body', type: 'project', source: 'agent' })
    check('全局库已有 X，往项目库写 slug X → 项目库里是 X-2', res.id === 'shared-rule-2' && ids(h.memoryDir).join() === 'shared-rule-2', JSON.stringify(res))
    check('  …两个库没有同一个 id', clashes(h).length === 0, clashes(h).join())
    check('  …全局库的 X 原样还在', ids(h.globalDir).join() === 'shared-rule' && mod.listMemories(h.globalDir)[0].body === 'shared-rule body')
  } finally {
    h.cleanup()
  }

  const r = host()
  try {
    seed(r.memoryDir, 'local-rule')
    const res = await r.tool('memory_remember', { slug: 'local-rule', title: 'Local rule', body: 'global body', type: 'project', source: 'agent', scope: 'global' })
    check('反向：项目库已有 X，往全局库写 slug X → 全局库里是 X-2', res.id === 'local-rule-2' && ids(r.globalDir).join() === 'local-rule-2' && clashes(r).length === 0, JSON.stringify(res))
  } finally {
    r.cleanup()
  }

  const c = host()
  try {
    // 手写文件的 id 带大写：Windows 上 `Mixed-Case.md` 与 `mixed-case.md` 是同一个名字，按小写判重
    mkdirSync(c.globalDir, { recursive: true })
    c.write(path.join(c.globalDir, 'Mixed-Case.md'), '---\ntitle: Mixed\ndescription: m\ntype: project\n---\n\nbody\n')
    const res = await c.tool('memory_remember', { slug: 'mixed-case', title: 'Mixed', body: 'x', type: 'project', source: 'agent' })
    check('跨库判重不分大小写', res.id === 'mixed-case-2' && clashes(c).length === 0, JSON.stringify(res))
  } finally {
    c.cleanup()
  }

  const q = host({ agentWrites: 'review' })
  try {
    seed(q.globalDir, 'queued-rule', { scope: 'global' })
    const queued = await q.tool('memory_remember', { slug: 'queued-rule', title: 'Queued rule', body: 'x', type: 'project', source: 'agent' })
    check('进待确认的不受影响（草稿有自己的 id，收下时才定库里的 id）', queued.pending === true, JSON.stringify(queued))
    const accepted = await mod.acceptPending(q.memoryDir, queued.id, { globalDir: q.globalDir })
    check('  …收下时避开全局库：项目库里是 X-2', accepted.ok === true && accepted.file === 'queued-rule-2.md' && clashes(q).length === 0, JSON.stringify(accepted))
  } finally {
    q.cleanup()
  }
}

section('取代与原地更新不受影响')
{
  const h = host()
  try {
    seed(h.memoryDir, 'keep-id')
    // 历史上已经存在的跨库同 id（例如手工放进去的）：原地更新不改名，不制造 keep-id-2
    seed(h.globalDir, 'keep-id', { scope: 'global' })
    const res = await h.tool('memory_remember', { slug: 'keep-id', title: 'Keep id v2', body: 'new body', type: 'project', source: 'agent', supersedes: 'keep-id' })
    check('原地更新：id 不变', res.id === 'keep-id' && res.updated === true && ids(h.memoryDir).join() === 'keep-id', JSON.stringify(res))
    check('  …正文是新的', mod.listMemories(h.memoryDir)[0].body === 'new body')
  } finally {
    h.cleanup()
  }

  const x = host()
  try {
    seed(x.globalDir, 'move-me', { scope: 'global' })
    const res = await x.tool('memory_remember', { slug: 'move-me', title: 'Move me', body: 'now project', type: 'project', source: 'agent', scope: 'project', supersedes: 'move-me' })
    check('跨库取代 + 同 slug：搬过来原地更新，仍是 move-me（不是 move-me-2）', res.id === 'move-me' && res.replacedFrom === 'global' && ids(x.memoryDir).join() === 'move-me' && ids(x.globalDir).length === 0, JSON.stringify(res))
  } finally {
    x.cleanup()
  }

  const s = host()
  try {
    seed(s.memoryDir, 'old-rule')
    seed(s.globalDir, 'taken-elsewhere', { scope: 'global' })
    const res = await s.tool('memory_remember', { slug: 'new-rule', title: 'New rule', body: 'b', type: 'project', source: 'agent', supersedes: 'old-rule' })
    check('换 slug 的取代：新 id 照常、旧条删除', res.id === 'new-rule' && res.replaced === 'old-rule' && ids(s.memoryDir).join() === 'new-rule', JSON.stringify(res))
    const res2 = await s.tool('memory_remember', { slug: 'taken-elsewhere', title: 'T', body: 'b2', type: 'project', source: 'agent', supersedes: 'new-rule' })
    check('换 slug 的取代撞上另一个库的 id：与库内重名一样加 -2', res2.id === 'taken-elsewhere-2' && res2.replaced === 'new-rule' && clashes(s).length === 0, JSON.stringify(res2))
  } finally {
    s.cleanup()
  }
}

section('acceptPending：落库时避开另一个库；原地更新不变')
{
  const h = host()
  try {
    seed(h.globalDir, 'dup', { scope: 'global' })
    mod.writePending(h.memoryDir, { id: 'dr_p', slug: 'dup', title: 'Dup', body: 'project draft', scope: 'project', load: 'on-demand' })
    const a = await mod.acceptPending(h.memoryDir, 'dr_p', { globalDir: h.globalDir })
    check('全局库已有 X，收下项目草稿 slug X → 项目库里是 X-2', a.ok === true && a.file === 'dup-2.md' && clashes(h).length === 0, JSON.stringify(a))

    seed(h.memoryDir, 'here')
    mod.writePending(h.memoryDir, { id: 'dr_g', slug: 'here', title: 'Here', body: 'global draft', scope: 'global', load: 'on-demand' })
    const b = await mod.acceptPending(h.memoryDir, 'dr_g', { globalDir: h.globalDir })
    check('反向：项目库已有 X，收下全局草稿 slug X → 全局库里是 X-2', b.ok === true && b.scope === 'global' && b.file === 'here-2.md' && clashes(h).length === 0, JSON.stringify(b))

    mod.writePending(h.memoryDir, { id: 'dr_u', slug: 'here', title: 'Here v2', body: 'updated', scope: 'project', load: 'on-demand', supersedes: 'here' })
    const c = await mod.acceptPending(h.memoryDir, 'dr_u', { globalDir: h.globalDir })
    check('带 supersedes 的同 slug 草稿：原地更新，id 不变', c.ok === true && c.file === 'here.md' && mod.listMemories(h.memoryDir).find((r) => r.id === 'here')?.body === 'updated', JSON.stringify(c))
  } finally {
    h.cleanup()
  }
}

section('面板保存改 slug（重命名）同样避开另一个库；moveMemory 的 target-exists 不变')
{
  const h = host()
  try {
    seed(h.memoryDir, 'rename-me')
    seed(h.globalDir, 'wanted-name', { scope: 'global' })
    const res = await h.http(`${API}/save`, { method: 'POST', body: { id: 'rename-me', scope: 'project', patch: { slug: 'wanted-name' } } })
    check('改成另一个库已有的 id → 加 -2', res.status === 200 && res.body?.memory?.id === 'wanted-name-2' && clashes(h).length === 0, `${res.status} ${JSON.stringify(res.body)}`)

    seed(h.memoryDir, 'twin')
    mkdirSync(h.globalDir, { recursive: true })
    h.write(path.join(h.globalDir, 'twin.md'), '---\ntitle: Twin\ndescription: t\ntype: project\n---\n\nglobal twin\n')
    const moved = mod.moveMemory(h.memoryDir, h.globalDir, 'twin', { toScope: 'global' })
    check('moveMemory：目标库已有同 id → target-exists（不变）', moved.ok === false && moved.reason === 'target-exists', JSON.stringify(moved))
  } finally {
    h.cleanup()
  }
}

section('收下草稿失败：原因码在 reason，状态码走 REASON_STATUS')
{
  const h = host()
  try {
    mod.writePending(h.memoryDir, { id: 'dr_bad', slug: 'bad', title: 'Bad', body: 'x', scope: 'project', load: 'always' })
    const bad = await h.http(`${API}/accept`, { method: 'POST', body: { id: 'dr_bad' } })
    check('「本项目 + 常驻」草稿 → 400，reason = belongs-in-project-agents', bad.status === 400 && bad.body?.reason === 'belongs-in-project-agents' && bad.body?.ok === false, `${bad.status} ${JSON.stringify(bad.body)}`)
    check('  …error 里是给人看的说明，不是原因码', typeof bad.body?.error === 'string' && bad.body.error !== 'belongs-in-project-agents')

    const missing = await h.http(`${API}/accept`, { method: 'POST', body: { id: 'dr_nope' } })
    check('草稿不存在 → 404，reason = not-found', missing.status === 404 && missing.body?.reason === 'not-found', `${missing.status} ${JSON.stringify(missing.body)}`)
    const missingReject = await h.http(`${API}/reject`, { method: 'POST', body: { id: 'dr_nope' } })
    check('丢弃不存在的草稿 → 同样 404 + not-found', missingReject.status === 404 && missingReject.body?.reason === 'not-found', `${missingReject.status} ${JSON.stringify(missingReject.body)}`)

    // AGENTS.md 写不进去（这里让它超出字节预算）：以前原因码塞在 error 里、状态落到默认 404
    h.write(h.agentsFile, '# 全局\n\n## 1. 已有\n\n内容\n')
    mod.writePending(h.memoryDir, { id: 'dr_big', slug: 'big', title: 'Big', body: '很长的正文。'.repeat(2000), scope: 'global', load: 'always' })
    const full = await h.http(`${API}/accept`, { method: 'POST', body: { id: 'dr_big' } })
    check('AGENTS.md 超预算 → reason = agents-full（码不再塞在 error 里），带 bytes / limit', full.body?.ok === false && full.body?.reason === 'agents-full' && Number.isFinite(full.body?.bytes) && Number.isFinite(full.body?.limit) && full.body?.error !== 'agents-full', `${full.status} ${JSON.stringify({ ...full.body, error: undefined })}`)
    check('  …状态 400（表里没有的码按其它路由的默认），不是 404', full.status === 400, String(full.status))
    check('  …草稿仍在队列里', mod.listPending(h.memoryDir).some((d) => d.id === 'dr_big'))
  } finally {
    h.cleanup()
  }
}

// same-library 登记进 REASON_STATUS（400）：把两个库配置成同一个目录，面板改范围时就会遇到
section('same-library：两个库是同一个目录时，面板改范围 → 400 same-library')
{
  const h = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    // 用同一个目录同时充当两个库：apply 时 globalMemoryDir 指向项目库目录
    const sameDirHost = makeHost(mod, { config: { duplicateCheck: false, globalMemoryDir: h.memoryDir, memoryDir: h.memoryDir } })
    try {
      seed(h.memoryDir, 'one')
      const res = await sameDirHost.http(`${API}/save`, { method: 'POST', body: { id: 'one', scope: 'project', patch: { scope: 'global' } } })
      check('save 换库到同一个目录 → 400，reason = same-library', res.status === 400 && res.body?.reason === 'same-library', `${res.status} ${JSON.stringify(res.body)}`)
    } finally {
      sameDirHost.cleanup()
    }
  } finally {
    h.cleanup()
  }
}

section('真实文件未被本次测试改动')
check('真实 AGENTS.md 与全局按需库的存在性与哈希不变', guard.unchanged())

summary()
