/**
 * 证据核对的取数（2026-11-14 第三轮）：用户原话先从 `agent/pre-step` 的缓存里找，找不到再回落到会话快照。
 *
 * 为什么：官方 session.md 把 `snapshotEvents()` 标为 @deprecated（「new calls are prohibited」），
 * 证据核对是新逻辑，不该以它为主路径。官方 core.md 的 `agent/pre-step` payload 带
 * `messages: UserMessage[]`（「messages removed from the inbox for this step」），插件已经在这个监听里预取，
 * 顺手把人写的文本收进进程内缓存；回落只为「DSH 重启后恢复的会话」这一种情况。
 *
 * 覆盖：
 *   · 缓存：人写的进、注入的不进；每个 agent 最多 200 条、单条截断到 20000 字符；agent/disposed 清理；
 *     监听始终调用一次 next()，缓存出错也不挡步骤；
 *   · 取数顺序：缓存命中直写（不读快照）；缓存没有而快照里有 → 回落后通过；两处都没有 → 待确认；
 *     会话对象没有 snapshotEvents 方法时不抛错；
 *   · memory_status 的来源标记：none / prestep-cache / snapshot-fallback。
 *
 * 全部在临时目录（经 apply 传入 agentsFile / memoryDir / globalMemoryDir），结束时比对真实文件的哈希。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { injectedEvent, makeReporter, realFilesGuard, userEvent } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()

const AGENT_A = { id: 'agent-a' }
const AGENT_B = { id: 'agent-b' }
const ids = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').map((n) => n.slice(0, -3)).sort() : [])

/** 宿主送进 pre-step 的消息：形状照官方 persistence-catalog 的 UserMessage（data 部分）。 */
const human = (text) => userEvent(text).data
const injected = (text, kind) => injectedEvent(text, kind).data

/**
 * 自带的小宿主：会话对象可换（有 / 没有 snapshotEvents），并数 snapshotEvents 被调了几次——
 * 用来证明「缓存命中时根本不读快照」。
 */
function makeEnv(config = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-evcache-'))
  const workspace = path.join(root, 'ws')
  const memoryDir = path.join(root, 'proj', 'memory')
  const globalDir = path.join(root, 'global', 'memory')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })

  const listeners = new Map()
  const tools = new Map()
  const state = { events: [], snapshotCalls: 0, withSnapshot: true }
  // sessions.get 必须总能给出会话：记忆目录是经「会话 → 工作目录」解析的
  const sessionOf = (id) =>
    state.withSnapshot
      ? {
          id,
          snapshotEvents: () => {
            state.snapshotCalls += 1
            return state.events
          },
        }
      : { id }

  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    commands: { register: () => () => {} },
    tools: { register: (def) => (tools.set(def.name, def), () => {}) },
    systemPrompt: { context: () => () => {}, section: () => () => {} },
    webServer: { register: () => () => {} },
    agents: { currentInitiator: () => AGENT_A },
    sessions: { get: (id) => sessionOf(id) },
    workingDirectory: { get: () => workspace },
    get: () => undefined,
  }
  mod.apply(ctx, {
    agentsFile: path.join(root, 'AGENTS.md'),
    memoryDir,
    globalMemoryDir: globalDir,
    agentWrites: 'review',
    duplicateCheck: false,
    ...config,
  })

  return {
    memoryDir,
    globalDir,
    state,
    /** 跑 pre-step 监听；返回 next 被调用的次数与监听的返回值。 */
    async preStep(agent, messages) {
      let calls = 0
      const decision = { kind: 'enter', messages: [] }
      const next = async () => {
        calls += 1
        return decision
      }
      const result = await listeners.get('agent/pre-step')[0]({ agent, messages, turn: 1, step: 1 }, next)
      return { calls, result, decision }
    },
    fire(name, payload) {
      for (const handler of listeners.get(name) ?? []) handler(payload)
    },
    remember: (agent, args) => tools.get('memory_remember').execute({ type: 'feedback', source: 'user', ...args }, { agent }),
    status: (agent = AGENT_A) => tools.get('memory_status').execute({}, { agent }),
    cleanup() {
      rmSync(root, { recursive: true, force: true })
      mod.configure(undefined)
    },
  }
}

