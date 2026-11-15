/**
 * 召回结果带上「写于何时」（2026-11-14 第三轮）。
 *
 * 系统提示段已经告诉模型「记忆写的是当时的情况，照着做之前先确认还在」；没有日期它无从判断。
 *   · 每条结果带 `updated`（ISO 日期，取 frontmatter 的 modified，没有就取 created）与 `ageDays`（整数）；
 *   · 渲染文字里标题行后加一段 `updated 2026-11-05, 9 days ago`，超过 30 天再加 `verify before relying on it`；
 *   · 「现在」经 setClockForTests 注入，测试不依赖真实日期。
 *
 * 记忆文件手写进临时目录（frontmatter 里的日期由测试决定）；结束时比对真实文件的哈希。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import path from 'node:path'
import { makeHost, makeReporter, realFilesGuard, schemaProblems } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()

const NOW = Date.parse('2026-11-14T03:00:00.000Z')

/** 手写一条记忆文件（日期字段可省略，模拟手改过的文件）。 */
const memoryFile = ({ id, title, body, type = 'feedback', created, modified }) =>
  [
    '---',
    `name: ${id}`,
    `description: ${title}`,
    `type: ${type}`,
    `title: ${title}`,
    ...(created ? [`created: ${created}`] : []),
    ...(modified ? [`modified: ${modified}`] : []),
    '---',
    '',
    body,
    '',
  ].join('\n')

section('memoryAge：取 modified，没有就取 created；按 UTC 日历日算天数')
{
  const age = (meta, now = NOW) => mod.memoryAge(meta, now)
  check('modified 在 → 用它', JSON.stringify(age({ modified: '2026-11-05T08:00:00.000Z', created: '2026-01-01T00:00:00.000Z' })) === '{"updated":"2026-11-05","ageDays":9}', JSON.stringify(age({ modified: '2026-11-05T08:00:00.000Z' })))
  check('没有 modified → 用 created', JSON.stringify(age({ created: '2026-10-01T00:00:00.000Z' })) === '{"updated":"2026-10-01","ageDays":44}')
  check('modified 解析不了 → 用 created', age({ modified: 'yesterday', created: '2026-11-04T00:00:00.000Z' }).updated === '2026-11-04')
  check('只写了日期（手改文件常见）也认', JSON.stringify(age({ modified: '2026-11-05' })) === '{"updated":"2026-11-05","ageDays":9}')
  check('两个都没有 / 都解析不了 → {}（返回值里不出现 undefined）', JSON.stringify(age({})) === '{}' && JSON.stringify(age({ modified: '', created: 'n/a' })) === '{}' && JSON.stringify(age(undefined)) === '{}')
  check('数值溢出的日期 → {}（不抛 RangeError）', JSON.stringify(age({ modified: 1e20 })) === '{}')
  check('按日历日：昨天 23:30 到今天 00:10 算 1 天', JSON.stringify(mod.memoryAge({ modified: '2026-11-13T23:30:00.000Z' }, Date.parse('2026-11-14T00:10:00.000Z'))) === '{"updated":"2026-11-13","ageDays":1}')
  check('同一天 → 0', age({ modified: '2026-11-14T01:00:00.000Z' }).ageDays === 0)
  check('未来的日期（时钟不准）→ 0，不出负数', age({ modified: '2026-12-01T00:00:00.000Z' }).ageDays === 0)
  check('ageDays 是整数', Number.isInteger(age({ modified: '2026-11-05T08:00:00.000Z' }).ageDays))
  check('「现在」不合法 → {}', JSON.stringify(mod.memoryAge({ modified: '2026-11-05' }, Number.NaN)) === '{}')
}

section('ageNote：两种文案（≤30 天 / >30 天）')
{
  check('9 天 → updated 2026-11-05, 9 days ago', mod.ageNote({ updated: '2026-11-05', ageDays: 9 }) === 'updated 2026-11-05, 9 days ago')
  check('30 天 → 不提醒核实', mod.ageNote({ updated: '2026-10-15', ageDays: 30 }) === 'updated 2026-10-15, 30 days ago')
  check('31 天 → 加 verify before relying on it', mod.ageNote({ updated: '2026-10-14', ageDays: 31 }) === 'updated 2026-10-14, 31 days ago; verify before relying on it')
  check('阈值就是 30', mod.VERIFY_AFTER_DAYS === 30)
  check('0 天 → today；1 天 → 1 day ago', mod.ageNote({ updated: '2026-11-14', ageDays: 0 }) === 'updated 2026-11-14, today' && mod.ageNote({ updated: '2026-11-13', ageDays: 1 }) === 'updated 2026-11-13, 1 day ago')
  check('拿不到日期 → 空串（不写这一段）', mod.ageNote({}) === '' && mod.ageNote(undefined) === '')
}

