/**
 * 抽取流水线测试（用 mock LLM，不真的调模型）。
 *
 * 覆盖除"真实网络请求"以外的全部环节：
 *   配置开关 → 对话取样 → 提示词 → 流式累加 → JSON 解析 → 向量去重 → 写入 pending
 *
 * 这样即使没有可用的 provider/网络，也能确认管道的每个接缝是通的。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mod = await import('../index.js')

let failures = 0
const check = (label, cond, detail) => {
  if (cond) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** 造一个只满足抽取需求的假 ctx。 */
function makeCtx({ reply, route = { provider: 'p', model: 'm' } }) {
  const session = {
    snapshotEvents: () => [
      {
        type: 'user/message',
        data: {
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: '以后每次改完插件都要先跑测试再提交，别再忘了。'.repeat(12) }],
        },
      },
      {
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [{ type: 'text', text: '明白，我会先跑测试。' }] },
        },
      },
      {
        type: 'tool/result',
        data: { message: { role: 'tool', content: [{ type: 'text', text: '这一大段工具输出不该被送进抽取'.repeat(20) }] } },
      },
    ],
    requestContext: () => route,
  }

  const llm = {
    stream: () => {
      const chunks = []
      // 拆成多块，模拟真实的流式返回
      for (let i = 0; i < reply.length; i += 40) {
        chunks.push({ type: 'text-delta', text: reply.slice(i, i + 40) })
      }
      chunks.push({ type: 'finish', reason: { kind: 'stop' } })
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }

  return {
    ctx: {
      get: (key) => (key === 'llm' ? llm : undefined),
      sessions: { get: () => session },
    },
    agent: { id: 'session-test' },
  }
}

console.log('== 关闭时直接跳过 ==')
{
  mod.configure({ enableExtraction: false })
  const { ctx, agent } = makeCtx({ reply: '[]' })
  const r = await mod.extractFromTurn(ctx, agent, path.join(os.tmpdir(), 'nowhere'))
  check('enableExtraction=false -> skipped', Boolean(r.skipped), JSON.stringify(r))
}

console.log('\n== llm 不可用时跳过 ==')
{
  mod.configure({ enableExtraction: true })
  const r = await mod.extractFromTurn({ get: () => undefined, sessions: { get: () => null } }, { id: 'x' }, os.tmpdir())
  check('无 llm -> skipped', Boolean(r.skipped), JSON.stringify(r))
}

