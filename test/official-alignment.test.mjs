/**
 * 对齐 DSH 官方插件开发说明（2026-11-14 第二轮）的几项行为：
 *
 *   · dshHome()：显式配置 > 非空白的 $DSH_HOME > ~/.dsh（官方 dsh-home-paths）；
 *   · 入参自行校验（官方 tools.md：raw JSON-Schema 工具自己校验输入）；
 *   · supersedes 跨库：工具与面板共用 moveMemory（官方 user-actions.md）；
 *   · 项目指令根 = 往上最近的 .git 目录（官方 dsh-agent-instructions 的 findProjectRoot）；
 *   · 证据只认人亲手发的 user/message（source.kind === 'user'；官方 session.md / persistence-catalog）；
 *   · 回合收尾的抽取接上 payload.signal（官方 core.md：agent/turn-stopping 的 payload 带 signal）。
 * 第三轮补充：
 *   · dshHomeDisplay()：文字里的主目录用符号形式，默认 `~/.dsh`，配置过 `$DSH_HOME`（官方 dsh-home-paths「Displaying a home」）；
 *   · memory_recall / memory_forget / memory_status 的说明只写行为与返回（官方 tool-design.md）。
 * pre-step 缓存与证据取数顺序在 evidence-cache.test.mjs；召回的「写于何时」在 recall-age.test.mjs。
 *
 * post-execute 的契约在 paths-hint.test.mjs 与 remember-hardening.test.mjs；§6.1 的提示词结构在 admission.test.mjs。
 * 全部在临时目录；DSH_HOME 只在用例里临时改、用完恢复，且只比较路径字符串，不去碰它指向的目录。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT, injectedEvent, makeHost, makeReporter, realFilesGuard, userEvent } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()
const ids = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').map((n) => n.slice(0, -3)).sort() : [])

/** 临时改 DSH_HOME 跑 fn，结束后原样恢复（包括「原来没设」）。 */
function withDshHome(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME')
  const saved = process.env.DSH_HOME
  try {
    if (value === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = value
    return fn()
  } finally {
    if (had) process.env.DSH_HOME = saved
    else delete process.env.DSH_HOME
  }
}

section('dshHome()：$DSH_HOME 非空白就用它，否则 ~/.dsh')
{
  const envBefore = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME') ? process.env.DSH_HOME : null
  mod.configure(undefined)
  const fallback = path.join(os.homedir(), '.dsh')
  const custom = path.join(os.tmpdir(), 'wsm-dsh-home-probe')

  withDshHome(undefined, () => {
    check('没设 → ~/.dsh（与改动前完全一致）', mod.dshHome() === fallback, mod.dshHome())
    check('  …全局按需库默认在 ~/.dsh/dsh-workspace-memory/global/memory', mod.globalMemoryDirOf() === path.join(fallback, 'dsh-workspace-memory', 'global', 'memory'))
  })
  withDshHome(custom, () => {
    check('设了 → 用它', mod.dshHome() === path.resolve(custom), mod.dshHome())
    check('  …全局按需库跟着走', mod.globalMemoryDirOf() === path.join(path.resolve(custom), 'dsh-workspace-memory', 'global', 'memory'), mod.globalMemoryDirOf())
  })
  for (const blank of ['', '   ', '\t']) {
    withDshHome(blank, () => check(`空白 ${JSON.stringify(blank)} → 视为没设（不会 resolve 成当前目录）`, mod.dshHome() === fallback, mod.dshHome()))
  }
  withDshHome('~', () => check('「~」→ 系统主目录', mod.dshHome() === path.resolve(os.homedir())))
  withDshHome('~/dsh-elsewhere', () => check('「~/x」→ 系统主目录下的 x', mod.dshHome() === path.join(os.homedir(), 'dsh-elsewhere'), mod.dshHome()))
  withDshHome(custom, () => {
    const explicit = path.join(os.tmpdir(), 'wsm-explicit-global', 'memory')
    mod.configure({ globalMemoryDir: explicit })
    check('显式配置优先于 DSH_HOME', mod.globalMemoryDirOf() === explicit)
    mod.configure(undefined)
  })
  const envAfter = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME') ? process.env.DSH_HOME : null
  check('用完恢复了环境变量（原来没设就还是没设）', envAfter === envBefore, `${JSON.stringify(envBefore)} → ${JSON.stringify(envAfter)}`)
}

section('入参自行校验：type 必填且在枚举里；scope / load 缺省取默认、非法拒写；source 非法按 agent')
{
  const h = makeHost(mod, { config: { duplicateCheck: false, agentWrites: 'review' } })
  try {
    const base = { slug: 'valid-one', title: 'Valid', body: 'body text', source: 'agent' }
    const nothingWritten = () => ids(h.memoryDir).length === 0 && ids(h.globalDir).length === 0 && mod.listPending(h.memoryDir).length === 0

    const missingType = await h.tool('memory_remember', { ...base, type: undefined })
    // §13 起允许值多了三个「不是记忆」的改道取值（procedure / repo-rule / docs）
    check('type 缺失 → invalid-argument，列出允许值', missingType.reason === 'invalid-argument' && missingType.written === false && missingType.argument === 'type' &&
      missingType.allowed?.join() === 'user,feedback,project,reference,pitfall,procedure,repo-rule,docs' &&
      /Allowed values: user, feedback, project, reference, pitfall, procedure, repo-rule, docs/.test(missingType.text), JSON.stringify(missingType))
    const badType = await h.tool('memory_remember', { ...base, type: 'lesson' })
    check('type 不在枚举里 → invalid-argument（以前静默回落成 project）', badType.reason === 'invalid-argument' && badType.argument === 'type' && /"lesson"/.test(badType.text), JSON.stringify(badType))
    const badScope = await h.tool('memory_remember', { ...base, type: 'project', scope: 'workspace' })
    check('scope 非法 → invalid-argument（以前静默当成 project）', badScope.reason === 'invalid-argument' && badScope.argument === 'scope' && badScope.allowed?.join() === 'project,global', JSON.stringify(badScope))
    const badLoad = await h.tool('memory_remember', { ...base, type: 'project', scope: 'global', load: 'sometimes' })
    check('load 非法 → invalid-argument（以前静默当成 on-demand）', badLoad.reason === 'invalid-argument' && badLoad.argument === 'load' && badLoad.allowed?.join() === 'on-demand,always', JSON.stringify(badLoad))
    const noBody = await h.tool('memory_remember', { ...base, type: 'project', body: '   ' })
    check('body 空白 → invalid-argument', noBody.reason === 'invalid-argument' && noBody.argument === 'body', JSON.stringify(noBody))
    const noTitle = await h.tool('memory_remember', { ...base, type: 'project', title: 42 })
    check('title 不是字符串 → invalid-argument', noTitle.reason === 'invalid-argument' && noTitle.argument === 'title', JSON.stringify(noTitle))
    check('  …以上都一个字没写（两个库、待确认队列）', nothingWritten())

    const defaults = await h.tool('memory_remember', { ...base, type: 'project' })
    check('scope / load 缺省 → project + on-demand（进项目库的待确认）', defaults.pending === true && defaults.scope === 'project' && defaults.load === 'on-demand', JSON.stringify(defaults))
    const blanks = await h.tool('memory_remember', { ...base, slug: 'blank-choices', title: 'Blank choices', type: 'project', scope: '', load: '  ' })
    check('scope / load 给空白串 = 没给，取默认值', blanks.pending === true && blanks.scope === 'project' && blanks.load === 'on-demand', JSON.stringify(blanks))
    const weirdSource = await h.tool('memory_remember', { ...base, slug: 'weird-source', title: 'Weird source', type: 'project', source: 'boss' })
    check('source 非法 → 按 agent 处理（进待确认 agent-review），不拒写', weirdSource.pending === true && weirdSource.reason === 'agent-review', JSON.stringify(weirdSource))
  } finally {
    h.cleanup()
  }
}

section('supersedes 跨库：新内容写入目标库，旧条在原库留档后删除（与面板移动共用 moveMemory）')
{
  // 直写：新 slug
  const a = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    mod.writeMemory(a.globalDir, { slug: 'old-rule', title: 'Old rule', description: 'old', body: 'the old global body', scope: 'global', type: 'feedback' })
    const res = await a.tool('memory_remember', { slug: 'new-rule', title: 'New rule', body: 'the new project body', type: 'feedback', source: 'agent', scope: 'project', supersedes: 'old-rule' })
    check('目标库（项目）写入新条', typeof res.id === 'string' && res.id === 'new-rule' && ids(a.memoryDir).join() === 'new-rule', JSON.stringify(res))
    check('  …原库（全局）里旧条没了', !ids(a.globalDir).includes('old-rule'))
    check('  …旧内容在原库 history 里留档', mod.listHistory(a.globalDir, 'old-rule').length >= 1)
    check('  …返回 replaced + replacedFrom，文本说明来自另一个库', res.replaced === 'old-rule' && res.replacedFrom === 'global' && /came from the all-projects/.test(res.text), JSON.stringify(res))
    check('  …新条记着取代了谁', mod.listMemories(a.memoryDir)[0].meta.supersedes === 'old-rule')
  } finally {
    a.cleanup()
  }

  // 直写：slug 与旧 id 相同 → 搬过来后原地更新
  const b = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    mod.writeMemory(b.memoryDir, { slug: 'same-id', title: 'Same id', description: 'old', body: 'old project body', type: 'project' })
    const res = await b.tool('memory_remember', { slug: 'same-id', title: 'Same id v2', body: 'new global body', type: 'project', source: 'agent', scope: 'global', supersedes: 'same-id' })
    check('slug = 旧 id：在目标库（全局）原地更新', res.id === 'same-id' && res.updated === true && res.replacedFrom === 'project' && ids(b.globalDir).join() === 'same-id' && ids(b.memoryDir).length === 0, JSON.stringify(res))
    check('  …正文是新的，文件里 scope: global', mod.listMemories(b.globalDir)[0].body === 'new global body' && mod.listMemories(b.globalDir)[0].meta.scope === 'global')
    check('  …两个库的 history 都留了旧版', mod.listHistory(b.memoryDir, 'same-id').length >= 1 && mod.listHistory(b.globalDir, 'same-id').length >= 1)
  } finally {
    b.cleanup()
  }

  // 两个库的精确 id 优先于前缀：目标库里碰巧以它开头的条目不能被错删
  const c = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    mod.writeMemory(c.memoryDir, { slug: 'rule-a-extra', title: 'Rule A extra', body: 'unrelated project rule', type: 'project' })
    mod.writeMemory(c.globalDir, { slug: 'rule-a', title: 'Rule A', body: 'global rule a', scope: 'global', type: 'project' })
    const res = await c.tool('memory_remember', { slug: 'rule-a-v2', title: 'Rule A v2', body: 'rule a, revised', type: 'project', source: 'agent', scope: 'project', supersedes: 'rule-a' })
    check('精确 id 在另一个库 → 取代它，而不是目标库里的前缀匹配', res.replaced === 'rule-a' && res.replacedFrom === 'global' && ids(c.memoryDir).join() === 'rule-a-extra,rule-a-v2' && ids(c.globalDir).length === 0, JSON.stringify(res))
  } finally {
    c.cleanup()
  }

  // 目标库满：跨库取代会让目标库多一条，照常拦；什么都不动
  const d = makeHost(mod, { config: { duplicateCheck: false, maxMemoryCount: 1 } })
  try {
    mod.writeMemory(d.memoryDir, { slug: 'only-one', title: 'Only one', body: 'x', type: 'project' })
    mod.writeMemory(d.globalDir, { slug: 'g-old', title: 'G old', body: 'y', scope: 'global', type: 'project' })
    const res = await d.tool('memory_remember', { slug: 'g-new', title: 'G new', body: 'z', type: 'project', source: 'agent', scope: 'project', supersedes: 'g-old' })
    check('目标库满 → library-full，两个库都没动', res.reason === 'library-full' && ids(d.memoryDir).join() === 'only-one' && ids(d.globalDir).join() === 'g-old', JSON.stringify(res))
  } finally {
    d.cleanup()
  }

  // 进待确认：现在什么都不搬；收下时才跨库取代
  const e = makeHost(mod, { config: { duplicateCheck: false, agentWrites: 'review' } })
  try {
    mod.writeMemory(e.globalDir, { slug: 'pending-old', title: 'Pending old', body: 'old', scope: 'global', type: 'project' })
    const queued = await e.tool('memory_remember', { slug: 'pending-new', title: 'Pending new', body: 'new', type: 'project', source: 'agent', scope: 'project', supersedes: 'pending-old' })
    check('进待确认：草稿记着 supersedes，两个库都没动', queued.pending === true && mod.listPending(e.memoryDir)[0]?.meta.supersedes === 'pending-old' &&
      ids(e.globalDir).join() === 'pending-old' && ids(e.memoryDir).length === 0, JSON.stringify(queued))
    check('  …文本点明旧条现在在另一个库', /will replace pending-old \(now in the all-projects/.test(queued.text), queued.text)
    const accepted = await mod.acceptPending(e.memoryDir, queued.id)
    check('收下 → 跨库取代：新条进项目库、旧条从全局库删掉', accepted.ok === true && accepted.replaced === 'pending-old' && ids(e.memoryDir).join() === 'pending-new' && ids(e.globalDir).length === 0, JSON.stringify(accepted))
    check('  …旧内容在全局库 history 里留档', mod.listHistory(e.globalDir, 'pending-old').length >= 1)
  } finally {
    e.cleanup()
  }
}