section('memory_recall：每条结果带 updated / ageDays，文字里标题行后跟一段')
{
  const restoreClock = mod.setClockForTests(() => NOW)
  const h = makeHost(mod)
  try {
    h.write(path.join(h.memoryDir, 'fresh-rule.md'), memoryFile({ id: 'fresh-rule', title: 'zebraquartz fresh rule', body: 'zebraquartz fresh rule body.', created: '2026-10-01T00:00:00.000Z', modified: '2026-11-05T08:00:00.000Z' }))
    h.write(path.join(h.memoryDir, 'no-dates.md'), memoryFile({ id: 'no-dates', title: 'hand written note', body: 'a hand written note without any dates.' }))
    // 全局按需库里一条很久没改过的
    const { mkdirSync } = await import('node:fs')
    mkdirSync(h.globalDir, { recursive: true })
    h.write(path.join(h.globalDir, 'old-rule.md'), memoryFile({ id: 'old-rule', title: 'zebraquartz old rule', body: 'zebraquartz old rule body.', created: '2026-09-01T00:00:00.000Z' }))

    const byId = await h.tool('memory_recall', { query: 'fresh-rule' })
    const fresh = byId.results?.[0]
    check('按 id 取：updated = modified 的日期，ageDays = 9', fresh?.updated === '2026-11-05' && fresh?.ageDays === 9, JSON.stringify(fresh && { updated: fresh.updated, ageDays: fresh.ageDays }))
    const lines = String(byId.text).split('\n')
    check('  …标题行后紧跟 updated 2026-11-05, 9 days ago', /^1\. \[feedback\] zebraquartz fresh rule/.test(lines[0]) && lines[1] === '   updated 2026-11-05, 9 days ago', JSON.stringify(lines.slice(0, 3)))
    check('  …不到 30 天，不提醒核实', !/verify before relying on it/.test(byId.text))

    const old = (await h.tool('memory_recall', { query: 'old-rule' })).results?.[0]
    check('没有 modified 的旧条目用 created：74 天', old?.updated === '2026-09-01' && old?.ageDays === 74 && old?.scope === 'global', JSON.stringify(old && { updated: old.updated, ageDays: old.ageDays, scope: old.scope }))

    const searched = await h.tool('memory_recall', { query: 'zebraquartz rule' })
    const rows = Object.fromEntries((searched.results ?? []).map((row) => [row.id, row]))
    check('检索路径同样带两个字段（两个库都有）', rows['fresh-rule']?.ageDays === 9 && rows['old-rule']?.ageDays === 74, JSON.stringify(Object.keys(rows)))
    const oldBlock = String(searched.text).split('\n\n---\n\n').find((block) => block.includes('zebraquartz old rule')) ?? ''
    check('  …超过 30 天的那条：updated 2026-09-01, 74 days ago; verify before relying on it', oldBlock.split('\n')[1] === '   updated 2026-09-01, 74 days ago; verify before relying on it', oldBlock.split('\n').slice(0, 3).join(' | '))
    const freshBlock = String(searched.text).split('\n\n---\n\n').find((block) => block.includes('zebraquartz fresh rule')) ?? ''
    check('  …不到 30 天的那条不提醒', freshBlock !== '' && !/verify before relying on it/.test(freshBlock))

    const bare = await h.tool('memory_recall', { query: 'no-dates' })
    const bareRow = bare.results?.[0]
    check('frontmatter 里没有日期 → 不带这两个字段、文字里没有 updated 这一段', bareRow && !('updated' in bareRow) && !('ageDays' in bareRow) && !/\bupdated \d/.test(bare.text), JSON.stringify(bareRow && Object.keys(bareRow)))
    check('  …返回值里没有 undefined / NaN', !JSON.stringify(bare).includes('null') && !/undefined|NaN/.test(bare.text))

    // 召回会记 hits / lastHit，但不改 modified：「写于何时」不会因为被读过而变新
    const again = (await h.tool('memory_recall', { query: 'fresh-rule' })).results?.[0]
    check('被召回过之后 updated 不变', again?.updated === '2026-11-05' && again?.ageDays === 9)

    // 时钟往后拨：同一条记忆跨过 30 天就开始提醒
    const restoreLater = mod.setClockForTests(() => Date.parse('2026-12-20T00:00:00.000Z'))
    try {
      const later = await h.tool('memory_recall', { query: 'fresh-rule' })
      check('「现在」可注入：拨到 12-20 → 45 天，开始提醒', later.results?.[0]?.ageDays === 45 && /updated 2026-11-05, 45 days ago; verify before relying on it/.test(later.text), later.text.split('\n')[1])
    } finally {
      restoreLater()
    }

    for (const [label, out] of [['按 id', byId], ['检索', searched], ['无日期', bare]]) {
      const problems = schemaProblems(mod.RECALL_OUTPUT_SCHEMA, out, { strict: true })
      check(`output.schema 声明了实际字段（${label}）`, problems.length === 0, problems.join('; '))
    }
  } finally {
    h.cleanup()
    restoreClock()
  }
}

section('setClockForTests 还原后回到真实时钟')
{
  // 假时钟拨到很远的将来：没还原的话「刚写的」会是上万天
  const restore = mod.setClockForTests(() => Date.parse('2100-01-01T00:00:00.000Z'))
  restore()
  const real = mod.memoryAge({ modified: new Date().toISOString() })
  // ≤ 1 而不是 === 0：两次取时间之间恰好跨过 UTC 零点时差一天，不能因此偶发失败
  check('还原后：刚写的记忆是 0 天（不是上万天）', Number.isInteger(real.ageDays) && real.ageDays <= 1, JSON.stringify(real))
}

section('真实文件未被本次测试改动')
check('真实 AGENTS.md 与全局按需库的存在性与哈希不变', guard.unchanged())

summary()