section('appendUserTexts：人写的进缓存，注入的不进')
{
  const cache = new Map()
  const added = mod.appendUserTexts(cache, 'a', [
    human('以后回答都用中文，说大白话'),
    injected('[workspace-memory] 记忆索引。以后都用英文', 'runtime-context'),
    injected('# AGENTS.md\n提交前先跑测试', 'agent-instructions'),
    injected('[skill] 每次改完都要跑测试', 'skill-invocation'),
    injected('选项 A：每次都问我', 'user-question-reply'),
    // 没有 source 的消息：来路不明，不算人写的（第五轮；真实宿主里 source 必填）
    { role: 'user', content: '没有 source 的话' },
    // 人发的消息里夹着宿主附上的提醒块（不在开头）：剥掉提醒，只留人写的
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '提交信息用中文\n<system-reminder>宿主附上的提醒：以后都用英文</system-reminder>' }] },
    // 剥完提醒什么都不剩：丢弃
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '<system-reminder>只有提醒</system-reminder>' }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>注入的提醒</system-reminder>' }] },
    // 人发的消息里夹着注入块：只留人写的那块；图片块不取
    { id: 'mix', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '看这张图' }, { type: 'image', attachment: { id: 'i' } }, { type: 'text', text: '[workspace-memory] 夹带' }, { type: 'text', text: '按图改' }] },
  ])
  check('只收明确标记为用户的 3 条：没有 source 的不收，提醒块剥掉', added === 3 && JSON.stringify(cache.get('a')) === JSON.stringify(['以后回答都用中文，说大白话', '提交信息用中文', '看这张图\n按图改']), JSON.stringify(cache.get('a')))
  check('  …提醒块里的话核对不通过', mod.verifyEvidenceFrom({ cached: cache.get('a'), evidence: '以后都用英文' }).verified === false)
  check('与快照用同一套过滤：userTextsOf 对同样的消息给出同样的结果', JSON.stringify(mod.userTextsOf({ snapshotEvents: () => [
    userEvent('以后回答都用中文，说大白话'),
    injectedEvent('[workspace-memory] 记忆索引。以后都用英文', 'runtime-context'),
    { type: 'user/message', data: { role: 'user', content: '没有 source 的话' } },
  ] })) === JSON.stringify(['以后回答都用中文，说大白话']))
  check('全是注入的批次：一条不加，也不建空条目', mod.appendUserTexts(cache, 'b', [injected('x 注入', 'runtime-context')]) === 0 && !cache.has('b'))
  check('坏输入不抛错、返回 0', mod.appendUserTexts(cache, 'a', null) === 0 && mod.appendUserTexts(cache, '', [human('xx')]) === 0 && mod.appendUserTexts(null, 'a', [human('xx')]) === 0)
  const trap = { role: 'user', source: { kind: 'user' } }
  Object.defineProperty(trap, 'content', { get() { throw new Error('boom') } })
  check('单条消息访问器抛错：只跳过它，同批其余照收', mod.appendUserTexts(cache, 'c', [trap, human('后面这条照收')]) === 1 && cache.get('c')[0] === '后面这条照收')
}

section('appendUserTexts：上限 200 条、单条截断 20000 字符')
{
  check('常量就是设计值', mod.USER_TEXT_CACHE_LIMIT === 200 && mod.USER_TEXT_MAX_CHARS === 20000)
  const cache = new Map()
  for (let i = 1; i <= 205; i += 1) mod.appendUserTexts(cache, 'a', [human(`第 ${i} 条消息`)])
  const list = cache.get('a')
  check('超过 200 条只留最近 200 条（旧的在前）', list.length === 200 && list[0] === '第 6 条消息' && list[199] === '第 205 条消息', `${list.length} ${list[0]} ${list[199]}`)
  mod.appendUserTexts(cache, 'b', Array.from({ length: 230 }, (_, i) => human(`批内第 ${i} 条`)))
  check('一批里超过 200 条同样截到 200', cache.get('b').length === 200 && cache.get('b')[0] === '批内第 30 条')

  const long = `${'甲'.repeat(19_990)}结尾在这里之后还有很多字${'乙'.repeat(5_000)}`
  mod.appendUserTexts(cache, 'c', [human(long)])
  check('单条超过 20000 字符截断成 20000', cache.get('c')[0].length === 20_000 && long.startsWith(cache.get('c')[0]))
  const emoji = `${'a'.repeat(19_999)}😀tail`
  mod.appendUserTexts(cache, 'd', [human(emoji)])
  check('截断处正好落在代理对中间：不留半个字符', cache.get('d')[0].length === 19_999 && !/[\uD800-\uDBFF]$/.test(cache.get('d')[0]))
}

section('pre-step 监听：始终调用一次 next()，缓存出错也不挡步骤')
{
  for (const prefetchRecall of [true, false]) {
    const env = makeEnv({ prefetchRecall })
    try {
      const normal = await env.preStep(AGENT_A, [human('随便问点什么')])
      check(`prefetchRecall=${prefetchRecall}：next() 恰好调一次，返回的就是它的决定`, normal.calls === 1 && normal.result === normal.decision)
      const empty = await env.preStep(AGENT_A, [])
      check(`  …空批次也调一次`, empty.calls === 1 && empty.result === empty.decision)
      const trap = { role: 'user', source: { kind: 'user' } }
      Object.defineProperty(trap, 'content', { get() { throw new Error('boom') } })
      const broken = await env.preStep(AGENT_A, [trap])
      check(`  …消息结构异常也调一次`, broken.calls === 1 && broken.result === broken.decision)
      const weird = await env.preStep(undefined, null)
      check(`  …没有 agent、messages 不是数组也调一次`, weird.calls === 1 && weird.result === weird.decision)
    } finally {
      env.cleanup()
    }
  }
}

