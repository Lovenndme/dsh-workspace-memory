/**
 * 测试用的假宿主：把 `apply(ctx, rawConfig)` 注册的路由 / 工具 / 命令 / 监听器收集起来，
 * 让测试能像宿主一样调用它们。不是测试文件（文件名不带 .test），被几个测试共用。
 *
 * 安全约定（吃过亏，见 CLAUDE.md）：
 *   · `agentsFile`、`memoryDir`、`globalMemoryDir` 一律经 apply 的 rawConfig 传入，并且都在临时目录里；
 *     `apply` 第一行就 `configure(rawConfig)`，不传等于回到真实的 ~/.dsh。
 *   · 假 ctx 不碰 ~/.dsh 下的任何东西。
 *
 * 分流默认 `agentWrites: 'direct'`：多数旧用例测的是「写进去之后」的行为（查重、预算、索引……），
 * 不是来源分流；分流本身在 write-routing / remember-route 里单独测。要测待确认队列的用例显式传 'review'。
 */
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SESSION = 's-ok'
export const AGENT = { id: 'agent-1' }

/**
 * 一条人发的用户消息事件，形状照官方 persistence-catalog 的 UserMessage：
 * `data = { id, role: 'user', content: ContentBlock[], source: { kind: 'user' } }`。
 */
let eventCounter = 0
export const userEvent = (text) => ({
  type: 'user/message',
  data: { id: `m${(eventCounter += 1)}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})

/** 一条注入的上下文（也是 user/message，但 source.kind 不是 'user'），例如 runtime-context、agent-instructions。 */
export const injectedEvent = (text, kind = 'runtime-context') => ({
  type: 'user/message',
  data: { id: `m${(eventCounter += 1)}`, role: 'user', content: [{ type: 'text', text }], source: { kind } },
})

/** 构造升级前遗留的常驻草稿；新 memory_remember 不再产生这种草稿。 */
export function legacyAlwaysDraft(mod, host, args) {
  const plan = mod.planAgentsChapter(args)
  if (!plan.ok) throw new Error(`旧草稿测试的章节不存在：${plan.reason}`)
  const file = mod.writePending(host.memoryDir, {
    ...args,
    scope: 'global',
    load: 'always',
    ...(plan.action === 'updated'
      ? { chapter: plan.chapter, chapterTitle: plan.chapterTitle, newChapter: false }
      : { newChapter: true }),
  })
  return { file, id: path.basename(file, '.md'), pending: true, ...(plan.action === 'updated' ? { chapter: plan.chapter } : {}) }
}

/**
 * 真实文件保护：记下真实主目录下 `AGENTS.md`、全局按需库（默认 `dsh-workspace-memory/global`，
 * 以及旧默认位置 `global-memory`）的**存在性与哈希**，测试结束时比对。
 * 只算哈希，不打印、不返回任何内容（那里是用户的真实数据）。
 * 主目录：`~/.dsh`，以及测试开始前设着的 DSH_HOME（test/isolate-home.mjs 记下的原值；与 index.js 的 dshHome() 同规则）。
 * 测试自己的临时主目录（isolate-home 换上的 DSH_HOME）不守：测试本来就会往那里写。
 */
export function realFilesGuard() {
  const homes = [path.join(os.homedir(), '.dsh')]
  const ORIGINAL = Symbol.for('dsh-workspace-memory.test.originalDshHome')
  // 没经过 isolate-home（例如别处直接用假宿主）时，当前的 DSH_HOME 就是「原值」
  const env = ORIGINAL in globalThis ? globalThis[ORIGINAL] : process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') {
    const expanded = env === '~' ? os.homedir() : env.startsWith('~/') || env.startsWith('~\\') ? path.join(os.homedir(), env.slice(2)) : env
    homes.push(path.resolve(expanded))
  }
  const targets = homes.flatMap((home) => [
    path.join(home, 'AGENTS.md'),
    path.join(home, 'dsh-workspace-memory', 'global'),
    path.join(home, 'global-memory'),
  ])
  const fingerprint = () => {
    const hash = createHash('sha256')
    for (const target of targets) {
      const present = existsSync(target)
      hash.update(`${target}:${present}\n`)
      if (!present) continue
      if (!statSync(target).isDirectory()) {
        hash.update(readFileSync(target))
        continue
      }
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(dir, entry.name)
          hash.update(`${path.relative(target, full)}\n`)
          if (entry.isDirectory()) walk(full)
          else hash.update(readFileSync(full))
        }
      }
      walk(target)
    }
    return hash.digest('hex')
  }
  const before = fingerprint()
  return { unchanged: () => fingerprint() === before }
}

/**
 * 按 tools.md 的「enforced raw JSON Schema subset」校验一个值（type / properties / required /
 * additionalProperties / items / enum / const / oneOf）。`strict: true` 时把没声明的键也算错——
 * 用来检查 output.schema 是否把实际会出现的字段都声明了（运行时 schema 写的是 additionalProperties: true）。
 * 返回问题列表（空 = 通过）。
 */
export function schemaProblems(schema, value, { strict = false } = {}, at = '$') {
  if (!schema || typeof schema !== 'object') return [`${at}: schema 不是对象`]
  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter((branch) => schemaProblems(branch, value, { strict }, at).length === 0)
    return passing.length === 1 ? [] : [`${at}: oneOf 命中 ${passing.length} 支`]
  }
  const problems = []
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
  if (schema.type) {
    const actual = typeOf(value)
    const ok = schema.type === actual || (schema.type === 'number' && actual === 'integer')
    if (!ok) return [`${at}: 应为 ${schema.type}，实际 ${actual}`]
  }
  // 数字只收「有限且不是 -0」（与宿主校验器的 lossless JSON number 同口径：NaN / Infinity / -0 一律不算）
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
    problems.push(`${at}: 数字不是 lossless JSON（${Object.is(value, -0) ? '-0' : value}）`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) problems.push(`${at}: 不在 enum 里`)
  if ('const' in schema && schema.const !== value) problems.push(`${at}: 不等于 const`)
  if (schema.type === 'object' && value && typeof value === 'object') {
    if (strict && schema.additionalProperties === undefined) problems.push(`${at}: 对象节点没有显式写 additionalProperties`)
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${at}.${key}: 缺少必需字段`)
    for (const [key, inner] of Object.entries(value)) {
      const sub = schema.properties?.[key]
      if (sub) problems.push(...schemaProblems(sub, inner, { strict }, `${at}.${key}`))
      else if (strict || schema.additionalProperties === false) problems.push(`${at}.${key}: 没有声明`)
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => problems.push(...schemaProblems(schema.items, item, { strict }, `${at}[${i}]`)))
  }
  return problems
}

