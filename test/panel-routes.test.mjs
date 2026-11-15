/**
 * 面板重设计（2026-11-15）新增与变更的宿主路由，按接口约定 A–F 逐项测：
 *   A  GET  /project-agents          只读展示工作区根下的 AGENTS.md / AGENTS.local.md（固定文件名、不逃出工作区、64 KiB 截断）
 *   B  GET  /list                    增 workspace / limits / historyDir / pending[].slug（只增不改）
 *   C  GET  /agents、/agents/sections 增 limit / mtime / historyLimit / historyDir（agents-missing 也带）
 *   D  POST /promote                 项目记忆一步升为全局指令；写章节失败来源不动；删来源失败 ok + removeError
 *   E  POST /open-agents             可选 target: global | team | local；team / local 文件不存在 400 file-missing
 *   F  POST /agents/create           只在全局 AGENTS.md 不存在时创建；已存在 400 already-exists
 *
 * 全部在临时目录；agentsFile / memoryDir / globalMemoryDir 经 apply 的 rawConfig 传入（见 fake-host.mjs），
 * 结束时比对真实 ~/.dsh/AGENTS.md 与全局按需库的哈希。整个文件不真的启动任何进程（setSpawnForTests）。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { makeHost, makeReporter, realFilesGuard } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()
const API = '/api/dsh-workspace-memory'
const AGENTS = '# 规则\n\n## 1. Alpha\n\nalpha body\n'
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// 整个文件都不许真的启动进程：open-agents 会拉起编辑器或 `cmd /c start`
// 记录完整的 (command, args, options)：既要断言「启动了几次 / 带的是哪个文件」，也要断言命令行的引号形态与 windowsVerbatimArguments
const launches = []
const restoreSpawn = mod.setSpawnForTests((command, args, options) => {
  launches.push({ command, args, options, line: [command, ...args].join(' ') })
  const child = new EventEmitter()
  child.unref = () => {}
  return child
})

/** 建目录链接：Windows 上用 junction（不需要管理员权限），其它平台用普通符号链接。 */
const linkDir = (target, link) => symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')

/** 文件符号链接：Windows 没开开发者模式时 EPERM，返回 false 由调用方跳过。 */
const tryLinkFile = (target, link) => {
  try {
    symlinkSync(target, link, 'file')
    return true
  } catch {
    return false
  }
}

/**
 * 项目指令根 = instructionsRootFor(cwd)（往上最近的 .git）。测试工作区放在系统临时目录下，
 * 它的祖先目录里有没有 .git 由机器决定；在工作区里建一个 .git 目录，根就确定是工作区本身。
 */
const gitHost = (options) => {
  const host = makeHost(mod, options)
  mkdirSync(path.join(host.workspace, '.git'))
  return host
}

section('A /project-agents：缺 session、文件都不存在、正常读取、不接受客户端路径')
{
  const host = gitHost()
  try {
    for (const session of [null, 's-nope']) {
      const res = await host.http(`${API}/project-agents`, { session })
      check(`session=${JSON.stringify(session)} → 400 no-session`, res.status === 400 && res.body?.reason === 'no-session', `${res.status} ${JSON.stringify(res.body)}`)
    }
    const wrong = await host.http(`${API}/project-agents`, { method: 'POST', body: {} })
    check('只收 GET → POST 405', wrong.status === 405)

    const none = await host.http(`${API}/project-agents`)
    const absent = (info, name) =>
      info?.path === path.join(host.workspace, name) && info.exists === false && info.bytes === 0 && info.mtime === null && info.body === '' && info.truncated === false && !('error' in info)
    check('两个文件都不存在 → 200，exists:false / bytes:0 / mtime:null / body:"" / truncated:false', none.status === 200 && none.body.ok === true && absent(none.body.team, 'AGENTS.md') && absent(none.body.local, 'AGENTS.local.md'), JSON.stringify(none.body))
    check('  …workspace = { path: 工作区根, name: 最后一段（不是编码后的目录名）}', none.body.workspace?.path === host.workspace && none.body.workspace?.name === 'ws', JSON.stringify(none.body.workspace))
    check('  …root = 项目指令根（这里工作区本身就是 git 仓库根）', none.body.root?.path === host.workspace && none.body.root?.name === 'ws', JSON.stringify(none.body.root))

    const team = '# 团队约定\n\n- 提交前跑测试\n'
    host.write(path.join(host.workspace, 'AGENTS.md'), team)
    host.write(path.join(host.workspace, 'AGENTS.local.md'), '只对我：中文回答\n')
    // 客户端塞进来的路径参数一律不看
    const read = await host.http(`${API}/project-agents`, { query: 'path=..%2F..%2FAGENTS.md&file=C%3A%5CWindows%5Cwin.ini&team=..%2Fx' })
    const t = read.body.team
    check('team：正文、真实字节数、ISO mtime、未截断', read.status === 200 && t.exists === true && t.body === team && t.bytes === Buffer.byteLength(team) && ISO.test(t.mtime) && t.truncated === false && !('error' in t), JSON.stringify(t))
    check('  …path 仍是工作区根下的固定文件名（查询参数被忽略）', t.path === path.join(host.workspace, 'AGENTS.md') && read.body.local.path === path.join(host.workspace, 'AGENTS.local.md'))
    check('local：同样读出', read.body.local.exists === true && read.body.local.body === '只对我：中文回答\n', JSON.stringify(read.body.local))
    check('返回值没有 undefined / NaN（能被 JSON 原样往返）', JSON.stringify(read.body) === JSON.stringify(JSON.parse(JSON.stringify(read.body))))
  } finally {
    host.cleanup()
  }
}

