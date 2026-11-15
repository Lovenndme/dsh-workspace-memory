/**
 * 主路径评测用的假宿主：每个场景一份，所有落盘路径都在独立的临时目录里。
 *
 * 为什么不直接复用 test/fake-host.mjs：
 *   · 那边的会话没有 `snapshotEvents()`，而新版的证据核对要从会话里读用户原话；
 *   · 那边的 workingDirectory 无视参数，这里要按会话对象返回，才能和真实宿主一样走 memoryDirOf；
 *   · 评测要并发跑，CONFIG 是模块级全局变量——同一个模块实例上 apply 两次，后一次会把前一次的
 *     memoryDir 改掉。所以这里按「一个 worker 一个模块实例」加载（见 loadPluginInstances），
 *     一个实例同一时刻只服务一个场景。
 *
 * 安全约定（同 CLAUDE.md）：memoryDir / agentsFile / globalMemoryDir 一律经 apply 的 rawConfig 传入；
 * apply 后再核对一遍插件实际生效的路径，对不上就抛错中止——绝不让评测写到真实的 ~/.dsh。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 临时 AGENTS.md 的初始内容（合成）。
 *
 * 为什么不留空文件：真实环境里全局 AGENTS.md 总是已有若干章；旧版的 global 写入在文件不存在时
 * 一律返回 agents-missing，那会把「插件准入」测成「文件不存在」。两章内容刻意与各场景主题无关。
 */
export const SEED_AGENTS = [
  '# 全局约定',
  '',
  '## 1. 安全',
  '',
  '- 不在代码、日志、提交说明里写入任何凭证。',
  '',
  '## 2. 临时文件',
  '',
  '- 临时文件放系统临时目录，不放进仓库。',
  '',
].join('\n')

/** SEED_AGENTS 里的章数：计分时用它算「新增了几章」。 */
export const SEED_CHAPTERS = 2

/**
 * 加载 n 个互相独立的插件模块实例。
 *
 * ESM 按 URL 缓存模块，带不同 query 的同一个文件就是不同实例，各有自己的 CONFIG / 缓存。
 */
export async function loadPluginInstances(indexPath, n) {
  const href = pathToFileURL(path.resolve(indexPath)).href
  const out = []
  for (let i = 0; i < n; i += 1) out.push(await import(`${href}?eval-instance=${i}`))
  return out
}

/** 把插件注册的工具定义转成 OpenAI function calling 格式。 */
export function toOpenAiTool(def) {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description ?? '',
      parameters: def.parameters ?? { type: 'object', properties: {} },
    },
  }
}

