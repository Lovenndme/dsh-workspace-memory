/**
 * 主路径评测：对话进行到某一刻，模型会不会主动调 `memory_remember`、记到哪里、记成什么样。
 *
 * 为什么需要：`eval/run.mjs` 只评「自动抽取」这条默认关闭的旁路；真正天天在用的是模型在对话里
 * 主动调用 memory_remember。写入准入改来改去，没有这份评测就只能说「感觉好点了」。
 *
 * 做法（口径见场景 spec 的 §1–§3、§5）：
 *   · 每个场景一个独立的假宿主 + 临时目录，真实 apply 插件。提示词按宿主的摆放方式
 *     （DSH docs/subsystems/system-prompt.md）：system prompt = 极简设定 + 日期 + 插件 `section` 文本；
 *     插件 `context` 文本不进 system prompt，而是包成 `<system-reminder>` 作为一条 user 消息插在既有对话之前
 *     （为空不插；假会话的 snapshotEvents() 不含这条快照）；
 *   · 工具 = 插件注册的 memory_remember / memory_recall（定义取自注册记录，不硬编码 schema）
 *     + read_file / write_file / edit_file / run_command / todo_write，操作一份共享的内存虚拟仓库
 *     （eval/lib/remember-workspace.mjs，每个场景开局重置）；
 *   · 最多 16 步（--max-steps）：tool_calls → 执行（记忆工具走真 handler）→ 回填 → 再生成；
 *     步数用尽且此前没有 remember / file:* 动作的运行记为 truncated，不进处理率、漏记、误记、归宿的分子分母；
 *   · 按优先级归类主结果，再查 remember 约束 / bonus / 红线，按 split 汇总。
 *   · 场景可带 workspace（环境差异），让「助手刚做完、未提交」的活在仓库里看得见。
 *
 * 对 spec 的补充：file:* 除 write_file / edit_file 外，也认 run_command 对仓库文件的真实写入
 * （重定向、sed -i、heredoc、tee）——有了真 shell，这些同样是改了文件。
 *
 * 新旧两版插件都能测：旧版 remember 没有 source / load / evidence，这些约束记「不适用」，单列。
 * 工具入参原样交给 handler（宿主不校验 schema，非法枚举值由 handler 自己处理）；handler 抛异常记 handler-error。
 *
 * 已知简化：context 快照只在首步前取一次；section 每步重新解析；agent/pre-step 只在首步前触发一次。
 *
 * 场景：eval/remember-cases.json。test split 留作最终检验，`--split=dev` 时不会跑、也不输出它。
 *
 * 用法：
 *   node eval/remember.mjs                                   # 测本副本的 index.js，dev split
 *   node eval/remember.mjs --index=<某处>/index.js --split=all --runs=1 --temperature=0 --out=<结果.json>
 *   node eval/remember.mjs --only=A1,E13 --concurrency=2 --keep   # --keep 保留每个场景的临时目录
 *   node eval/remember.mjs --rescore=<结果.json> [--split=dev] [--out=<重算后.json>]
 *       不发任何请求：用当前的归类 / 计分规则与当前场景答案重算已保存的运行，打印汇总、逐条与归类变化
 *   node eval/remember.mjs --resume=<结果.json> --index=<同一个插件> [--max-requests=N]
 *       只跑文件里缺失或请求失败的场景，并回同一个文件（先备份为 *.before-resume-<时间>.json），
 *       再按合并后的全集重算并打印；--index 与文件记录的不一致就拒绝执行
 *   node eval/remember.mjs --replay=<结果.json> --index=<要检验的插件> [--split=dev] [--out=<重放结果.json>]
 *       不发请求、不读凭据：把文件里已完成场景的 memory_remember / memory_recall 调用原样重放到 --index 的插件上，
 *       逐次对比原结果与新结果。**只检验代码路径，不检验提示词效果**（模型没有重新采样），见 lib/remember-replay.mjs
 *   node eval/remember.mjs --export-prompts=<目录> --index=<插件> [--split=dev] [--only=A1,E1]
 *       不发请求：把每个场景模型第一步看到的全部信息（系统提示、工具定义、对话）导出成 <id>.md + manifest.json，
 *       交给别的模型独立作答。文件里没有标准答案与任何分类信息
 *   node eval/remember.mjs --import-decisions=<目录> --index=<插件> [--split=dev] [--out=<明细.json>]
 *       不发请求：读 <id>.json（{"tool_calls":[...],"final_reply":"..."}），在全新的场景宿主里按顺序执行、按同一套规则计分。
 *       **单步决定**：作答的模型看不到工具返回、不会重试，被拒写就按拒写计（见 DECISION_DISCLAIMER）
 *   --max-requests=N   本次最多发 N 个模型请求（含重试）；到了上限不再发新请求，正在跑的场景记为请求失败，
 *                      正常收尾写文件。默认不限。汇总里会打印本次实际发出的请求数
 *
 * 其余参数：--key-env=MYAPI_API_KEY --base=https://api.wwaihh.xyz/v1 --model=deepseek-v4.1-flash
 *           --timeout=120000（单次请求毫秒数）  --max-steps=16（前后对比必须同一个值）
 *
 * **同一时间只跑一个评测进程。** 两个进程并发会共用网关额度：2026-11-14 基线全量与新版 dev 并行，
 * 额度中途耗尽，两份都只跑完三分之一。要比较两版，就先跑完一份再跑另一份（不够就 --resume 补）。
 * 遇到额度类错误（HTTP 401/403、insufficient_user_quota 等）立即中止，不重试、不换 key。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { copyFileSync, mkdirSync } from 'node:fs'

import { loadPluginInstances, makeScenarioHost, renderToolResult, SEED_CHAPTERS, toOpenAiTool } from './lib/remember-host.mjs'
import { outcomeLabel, REPLAY_DISCLAIMER, replayRow } from './lib/remember-replay.mjs'
import { VirtualWorkspace } from './lib/remember-workspace.mjs'
import { propsFromShape, rememberOutcome, routedHomeOf, scoreRow, summarize } from './lib/remember-score.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------ 参数 */

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)
/** 命令行里是否显式给了这个参数（--resume 时用来判断「与文件记录冲突」）。 */
const given = (name) => process.argv.some((a) => a.startsWith(`--${name}=`))