section('A /project-agents：超过 64 KiB 按字符边界截断，bytes 仍是真实大小')
{
  const host = gitHost()
  try {
    const LIMIT = mod.PROJECT_AGENTS_MAX_BYTES
    check('上限是 64 KiB', LIMIT === 64 * 1024)
    const teamFile = path.join(host.workspace, 'AGENTS.md')
    const localFile = path.join(host.workspace, 'AGENTS.local.md')

    // 3 字节的「中」横跨截断点：前 LIMIT-1 个 a，「中」占 LIMIT-1..LIMIT+1
    const cjk = `${'a'.repeat(LIMIT - 1)}中tail`
    host.write(teamFile, cjk)
    // 4 字节的 emoji 横跨截断点：占 LIMIT-2..LIMIT+1
    const emoji = `${'b'.repeat(LIMIT - 2)}😀more`
    host.write(localFile, emoji)
    const cut = await host.http(`${API}/project-agents`)
    const t = cut.body.team
    const l = cut.body.local
    check('三字节字符跨界：退到字符之前，truncated:true，bytes = 文件真实大小', t.truncated === true && t.body === 'a'.repeat(LIMIT - 1) && t.bytes === Buffer.byteLength(cjk) && !t.body.includes('\uFFFD'), `${t.truncated} ${t.body.length} ${t.bytes}`)
    check('四字节字符跨界：同样不劈开（无替换字符），正文不超过上限', l.truncated === true && l.body === 'b'.repeat(LIMIT - 2) && Buffer.byteLength(l.body) <= LIMIT && !l.body.includes('\uFFFD') && l.bytes === Buffer.byteLength(emoji), `${l.truncated} ${l.body.length}`)

    // 正好 64 KiB 不算截断；多一个字节就截断
    host.write(teamFile, 'c'.repeat(LIMIT))
    host.write(localFile, `${'d'.repeat(LIMIT - 1)}中`)
    const edge = await host.http(`${API}/project-agents`)
    check('正好 64 KiB → 不截断，全文', edge.body.team.truncated === false && edge.body.team.body.length === LIMIT && edge.body.team.bytes === LIMIT)
    check('多字节字符刚好结束在上限之外 → 截断且不留半个字符', edge.body.local.truncated === true && edge.body.local.body === 'd'.repeat(LIMIT - 1), `${edge.body.local.body.length}`)

    const big = `${'中'.repeat(30000)}`
    host.write(teamFile, big)
    const many = await host.http(`${API}/project-agents`)
    check('全是多字节字符的大文件：截断后仍是合法 UTF-8、字节数 ≤ 上限、是原文前缀', many.body.team.truncated === true && Buffer.byteLength(many.body.team.body) <= LIMIT && big.startsWith(many.body.team.body) && many.body.team.body.length === Math.floor(LIMIT / 3))
  } finally {
    host.cleanup()
  }
}

