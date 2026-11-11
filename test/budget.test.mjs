/**
 * 体量与条数预算：成本发生在哪，就在哪设限。
 *
 * | 成本 | 时机 | 策略 |
 * |---|---|---|
 * | 条数（MEMORY.md 索引每轮注入） | 每轮 | **硬限**，满了拒写并给淘汰候选 |
 * | 单条正文长度 | 只在 recall 那次 | **只提醒，不拦不截**（用户明确：长内容该长） |
 * | 一次召回总体积 | 特定调用 | 收敛「返回几条」，不切单条正文 |
 *
 * 最容易写错的一条：把长正文截断。这里专门断言「存进去的和传进去的一模一样」。
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
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

function makeEnv(config = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-budget-'))
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
    on() { return () => {} },
    commands: { register: () => {}, },
    tools: { register: (def) => { tools.push(def); return () => {} } },
    systemPrompt: { context: () => () => {} },
    webServer: { register: () => () => {} },
    agents: { currentInitiator: () => null, },
    sessions: { get: () => ({ id: 's-budget' }) },
    workingDirectory: { get: () => workspace },
    get() { return undefined },
  }

  mod.apply(ctx, { agentsFile: path.join(root, 'AGENTS.md'), duplicateCheck: false, ...config })

  const projectDir = path.join(os.homedir(), '.dsh', 'projects', mod.encodeProjectPath(workspace))
  const memoryDir = path.join(projectDir, 'memory')

  return {
    root,
    memoryDir,
    projectDir,
    tool: tools.find((entry) => entry.name === 'memory_remember'),
    // 文件不存在时返回 null，不抛异常——「没写进去」本身就是要断言的状态
    raw: (id) => {
      const file = path.join(memoryDir, `${id}.md`)
      return existsSync(file) ? readFileSync(file, 'utf8') : null
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
      mod.configure(undefined)
    },
  }
}

const run = (env, args) => env.tool.execute(args, { agent: { id: 'a-budget' } })
const mem = (n, extra = {}) => ({
  slug: `mem-${n}`,
  title: `记忆 ${n}`,
  description: `摘要 ${n}`,
  body: `正文 ${n}。`,
  confidence: 0.95,
  ...extra,
})

console.log('== 条数上限：满了拒写并给淘汰候选 ==')
{
  const env = makeEnv({ maxMemoryCount: 3 })
  try {
    for (let i = 1; i <= 3; i += 1) await run(env, mem(i))
    const result = await run(env, mem(4))
    check('拒写', result.written === false, JSON.stringify(result.written))
    check('reason = library-full', result.reason === 'library-full', JSON.stringify(result.reason))
    check('报出当前条数与上限', result.count === 3 && result.limit === 3, `${result.count}/${result.limit}`)
    check('给了淘汰候选', (result.candidates ?? []).length > 0, JSON.stringify(result.candidates))
    check('第 4 条没被写入', !env.raw('mem-4'))
    check('提示了 supersedes 与提额两条出路', /supersedes/.test(result.text ?? '') && /maxMemoryCount/.test(result.text ?? ''))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 库满时 supersedes 仍然可以写（替换不增加条数）==')
{
  const env = makeEnv({ maxMemoryCount: 2 })
  try {
    await run(env, mem(1))
    await run(env, mem(2))
    const result = await run(env, mem(3, { supersedes: 'mem-1' }))
    check('没被条数上限拦住', typeof result.id === 'string', JSON.stringify(result))
    check('返回 replaced', result.replaced === 'mem-1', JSON.stringify(result.replaced))
  } finally {
    env.cleanup()
  }
}

console.log('\n== maxMemoryCount: 0 = 不限制 ==')
{
  const env = makeEnv({ maxMemoryCount: 0 })
  try {
    for (let i = 1; i <= 4; i += 1) await run(env, mem(i))
    const ok = await run(env, mem(5))
    check('第 5 条照样写入', typeof ok.id === 'string', JSON.stringify(ok))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 长正文：提醒但不截断 ==')
{
  const env = makeEnv({ warnBodyChars: 200 })
  try {
    const longBody = `规则如下：\n\n${'这是一段确实需要详细说明的内容。'.repeat(40)}`
    const result = await run(env, mem('long', { body: longBody }))
    check('写入成功（没有拒）', typeof result.id === 'string', JSON.stringify(result))
    check('提示了长度', /soft threshold/.test(result.text ?? ''), result.text)
    check('提示了拆分建议', /splitting/.test(result.text ?? ''))
    check('正文一个字符都没丢', env.raw(result.id).includes(longBody.trim()), '存储内容与传入不一致')
  } finally {
    env.cleanup()
  }
}

console.log('\n== 召回预算：少带一条，不切正文 ==')
{
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-recall-'))
  const memoryDir = path.join(root, 'memory')
  try {
    mod.configure({ recallMaxChars: 400 })
    const body = '检索关键词 预算 命中。' + '填充内容'.repeat(60) // 约 500+ 字节
    for (let i = 1; i <= 3; i += 1) {
      mod.writeMemory(memoryDir, {
        slug: `recall-${i}`,
        title: `召回 ${i}`,
        description: '检索关键词 预算 命中',
        body,
        confidence: 0.9,
      })
    }
    const found = await mod.recall(memoryDir, '检索关键词 预算 命中', 3)
    check('返回条数被预算收敛', found.results.length < 3, `返回 ${found.results.length} 条`)
    check('如实报出还有几条没返回', found.omitted > 0, `omitted=${found.omitted}`)
    check('返回的正文是完整的（未被截断）', found.results.every((row) => row.body === body), JSON.stringify(found.results.map((r) => r.body.length)))
    check('每条带 chars 便于判断体积', found.results.every((row) => typeof row.chars === 'number'))
  } finally {
    rmSync(root, { recursive: true, force: true })
    mod.configure(undefined)
  }
}

console.log('\n== 预算关掉（0）时全部返回 ==')
{
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-recall2-'))
  const memoryDir = path.join(root, 'memory')
  try {
    mod.configure({ recallMaxChars: 0 })
    for (let i = 1; i <= 3; i += 1) {
      mod.writeMemory(memoryDir, {
        slug: `all-${i}`,
        title: `全部 ${i}`,
        description: '共同关键词 测试',
        body: '共同关键词 测试 ' + '内容'.repeat(200),
        confidence: 0.9,
      })
    }
    const found = await mod.recall(memoryDir, '共同关键词 测试', 3)
    check('三条都返回', found.results.length === 3, `返回 ${found.results.length} 条`)
  } finally {
    rmSync(root, { recursive: true, force: true })
    mod.configure(undefined)
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
