/**
 * 抽取流水线测试（用 mock LLM，不真的调模型）。
 *
 * 覆盖除"真实网络请求"以外的全部环节：
 *   配置开关 → 对话取样 → 提示词 → 流式累加 → JSON 解析 → 向量去重 → 写入 pending
 *
 * 这样即使没有可用的 provider/网络，也能确认管道的每个接缝是通的。
 */
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
    snapshotEvents: () => [{ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '嗯' }] } }],
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
