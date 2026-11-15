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
 * 计分口径与插件现在的抽取行为一致（第六轮起）：
 *   · 候选**全部入队**，不因证据核对不过而丢弃（插件的 extractFromTurn 只做去重，核对结果存进 evidenceVerified）；
 *   · source: "user" 的候选做与插件相同的核对：原话出处（verifyEvidence，同一条用户消息内按序匹配）
 *     **且** 与这条记忆的文字沾边（evidenceRelates，比 [标题, 摘要, 正文]）。两道都过 = 「入队（已核实）」，
 *     否则 = 「入队（未核实）」——面板据此显示「用户原话」或「未核实」；
 *   · source: "agent" 或没标 source 的（插件按 agent 处理）= 「入队（agent）」。
 * 所以 precision / recall 报两组：全部入队的候选（插件实际放进队列的），以及其中「已核实」的那部分
 * （面板标成「用户原话」的条目有多准、覆盖了多少应记项）。另分开报三类入队的条数。
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

/** 语料里「用户：」开头的每一行当作一条用户消息（与插件证据核对的口径一致：同一条消息内按序匹配）。 */
const userLinesOf = (snippet) =>
  String(snippet)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('用户：'))
    .map((line) => line.slice('用户：'.length))

/**
 * 与 extractFromTurn 相同的分类（插件不丢弃任何一类，只决定入队时的 evidenceVerified）：
 *   'verified'   source: "user"，原话核对得到且与这条记忆的文字沾边 → 入队（已核实）
 *   'unverified' source: "user"，两道里有一道没过                    → 入队（未核实）
 *   'agent'      source: "agent" 或没标（插件按 agent 处理）          → 入队（agent）
 */
const classify = (candidate, userTexts) => {
  if (candidate.source !== 'user') return 'agent'
  const found = mod.verifyEvidence(userTexts, candidate.evidence).verified
  const related = mod.evidenceRelates(candidate.evidence, [candidate.title, candidate.description, candidate.body])
  return found && related ? 'verified' : 'unverified'
}

/** `options.only`：只拿某一类入队的候选来算（例如只看「已核实」）；不给就是全部入队的候选。 */
function score(rows, options = {}) {
  const { only } = options
  let tp = 0
  let fp = 0
  let fn = 0

  for (const row of rows) {
    if (row.error) continue
    let candidates = row.candidates
    if (only) {
      const userTexts = userLinesOf(row.snippet)
      candidates = candidates.filter((c) => classify(c, userTexts) === only)
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
console.log(`语料 ${FILE}：${snippets.length} 段；候选全部入队，source: user 的按「出处 + evidenceRelates」分成已核实 / 未核实\n`)

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

const queuedAll = score(rows)
const queuedVerified = score(rows, { only: 'verified' })

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

// 按插件入队时的身份计数（插件三类都入队，不丢弃）；没标 source 的单独记一笔，插件按 agent 处理
const tally = { verified: 0, unverified: 0, agent: 0, unlabeled: 0 }
for (const row of rows) {
  if (row.error) continue
  const userTexts = userLinesOf(row.snippet)
  for (const c of row.candidates) {
    const kind = classify(c, userTexts)
    tally[kind] += 1
    if (kind === 'agent' && c.source !== 'agent') tally.unlabeled += 1
  }
}

console.log('\n=== 入队身份（插件全部入队，不丢弃）===')
console.log(`  入队（已核实）  ${tally.verified} 条（source: user，出处核对得到且与标题 / 摘要 / 正文沾边；面板标「用户原话」）`)
console.log(`  入队（未核实）  ${tally.unverified} 条（source: user，两道里有一道没过；面板标「未核实」）`)
console.log(`  入队（agent）   ${tally.agent} 条（其中没标 source、插件按 agent 处理的 ${tally.unlabeled} 条）`)

console.log('\n=== 基线 ===')
console.log(`  全部入队的候选  precision=${pct(queuedAll.precision)}  recall=${pct(queuedAll.recall)}  (TP=${queuedAll.tp} FP=${queuedAll.fp} FN=${queuedAll.fn})`)
console.log(`  其中已核实的    precision=${pct(queuedVerified.precision)}  recall=${pct(queuedVerified.recall)}  (TP=${queuedVerified.tp} FP=${queuedVerified.fp} FN=${queuedVerified.fn})`)

const errors = rows.filter((r) => r.error).length
if (errors > 0) console.log(`\n注意：${errors} 段请求失败，未计入评分。`)
