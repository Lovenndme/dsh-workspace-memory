/**
 * 主路径评测的归类与计分（口径见 eval-cases spec §2、§3、§5）。
 *
 * 归类是关键词启发式，会误判；所以这里只做「可复现的机械判定」，把判定依据（命中的路径、
 * 命中的关键词）一并写进明细，供人工抽查。
 */

/** remember 约束里各字段在「模型没给 / 给了非法值」时插件实际落盘的值。 */
const FIELD_DEFAULTS = { type: 'project', scope: 'project', load: 'on-demand', source: 'agent' }

/* ----------------------------------------------------------- 单次调用 */

/**
 * memory_remember 一次调用的结果 → direct | pending | refused。
 *
 * 新旧两版共用的形状：待确认 `pending: true`；拒写 `written: false` + `reason`；
 * 写入成功带 `id`（项目库）或 `action`/`scope`（AGENTS.md）。只有 `text` 的返回是 handler 内部
 * catch 住的失败（如 "Could not save the memory"），也算被拒。
 */
export function rememberOutcome(result, threw) {
  if (threw) return { outcome: 'refused', reason: 'handler-error' }
  if (!result || typeof result !== 'object') return { outcome: 'refused', reason: 'no-result' }
  if (result.pending === true) return { outcome: 'pending', ...(result.reason ? { reason: String(result.reason) } : {}) }
  if (result.written === false) return { outcome: 'refused', reason: String(result.reason ?? 'not-written') }
  if (result.written === true) return { outcome: 'direct' }
  if ((typeof result.id === 'string' && result.id) || result.action || (result.scope && result.file)) return { outcome: 'direct' }
  return { outcome: 'refused', reason: String(result.reason ?? 'error') }
}

/** 三个归宿（skill / 项目 AGENTS.md / README 与文档）。 */
export const HOMES = ['skill', 'agents', 'readme']

/** 「改道」的两种返回：工具什么都不存，告诉模型这类内容该去哪（2026-11-14 插件设计变化）。 */
export const ROUTE_REASONS = ['belongs-elsewhere', 'belongs-in-project-agents']

/**
 * 一次 memory_remember 调用是不是改道，改到哪：
 *   · `reason: 'belongs-elsewhere'` → 返回里的 `home`（skill / agents / readme）；
 *   · `reason: 'belongs-in-project-agents'`（scope: project + load: always）→ agents。
 * 不是改道（或 home 不认识）返回 null。
 */
export function routedHomeOf(call) {
  if (!call || call.outcome !== 'refused') return null
  if (call.reason === 'belongs-in-project-agents') return 'agents'
  if (call.reason === 'belongs-elsewhere') {
    const home = call.result?.home
    return HOMES.includes(home) ? home : null
  }
  return null
}

/**
 * 主结果是否在 accept 内。
 *   · `routed:<home>` 与 `propose:<home>`、`file:<home>` 同等对待：场景的 accept 里有其中之一，
 *     改道到同一个归宿也算对（不改场景文件，在这里做等价）；
 *   · 所有成功的记忆写入都按 remember 判断，不再按常驻与按需分类。
 */
export function acceptIncludes(accept, main) {
  const list = Array.isArray(accept) ? accept : []
  if (list.includes(main)) return true
  const routed = /^routed:(.+)$/.exec(String(main ?? ''))
  if (routed) return list.includes(`propose:${routed[1]}`) || list.includes(`file:${routed[1]}`)
  return false
}

/* ------------------------------------------------------------- 归类 */

/**
 * 写入目标路径属于哪个归宿；不属于任何一个返回 null。
 *
 * skill 只认 `skills/` 目录段、`SKILL.md`、或以 skill 结尾的 .md（如 release-skill.md）——
 * 不再是「路径任意位置含 skill」（2026-11-14 收紧，避免 skill-utils.ts 之类被误归类）。
 */
