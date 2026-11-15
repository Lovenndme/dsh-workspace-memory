/**
 * 证据核对容忍抄写出入（2026-11-14 第四轮，设计说明 §9.3）。
 *
 * 评测里模型抄用户原话时漏了一个字（「不用每步问我」对「不用每步都问我」），核对不过、白进了一次待确认。
 * 核对的目的是确认「这句话出自用户」，不是逐字校对。两步，任一通过即算通过：
 *   1. 精确：归一化时再去掉标点与符号（\p{P}、\p{S}）；省略号切段在去标点之前；
 *   2. 近似：归一化后 ≥ 10 字的段，允许与同一条消息里某个**连续片段**有 ≤ floor(长度/10) 的编辑距离
 *      （Sellers 近似子串匹配）；更短的段只走精确；多段按顺序，近似段的落点取匹配片段的结束位置；
 *      每条消息只看前 20000 字符（精确不受限）。
 * 返回值：通过时带 match: 'exact' | 'approx'，未通过时不带。
 *
 * 两条反例最要紧：分散在长消息各处的字符拼不出通过；长度 < 10 时差一个字不通过。
 * 两条取数路径（pre-step 缓存与快照回落）都走同一个 verifyEvidence，末尾各验一次。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeReporter, realFilesGuard, userEvent } from './fake-host.mjs'

const mod = await import('../index.js')
const { verifyEvidence, approxMatchEnd } = mod
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()

const result = (texts, evidence) => verifyEvidence(texts, evidence)
const matchOf = (texts, evidence) => {
  const res = result(texts, evidence)
  return res.verified ? res.match : 'none'
}

const SAID = '这个项目以后不用每步都问我，直接做完再汇报就行。'
// 归一化后：这个项目以后不用每步都问我直接做完再汇报就行（去掉了逗号和句号）

section('常量')
{
  check('近似匹配的最短段长是 10', mod.EVIDENCE_APPROX_MIN_LENGTH === 10)
  check('近似匹配只看每条消息前 20000 字符', mod.EVIDENCE_APPROX_MAX_CHARS === 20000)
}

section('长度 ≥ 10：漏一个字 / 多一个字 / 错一个字通过（approx）')
{
  // 「以后不用每步都问我直接做完再汇报」16 字 → 允许 1 处编辑
  check('原样 → exact', matchOf([SAID], '以后不用每步都问我直接做完再汇报') === 'exact')
  check('漏一个字（评测里的真实情形：漏了「都」）→ approx', matchOf([SAID], '以后不用每步问我，直接做完再汇报') === 'approx')
  check('多一个字 → approx', matchOf([SAID], '以后不用每步都都问我直接做完再汇报') === 'approx')
  check('错一个字 → approx', matchOf([SAID], '以后不用每步都问你直接做完再汇报') === 'approx')
  check('英文同样适用：漏一个字母', matchOf(['Please run the full test suite before you push.'], 'run the ful test suite before you push') === 'approx')
  check('错两个字（超过 floor(16/10)=1）→ 不通过', matchOf([SAID], '以后不用每步都问你直接做好再汇报') === 'none')
  // 20 字起允许 2 处
  const long = '以后不用每步都问我直接做完再汇报就行谢谢'
  check('20 字的段允许 2 处出入', matchOf([`${long}。`], '以后不用每步问我直接做完再汇报就行谢') === 'approx')
}

section('长度 < 10：只走精确，差一个字不通过')
{
  check('「不用每步问我」（6 字）对「不用每步都问我」→ 不通过', matchOf([SAID], '不用每步问我') === 'none')
  check('「不用每步都问我」原样 → exact', matchOf([SAID], '不用每步都问我') === 'exact')
  check('9 字的段错一个字 → 不通过', Array.from('以后不用每步都问你').length === 9 && matchOf([SAID], '以后不用每步都问你') === 'none')
  check('10 字的段错一个字 → approx（恰好到门槛）', Array.from('以后不用每步都问你直').length === 10 && matchOf([SAID], '以后不用每步都问你直') === 'approx')
}

section('标点、全半角、空白差异通过（exact）')
{
  check('标点换了（逗号→句号、加感叹号）', matchOf([SAID], '以后不用每步都问我。直接做完再汇报！') === 'exact')
  check('去掉了全部标点', matchOf([SAID], '这个项目以后不用每步都问我直接做完再汇报就行') === 'exact')
  check('多了空格与换行', matchOf([SAID], '以后 不用每步\n都问我') === 'exact')
  check('全角英文 / 半角标点', matchOf(['Run the FULL test suite, please.'], 'run the ＦＵＬＬ test suite please') === 'exact')
  check('首尾带引号（引号也是标点）', matchOf([SAID], '「以后不用每步都问我」') === 'exact' && matchOf([SAID], '"直接做完再汇报"') === 'exact')
  check('符号类字符（\\p{S}）也不算：~ + = 之类', matchOf(['发布只走 CI + 每 4 小时一批'], '发布只走CI每4小时一批') === 'exact')
}

section('不相干、乱序、跨消息、拼凑：不通过')
{
  check('两句不相干的话', matchOf([SAID], '请把数据库迁移脚本写成可回滚的') === 'none')
  // 证据的每个字都在长消息里出现过，但散落各处、互不相连
  const evidence = '以后不用每步都问我直接做完再汇报'
  const scattered = Array.from(evidence).map((ch, i) => `${ch}${'无关的填充文字'.repeat(1 + (i % 3))}`).join('')
  check('分散在长消息各处的字符拼不出通过', matchOf([scattered], evidence) === 'none')
  const interleaved = Array.from(evidence).join('啊')
  check('  …每两个字之间只插一个字也拼不出（编辑距离远超 1）', matchOf([interleaved], evidence) === 'none')
  const both = `${'前面一大段无关的话。'.repeat(50)}${interleaved}${'后面又是一大段。'.repeat(50)}`
  check('  …放进长消息里同样不通过', matchOf([both], evidence) === 'none')

  const said2 = '直接做完再汇报不要中途停下来问我。以后测试都用中文写断言说明。'
  check('多段按顺序 → exact', matchOf([said2], '直接做完再汇报不要中途停下…以后测试都用中文写断言说明') === 'exact')
  // 漏的字在段中间（漏在段尾仍是子串，那是精确通过）
  check('多段按顺序、其中一段中间漏一个字 → approx', matchOf([said2], '直接做完再汇报不要中停下…以后测试都用中文写断言说明') === 'approx')
  check('多段乱序 → 不通过', matchOf([said2], '以后测试都用中文写断言说明…直接做完再汇报不要中途停下') === 'none')
  check('多段乱序、带一个字的出入 → 仍不通过', matchOf([said2], '以后测试都用中文写断言…直接做完再汇报不要中途停下') === 'none')

  check('一句话拆在两条消息里 → 不通过', matchOf(['以后不用每步都问', '我直接做完再汇报'], '以后不用每步都问我直接做完再汇报') === 'none')
  check('两段分别在两条消息里 → 不通过', matchOf(['直接做完再汇报不要中途停下来', '以后测试都用中文写断言说明'], '直接做完再汇报不要中途停下…以后测试都用中文写断言说明') === 'none')
  check('同样的两段在一条消息里 → 通过', matchOf(['直接做完再汇报不要中途停下来，以后测试都用中文写断言说明'], '直接做完再汇报不要中途停下…以后测试都用中文写断言说明') === 'exact')
}

section('省略号切段在去标点之前；过短仍不通过')
{
  check('「…」切段后两段都 ≥ 2 字', matchOf([SAID], '以后不用…直接做完') === 'exact')
  check('省略号切出 1 个字的段 → 不通过', matchOf([SAID], '我…直接做完再汇报') === 'none')
  check('只剩标点 → 不通过', matchOf([SAID], '！？。，') === 'none' && matchOf([SAID], '……') === 'none')
  check('去标点后不足 4 字 → 不通过', matchOf(['OK!!! 好的'], 'OK!!!') === 'none')
}

section('20000 字符上限：只限近似，精确不受限')
{
  const filler = '这是一段很长的无关前文用来把关键句推到两万字之后。'.repeat(900) // > 20000 字符
  const deep = `${filler}${SAID}`
  check('前文超过 20000 字符', filler.length > mod.EVIDENCE_APPROX_MAX_CHARS, String(filler.length))
  check('关键句在 20000 字符之后：原样仍能精确通过', matchOf([deep], '以后不用每步都问我直接做完再汇报') === 'exact')
  check('  …但漏一个字时不做近似（超出部分不参与近似）', matchOf([deep], '以后不用每步问我直接做完再汇报') === 'none')
  check('  …同一句放在前面就能近似通过', matchOf([`${SAID}${filler}`], '以后不用每步问我直接做完再汇报') === 'approx')
}

section('返回值形状')
{
  check('精确通过：{ verified: true, match: "exact" }', JSON.stringify(result([SAID], '不用每步都问我')) === '{"verified":true,"match":"exact"}')
  check('近似通过：{ verified: true, match: "approx" }', JSON.stringify(result([SAID], '以后不用每步问我直接做完再汇报')) === '{"verified":true,"match":"approx"}')
  check('未通过：只有 { verified: false }', JSON.stringify(result([SAID], '不用每步问我')) === '{"verified":false}')
}

section('approxMatchEnd：与朴素的全量 DP 逐一对照（随机串）')
{
  // 朴素做法：对每个结束位置 j，算 pattern 与「以 j 结尾的任意片段」的最小编辑距离（Sellers 的定义）
  const naiveEnd = (p, t, k, from) => {
    const m = p.length
    let prev = Array.from({ length: m + 1 }, (_, i) => i)
    for (let j = from; j < t.length; j += 1) {
      const cur = [0]
      for (let i = 1; i <= m; i += 1) cur[i] = Math.min(prev[i - 1] + (p[i - 1] === t[j] ? 0 : 1), prev[i] + 1, cur[i - 1] + 1)
      if (cur[m] <= k) return j + 1
      prev = cur
    }
    return -1
  }
  let seed = 12345
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  let mismatches = 0
  let runs = 0
  for (let trial = 0; trial < 3000; trial += 1) {
    const alphabet = 2 + rand(3)
    const m = 1 + rand(14)
    const n = rand(40)
    const p = Array.from({ length: m }, () => rand(alphabet))
    const t = Array.from({ length: n }, () => rand(alphabet))
    const k = rand(Math.max(1, Math.ceil(m / 2)))
    const from = n > 0 ? rand(n) : 0
    const expected = k >= m ? from : naiveEnd(p, t, k, from)
    const actual = approxMatchEnd(p, t, k, from)
    runs += 1
    if (expected !== actual) {
      mismatches += 1
      if (mismatches <= 3) console.log(`        p=${p.join('')} t=${t.join('')} k=${k} from=${from} expected=${expected} actual=${actual}`)
    }
  }
  check(`3000 组随机串与朴素 DP 结果一致（最早的结束位置）`, mismatches === 0, `${mismatches}/${runs} 不一致`)
}

section('性能：一条 20000 字符的消息')
{
  const big = Array.from({ length: 20000 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7919) % 3000))).join('')
  const evidence30 = '以后不用每步都问我直接做完再汇报就行谢谢你们大家的配合与支持啊'
  const evidence300 = evidence30.repeat(10)
  const time = (fn) => {
    const started = process.hrtime.bigint()
    fn()
    return Number(process.hrtime.bigint() - started) / 1e6
  }
  const t30 = time(() => verifyEvidence([big], evidence30))
  const t300 = time(() => verifyEvidence([big], evidence300))
  const t200msgs = time(() => verifyEvidence(Array.from({ length: 200 }, () => big), evidence30))
  console.log(`        30 字证据 × 1 条 20000 字消息：${t30.toFixed(1)} ms；300 字证据：${t300.toFixed(1)} ms；30 字证据 × 200 条：${t200msgs.toFixed(0)} ms`)
  check('30 字证据、一条 20000 字消息、不命中：远低于 1 秒', t30 < 1000, `${t30} ms`)
}

section('两条取数路径都用近似核对：pre-step 缓存与快照回落')
{
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-approx-'))
  const workspace = path.join(root, 'ws')
  const memoryDir = path.join(root, 'proj', 'memory')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  const listeners = new Map()
  const tools = new Map()
  const events = []
  const agent = { id: 'agent-approx' }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(name, handler) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler])
      return () => {}
    },
    commands: { register: () => () => {} },
    tools: { register: (def) => (tools.set(def.name, def), () => {}) },
    systemPrompt: { context: () => () => {}, section: () => () => {} },
    webServer: { register: () => () => {} },
    agents: { currentInitiator: () => agent },
    sessions: { get: (id) => ({ id, snapshotEvents: () => events }) },
    workingDirectory: { get: () => workspace },
    get: () => undefined,
  }
  try {
    mod.apply(ctx, { agentsFile: path.join(root, 'AGENTS.md'), memoryDir, globalMemoryDir: path.join(root, 'global', 'memory'), agentWrites: 'review', duplicateCheck: false })
    const remember = (args) => tools.get('memory_remember').execute({ type: 'feedback', source: 'user', ...args }, { agent })
    const status = async () => (await tools.get('memory_status').execute({}, { agent })).evidenceSource

    await listeners.get('agent/pre-step')[0]({ agent, messages: [userEvent(SAID).data], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
    const fromCache = await remember({ slug: 'no-step-asks', description: '不用每步都问，直接做完再汇报', title: 'No step asks', body: '不用每步都问。', evidence: '以后不用每步问我，直接做完再汇报' })
    check('pre-step 缓存：漏一个字的证据 → 直写', typeof fromCache.id === 'string' && fromCache.pending !== true, JSON.stringify(fromCache))
    check('  …走的是缓存', (await status()) === 'prestep-cache')

    events.push(userEvent('提交信息一律用中文写，标题不超过五十个字。'))
    const fromSnapshot = await remember({ slug: 'zh-commits', description: '提交信息一律用中文写', title: 'Chinese commits', body: '提交信息用中文。', evidence: '提交信息一律用中文写标题不超过五十字' })
    check('快照回落：漏一个字的证据 → 直写', typeof fromSnapshot.id === 'string' && fromSnapshot.pending !== true, JSON.stringify(fromSnapshot))
    check('  …走的是快照回落', (await status()) === 'snapshot-fallback')

    const short = await remember({ slug: 'short-slip', description: '不用每步都问', title: 'Short slip', body: 'x', evidence: '不用每步问我' })
    check('短证据差一个字 → 仍进待确认（evidence-not-found）', short.pending === true && short.reason === 'evidence-not-found', JSON.stringify(short))
  } finally {
    rmSync(root, { recursive: true, force: true })
    mod.configure(undefined)
  }
}

section('真实文件未被本次测试改动')
check('真实 AGENTS.md 与全局按需库的存在性与哈希不变', guard.unchanged())

summary()