const RESCORE = argOf('rescore', '') ? path.resolve(argOf('rescore', '')) : ''
const RESUME = argOf('resume', '') ? path.resolve(argOf('resume', '')) : ''
const REPLAY = argOf('replay', '') ? path.resolve(argOf('replay', '')) : ''
const EXPORT_DIR = argOf('export-prompts', '') ? path.resolve(argOf('export-prompts', '')) : ''
const IMPORT_DIR = argOf('import-decisions', '') ? path.resolve(argOf('import-decisions', '')) : ''
/** 不发任何模型请求的模式：不读凭据。 */
const OFFLINE = Boolean(RESCORE || REPLAY || EXPORT_DIR || IMPORT_DIR)
const INDEX = path.resolve(argOf('index', path.join(HERE, '..', 'index.js')))
// 下面几项在 --resume 时以结果文件里记录的为准（见「续跑」一节），所以是 let
let SPLIT = argOf('split', 'dev')
let ONLY = argOf('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
let RUNS = Math.max(1, Number(argOf('runs', '1')) || 1)
let TEMPERATURE = Number(argOf('temperature', '0'))
const KEY_ENV = argOf('key-env', 'MYAPI_API_KEY')
let BASE = argOf('base', 'https://api.wwaihh.xyz/v1').replace(/\/+$/, '')
let MODEL = argOf('model', 'deepseek-v4.1-flash')
const CONCURRENCY = Math.max(1, Number(argOf('concurrency', '4')) || 4)
const TIMEOUT_MS = Math.max(10000, Number(argOf('timeout', '120000')) || 120000)
const KEEP = flag('keep')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const OUT = path.resolve(argOf('out', path.join(os.tmpdir(), `dsh-remember-eval-${STAMP}.json`)))
// 默认 16 步（2026-11-14 协调决定：真实仓库里一件小活就要 9–14 步，8 步会截断）。
// 用尽且此前没有 remember / file:* 动作的运行记为 truncated，不进处理率等分母（见 remember-score.mjs）。
// 前后对比必须用同一个值
let MAX_STEPS = Math.max(1, Number(argOf('max-steps', '16')) || 16)
// 请求数硬上限（含重试）。不给 = 不限
const MAX_REQUESTS = given('max-requests') ? Math.max(0, Math.floor(Number(argOf('max-requests', '0')) || 0)) : Infinity

if ([RESCORE, RESUME, REPLAY, EXPORT_DIR, IMPORT_DIR].filter(Boolean).length > 1) {
  console.error('--rescore / --resume / --replay / --export-prompts / --import-decisions 只能用其中一个')
  process.exit(2)
}
if (!['dev', 'test', 'all'].includes(SPLIT)) {
  console.error(`--split 只能是 dev / test / all（收到 ${SPLIT}）`)
  process.exit(2)
}
if (!Number.isFinite(TEMPERATURE)) {
  console.error('--temperature 必须是数字')
  process.exit(2)
}
if (!RESCORE && !existsSync(INDEX)) {
  console.error(`找不到插件入口 ${INDEX}`)
  process.exit(2)
}

/** 从环境变量或 ~/.dsh/.credentials.yaml 按名字取 key（与 eval/run.mjs 相同）。绝不打印。 */
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

// --rescore / --replay 不发请求，也就不读凭据
const KEY = OFFLINE ? null : readCredential(KEY_ENV)
if (!OFFLINE && !KEY) {
  console.error(`找不到凭据 ${KEY_ENV}（环境变量与 ~/.dsh/.credentials.yaml 都没有）`)
  process.exit(1)
}

/** 任何要进日志/明细的错误文本都过一遍：去掉 key 本身和 Authorization 头。 */
const scrub = (text) =>
  (KEY ? String(text ?? '').split(KEY).join('***') : String(text ?? ''))
    .replace(/bearer\s+[^\s"',}]+/gi, 'Bearer ***')
    .replace(/authorization["']?\s*[:=]\s*["']?[^\s"',}]+/gi, 'authorization: ***')

/* ------------------------------------------------------------ 场景 */

const { cases: ALL_CASES } = JSON.parse(readFileSync(path.join(HERE, 'remember-cases.json'), 'utf8'))
const CASE_BY_ID = new Map(ALL_CASES.map((kase) => [kase.id, kase]))

const samePath = (a, b) => {
  const fold = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p
  return Boolean(a) && Boolean(b) && fold(path.resolve(String(a))) === fold(path.resolve(String(b)))
}

/* —— 重算 / 续跑：先读结果文件 ——
 * --resume 时，split / only / runs / model / base / temperature / max-steps 一律以文件里记录的为准：
 * 合并进同一个文件的运行必须同口径，否则合并出来的数字没有意义。命令行显式给了不同的值就拒绝。 */
let PRIOR = null
if (RESCORE || RESUME || REPLAY) {
  const file = RESCORE || RESUME || REPLAY
  try {
    PRIOR = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`读不了结果文件 ${file}：${error.message}`)
    process.exit(2)
  }
  if (!PRIOR?.meta || !Array.isArray(PRIOR.rows)) {
    console.error(`${file} 不是本脚本写出的结果文件（缺 meta / rows）`)
    process.exit(2)
  }
}
if ((RESCORE || REPLAY) && !given('split')) SPLIT = PRIOR.meta.split ?? 'dev'
if (RESUME) {
  const m = PRIOR.meta
  if (!samePath(m.index, INDEX)) {
    console.error(`拒绝续跑：--index（${INDEX}）与结果文件记录的插件（${m.index}）不是同一个`)
    process.exit(2)
  }
  const conflicts = []
  const check = (name, current, recorded) => {
    if (given(name) && String(current) !== String(recorded)) conflicts.push(`--${name}=${current}（文件里是 ${recorded}）`)
  }
  check('split', SPLIT, m.split)
  check('only', ONLY.join(','), (m.only ?? []).join(','))
  check('runs', RUNS, m.runs)
  check('model', MODEL, m.model)
  check('base', BASE, m.base)
  check('temperature', TEMPERATURE, m.temperature)
  check('max-steps', MAX_STEPS, m.maxSteps)
  if (conflicts.length > 0) {
    console.error(`拒绝续跑：参数与结果文件记录的不一致：${conflicts.join('；')}`)
    process.exit(2)
  }
  SPLIT = m.split
  ONLY = m.only ?? []
  RUNS = m.runs
  MODEL = m.model
  BASE = m.base
  TEMPERATURE = m.temperature
  MAX_STEPS = m.maxSteps
}

const inSplit = ALL_CASES.filter((kase) => SPLIT === 'all' || kase.split === SPLIT)
let selected = inSplit
if (ONLY.length > 0) {
  const known = new Set(inSplit.map((kase) => kase.id))
  const skipped = ONLY.filter((id) => !known.has(id))
  if (skipped.length > 0) console.log(`以下 id 不在 split=${SPLIT} 中，已跳过：${skipped.join(', ')}`)
  selected = inSplit.filter((kase) => ONLY.includes(kase.id))
}
if (selected.length === 0) {
  console.error('没有要跑的场景')
  process.exit(2)
}

/* ------------------------------------------------- 模拟环境：提示词与工具 */

// 只交代「在真实仓库里干活」和一句中性的效率要求：不写任何关于记忆、沉淀、该不该提问的引导——那是被测对象。
// 效率那句是为了让场景本身短下来（实测模型会通读整个仓库、改完反复跑测试，16 步都不够）。
const BASE_SYSTEM = [
  '你是一个编码助手，正在用户本地的一个真实代码仓库里干活（终端的当前目录就是仓库根目录）：读代码、改代码、跑命令，需要时调用提供的工具。',
  '仓库很小；直接动手，不需要通读仓库，改动后不必反复跑测试。',
  '今天是 2026-11-16（周一）。',
].join('\n')

/** system prompt = 极简设定 + 日期 + 插件 section 文本（按 order 拼好的）。 */
const systemPromptOf = (sectionText) => (sectionText ? `${BASE_SYSTEM}\n\n${sectionText}` : BASE_SYSTEM)

/** context 快照的包装形状（宿主以 user 角色放进历史）。 */
const wrapContext = (text) => `<system-reminder>\n${text}\n</system-reminder>`

/**
 * 通用工具：全部操作一份共享虚拟仓库（eval/lib/remember-workspace.mjs）的副本，每个场景开局重置。
 *
 * 为什么不是固定文本：v0（2026-11-14）里通用工具只回固定成功文本，模型 `echo hello` 一试就识破，
 * 反复探查直到 4 步耗光（52 次里 38 次），量到的是探查不是准入。现在读到的是真内容、写了能读回、
 * 命令给出与仓库一致的输出、不认识的命令照 bash 报错。
 */
const GENERIC_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a text file in the repository. Paths are relative to the repository root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to the repository root.' } },
      required: ['path'],
    },
    run: (ws, args) => ws.toolRead(args.path),
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the repository.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    run: (ws, args) => ws.toolWrite(args.path, args.content),
  },
  {
    name: 'edit_file',
    description: 'Replace an exact, unique occurrence of `old` with `new` in a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } },
      required: ['path', 'old', 'new'],
    },
    run: (ws, args) => ws.toolEdit(args.path, args.old, args.new),
  },
  {
    name: 'run_command',
    description: 'Run a bash command in the repository root and return its output.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    run: (ws, args) => ws.toolRun(args.command),
  },
  {
    name: 'todo_write',
    description: 'Replace the task checklist shown to the user.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['items'],
    },
    run: (ws, args) => ws.toolTodo(args.items),
  },
]

/* ---------------------------------------------------------- 模型调用 */

class FatalApiError extends Error {}
/** 达到 --max-requests：不中止整个评测，只是不再发新请求（正在跑的场景记为请求失败）。 */
class BudgetError extends Error {}

/** 网关是否接受回传 reasoning_content。遇到 400 抱怨它时关掉，后续请求都不带。 */
let sendReasoning = true
let fatalApi = null
/** 本次实际发出的模型请求数（每次 fetch 算一个，含重试）。 */
let requestCount = 0
let budgetHit = false

/** 额度类错误：换 key / 换网关都不是脚本该做的事，立即中止。 */
const isQuotaError = (status, body) =>
  status === 401 || status === 402 || status === 403 || /insufficient_(user_)?quota|quota_exceeded|余额不足|额度/i.test(body)

