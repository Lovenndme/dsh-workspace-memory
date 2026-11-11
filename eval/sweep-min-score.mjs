/**
 * `minScore` 闸门扫描：把「召回 vs 误召」的取舍摊开，用数据选点。
 *
 * 为什么不凭感觉定阈值：这个参数同时决定「该找到的能不能找到」和
 * 「库里没有时会不会胡说」，两个方向的错误代价不同，必须看到整条曲线。
 *
 * 用法：node eval/sweep-min-score.mjs
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const mod = await import('../index.js')

const STEPS = [0.3, 0.31, 0.32, 0.33, 0.34, 0.35, 0.36, 0.4, 0.45]
const K = 3

const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-sweep-'))
const memoryDir = path.join(root, 'memory')
try {
  cpSync(path.join(HERE, 'golden', 'corpus'), memoryDir, { recursive: true })
  const cases = JSON.parse(readFileSync(path.join(HERE, 'golden', 'queries.json'), 'utf8'))

  console.log('\n  minScore  recall@1  recall@3  MRR    负样本误召  误召的用例')
  for (const minScore of STEPS) {
    mod.configure({ minScore })
    await mod.rebuildVectors(memoryDir)
    const rows = []
    for (const item of cases) {
      const found = await mod.recall(memoryDir, item.query, K)
      const ids = found.results.map((row) => row.id)
      const rank = item.expect.length > 0 ? (ids.findIndex((id) => item.expect.includes(id)) + 1 || null) : null
      rows.push({ kind: item.kind, id: item.id, rank, returned: ids.length })
    }
    const positives = rows.filter((row) => row.kind === 'positive')
    const negatives = rows.filter((row) => row.kind === 'negative')
    const pct = (n) => `${(n * 100).toFixed(0)}%`.padStart(4)
    const recall1 = positives.filter((row) => row.rank === 1).length / positives.length
    const recallK = positives.filter((row) => row.rank !== null).length / positives.length
    const mrr = positives.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / positives.length
    const fpRows = negatives.filter((row) => row.returned > 0)
    const fp = fpRows.length / negatives.length
    const names = fpRows.map((row) => row.id.replace('neg-', '')).join(',') || '—'
    console.log(`    ${minScore.toFixed(2)}     ${pct(recall1)}     ${pct(recallK)}     ${mrr.toFixed(3)}   ${pct(fp)}        ${names}`)
  }
  console.log('\n  选点原则：在误召可控（≤ 10%）的前提下取召回最高的最小阈值。\n')
} finally {
  rmSync(root, { recursive: true, force: true })
  mod.configure(undefined)
}