section('项目指令根：往上最近的 .git 目录，找不到就是工作目录')
{
  const root = path.resolve(path.sep, 'r')
  const repo = path.join(root, 'ws', 'repo')
  const marks = new Set([path.join(repo, '.git')])
  const probe = (p) => marks.has(p)
  check('工作目录就是仓库根', mod.instructionsRootFor(repo, probe) === repo)
  check('工作目录在仓库深处 → 仓库根', mod.instructionsRootFor(path.join(repo, 'a', 'b'), probe) === repo)
  check('找不到 .git → 工作目录本身', mod.instructionsRootFor(path.join(root, 'elsewhere', 'x'), probe) === path.join(root, 'elsewhere', 'x'))
  marks.add(path.join(repo, 'a', '.git'))
  check('嵌套仓库 → 最近的那个', mod.instructionsRootFor(path.join(repo, 'a', 'b'), probe) === path.join(repo, 'a'))
  check('探测抛错当作没有，不冒泡', mod.instructionsRootFor(path.join(root, 'z'), () => { throw new Error('EPERM') }) === path.join(root, 'z'))
}

section('证据只认人亲手发的消息（source.kind === "user"）')
{
  const session = (events) => ({ snapshotEvents: () => events })
  const texts = mod.userTextsOf(session([
    userEvent('以后都用中文回答'),
    injectedEvent('工作区说明：以后都用英文回答', 'runtime-context'),
    injectedEvent('# AGENTS.md\n提交前先跑测试', 'agent-instructions'),
    injectedEvent('另一个会话里说过：发布只走 CI', 'session-reference'),
    injectedEvent('选项 A：每次都问我', 'user-question-reply'),
    // 没有 source 字段：第五轮起不放行（真实宿主里 source 必填，没有的来路不明）
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '没有 source 的话：以后都用英文回答' }] } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '[workspace-memory] 记忆索引' }] } },
    // 文本、图片、文件块混排：只取文本块
    { type: 'user/message', data: { id: 'mix', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '看这张图' }, { type: 'image', attachment: { id: 'a1' } }, { type: 'file', attachment: { id: 'f1' } }, { type: 'text', text: '按图改' }] } },
  ]))
  check('只留下明确标记为用户的，注入的上下文与没有 source 的消息一律不算', JSON.stringify(texts) === JSON.stringify(['以后都用中文回答', '看这张图\n按图改']), JSON.stringify(texts))
  check('证据只出现在 runtime-context 里 → 不通过', mod.verifyEvidence(texts, '以后都用英文回答').verified === false)
  check('证据只出现在 AGENTS.md 注入里 → 不通过', mod.verifyEvidence(texts, '提交前先跑测试').verified === false)
  check('证据只出现在提问回答（选项文字）里 → 不通过', mod.verifyEvidence(texts, '每次都问我').verified === false)
  check('人说过的 → 通过', mod.verifyEvidence(texts, '以后都用中文回答').verified === true)

  // 端到端：模型拿注入上下文里的话当证据 → 进待确认，不直写
  const h = makeHost(mod, { config: { duplicateCheck: false, agentWrites: 'review' } })
  try {
    h.state.events.push(userEvent('帮我看看这个函数'), injectedEvent('[skill] 以后每次改完都要先跑测试再提交', 'skill-invocation'))
    const res = await h.tool('memory_remember', { slug: 'from-skill', title: 'From skill', body: 'x', type: 'feedback', source: 'user', evidence: '以后每次改完都要先跑测试再提交' })
    check('证据来自 skill 注入 → evidence-not-found，进待确认', res.pending === true && res.reason === 'evidence-not-found' && ids(h.memoryDir).length === 0, JSON.stringify(res))
  } finally {
    h.cleanup()
  }
}

