/**
 * 写入前查重 + 覆盖（supersedes）。
 *
 * 要解决的问题：`memory_remember` 只在 slug 相同时覆盖，slug 不同就并存。
 * 于是「本地脚本是兜底」和「本地脚本已关闭」会同时躺在库里，召回读到哪条看分数
 * ——比没有记忆更糟。
 *
 * 规则（用户 2026-11-03 定）：命中疑似重复就**拒写**并回候选，由调用方显式选择：
 *   · `supersedes: <id>` → 覆盖旧的那条（旧正文归档到 history/）
 *   · `newMemory: true`  → 确实是新的一条
 *
 * 全部使用临时工作区，不碰真实记忆库。
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
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

function makeEnv(extraConfig = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-dup-'))
  const workspace = path.join(root, 'ws')
  const tools = []

  const ctx = {
    effect(fn) {
      try {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      } catch {
        return () => {}
      }
    },
    on() {},
    commands: { register: () => {}, },
    tools: { register: (def) => { tools.push(def); return () => {} } },
    systemPrompt: { context: () => () => {} },
    webServer: { register: () => () => {} },
    agents: { currentInitiator: () => null, },
    sessions: { get: () => ({ id: 's-dup' }) },
    workingDirectory: { get: () => workspace },
    get(name) {
      if (name === 'tools') return ctx.tools
      if (name === 'commands') return ctx.commands
      if (name === 'systemPrompt') return ctx.systemPrompt
      if (name === 'webServer') return ctx.webServer
      return undefined
    },
  }

  mod.apply(ctx, { agentsFile: path.join(root, 'AGENTS.md'), duplicateCheck: true, ...extraConfig })

  const projectDir = path.join(os.homedir(), '.dsh', 'projects', mod.encodeProjectPath(workspace))
  const memoryDir = path.join(projectDir, 'memory')

  return {
    root,
    memoryDir,
    projectDir,
    tool: tools.find((entry) => entry.name === 'memory_remember'),
    ids: () => (existsSync(memoryDir) ? readdirSync(memoryDir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').map((n) => n.replace(/\.md$/, '')) : []),
    read: (id) => readFileSync(path.join(memoryDir, `${id}.md`), 'utf8'),
    historyOf: (id) => {
      const dir = path.join(projectDir, '.memory-state', 'history', id)
      return existsSync(dir) ? readdirSync(dir) : []
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
      mod.configure(undefined)
    },
  }
}

const run = (env, args) => env.tool.execute(args, { agent: { id: 'a-dup' } })

const PUBLISH_A = {
  slug: 'publish-github-actions-only',
  title: '发布只用 GitHub Actions 且每 4 小时批量',
  description: '发布节奏与渠道',
  body: '规则：每 4 小时批量发布，只用 GitHub Actions。',
  confidence: 0.95,
}

const PUBLISH_B = {
  slug: 'publish-cadence-updated',
  title: '发布只用 GitHub Actions，每 4 小时批量发',
  description: '发布节奏与渠道（修订）',
  body: '规则：每 4 小时批量发布，只用 GitHub Actions；本地脚本已关闭。',
  confidence: 0.95,
}

console.log('== 空库首次写入不受影响 ==')
{
  const env = makeEnv()
  try {
    const result = await run(env, PUBLISH_A)
    check('写入成功', typeof result.id === 'string', JSON.stringify(result))
    check('库里有 1 条', env.ids().length === 1, env.ids().join(','))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 疑似重复 → 拒写并回候选 ==')
{
  const env = makeEnv()
  try {
    await run(env, PUBLISH_A)
    const before = env.read('publish-github-actions-only')
    const result = await run(env, PUBLISH_B)

    check('没有写入', env.ids().length === 1, env.ids().join(','))
    check('reason = needs-review', result.reason === 'needs-review', JSON.stringify(result.reason))
    check('written = false', result.written === false, JSON.stringify(result.written))
    check('候选里出现了那条', (result.candidates ?? []).some((c) => c.id === 'publish-github-actions-only'), JSON.stringify(result.candidates))
    check('标出了分数', (result.candidates ?? []).every((c) => typeof c.score === 'number'), JSON.stringify(result.candidates?.[0]))
    check('提示两种出路', /supersedes/.test(result.text ?? '') && /newMemory/.test(result.text ?? ''))
    check('已有条目未被改动', env.read('publish-github-actions-only') === before)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 查重不计入 hits（否则淘汰统计失真）==')
{
  const env = makeEnv()
  try {
    await run(env, PUBLISH_A)
    const hitsOf = (text) => Number(/^hits:\s*(\d+)$/m.exec(text)?.[1] ?? 0)
    const before = hitsOf(env.read('publish-github-actions-only'))
    await run(env, PUBLISH_B) // 只触发查重，不写入
    const after = hitsOf(env.read('publish-github-actions-only'))
    check('hits 未增加', after === before, `${before} → ${after}`)
  } finally {
    env.cleanup()
  }
}

console.log('\n== newMemory: true → 确实是新的一条 ==')
{
  const env = makeEnv()
  try {
    await run(env, PUBLISH_A)
    const result = await run(env, { ...PUBLISH_B, newMemory: true })
    check('写入成功', typeof result.id === 'string', JSON.stringify(result))
    check('两条并存', env.ids().length === 2, env.ids().join(','))
  } finally {
    env.cleanup()
  }
}

console.log('\n== supersedes → 覆盖旧条目，旧的进 history ==')
{
  const env = makeEnv()
  try {
    await run(env, PUBLISH_A)
    const result = await run(env, { ...PUBLISH_B, supersedes: 'publish-github-actions-only' })

    check('写入成功', typeof result.id === 'string', JSON.stringify(result))
    check('返回 replaced', result.replaced === 'publish-github-actions-only', JSON.stringify(result.replaced))
    check('库里只剩新的', env.ids().length === 1, env.ids().join(','))
    check('旧 id 已消失', !env.ids().includes('publish-github-actions-only'), env.ids().join(','))
    check('新条目记录了 supersedes', /^supersedes:\s*publish-github-actions-only$/m.test(env.read(result.id)), env.read(result.id).slice(0, 400))
    check('旧正文进了 history', env.historyOf('publish-github-actions-only').length > 0, env.historyOf('publish-github-actions-only').join(','))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 不相关主题不误拦 ==')
{
  const env = makeEnv()
  try {
    await run(env, PUBLISH_A)
    const result = await run(env, {
      slug: 'no-explanatory-ui-text',
      title: '界面里不要自行添加解释性文字',
      description: 'UI 文案约定',
      body: '规则：界面只呈现数据与控件，解释写进 README。',
      confidence: 0.95,
    })
    check('直接写入', typeof result.id === 'string', JSON.stringify(result))
    check('变成 2 条', env.ids().length === 2, env.ids().join(','))
  } finally {
    env.cleanup()
  }
}

console.log('\n== supersedes 指向不存在的 id → 明确报错 ==')
{
  const env = makeEnv()
  try {
    const result = await run(env, { ...PUBLISH_B, supersedes: 'no-such-id' })
    check('拒写', env.ids().length === 0, env.ids().join(','))
    check('reason = supersedes-not-found', result.reason === 'supersedes-not-found', JSON.stringify(result.reason))
    check('提示先 recall 拿 id', /memory_recall/.test(result.text ?? ''), result.text)
  } finally {
    env.cleanup()
  }
}

console.log('\n== duplicateCheck: false → 关闭查重 ==')
{
  const env = makeEnv({ duplicateCheck: false })
  try {
    await run(env, PUBLISH_A)
    const result = await run(env, PUBLISH_B)
    check('两条并存（未拦截）', env.ids().length === 2, env.ids().join(','))
    check('写入成功', typeof result.id === 'string', JSON.stringify(result.id))
  } finally {
    env.cleanup()
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