section('A /project-agents：读不出来的单项带 error，整体仍 200；链接逃出工作区当作不存在')
{
  const host = gitHost()
  try {
    // 同名目录：存在但不是文件 → exists:true, body:'', error
    mkdirSync(path.join(host.workspace, 'AGENTS.md'))
    const dir = await host.http(`${API}/project-agents`)
    check('AGENTS.md 是目录 → 200，team.exists:true / body:"" / 带中文 error', dir.status === 200 && dir.body.team.exists === true && dir.body.team.body === '' && typeof dir.body.team.error === 'string' && /[\u4e00-\u9fff]/.test(dir.body.team.error) && dir.body.local.exists === false, JSON.stringify(dir.body))
    rmSync(path.join(host.workspace, 'AGENTS.md'), { recursive: true })

    // 目录链接指到工作区外（Windows 上是 junction）：realpath 不在工作区里 → 当作不存在，外面的内容一个字都不读
    const outside = path.join(host.root, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.md'), 'SECRET OUTSIDE')
    linkDir(outside, path.join(host.workspace, 'AGENTS.md'))
    const escaped = await host.http(`${API}/project-agents`)
    check('AGENTS.md 是指到工作区外的目录链接 → exists:false（当作不存在）', escaped.status === 200 && escaped.body.team.exists === false && escaped.body.team.body === '' && !('error' in escaped.body.team), JSON.stringify(escaped.body.team))

    // local 也走一遍逃逸分支——用 junction（不需要符号链接权限，本机一定执行到）：AGENTS.local.md 指向根外目录。
    // 文件符号链接是另一种形态、但本机多半没权限建；逃逸判定在 locateWorkspaceFile 里对两者同源（都看 realpath 是否在根内），
    // 这个 junction 用例已覆盖该分支，所以不再依赖符号链接权限。
    linkDir(outside, path.join(host.workspace, 'AGENTS.local.md'))
    const escapedLocal = await host.http(`${API}/project-agents`)
    check('AGENTS.local.md 是指到工作区外的链接 → exists:false，不泄露外部内容', escapedLocal.body.local.exists === false && escapedLocal.body.local.body === '' && !('error' in escapedLocal.body.local) && !JSON.stringify(escapedLocal.body).includes('SECRET'), JSON.stringify(escapedLocal.body.local))
    // 文件符号链接（指向根内文件应照常读）：只有在本机能建符号链接时才顺带验一下，建不了就跳过——逃逸分支上面已用 junction 覆盖
    rmSync(path.join(host.workspace, 'AGENTS.local.md'), { recursive: true, force: true })
    writeFileSync(path.join(host.workspace, 'inner.md'), 'inner body')
    if (tryLinkFile(path.join(host.workspace, 'inner.md'), path.join(host.workspace, 'AGENTS.local.md'))) {
      const inner = await host.http(`${API}/project-agents`)
      check('（可选）指向工作区内文件的符号链接照常读', inner.body.local.exists === true && inner.body.local.body === 'inner body', JSON.stringify(inner.body.local))
    } else {
      console.log('  SKIP  （可选）文件符号链接读取：本机无权限；逃逸分支已由上面的 junction 用例覆盖')
    }
    check('任何响应里都没有工作区外的内容', !JSON.stringify(escaped.body).includes('SECRET'))
  } finally {
    host.cleanup()
  }

  // 工作区根本身经链接进入：两边都取 realpath 再比，照常读
  const linked = gitHost()
  try {
    const via = path.join(linked.root, 'ws-link')
    linkDir(linked.workspace, via)
    linked.state.cwd = via
    linked.write(path.join(linked.workspace, 'AGENTS.md'), 'team via link')
    const res = await linked.http(`${API}/project-agents`)
    check('工作区根是链接时照常读，path / workspace / root 用会话看到的路径', res.body.team.exists === true && res.body.team.body === 'team via link' && res.body.workspace.path === via && res.body.root.path === via && res.body.team.path === path.join(via, 'AGENTS.md'), JSON.stringify(res.body))
  } finally {
    linked.cleanup()
  }
}

section('A / E 项目指令根 = instructionsRootFor（往上最近的 .git）：子仓库读子仓库根的文件，workspace 仍是工作区根')
{
  // 假的工作区注册表：工作区根注册的是 ws，会话 cwd 在 ws 下面一个子仓库的深处
  const registry = { roots: [], list() { return this.roots.map((root) => ({ path: root })) } }
  const host = makeHost(mod, { registry })
  try {
    registry.roots = [host.workspace]
    const sub = path.join(host.workspace, 'sub-repo')
    const deep = path.join(sub, 'src', 'deep')
    mkdirSync(path.join(sub, '.git'), { recursive: true })
    mkdirSync(deep, { recursive: true })
    host.state.cwd = deep
    host.write(path.join(host.workspace, 'AGENTS.md'), 'WORKSPACE ROOT TEAM')
    host.write(path.join(host.workspace, 'AGENTS.local.md'), 'WORKSPACE ROOT LOCAL')
    host.write(path.join(sub, 'AGENTS.md'), 'SUB REPO TEAM')
    host.write(path.join(sub, 'AGENTS.local.md'), 'SUB REPO LOCAL')

    const res = await host.http(`${API}/project-agents`)
    const b = res.body
    check('workspace = 工作区根（与 /list 同一口径）', b.workspace?.path === host.workspace && b.workspace?.name === 'ws', JSON.stringify(b.workspace))
    check('root = 子仓库根（宿主实际加载项目指令的目录）', b.root?.path === sub && b.root?.name === 'sub-repo', JSON.stringify(b.root))
    check('读到的是子仓库根的 AGENTS.md / AGENTS.local.md', b.team.body === 'SUB REPO TEAM' && b.team.path === path.join(sub, 'AGENTS.md') && b.local.body === 'SUB REPO LOCAL' && b.local.path === path.join(sub, 'AGENTS.local.md'), JSON.stringify(b))
    check('  …工作区根那两份一个字都没读', !JSON.stringify(b).includes('WORKSPACE ROOT'))
    const list = await host.http(`${API}/list`)
    check('/list 的 workspace 与 /project-agents 的 workspace 一致', list.body.workspace?.path === host.workspace, JSON.stringify(list.body.workspace))

    const n = launches.length
    const opened = await host.http(`${API}/open-agents`, { method: 'POST', body: { editor: 'system', target: 'team' } })
    check('/open-agents team 打开子仓库根的 AGENTS.md', opened.status === 200 && opened.body.agentsPath === path.join(sub, 'AGENTS.md') && launches.length === n + 1 && launches.at(-1).line.includes(path.join(sub, 'AGENTS.md')), JSON.stringify(opened.body))

    // 防逃逸以项目指令根为准：链接指到工作区里、但在子仓库根之外的目录，同样当作不存在
    rmSync(path.join(sub, 'AGENTS.local.md'))
    const sibling = path.join(host.workspace, 'sibling')
    mkdirSync(sibling)
    linkDir(sibling, path.join(sub, 'AGENTS.local.md'))
    const escaped = await host.http(`${API}/project-agents`)
    check('链接指到子仓库根之外（虽然还在工作区里）→ exists:false', escaped.body.local.exists === false && !('error' in escaped.body.local), JSON.stringify(escaped.body.local))
    const openEscaped = await host.http(`${API}/open-agents`, { method: 'POST', body: { editor: 'system', target: 'local' } })
    check('  …/open-agents local 同样 400 file-missing，不启动', openEscaped.status === 400 && openEscaped.body.reason === 'file-missing' && openEscaped.body.path === path.join(sub, 'AGENTS.local.md') && launches.length === n + 1, JSON.stringify(openEscaped.body))
  } finally {
    // 注册表清空并让插件重读一次，免得后面的用例沿用这个（马上要删掉的）工作区根
    registry.roots = []
    await host.http(`${API}/list`)
    host.cleanup()
  }

  // cwd 不在任何 git 仓库里：沿用 instructionsRootFor 的回落（cwd 本身）
  const plain = makeHost(mod)
  try {
    const cwd = path.join(plain.workspace, 'no-git', 'inner')
    mkdirSync(cwd, { recursive: true })
    plain.state.cwd = cwd
    const expected = mod.instructionsRootFor(cwd)
    const res = await plain.http(`${API}/project-agents`)
    check('root 与 instructionsRootFor(cwd) 一致', res.status === 200 && res.body.root?.path === expected, `${JSON.stringify(res.body.root)} vs ${expected}`)
    if (expected === cwd) {
      plain.write(path.join(cwd, 'AGENTS.md'), 'CWD TEAM')
      const again = await plain.http(`${API}/project-agents`)
      check('没有 .git → 根回落到 cwd 本身，读 cwd 下的 AGENTS.md', again.body.root.path === cwd && again.body.root.name === 'inner' && again.body.team.body === 'CWD TEAM' && again.body.team.path === path.join(cwd, 'AGENTS.md'), JSON.stringify(again.body))
      check('  …workspace 仍是 projectRootFor（没有注册工作区时就是 cwd）', again.body.workspace.path === cwd, JSON.stringify(again.body.workspace))
    } else {
      console.log(`  SKIP  回落到 cwd：本机临时目录的祖先里有 .git（${expected}），无法构造「不在任何 git 仓库里」`)
    }
  } finally {
    plain.cleanup()
  }
}

section('B /list：新增 workspace / limits / historyDir / pending[].slug，原字段不变')
{
  const host = makeHost(mod, { config: { maxMemoryCount: 12, maxTitleChars: 150, maxBodyChars: 5000, maxTags: 7, maxTagChars: 30 } })
  try {
    mod.writeMemory(host.memoryDir, { slug: 'kept', title: 'Kept', body: 'kept body' })
    mod.writePending(host.memoryDir, { id: 'dr_slug', title: '有 slug', body: 'x', slug: 'My Draft Slug' })
    mod.writePending(host.memoryDir, { id: 'dr_noslug', title: '没 slug', body: 'x' })
    const res = await host.http(`${API}/list`)
    const body = res.body
    check('原字段都在', res.status === 200 && body.ok === true && body.root === host.memoryDir && body.globalRoot === host.globalDir && Array.isArray(body.memories) && Array.isArray(body.pending) && 'pendingEnabled' in body && body.agentWrites === 'direct')
    check('workspace = { path, name }', body.workspace?.path === host.workspace && body.workspace?.name === 'ws', JSON.stringify(body.workspace))
    check('limits 取宿主实际生效的值（配置 + validateMemoryPatch 的常量）',
      JSON.stringify(body.limits) === JSON.stringify({ maxMemoryCount: 12, maxTitleChars: 150, maxDescriptionChars: 120, maxBodyChars: 5000, maxTags: 7, maxTagChars: 30 }),
      JSON.stringify(body.limits))
    check('historyDir 两个库各自的 .memory-state/history',
      body.historyDir?.project === path.join(host.root, 'proj', '.memory-state', 'history') && body.historyDir?.global === path.join(host.root, 'global', '.memory-state', 'history'),
      JSON.stringify(body.historyDir))
    const bySlug = new Map(body.pending.map((d) => [d.id, d]))
    check('pending[].slug = 草稿 frontmatter 里的文件名', bySlug.get('dr_slug')?.slug === 'my-draft-slug', JSON.stringify(bySlug.get('dr_slug')))
    check('  …草稿没有 slug → 空串（不是 undefined）', bySlug.get('dr_noslug')?.slug === '' && bySlug.get('dr_noslug')?.status === 'draft')
    check('  …已确认条目不加 slug（只增在草稿上）', !('slug' in body.memories[0]))

    // 限值与 validateMemoryPatch 一致：标题 151 字被拒、150 字通过
    const longTitle = await host.http(`${API}/save`, { method: 'POST', body: { id: 'kept', patch: { title: 'x'.repeat(151) } } })
    const okTitle = await host.http(`${API}/save`, { method: 'POST', body: { id: 'kept', patch: { title: 'x'.repeat(150) } } })
    check('limits.maxTitleChars 就是保存时的闸门', longTitle.status === 400 && okTitle.status === 200, `${longTitle.status} ${okTitle.status}`)
    const longDesc = await host.http(`${API}/save`, { method: 'POST', body: { id: 'kept', patch: { description: 'd'.repeat(121) } } })
    check('limits.maxDescriptionChars 就是保存时的闸门', longDesc.status === 400)
  } finally {
    host.cleanup()
  }
}

section('C /agents 与 /agents/sections：limit / mtime / historyLimit / historyDir')
{
  const host = makeHost(mod, { config: { maxAgentsBytes: 4321 } })
  try {
    const missing = await host.http(`${API}/agents`, { session: null })
    const a0 = missing.body.agents
    check('/agents 文件不存在：exists:false，仍带 limit / historyDir，mtime:null', missing.status === 200 && a0.exists === false && a0.limit === 4321 && a0.mtime === null && a0.historyLimit === 20 && a0.historyDir === path.join(host.root, '.agents-history'), JSON.stringify(a0))
    const sec0 = await host.http(`${API}/agents/sections`, { session: null })
    check('/agents/sections 文件不存在：agents-missing（仍是 200），顶层带 limit / historyDir', sec0.status === 200 && sec0.body.ok === false && sec0.body.reason === 'agents-missing' && sec0.body.limit === 4321 && sec0.body.historyDir === path.join(host.root, '.agents-history') && sec0.body.mtime === null, JSON.stringify(sec0.body))

    host.write(host.agentsFile, AGENTS)
    const res = await host.http(`${API}/agents`, { session: null })
    const a = res.body.agents
    check('/agents：原字段 + limit / mtime(ISO) / historyLimit / historyDir 都在 agents 对象里', a.exists === true && a.bytes === Buffer.byteLength(AGENTS) && a.sections === 1 && a.limit === 4321 && ISO.test(a.mtime) && a.historyLimit === 20 && a.historyDir === path.join(host.root, '.agents-history') && Array.isArray(res.body.editors) && !('limit' in res.body), JSON.stringify(res.body))
    const sec = await host.http(`${API}/agents/sections`, { session: null })
    check('/agents/sections：字段放在顶层，章节照旧', sec.body.ok === true && sec.body.sections.length === 1 && sec.body.limit === 4321 && ISO.test(sec.body.mtime) && sec.body.historyLimit === 20 && sec.body.historyDir === a.historyDir, JSON.stringify({ ...sec.body, sections: undefined }))

    // 写入后备份确实落在 historyDir 里
    await host.http(`${API}/agents/add-section`, { method: 'POST', session: null, body: { title: 'Beta', body: 'b' } })
    check('写章节后备份落在 historyDir 里', existsSync(a.historyDir))
  } finally {
    host.cleanup()
  }

  const unlimited = makeHost(mod, { config: { maxAgentsBytes: 0 } })
  try {
    unlimited.write(unlimited.agentsFile, AGENTS)
    const res = await unlimited.http(`${API}/agents/sections`, { session: null })
    check('maxAgentsBytes: 0 → limit 0（不限）', res.body.limit === 0, JSON.stringify(res.body.limit))
  } finally {
    unlimited.cleanup()
  }
}

section('D /promote：项目记忆一步升为全局指令')
{
  const host = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    host.write(host.agentsFile, AGENTS)
    mod.writeMemory(host.memoryDir, { slug: 'proj-rule', title: '项目里的做法', body: '先写测试再改代码。', type: 'project' })
    const noScope = await host.http(`${API}/promote`, { method: 'POST', body: { id: 'proj-rule' } })
    check('只在项目库、没带 scope → 200，fromScope: project（不再 scope-not-global）', noScope.status === 200 && noScope.body.ok === true && noScope.body.fromScope === 'project' && noScope.body.scope === 'project' && noScope.body.memoryRemoved === true && !('removeError' in noScope.body), JSON.stringify(noScope.body))
    check('  …AGENTS.md 追加了新章，记忆移出项目库，删前留了历史', host.read(host.agentsFile).includes('## 2. 项目里的做法') && !existsSync(path.join(host.memoryDir, 'proj-rule.md')) && mod.listHistory(host.memoryDir, 'proj-rule').length === 1)

    mod.writeMemory(host.memoryDir, { slug: 'proj-two', title: '第二条', body: '第二条正文。' })
    const explicit = await host.http(`${API}/promote`, { method: 'POST', body: { id: 'proj-two', scope: 'project' } })
    check('显式 scope: project 同样成功', explicit.status === 200 && explicit.body.fromScope === 'project', JSON.stringify(explicit.body))

    mod.writeMemory(host.globalDir, { slug: 'glob-one', title: '通用的一条', body: '通用正文。', scope: 'global' })
    const fromGlobal = await host.http(`${API}/promote`, { method: 'POST', body: { id: 'glob-one', scope: 'global' } })
    check('通用记忆照旧，fromScope: global', fromGlobal.status === 200 && fromGlobal.body.fromScope === 'global' && !existsSync(path.join(host.globalDir, 'glob-one.md')), JSON.stringify(fromGlobal.body))

    const missing = await host.http(`${API}/promote`, { method: 'POST', body: { id: 'no-such' } })
    check('不存在的 id → 400 not-found（不变）', missing.status === 400 && missing.body.reason === 'not-found')

    // 写章节失败：同名章已存在 → 来源不动
    mod.writeMemory(host.memoryDir, { slug: 'dup', title: 'Alpha', body: '会撞名。' })
    const before = host.read(host.agentsFile)
    const dup = await host.http(`${API}/promote`, { method: 'POST', body: { id: 'dup', scope: 'project' } })
    check('同名章已存在 → 400 already-present，来源条目与 AGENTS.md 都不动', dup.status === 400 && dup.body.reason === 'already-present' && existsSync(path.join(host.memoryDir, 'dup.md')) && host.read(host.agentsFile) === before && mod.listHistory(host.memoryDir, 'dup').length === 0, JSON.stringify(dup.body))
  } finally {
    host.cleanup()
  }

  const full = makeHost(mod, { config: { duplicateCheck: false, maxAgentsBytes: 120 } })
  try {
    full.write(full.agentsFile, AGENTS)
    mod.writeMemory(full.memoryDir, { slug: 'big', title: '很长的一条', body: '长'.repeat(200) })
    const res = await full.http(`${API}/promote`, { method: 'POST', body: { id: 'big', scope: 'project' } })
    check('超字节上限 → 400 agents-full，来源条目不动', res.status === 400 && res.body.reason === 'agents-full' && Number.isFinite(res.body.limit) && existsSync(path.join(full.memoryDir, 'big.md')) && full.read(full.agentsFile) === AGENTS, JSON.stringify(res.body))
    rmSync(full.agentsFile)
    const gone = await full.http(`${API}/promote`, { method: 'POST', body: { id: 'big' } })
    check('全局 AGENTS.md 不存在 → 400 agents-missing，来源条目不动', gone.status === 400 && gone.body.reason === 'agents-missing' && existsSync(path.join(full.memoryDir, 'big.md')), JSON.stringify(gone.body))
  } finally {
    full.cleanup()
  }

  const stuck = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    stuck.write(stuck.agentsFile, AGENTS)
    mod.writeMemory(stuck.memoryDir, { slug: 'locked', title: '删不掉的', body: '删不掉的正文。' })
    const restore = mod.setRemoveFileForTests(() => {
      throw Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' })
    })
    let res
    try {
      res = await stuck.http(`${API}/promote`, { method: 'POST', body: { id: 'locked', scope: 'project' } })
    } finally {
      restore()
    }
    check('写章节成功、删来源失败 → 200 ok:true, memoryRemoved:false, removeError（中文）', res.status === 200 && res.body.ok === true && res.body.memoryRemoved === false && typeof res.body.removeError === 'string' && res.body.removeError.includes('项目记忆') && res.body.fromScope === 'project', JSON.stringify(res.body))
    check('  …章节已写入，来源条目还在，删除前照旧归档了历史', stuck.read(stuck.agentsFile).includes('删不掉的') && existsSync(path.join(stuck.memoryDir, 'locked.md')) && mod.listHistory(stuck.memoryDir, 'locked').length === 1)
    check('  …removeError 不含 undefined', !/undefined/.test(res.body.removeError))
  } finally {
    stuck.cleanup()
  }
}

