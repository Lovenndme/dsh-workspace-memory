/**
 * 历史版本 + 命中计数测试。
 *
 * 这两件事的共同目的：让记忆**可回溯、可淘汰**。
 *   · 历史：覆盖/删除前留档，误改能回退
 *   · hits/lastHit：被召回才算用过，为「哪条该淘汰」提供依据
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

const tmp = (tag) => mkdtempSync(path.join(os.tmpdir(), `wsm-${tag}-`))
const historyDir = (dir, id) => path.join(path.dirname(dir), '.memory-state', 'history', id)

console.log('== 新建不留历史 ==')
{
  const t = tmp('hist-new')
  const dir = path.join(t, '.dsh-memory')
  try {
    mod.configure({ historyLimit: 20 })
    mod.writeMemory(dir, { slug: 'a', title: '标题', body: '正文', type: 'project' })
    check('新建后没有历史目录', !existsSync(historyDir(dir, 'a')), historyDir(dir, 'a'))
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
}

console.log('\n== 覆盖前留档 ==')
{
  const t = tmp('hist-over')
  const dir = path.join(t, '.dsh-memory')
  try {
    mod.configure({ historyLimit: 20 })
    mod.writeMemory(dir, { slug: 'a', title: '标题', body: '第一版正文', type: 'project' })
    mod.writeMemory(dir, { id: 'a', body: '第二版正文' })

    const versions = mod.listHistory(dir, 'a')
    check('留了 1 个历史版本', versions.length === 1, String(versions.length))
    const raw = readFileSync(versions[0].file, 'utf8')
    check('历史里是旧内容', raw.includes('第一版正文'), raw.slice(0, 120))
    check('当前文件是新内容', readFileSync(path.join(dir, 'a.md'), 'utf8').includes('第二版正文'))
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
}

console.log('\n== 删除也留档 ==')
{
  const t = tmp('hist-del')
  const dir = path.join(t, '.dsh-memory')
  try {
    mod.configure({ historyLimit: 20 })
    mod.writeMemory(dir, { slug: 'gone', title: '要被删', body: '珍贵的正文', type: 'project' })
    const removed = mod.deleteMemory(dir, 'gone')
    check('删除返回 true', removed === true, String(removed))
    check('当前文件已消失', !existsSync(path.join(dir, 'gone.md')))

    const versions = mod.listHistory(dir, 'gone')
    check('删除留了 1 个历史版本', versions.length === 1, String(versions.length))
    check('历史里正文还在', readFileSync(versions[0].file, 'utf8').includes('珍贵的正文'), versions[0]?.name)
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
}

console.log('\n== historyLimit 生效 ==')
{
  const t = tmp('hist-limit')
  const dir = path.join(t, '.dsh-memory')
  try {
    mod.configure({ historyLimit: 2 })
    mod.writeMemory(dir, { slug: 'b', title: '标题', body: 'v1', type: 'project' })
    for (const v of ['v2', 'v3', 'v4']) mod.writeMemory(dir, { id: 'b', body: v })
    const versions = mod.listHistory(dir, 'b')
    check('只保留最近 2 版', versions.length === 2, String(versions.length))
    check('留下的是较新的两版', readFileSync(versions[0].file, 'utf8').includes('v3'), versions.map((v) => v.name).join(','))
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
}

console.log('\n== historyLimit=0 关闭留档 ==')
{
  const t = tmp('hist-off')
  const dir = path.join(t, '.dsh-memory')
  try {
    mod.configure({ historyLimit: 0 })
    mod.writeMemory(dir, { slug: 'c', title: '标题', body: 'v1', type: 'project' })
    mod.writeMemory(dir, { id: 'c', body: 'v2' })
    check('没有历史目录', mod.listHistory(dir, 'c').length === 0)
  } finally {
    rmSync(t, { recursive: true, force: true })
    mod.configure(undefined)
  }
}

console.log('\n== 命中计数 ==')
{
  const t = tmp('hits')
  const dir = path.join(t, '.dsh-memory')
  try {
    mod.configure(undefined)
    mod.writeMemory(dir, { slug: 'hot', title: '发布流程说明', description: '发布前要跑全量测试', body: '发布前必须跑全量测试并全绿。', type: 'project' })
    await mod.rebuildVectors(dir)

    const before = mod.listMemories(dir).find((m) => m.id === 'hot')
    check('初始 hits=0', Number(before.meta.hits ?? 0) === 0, String(before.meta.hits))
    const modifiedBefore = before.meta.modified

    const first = await mod.recall(dir, '发布前要做什么', 3)
    check('召回命中该条', first.results[0]?.id === 'hot', JSON.stringify(first.results.map((r) => r.id)))

    const afterOne = mod.listMemories(dir).find((m) => m.id === 'hot')
    check('hits 变成 1', Number(afterOne.meta.hits) === 1, String(afterOne.meta.hits))
    check('lastHit 被写入', typeof afterOne.meta.lastHit === 'string' && afterOne.meta.lastHit.length > 0, afterOne.meta.lastHit)
    check('modified 不被命中改动', afterOne.meta.modified === modifiedBefore, `${modifiedBefore} -> ${afterOne.meta.modified}`)

    await mod.recall(dir, '发布前要做什么', 3)
    const afterTwo = mod.listMemories(dir).find((m) => m.id === 'hot')
    check('hits 累加到 2', Number(afterTwo.meta.hits) === 2, String(afterTwo.meta.hits))

    console.log('\n== 未命中的条目不该涨 ==')
    mod.writeMemory(dir, { slug: 'cold', title: '完全无关的东西', description: '关于植物养护', body: '浇水要适量。', type: 'reference' })
    await mod.rebuildVectors(dir)
    await mod.recall(dir, '发布前要做什么', 3)
    const cold = mod.listMemories(dir).find((m) => m.id === 'cold')
    check('cold 的 hits 仍为 0', Number(cold.meta.hits ?? 0) === 0, String(cold.meta.hits))
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
