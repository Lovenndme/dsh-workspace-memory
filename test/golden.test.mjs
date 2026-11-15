/**
 * 召回金标集的 CI 门槛。
 *
 * 为什么要有这一层：`eval/golden.mjs` 只是打印数字，人不会每次都去看。
 * 这里把「不能退化」写成断言——改了检索逻辑、权重、闸门，只要指标掉了就红。
 *
 * 基线（2026-11-03 实测，hybrid 模式）：
 *   recall@1 70% / recall@3 90% / MRR 0.75 / 负样本误召 0%
 *
 * 门槛略低于实测值，留一条的余量——否则任何微小波动都会红，反而没人看。
 * 没有 leanvec 的机器会退化成纯关键词模式，召回天然更差，用放宽的门槛。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
const { runGolden } = await import('../eval/golden.mjs')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const pct = (n) => `${(n * 100).toFixed(1)}%`

const { rows, metrics } = await runGolden({ k: 3 })

console.log(`== 金标集（模式 ${metrics.mode}，正 ${metrics.positiveCount} / 负 ${metrics.negativeCount}）==`)
console.log(`  recall@1 ${pct(metrics.recallAt1)}  recall@3 ${pct(metrics.recallAtK)}  MRR ${metrics.mrr.toFixed(3)}  误召 ${pct(metrics.negativeFp)}`)

check('语料非空', rows.length > 0 && metrics.positiveCount > 0 && metrics.negativeCount > 0)
check('正负样本都有，否则指标没有意义', metrics.positiveCount >= 5 && metrics.negativeCount >= 5, `${metrics.positiveCount}/${metrics.negativeCount}`)

const hybrid = metrics.mode === 'hybrid'

if (!hybrid) {
  // 纯关键词模式下中文召回实测只有 20% 左右：这是**没有嵌入模型**的正常结果，
  // 不是回归。对着它设一个能过的阈值等于自欺欺人，所以这里如实跳过召回阈值，
  // 只保留「语料/样本结构」与负样本检查。CI 装了 leanvec 才真正守 recall。
  console.log('  SKIP  无嵌入模型（纯关键词模式），召回阈值不适用；只检查结构与负样本')
  check(`负样本误召 ≤ 25.0%`, metrics.negativeFp <= 0.25, JSON.stringify(metrics.falsePositives))
} else {
  const minRecall1 = 0.7
  const minRecall3 = 0.85
  const maxNegFp = 0.12
  check(`recall@1 ≥ ${pct(minRecall1)}`, metrics.recallAt1 >= minRecall1, pct(metrics.recallAt1))
  check(`recall@3 ≥ ${pct(minRecall3)}`, metrics.recallAtK >= minRecall3, `未命中: ${metrics.missed.join(', ') || '无'}`)
  check(`负样本误召 ≤ ${pct(maxNegFp)}`, metrics.negativeFp <= maxNegFp, JSON.stringify(metrics.falsePositives))
}

// 负样本是这个评测的重点：库里没有答案时必须敢返回空
check('负样本确实测到了「返回空」的能力', metrics.negativeCount >= 5, String(metrics.negativeCount))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
if (metrics.missed.length > 0) console.log(`  （已知未命中，可后续改进检索：${metrics.missed.join(', ')}）`)
process.exit(failures === 0 ? 0 : 1)
