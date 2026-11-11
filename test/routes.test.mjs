/**
 * HTTP 路由与 memory_forget 工具的闸门：
 *   1. 记忆 id 是路径穿越的入口——任何路由 / 工具都不能因为 id 去读、写、删记忆目录之外的文件
 *   2. 记忆库路由必须带能反查出工作目录的 session，查不到就是 400
 *   3. 写路由只收 application/json（跨站「简单请求」不触发预检，是 CSRF 的口子）
 *   4. AGENTS.md 章节写路由：expectedTitle 对不上 → 409，index 必须是真整数 → 400
 *   5. 任何路由都不能把异常抛进宿主
 *
 * 全部在临时目录里跑；agentsFile / memoryDir 经 apply 的 rawConfig 传入（见 fake-host.mjs）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeHost, makeReporter, snapshotTree } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const API = '/api/dsh-workspace-memory'

const AGENTS = ['# 规则', '', '## 1. Alpha', '', 'alpha body', '', '## 2. Beta', '', 'beta body', ''].join('\n')

section('路径穿越：每个路由与 memory_forget 工具都拒绝，库外文件一个字节不变')
{
  const host = makeHost(mod)
  try {
    host.write(host.agentsFile, AGENTS)
    host.write(path.join(host.root, 'victim.md'), 'victim body')
    host.write(path.join(host.root, 'proj', 'victim.md'), 'victim in proj')
    mkdirSync(path.join(host.root, 'proj', '.memory-state', 'pending'), { recursive: true })
    host.write(path.join(host.root, 'proj', '.memory-state', 'pending', 'dr_real.md'), '---\ntitle: 真草稿\n---\n\n正文\n')
    await host.tool('memory_remember', { slug: 'legit-one', title: 'Legit', body: 'legit body text here', description: 'd' })

    const outside = path.join(host.root, 'victim')
    const evil = [
      '../../victim',
      '..\\..\\victim',
      '../../../AGENTS',
      '../victim',
      '..',
      '.',
      'a/b',
      'a\\b',
      outside, // 绝对路径（含盘符与反斜杠）
      'C:\\Windows\\win',
    ]
    // 快照 root 下除记忆目录以外的一切（含 AGENTS.md、victim.md、草稿）
    const skip = [path.relative(host.root, host.memoryDir)]
    const before = snapshotTree(host.root, skip)

    for (const id of evil) {
      for (const route of ['save', 'forget', 'accept', 'reject', 'promote']) {
        const res = await host.http(`${API}/${route}`, { method: 'POST', body: { id, patch: { body: 'PWNED' } } })
        check(
          `${route} ← ${JSON.stringify(id)} → 400 invalid-id`,
          res.status === 400 && res.body?.ok === false && res.body?.reason === 'invalid-id',
          `${res.status} ${JSON.stringify(res.body)}`,
        )
      }
      const tool = await host.tool('memory_forget', { id })
      check(
        `memory_forget ← ${JSON.stringify(id)} 拒绝且不抛`,
        tool.removed === false && tool.reason === 'invalid-id' && typeof tool.text === 'string',
        JSON.stringify(tool),
      )
    }

    const after = snapshotTree(host.root, skip)
    check('记忆目录之外没有任何文件被改、被删、被新建', JSON.stringify(before) === JSON.stringify(after))
    check('victim.md 仍在', existsSync(path.join(host.root, 'victim.md')))
    check('正常记忆没受影响', existsSync(path.join(host.memoryDir, 'legit-one.md')))

    // 合法 id 照常工作
    const ok = await host.http(`${API}/forget`, { method: 'POST', body: { id: 'legit-one' } })
    check('合法 id 仍可删除', ok.status === 200 && ok.body.ok === true && !existsSync(path.join(host.memoryDir, 'legit-one.md')), JSON.stringify(ok.body))
    const missing = await host.http(`${API}/forget`, { method: 'POST', body: { id: 'no-such-memory' } })
    check('合法但不存在的 id → 404（不是 400）', missing.status === 404, String(missing.status))
  } finally {
    host.cleanup()
  }
}

section('session 必需：缺失或查不到一律 400，不回退到默认目录')
{
  const host = makeHost(mod)
  try {
    const scoped = [
      ['list', 'GET', undefined],
      ['save', 'POST', { id: 'x', patch: { body: 'y' } }],
      ['accept', 'POST', { id: 'dr_x' }],
      ['reject', 'POST', { id: 'dr_x' }],
      ['forget', 'POST', { id: 'x' }],
      ['promote', 'POST', { id: 'x' }],
    ]
    for (const [route, method, body] of scoped) {
      const none = await host.http(`${API}/${route}`, { method, session: null, body })
      check(`${route} 不带 session → 400 no-session`, none.status === 400 && none.body?.reason === 'no-session', `${none.status} ${JSON.stringify(none.body)}`)
      const unknown = await host.http(`${API}/${route}`, { method, session: 's-nope', body })
      check(`${route} 带不存在的 session → 400 no-session`, unknown.status === 400 && unknown.body?.reason === 'no-session', `${unknown.status}`)
    }
    const list = await host.http(`${API}/list`)
    check('带有效 session 的 list → 200', list.status === 200 && list.body.ok === true && Array.isArray(list.body.memories))
    const head = await host.http(`${API}/list`, { method: 'HEAD' })
    check('HEAD 也能读', head.status === 200)
    const wrongMethod = await host.http(`${API}/list`, { method: 'POST', body: {} })
    check('list 不收 POST → 405', wrongMethod.status === 405)
    const getOnWrite = await host.http(`${API}/forget`, { method: 'GET' })
    check('写路由不收 GET → 405（GET 不能改状态）', getOnWrite.status === 405)
  } finally {
    host.cleanup()
  }
}

section('写路由只收 application/json：其余一律 415，且什么都不改')
{
  const host = makeHost(mod)
  try {
    host.write(host.agentsFile, AGENTS)
    await host.tool('memory_remember', { slug: 'keep-me', title: 'Keep', body: 'keep me body text', description: 'd' })
    const before = snapshotTree(host.root)
    const writes = [
      ['save', { id: 'keep-me', patch: { body: 'x' } }],
      ['accept', { id: 'dr_x' }],
      ['reject', { id: 'dr_x' }],
      ['forget', { id: 'keep-me' }],
      ['promote', { id: 'keep-me' }],
      ['open-agents', { editor: 'system' }], // 若闸门失效会真的弹出编辑器——所以只用非 JSON 类型测
      ['agents/save-section', { index: 0, title: 'x', body: 'y' }],
      ['agents/delete-section', { index: 0 }],
      ['agents/add-section', { title: 'x', body: 'y' }],
    ]
    for (const [route, body] of writes) {
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
        const headers = type ? { 'content-type': type } : {}
        const res = await host.http(`${API}/${route}`, { method: 'POST', headers, rawBody: JSON.stringify(body) })
        check(
          `${route} ← ${type ?? '(无 content-type)'} → 415`,
          res.status === 415 && res.body?.ok === false && res.body?.reason === 'unsupported-media-type',
          `${res.status} ${JSON.stringify(res.body)}`,
        )
      }
    }
    check('415 之后磁盘一个字节没变', JSON.stringify(before) === JSON.stringify(snapshotTree(host.root)))

    const withCharset = await host.http(`${API}/forget`, {
      method: 'POST',
      headers: { 'content-type': 'Application/JSON; charset=utf-8' },
      body: { id: 'keep-me' },
    })
    check('application/json; charset=utf-8（大小写不敏感）被接受', withCharset.status === 200, `${withCharset.status} ${JSON.stringify(withCharset.body)}`)

    const badJson = await host.http(`${API}/forget`, { method: 'POST', rawBody: '{oops' })
    check('坏 JSON → 400 invalid-json', badJson.status === 400 && badJson.body?.reason === 'invalid-json', `${badJson.status}`)
    const huge = await host.http(`${API}/forget`, { method: 'POST', rawBody: JSON.stringify({ id: 'x'.repeat(1024 * 1024 + 10) }) })
    check('超过 1 MiB → 413 并断开连接', huge.status === 413 && huge.req.destroyed === true, `${huge.status} destroyed=${huge.req.destroyed}`)
  } finally {
    host.cleanup()
  }
}

section('AGENTS.md 章节：expectedTitle 对不上 → 409；index 必须是真整数 → 400')
{
  const host = makeHost(mod)
  try {
    host.write(host.agentsFile, AGENTS)
    const text = () => host.read(host.agentsFile)

    const stale = await host.http(`${API}/agents/save-section`, { method: 'POST', session: null, body: { index: 0, title: 'Alpha', body: 'NEW', expectedTitle: 'Beta' } })
    check('save-section 序号过期 → 409 section-moved', stale.status === 409 && stale.body?.reason === 'section-moved', `${stale.status} ${JSON.stringify(stale.body)}`)
    check('  …文件没变', text() === AGENTS)

    const fresh = await host.http(`${API}/agents/save-section`, { method: 'POST', session: null, body: { index: 0, title: 'Alpha', body: 'NEW alpha body', expectedTitle: '1. Alpha' } })
    check('expectedTitle 带编号也能对上 → 200', fresh.status === 200 && fresh.body?.ok === true, `${fresh.status} ${JSON.stringify(fresh.body)}`)
    check('  …正文已更新', text().includes('NEW alpha body') && text().includes('beta body'))

    const before = text()
    const staleDelete = await host.http(`${API}/agents/delete-section`, { method: 'POST', session: null, body: { index: 1, expectedTitle: 'Alpha' } })
    check('delete-section 序号过期 → 409', staleDelete.status === 409 && staleDelete.body?.reason === 'section-moved', `${staleDelete.status}`)
    check('  …没有删错章', text() === before)

    for (const index of ['1', 1.5, '', null, [], true, -1, undefined, '0']) {
      for (const route of ['save-section', 'delete-section']) {
        const res = await host.http(`${API}/agents/${route}`, { method: 'POST', session: null, body: { index, title: 'x', body: 'y' } })
        check(`${route} index=${JSON.stringify(index)} → 400 invalid-index`, res.status === 400 && res.body?.reason === 'invalid-index', `${res.status} ${JSON.stringify(res.body)}`)
      }
    }
    check('非法 index 没有改动文件', text() === before)

    const outOfRange = await host.http(`${API}/agents/delete-section`, { method: 'POST', session: null, body: { index: 9 } })
    check('越界的整数 → 400 section-not-found（不是 invalid-index）', outOfRange.status === 400 && outOfRange.body?.reason === 'section-not-found', `${outOfRange.status} ${JSON.stringify(outOfRange.body)}`)

    const ok = await host.http(`${API}/agents/delete-section`, { method: 'POST', session: null, body: { index: 1, expectedTitle: 'Beta' } })
    check('没有过期时正常删除 → 200', ok.status === 200 && !text().includes('beta body'), `${ok.status}`)
    const added = await host.http(`${API}/agents/add-section`, { method: 'POST', session: null, body: { title: 'Gamma', body: 'gamma body' } })
    check('add-section → 200', added.status === 200 && text().includes('Gamma'))
  } finally {
    host.cleanup()
  }
}

section('任何路由都不把异常抛进宿主')
{
  const host = makeHost(mod)
  try {
    // AGENTS.md 是个目录：existsSync 为真、readFileSync 抛 EISDIR
    mkdirSync(host.agentsFile)
    for (const route of ['agents/sections', 'agents']) {
      let threw = null
      let res
      try {
        res = await host.http(`${API}/${route}`, { session: null })
      } catch (error) {
        threw = error
      }
      check(`GET ${route} 在 AGENTS.md 不可读时不抛`, threw === null, threw ? String(threw.message) : '')
      if (route === 'agents/sections') check('  …回 500 + ok:false', res?.status === 500 && res.body?.ok === false, `${res?.status}`)
    }
    for (const route of ['agents/save-section', 'agents/delete-section', 'agents/add-section']) {
      const res = await host.http(`${API}/${route}`, { method: 'POST', session: null, body: { index: 0, title: 't', body: 'b' } })
      check(`POST ${route} 在 AGENTS.md 不可读时回 JSON 错误而不抛`, res.body?.ok === false && res.status >= 400, `${res.status}`)
    }
  } finally {
    host.cleanup()
  }
}

section('/diag 已移除（它的开关 enableDiagEndpoint 也不再存在）')
{
  const host = makeHost(mod, { config: { enableDiagEndpoint: true } })
  try {
    check('没有注册 /diag 路由', !host.routes.has(`${API}/diag`))
    check('config 里残留 enableDiagEndpoint 只是被当作未知键忽略', mod.resolveConfig({ enableDiagEndpoint: true }).issues.some((issue) => issue.startsWith('enableDiagEndpoint')))
  } finally {
    host.cleanup()
  }
}

summary()