section('回合收尾的抽取接上 payload.signal')
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-abort-'))
  const memoryDir = path.join(tmp, 'proj', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  try {
    mod.configure({ enableExtraction: true })
    const longText = '以后每次改完插件都要先跑测试再提交，别再忘了。'.repeat(12)
    const session = { snapshotEvents: () => [userEvent(longText)], requestContext: () => ({ provider: 'p', model: 'm' }) }
    let streams = 0
    let streamSignal
    // 流先吐一块，然后一直挂着，直到自己的 signal 被中止
    const llm = {
      stream: (req) => {
        streams += 1
        streamSignal = req.signal
        return (async function* () {
          yield { type: 'text-delta', text: '[{"title":"半截' }
          await new Promise((resolve) => req.signal.addEventListener('abort', resolve, { once: true }))
          yield { type: 'text-delta', text: '"}]' }
        })()
      },
    }
    const ctx = { get: (key) => (key === 'llm' ? llm : undefined), sessions: { get: () => session } }

    const pre = new AbortController()
    pre.abort()
    const skipped = await mod.extractFromTurn(ctx, { id: 'a' }, memoryDir, { signal: pre.signal })
    check('signal 已中止 → 立刻跳过，不调模型', skipped.skipped === 'extraction aborted' && streams === 0, JSON.stringify(skipped))

    const live = new AbortController()
    const started = Date.now()
    setTimeout(() => live.abort(), 50)
    const aborted = await mod.extractFromTurn(ctx, { id: 'a' }, memoryDir, { signal: live.signal, timeoutMs: 10_000 })
    check('流进行中被中止 → 很快返回 aborted（不等墙钟超时）', aborted.skipped === 'extraction aborted' && Date.now() - started < 5_000, `${JSON.stringify(aborted)} ${Date.now() - started}ms`)
    check('  …中止转发给了模型流', streamSignal?.aborted === true)
    check('  …半截输出不入队', mod.listPending(memoryDir).length === 0)
  } finally {
    mod.configure(undefined)
    rmSync(tmp, { recursive: true, force: true })
  }

  // 监听器把 payload.signal 交给了抽取：已中止的 signal → 根本不调模型
  let calls = 0
  const llm = { stream: () => { calls += 1; return (async function* () {})() } }
  const h = makeHost(mod, { config: { enableExtraction: true, extractEveryTurns: 1 }, services: { llm } })
  try {
    h.state.route = { provider: 'p', model: 'm' }
    h.state.events.push(userEvent('以后每次改完插件都要先跑测试再提交，别再忘了。'.repeat(12)))
    const stopping = h.listeners.get('agent/turn-stopping')
    const done = new AbortController()
    done.abort()
    await stopping[0]({ agent: AGENT, turn: 1, signal: done.signal })
    check('turn-stopping：payload.signal 已中止 → 不调模型', calls === 0)
    await stopping[0]({ agent: AGENT, turn: 2, signal: new AbortController().signal })
    check('  …signal 正常 → 照常抽取（调了一次模型）', calls === 1)
  } finally {
    h.cleanup()
  }
}

