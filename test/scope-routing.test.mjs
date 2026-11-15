/**
 * `memory_remember` 写进全局 AGENTS.md 的分支（scope: global + load: always）。
 *
 * 规则（用户 2026-11-03 定，2026-11-14 改成 scope × load 两个选择）：
 *   · 只有 `scope: global` 且 `load: always` 才写 ~/.dsh/AGENTS.md；单独的 `scope: global` 进全局按需库。
 *   · **同名章更新，不追加重名**——AGENTS.md 每轮注入且有字节预算，重复条目会把重要内容挤掉。
 *   · **写 AGENTS.md 一律先进待确认，用户在面板里收下才写**（第五轮设计变更）——写错会影响所有项目的每一轮，
 *     而证据核对只能证明「这几个字出自用户」：用户回一句「好的，继续」就能被拿来当证据。
 *     以前「用户原话 + 证据通过」会直写，那条路已经关掉；下面的用例都改成「入队 → 收下 → 写入」。
 *   · 章节协议（chapter: N / 同名 / newChapter）在**入队之前**校验，章号与当时的章标题存进草稿，收下时核对。
 *
 * 本测试用临时 AGENTS.md + 临时工作区 + 临时全局库，不碰真实的 ~/.dsh。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { realFilesGuard, userEvent } from './fake-host.mjs'

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
 * 安全网：真实 AGENTS.md 与真实全局按需库的快照（只比存在性与哈希，不读出内容）。
 *
 * `apply(ctx, rawConfig)` 内部会 `configure(rawConfig)`——**不传 config 就会重置成默认值**，
 * 也就是真实的 ~/.dsh/AGENTS.md。第一版测试正是这样把「## 12. 全局规则甲」写进了真文件。
 * 所以：① config 必须经 apply 传入；② 结束时断言真文件一个字节都没变。
 */
const guard = realFilesGuard()

/** 用户在本会话里说过的话：证据核对读它。 */
const SAID = [
  '以后所有项目都用中文回答我，规则正文。',
  '全局规则甲：第一版正文。',
  '全局规则甲：第二版正文。',
  '原有内容。新增内容。',
]

/** 造一个临时环境：临时 AGENTS.md + 临时工作区 + 临时全局库 + 捕获到的工具表。 */
function makeEnv() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-scope-'))
  const agentsFile = path.join(root, 'AGENTS.md')
  writeFileSync(agentsFile, BASE, 'utf8')
  const workspace = path.join(root, 'ws')
  const memoryDir = path.join(root, 'proj', 'memory')
  const globalDir = path.join(root, 'global', 'memory')
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
    sessions: { get: () => ({ id: 's-test', snapshotEvents: () => SAID.map(userEvent) }) },
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
  mod.apply(ctx, { agentsFile, memoryDir, globalMemoryDir: globalDir, agentWrites: 'review' })

  const tool = tools.find((entry) => entry.name === 'memory_remember')
  const files = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md') : [])

  return {
    root,
    agentsFile,
    tool,
    memoryDir,
    agentsText: () => readFileSync(agentsFile, 'utf8'),
    libraryFiles: () => files(memoryDir),
    globalFiles: () => files(globalDir),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
      mod.configure(undefined)
    },
  }
}

const run = (env, args) => env.tool.execute(args, { agent: { id: 'a-test' } })
/** 常驻写入：入队（断言进了待确认、AGENTS.md 没动），再收下，返回两步的结果。 */
async function queueAndAccept(env, args) {
  const before = env.agentsText()
  const queued = await run(env, args)
  const untouched = env.agentsText() === before
  const accepted = queued.pending === true ? await mod.acceptPending(env.memoryDir, queued.id) : { ok: false, reason: 'not-queued' }
  return { queued, untouched, accepted }
}
/** 用户原话支撑的、写进 AGENTS.md 的参数。 */
const userAlways = (extra) => ({ type: 'feedback', source: 'user', scope: 'global', load: 'always', ...extra })

