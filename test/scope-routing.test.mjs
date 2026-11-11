/**
 * `memory_remember` 的 scope 分流：项目记忆 vs 全局 AGENTS.md。
 *
 * 规则（用户 2026-11-03 定）：跨项目通用规则可以直写 ~/.dsh/AGENTS.md；
 * 该项目内的决策仍写项目记忆库。两条硬约束：
 *   1. **同名章更新，不追加重名**——AGENTS.md 每轮注入且有字节预算，重复条目会把重要内容挤掉。
 *   2. **低置信度不直写 AGENTS.md**——写错会影响所有项目，必须经人确认。
 *
 * 本测试用临时 AGENTS.md + 临时工作区，不碰真实的 ~/.dsh/AGENTS.md。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
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

const BASE = ['# 全局工作约定', '', '适用于所有项目。', '', '## 1. 已有的一章', '', '原有内容。', ''].join('\n')

/**
 * 安全网：真实 AGENTS.md 的快照。
 *
 * `apply(ctx, rawConfig)` 内部会 `configure(rawConfig)`——**不传 config 就会重置成默认值**，
 * 也就是真实的 ~/.dsh/AGENTS.md。第一版测试正是这样把「## 12. 全局规则甲」写进了真文件。
 * 所以：① config 必须经 apply 传入；② 结束时断言真文件一个字节都没变。
 */
const REAL_AGENTS = path.join(os.homedir(), '.dsh', 'AGENTS.md')
const realBefore = existsSync(REAL_AGENTS) ? readFileSync(REAL_AGENTS, 'utf8') : ''

/** 造一个临时环境：临时 AGENTS.md + 临时工作区 + 捕获到的工具表。 */
function makeEnv() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-scope-'))
  const agentsFile = path.join(root, 'AGENTS.md')
  writeFileSync(agentsFile, BASE, 'utf8')
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
    sessions: { get: () => ({ id: 's-test' }) },
    workingDirectory: { get: () => workspace },
    get(name) {
      if (name === 'tools') return ctx.tools
      if (name === 'commands') return ctx.commands
      if (name === 'systemPrompt') return ctx.systemPrompt
      if (name === 'webServer') return ctx.webServer
      return undefined
    },
  }

  // 关键：config 必须传给 apply，不能先 configure() 再 apply()——后者会把前者的设置覆盖掉
  mod.apply(ctx, { agentsFile, directWriteConfidence: 0.8 })

  const tool = tools.find((entry) => entry.name === 'memory_remember')
  const projectDir = path.join(os.homedir(), '.dsh', 'projects', mod.encodeProjectPath(workspace))
  // 工具内部用 resolveMemoryDir(workspace) 算库路径，测试必须用同一个
  const memoryDir = path.join(projectDir, 'memory')

  return {
    root,
    agentsFile,
    tool,
    memoryDir,
    projectDir,
    agentsText: () => readFileSync(agentsFile, 'utf8'),
    libraryFiles: () => {
      const dir = path.join(projectDir, 'memory')
      return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md') : []
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
      mod.configure(undefined)
    },
  }
}

const run = (env, args) => env.tool.execute(args, { agent: { id: 'a-test' } })