section('收下 / 丢弃草稿只留给用户（官方 user-actions.md：确认类动作 user-only）')
{
  const h = makeHost(mod)
  try {
    const names = [...h.tools.keys()].sort()
    check('注册的工具只有这四个', names.join() === 'memory_forget,memory_recall,memory_remember,memory_status', names.join())
    const params = [...h.tools.values()].flatMap((def) => Object.keys(def.parameters?.properties ?? {}))
    check('没有任何工具或参数能收下 / 丢弃草稿', !names.some((n) => /accept|reject|pending|approve/i.test(n)) && !params.some((p) => /accept|reject|approve|pending/i.test(p)), params.join())
  } finally {
    h.cleanup()
  }
}

section('dshHomeDisplay()：默认显示 ~/.dsh，配置过显示 $DSH_HOME；不泄露绝对路径')
{
  const envBefore = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME') ? process.env.DSH_HOME : null
  const custom = path.join(os.tmpdir(), 'wsm-dsh-home-display-probe')
  withDshHome(undefined, () => check('没设 → ~/.dsh', mod.dshHomeDisplay() === '~/.dsh', mod.dshHomeDisplay()))
  withDshHome(custom, () => check('设了别的目录 → $DSH_HOME（不是那个绝对路径）', mod.dshHomeDisplay() === '$DSH_HOME', mod.dshHomeDisplay()))
  withDshHome('   ', () => check('空白 → 视为没设 → ~/.dsh', mod.dshHomeDisplay() === '~/.dsh'))
  // 官方：比较的是解析后的路径；显式设成默认目录仍按默认显示
  withDshHome(path.join(os.homedir(), '.dsh'), () => check('显式设成默认目录 → 仍是 ~/.dsh', mod.dshHomeDisplay() === '~/.dsh', mod.dshHomeDisplay()))

  // 工具返回文字跟着走：常驻草稿的「收下后写进哪里」。只在 DSH_HOME 指向临时目录时调工具——
  // 第五轮起测试从不在「没设 DSH_HOME」（= 真实 ~/.dsh）的状态下调用会读写文件的函数；
  // 「没设时写 ~/.dsh」由上面的纯函数断言覆盖，文案用的就是同一个 dshHomeDisplay()。
  // agentsFile 不配置（= 主目录下的 AGENTS.md），主目录指向临时的 custom：文字里写符号形式。
  // 配置了自定义 agentsFile 时怎么显示，见 review2-fixes.test.mjs 的「agentsFileDisplay」一节。
  const h = makeHost(mod, { config: { duplicateCheck: false, agentWrites: 'review', agentsFile: '' } })
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME')
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = custom
    mkdirSync(custom, { recursive: true })
    h.write(path.join(custom, 'AGENTS.md'), '# 全局\n\n## 1. 已有的一章\n\n内容\n') // 常驻写入在入队前要读章节清单
    const configured = await h.tool('memory_remember', { slug: 'always-b', title: 'Always B', body: 'x', type: 'feedback', source: 'agent', scope: 'global', load: 'always', newChapter: true })
    check('设了 DSH_HOME：文字写 $DSH_HOME/AGENTS.md，不出现绝对路径', /writes it into \$DSH_HOME\/AGENTS\.md/.test(configured.text) && !configured.text.includes(custom), configured.text)
    check('  …文案用的就是 dshHomeDisplay()（没设时它返回 ~/.dsh，见上）', configured.text.includes(`${mod.dshHomeDisplay()}/AGENTS.md`))
  } finally {
    if (had) process.env.DSH_HOME = saved
    else delete process.env.DSH_HOME
    h.cleanup()
    rmSync(custom, { recursive: true, force: true })
  }
  const envAfter = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME') ? process.env.DSH_HOME : null
  check('用完恢复了环境变量', envAfter === envBefore, `${JSON.stringify(envBefore)} → ${JSON.stringify(envAfter)}`)
}