console.log('\n== 正常抽取：入队 ==')
{
  mod.configure({ enableExtraction: true, dedupeThreshold: 0.9, extractMaxPerTurn: 3 })
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-extract-'))
  const dir = path.join(tmp, '.dsh-memory')
  try {
    const reply = JSON.stringify([
      { title: '改完插件要先跑测试', body: '用户明确要求：每次改完插件先跑测试再提交。理由：避免把坏版本推上线。', type: 'feedback', tags: ['流程'], confidence: 0.9 },
    ])
    const { ctx, agent } = makeCtx({ reply })
    const r = await mod.extractFromTurn(ctx, agent, dir)
    check('queued=1', r.queued === 1, JSON.stringify(r))
    check('pending 里有 1 条', mod.listPending(dir).length === 1, String(mod.listPending(dir).length))
    const draft = mod.listPending(dir)[0] ?? { meta: {} }
    check('标题正确', draft.meta.title === '改完插件要先跑测试', draft.meta.title)
    check('type 正确', draft.meta.type === 'feedback', draft.meta.type)
    check('status=draft', draft.meta.status === 'draft', draft.meta.status)
    check('正式库仍为空', mod.listMemories(dir).length === 0)

    console.log('\n== 同一条再抽一次：应被去重 ==')
    const r2 = await mod.extractFromTurn(ctx, agent, dir)
    check('第二次 deduped=1 queued=0', r2.deduped === 1 && r2.queued === 0, JSON.stringify(r2))
    check('pending 仍是 1 条', mod.listPending(dir).length === 1, String(mod.listPending(dir).length))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\n== 证据核对：声称用户说的必须能在用户消息里找到原话 ==')
{
  mod.configure({ enableExtraction: true, dedupeThreshold: 0.99, extractMaxPerTurn: 5 })
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-extract-evidence-'))
  const dir = path.join(tmp, '.dsh-memory')
  try {
    const reply = JSON.stringify([
      // 原话在用户消息里（中间用省略号跳过一段）→ 入队
      { slug: 'test-before-commit', title: '改完插件先跑测试', body: '每次改完插件先跑测试再提交。理由：避免坏版本上线。', type: 'feedback', scope: 'project', load: 'on-demand', source: 'user', evidence: '「以后每次改完插件…先跑测试再提交」' },
      // 声称用户说的，但用户没说过 → 第六轮起不丢弃，以「未核实」入队（evidenceVerified: false）并计数
      { slug: 'fake-quote', title: '用户要求用英文回答', body: '用户要求所有回答都用英文。', type: 'user', source: 'user', evidence: '以后都用英文回答我' },
      // 证据只出现在助手消息里 → 同样未核实
      { slug: 'assistant-said', title: '助手说会先跑测试', body: '助手承诺先跑测试。', type: 'feedback', source: 'user', evidence: '明白，我会先跑测试' },
      // 模型自己得出的 → 照常入队，不看证据
      { slug: 'agent-pitfall', title: 'Windows 上 rename 可能 EPERM', body: '编辑器占着文件时 rename 会 EPERM，退回直接写。', type: 'pitfall', scope: 'global', load: 'on-demand', source: 'agent', evidence: '' },
      // 本项目常驻：抽取没法问，降成按需加载入队
      { slug: 'project-always', title: '本项目每轮都要遵守的规则', body: '本项目的某条硬性约定。', type: 'project', scope: 'project', load: 'always', source: 'agent' },
    ])
    const { ctx, agent } = makeCtx({ reply })
    const r = await mod.extractFromTurn(ctx, agent, dir)
    // 第六轮：核对不过的不再丢弃——抽取本来就只进待确认，丢掉等于替人做了决定；unverified = 以未核实身份入队的条数
    check('返回 unverified = 以未核实身份入队的 2 条（取代 lowConfidence）', r.unverified === 2 && !('lowConfidence' in r), JSON.stringify(r))
    check('五条全部入队', r.queued === 5, JSON.stringify(r))
    const drafts = new Map(mod.listPending(dir).map((d) => [d.meta.slug, d.meta]))
    check('用户原话那条：source=user、evidence 落盘、evidenceVerified: true', drafts.get('test-before-commit')?.source === 'user' && /先跑测试再提交/.test(drafts.get('test-before-commit')?.evidence ?? '') && drafts.get('test-before-commit')?.evidenceVerified === 'true', JSON.stringify(drafts.get('test-before-commit')))
    check('没核实的两条以「未核实」入队（evidenceVerified: false），证据原样留着给人看', ['fake-quote', 'assistant-said'].every((slug) => drafts.get(slug)?.source === 'user' && drafts.get(slug)?.evidenceVerified === 'false' && typeof drafts.get(slug)?.evidence === 'string'), JSON.stringify([drafts.get('fake-quote'), drafts.get('assistant-said')]))
    check('agent 来源的草稿不带 evidenceVerified', drafts.get('agent-pitfall')?.evidenceVerified === undefined)
    check('agent 那条：scope=global、load=on-demand、type=pitfall、没有 evidence', drafts.get('agent-pitfall')?.scope === 'global' && drafts.get('agent-pitfall')?.load === 'on-demand' && drafts.get('agent-pitfall')?.type === 'pitfall' && drafts.get('agent-pitfall')?.evidence === undefined, JSON.stringify(drafts.get('agent-pitfall')))
    check('project + always 被降成 on-demand（插件不写项目 AGENTS.md）', drafts.get('project-always')?.load === 'on-demand' && drafts.get('project-always')?.scope === 'project', JSON.stringify(drafts.get('project-always')))
    check('草稿不再写 confidence', [...drafts.values()].every((meta) => meta.confidence === undefined))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\n== 同 slug 再抽一次：覆盖原草稿，不堆第二条 ==')
{
  mod.configure({ enableExtraction: true, dedupeThreshold: 1, extractMaxPerTurn: 3 })
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-extract-slug-'))
  const dir = path.join(tmp, '.dsh-memory')
  try {
    const first = makeCtx({ reply: JSON.stringify([{ slug: 'same-topic', title: '第一版', body: '第一版正文：发布前跑测试。', type: 'project', source: 'agent' }]) })
    await mod.extractFromTurn(first.ctx, first.agent, dir)
    const second = makeCtx({ reply: JSON.stringify([{ slug: 'same-topic', title: '第二版', body: '第二版正文：完全不同的表述，关于部署窗口。', type: 'project', source: 'agent' }]) })
    await mod.extractFromTurn(second.ctx, second.agent, dir)
    const drafts = mod.listPending(dir)
    check('队列里仍只有一条', drafts.length === 1, String(drafts.length))
    check('留下的是新版', drafts[0]?.meta.title === '第二版', JSON.stringify(drafts[0]?.meta))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\n== 模型返回空数组：不入队也不报错 ==')
{
  mod.configure({ enableExtraction: true })
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-empty-'))
  const dir = path.join(tmp, '.dsh-memory')
  try {
    const { ctx, agent } = makeCtx({ reply: '[]' })
    const r = await mod.extractFromTurn(ctx, agent, dir)
    check('skipped 表示没有值得记的', Boolean(r.skipped), JSON.stringify(r))
    check('pending 为空', mod.listPending(dir).length === 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\n== 对话太短：跳过 ==')
{
  mod.configure({ enableExtraction: true })
  const shortSession = {
    snapshotEvents: () => [{ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '嗯' }] } }],
    requestContext: () => ({ provider: 'p', model: 'm' }),
  }
  const ctx = { get: () => ({ stream: () => (async function* () {})() }), sessions: { get: () => shortSession } }
  const r = await mod.extractFromTurn(ctx, { id: 's' }, os.tmpdir())
  check('transcript 太短 -> skipped', r.skipped === 'transcript too short', JSON.stringify(r))
}

console.log('\n== 模型输出乱七八糟也不崩 ==')
{
  mod.configure({ enableExtraction: true })
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-junk-'))
  const dir = path.join(tmp, '.dsh-memory')
  try {
    const { ctx, agent } = makeCtx({ reply: '抱歉，我无法完成这个请求。' })
    const r = await mod.extractFromTurn(ctx, agent, dir)
    check('非 JSON 输出 -> skipped 而非抛异常', Boolean(r.skipped), JSON.stringify(r))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 收尾：恢复默认，避免污染同一进程里后续的运行
mod.configure(undefined)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
