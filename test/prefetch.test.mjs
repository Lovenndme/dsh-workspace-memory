/**
 * 召回触发点③：用户消息进来时预取相关记忆。
 *
 * 另外两个触发点靠外部信号——会话开始（索引注入）、碰到文件（paths 提示）。
 * 用户直接提问时原本没有任何触发，「要不要 recall」全看模型自觉。
 *
 * 实现约束（决定了测试怎么写）：
 *   · `system-prompt/assemble` 的 context.text 是**同步**的，拿不到用户消息
 *   · `agent/pre-step` 是 async waterfall 且带 messages
 * 所以 pre-step 里 await 真正的 recall 存进缓存，注入只读缓存。
 * **不往 messages 里塞东西**——那会污染对话记录。
 *
 * 注意：断言必须限定在 `[相关记忆]` 段内。索引本身会列出全部条目，
 * 拿整段文本去断言「无关条目不在里面」是错的。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mod = await import('../index.js')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** 只取「相关记忆」那一段（索引里本来就有全部条目，整段断言会误判）。 */
const relatedSection = (text) => {
  const at = text.indexOf('[相关记忆]')
  return at === -1 ? '' : text.slice(at)
}

function makeEnv(config = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-prefetch-'))
  const workspace = path.join(root, 'ws')
  const listeners = new Map()
  const contexts = []
  const agent = { id: 'a-prefetch' }

  const ctx = {
    effect(fn) {
      try {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      } catch {
        return () => {}
      }
    },
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    commands: { register: () => {}, },
    tools: { register: () => () => {} },
    systemPrompt: {
      context: (def) => {
        contexts.push(def)
        return () => {}
      },
    },
    webServer: { register: () => () => {} },
    agents: { currentInitiator: () => agent, },
    sessions: { get: () => ({ id: 's-prefetch' }) },
    workingDirectory: { get: () => workspace },
    get() { return undefined },
  }

  mod.apply(ctx, { agentsFile: path.join(root, 'AGENTS.md'), memoryDir: path.join(root, 'proj', 'memory'), globalMemoryDir: path.join(root, 'global', 'memory'), prefetchRecall: true, ...config })

  // 记忆库与全局按需库都放在临时目录（经 apply 传入），不碰 ~/.dsh
  const projectDir = path.join(root, 'proj')
  const memoryDir = path.join(projectDir, 'memory')

  return {
    root,
    memoryDir,
    agent,
    preStep: async (messages, turn = 1) => {
      let reachedNext = false
      const next = async () => {
        reachedNext = true
        return { kind: 'enter', messages }
      }
      for (const handler of listeners.get('agent/pre-step') ?? []) {
        await handler({ agent, messages, turn, step: 1 }, next)
      }
      return { reachedNext }
    },
    fire: (name, payload) => {
      for (const handler of listeners.get(name) ?? []) handler(payload)
    },
    injection: () => contexts.find((def) => def.name === 'workspace-memory')?.text?.() ?? '',
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
      mod.configure(undefined)
    },
  }
}

const seed = (env, id, title, description, body) =>
  mod.writeMemory(env.memoryDir, { slug: id, title, description, body })

// 宿主送进 pre-step 的消息都带 source（真实宿主里必填）；没有 source 的消息不算人写的（第五轮）
const userMessage = (text) => [{ role: 'user', source: { kind: 'user' }, content: text }]

// 这条消息实测能过闸门（融合分 0.40）；换说法会掉到闸门以下，见金标集里 pos-npm-cadence 的已知未命中
// 无向量时用实际存在的词验证事件与缓存，不要求关键词检索理解改述。
const HIT_MESSAGE = (await mod.resolveEmbedder()) ? '发版的时候版本号应该什么时候改' : 'npm 发布'

console.log('== 相关的用户消息 → 注入里列出相关记忆 ==')
{
  const env = makeEnv()
  try {
    seed(env, 'npm-publish-cadence', 'npm 发布：只走 GitHub Actions 每 4 小时批量发', '发布节奏与版本号规则', '不要每次改动就发 npm，改成每 4 小时批量发布，版本号在发布那一刻才升。')
    seed(env, 'db-migration-rules', '数据库迁移必须可回滚且先备份', '生产库结构变更的硬性流程', '任何 schema 变更都要配回滚脚本，上线前全量备份。')

    await env.preStep(userMessage(HIT_MESSAGE))
    const text = env.injection()
    const section = relatedSection(text)
    check('出现相关记忆段', section !== '', text.slice(0, 200))
    check('列出的是发布那条', section.includes('npm-publish-cadence'), section)
    check('无关的数据库条目没被带进来', !section.includes('db-migration'), section)
    check('只给 id 与标题，不给正文', !section.includes('不要每次改动就发 npm'), section)
    check('索引本身仍完整注入', text.includes('[workspace-memory]') && text.includes('db-migration-rules'))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 无关的用户消息 → 不出现相关记忆段 ==')
{
  const env = makeEnv()
  try {
    seed(env, 'npm-publish-cadence', 'npm 发布：只走 GitHub Actions 每 4 小时批量发', '发布节奏与版本号规则', '不要每次改动就发 npm，改成每 4 小时批量发布。')
    await env.preStep(userMessage('Kubernetes 的 Pod 一直 CrashLoopBackOff 怎么排查'))
    check('没有相关记忆段', relatedSection(env.injection()) === '', env.injection().slice(-200))
    check('索引仍在注入（每轮的基础）', env.injection().includes('[workspace-memory]'))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 回合结束清缓存，不污染下一轮 ==')
{
  const env = makeEnv()
  try {
    seed(env, 'npm-publish-cadence', 'npm 发布：只走 GitHub Actions 每 4 小时批量发', '发布节奏与版本号规则', '不要每次改动就发 npm，改成每 4 小时批量发布。')
    await env.preStep(userMessage(HIT_MESSAGE))
    check('本轮有相关记忆', relatedSection(env.injection()) !== '')
    env.fire('agent/turn-stopping', { agent: env.agent, turn: 1 })
    check('回合结束后清掉', relatedSection(env.injection()) === '', env.injection().slice(-160))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 没有新用户消息时保留上一份缓存 ==')
{
  const env = makeEnv()
  try {
    seed(env, 'npm-publish-cadence', 'npm 发布：只走 GitHub Actions 每 4 小时批量发', '发布节奏与版本号规则', '不要每次改动就发 npm，改成每 4 小时批量发布。')
    await env.preStep(userMessage(HIT_MESSAGE))
    const before = relatedSection(env.injection())
    await env.preStep([])
    check('缓存仍在', relatedSection(env.injection()) === before && before !== '', before)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 关闭开关 / 空库都不挡步骤 ==')
{
  const off = makeEnv({ prefetchRecall: false })
  try {
    seed(off, 'npm-publish-cadence', 'npm 发布：每 4 小时批量发', '发布节奏', '不要每次改动就发 npm。')
    const run = await off.preStep(userMessage(HIT_MESSAGE))
    check('关闭后仍调用 next', run.reachedNext === true)
    check('关闭后没有相关记忆段', relatedSection(off.injection()) === '')
  } finally {
    off.cleanup()
  }

  const empty = makeEnv()
  try {
    const run = await empty.preStep(userMessage('随便问点什么'))
    check('空库仍调用 next', run.reachedNext === true)
    check('空库没有相关记忆段', relatedSection(empty.injection()) === '')
  } finally {
    empty.cleanup()
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