section('E /open-agents：target global | team | local')
{
  const host = gitHost()
  try {
    host.write(host.agentsFile, AGENTS)
    const teamFile = path.join(host.workspace, 'AGENTS.md')
    const localFile = path.join(host.workspace, 'AGENTS.local.md')
    const launched = () => launches.length

    let n = launched()
    const dflt = await host.http(`${API}/open-agents`, { method: 'POST', session: null, body: { editor: 'system' } })
    check('不带 target → 打开全局 AGENTS.md（不需要 session，与以前一致）', dflt.status === 200 && dflt.body.ok === true && dflt.body.agentsPath === host.agentsFile && launched() === n + 1 && launches.at(-1).line.includes(host.agentsFile), JSON.stringify(dflt.body))
    n = launched()
    const glob = await host.http(`${API}/open-agents`, { method: 'POST', session: null, body: { editor: 'system', target: 'global' } })
    check('target: global → 同上', glob.status === 200 && glob.body.agentsPath === host.agentsFile && launched() === n + 1)

    n = launched()
    const noSession = await host.http(`${API}/open-agents`, { method: 'POST', session: null, body: { editor: 'system', target: 'team' } })
    check('target: team 不带 session → 400 no-session，不启动', noSession.status === 400 && noSession.body.reason === 'no-session' && launched() === n, JSON.stringify(noSession.body))
    const teamMissing = await host.http(`${API}/open-agents`, { method: 'POST', body: { editor: 'system', target: 'team' } })
    check('team 文件不存在 → 400 file-missing（带 path），不启动、不新建', teamMissing.status === 400 && teamMissing.body.reason === 'file-missing' && teamMissing.body.path === teamFile && launched() === n && !existsSync(teamFile), JSON.stringify(teamMissing.body))
    const localMissing = await host.http(`${API}/open-agents`, { method: 'POST', body: { editor: 'system', target: 'local' } })
    check('local 文件不存在 → 400 file-missing（带 path）', localMissing.status === 400 && localMissing.body.reason === 'file-missing' && localMissing.body.path === localFile && launched() === n, JSON.stringify(localMissing.body))

    // 非法 target 一律 invalid-target（不是 file-missing）：['team'] 这种数组尤其要先判 typeof，否则
    // Object.hasOwn 会把它转成字符串 'team' 当成命中。先建好 team 文件，确保 ['team'] 若被当成 team 就会启动——这样断言「没启动」才有意义。
    host.write(teamFile, '# team\n')
    for (const target of ['evil', '../AGENTS', 'TEAM', 5, {}, ['team'], true]) {
      const bad = await host.http(`${API}/open-agents`, { method: 'POST', body: { editor: 'system', target } })
      check(`target=${JSON.stringify(target)} → 400 invalid-target，不启动`, bad.status === 400 && bad.body.reason === 'invalid-target' && launched() === n, `${bad.status} ${JSON.stringify(bad.body)}`)
    }
    rmSync(teamFile)

    host.write(teamFile, '# team\n')
    host.write(localFile, '# local\n')
    const team = await host.http(`${API}/open-agents`, { method: 'POST', body: { editor: 'system', target: 'team', path: 'C:\\Windows\\win.ini', file: '../x' } })
    check('team 存在 → 200，agentsPath 是实际打开的固定文件（请求里的路径字段被忽略）', team.status === 200 && team.body.ok === true && team.body.agentsPath === teamFile && launched() === n + 1 && launches.at(-1).line.includes(teamFile) && !launches.at(-1).line.includes('win.ini'), JSON.stringify(team.body))
    const local = await host.http(`${API}/open-agents`, { method: 'POST', body: { editor: 'system', target: 'local' } })
    check('local 存在 → 200，打开 AGENTS.local.md', local.status === 200 && local.body.agentsPath === localFile && launched() === n + 2 && launches.at(-1).line.includes(localFile), JSON.stringify(local.body))

    // 系统默认打开交给 cmd 的命令行必须安全：路径在一对引号里、windowsVerbatimArguments，start 的标题位是空 ""
    const lastLaunch = () => launches.at(-1)
    if (process.platform !== 'win32') {
      // 非 Windows 平台的「系统默认」走 xdg-open/open，没有 cmd 引号这回事
      console.log('  SKIP  非 Windows 平台：系统默认打开不是 cmd /d /s /c')
    } else {
      check('系统默认打开用 cmd /d /s /c + windowsVerbatimArguments，整条命令行自己拼', (() => {
        const l = lastLaunch()
        return l.command === 'cmd' && l.args[0] === '/d' && l.args[1] === '/s' && l.args[2] === '/c' && l.args.length === 4 &&
          l.options?.windowsVerbatimArguments === true &&
          l.args[3] === `"start "" "${localFile}""`
      })(), JSON.stringify({ args: lastLaunch().args, opts: lastLaunch().options }))
    }
  } finally {
    host.cleanup()
  }
}