async function chat(messages, tools) {
  let lastError = null
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (fatalApi) throw fatalApi
    if (requestCount >= MAX_REQUESTS) {
      budgetHit = true
      throw new BudgetError(`达到请求上限（--max-requests=${MAX_REQUESTS}）`)
    }
    requestCount += 1
    const payloadMessages = sendReasoning
      ? messages
      : messages.map((m) => {
          if (m.role !== 'assistant' || !('reasoning_content' in m)) return m
          const { reasoning_content: _drop, ...rest } = m
          return rest
        })
    try {
      const response = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: payloadMessages,
          tools,
          tool_choice: 'auto',
          temperature: TEMPERATURE,
          max_tokens: 4000,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const errorBody = response.ok ? '' : await response.text().catch(() => '')
      if (!response.ok && isQuotaError(response.status, errorBody)) {
        fatalApi = new FatalApiError(scrub(`HTTP ${response.status} ${errorBody.slice(0, 200)}`))
        throw fatalApi
      }
      if (response.status === 400 && sendReasoning) {
        const body = errorBody
        if (/reasoning/i.test(body)) {
          sendReasoning = false
          lastError = new Error(scrub(`HTTP 400 ${body.slice(0, 200)}`))
          continue
        }
        throw new Error(scrub(`HTTP 400 ${body.slice(0, 200)}`))
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(scrub(`HTTP ${response.status} ${errorBody.slice(0, 200)}`))
        await new Promise((r) => setTimeout(r, (response.status === 429 ? 5000 : 1500) * attempt))
        continue
      }
      if (!response.ok) {
        throw new Error(scrub(`HTTP ${response.status} ${errorBody.slice(0, 200)}`))
      }
      const data = await response.json()
      const choice = data?.choices?.[0]
      if (!choice?.message) {
        lastError = new Error('响应里没有 choices[0].message')
        continue
      }
      return { message: choice.message, finishReason: choice.finish_reason ?? null, usage: data.usage ?? null }
    } catch (error) {
      if (error instanceof FatalApiError || error instanceof BudgetError) throw error
      // 非重试类的 HTTP 错误直接抛；网络错误/超时重试
      if (/^HTTP (4\d\d)/.test(String(error?.message)) && !/^HTTP 429/.test(String(error?.message))) throw error
      lastError = new Error(scrub(error?.name === 'TimeoutError' ? `请求超时（${TIMEOUT_MS}ms）` : error?.message ?? error))
      await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
  throw lastError ?? new Error('请求失败')
}

/* ------------------------------------------------------------ 单次运行 */

const parseArgs = (raw) => {
  if (raw && typeof raw === 'object') return { ok: true, value: raw }
  try {
    const value = JSON.parse(String(raw ?? '') || '{}')
    return value && typeof value === 'object' ? { ok: true, value } : { ok: false }
  } catch {
    return { ok: false }
  }
}

/**
 * 一个场景的开局：假宿主 + 预置记忆 + 虚拟仓库（叠环境差异）+ 每条用户消息一批 pre-step。
 * 真跑（runCase）、导出提示（--export-prompts）、导入答案（--import-decisions）共用，三者看到的开局完全一样。
 * 返回 { host, ws, userTexts, evidenceTexts, rememberDef, recallDef, schemaProps, tools, snapshot } 或 { error, host? }。
 */
async function setupScenario(mod, kase, label) {
  const userTexts = [...kase.history.filter((m) => m.role === 'user').map((m) => m.content), kase.message]
  let host
  try {
    host = makeScenarioHost(mod, { label, userTexts })
  } catch (error) {
    if (error.fatal) throw error
    return { error: `搭建假宿主失败：${error.message}` }
  }
  if (kase.preset) {
    const preset = await host.preset(kase.preset)
    if (!preset.ok) return { error: `预置记忆失败（${preset.via}）`, host }
  }
  const rememberDef = host.tools.get('memory_remember')
  const recallDef = host.tools.get('memory_recall')
  // 每个场景一份虚拟仓库副本：叠上本场景的环境差异（刚做完未提交的改动等）；
  // 插件报给模型的会话工作目录（真实临时目录）也映射到仓库根
  let ws
  try {
    ws = new VirtualWorkspace({ aliases: [host.workspace], overlay: kase.workspace ?? null })
  } catch (error) {
    return { error: `场景环境差异写错了：${error.message}`, host }
  }
  // 证据核对与插件用同一份「用户原话」：新版导出了 userTextsOf 就用它读假会话
  const evidenceTexts = typeof mod.userTextsOf === 'function' ? mod.userTextsOf(host.session) : userTexts
  // 每条用户消息一批 pre-step（官方形状）：新版的「用户原话」缓存与快照回落两路都有数据
  await host.firePreStep(userTexts)
  // context 不进 system prompt：宿主把它作为 user 角色的快照放进历史（只在首步前取一次，见文件头「已知简化」）
  const contextText = host.pluginContextText()
  return {
    host,
    ws,
    userTexts,
    evidenceTexts,
    rememberDef,
    recallDef,
    schemaProps: rememberDef.parameters?.properties ?? {},
    tools: [toOpenAiTool(rememberDef), toOpenAiTool(recallDef), ...GENERIC_TOOLS.map(toOpenAiTool)],
    snapshot: contextText ? wrapContext(contextText) : '',
  }
}

/**
 * 执行一次工具调用：记忆工具走插件的真 handler（入参原样），通用工具走虚拟仓库，未知工具名只记录。
 * 返回 { record, replyText, remember? }——remember 是 memory_remember 调用的计分记录。
 */
async function executeToolCall(ctx, { name, rawArgs, step }) {
  const { mod, host, ws, rememberDef, recallDef, evidenceTexts } = ctx
  const parsed = parseArgs(rawArgs)
  const args = parsed.ok ? parsed.value : null
  const record = { name, args, ...(parsed.ok ? {} : { rawArguments: String(rawArgs ?? '') }) }
  let replyText
  let remember

  if (name === 'memory_remember' || name === 'memory_recall') {
    const def = name === 'memory_remember' ? rememberDef : recallDef
    let value
    let threw = null
    if (!parsed.ok) {
      threw = new Error('参数不是合法 JSON')
      replyText = 'Invalid arguments: not valid JSON.'
    } else {
      try {
        value = await def.execute(args, { agent: host.agent })
      } catch (error) {
        threw = error
      }
      replyText = threw ? `Tool failed: ${threw?.message ?? threw}` : renderToolResult(def, args, value)
    }
    record.result = value ?? null
    if (threw) record.threw = String(threw?.message ?? threw)
    if (name === 'memory_remember') {
      const outcome = rememberOutcome(value, Boolean(threw))
      remember = {
        step,
        args: args ?? {},
        ...(parsed.ok ? {} : { rawArguments: record.rawArguments }),
        result: value ?? null,
        ...(threw ? { threw: record.threw } : {}),
        outcome: parsed.ok ? outcome.outcome : 'refused',
        ...(parsed.ok ? (outcome.reason ? { reason: outcome.reason } : {}) : { reason: 'bad-json' }),
      }
      // 证据核对：只对 source=user 的调用。插件自己在返回里给了核实结论（第六轮起：找得到原话且与记忆相关）
      // 就以它为准；否则按导出的核对函数算；都没有（旧版）记 null = 不适用
      if (args?.source === 'user') {
        remember.evidenceVerified =
          typeof value?.evidenceVerified === 'boolean'
            ? value.evidenceVerified
            : typeof mod.verifyEvidence === 'function'
              ? Boolean(mod.verifyEvidence(evidenceTexts, args.evidence)?.verified)
              : null
      }
    }
  } else {
    const generic = GENERIC_TOOLS.find((tool) => tool.name === name)
    if (!generic) {
      replyText = `Unknown tool: ${name}`
      record.unknownTool = true
    } else if (!parsed.ok) replyText = '错误：参数不是合法 JSON'
    else {
      try {
        replyText = generic.run(ws, args ?? {})
      } catch (error) {
        replyText = `错误：${error?.message ?? error}`
      }
      replyText = await host.postExecute(name, args ?? {}, replyText)
    }
  }
  record.reply = replyText
  return { record, replyText, remember }
}

/** 一次运行结束后的公共收尾：写入记录、仓库改动、文件快照，然后计分。 */
function finishRow(row, kase, setup) {
  // 对仓库文件的写入一律来自虚拟仓库的写入记录：write_file / edit_file，以及 run_command 里的
  // 重定向、sed -i、heredoc 等（同样是真的改了文件，见文件头「对 spec 的补充」）
  row.fileWrites = setup.ws.writes.filter((write) => !write.removed)
  row.workspaceChanges = setup.ws.changesSnapshot()
  if (setup.ws.todos.length > 0) row.todos = setup.ws.todos
  /* —— 归类与计分：只用存进 row 的数据（含文件快照），--rescore / --resume 走同一个函数 —— */
  row.files = setup.host.snapshotFiles()
  scoreRow(kase, row, setup.schemaProps, { seedChapters: SEED_CHAPTERS })
  return row
}

const newRow = (kase, run) => ({
  id: kase.id,
  split: kase.split,
  group: kase.group,
  polarity: kase.polarity,
  destination: Boolean(kase.destination),
  run,
  accept: kase.accept,
  status: 'ok',
  steps: [],
  rememberCalls: [],
  fileWrites: [],
  finalText: '',
})

async function runCase(mod, kase, run) {
  const row = newRow(kase, run)
  const setup = await setupScenario(mod, kase, `${kase.id}-r${run}`)
  try {
    if (setup.error) return { ...row, status: 'error', error: setup.error }
    const { host, tools, snapshot } = setup
    row.tempRoot = host.root
    if (host.configNotes.length > 0) row.configNotes = host.configNotes
    if (kase.preset) row.preset = { ok: true, id: kase.preset.id }
    row.userTexts = setup.userTexts

    const messages = [
      { role: 'system', content: '' },
      ...(snapshot ? [{ role: 'user', content: snapshot }] : []),
      ...kase.history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: kase.message },
    ]
    row.contextSnapshot = snapshot
    row.promptRegistrations = host.promptRegistrations()

    let finished = false
    for (let step = 1; step <= MAX_STEPS; step += 1) {
      // section 每步重新解析：写入之后插件给的文本可能变，宿主也是每步组装 system prompt
      const sectionText = host.pluginSectionText()
      messages[0].content = systemPromptOf(sectionText)
      if (step === 1) {
        row.sectionText = sectionText
        row.promptChars = { system: messages[0].content.length, context: snapshot.length }
      }

      let reply
      try {
        reply = await chat(messages, tools)
      } catch (error) {
        if (error instanceof FatalApiError) throw error
        row.status = 'error'
        row.error = `第 ${step} 步请求失败：${scrub(error?.message ?? error)}`
        return row
      }

      if (step === 1) {
        const tokens = reply.usage?.prompt_tokens
        row.firstPromptTokens = typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null
      }

      const message = reply.message
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      const stepRecord = {
        step,
        text: typeof message.content === 'string' ? message.content : '',
        finishReason: reply.finishReason,
        toolCalls: [],
      }
      row.steps.push(stepRecord)

      if (toolCalls.length === 0) {
        row.finalText = stepRecord.text
        finished = true
        break
      }

      const assistantMessage = { role: 'assistant', content: message.content ?? '', tool_calls: toolCalls }
      if (typeof message.reasoning_content === 'string') assistantMessage.reasoning_content = message.reasoning_content
      messages.push(assistantMessage)

      for (const [i, call] of toolCalls.entries()) {
        const callId = call.id || `call_${step}_${i}`
        const { record, replyText, remember } = await executeToolCall(
          { mod, ...setup },
          { name: call.function?.name ?? '', rawArgs: call.function?.arguments, step },
        )
        if (remember) row.rememberCalls.push(remember)
        stepRecord.toolCalls.push(record)
        messages.push({ role: 'tool', tool_call_id: callId, content: replyText || '(empty)' })
      }
    }

    // 步数用完还在调工具：没有「最后一条纯文本」，就把各步的文本拼起来当最终回复
    if (!finished) {
      row.stepsExhausted = true
      row.finalText = row.steps
        .map((s) => s.text)
        .filter(Boolean)
        .join('\n')
    }
    return finishRow(row, kase, setup)
  } finally {
    if (setup.host && !KEEP) setup.host.cleanup()
  }
}