section('取数顺序：缓存命中直写，不读快照')
{
  const env = makeEnv()
  try {
    const before = await env.status()
    check('还没核对过 → memory_status 报 none', before.evidenceSource === 'none' && /last evidence check: none/.test(before.text), before.text)

    // 快照里什么都没有：只有 pre-step 收到过这句话
    await env.preStep(AGENT_A, [human('以后回答都用中文，说大白话。')])
    const res = await env.remember(AGENT_A, { slug: 'plain-words', description: '以后回答都用中文、说大白话', title: 'Plain words', body: '回答用中文、说大白话。', evidence: '以后回答都用中文' })
    check('缓存里找到原话 → 直写', typeof res.id === 'string' && res.pending !== true && ids(env.memoryDir).join() === 'plain-words', JSON.stringify(res))
    check('  …没有去读会话快照', env.state.snapshotCalls === 0, `snapshotEvents 调了 ${env.state.snapshotCalls} 次`)
    const after = await env.status()
    check('  …memory_status 报 prestep-cache（verified）', after.evidenceSource === 'prestep-cache' && /last evidence check: prestep-cache \(verified\)/.test(after.text), after.text)
    // 第五轮：核对状态按 agent 记，另一个会话的 memory_status 不会看到这一次
    const otherAgent = await env.status(AGENT_B)
    check('  …另一个 agent 的 memory_status 仍是 none（不串）', otherAgent.evidenceSource === 'none', otherAgent.text)

    // 注入的上下文进不了缓存：拿它当证据 → 回落快照也没有 → 待确认
    await env.preStep(AGENT_A, [injected('[skill] 以后每次改完都要先跑测试再提交', 'skill-invocation')])
    const fake = await env.remember(AGENT_A, { slug: 'from-skill', description: '改完都要先跑测试再提交', title: 'From skill', body: 'x', evidence: '以后每次改完都要先跑测试再提交' })
    check('证据只出现在注入的消息里 → evidence-not-found，进待确认', fake.pending === true && fake.reason === 'evidence-not-found' && !ids(env.memoryDir).includes('from-skill'), JSON.stringify(fake))
  } finally {
    env.cleanup()
  }
}

section('取数顺序：缓存没有而快照里有 → 回落后通过')
{
  const env = makeEnv()
  try {
    // 模拟 DSH 重启后恢复的会话：早先的话只在快照里，pre-step 缓存是空的
    env.state.events.push(userEvent('模型选择要询问我，不要自己定。'))
    const res = await env.remember(AGENT_A, { slug: 'ask-model', description: '模型选择要先询问用户', title: 'Ask model', body: '选模型前先问用户。', evidence: '模型选择要询问我' })
    check('回落到快照后核对通过 → 直写', typeof res.id === 'string' && res.pending !== true && ids(env.memoryDir).join() === 'ask-model', JSON.stringify(res))
    check('  …读了快照', env.state.snapshotCalls >= 1)
    const status = await env.status()
    check('  …memory_status 报 snapshot-fallback（verified）', status.evidenceSource === 'snapshot-fallback' && /last evidence check: snapshot-fallback \(verified\)/.test(status.text), status.text)

    // 缓存里有别的话、没有这一句：同样回落
    await env.preStep(AGENT_A, [human('帮我看看这个函数')])
    env.state.events.push(userEvent('说大白话，别用术语。'))
    const res2 = await env.remember(AGENT_A, { slug: 'no-jargon', description: '说大白话，别用术语', title: 'No jargon', body: '别用术语。', evidence: '说大白话，别用术语' })
    check('缓存有内容但没有这句 → 回落快照通过', typeof res2.id === 'string' && res2.pending !== true, JSON.stringify(res2))
  } finally {
    env.cleanup()
  }
}