if (process.platform !== 'win32') {
  // 下面这整段验证的是 Windows 的 cmd 引号形态（& ^ ; % 与空格），其它平台不适用
  section('E /open-agents：系统默认打开时路径里的 shell 特殊字符不被 cmd 解释；% 与引号被拒')
  console.log('  SKIP  非 Windows 平台：cmd 引号形态不适用')
} else {
  // 项目指令根的目录名里带 cmd 的特殊字符：& ( ) ^ ; 空格 逗号 ! @ = +（都是 Windows 合法文件名字符）
  // 在 cmd 双引号内它们都是普通字符，不能被当语法执行（复现 02）。`| < > "` 是 Windows 非法文件名字符，
  // 根本进不了路径；我们的引号形态对它们也安全，但无法用真实目录构造，故不在此列。
  for (const dirName of ['p&ver&echo', 'x, y', 'has space', 'r(a)^b;c', 'at@and=plus+bang!']) {
    const host = gitHost()
    try {
      // 在工作区下建一个带特殊字符名字的子仓库，cwd 落进去，项目指令根就是它
      const repo = path.join(host.workspace, dirName)
      mkdirSync(path.join(repo, '.git'), { recursive: true })
      const teamFile = path.join(repo, 'AGENTS.md')
      writeFileSync(teamFile, '# team\n')
      host.state.cwd = repo
      const n = launches.length
      const res = await host.http(`${API}/open-agents`, { method: 'POST', body: { editor: 'system', target: 'team' } })
      const l = launches.at(-1)
      check(`目录名「${dirName}」：200 且命令行把整条路径放进一对引号（windowsVerbatimArguments）`, res.status === 200 && launches.length === n + 1 && l.command === 'cmd' && l.options?.windowsVerbatimArguments === true && l.args[3] === `"start "" "${teamFile}""`, JSON.stringify(l.args))
      check(`  …特殊字符只作为路径内容出现一次，不在引号外`, l.args[3].split(dirName).length === 2 && l.args[3].endsWith(`${path.sep}AGENTS.md""`), l.args[3])
    } finally {
      host.cleanup()
    }
  }

  // 路径含 % 或 "（% 会被 cmd 展开、" 会提前闭合引号）→ 拒绝，不启动任何进程
  for (const dirName of ['q%OS%q', 'a%PATH%b']) {
    const host = gitHost()
    try {
      const repo = path.join(host.workspace, dirName)
      mkdirSync(path.join(repo, '.git'), { recursive: true })
      writeFileSync(path.join(repo, 'AGENTS.md'), '# team\n')
      host.state.cwd = repo
      const n = launches.length
      const res = await host.http(`${API}/open-agents`, { method: 'POST', body: { editor: 'system', target: 'team' } })
      check(`目录名「${dirName}」含 % → 400 launch-failed，不启动任何进程`, res.status === 400 && res.body.reason === 'launch-failed' && typeof res.body.error === 'string' && res.body.error.includes('%') && launches.length === n, `${res.status} ${JSON.stringify(res.body)} launched+${launches.length - n}`)
    } finally {
      host.cleanup()
    }
  }
}