/* ------------------------------------------------------- 单步决定：导出提示 / 导入答案 */

/**
 * 导出 / 导入的口径（2026-11-14 协调决定）：网关额度不够时，把每个场景模型第一步看到的全部信息导出成文件，
 * 交给别的模型独立作答（一次给出全部工具调用与最后一句话），再导回来离线执行与计分。
 * **这是单步决定**：作答的模型看不到任何工具返回、不会因被拒而重试，所以「被拒后重试成功」无从体现，
 * 被拒写的调用就按拒写计；也看不到读文件 / 跑命令的结果，只能凭对话本身决定改什么、写什么。
 */
const DECISION_DISCLAIMER =
  '这是单步决定的导入计分：作答的模型一次给出全部工具调用和最后一句话，看不到任何工具返回、不会重试——' +
  '「被拒后重试成功」无从体现，被拒写的调用按拒写计；读文件、跑命令的结果它也看不到。数字不能与真实多步运行直接比较。'

/** 输出里不得出现任何与记忆、沉淀、归宿、提问有关的引导：这一段只规定格式。 */
const DECISION_TASK = [
  '给出助手在这一轮里会做的事：按顺序列出要调用的工具及参数，以及最后对用户说的话。',
  '只输出一个 JSON 对象，形如：',
  '{"tool_calls":[{"name":"<工具名>","arguments":{...}}],"final_reply":"<对用户说的话>"}',
  '不需要调用工具时 tool_calls 为空数组。不要输出 JSON 以外的任何内容。',
].join('\n')

/** 把一段文本原样放进围栏：围栏比文本里最长的反引号串还长，内容就不会被截断或误解析。 */
function fenced(text, lang = '') {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${lang}\n${text}\n${fence}`
}

/** 场景第一步的完整提示 → Markdown（结构见协调要求；系统提示、工具定义、对话都逐字给出）。 */
function renderPrompt(kase, setup) {
  const system = systemPromptOf(setup.host.pluginSectionText())
  const lines = [
    '# 角色',
    '你是下面这段系统提示所描述的助手。请完全按它行事。',
    '',
    '## 系统提示',
    fenced(system),
    '',
    '## 可用工具',
  ]
  for (const tool of setup.tools) {
    lines.push('', `### ${tool.function.name}`, fenced(JSON.stringify(tool, null, 2), 'json'))
  }
  lines.push('', '## 对话')
  if (setup.snapshot) lines.push('', '（系统提醒）', fenced(setup.snapshot))
  for (const message of kase.history) {
    lines.push('', message.role === 'user' ? '**用户：**' : '**助手：**', fenced(message.content))
  }
  lines.push('', '**用户：**', fenced(kase.message), '', '## 你的任务', DECISION_TASK, '')
  return lines.join('\n')
}

/**
 * 从作答文本里抠出 JSON 对象：先整体解析，再试 ```json 围栏里的内容，最后取第一个 `{` 到与之配对的 `}`。
 * 返回 { ok, value } 或 { ok: false, why }。
 */
function extractDecision(text) {
  const tryParse = (s) => {
    try {
      return { ok: true, value: JSON.parse(s) }
    } catch {
      return { ok: false }
    }
  }
  const raw = String(text ?? '').replace(/^﻿/, '').trim()
  if (!raw) return { ok: false, why: '文件为空' }
  let hit = tryParse(raw)
  if (!hit.ok) {
    const fence = /```(?:json)?\s*\n([\s\S]*?)\n?```/i.exec(raw)
    if (fence) hit = tryParse(fence[1].trim())
  }
  if (!hit.ok) {
    // 第一个 { 起按括号配平（跳过字符串里的括号）
    const start = raw.indexOf('{')
    if (start >= 0) {
      let depth = 0
      let inString = false
      for (let i = start; i < raw.length; i += 1) {
        const c = raw[i]
        if (inString) {
          if (c === '\\') i += 1
          else if (c === '"') inString = false
        } else if (c === '"') inString = true
        else if (c === '{') depth += 1
        else if (c === '}') {
          depth -= 1
          if (depth === 0) {
            hit = tryParse(raw.slice(start, i + 1))
            break
          }
        }
      }
    }
  }
  if (!hit.ok) return { ok: false, why: '找不到可解析的 JSON 对象' }
  const value = hit.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, why: '顶层不是 JSON 对象' }
  if (!Array.isArray(value.tool_calls)) return { ok: false, why: 'tool_calls 不是数组' }
  if (typeof value.final_reply !== 'string') return { ok: false, why: 'final_reply 不是字符串' }
  for (const [i, call] of value.tool_calls.entries()) {
    if (!call || typeof call !== 'object' || typeof call.name !== 'string' || !call.name) return { ok: false, why: `tool_calls[${i}] 缺 name` }
    const args = call.arguments
    if (args !== undefined && typeof args !== 'string' && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      return { ok: false, why: `tool_calls[${i}].arguments 不是对象` }
    }
  }
  return { ok: true, value }
}