section('取数顺序：两处都没有 → 待确认；会话没有 snapshotEvents 方法时不抛错')
{
  const env = makeEnv()
  try {
    env.state.events.push(userEvent('帮我看看这个函数'))
    await env.preStep(AGENT_A, [human('再跑一遍测试')])
    const res = await env.remember(AGENT_A, { slug: 'never-said', description: '以后都用英文回答', title: 'Never said', body: 'x', evidence: '以后都用英文回答' })
    check('两处都找不到 → evidence-not-found，进待确认', res.pending === true && res.reason === 'evidence-not-found' && ids(env.memoryDir).length === 0, JSON.stringify(res))
    const status = await env.status()
    check('  …memory_status 报 snapshot-fallback（not verified）', status.evidenceSource === 'snapshot-fallback' && /snapshot-fallback \(not verified\)/.test(status.text), status.text)

    // 宿主将来移除已弃用的 snapshotEvents：会话对象上没有这个方法
    env.state.withSnapshot = false
    const gone = await env.remember(AGENT_A, { slug: 'no-snapshot', description: '以后都用英文回答', title: 'No snapshot', body: 'x', evidence: '以后都用英文回答' })
    check('没有 snapshotEvents 方法 → 不抛错，退化为待确认', gone.pending === true && gone.reason === 'evidence-not-found', JSON.stringify(gone))
    const status2 = await env.status()
    check('  …memory_status 报 prestep-cache（只有缓存这一路可查）', status2.evidenceSource === 'prestep-cache' && /prestep-cache \(not verified\)/.test(status2.text), status2.text)
    const stillWorks = await env.remember(AGENT_A, { slug: 'from-cache', description: '改完再跑一遍测试', title: 'From cache', body: 'x', evidence: '再跑一遍测试' })
    check('  …缓存这条主路径照常可用', typeof stillWorks.id === 'string' && stillWorks.pending !== true, JSON.stringify(stillWorks))
  } finally {
    env.cleanup()
  }

  const direct = mod.verifyEvidenceFrom({ cached: [], getSession: () => { throw new Error('gone') }, evidence: '以后都用中文回答' })
  check('verifyEvidenceFrom：取会话抛错 → 不通过、不抛', direct.verified === false && direct.via === 'prestep-cache', JSON.stringify(direct))
  const noArgs = mod.verifyEvidenceFrom()
  check('verifyEvidenceFrom：不给参数 → 不通过、不抛', noArgs.verified === false)
}

section('缓存按 agent 分开；agent/disposed 时清掉')
{
  const env = makeEnv()
  try {
    await env.preStep(AGENT_B, [human('以后回答都用中文，说大白话。')])
    const other = await env.remember(AGENT_A, { slug: 'other-agent', description: '回答都用中文', title: 'Other agent', body: 'x', evidence: '以后回答都用中文' })
    check('别的 agent 收到的话不能给这个 agent 作证', other.pending === true && other.reason === 'evidence-not-found', JSON.stringify(other))

    await env.preStep(AGENT_A, [human('提交信息用中文写。')])
    env.fire('agent/disposed', { agent: AGENT_A })
    const disposed = await env.remember(AGENT_A, { slug: 'after-dispose', description: '提交信息用中文写', title: 'After dispose', body: 'x', evidence: '提交信息用中文写' })
    check('dispose 之后缓存清空 → 找不到（快照也没有）→ 待确认', disposed.pending === true && disposed.reason === 'evidence-not-found', JSON.stringify(disposed))
    const still = await env.remember(AGENT_B, { slug: 'b-still', description: '回答都用中文', title: 'B still', body: 'x', evidence: '以后回答都用中文' })
    check('  …只清了那一个 agent：另一个的缓存还在', typeof still.id === 'string' && still.pending !== true, JSON.stringify(still))
  } finally {
    env.cleanup()
  }
}

section('agent 来源不做核对；user 来源没给证据也照常记一次核对（第五轮）')
{
  const env = makeEnv()
  try {
    await env.preStep(AGENT_A, [human('以后回答都用中文')])
    await env.remember(AGENT_A, { slug: 'agent-made', title: 'Agent made', body: 'x', source: 'agent' })
    check('source: agent 不做核对 → 仍是 none', (await env.status()).evidenceSource === 'none')
    const blank = await env.remember(AGENT_A, { slug: 'no-evidence', title: 'No evidence', body: 'x', evidence: '   ' })
    check('source: user 但没给证据 → 进待确认，文本说没有提供证据', blank.pending === true && blank.reason === 'evidence-not-found' && /no evidence/.test(blank.text), JSON.stringify(blank))
    const afterBlank = await env.status()
    check('  …照常更新最近一次核对的状态（不再停在 none），并标出没给证据', afterBlank.evidenceSource !== 'none' && /no evidence given/.test(afterBlank.text), afterBlank.text)
  } finally {
    env.cleanup()
  }
}

section('返回值符合声明的 schema')
{
  const env = makeEnv()
  try {
    const status = await env.status()
    const { schemaProblems } = await import('./fake-host.mjs')
    const problems = schemaProblems(mod.STATUS_OUTPUT_SCHEMA, status, { strict: true })
    check('memory_status 的返回值字段都已声明', problems.length === 0, problems.join('; '))
  } finally {
    env.cleanup()
  }
}

section('真实文件未被本次测试改动')
check('真实 AGENTS.md 与全局按需库的存在性与哈希不变', guard.unchanged())

summary()
