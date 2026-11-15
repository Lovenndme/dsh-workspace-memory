/**
 * 待确认队列 + 抽取结果解析测试。
 *
 * 抽取本身要调模型，网络不确定，不放进单元测试。这里测两段确定性的东西：
 *   1. parseExtractionJson 对模型各种输出形态的容错
 *   2. pending → accept / reject 的状态流转（含索引与向量重建）
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
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

/* ------------------------------------------------ parseExtractionJson */

console.log('== 模型输出容错 ==')
{
  const clean = JSON.stringify([{ title: 't1', body: 'b1', type: 'feedback' }])
  check('裸 JSON 数组', mod.parseExtractionJson(clean).length === 1)

  const fenced = '```json\n' + clean + '\n```'
  check('```json 围栏', mod.parseExtractionJson(fenced).length === 1)

  const chatty = `好的，我提取到以下记忆：\n\n${clean}\n\n希望有帮助。`
  check('前后有闲聊', mod.parseExtractionJson(chatty).length === 1)

  check('空数组 -> []', mod.parseExtractionJson('[]').length === 0)
  check('非 JSON -> []', mod.parseExtractionJson('我无法提取').length === 0)
  check('坏 JSON -> [] 不抛', mod.parseExtractionJson('[{"title":').length === 0)
  check('null -> []', mod.parseExtractionJson(null).length === 0)

  const partial = JSON.stringify([
    { title: 'ok', body: 'fine', type: 'user' },
    { title: '   ', body: 'empty title' },
    { body: 'no title' },
    { title: 'no body' },
  ])
  check('过滤缺字段的条目，只留合法项', mod.parseExtractionJson(partial).length === 1)
}

/* ------------------------------------------------ pending 生命周期 */

console.log('\n== pending -> accept ==')
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-pending-'))
  const dir = path.join(tmp, '.dsh-memory')
  try {
    const file = mod.writePending(dir, {
      title: '抽取出来的候选记忆',
      body: '这是正文，包含理由。',
      type: 'feedback',
      tags: ['draft'],
      confidence: 0.7,
    })
    check('pending 文件落地', existsSync(file), file)
    check('不在 memories/ 里', !existsSync(path.join(dir, 'memories')), '不应创建 memories/')

    const drafts = mod.listPending(dir)
    check('listPending 能读到', drafts.length === 1, `got ${drafts.length}`)
    check('status 是 draft', drafts[0].meta.status === 'draft', drafts[0].meta.status)
    check('未进 MEMORY.md 索引', mod.listMemories(dir).length === 0, 'pending 不应污染正式库')

    const id = drafts[0].id
    const accepted = await mod.acceptPending(dir, id)
    check('accept 成功', accepted.ok === true, JSON.stringify(accepted))
    check('pending 已清空', mod.listPending(dir).length === 0)
    check('已进入 memories/', mod.listMemories(dir).length === 1)
    check('status 变成 confirmed', mod.listMemories(dir)[0].meta.status === 'confirmed', JSON.stringify(mod.listMemories(dir)[0].meta))

    const index = readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')
    check('MEMORY.md 已收录', index.includes('抽取出来的候选记忆'), index.slice(0, 200))
    check('向量已重建', accepted.vectorCount === 1, JSON.stringify(accepted))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\n== pending -> reject ==')
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-reject-'))
  const dir = path.join(tmp, '.dsh-memory')
  try {
    mod.writePending(dir, { title: '要丢掉的候选', body: '正文', type: 'project' })
    const id = mod.listPending(dir)[0].id
    const rejected = mod.rejectPending(dir, id)
    check('reject 成功', rejected.ok === true, JSON.stringify(rejected))
    check('pending 已清空', mod.listPending(dir).length === 0)
    check('memories/ 仍为空', mod.listMemories(dir).length === 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\n== 不存在的 id ==')
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-miss-'))
  const dir = path.join(tmp, '.dsh-memory')
  try {
    const a = await mod.acceptPending(dir, 'dr_nope')
    check('accept 不存在的 id 返回 ok:false', a.ok === false && typeof a.error === 'string', JSON.stringify(a))
    const r = mod.rejectPending(dir, 'dr_nope')
    check('reject 不存在的 id 返回 ok:false', r.ok === false && typeof r.error === 'string', JSON.stringify(r))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