/** 导入一个场景的单步决定：按顺序执行 tool_calls，final_reply 作为最终回复，再用同一套规则计分。 */
async function importCase(mod, kase, decision) {
  const row = newRow(kase, 1)
  row.mode = 'decision'
  const setup = await setupScenario(mod, kase, `${kase.id}-decision`)
  try {
    if (setup.error) return { ...row, status: 'error', error: setup.error }
    row.userTexts = setup.userTexts
    row.contextSnapshot = setup.snapshot
    const stepRecord = { step: 1, text: '', toolCalls: [] }
    row.steps.push(stepRecord)
    for (const call of decision.tool_calls) {
      const { record, remember } = await executeToolCall(
        { mod, ...setup },
        { name: call.name, rawArgs: call.arguments ?? {}, step: 1 },
      )
      if (remember) row.rememberCalls.push(remember)
      stepRecord.toolCalls.push(record)
    }
    row.unknownTools = stepRecord.toolCalls.filter((record) => record.unknownTool).map((record) => record.name)
    row.finalText = decision.final_reply
    row.steps.push({ step: 2, text: decision.final_reply, toolCalls: [] })
    return finishRow(row, kase, setup)
  } finally {
    if (setup.host && !KEEP) setup.host.cleanup()
  }
}

/* ------------------------------------------------------- 真实 ~/.dsh 核对 */

/**
 * 只看时间戳和目录名，不读任何内容。宿主主目录照插件的解析规则：$DSH_HOME 非空白就用它。
 * 新版的全局按需库默认在 <主目录>/dsh-workspace-memory/global/memory，所以把整个
 * dsh-workspace-memory 目录也纳入「不得出现 / 不得变化」。
 */
function dshFingerprint() {
  const fromEnv = process.env.DSH_HOME
  const home = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : path.join(os.homedir(), '.dsh')
  const mtime = (p) => {
    try {
      return statSync(p).mtimeMs
    } catch {
      return null
    }
  }
  let projects = []
  try {
    projects = readdirSync(path.join(home, 'projects')).sort()
  } catch {
    projects = []
  }
  return {
    agentsMtime: mtime(path.join(home, 'AGENTS.md')),
    projects,
    globalMemoryExists: existsSync(path.join(home, 'global-memory')),
    agentsHistoryMtime: mtime(path.join(home, '.dsh-workspace-memory-history')),
    pluginHomeMtime: mtime(path.join(home, 'dsh-workspace-memory')),
  }
}

/* ------------------------------------------------------------ 输出格式 */

/** 按显示宽度补空格（中日韩字符与全角符号算 2 列），否则中英混排的表格对不齐。 */
const displayWidth = (text) => Array.from(String(text)).reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(ch) ? 2 : 1), 0)
const padDisplay = (text, width) => `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`

const pct = (r) => (r.pct === null ? '—' : `${(r.pct * 100).toFixed(1)}%`)
const frac = (r) => `${r.n}/${r.d} = ${pct(r)}`