console.log('== 工具声明了 scope 参数 ==')
{
  const env = makeEnv()
  try {
    const schema = env.tool.parameters.properties.scope
    check('有 scope 字段', Boolean(schema), JSON.stringify(Object.keys(env.tool.parameters.properties)))
    check('枚举含 project / global', (schema?.enum ?? []).join(',') === 'project,global', JSON.stringify(schema?.enum))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 全局 + 高置信度 → 写 AGENTS.md，不写项目库 ==')
{
  const env = makeEnv()
  try {
    const result = await run(env, { title: '全局规则甲', body: '规则正文。', confidence: 0.95, scope: 'global', newChapter: true })
    const text = env.agentsText()
    check('AGENTS.md 新增了该章', text.includes('## 2. 全局规则甲'), text.slice(-120))
    check('返回标记为 added', result.action === 'added', JSON.stringify(result.action))
    check('项目记忆库没有被写入', env.libraryFiles().length === 0, env.libraryFiles().join(','))
    check('原有章保持不变', text.includes('## 1. 已有的一章') && text.includes('原有内容。'))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 没声明 newChapter 且不同名 → 拒写并回清单 ==')
{
  const env = makeEnv()
  try {
    const before = env.agentsText()
    const result = await run(env, { title: '一个全新的主题', body: '正文。', confidence: 0.95, scope: 'global' })
    check('没有写入', env.agentsText() === before)
    check('reason 是 needs-confirmation', result.reason === 'needs-confirmation', JSON.stringify(result))
    check('written 标记为 false', result.written === false, JSON.stringify(result.written))
    check('回显了现有章节清单', /1\. 已有的一章/.test(result.text ?? ''), result.text?.slice(0, 200))
    check('提示了两种出路', /chapter: <number>/.test(result.text ?? '') && /newChapter: true/.test(result.text ?? ''))
  } finally {
    env.cleanup()
  }
}

console.log('\n== chapter: N 更新指定章（不新增）==')
{
  const env = makeEnv()
  try {
    const result = await run(env, {
      title: '合并后的第一章',
      body: '原有内容。\n\n新增内容。',
      confidence: 0.95,
      scope: 'global',
      chapter: 1,
    })
    const text = env.agentsText()
    check('返回 updated', result.action === 'updated', JSON.stringify(result.action))
    check('章数没有增加', [...text.matchAll(/^## \d+\./gm)].length === 1, text)
    check('标题被替换', text.includes('## 1. 合并后的第一章'), text)
    check('新旧内容都在', text.includes('原有内容。') && text.includes('新增内容。'))
  } finally {
    env.cleanup()
  }
}

console.log('\n== chapter 越界 → 明确报错 ==')
{
  const env = makeEnv()
  try {
    const before = env.agentsText()
    const result = await run(env, { title: 'x', body: 'y', confidence: 0.95, scope: 'global', chapter: 99 })
    check('拒写', env.agentsText() === before)
    check('说明章号不存在', /chapter-not-found/.test(result.text ?? ''), result.text)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 同名再写 → 更新，不追加重名 ==')
{
  const env = makeEnv()
  try {
    await run(env, { title: '全局规则甲', body: '第一版正文。', confidence: 0.95, scope: 'global', newChapter: true })
    // 同名时精确匹配优先，不需要再声明 newChapter
    const result = await run(env, { title: '全局规则甲', body: '第二版正文。', confidence: 0.95, scope: 'global' })
    const text = env.agentsText()
    const hits = [...text.matchAll(/^## \d+\. 全局规则甲$/gm)].length
    check('只有一章', hits === 1, `出现 ${hits} 次`)
    check('返回标记为 updated', result.action === 'updated', JSON.stringify(result.action))
    check('正文被替换成新版', text.includes('第二版正文。') && !text.includes('第一版正文。'))
    check('编号仍连续', /^## 1\. 已有的一章$/m.test(text) && /^## 2\. 全局规则甲$/m.test(text), text.slice(-120))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 全局 + 低置信度 → 进待确认，AGENTS.md 不动 ==')
{
  const env = makeEnv()
  try {
    const before = env.agentsText()
    const result = await run(env, { title: '没把握的全局规则', body: '正文。', confidence: 0.5, scope: 'global' })
    check('返回 pending', result.pending === true, JSON.stringify(result))
    check('AGENTS.md 未被改动', env.agentsText() === before)
    check('项目库也没有写入', env.libraryFiles().length === 0)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 收下全局草稿 → 写进 AGENTS.md ==')
{
  const env = makeEnv()
  try {
    const queued = await run(env, { title: '待确认的全局规则', body: '确认后的正文。', confidence: 0.5, scope: 'global' })
    const accepted = await mod.acceptPending(env.memoryDir, queued.id)
    const text = env.agentsText()
    check('accept 成功', accepted.ok === true, JSON.stringify(accepted))
    check('写进了 AGENTS.md', text.includes('待确认的全局规则'), text.slice(-120))
    check('没有写进项目库', env.libraryFiles().length === 0, env.libraryFiles().join(','))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 项目 scope 行为不变 ==')
{
  const env = makeEnv()
  try {
    const before = env.agentsText()
    const result = await run(env, { title: '项目内的决定', body: '正文。', confidence: 0.95, scope: 'project' })
    check('写进了项目库', env.libraryFiles().length === 1, env.libraryFiles().join(','))
    check('AGENTS.md 未被改动', env.agentsText() === before)
    check('返回的是记忆 id', typeof result.id === 'string' && result.id.length > 0, JSON.stringify(result.id))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 不传 scope 时默认按项目处理 ==')
{
  const env = makeEnv()
  try {
    const before = env.agentsText()
    await run(env, { title: '未指定归属', body: '正文。', confidence: 0.95 })
    check('进了项目库', env.libraryFiles().length === 1, env.libraryFiles().join(','))
    check('AGENTS.md 未被改动', env.agentsText() === before)
  } finally {
    env.cleanup()
  }
}

console.log(`\n== 真实 AGENTS.md 未被本次测试改动 ==`)
{
  const realAfter = existsSync(REAL_AGENTS) ? readFileSync(REAL_AGENTS, 'utf8') : ''
  check('~/.dsh/AGENTS.md 未变', realAfter === realBefore, `before ${realBefore.length} → after ${realAfter.length} 字符`)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
