/** 升级前遗留常驻草稿的章节写入兼容；新 memory_remember 只写记忆库。 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { realFilesGuard, userEvent, legacyAlwaysDraft } from './fake-host.mjs'

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
/** 构造历史常驻草稿，再收下，验证旧草稿仍按原章节协议写入。 */
async function queueAndAccept(env, args) {
  const before = env.agentsText()
  const queued = legacyAlwaysDraft(mod, env, args)
  const untouched = env.agentsText() === before
  const accepted = queued.pending === true ? await mod.acceptPending(env.memoryDir, queued.id) : { ok: false, reason: 'not-queued' }
  return { queued, untouched, accepted }
}
/** 升级前的用户来源常驻草稿；也用来覆盖带旧 load 的新调用。 */
const userAlways = (extra) => ({ type: 'feedback', source: 'user', scope: 'global', load: 'always', ...extra })

console.log('== 工具声明 scope，移除 load 参数 ==')
{
  const env = makeEnv()
  try {
    const schema = env.tool.parameters.properties.scope
    check('有 scope 字段', Boolean(schema), JSON.stringify(Object.keys(env.tool.parameters.properties)))
    check('scope 枚举含 project / global', (schema?.enum ?? []).join(',') === 'project,global', JSON.stringify(schema?.enum))
    check('输入 schema 不再包含 load', !('load' in env.tool.parameters.properties))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 历史常驻草稿收下后写 AGENTS.md，不写任何记忆库 ==')
{
  const env = makeEnv()
  try {
    const { queued, untouched, accepted } = await queueAndAccept(env, userAlways({ title: '全局规则甲', body: '规则正文。', evidence: '以后所有项目都用中文回答我', newChapter: true }))
    check('旧常驻草稿可继续收下', queued.pending === true && accepted.ok === true, JSON.stringify(queued))
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
    const result = mod.planAgentsChapter({ title: '一个全新的主题' })
    check('没有写入', env.agentsText() === before)
    check('reason 是 needs-confirmation（入队之前就校验）', result.reason === 'needs-confirmation', JSON.stringify(result))
    check('  …也没有进待确认队列', mod.listPending(env.memoryDir).length === 0)
    check('规划未通过', result.ok === false, JSON.stringify(result))
    check('规划返回现有章节清单', result.chapters?.includes('1. 已有的一章'), JSON.stringify(result))
    check('规划不产生草稿', mod.listPending(env.memoryDir).length === 0)
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
    const result = mod.planAgentsChapter({ title: 'x', chapter: 99 })
    check('拒写', env.agentsText() === before)
    check('说明章号不存在（入队之前就拒写）', result.reason === 'chapter-not-found' && result.chapter === 99 && mod.listPending(env.memoryDir).length === 0, result.text)
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

console.log('\n== 旧 load 不改变新调用的来源分流，AGENTS.md 不动 ==')
{
  const env = makeEnv()
  try {
    const before = env.agentsText()
    const agent = await run(env, { slug: 'agent-global', title: '模型自己总结的全局规则', body: '正文。', type: 'pitfall', source: 'agent', scope: 'global', load: 'always', newChapter: true })
    check('agent 来源 → pending / agent-review', agent.pending === true && agent.reason === 'agent-review' && agent.load === 'on-demand' && agent.loadIgnored === true, JSON.stringify(agent))
    const fake = await run(env, userAlways({ slug: 'fake-global', title: '证据对不上的全局规则', body: '正文。', evidence: '用户从没说过这句话', newChapter: true }))
    check('user 来源（证据对不上）→ pending / evidence-not-found', fake.pending === true && fake.reason === 'evidence-not-found' && fake.load === 'on-demand', JSON.stringify(fake))
    const real = await run(env, userAlways({ slug: 'real-global', title: '以后所有项目都用中文回答', body: '正文。', evidence: '以后所有项目都用中文回答我', newChapter: true }))
    check('user 来源核实后直写跨项目记忆库', !real.pending && real.scope === 'global' && real.loadIgnored === true && env.globalFiles().includes('real-global.md'), JSON.stringify(real))
    check('文本让模型告诉用户去面板看', /waiting in the memory panel/.test(fake.text) && /AGENTS\.md/.test(fake.text), fake.text)
    check('AGENTS.md 未被改动', env.agentsText() === before)
    check('只有核实原话写入跨项目库，两个未核实草稿都按需', env.libraryFiles().length === 0 && env.globalFiles().length === 1 && mod.listPending(env.memoryDir).every(d => d.meta.load === 'on-demand'))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 收下常驻草稿 → 写进 AGENTS.md ==')
{
  const env = makeEnv()
  try {
    const queued = legacyAlwaysDraft(mod, env, { title: '待确认的全局规则', body: '确认后的正文。', type: 'feedback', source: 'agent', scope: 'global', load: 'always', newChapter: true })
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