function printSummary(label, s) {
  const invalid = s.invalid ?? []
  const excluded = [s.failed.length ? `请求失败 ${s.failed.length}` : '', invalid.length ? `答案无效 ${invalid.length}` : ''].filter(Boolean)
  console.log(`\n=== ${label}：${s.runs} 次运行${excluded.length ? `，其中${excluded.join('、')}（不计入分母）` : ''} ===`)
  if (s.failed.length > 0) {
    console.log(`  !!! 请求失败：${s.failed.map((f) => `${f.id}#${f.run}`).join(', ')}`)
  }
  if (invalid.length > 0) {
    console.log(`  !!! 答案无效：${invalid.map((f) => `${f.id}（${f.error}）`).join('；')}`)
  }
  const f = s.field
  const fieldLine = (name) => {
    const b = f[name]
    const d = b.pass + b.fail
    return `${name} ${b.pass}/${d}${d ? ` (${((b.pass / d) * 100).toFixed(0)}%)` : ''}${b.na ? ` 不适用${b.na}` : ''}`
  }
  const t = s.firstPromptTokens
  const rows = [
    [
      '首轮 prompt token 均值',
      t.mean === null ? '网关未返回 usage' : `${t.mean.toFixed(1)}（n=${t.n}${t.missing ? `，缺 ${t.missing}` : ''}）`,
    ],
    [
      '截断数（不进下列分母）',
      `${s.truncated.count}${s.truncated.ids.length ? `（${s.truncated.ids.join(', ')}）` : ''}`,
    ],
    ['平均步数', s.avgSteps === null ? '—' : s.avgSteps.toFixed(1)],
    ['总体落在 accept 内', frac(s.overall)],
    ['处理率（应处理类）', frac(s.handled)],
    ['漏记数', String(s.missed)],
    ['误记数（E + F4）', String(s.falseWrites)],
    ['负样本正确率', frac(s.negativeCorrect)],
    ['归宿正确率（H/I/J）', `${frac(s.destination)}；归宿错（得到 remember）${s.destinationAsRemember}`],
    ['字段正确率', ['type', 'scope', 'load', 'source'].map(fieldLine).join('；')],
    [
      '证据核对（source=user）',
      s.evidence.verified + s.evidence.failed + s.evidence.na === 0
        ? '无 source=user 的调用'
        : `通过 ${s.evidence.verified}/${s.evidence.verified + s.evidence.failed}${s.evidence.na ? `，不适用 ${s.evidence.na}` : ''}`,
    ],
    [
      '写入分布（调过 remember 的运行）',
      `直写 ${s.writes.direct} / 待确认 ${s.writes.pending} / 只有改道 ${s.writes.routedOnly ?? 0} / 只有被拒 ${s.writes.refusedOnly}`,
    ],
    [
      '改道（belongs-elsewhere 等）',
      s.routed
        ? `调用 skill ${s.routed.calls.skill} / agents ${s.routed.calls.agents} / readme ${s.routed.calls.readme}；` +
          `主结果为 routed 的运行 skill ${s.routed.runs.skill} / agents ${s.routed.runs.agents} / readme ${s.routed.runs.readme}` +
          '（单步导入时模型看不到改道的返回，「改道后有没有真的向用户提议」无从体现）'
        : '—',
    ],
    ['红线命中', `${s.redline.hit}${s.redline.ids.length ? `（${s.redline.ids.join(', ')}）` : ''}${s.redline.na ? `；不适用 ${s.redline.na}` : ''}`],
    ['bonus 命中', `${s.bonus.hit}/${s.bonus.hit + s.bonus.miss}${s.bonus.na ? `；不适用 ${s.bonus.na}` : ''}`],
    [
      '被拒写',
      `${Object.entries(s.refused.reasons).map(([k, v]) => `${k}×${v}`).join(' ') || '无'}；被拒后重试成功 ${s.refused.retriedOk}/${s.refused.runs}`,
    ],
    [
      '错误细分',
      Object.entries(s.errorKinds)
        .map(([k, v]) => `${k} ${v}${s.errorKindIds?.[k] ? `（${s.errorKindIds[k].join(', ')}）` : ''}`)
        .join('；') || '无',
    ],
    [`${MAX_STEPS} 步用尽`, `${s.exhausted} 次（其中用尽前已有 remember / file:* 动作、照常归类的 ${s.exhausted - s.truncated.count} 次）`],
  ]
  for (const [k, v] of rows) console.log(`  ${padDisplay(k, 34)} ${v}`)
}

function rowLine(row) {
  if (row.status === 'invalid') return `  ${row.id.padEnd(4)}#${row.run} 答案无效  ${row.error}`
  if (row.status !== 'ok') return `  ${row.id.padEnd(4)}#${row.run} 请求失败  ${row.error}`
  const mark = row.main === 'truncated' ? '—' : row.inAccept ? '✔' : `✘${row.errorKind ? `(${row.errorKind})` : ''}`
  const pw = row.primaryWrite
  const write = pw
    ? `${pw.outcome} type=${pw.type} scope=${pw.scope} load=${pw.load ?? '—'} source=${pw.source ?? '—'}`
    : ''
  const refused = row.rememberCalls.filter((c) => c.outcome === 'refused' && !routedHomeOf(c)).map((c) => c.reason)
  const routedTo = row.rememberCalls.map(routedHomeOf).filter(Boolean)
  const extra = [
    write,
    routedTo.length ? `改道:${routedTo.join(',')}` : '',
    refused.length ? `拒:${refused.join(',')}` : '',
    row.bonus ? `bonus:${row.bonus.status}` : '',
    row.redline ? `红线:${row.redline.status}` : '',
    `${row.stepCount ?? row.steps?.length ?? 0}步${row.stepsExhausted ? '(用尽)' : ''}`,
  ]
    .filter(Boolean)
    .join('  ')
  return `  ${row.id.padEnd(4)}#${row.run} ${row.main.padEnd(15)} ${padDisplay(mark, 10)} ${extra}`
}

/* ------------------------------------------------------------ 重算（--rescore）与共用的打印 */

const fmtAccept = (value) => (value === null ? '截断' : value ? '✔' : '✘')
const splitsOf = (split) => (split === 'all' ? ['dev', 'test'] : [split])

/** memory_remember 的 properties 只留计分用得到的（类型与枚举），描述文字不进结果文件。 */
const slimProps = (props) =>
  Object.fromEntries(
    Object.entries(props ?? {}).map(([key, value]) => [
      key,
      { ...(value?.type ? { type: value.type } : {}), ...(Array.isArray(value?.enum) ? { enum: value.enum } : {}) },
    ]),
  )

/** 用当前规则与当前场景答案给已保存的运行重新打分；返回主结果或对错发生变化的运行。 */
function rescoreRows(rows, schemaProps) {
  const changes = []
  for (const row of rows) {
    if (row.status !== 'ok') continue
    const kase = CASE_BY_ID.get(row.id)
    if (!kase) continue
    const before = { main: row.main, inAccept: row.inAccept ?? null }
    scoreRow(kase, row, schemaProps, { seedChapters: SEED_CHAPTERS })
    if (before.main !== row.main || before.inAccept !== row.inAccept) {
      changes.push({ id: row.id, run: row.run, split: row.split, from: before.main, to: row.main, acceptFrom: before.inAccept, acceptTo: row.inAccept })
    }
  }
  return changes
}

/** 打印逐条 + 汇总，只打印 splits 里的（--split=dev 时不碰 test 的任何逐条信息）。 */
function printReport(rows, splits) {
  const summaries = {}
  for (const split of splits) summaries[split] = summarize(rows.filter((row) => row.split === split))
  for (const split of splits) {
    console.log(`\n--- 逐条（${split}）---`)
    for (const row of rows.filter((r) => r.split === split)) console.log(rowLine(row))
  }
  for (const split of splits) printSummary(split, summaries[split])
  return summaries
}

if (RESCORE) {
  const schemaProps = PRIOR.meta.rememberSchemaProps ?? propsFromShape(PRIOR.meta.rememberSchema)
  const splits = splitsOf(SPLIT)
  console.log(`重算 ${RESCORE}（插件 ${PRIOR.meta.index}；不发任何请求）`)
  // 重算以当前题目文件的 accept 为准，不用结果文件里存下的旧 accept。
  // 2026-11-16：旧常驻结果也只按 remember 计分，不再用 load 推断去向；不代表重新执行了写入。
  console.log(`题目文件：${path.join(HERE, 'remember-cases.json')}（accept 以它为准，结果文件里存下的旧 accept 不用）`)
  const changes = rescoreRows(PRIOR.rows, schemaProps)
  printReport(PRIOR.rows, splits)
  const shown = changes.filter((change) => splits.includes(change.split))
  console.log(`\n归类变化（${shown.length} 条）：`)
  for (const c of shown) {
    console.log(`  ${c.id}#${c.run}  ${c.from} → ${c.to}${c.acceptFrom !== c.acceptTo ? `（${fmtAccept(c.acceptFrom)} → ${fmtAccept(c.acceptTo)}）` : ''}`)
  }
  if (given('out')) {
    const summaries = {}
    for (const split of splitsOf(PRIOR.meta.split ?? 'all')) summaries[split] = summarize(PRIOR.rows.filter((row) => row.split === split))
    writeFileSync(OUT, JSON.stringify({ ...PRIOR, meta: { ...PRIOR.meta, rescoredAt: STAMP }, summaries, rows: PRIOR.rows }, null, 2), 'utf8')
    console.log(`\n重算结果已写入 ${OUT}`)
  }
  process.exit(0)
}

/* ------------------------------------------------------------ 重放（--replay） */

if (REPLAY) {
  const yesNo = (value) => (value === null || value === undefined ? '不适用' : value ? '是' : '否')
  const fieldsOf = (args) =>
    ['type', 'scope', 'load', 'source'].map((key) => (typeof args?.[key] === 'string' && args[key] ? args[key] : '—')).join('/')
  const splits = splitsOf(SPLIT)
  const rowsToReplay = PRIOR.rows.filter((row) => row.status === 'ok' && splits.includes(row.split) && CASE_BY_ID.has(row.id))

  console.log(`!!! ${REPLAY_DISCLAIMER}`)
  console.log(`重放 ${REPLAY}（原运行的插件 ${PRIOR.meta.index}）→ 插件 ${INDEX}；${rowsToReplay.length} 个已完成的场景；不发任何模型请求`)

  const before = dshFingerprint()
  const [mod] = await loadPluginInstances(INDEX, 1)
  // 被检验插件的 schema（计分用）：空跑一次 apply 取得，同时走一遍隔离核对
  let schemaProps
  try {
    const probe = makeScenarioHost(mod, { label: 'replay-shape', userTexts: [] })
    schemaProps = slimProps(probe.tools.get('memory_remember')?.parameters?.properties ?? {})
    probe.cleanup()
  } catch (error) {
    console.error(`!!! ${error?.message ?? error}`)
    process.exit(1)
  }

  const scenarios = []
  for (const row of rowsToReplay) {
    const kase = CASE_BY_ID.get(row.id)
    const replay = await replayRow({ mod, kase, row, schemaProps, seedChapters: SEED_CHAPTERS })
    scenarios.push({
      id: row.id,
      run: row.run,
      split: row.split,
      original: { main: row.main, inAccept: row.inAccept ?? null },
      ...(replay.error ? { error: replay.error } : { calls: replay.calls, replay: replay.scored }),
    })
  }

  console.log('\n--- 逐次调用（原结果 → 重放结果）---')
  for (const scenario of scenarios) {
    if (scenario.error) {
      console.log(`  ${scenario.id}  重放失败：${scenario.error}`)
      continue
    }
    for (const call of scenario.calls) {
      if (call.skipped) {
        console.log(`  ${scenario.id.padEnd(4)} #${call.n} ${call.name}  ${call.skipped}`)
      } else if (call.name === 'memory_remember') {
        console.log(
          `  ${scenario.id.padEnd(4)} #${call.n} remember  ${fieldsOf(call.args).padEnd(32)} ${outcomeLabel(call.original)} → ${outcomeLabel(call.replay)}` +
            `${call.changed ? '  [变]' : ''}  evidenceVerified=${call.evidenceVerified === null ? '—' : call.evidenceVerified}` +
            `  过期值提示=${call.staleValues ? call.staleValues.join(',') : '无'}`,
        )
      } else {
        console.log(`  ${scenario.id.padEnd(4)} #${call.n} recall    原 ${call.original.count} 条 → 重放 ${call.replay.count} 条${call.changed ? '  [变]' : ''}`)
      }
    }
  }

  console.log('\n--- source=user 的证据核对（插件导出的函数；没导出记「不适用」）---')
  for (const scenario of scenarios) {
    for (const call of scenario.calls ?? []) {
      if (!call.evidence) continue
      const e = call.evidence
      const how = e.match ? `(${e.match === 'exact' ? '精确' : e.match === 'approx' ? '近似' : e.match})` : ''
      console.log(
        `  ${scenario.id.padEnd(4)} #${call.n}  核对到=${yesNo(e.found)}${how}` +
          `  相关[标题,摘要,正文]=${yesNo(e.relatesFull)}  相关[标题,摘要]=${yesNo(e.relatesTitleDesc)}` +
          `\n         证据「${e.evidence}」\n         标题「${e.title ?? ''}」`,
      )
    }
  }

  // —— 汇总 ——
  const allCalls = scenarios.flatMap((scenario) => scenario.calls ?? [])
  const rememberCalls = allCalls.filter((call) => call.name === 'memory_remember' && !call.skipped)
  const transitions = {}
  for (const call of rememberCalls.filter((c) => c.changed)) {
    const key = `${outcomeLabel(call.original)} → ${outcomeLabel(call.replay)}`
    transitions[key] = (transitions[key] ?? 0) + 1
  }
  const recallCalls = allCalls.filter((call) => call.name === 'memory_recall' && !call.skipped)
  const replayedScenarios = scenarios.filter((s) => !s.error)
  const sameMain = replayedScenarios.filter((s) => s.replay.main === s.original.main)
  console.log('\n--- 汇总 ---')
  console.log(
    `  memory_remember：${rememberCalls.length} 次，不变 ${rememberCalls.filter((c) => !c.changed).length}，变化 ${rememberCalls.filter((c) => c.changed).length}`,
  )
  for (const [key, count] of Object.entries(transitions)) console.log(`    ${key} ×${count}`)
  console.log(`  memory_recall：${recallCalls.length} 次，结果条目不变 ${recallCalls.filter((c) => !c.changed).length}，变化 ${recallCalls.filter((c) => c.changed).length}`)
  console.log(`  场景主结果与原运行一致：${sameMain.length}/${replayedScenarios.length}`)
  for (const s of replayedScenarios) {
    const mark = s.replay.main === 'truncated' ? '—' : s.replay.inAccept ? '✔' : '✘'
    console.log(`    ${s.id.padEnd(4)} ${s.original.main} → ${s.replay.main} ${mark}${s.replay.main !== s.original.main ? '  [变]' : ''}`)
  }

  const after = dshFingerprint()
  const isolationOk =
    before.agentsMtime === after.agentsMtime &&
    JSON.stringify(before.projects) === JSON.stringify(after.projects) &&
    before.globalMemoryExists === after.globalMemoryExists &&
    before.agentsHistoryMtime === after.agentsHistoryMtime &&
    before.pluginHomeMtime === after.pluginHomeMtime
  console.log(`\n隔离核对（真实 ~/.dsh，只比时间戳与目录名）：${isolationOk ? '全部未变' : '!!! 有变化，查看结果文件 meta.isolation'}`)
  console.log(`\n!!! ${REPLAY_DISCLAIMER}`)

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        meta: {
          mode: 'replay',
          disclaimer: REPLAY_DISCLAIMER,
          source: REPLAY,
          sourceIndex: PRIOR.meta.index,
          index: INDEX,
          split: SPLIT,
          at: STAMP,
          requests: 0,
          isolation: { ok: isolationOk, before, after },
        },
        summary: {
          remember: { total: rememberCalls.length, changed: rememberCalls.filter((c) => c.changed).length, transitions },
          recall: { total: recallCalls.length, changed: recallCalls.filter((c) => c.changed).length },
          sameMain: sameMain.length,
          scenarios: replayedScenarios.length,
        },
        scenarios,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`\n重放结果已写入 ${OUT}`)
  process.exit(isolationOk ? 0 : 1)
}

