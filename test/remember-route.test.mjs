/**
 * `memory_remember` 的置信度分流规则。
 *
 * 规则（用户 2026-11-02 定）：**模型自评置信度高的直接入库，不确定的进待确认由人审核**。
 * 这条规则决定了「什么会绕过人的判断直接进库」，所以必须有测试锁住边界。
 */
const mod = await import('../index.js')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

console.log('== 默认门槛 0.8 ==')
{
  const r = mod.configure({ directWriteConfidence: 0.8 })
  check('配置被接受', r.config.directWriteConfidence === 0.8, JSON.stringify(r.config.directWriteConfidence))

  check('0.90 → 直接入库', mod.rememberRoute(0.9) === 'direct', mod.rememberRoute(0.9))
  check('0.80 → 直接入库（边界含等号）', mod.rememberRoute(0.8) === 'direct', mod.rememberRoute(0.8))
  check('0.79 → 进待确认', mod.rememberRoute(0.79) === 'pending', mod.rememberRoute(0.79))
  check('0.30 → 进待确认', mod.rememberRoute(0.3) === 'pending', mod.rememberRoute(0.3))
  check('未估值按 0.8 处理 → 直接入库', mod.rememberRoute(undefined) === 'direct', mod.rememberRoute(undefined))
  check('NaN 按 0.8 处理 → 直接入库', mod.rememberRoute(Number.NaN) === 'direct', mod.rememberRoute(Number.NaN))
}

console.log('\n== 门槛拉到 1：全部要人确认 ==')
{
  mod.configure({ directWriteConfidence: 1 })
  check('0.99 → 待确认', mod.rememberRoute(0.99) === 'pending', mod.rememberRoute(0.99))
  check('1.00 → 直接入库', mod.rememberRoute(1) === 'direct', mod.rememberRoute(1))
}

console.log('\n== 门槛归零：全部直接入库 ==')
{
  mod.configure({ directWriteConfidence: 0 })
  check('0.10 → 直接入库', mod.rememberRoute(0.1) === 'direct', mod.rememberRoute(0.1))
  check('0.00 → 直接入库', mod.rememberRoute(0) === 'direct', mod.rememberRoute(0))
}

console.log('\n== 越界值被拒绝，退回默认 ==')
{
  const bad = mod.configure({ directWriteConfidence: 1.5 })
  check('1.5 被拒并记录问题', bad.issues.some((i) => i.startsWith('directWriteConfidence:')), bad.issues.join(' | '))
  check('退回默认 0.8', bad.config.directWriteConfidence === 0.8, String(bad.config.directWriteConfidence))
}

mod.configure(undefined)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