section('E /open-agents：链接逃出工作区 / 非 JSON')
{
  const host = gitHost()
  try {
    const teamFile = path.join(host.workspace, 'AGENTS.md')
    const launched = () => launches.length
    let n = launched()

    // 链接逃出工作区：与 /project-agents 同一套校验，当作不存在
    const outside = path.join(host.root, 'outside-open')
    mkdirSync(outside)
    linkDir(outside, teamFile)
    n = launched()
    const escaped = await host.http(`${API}/open-agents`, { method: 'POST', body: { editor: 'system', target: 'team' } })
    check('team 是指到工作区外的链接 → 400 file-missing，不启动', escaped.status === 400 && escaped.body.reason === 'file-missing' && launched() === n, JSON.stringify(escaped.body))

    const notJson = await host.http(`${API}/open-agents`, { method: 'POST', headers: { 'content-type': 'text/plain' }, rawBody: JSON.stringify({ target: 'local' }) })
    check('非 JSON → 415，不启动', notJson.status === 415 && launched() === n)
  } finally {
    host.cleanup()
  }
}

section('F /agents/create：只在全局 AGENTS.md 不存在时创建')
{
  const temp = mkdtempSync(path.join(os.tmpdir(), 'wsm-create-'))
  const nested = path.join(temp, 'nested', 'deeper', 'AGENTS.md')
  const host = makeHost(mod, { config: { agentsFile: nested } })
  try {
    const getIt = await host.http(`${API}/agents/create`, { session: null })
    check('只收 POST → GET 405', getIt.status === 405 && !existsSync(nested))
    const notJson = await host.http(`${API}/agents/create`, { method: 'POST', session: null, headers: { 'content-type': 'text/plain' }, rawBody: '{}' })
    check('非 JSON → 415，不创建', notJson.status === 415 && !existsSync(nested))

    const created = await host.http(`${API}/agents/create`, { method: 'POST', session: null, body: {} })
    check('不存在 → 200 { ok, path, bytes }，父目录一并创建', created.status === 200 && created.body.ok === true && created.body.path === nested && created.body.bytes === Buffer.byteLength('# AGENTS.md\n') && existsSync(nested), JSON.stringify(created.body))
    check('  …内容是一行 `# AGENTS.md`', readFileSync(nested, 'utf8') === '# AGENTS.md\n')
    const sections = await host.http(`${API}/agents/sections`, { session: null })
    check('  …新文件没有章（那一行是前言）', sections.body.ok === true && sections.body.sections.length === 0 && sections.body.preamble === '# AGENTS.md', JSON.stringify(sections.body))
    const added = await host.http(`${API}/agents/add-section`, { method: 'POST', session: null, body: { title: '第一章', body: '内容' } })
    check('  …之后可以直接新增章', added.status === 200 && readFileSync(nested, 'utf8').startsWith('# AGENTS.md\n\n## 1. 第一章'), readFileSync(nested, 'utf8'))

    const before = readFileSync(nested, 'utf8')
    const again = await host.http(`${API}/agents/create`, { method: 'POST', session: null, body: {} })
    check('已存在 → 409 already-exists（带 path），内容一个字节不变', again.status === 409 && again.body.ok === false && again.body.reason === 'already-exists' && again.body.path === nested && readFileSync(nested, 'utf8') === before, JSON.stringify(again.body))
  } finally {
    host.cleanup()
    rmSync(temp, { recursive: true, force: true })
  }

  // 同名目录也算已存在，不去动它
  const dirHost = makeHost(mod)
  try {
    mkdirSync(dirHost.agentsFile)
    const res = await dirHost.http(`${API}/agents/create`, { method: 'POST', session: null, body: {} })
    check('AGENTS.md 位置是个目录 → 409 already-exists', res.status === 409 && res.body.reason === 'already-exists', JSON.stringify(res.body))
  } finally {
    dirHost.cleanup()
  }

  // 悬空 junction：existsSync 为 false，但那个位置已经有目录项——必须 already-exists，且不能穿过链接在目标处建东西
  const danglingTemp = mkdtempSync(path.join(os.tmpdir(), 'wsm-create-dangling-'))
  const linkHost = makeHost(mod, { config: { agentsFile: path.join(danglingTemp, 'AGENTS.md') } })
  try {
    const link = path.join(danglingTemp, 'AGENTS.md')
    const deadTarget = path.join(danglingTemp, 'no-such-dir')
    linkDir(deadTarget, link) // 指向一个还不存在的目录
    check('（自检）existsSync 为 false、位置确实是悬空链接', !existsSync(link) && lstatSync(link, { throwIfNoEntry: false }) && !existsSync(deadTarget))
    const res = await linkHost.http(`${API}/agents/create`, { method: 'POST', session: null, body: {} })
    check('悬空 junction → 409 already-exists（不覆盖、不新建）', res.status === 409 && res.body.reason === 'already-exists' && res.body.path === link, JSON.stringify(res.body))
    check('  …没有穿过链接在目标处建出目录', !existsSync(deadTarget), `deadTarget 存在? ${existsSync(deadTarget)}`)
  } finally {
    linkHost.cleanup()
    rmSync(danglingTemp, { recursive: true, force: true })
  }
}