section('memory_recall / memory_forget / memory_status 的说明只写行为与返回（官方 tool-design.md）')
{
  const h = makeHost(mod)
  try {
    for (const name of ['memory_recall', 'memory_forget', 'memory_status']) {
      const def = h.tools.get(name)
      const description = def.description ?? ''
      check(`${name}：说明 < 1000 字符`, description.length > 0 && description.length < 1000, `${description.length}`)
      check(`${name}：不写实现细节（嵌入 / 向量 / 混合检索）`, !/embedding|vector|hybrid|leanvec/i.test(description), description)
      const params = Object.values(def.parameters?.properties ?? {}).map((p) => p.description ?? '').filter(Boolean)
      check(`${name}：参数说明不在工具说明里重复（Say each fact once）`, params.every((p) => !description.includes(p)))
    }
    check('memory_forget：「两个库都有时传 scope」只写在 scope 参数上', !/scope/i.test(h.tools.get('memory_forget').description) && /both/.test(h.tools.get('memory_forget').parameters.properties.scope.description))
    check('memory_recall：说明里讲了会返回更新日期', /last updated/.test(h.tools.get('memory_recall').description))
  } finally {
    h.cleanup()
  }
}

section('真实文件未被本次测试改动')
check('真实 AGENTS.md 与全局按需库的存在性与哈希不变', guard.unchanged())

summary()
