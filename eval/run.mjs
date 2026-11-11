/**
 * 抽取准入评测：量出 precision / recall 基线。
 *
 * 为什么需要：准入判断没有基线就只能盲改——改完只能说"感觉好点了"。
 * 有了这两个数字，之后每次改提示词、改阈值都能直接对比。
 *
 * 口径：
 *   TP = 命中的应记项（一条 expectation 匹配到一条候选）
 *   FP = 记下来但不该记的候选（含"整段都不该记"里冒出来的）
 *   FN = 该记但没记出来的
 *   precision = TP / (TP + FP)   记下来的里面有多少是真的
 *   recall    = TP / (TP + FN)   该记的记住了多少
 *
 * 同时报告「加上 minExtractConfidence 闸门之后」的两个数字，
 * 用来判断这个闸门到底帮忙还是帮倒忙。
 *
 * 用法：
 *   node eval/run.mjs
 *   node eval/run.mjs --key-env=ARKCLI_CODING_PLAN_API_KEY --base=https://ark.cn-beijing.volces.com/api/coding/v3 --model=deepseek-v4-1-flash-261017
 */
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mod = await import('../index.js')

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const KEY_ENV = argOf('key-env', 'MYAPI_API_KEY')
const BASE = argOf('base', 'https://api.wwaihh.xyz/v1')
const MODEL = argOf('model', 'deepseek-v4.1-flash')
const MIN_CONF = Number(argOf('min-conf', '0.6'))
const FILE = argOf('file', 'snippets.json')

/** 从 ~/.dsh/.credentials.yaml 里按行取出 key（格式是 `  NAME: value`）。 */
function readCredential(name) {
  if (process.env[name]) return process.env[name]
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(file)) return null
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`).exec(line)
    if (m) return m[1].replace(/^["']|["']$/g, '')
  }
  return null
}

const KEY = readCredential(KEY_ENV)
if (!KEY) {
  console.error(`找不到凭据 ${KEY_ENV}（环境变量与 ~/.dsh/.credentials.yaml 都没有）`)
  process.exit(1)
}

const snippets = JSON.parse(readFileSync(new URL(`./${FILE}`, import.meta.url), 'utf8'))

async function askModel(transcript) {
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: mod.EXTRACTION_SYSTEM },
            { role: 'user', content: `对话记录：\n\n${transcript}` },
          ],
          max_tokens: 1200,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(60000),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status} ${body.slice(0, 160)}`)
      }
      const data = await response.json()
      return data?.choices?.[0]?.message?.content ?? ''
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, 800 * attempt))
    }
  }
  throw lastError
}

/** 一条 expectation 是否被某条候选命中：所有 must 关键词都要出现。 */
function matches(candidate, expectation) {
  const hay = `${candidate.title ?? ''}\n${candidate.description ?? ''}\n${candidate.body ?? ''}`.toLowerCase()
  return expectation.must.every((kw) => hay.includes(String(kw).toLowerCase()))
}

function score(rows, options = {}) {
  const { applyGate = false } = options
  let tp = 0
  let fp = 0
  let fn = 0

  for (const row of rows) {
    if (row.error) continue
    let candidates = row.candidates
    if (applyGate) {
      candidates = candidates.filter((c) => (typeof c.confidence === 'number' ? c.confidence : 0.6) >= MIN_CONF)
    }
    const pool = [...candidates]
    let matched = 0
    for (const expectation of row.expect) {
      const index = pool.findIndex((c) => matches(c, expectation))
      if (index >= 0) {
        pool.splice(index, 1)
        matched += 1
      }
    }
    tp += matched
    fn += row.expect.length - matched
    fp += pool.length
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  return { tp, fp, fn, precision, recall }
}

console.log(`模型 ${MODEL} @ ${BASE}`)
console.log(`语料 ${FILE}：${snippets.length} 段；置信度闸门阈值 ${MIN_CONF}\n`)

const rows = []
for (const snippet of snippets) {
  process.stdout.write(`  ${snippet.id} … `)
  try {
    const raw = await askModel(snippet.snippet)
    const candidates = mod.parseExtractionJson(raw)
    rows.push({ ...snippet, candidates, raw })
    console.log(`${candidates.length} 条候选（应记 ${snippet.expect.length}）`)
  } catch (error) {
    rows.push({ ...snippet, candidates: [], error: String(error?.message ?? error) })
    console.log(`失败：${error?.message ?? error}`)
  }
}

const withoutGate = score(rows)
const withGate = score(rows, { applyGate: true })

const pct = (x) => `${(x * 100).toFixed(1)}%`

console.log('\n=== 逐条明细（✔ 命中 / ✘ 漏记 / ✚ 误记）===')
for (const row of rows) {
  if (row.error) {
    console.log(`  ${row.id.padEnd(24)} 请求失败`)
    continue
  }
  const pool = [...row.candidates]
  let hitCount = 0
  for (const expectation of row.expect) {
    const index = pool.findIndex((c) => matches(c, expectation))
    if (index >= 0) {
      pool.splice(index, 1)
      hitCount += 1
    }
  }
  const marks = '✔'.repeat(hitCount) + '✘'.repeat(row.expect.length - hitCount) + '✚'.repeat(pool.length)
  const titles = row.candidates.map((c) => c.title).join(' | ') || '（无）'
  console.log(`  ${row.id.padEnd(24)} ${marks.padEnd(6)} ${titles}`)
}

console.log('\n=== 基线 ===')
console.log(`  不加闸门  precision=${pct(withoutGate.precision)}  recall=${pct(withoutGate.recall)}  (TP=${withoutGate.tp} FP=${withoutGate.fp} FN=${withoutGate.fn})`)
console.log(`  加闸门    precision=${pct(withGate.precision)}  recall=${pct(withGate.recall)}  (TP=${withGate.tp} FP=${withGate.fp} FN=${withGate.fn})`)

const errors = rows.filter((r) => r.error).length
if (errors > 0) console.log(`\n注意：${errors} 段请求失败，未计入评分。`)
