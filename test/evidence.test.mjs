/**
 * 证据核对：`source: "user"` 的写入要能在用户消息里找到原话，否则进待确认。
 *
 * 为什么需要：审计（2026-11-14）里「没有用户信号、模型自行总结」的条目大多被推翻，
 * 典型是用户只说「加到 gitignore」，模型自选 skip-worktree 并写成规则。按来源分流的前提是
 * 来源可核对——模型声称「用户说的」时，就拿原话去对。
 *
 * 规则（index.js 的 verifyEvidence）：
 *   · 空白 / 大小写 / 全半角差异不算改写；首尾引号去掉；
 *   · 省略号（… 或 ..）切段，按顺序出现在**同一条**用户消息里；每段 ≥ 2 字、合计 ≥ 4 字；
 *   · 注入块（<system-reminder>、[workspace-memory]）不是用户说的话。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
const mod = await import('../index.js')
const { verifyEvidence, userTextsOf } = mod

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}
const ok = (texts, evidence) => verifyEvidence(texts, evidence).verified === true

const said = [
  '我只看得懂中文，以后回答都用中文，说大白话。',
  'Please run the FULL test suite before you push.',
  '模型选择要询问我，不要自己定。',
]

console.log('== 原样与等价写法通过 ==')
{
  check('逐字摘录', ok(said, '以后回答都用中文'))
  check('空白差异（多了空格、换行）', ok(said, '以后 回答\n都用 中文'))
  check('大小写差异', ok(said, 'please RUN the full test suite'))
  check('全角/半角差异（ＦＵＬＬ、全角逗号）', ok(said, 'run the ＦＵＬＬ test suite') && ok(said, '我只看得懂中文,以后回答'))
  check('首尾带引号', ok(said, '「说大白话」') && ok(said, '"模型选择要询问我"') && ok(said, '“不要自己定”'))
  check('抄来了「用户：」前缀也认', ok(said, '用户：模型选择要询问我'))
}

console.log('\n== 省略号分段 ==')
{
  check('… 跳过中间一段，按顺序通过', ok(said, '我只看得懂中文…说大白话'))
  check('.. / ... 同样是省略号', ok(said, 'run the full...before you push') && ok(said, '模型选择..不要自己定'))
  check('首尾的省略号只表示「前后还有话」', ok(said, '…以后回答都用中文…'))
  check('乱序不通过', !ok(said, '说大白话…我只看得懂中文'))
  check('段之间不能拼另一条消息的内容', !ok(said, '以后回答都用中文…模型选择要询问我'))
}

console.log('\n== 跨消息拼接不通过 ==')
{
  check('两条消息首尾相接不算一句话', !ok(['以后回答都用', '中文说大白话'], '以后回答都用中文'))
  check('同样的文字在一条消息里就通过', ok(['以后回答都用中文说大白话'], '以后回答都用中文'))
}

console.log('\n== 过短 / 无效输入不通过 ==')
{
  check('总长 < 4', !ok(said, '中文'))
  check('某一段只有 1 个字', !ok(said, '我…说大白话'))
  check('两段各 2 字、合计 4 字：恰好够', ok(said, '我只…中文'))
  check('空串 / 只有空白 / 只有引号或省略号', !ok(said, '') && !ok(said, '   ') && !ok(said, '「」') && !ok(said, '……'))
  check('不是字符串', !ok(said, undefined) && !ok(said, null) && !ok(said, 42) && !ok(said, ['以后回答都用中文']))
  check('没有用户消息（拿不到会话）', !ok([], '以后回答都用中文') && !ok(undefined, '以后回答都用中文'))
  check('用户没说过的话', !ok(said, '以后都用英文回答'))
  check('只有一部分对得上也不行', !ok(said, '以后回答都用中文和英文'))
  // 第四轮：通过时多一个 match（exact / approx），未通过时只有 verified
  check('返回值形状：通过 { verified, match }，未通过只有 { verified }', JSON.stringify(verifyEvidence(said, '说大白话')) === '{"verified":true,"match":"exact"}' && JSON.stringify(verifyEvidence(said, '从没说过的话')) === '{"verified":false}')
}

console.log('\n== userTextsOf：只取用户消息，跳过注入块，全会话不截断 ==')
{
  const long = '很长的一段用户消息。'.repeat(2000)
  // 真实宿主里 user/message 的 source 必填；人发的是 { kind: 'user' }（第五轮起没有 source 的不算人写的）
  const human = (content) => ({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content } })
  const session = {
    snapshotEvents: () => [
      human([{ type: 'text', text: '<system-reminder>以后回答都用中文</system-reminder>' }]),
      human([{ type: 'text', text: '[workspace-memory] 记忆索引。以后回答都用中文' }]),
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '助手说：以后回答都用中文' }] } } },
      { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: '工具输出：以后回答都用中文' }] } } },
      // 没有 source：来路不明，不算
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '没有 source 的消息：以后回答都用中文' }] } },
      human([{ type: 'text', text: '第一句。' }, { type: 'image' }, { type: 'text', text: '第二句。' }]),
      human([{ type: 'text', text: long }]),
      human('字符串形式的消息'),
      // 提醒块夹在人写的话中间（不在开头）：剥掉提醒，留下人写的
      human([{ type: 'text', text: '帮我改一下\n<system-reminder>以后回答都用中文</system-reminder>\n这个函数' }]),
    ],
  }
  const texts = userTextsOf(session)
  check('注入块、助手消息、工具结果、没有 source 的消息都不算', texts.length === 4, JSON.stringify(texts.map((t) => t.slice(0, 20))))
  check('一条消息的多个文本块合成一个元素', texts[0] === '第一句。\n第二句。', JSON.stringify(texts[0]))
  check('长消息不截断', texts[1] === long)
  check('content 是字符串时也取', texts[2] === '字符串形式的消息')
  check('任意位置的 <system-reminder> 块都剥掉', texts[3] === '帮我改一下\n\n这个函数', JSON.stringify(texts[3]))
  check('只有注入块 / 提醒块 / 无 source 消息里出现过的话 → 核对不通过', !ok(texts, '以后回答都用中文'))
  check('拿不到会话 / snapshotEvents 抛错 / 返回非数组 → []',
    userTextsOf(undefined).length === 0 &&
      userTextsOf({ snapshotEvents: () => { throw new Error('x') } }).length === 0 &&
      userTextsOf({ snapshotEvents: () => null }).length === 0 &&
      userTextsOf({}).length === 0)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
