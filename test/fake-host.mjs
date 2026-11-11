/**
 * 测试用的假宿主：把 `apply(ctx, rawConfig)` 注册的路由 / 工具 / 命令 / 监听器收集起来，
 * 让测试能像宿主一样调用它们。不是测试文件（文件名不带 .test），被几个测试共用。
 *
 * 安全约定（吃过亏，见 CLAUDE.md）：
 *   · `agentsFile` 与 `memoryDir` 一律经 apply 的 rawConfig 传入，并且都在临时目录里；
 *     `apply` 第一行就 `configure(rawConfig)`，不传等于回到真实的 ~/.dsh。
 *   · 假 ctx 不碰 ~/.dsh 下的任何东西。
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SESSION = 's-ok'
export const AGENT = { id: 'agent-1' }

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
 */
export function makeHost(mod, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-host-'))
  const workspace = path.join(root, 'ws')
  const memoryDir = path.join(root, 'proj', 'memory')
  const agentsFile = path.join(root, 'AGENTS.md')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })

  const routes = new Map()
  const tools = new Map()
  const commands = new Map()
  const listeners = new Map()
  let contextDef = null
  const state = { initiator: AGENT, cwd: workspace }

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
    systemPrompt: { context: (def) => ((contextDef = def), () => {}) },
    webServer: { register: (def) => (routes.set(def.path, def), () => {}) },
    agents: { currentInitiator: () => state.initiator },
    // 只认 SESSION 与 AGENT：其余 session id 查不到，用来测「session 必需」
    sessions: { get: (id) => (id === SESSION || id === AGENT.id ? { id } : undefined) },
    workingDirectory: { get: () => state.cwd },
    get: (name) => (name === 'workspaceRegistry' ? options.registry : undefined),
  }

  mod.apply(ctx, { agentsFile, memoryDir, ...options.config })

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
    agentsFile,
    routes,
    tools,
    commands,
    listeners,
    state,
    http,
    /** 调工具，返回 execute 的原始返回值。 */
    tool: (name, args) => tools.get(name).execute(args, { agent: AGENT }),
    /** 跑命令，返回处理函数的结果。 */
    command: (name, rawInput, extra = {}) => commands.get(name).handler({ rawInput, agent: AGENT, ...extra }),
    /** 当前注入到 system prompt 的文本。 */
    contextText: () => contextDef.text(),
    /** 触发某个事件的第一个监听器（waterfall 的 next 默认原样放行）。 */
    fire: async (name, ...args) => {
      let passed = false
      const next = async () => {
        passed = true
        return { __next: true }
      }
      const result = await listeners.get(name)[0](...args, next)
      return { result, passed }
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
