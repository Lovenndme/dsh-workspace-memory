/**
 * 正文过期值提示（stalenessHints）：只提示、不拦截、不改写。
 *
 * 为什么：审计（2026-11-14）里 24 条记忆有 13 条「规则对，但混了提交哈希、计数、版本号、安装路径」——
 * 规则还对，那些值早已过期。拦截会误伤（版本号有时就是坑的失效条件），
 * 所以沿用「策略不是过滤器」：写进去，并在结果里点名，让模型自己判断要不要删。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { makeHost, makeReporter, realFilesGuard } from './fake-host.mjs'

const mod = await import('../index.js')
const { stalenessHints } = mod
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

section('检出提交哈希与版本号')
{
  check('7 位短哈希', same(stalenessHints('修复见提交 a1b2c3d。', 'project'), ['a1b2c3d']))
  check('40 位完整哈希', stalenessHints(`commit ${'0123456789abcdef'.repeat(2)}01234567 已合入`, 'project').length === 1)
  check('大写十六进制也算', same(stalenessHints('build DEADBEEF1 failed', 'project'), ['DEADBEEF1']))
  check('版本号 v1.2.3 与 2.0.4', same(stalenessHints('升级到 v1.2.3，AgentScope 2.0.4 之后', 'project'), ['v1.2.3', '2.0.4']))
  check('同一个值只报一次', same(stalenessHints('a1b2c3d 与 a1b2c3d', 'feedback'), ['a1b2c3d']))
}

section('不该报的不报')
{
  check('纯数字不是哈希（计数、日期）', stalenessHints('共 12345678 条，2026111401', 'project').length === 0)
  check('纯字母不是哈希（单词）', stalenessHints('deadbeef facade cafebabe', 'project').length === 0)
  check('6 位太短、41 位太长', stalenessHints(`abc123 与 ${'a1'.repeat(20)}b`, 'project').length === 0)
  check('嵌在更长的标识符里不算（0x 前缀、单词中间）', stalenessHints('0x1f2e3d4c 与 prefixa1b2c3d4', 'project').length === 0)
  check('两段的版本号不算', stalenessHints('Node 18.2 与 1.5 倍', 'project').length === 0)
  check('四段的 IP 不算版本号', stalenessHints('连 172.16.9.116 的服务', 'project').length === 0)
  check('句末的点不影响识别', same(stalenessHints('要求 Node 18.20.1.', 'project'), ['18.20.1']))
}

section('pitfall 豁免版本号（版本正是坑的失效条件），哈希照报')
{
  check('pitfall 的版本号不报', stalenessHints('2.0.4 起官方子 Agent 工厂丢 shell 能力', 'pitfall').length === 0)
  check('pitfall 的哈希仍然报', same(stalenessHints('见 a1b2c3d；2.0.4 起失效', 'pitfall'), ['a1b2c3d']))
}

section('围栏代码块里不检')
{
  const body = ['规则：发布前跑测试。', '', '```bash', 'git checkout a1b2c3d', 'npm i pkg@1.2.3', '```', '', '~~~', 'v9.9.9', '~~~'].join('\n')
  check('``` 与 ~~~ 里的值都不报', stalenessHints(body, 'project').length === 0, JSON.stringify(stalenessHints(body, 'project')))
  check('围栏外的照报', same(stalenessHints(`${body}\n\n另见 b2c3d4e。`, 'project'), ['b2c3d4e']))
  check('空 / 非字符串正文不抛', stalenessHints(undefined, 'project').length === 0 && stalenessHints(null).length === 0)
}

section('写入不被拦：直写与进待确认都在文本末尾点名')
{
  const host = makeHost(mod, { config: { duplicateCheck: false } })
  try {
    const body = '发布只走 CI。上次在 a1b2c3d 修好，用的是 v1.2.3。'
    const direct = await host.tool('memory_remember', { slug: 'ci-only', title: 'CI only', body, type: 'project', source: 'agent' })
    check('照常写入', typeof direct.id === 'string' && !direct.reason, JSON.stringify(direct))
    check('正文原样保存（不改写）', readFileSync(path.join(host.memoryDir, 'ci-only.md'), 'utf8').includes(body))
    check('文本末尾点名命中的串', /Note: the body mentions "a1b2c3d", "v1\.2\.3"\. Values like these go stale; keep them only if they are the condition under which this memory stops applying\.$/.test(direct.text), direct.text)
    check('结构化字段 staleValues', same(direct.staleValues, ['a1b2c3d', 'v1.2.3']))

    const queued = await host.tool('memory_remember', { slug: 'queued-stale', title: 'Queued', body, type: 'project', source: 'user', evidence: '没说过' })
    check('进待确认的结果同样点名', queued.pending === true && /Note: the body mentions "a1b2c3d"/.test(queued.text), queued.text)

    const pitfall = await host.tool('memory_remember', { slug: 'pin-version', title: 'Pin', body: '2.0.4 起这个坑才出现。', type: 'pitfall', source: 'agent' })
    check('pitfall 只有版本号 → 不提示', typeof pitfall.id === 'string' && !/Note: the body mentions/.test(pitfall.text) && pitfall.staleValues === undefined, pitfall.text)

    const clean = await host.tool('memory_remember', { slug: 'clean', title: 'Clean', body: '说大白话。', type: 'feedback', source: 'agent' })
    check('没有过期值 → 文本里没有这句', !/go stale/.test(clean.text))
  } finally {
    host.cleanup()
  }
}

section('真实文件未被本次测试改动')
check('~/.dsh/AGENTS.md 与 ~/.dsh/global-memory 的存在性与哈希不变', guard.unchanged())

summary()
