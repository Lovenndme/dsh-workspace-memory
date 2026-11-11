/**
 * 召回金标集评测：把「召回效果怎么样」从感觉变成数字。
 *
 * 与 `eval/run.mjs` 的区别：那个量的是**抽取准入**（该不该记，需要调 LLM）；
 * 这个量的是**召回**（记下来的能不能找回来），纯本地、无模型调用、可进 CI。
 *
 * 口径：
 *   recall@1  = 第一条就命中期望记忆的正样本占比
 *   recall@k  = top-k 内命中期望记忆的正样本占比（k 默认 3）
 *   MRR       = 命中排名的倒数均值（没命中记 0）
 *   precision@k = top-k 里「属于期望集合」的条目占比（衡量有没有夹带无关条目）
 *   negFP     = 负样本里**返回了任何东西**的比例 ← 最关键：库里没有答案时能不能闭嘴
 *
 * 负样本是最容易被忽略的一半：只测正样本的话，「随便返回点什么」也能拿高分。
 *
 * 用法：
 *   node eval/golden.mjs
 *   node eval/golden.mjs --k=5 --min-recall-at-1=0.9
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 跑一遍金标集，返回逐条结果与汇总指标。 */
export async function runGolden(options = {}) {
  const k = Number(options.k ?? 3)
  const config = options.config ?? {}
  const mod = await import('../index.js')

  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-golden-'))
  const memoryDir = path.join(root, 'memory')
  try {
    cpSync(path.join(HERE, 'golden', 'corpus'), memoryDir, { recursive: true })
    mod.configure(config)
    const built = await mod.rebuildVectors(memoryDir)
    const cases = JSON.parse(readFileSync(path.join(HERE, 'golden', 'queries.json'), 'utf8'))

    const rows = []
    for (const item of cases) {
      const found = await mod.recall(memoryDir, item.query, k)
      const ids = found.results.map((row) => row.id)
      const hitIndex = item.expect.length > 0 ? ids.findIndex((id) => item.expect.includes(id)) : -1
      rows.push({
        id: item.id,
        kind: item.kind,
        query: item.query,
        expect: item.expect,
        ids,
        rank: hitIndex >= 0 ? hitIndex + 1 : null,
        relevant: ids.filter((id) => item.expect.includes(id)).length,
        returned: ids.length,
      })
    }

    const positives = rows.filter((row) => row.kind === 'positive')
    const negatives = rows.filter((row) => row.kind === 'negative')
    const mean = (list) => (list.length === 0 ? 0 : list.reduce((sum, n) => sum + n, 0) / list.length)

    const metrics = {
      mode: built.mode,
      indexed: built.indexed,
      corpus: 0,
      positiveCount: positives.length,
      negativeCount: negatives.length,
      recallAt1: mean(positives.map((row) => (row.rank === 1 ? 1 : 0))),
      recallAtK: mean(positives.map((row) => (row.rank !== null ? 1 : 0))),
      mrr: mean(positives.map((row) => (row.rank ? 1 / row.rank : 0))),
      precisionAtK: mean(
        positives.filter((row) => row.returned > 0).map((row) => row.relevant / row.returned),
      ),
      negativeFp: mean(negatives.map((row) => (row.returned > 0 ? 1 : 0))),
      missed: positives.filter((row) => row.rank === null).map((row) => row.id),
      falsePositives: negatives.filter((row) => row.returned > 0).map((row) => ({ id: row.id, got: row.ids })),
    }
    metrics.corpus = new Set(rows.flatMap((row) => row.ids)).size + 0

    return { rows, metrics }
  } finally {
    rmSync(root, { recursive: true, force: true })
    mod.configure(undefined)
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  const argOf = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
    return hit ? hit.slice(name.length + 3) : fallback
  }
  const k = Number(argOf('k', '3'))

  const { rows, metrics } = await runGolden({ k })
  // 默认门槛与 test/golden.test.mjs 一致：有向量（hybrid）用严的，退化成纯关键词用放宽的
  const hybrid = metrics.mode === 'hybrid'
  const minRecall1 = Number(argOf('min-recall-at-1', hybrid ? '0.7' : '0.5'))
  const minRecallK = Number(argOf('min-recall-at-k', hybrid ? '0.85' : '0.7'))
  const maxNegFp = Number(argOf('max-neg-fp', hybrid ? '0.12' : '0.25'))
  console.log(`\n召回模式: ${metrics.mode}（索引 ${metrics.indexed} 条）`)
  console.log(`样本: 正 ${metrics.positiveCount} / 负 ${metrics.negativeCount}\n`)

  for (const row of rows) {
    const mark = row.kind === 'negative' ? (row.returned === 0 ? 'OK ' : 'FP ') : row.rank === 1 ? 'OK ' : row.rank ? 'OK ' : 'MISS'
    const detail = row.kind === 'negative' ? (row.returned ? `误返回 ${row.ids.join(',')}` : '—') : `rank=${row.rank ?? '-'} got=${row.ids.join(',') || '无'}`
    console.log(`  ${mark} ${row.id.padEnd(18)} ${detail}`)
  }

  const pct = (n) => `${(n * 100).toFixed(1)}%`
  console.log(`\n  recall@1   ${pct(metrics.recallAt1)}  (门槛 ${pct(minRecall1)})`)
  console.log(`  recall@${k}   ${pct(metrics.recallAtK)}  (门槛 ${pct(minRecallK)})`)
  console.log(`  MRR        ${metrics.mrr.toFixed(3)}`)
  console.log(`  precision@${k} ${pct(metrics.precisionAtK)}`)
  console.log(`  负样本误召 ${pct(metrics.negativeFp)}  (上限 ${pct(maxNegFp)})`)

  const failed = []
  if (metrics.recallAt1 < minRecall1) failed.push(`recall@1 ${pct(metrics.recallAt1)} < ${pct(minRecall1)}`)
  if (metrics.recallAtK < minRecallK) failed.push(`recall@${k} ${pct(metrics.recallAtK)} < ${pct(minRecallK)}`)
  if (metrics.negativeFp > maxNegFp) failed.push(`负样本误召 ${pct(metrics.negativeFp)} > ${pct(maxNegFp)}`)

  console.log(failed.length === 0 ? '\n  门槛全部通过\n' : `\n  未达标: ${failed.join(' / ')}\n`)
  process.exit(failed.length === 0 ? 0 : 1)
}