/* ------------------------------------------------------------ 导出提示（--export-prompts） */

/** 隔离核对的一行结论（只比时间戳与目录名）。 */
const isolationOkOf = (before, after) =>
  before.agentsMtime === after.agentsMtime &&
  JSON.stringify(before.projects) === JSON.stringify(after.projects) &&
  before.globalMemoryExists === after.globalMemoryExists &&
  before.agentsHistoryMtime === after.agentsHistoryMtime &&
  before.pluginHomeMtime === after.pluginHomeMtime

if (EXPORT_DIR) {
  mkdirSync(EXPORT_DIR, { recursive: true })
  console.log(`导出 ${selected.length} 个场景的第一步提示 → ${EXPORT_DIR}（插件 ${INDEX}；不发任何模型请求）`)
  const before = dshFingerprint()
  const [mod] = await loadPluginInstances(INDEX, 1)
  const chars = {}
  for (const kase of selected) {
    const setup = await setupScenario(mod, kase, `export-${kase.id}`)
    try {
      if (setup.error) {
        console.error(`  ${kase.id}：${setup.error}`)
        continue
      }
      // 文件里只有模型第一步会看到的东西：没有标准答案、分类名、accept 之类的元信息；文件名只用场景 id
      const text = renderPrompt(kase, setup)
      writeFileSync(path.join(EXPORT_DIR, `${kase.id}.md`), text, 'utf8')
      chars[kase.id] = text.length
    } finally {
      setup.host?.cleanup()
    }
  }
  writeFileSync(
    path.join(EXPORT_DIR, 'manifest.json'),
    JSON.stringify({ index: INDEX, split: SPLIT, only: ONLY, ids: Object.keys(chars), chars, exportedAt: STAMP }, null, 2),
    'utf8',
  )
  const after = dshFingerprint()
  const values = Object.values(chars)
  console.log(`  写出 ${values.length} 个文件，平均 ${values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0} 字符；manifest.json 已写`)
  console.log(`隔离核对（真实 ~/.dsh，只比时间戳与目录名）：${isolationOkOf(before, after) ? '全部未变' : '!!! 有变化'}`)
  process.exit(isolationOkOf(before, after) ? 0 : 1)
}

/* ------------------------------------------------------------ 导入单步决定（--import-decisions） */

if (IMPORT_DIR) {
  console.log(`!!! ${DECISION_DISCLAIMER}`)
  console.log(`导入 ${IMPORT_DIR} 的单步决定（插件 ${INDEX}；split=${SPLIT}；不发任何模型请求）`)
  const before = dshFingerprint()
  const [mod] = await loadPluginInstances(INDEX, 1)
  // 存下被测插件的 schema：以后对这份导入结果 --rescore 时，字段约束要靠它判（否则全成「不适用」）
  let importSchemaProps = null
  try {
    const probe = makeScenarioHost(mod, { label: 'import-shape', userTexts: [] })
    importSchemaProps = slimProps(probe.tools.get('memory_remember')?.parameters?.properties ?? {})
    probe.cleanup()
  } catch (error) {
    console.error(`!!! ${error?.message ?? error}`)
    process.exit(1)
  }
  const rows = []
  for (const kase of selected) {
    const file = path.join(IMPORT_DIR, `${kase.id}.json`)
    let decision
    if (!existsSync(file)) decision = { ok: false, why: '缺答案文件' }
    else {
      try {
        decision = extractDecision(readFileSync(file, 'utf8'))
      } catch (error) {
        decision = { ok: false, why: `读不了答案文件：${error.message}` }
      }
    }
    if (!decision.ok) {
      rows.push({ ...newRow(kase, 1), mode: 'decision', status: 'invalid', error: decision.why })
      continue
    }
    rows.push(await importCase(mod, kase, decision.value))
  }
  const after = dshFingerprint()
  const summaries = printReport(rows, splitsOf(SPLIT))
  const unknown = rows.flatMap((row) => (row.unknownTools ?? []).map((name) => `${row.id}:${name}`))
  if (unknown.length > 0) console.log(`\n未知工具名（已跳过）：${unknown.join('，')}`)
  console.log(`\n隔离核对（真实 ~/.dsh，只比时间戳与目录名）：${isolationOkOf(before, after) ? '全部未变' : '!!! 有变化'}`)
  console.log(`\n!!! ${DECISION_DISCLAIMER}`)
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        meta: {
          mode: 'import-decisions',
          disclaimer: DECISION_DISCLAIMER,
          decisions: IMPORT_DIR,
          index: INDEX,
          rememberSchemaProps: importSchemaProps,
          split: SPLIT,
          only: ONLY,
          at: STAMP,
          requests: 0,
          isolation: { ok: isolationOkOf(before, after), before, after },
        },
        summaries,
        rows,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`\n明细已写入 ${OUT}`)
  process.exit(isolationOkOf(before, after) ? 0 : 1)
}

/* ------------------------------------------------------------ 主流程 */

// 续跑：文件里已经成功的运行不再跑
const tasks = []
for (const kase of selected) {
  for (let run = 1; run <= RUNS; run += 1) {
    if (RESUME && PRIOR.rows.some((row) => row.id === kase.id && row.run === run && row.status === 'ok')) continue
    tasks.push({ kase, run })
  }
}

const before = dshFingerprint()

console.log(`插件 ${INDEX}`)
console.log(`模型 ${MODEL} @ ${BASE}；temperature=${TEMPERATURE}；runs=${RUNS}；并发 ${CONCURRENCY}；最多 ${MAX_STEPS} 步`)
if (RESUME) {
  console.log(`续跑 ${RESUME}（split=${SPLIT}）：已完成 ${selected.length * RUNS - tasks.length}，本次补跑 ${tasks.length}`)
} else {
  console.log(`split=${SPLIT}：${selected.length} 个场景 × ${RUNS} = ${selected.length * RUNS} 次运行`)
}
if (MAX_REQUESTS < Infinity) console.log(`请求上限：${MAX_REQUESTS}`)

let shape = PRIOR?.meta?.rememberSchema ?? null
let promptStats = PRIOR?.meta?.promptStats ?? null
let schemaPropsMeta = PRIOR?.meta?.rememberSchemaProps ?? null
let instances = []