console.log('== 工具声明了 scope / load 参数 ==')
{
  const env = makeEnv()
  try {
    const schema = env.tool.parameters.properties.scope
    check('有 scope 字段', Boolean(schema), JSON.stringify(Object.keys(env.tool.parameters.properties)))
    check('scope 枚举含 project / global', (schema?.enum ?? []).join(',') === 'project,global', JSON.stringify(schema?.enum))
    check('load 枚举含 on-demand / always', (env.tool.parameters.properties.load?.enum ?? []).join(',') === 'on-demand,always')
  } finally {
    env.cleanup()
  }
}

console.log('\n== global + always + 用户原话 → 先进待确认，收下后写 AGENTS.md，不写任何记忆库 ==')
{
  const env = makeEnv()
  try {
    const { queued, untouched, accepted } = await queueAndAccept(env, userAlways({ title: '全局规则甲', body: '规则正文。', evidence: '以后所有项目都用中文回答我', newChapter: true }))
    check('用户原话、证据核对得上也进待确认（always-needs-user）', queued.pending === true && queued.reason === 'always-needs-user', JSON.stringify(queued))
    check('  …入队时 AGENTS.md 一个字没动', untouched)
    const text = env.agentsText()
    check('收下后 AGENTS.md 新增了该章', text.includes('## 2. 全局规则甲'), text.slice(-120))
    check('收下返回标记为 added', accepted.ok === true && accepted.action === 'added', JSON.stringify(accepted))
    check('项目记忆库没有被写入', env.libraryFiles().length === 0, env.libraryFiles().join(','))
    check('全局按需库也没有被写入', env.globalFiles().length === 0)
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
    const result = await run(env, userAlways({ title: '一个全新的主题', body: '正文。', evidence: '以后所有项目都用中文回答我' }))
    check('没有写入', env.agentsText() === before)
    check('reason 是 needs-confirmation（入队之前就校验）', result.reason === 'needs-confirmation', JSON.stringify(result))
    check('  …也没有进待确认队列', mod.listPending(env.memoryDir).length === 0)
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
    const { queued, untouched, accepted } = await queueAndAccept(env, userAlways({ title: '合并后的第一章', body: '原有内容。\n\n新增内容。', evidence: '原有内容。新增内容。', chapter: 1 }))
    check('入队，草稿记着要更新第 1 章与它当时的标题', queued.pending === true && queued.chapter === 1 && untouched &&
      mod.listPending(env.memoryDir).length === 0 /* 收下后草稿已删 */, JSON.stringify(queued))
    const text = env.agentsText()
    check('收下返回 updated', accepted.ok === true && accepted.action === 'updated', JSON.stringify(accepted))
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
    const result = await run(env, userAlways({ title: 'x', body: 'y', evidence: '以后所有项目都用中文回答我', chapter: 99 }))
    check('拒写', env.agentsText() === before)
    check('说明章号不存在（入队之前就拒写）', result.reason === 'chapter-not-found' && /no chapter 99/.test(result.text ?? '') && mod.listPending(env.memoryDir).length === 0, result.text)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 同名再写 → 更新，不追加重名 ==')
{
  const env = makeEnv()
  try {
    await queueAndAccept(env, userAlways({ title: '全局规则甲', body: '第一版正文。', evidence: '全局规则甲：第一版正文。', newChapter: true }))
    // 同名时精确匹配优先，不需要再声明 newChapter；入队时就定好「更新第 2 章」
    const { queued, accepted } = await queueAndAccept(env, userAlways({ title: '全局规则甲', body: '第二版正文。', evidence: '全局规则甲：第二版正文。' }))
    const text = env.agentsText()
    const hits = [...text.matchAll(/^## \d+\. 全局规则甲$/gm)].length
    check('入队时按同名定为更新第 2 章', queued.chapter === 2, JSON.stringify(queued))
    check('只有一章', hits === 1, `出现 ${hits} 次`)
    check('返回标记为 updated', accepted.action === 'updated', JSON.stringify(accepted.action))
    check('正文被替换成新版', text.includes('第二版正文。') && !text.includes('第一版正文。'))
    check('编号仍连续', /^## 1\. 已有的一章$/m.test(text) && /^## 2\. 全局规则甲$/m.test(text), text.slice(-120))
  } finally {
    env.cleanup()
  }
}

console.log('\n== global + always：不论来源、不论证据，一律进待确认，AGENTS.md 不动 ==')
{
  const env = makeEnv()
  try {
    const before = env.agentsText()
    const agent = await run(env, { title: '模型自己总结的全局规则', body: '正文。', type: 'pitfall', source: 'agent', scope: 'global', load: 'always', newChapter: true })
    check('agent 来源 → pending / always-needs-user', agent.pending === true && agent.reason === 'always-needs-user', JSON.stringify(agent))
    const fake = await run(env, userAlways({ title: '证据对不上的全局规则', body: '正文。', evidence: '用户从没说过这句话', newChapter: true }))
    check('user 来源（证据对不上）→ 同样 pending / always-needs-user', fake.pending === true && fake.reason === 'always-needs-user', JSON.stringify(fake))
    const real = await run(env, userAlways({ title: '以后所有项目都用中文回答', body: '正文。', evidence: '以后所有项目都用中文回答我', newChapter: true }))
    check('user 来源、证据核对得上 → 也是 pending / always-needs-user（不再直写）', real.pending === true && real.reason === 'always-needs-user', JSON.stringify(real))
    check('文本让模型告诉用户去面板看', /waiting in the memory panel/.test(fake.text) && /AGENTS\.md/.test(fake.text), fake.text)
    check('AGENTS.md 未被改动', env.agentsText() === before)
    check('两个记忆库都没有写入', env.libraryFiles().length === 0 && env.globalFiles().length === 0)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 收下常驻草稿 → 写进 AGENTS.md ==')
{
  const env = makeEnv()
  try {
    const queued = await run(env, { title: '待确认的全局规则', body: '确认后的正文。', type: 'feedback', source: 'agent', scope: 'global', load: 'always', newChapter: true })
    const draft = mod.listPending(env.memoryDir).find((item) => item.id === queued.id)
    check('草稿记下了 scope / load / source', draft?.meta.scope === 'global' && draft?.meta.load === 'always' && draft?.meta.source === 'agent', JSON.stringify(draft?.meta))
    const accepted = await mod.acceptPending(env.memoryDir, queued.id)
    const text = env.agentsText()
    check('accept 成功', accepted.ok === true, JSON.stringify(accepted))
    check('写进了 AGENTS.md', text.includes('待确认的全局规则'), text.slice(-120))
    check('没有写进任何记忆库', env.libraryFiles().length === 0 && env.globalFiles().length === 0, env.libraryFiles().join(','))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 只写 scope: global（load 默认 on-demand）→ 不碰 AGENTS.md ==')
{
  const env = makeEnv()
  try {
    const before = env.agentsText()
    const result = await run(env, { slug: 'global-on-demand', title: '跨项目但只在特定场景用', body: '正文。', type: 'reference', source: 'agent', scope: 'global' })
    check('进了待确认（agent 来源默认要人看）', result.pending === true && result.scope === 'global' && result.load === 'on-demand', JSON.stringify(result))
    check('AGENTS.md 未被改动', env.agentsText() === before)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 项目 scope 行为不变 ==')
{
  const env = makeEnv()
  try {
    const before = env.agentsText()
    // 证据要与标题或摘要沾边（evidenceRelates，第五轮）
    const result = await run(env, { title: '项目内的决定：都用中文回答', slug: 'project-decision', body: '正文。', type: 'project', source: 'user', evidence: '以后所有项目都用中文回答我', scope: 'project' })
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
    await run(env, { title: '未指定归属：都用中文回答', slug: 'unspecified-scope', body: '正文。', type: 'project', source: 'user', evidence: '以后所有项目都用中文回答我' })
    check('进了项目库', env.libraryFiles().length === 1, env.libraryFiles().join(','))
    check('AGENTS.md 未被改动', env.agentsText() === before)
  } finally {
    env.cleanup()
  }
}

console.log(`\n== 真实文件未被本次测试改动 ==`)
check('~/.dsh/AGENTS.md 与 ~/.dsh/global-memory 的存在性与哈希不变', guard.unchanged())

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