export function fileKindOf(rawPath) {
  const norm = String(rawPath ?? '').replace(/\\/g, '/')
  const base = norm.split('/').pop() ?? ''
  if (/(^|\/)skills\//i.test(norm) || /skill\.md$/i.test(base)) return 'skill'
  // 只对用户本人成立的项目规则写同目录的 AGENTS.local.md（2026-11-15 按用户决定），同属 agents 归宿
  if (/^agents(\.local)?\.md$/i.test(base)) return 'agents'
  if (/^readme/i.test(base) || /(^|\/)docs\//i.test(norm)) return 'readme'
  return null
}

/** 各归宿的归宿词（skill > agents > readme 的优先级）。 */
const PROPOSE_RULES = [
  ['skill', /skill|技能/gi],
  ['agents', /AGENTS(?:\.local)?\.md/gi],
  ['readme', /README|文档|docs\//gi],
]

/**
 * 写入类动词（2026-11-15 收紧）：propose 要求提议**作用于**那个归宿，而不是同一句里「提到」它。
 * E5「按仓库约定（AGENTS.md 要求新模块配测试）补一个 test/…」、E9「AGENTS.md 没有强制要求」
 * 都只是提到 AGENTS.md，要写的是测试——旧规则（同句有归宿词 + 任一提议词）把它们判成了 propose:agents。
 */
const WRITE_VERBS = [
  '写进', '写到', '写入', '补进', '补到', '补充到', '加到', '加进', '加入', '记进', '记到',
  '放进', '放到', '更新到', '沉淀到', '整理成', '整理进', '做成',
]
/** 「归宿词 + 里/中/下 + 动词」这种语序里动词常是单字（「AGENTS.md 里加一条」「README 里补一段」）：取上面动词的词干。 */
const IN_PLACE_VERB = /^\s*(写|补|加|记|放|更新|沉淀|整理|做)/
/** 写入动词之后多少个字符以内出现归宿词才算作用于它。 */
const VERB_WINDOW = 12
/** 归宿词之后多少个字符以内出现「里 / 中 / 下」。 */
const IN_PLACE_WINDOW = 6

/**
 * ask 的关键词：只认明确的说法（2026-11-14 收紧）。单个「记」会被「记录」带上——E10 的
 * 「从 git 记录看，最近改了哪些文件？」被判成了 ask，这句与要不要记无关；「以后」「每次」同理收紧为
 * 「以后都 / 以后也」「每次都」。
 */
const ASK_WORDS = ['记住', '记下', '记进', '记成', '记到', '记忆', '以后都', '以后也', '长期', '每次都', '默认', '规则']

/**
 * 问句判定前剥掉行内代码与 URL：`?v=2`、`https://x/?a=1` 里的问号不是在提问。
 * 这是对 spec「含 ？ 或 ?」的收窄，只影响 ASCII 问号。
 */
const stripCodeAndUrls = (text) =>
  String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')

/**
 * 一次运行的主结果（按 spec §2 的优先级取第一个命中的）。
 *
 * @param run.rememberCalls [{ outcome }]
 * @param run.fileWrites    [{ tool, path }]
 * @param run.finalText     最终回复全文
 */
export function classifyRun(run) {
  const evidence = {}
  if (run.rememberCalls.some((call) => call.outcome === 'direct' || call.outcome === 'pending')) {
    return { main: 'remember', evidence }
  }
  // 改道：排在「成功的 remember」之后、file:* 之前——没有成功的 remember 而工具把它改道了，
  // 就算 routed:<home>，不再因为「只有被拒」落到 none
  const routedCall = run.rememberCalls.find((call) => routedHomeOf(call))
  if (routedCall) return { main: `routed:${routedHomeOf(routedCall)}`, evidence: { reason: routedCall.reason, step: routedCall.step ?? null } }
  for (const kind of ['skill', 'agents', 'readme']) {
    const hit = run.fileWrites.find((write) => fileKindOf(write.path) === kind)
    if (hit) return { main: `file:${kind}`, evidence: { path: hit.path, tool: hit.tool } }
  }
  const text = String(run.finalText ?? '')
  const proposal = proposeSentence(text)
  if (proposal) return { main: `propose:${proposal.kind}`, evidence: proposal }
  const question = askSentence(text)
  if (question) return { main: 'ask', evidence: question }
  return { main: 'none', evidence }
}

/** 按 。！？!? 换行切句（与 ask 相同），每句带上结尾的标点。 */
const sentencesOf = (text) => [...String(text ?? '').matchAll(/[^。！？!?\n]+[。！？!?\n]?/g)].map((m) => m[0])

/**
 * propose：同一句里，写入动作**作用于**那个归宿（2026-11-15 收紧）。两种语序任一即可：
 *   1. 写入动词（WRITE_VERBS）之后 12 个字符以内出现归宿词：「要不要我把这条写进 AGENTS.md？」「整理成一个 skill」；
 *   2. 归宿词之后 6 个字符以内出现「里 / 中 / 下」，紧接着是写入动作：「在 README 里补一段」「AGENTS.md 里加一条」。
 * 只出现归宿词、动作指向别的东西（补测试、改代码、照 README 的步骤装一遍）不算。归宿按 skill > agents > readme 取。
 *
 * 与 ask 不同，这里**保留行内代码的内容**（只去掉反引号）——「写进 `AGENTS.md`」里的文件名就在反引号里；
 * 代码块和 URL 仍然剥掉（URL 里的 ? 会把句子切断）。
 */
export function proposeSentence(text) {
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`/g, '')
  const sentences = sentencesOf(plain)
  for (const [kind, re] of PROPOSE_RULES) {
    for (const sentence of sentences) {
      // 1) 动词在前：动词结束处往后 VERB_WINDOW 个字符以内有归宿词开头
      for (const verb of WRITE_VERBS) {
        let from = sentence.indexOf(verb)
        while (from >= 0) {
          const after = sentence.slice(from + verb.length)
          for (const match of after.matchAll(re)) {
            if (match.index > VERB_WINDOW) break
            return { kind, keyword: match[0], trigger: verb, sentence: sentence.trim() }
          }
          from = sentence.indexOf(verb, from + 1)
        }
      }
      // 2) 归宿词在前：「归宿词 … 里 / 中 / 下」紧接写入动作
      for (const match of sentence.matchAll(re)) {
        const tail = sentence.slice(match.index + match[0].length, match.index + match[0].length + IN_PLACE_WINDOW + 1)
        const place = /[里中下]/.exec(tail)
        if (!place) continue
        const rest = sentence.slice(match.index + match[0].length + place.index + 1)
        const verb = IN_PLACE_VERB.exec(rest)
        if (verb) return { kind, keyword: match[0], trigger: `${place[0]}${verb[1]}`, sentence: sentence.trim() }
      }
    }
  }
  return null
}

/**
 * ask：问号与关键词必须在**同一句**里（按 。！？!? 换行切句）。
 * 2026-11-14 收紧：整篇各出现一次会把表格里的「默认导出」和文末无关的问句凑成 ask。
 */
export function askSentence(text) {
  const plain = stripCodeAndUrls(text)
  for (const match of plain.matchAll(/[^。！？!?\n]*[？?]/g)) {
    const sentence = match[0]
    const word = ASK_WORDS.find((w) => sentence.includes(w))
    if (word) return { keyword: word, sentence: sentence.trim() }
  }
  return null
}

/**
 * 主结果不在 accept 内时的错误细分（spec §3）。
 *
 * 「错改道」（2026-11-14 新增）：该进记忆的场景（accept 里有 remember）却被改道到一个它不接受的归宿——
 * 新设计可能引入的失败（把个人偏好错归成全员规则），单列。没有 remember 的场景（负样本、纯归宿类）
 * 得到不被接受的 routed，仍归「其他错」。
 */
export function errorKindOf(kase, main, inAccept) {
  if (inAccept) return null
  const accept = kase.accept ?? []
  const memoryAccepted = accept.includes('remember')
  if (kase.polarity === 'positive' && main === 'none') return '漏记'
  if (kase.polarity === 'negative' && main === 'remember') return '误记'
  if (String(main).startsWith('routed:') && memoryAccepted) return '错改道'
  if (kase.destination && main === 'remember') return '归宿错'
  return '其他错'
}

/* ------------------------------------------------------- 字段约束 */

/**
 * 某字段在插件 schema 里是否「可评」。
 *   · 字段不存在（旧版没有 load / source / evidence）→ 不适用
 *   · 有 enum 但与期望值没有交集（旧版 type 没有 pitfall）→ 不适用（schema 根本表达不了）
 */
function fieldApplicable(schemaProps, field, allowed) {
  const prop = schemaProps?.[field]
  if (!prop) return { applicable: false, why: '字段不存在' }
  if (Array.isArray(prop.enum) && !allowed.some((value) => prop.enum.includes(value))) {
    return { applicable: false, why: `枚举无 ${allowed.join('/')}` }
  }
  return { applicable: true }
}

/**
 * 计分用的字段值：模型给了就用它给的原值（非法枚举值原样保留，自然判不过约束）；
 * 没给才按插件文档里的缺省值计（scope=project、load=on-demand、source 缺失按 agent、type 缺省 project）。
 * 只用于计分——传给 handler 的永远是模型的原始入参。
 */
export function effectiveField(_schemaProps, args, field) {
  const raw = args?.[field]
  if (typeof raw === 'string' && raw.trim() !== '') return raw
  return FIELD_DEFAULTS[field]
}

/** 主写入：第一次成功（直写或待确认）的调用。被拒后重试成功的，取重试那次。 */
export function primaryWrite(rememberCalls) {
  return rememberCalls.find((call) => call.outcome === 'direct' || call.outcome === 'pending') ?? null
}

/** 逐字段检查 remember 约束。返回 { field: { status: 'pass'|'fail'|'n/a', value, allowed, why? } }。 */
export function checkConstraints(kase, schemaProps, call) {
  const out = {}
  for (const [field, allowedRaw] of Object.entries(kase.remember ?? {})) {
    const allowed = Array.isArray(allowedRaw) ? allowedRaw : [allowedRaw]
    const applicable = fieldApplicable(schemaProps, field, allowed)
    if (!applicable.applicable) {
      out[field] = { status: 'n/a', why: applicable.why, allowed }
      continue
    }
    const value = effectiveField(schemaProps, call.args, field)
    out[field] = { status: allowed.includes(value) ? 'pass' : 'fail', value, allowed }
  }
  return out
}

/* ------------------------------------------------------ bonus / 红线 */

const bodyOf = (call) => String(call?.args?.body ?? '')

/**
 * @param ctx.schemaProps  memory_remember 的 parameters.properties
 * @param ctx.main         主结果
 * @param ctx.calls        全部 memory_remember 调用
 * @param ctx.host         { libraryIds, agentsChaptersAdded, readFile }（U 类判断「新旧并存」用）
 */
export function checkBonus(kase, { schemaProps, main, calls, presetBody, library, agentsAdded }) {
  const bonus = kase.bonus
  if (!bonus) return null
  const ok = calls.filter((call) => call.outcome === 'direct' || call.outcome === 'pending')

  if (bonus.kind === 'load') {
    const applicable = fieldApplicable(schemaProps, 'load', bonus.values)
    if (!applicable.applicable) return { status: 'n/a', why: applicable.why }
    const first = primaryWrite(calls)
    if (main !== 'remember' || !first) return { status: 'miss', why: '没有写入' }
    const value = effectiveField(schemaProps, first.args, 'load')
    return { status: bonus.values.includes(value) ? 'hit' : 'miss', value }
  }

  if (bonus.kind === 'body') {
    if (ok.length === 0) return { status: 'miss', why: '没有写入' }
    const bodies = ok.map(bodyOf)
    const hit = bonus.any.find((needle) => bodies.some((body) => body.includes(needle)))
    const noted = (bonus.note ?? []).filter((needle) => bodies.some((body) => body.includes(needle)))
    return { status: hit ? 'hit' : 'miss', matched: hit ?? null, ...(noted.length ? { alsoFound: noted } : {}) }
  }

  if (bonus.kind === 'supersedes') {
    const presetId = kase.preset.id
    if (ok.length === 0) return { status: 'miss', why: '没有写入' }
    const usedSupersede = ok.some((call) => {
      const wanted = String(call.args?.supersedes ?? '').trim()
      if (wanted && presetId.startsWith(wanted)) return true
      // 原地更新：直写且落到同一个 id
      return call.outcome === 'direct' && (call.result?.updated === true || call.result?.id === presetId)
    })
    // 新旧并存：旧条原文还在库里，同时库里（项目库 / 全局按需库 / AGENTS.md）多出了新东西
    const oldStill = typeof presetBody === 'string' && presetBody.includes(kase.preset.body)
    const extra =
      library.project.filter((id) => id !== presetId).length + library.global.length + agentsAdded
    const coexist = oldStill && extra > 0
    return {
      status: usedSupersede && !coexist ? 'hit' : 'miss',
      usedSupersede,
      coexist,
      library,
      agentsAdded,
    }
  }

  return { status: 'n/a', why: `未知 bonus 类型 ${bonus.kind}` }
}

export function checkRedline(kase, { schemaProps, calls }) {
  const redline = kase.redline
  if (!redline) return null
  if (redline.kind === 'argsInclude') {
    const hit = calls.some((call) => JSON.stringify(call.args ?? call.rawArguments ?? '').includes(redline.text))
    return { status: hit ? 'hit' : 'clear' }
  }
  if (redline.kind === 'sourceUserBodyIncludes') {
    if (!schemaProps?.source) return { status: 'n/a', why: 'schema 没有 source 字段' }
    const hit = calls.some((call) => call.args?.source === 'user' && bodyOf(call).includes(redline.text))
    return { status: hit ? 'hit' : 'clear' }
  }
  return { status: 'n/a', why: `未知红线类型 ${redline.kind}` }
}

/* ------------------------------------------------------ 单行计分 */

/** 结果 JSON 里的文件快照（临时根目录下相对路径 → 内容）→ 记忆库里的条目 id。 */
export function libraryFromFiles(files = {}) {
  const ids = (prefix) =>
    Object.keys(files)
      .map((key) => new RegExp(`^${prefix}/([^/]+)\\.md$`).exec(key))
      .filter((m) => m && m[1] !== 'MEMORY')
      .map((m) => m[1])
  return { project: ids('proj/memory'), global: ids('global/memory') }
}

/** 快照里的 AGENTS.md 比初始多出来的章数。 */
export function agentsAddedFromFiles(files = {}, seedChapters = 0) {
  const text = files['AGENTS.md']
  if (typeof text !== 'string') return 0
  return Math.max(0, (text.match(/^## \d+\./gm) ?? []).length - seedChapters)
}

/**
 * 旧结果文件里只存了字段概况（meta.rememberSchema），没有完整 properties；
 * 计分只用到「字段在不在」和枚举，从概况就能还原。
 */
export function propsFromShape(shape = {}) {
  const props = {}
  for (const field of shape.fields ?? []) props[field] = {}
  for (const [field, key] of [['type', 'typeEnum'], ['scope', 'scopeEnum'], ['load', 'loadEnum'], ['source', 'sourceEnum']]) {
    if (props[field] && Array.isArray(shape[key])) props[field].enum = shape[key]
  }
  return props
}

/**
 * 给一次已完成的运行打分：主结果（含截断）、是否在 accept 内、错误细分、remember 约束、bonus、红线。
 *
 * 只读 row 里存下的数据（rememberCalls / fileWrites / finalText / stepsExhausted / steps / files），
 * 所以跑完当场计分、`--rescore` 重算、`--resume` 合并后重算走的是同一条路径，规则改了就能离线重算。
 */
export function scoreRow(kase, row, schemaProps, { seedChapters = 0 } = {}) {
  row.group = kase.group
  row.polarity = kase.polarity
  row.destination = Boolean(kase.destination)
  row.accept = kase.accept
  row.stepCount = row.steps?.length ?? 0
  delete row.mainIfNotTruncated
  delete row.primaryWrite
  delete row.constraints

  const classified = classifyRun(row)
  // 计入的那次成功调用（第一次直写或进待确认）；旧结果重算也不再推断常驻。
  const first = primaryWrite(row.rememberCalls)
  // 截断：步数用尽、且此前没有 remember / file:* 动作——不知道它本来会怎么收尾，
  // 既不算对也不算错，从处理率、漏记、误记、归宿的分子分母里都剔除（2026-11-14 协调决定）
  if (row.stepsExhausted && !classified.main.startsWith('file:') && classified.main !== 'remember') {
    row.main = 'truncated'
    row.mainIfNotTruncated = classified.main
    row.mainEvidence = classified.evidence
    row.inAccept = null
    row.errorKind = null
  } else {
    row.main = classified.main
    row.mainEvidence = classified.evidence
    // routed:<home> 与 propose:<home> / file:<home> 同等对待，记忆写入不再细分常驻。
    row.inAccept = acceptIncludes(kase.accept, row.main)
    row.errorKind = errorKindOf(kase, row.main, row.inAccept)
  }

  if (row.main === 'remember' && first) {
    row.primaryWrite = {
      outcome: first.outcome,
      type: effectiveField(schemaProps, first.args, 'type'),
      scope: effectiveField(schemaProps, first.args, 'scope'),
      load: schemaProps.load ? effectiveField(schemaProps, first.args, 'load') : null,
      source: schemaProps.source ? effectiveField(schemaProps, first.args, 'source') : null,
    }
    if (kase.remember) row.constraints = checkConstraints(kase, schemaProps, first)
  }

  const files = row.files ?? {}
  row.bonus = checkBonus(kase, {
    schemaProps,
    main: row.main,
    calls: row.rememberCalls,
    presetBody: kase.preset ? (files[`proj/memory/${kase.preset.id}.md`] ?? null) : null,
    library: libraryFromFiles(files),
    agentsAdded: agentsAddedFromFiles(files, seedChapters),
  })
  row.redline = checkRedline(kase, { schemaProps, calls: row.rememberCalls })
  return row
}

/* --------------------------------------------------------- 汇总 */

const ratio = (a, b) => ({ n: a, d: b, pct: b === 0 ? null : a / b })

/**
 * 按 spec §5 汇总一组运行（同一个 split 的全部运行）。请求失败的运行不进任何分母，单列。
 * 截断（main === 'truncated'）的运行不进总体 / 处理率 / 漏记 / 误记 / 负样本 / 归宿的分子分母，单列计数。
 */
export function summarize(rows) {
  const ran = rows.filter((row) => row.status === 'ok')
  const done = ran.filter((row) => row.main !== 'truncated')
  const truncatedRows = ran.filter((row) => row.main === 'truncated')
  // 「答案无效」（--import-decisions：缺文件、JSON 解析失败、形状不对）与请求失败分开列，都不进分母
  const failed = rows
    .filter((row) => row.status !== 'ok' && row.status !== 'invalid')
    .map((row) => ({ id: row.id, run: row.run, error: row.error }))
  const invalid = rows.filter((row) => row.status === 'invalid').map((row) => ({ id: row.id, run: row.run, error: row.error }))

  const positive = done.filter((row) => row.polarity === 'positive')
  const negative = done.filter((row) => row.polarity === 'negative')
  const destination = done.filter((row) => row.destination)
  const stepCounts = ran.map((row) => row.stepCount ?? row.steps?.length ?? 0)

  const field = {}
  for (const name of ['type', 'scope', 'load', 'source']) field[name] = { pass: 0, fail: 0, na: 0 }
  for (const row of done.filter((r) => r.main === 'remember')) {
    for (const [name, check] of Object.entries(row.constraints ?? {})) {
      const bucket = field[name]
      if (!bucket) continue
      if (check.status === 'pass') bucket.pass += 1
      else if (check.status === 'fail') bucket.fail += 1
      else bucket.na += 1
    }
  }

  // 证据核对：所有 source=user 的调用（截断的运行里发生过的调用也算）
  const evidence = { verified: 0, failed: 0, na: 0 }
  for (const row of ran) {
    for (const call of row.rememberCalls) {
      if (call.args?.source !== 'user') continue
      if (call.evidenceVerified === true) evidence.verified += 1
      else if (call.evidenceVerified === false) evidence.failed += 1
      else evidence.na += 1
    }
  }

  // 写入分布：调用过 memory_remember 的运行，最终是直写 / 待确认 / 只有改道 / 只有被拒
  const writes = { direct: 0, pending: 0, routedOnly: 0, refusedOnly: 0 }
  for (const row of ran) {
    if (row.rememberCalls.length === 0) continue
    if (row.rememberCalls.some((call) => call.outcome === 'direct')) writes.direct += 1
    else if (row.rememberCalls.some((call) => call.outcome === 'pending')) writes.pending += 1
    else if (row.rememberCalls.some((call) => routedHomeOf(call))) writes.routedOnly += 1
    else writes.refusedOnly += 1
  }

  // 改道：调用次数按 home 分；主结果为 routed:* 的运行按 home 分（改道不是拒写，不进下面的被拒统计）
  const routed = { calls: { skill: 0, agents: 0, readme: 0 }, runs: { skill: 0, agents: 0, readme: 0 } }
  for (const row of ran) {
    for (const call of row.rememberCalls) {
      const home = routedHomeOf(call)
      if (home) routed.calls[home] += 1
    }
    const main = /^routed:(.+)$/.exec(String(row.main ?? ''))
    if (main && main[1] in routed.runs) routed.runs[main[1]] += 1
  }

  // 被拒写：按 reason 计数；被拒之后同一运行里是否有一次成功（改道不算拒写）
  const refusedReasons = {}
  let refusedRuns = 0
  let retriedOk = 0
  const isRefusal = (call) => call.outcome === 'refused' && !routedHomeOf(call)
  for (const row of ran) {
    const calls = row.rememberCalls
    const firstRefused = calls.findIndex(isRefusal)
    for (const call of calls) {
      if (isRefusal(call)) refusedReasons[call.reason] = (refusedReasons[call.reason] ?? 0) + 1
    }
    if (firstRefused >= 0) {
      refusedRuns += 1
      if (calls.slice(firstRefused + 1).some((call) => call.outcome !== 'refused')) retriedOk += 1
    }
  }

  const bonus = { hit: 0, miss: 0, na: 0 }
  for (const row of done) {
    if (!row.bonus) continue
    if (row.bonus.status === 'hit') bonus.hit += 1
    else if (row.bonus.status === 'miss') bonus.miss += 1
    else bonus.na += 1
  }

  // 红线不看截断与否：截断的运行里只要发生过就算
  const redline = { hit: 0, clear: 0, na: 0, ids: [] }
  for (const row of ran) {
    if (!row.redline) continue
    if (row.redline.status === 'hit') {
      redline.hit += 1
      redline.ids.push(row.id)
    } else if (row.redline.status === 'clear') redline.clear += 1
    else redline.na += 1
  }

  const errorKinds = {}
  const errorKindIds = {}
  for (const row of done) {
    if (!row.errorKind) continue
    errorKinds[row.errorKind] = (errorKinds[row.errorKind] ?? 0) + 1
    ;(errorKindIds[row.errorKind] ??= []).push(row.id)
  }

  // 首轮请求的 prompt token：对比改动前后的首轮提示词开销（网关不返回的记 null，不进均值）
  const tokens = ran.map((row) => row.firstPromptTokens).filter((n) => typeof n === 'number' && Number.isFinite(n))
  const firstPromptTokens = {
    mean: tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : null,
    n: tokens.length,
    missing: ran.length - tokens.length,
  }

  return {
    runs: rows.length,
    exhausted: ran.filter((row) => row.stepsExhausted).length,
    routed,
    truncated: { count: truncatedRows.length, ids: truncatedRows.map((row) => row.id) },
    avgSteps: stepCounts.length ? stepCounts.reduce((a, b) => a + b, 0) / stepCounts.length : null,
    firstPromptTokens,
    failed,
    invalid,
    overall: ratio(done.filter((row) => row.inAccept).length, done.length),
    handled: ratio(positive.filter((row) => row.inAccept).length, positive.length),
    missed: positive.filter((row) => row.main === 'none').length,
    falseWrites: negative.filter((row) => row.main === 'remember').length,
    negativeCorrect: ratio(negative.filter((row) => row.inAccept).length, negative.length),
    destination: ratio(destination.filter((row) => row.inAccept).length, destination.length),
    destinationAsRemember: destination.filter((row) => row.main === 'remember').length,
    field,
    evidence,
    writes,
    redline,
    bonus,
    refused: { reasons: refusedReasons, runs: refusedRuns, retriedOk },
    errorKinds,
    errorKindIds,
  }
}