section('一致性：项目 AGENTS.md 是目录时，/project-agents 与 /open-agents 说法一致（同一套 locateWorkspaceFile 分类）')
{
  const host = gitHost()
  try {
    // team 位置是个目录（不是普通文件）：读端 exists:true + error，动作端 file-missing，都来自 locateWorkspaceFile 的 'error' 分类
    mkdirSync(path.join(host.workspace, 'AGENTS.md'))
    const read = await host.http(`${API}/project-agents`)
    check('/project-agents：team.exists:true + 中文 error，正文为空', read.status === 200 && read.body.team.exists === true && read.body.team.body === '' && typeof read.body.team.error === 'string', JSON.stringify(read.body.team))
    const n = launches.length
    const open = await host.http(`${API}/open-agents`, { method: 'POST', body: { editor: 'system', target: 'team' } })
    check('/open-agents：同一个目录 → 400 file-missing，不启动', open.status === 400 && open.body.reason === 'file-missing' && open.body.path === path.join(host.workspace, 'AGENTS.md') && launches.length === n, JSON.stringify(open.body))
  } finally {
    host.cleanup()
  }
}

section('新原因码登记在 REASON_STATUS：file-missing 400、already-exists 409')
{
  const host = gitHost()
  try {
    host.write(path.join(host.workspace, 'placeholder.txt'), '')
    const missing = await host.http(`${API}/open-agents`, { method: 'POST', body: { editor: 'system', target: 'local' } })
    host.write(host.agentsFile, AGENTS)
    const exists = await host.http(`${API}/agents/create`, { method: 'POST', session: null, body: {} })
    check('file-missing → 400、already-exists → 409', missing.status === 400 && missing.body.reason === 'file-missing' && exists.status === 409 && exists.body.reason === 'already-exists')
  } finally {
    host.cleanup()
  }
}

restoreSpawn()
check('真实的 ~/.dsh/AGENTS.md 与全局按需库一个字节没变', guard.unchanged())
summary()