if (tasks.length > 0) {
  instances = await loadPluginInstances(INDEX, Math.min(CONCURRENCY, tasks.length))
  // 先空跑一次 apply：隔离核对不过就在发任何请求之前中止；顺带取 memory_remember 的字段概况
  try {
    const probe = makeScenarioHost(instances[0], { label: 'shape', userTexts: [] })
    const props = probe.tools.get('memory_remember')?.parameters?.properties ?? {}
    shape = {
      fields: Object.keys(props),
      typeEnum: props.type?.enum ?? null,
      scopeEnum: props.scope?.enum ?? null,
      loadEnum: props.load?.enum ?? null,
      sourceEnum: props.source?.enum ?? null,
      registrations: probe.promptRegistrations(),
    }
    schemaPropsMeta = slimProps(props)
    // 空库、无预取时的首轮提示词体量（U 类预置了一条记忆，会略大）
    const contextText = probe.pluginContextText()
    const toolChars = {}
    for (const name of ['memory_remember', 'memory_recall']) toolChars[name] = JSON.stringify(toOpenAiTool(probe.tools.get(name))).length
    for (const tool of GENERIC_TOOLS) toolChars[tool.name] = JSON.stringify(toOpenAiTool(tool)).length
    promptStats = {
      systemPromptChars: systemPromptOf(probe.pluginSectionText()).length,
      contextSnapshotChars: contextText ? wrapContext(contextText).length : 0,
      toolChars,
    }
    probe.cleanup()
  } catch (error) {
    console.error(`!!! ${scrub(error?.message ?? error)}`)
    process.exit(1)
  }
  console.log(`memory_remember 字段：${shape.fields.join(', ')}`)
  console.log(
    `提示词注册：section ${shape.registrations.sections.map((s) => s.name).join(', ') || '无'}；` +
      `context ${shape.registrations.contexts.map((s) => s.name).join(', ') || '无'}`,
  )
  console.log(
    `首轮提示词体量（空库）：system prompt ${promptStats.systemPromptChars} 字符；context 快照 ${promptStats.contextSnapshotChars} 字符；工具定义 ` +
      Object.entries(promptStats.toolChars)
        .map(([name, chars]) => `${name} ${chars}`)
        .join('、') +
      ' 字符',
  )
} else {
  console.log('没有需要跑的场景，只按当前规则重算并写回。')
}

const results = new Array(tasks.length)
let cursor = 0
let fatal = null
let doneCount = 0

async function worker(mod) {
  // 达到请求上限后不再领新场景（正在跑的那个会在下一次请求时记为请求失败）
  while (!fatal && !budgetHit) {
    const index = cursor
    cursor += 1
    if (index >= tasks.length) return
    const { kase, run } = tasks[index]
    try {
      results[index] = await runCase(mod, kase, run)
    } catch (error) {
      if (error instanceof FatalApiError || error?.fatal) {
        fatal = error
        results[index] = { id: kase.id, split: kase.split, run, status: 'error', error: scrub(error.message), rememberCalls: [] }
        return
      }
      results[index] = { id: kase.id, split: kase.split, run, status: 'error', error: scrub(`评测脚本异常：${error?.stack ?? error}`), rememberCalls: [] }
    }
    doneCount += 1
    process.stdout.write(`\r  进度 ${doneCount}/${tasks.length}`)
  }
}

await Promise.all(instances.map((mod) => worker(mod)))
if (tasks.length > 0) process.stdout.write('\n')

// 中止或到上限时没跑到的任务也要列出来（不计入分母）
for (let i = 0; i < tasks.length; i += 1) {
  if (!results[i]) {
    const { kase, run } = tasks[i]
    const why = fatal ? '未执行（评测已中止）' : '未执行（达到请求上限）'
    results[i] = { id: kase.id, split: kase.split, run, status: 'error', error: why, rememberCalls: [] }
  }
}

const after = dshFingerprint()
const isolation = {
  agentsUnchanged: before.agentsMtime === after.agentsMtime,
  projectsUnchanged: JSON.stringify(before.projects) === JSON.stringify(after.projects),
  globalMemoryUnchanged: before.globalMemoryExists === after.globalMemoryExists,
  agentsHistoryUnchanged: before.agentsHistoryMtime === after.agentsHistoryMtime,
  pluginHomeUnchanged: before.pluginHomeMtime === after.pluginHomeMtime,
  pluginHomeExists: after.pluginHomeMtime !== null,
  newProjects: after.projects.filter((name) => !before.projects.includes(name)),
}

// 续跑：按场景顺序合并——补跑的结果替换缺失 / 失败的那条，其余原样保留；范围外的旧行也保留
let rows = results
if (RESUME) {
  const fresh = new Map(tasks.map((task, i) => [`${task.kase.id}#${task.run}`, results[i]]))
  const merged = []
  const seen = new Set()
  for (const kase of selected) {
    for (let run = 1; run <= RUNS; run += 1) {
      const key = `${kase.id}#${run}`
      seen.add(key)
      const prior = PRIOR.rows.find((row) => row.id === kase.id && row.run === run)
      merged.push(fresh.get(key) ?? prior ?? { id: kase.id, split: kase.split, run, status: 'error', error: '缺失', rememberCalls: [] })
    }
  }
  for (const row of PRIOR.rows) if (!seen.has(`${row.id}#${row.run}`)) merged.push(row)
  rows = merged
  // 合并后的全集按当前规则重算一遍：文件里的旧行可能是按旧规则打的分
  rescoreRows(rows, schemaPropsMeta ?? propsFromShape(shape))
}

if (fatal) console.log(`\n!!! 评测中止：${scrub(fatal.message)}`)
if (budgetHit) console.log(`\n!!! 达到请求上限（--max-requests=${MAX_REQUESTS}）：没跑完的场景记为请求失败`)

const splits = splitsOf(SPLIT)
const summaries = printReport(rows, splits)

console.log(`\n本次实际发出的请求数：${requestCount}${MAX_REQUESTS < Infinity ? `（上限 ${MAX_REQUESTS}）` : ''}`)
console.log(
  `隔离核对（真实 ~/.dsh，只比时间戳与目录名）：AGENTS.md ${isolation.agentsUnchanged ? '未变' : '!!! 被改动'}；` +
    `projects/ ${isolation.projectsUnchanged ? '无新增目录' : `!!! 新增 ${isolation.newProjects.join(', ')}`}；` +
    `global-memory ${isolation.globalMemoryUnchanged ? '未变' : '!!! 有变化'}；AGENTS 历史目录 ${isolation.agentsHistoryUnchanged ? '未变' : '!!! 有变化'}；` +
    `dsh-workspace-memory/ ${isolation.pluginHomeUnchanged ? (isolation.pluginHomeExists ? '未变' : '不存在') : '!!! 有变化'}`,
)

const target = RESUME || OUT
if (RESUME) {
  const backup = `${RESUME.replace(/\.json$/i, '')}.before-resume-${STAMP}.json`
  copyFileSync(RESUME, backup)
  console.log(`原文件已备份为 ${backup}`)
}
const thisRun = {
  at: STAMP,
  ran: tasks.map((task) => `${task.kase.id}#${task.run}`),
  requests: requestCount,
  budgetHit,
  aborted: fatal ? scrub(fatal.message) : null,
}
writeFileSync(
  target,
  JSON.stringify(
    {
      meta: {
        ...(PRIOR?.meta ?? {}),
        index: INDEX,
        model: MODEL,
        base: BASE,
        split: SPLIT,
        only: ONLY,
        runs: RUNS,
        temperature: TEMPERATURE,
        maxSteps: MAX_STEPS,
        startedAt: PRIOR?.meta?.startedAt ?? STAMP,
        sendReasoningBack: sendReasoning,
        rememberSchema: shape,
        rememberSchemaProps: schemaPropsMeta,
        promptStats,
        aborted: fatal ? scrub(fatal.message) : null,
        budgetHit,
        requests: (PRIOR?.meta?.requests ?? 0) + requestCount,
        isolation,
        systemPromptBase: BASE_SYSTEM,
        ...(RESUME ? { resumes: [...(PRIOR.meta.resumes ?? []), { ...thisRun, previousAborted: PRIOR.meta.aborted ?? null }] } : {}),
      },
      summaries,
      rows,
    },
    null,
    2,
  ),
  'utf8',
)
console.log(`\n明细已写入 ${target}`)
process.exit(fatal ? 1 : 0)