/** 递归快照：相对路径 → 内容。`skip` 里的目录（相对 root）整棵跳过。 */
export function snapshotTree(root, skip = []) {
  const out = {}
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (skip.includes(rel)) continue
      if (entry.isDirectory()) {
        out[`${rel}/`] = '<dir>'
        walk(full)
      } else {
        out[rel] = readFileSync(full, 'utf8')
      }
    }
  }
  walk(root)
  return out
}

/**
 * @param mod     `await import('../index.js')`
 * @param options.config    追加到 apply 的 rawConfig（agentsFile / memoryDir 已经替你填好）
 * @param options.registry  假的 workspaceRegistry（{ list() }）
 * @param options.services  经 ctx.get(name) 取到的可选服务（如 { llm }）
 */
export function makeHost(mod, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-host-'))
  const workspace = path.join(root, 'ws')
  const memoryDir = path.join(root, 'proj', 'memory')
  const globalDir = path.join(root, 'global', 'memory')
  const agentsFile = path.join(root, 'AGENTS.md')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })

  const routes = new Map()
  const tools = new Map()
  const commands = new Map()
  const listeners = new Map()
  const sections = []
  let contextDef = null
  // events：会话里的事件（证据核对读它）；用 state.events.push(userEvent('...')) 模拟用户说过的话
  const state = { initiator: AGENT, cwd: workspace, events: [] }

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
    commands: { register: (def) => (commands.set(def.name, def), () => {}) },
    tools: { register: (def) => (tools.set(def.name, def), () => {}) },
    systemPrompt: {
      context: (def) => ((contextDef = def), () => {}),
      // 系统提示段（静态文本），收集起来给结构守卫用
      section: (def) => (sections.push(def), () => {}),
    },
    webServer: { register: (def) => (routes.set(def.path, def), () => {}) },
    agents: { currentInitiator: () => state.initiator },
    // 只认 SESSION 与 AGENT：其余 session id 查不到，用来测「session 必需」
    // requestContext：抽取用它取当前路由的 provider/model；默认没有（= 跳过抽取），测抽取时给 state.route
    sessions: {
      get: (id) =>
        id === SESSION || id === AGENT.id ? { id, snapshotEvents: () => state.events, requestContext: () => state.route } : undefined,
    },
    workingDirectory: { get: () => state.cwd },
    // 可选服务（如 llm）经 options.services 注入
    get: (name) => (name === 'workspaceRegistry' ? options.registry : options.services?.[name]),
  }

  mod.apply(ctx, { agentsFile, memoryDir, globalMemoryDir: globalDir, agentWrites: 'direct', ...options.config })

  /** 发一个假 HTTP 请求。handler 同步抛出会原样抛给测试（那本身就是缺陷）。 */
  async function http(route, { method = 'GET', session = SESSION, headers, body, rawBody, query = '' } = {}) {
    const def = routes.get(route)
    if (!def) throw new Error(`没有注册路由 ${route}`)
    const req = new EventEmitter()
    const search = [session === null ? '' : `session=${encodeURIComponent(session)}`, query].filter(Boolean).join('&')
    req.url = `${route}${search ? `?${search}` : ''}`
    req.method = method
    req.headers = headers ?? (method === 'POST' ? { 'content-type': 'application/json' } : {})
    req.destroyed = false
    req.destroy = () => {
      req.destroyed = true
    }
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value
      },
      end(payload) {
        this.payload = payload
        this.finish()
      },
    }
    const finished = new Promise((resolve) => {
      res.finish = resolve
    })
    const run = Promise.resolve(def.handler(req, res))
    setImmediate(() => {
      const text = rawBody ?? (body === undefined ? '' : JSON.stringify(body))
      if (text) req.emit('data', Buffer.from(text))
      req.emit('end')
    })
    await Promise.race([finished, run.then(() => new Promise((resolve) => setTimeout(resolve, 20)))])
    await run
    return { status: res.statusCode, headers: res.headers, body: res.payload ? JSON.parse(res.payload) : null, req }
  }

  return {
    root,
    workspace,
    memoryDir,
    globalDir,
    agentsFile,
    routes,
    tools,
    commands,
    listeners,
    sections,
    state,
    http,
    /**
     * 调工具，返回 execute 的原始返回值。
     * memory_remember 没传 `type` 时补一个 'project'：type 现在是工具自己校验的必填参数（缺了拒写 invalid-argument），
     * 而多数旧用例测的是写进去之后的行为，以前就是靠「缺省回落 project」写进去的。
     * 要测「缺 type」就显式传 `type: undefined`（`'type' in args` 为真，不补）。
     */
    tool: (name, args) =>
      tools.get(name).execute(name === 'memory_remember' && args && !('type' in args) ? { type: 'project', ...args } : args, { agent: AGENT }),
    /** 跑命令，返回处理函数的结果。 */
    command: (name, rawInput, extra = {}) => commands.get(name).handler({ rawInput, agent: AGENT, ...extra }),
    /** 当前注入到 system prompt 的动态 context 文本。 */
    contextText: () => contextDef.text(),
    /**
     * 触发某个事件的第一个监听器。waterfall 的 next 默认返回一个**新的** `{ kind: 'accept' }`
     * （宿主「原样接受」的决定，tools.md：next() accepts it unchanged）；`passed` = next 被调用过，
     * `nextResult` = next 返回的那个对象（用来断言「原样透传」）。
     */
    fire: async (name, ...args) => {
      let passed = false
      let nextResult
      const next = async () => {
        passed = true
        nextResult = { kind: 'accept' }
        return nextResult
      }
      const result = await listeners.get(name)[0](...args, next)
      return { result, passed, nextResult }
    },
    /** 同 fire，但下游 next() 的返回由 `nextImpl` 决定（测 block / 换 value / additionalContexts）。 */
    fireWith: async (name, nextImpl, ...args) => {
      let calls = 0
      let nextResult
      const next = async () => {
        calls += 1
        nextResult = await nextImpl()
        return nextResult
      }
      const result = await listeners.get(name)[0](...args, next)
      return { result, calls, nextResult }
    },
    write(file, text) {
      writeFileSync(file, text, 'utf8')
    },
    read: (file) => readFileSync(file, 'utf8'),
    exists: existsSync,
    stat: statSync,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 测试脚本里统一的 PASS/FAIL 打印；失败计数通过 `summary()` 退出。 */
export function makeReporter() {
  let failures = 0
  return {
    check(label, condition, detail) {
      if (condition) {
        console.log(`  PASS  ${label}`)
      } else {
        failures += 1
        console.log(`  FAIL  ${label}${detail === undefined ? '' : `\n        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
      }
    },
    section(title) {
      console.log(`\n== ${title} ==`)
    },
    summary() {
      console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      process.exit(failures === 0 ? 0 : 1)
    },
  }
}
