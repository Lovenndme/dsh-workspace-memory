/** 来源分流：所有新写入都按需；旧 load 不再改变核实结果或 agentWrites 配置。 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
const mod = await import('../index.js')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}
const show = (value) => JSON.stringify(value)
const R = mod.rememberRoute

console.log('== 默认 agentWrites = review ==')
{
  const r = mod.configure({})
  check('默认值是 review', r.config.agentWrites === 'review', show(r.config.agentWrites))

  const direct = R({ source: 'user', verified: true, load: 'on-demand' })
  check('user + 证据通过 + on-demand → 直写', direct.route === 'direct' && direct.reason === undefined, show(direct))
  const unverified = R({ source: 'user', verified: false, load: 'on-demand' })
  check('user + 证据未通过 + on-demand → pending / evidence-not-found', unverified.route === 'pending' && unverified.reason === 'evidence-not-found', show(unverified))
  for (const verified of [true, false]) {
    const userAlways = R({ source: 'user', verified, load: 'always' })
    check(`旧 always + user + 证据${verified ? '通过' : '未通过'} → 仍按证据分流`, userAlways.route === (verified ? 'direct' : 'pending') && userAlways.reason === (verified ? undefined : 'evidence-not-found'), show(userAlways))
  }
  const always = R({ source: 'agent', load: 'always' })
  check('旧 always + agent → pending / agent-review', always.route === 'pending' && always.reason === 'agent-review', show(always))
  const review = R({ source: 'agent', load: 'on-demand' })
  check('agent + on-demand → pending / agent-review', review.route === 'pending' && review.reason === 'agent-review', show(review))
  check('agent 带 verified:true 也不直写（核对只对 user 有意义）', R({ source: 'agent', verified: true, load: 'on-demand' }).route === 'pending')
}

console.log('\n== source 缺失或非法按 agent 处理 ==')
{
  mod.configure({})
  for (const source of [undefined, null, '', 'USER', 'human', 42]) {
    const r = R({ source, verified: true, load: 'on-demand' })
    check(`source=${show(source)} → agent-review`, r.route === 'pending' && r.reason === 'agent-review', show(r))
  }
  check('不传参数 → agent-review（不抛）', R().reason === 'agent-review', show(R()))
  check('旧调用形式 rememberRoute(0.95) 不会被当成直写', R(0.95).route === 'pending', show(R(0.95)))
  check('verified 必须是 true（"yes" 不算）', R({ source: 'user', verified: 'yes' }).route === 'pending')
}

console.log('\n== agentWrites = direct ==')
{
  const r = mod.configure({ agentWrites: 'direct' })
  check('配置被接受', r.config.agentWrites === 'direct' && r.issues.length === 0, show(r))
  check('agent + on-demand → 直写', R({ source: 'agent', load: 'on-demand' }).route === 'direct')
  check('agentWrites=direct + 旧 always 也按需直写', R({ source: 'agent', load: 'always' }).route === 'direct')
  check('user + 证据通过 + 旧 always 同样直写', R({ source: 'user', verified: true, load: 'always' }).route === 'direct')
  check('user + 证据未通过 仍然进 pending（开关只管 agent）', R({ source: 'user', verified: false, load: 'on-demand' }).reason === 'evidence-not-found')
}

console.log('\n== 坏值退回默认 ==')
{
  const bad = mod.configure({ agentWrites: 'yolo' })
  check('非法值被拒并记录 issue', bad.issues.some((i) => i.startsWith('agentWrites:')), bad.issues.join(' | '))
  check('退回默认 review', bad.config.agentWrites === 'review', show(bad.config.agentWrites))
  check('退回后 agent 内容进 pending', R({ source: 'agent', load: 'on-demand' }).route === 'pending')
  const wrongType = mod.configure({ agentWrites: true })
  check('非字符串同样被拒', wrongType.config.agentWrites === 'review' && wrongType.issues.some((i) => i.startsWith('agentWrites:')), show(wrongType.issues))
}

mod.configure(undefined)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