/** 按宿主的方式把工具返回值渲染成给模型看的文本：有 output.render 就用它。 */
export function renderToolResult(def, args, value) {
  try {
    const blocks = def?.output?.render?.(args, value)
    if (Array.isArray(blocks)) {
      const text = blocks
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (text) return text
    }
  } catch {
    // render 出错就退回 JSON
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const samePath = (a, b) => {
  const fold = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p
  return fold(path.resolve(String(a))) === fold(path.resolve(String(b)))
}

/**
 * 为一个场景搭假宿主并 apply 插件。
 *
 * @param mod        插件模块实例
 * @param options.label     用于临时目录名与 agent id
 * @param options.userTexts 该场景全部用户消息（含最后一条），snapshotEvents() 原样返回
 */
export function makeScenarioHost(mod, { label, userTexts }) {
  const root = mkdtempSync(path.join(os.tmpdir(), `wsm-remember-${label}-`))
  const workspace = path.join(root, 'ws')
  const memoryDir = path.join(root, 'proj', 'memory')
  const globalMemoryDir = path.join(root, 'global', 'memory')
  const agentsFile = path.join(root, 'AGENTS.md')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(path.dirname(globalMemoryDir), { recursive: true })
  writeFileSync(agentsFile, SEED_AGENTS, 'utf8')

  const agent = { id: `agent-${label}` }
  // 事件按宿主官方形状给：新版 userTextsOf 只认 source.kind === 'user'（人亲手发的消息），
  // 旧版只读 data.content，两边都能读。system-reminder 的 context 快照不在这里（它不是用户说的话）。
  const session = {
    id: agent.id,
    snapshotEvents: () =>
      userTexts.map((text, i) => ({
        type: 'user/message',
        data: { id: `${agent.id}-u${i + 1}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
      })),
  }

  const tools = new Map()
  const commands = new Map()
  const routes = new Map()
  const listeners = new Map()
  // 宿主的两种提示词注册（docs/subsystems/system-prompt.md）：
  //   section → 拼进 system prompt；context → 作为 user 角色的快照进历史，不进 system prompt
  const sections = []
  const contexts = []

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
      section: (def) => (sections.push(def), () => {}),
      context: (def) => (contexts.push(def), () => {}),
    },
    webServer: { register: (def) => (routes.set(def.path, def), () => {}) },
    agents: { currentInitiator: () => agent },
    sessions: { get: (id) => (id === agent.id ? session : undefined) },
    workingDirectory: { get: (s) => (s === session ? workspace : undefined) },
    get: () => undefined,
  }

  // 旧版不认识 globalMemoryDir，会往 stderr 打「未知配置项」；收集起来写进明细，不刷屏
  const rawConfig = { memoryDir, agentsFile, globalMemoryDir }
  const configNotes = []
  const originalError = console.error
  console.error = (...parts) => configNotes.push(parts.map(String).join(' '))
  try {
    mod.apply(ctx, rawConfig)
  } finally {
    console.error = originalError
  }

  // —— 隔离核对：插件实际生效的路径必须都是临时目录，否则立即中止 ——
  const problems = []
  if (typeof mod.resolveConfig === 'function') {
    const resolved = mod.resolveConfig(rawConfig)?.config ?? {}
    if (!resolved.memoryDir || !samePath(resolved.memoryDir, memoryDir)) problems.push(`memoryDir 未生效：${resolved.memoryDir}`)
    if (!resolved.agentsFile || !samePath(resolved.agentsFile, agentsFile)) problems.push(`agentsFile 未生效：${resolved.agentsFile}`)
  }
  if (typeof mod.agentsStatus === 'function') {
    const status = mod.agentsStatus()
    if (!status?.path || !samePath(status.path, agentsFile)) problems.push(`AGENTS.md 指向 ${status?.path}`)
  }
  if (typeof mod.globalMemoryDirOf === 'function') {
    const dir = mod.globalMemoryDirOf()
    if (!dir || !samePath(dir, globalMemoryDir)) problems.push(`globalMemoryDir 指向 ${dir}`)
  }
  if (problems.length > 0) {
    rmSync(root, { recursive: true, force: true })
    const error = new Error(`隔离核对失败（为避免写到真实 ~/.dsh 已中止）：${problems.join('；')}`)
    error.fatal = true
    throw error
  }

  const remember = tools.get('memory_remember')
  const recall = tools.get('memory_recall')
  if (!remember || !recall) {
    rmSync(root, { recursive: true, force: true })
    const error = new Error('插件没有注册 memory_remember / memory_recall')
    error.fatal = true
    throw error
  }

  /**
   * 解析一组 section / context：按 order 升序、同 order 按 name 的码元序（与宿主一致）；
   * text 是函数就以 AssembleContext（这里只带 agent）调用。单条抛错按空处理，不拖垮整份提示词。
   */
  function resolveTexts(defs) {
    const parts = []
    const sorted = [...defs].sort((a, b) => {
      const byOrder = (a.order ?? 0) - (b.order ?? 0)
      if (byOrder !== 0) return byOrder
      const an = String(a.name ?? '')
      const bn = String(b.name ?? '')
      return an < bn ? -1 : an > bn ? 1 : 0
    })
    for (const def of sorted) {
      try {
        const text = typeof def.text === 'function' ? def.text({ agent }) : def.text
        if (typeof text === 'string' && text.trim()) parts.push(text)
      } catch {
        // 与宿主一致：单条失败不影响其余
      }
    }
    return parts.join('\n\n')
  }

  /** waterfall：依次调监听器，next() 进入下一个，最后一个的 next 原样返回 fallback。 */
  async function waterfall(name, args, fallback) {
    const list = listeners.get(name) ?? []
    const step = async (i) => {
      if (i >= list.length) return fallback
      return list[i](...args, () => step(i + 1))
    }
    return step(0)
  }

  return {
    root,
    workspace,
    memoryDir,
    globalMemoryDir,
    agentsFile,
    agent,
    session,
    tools,
    configNotes,

    /**
     * 照真实宿主的顺序触发 agent/pre-step：每条用户消息一批（一轮一条），消息按官方 UserMessage 形状给
     * （带 source.kind === 'user'）。新版插件在这里收「用户原话」缓存（证据核对的主路径）并做预取；
     * 旧版只做预取（最后一批的结果生效，与以前「只带最后一条」等价）。
     */
    async firePreStep(texts) {
      const list = Array.isArray(texts) ? texts : [texts]
      for (const [i, text] of list.entries()) {
        try {
          await waterfall(
            'agent/pre-step',
            [
              {
                agent,
                turn: i + 1,
                messages: [{ id: `${agent.id}-u${i + 1}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
              },
            ],
            undefined,
          )
        } catch {
          // 预取失败不影响评测（插件自己也是这么对待的）
        }
      }
    },

    /** 插件 section 的文本（进 system prompt）：按 order、再按 name 升序，text 是函数就真实调用。 */
    pluginSectionText: () => resolveTexts(sections),

    /** 插件 context 的文本（作为 user 角色快照进历史）。旧版在库为空时返回空串，照实使用。 */
    pluginContextText: () => resolveTexts(contexts),

    /** 注册了几个 section / context（写进明细，确认新旧版的注册方式）。 */
    promptRegistrations: () => ({
      sections: sections.map((def) => ({ name: def.name, order: def.order })),
      contexts: contexts.map((def) => ({ name: def.name, order: def.order })),
    }),

    /** 通用工具执行后的 post-execute 钩子（paths 提示）；任何异常都返回原文本。 */
    async postExecute(name, args, text) {
      try {
        const result = { kind: 'accept', content: [{ type: 'text', text }] }
        const out = await waterfall('tools/post-execute', [{ name, arguments: args, agent }, result], result)
        const blocks = Array.isArray(out?.content) ? out.content : result.content
        return blocks
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text)
          .join('')
      } catch {
        return text
      }
    },

    /**
     * 预置一条记忆（U 类）。优先用导出的 writeMemory；失败再退回调 handler。
     * 返回 { ok, via, id }。
     */
    async preset(item) {
      const file = path.join(memoryDir, `${item.id}.md`)
      if (typeof mod.writeMemory === 'function') {
        try {
          mod.writeMemory(memoryDir, {
            slug: item.id,
            title: item.title,
            description: item.description,
            body: item.body,
            type: item.type,
            scope: 'project',
            load: 'on-demand',
            source: 'user',
          })
          if (existsSync(file)) return { ok: true, via: 'writeMemory', id: item.id }
        } catch {
          // 退回 handler
        }
      }
      try {
        await remember.execute(
          {
            slug: item.id,
            title: item.title,
            description: item.description,
            body: item.body,
            type: item.type,
            confidence: 1,
            newMemory: true,
          },
          { agent },
        )
      } catch {
        // 下面按文件是否存在判定
      }
      return { ok: existsSync(file), via: 'handler', id: item.id }
    },

    /** 临时根目录下的全部文件（相对路径 → 内容），工作目录除外。写进明细用。 */
    snapshotFiles() {
      const out = {}
      const walk = (dir) => {
        let entries
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name)
          const rel = path.relative(root, full).replace(/\\/g, '/')
          if (rel === 'ws') continue
          if (entry.isDirectory()) walk(full)
          else {
            try {
              out[rel] = readFileSync(full, 'utf8')
            } catch {
              out[rel] = '<unreadable>'
            }
          }
        }
      }
      walk(root)
      return out
    },

    /** 记忆库里的条目 id（项目库 + 全局按需库，不含 MEMORY.md）。 */
    libraryIds() {
      const list = (dir) => {
        try {
          return readdirSync(dir).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md').map((name) => name.slice(0, -3))
        } catch {
          return []
        }
      }
      return { project: list(memoryDir), global: list(globalMemoryDir) }
    },

    /** AGENTS.md 里比初始多出来的章数。 */
    agentsChaptersAdded() {
      try {
        const text = readFileSync(agentsFile, 'utf8')
        const count = (text.match(/^## \d+\./gm) ?? []).length
        return Math.max(0, count - SEED_CHAPTERS)
      } catch {
        return 0
      }
    },

    readFile(rel) {
      try {
        return readFileSync(path.join(root, rel), 'utf8')
      } catch {
        return null
      }
    },

    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}
