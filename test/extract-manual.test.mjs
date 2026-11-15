/**
 * 手动抽取不受 `enableExtraction` 影响。
 *
 * 为什么单独立一条：`enableExtraction` 的语义是「每回合自动触发」，
 * 但 `/memory extract` 曾经直接复用同一个入口，于是开关关闭时**手动命令也会被拒**——
 * 而面板与帮助文案都在建议用户去跑它。这是一个「文档承诺了、代码拒绝了」的真 bug。
 *
 * 测试不联网：用不带 llm 的假 ctx，只要 `skipped` 不再是 extraction disabled，
 * 就证明守卫被绕过了（会停在后面的 'llm unavailable'）。
 */
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

const { mkdtempSync, rmSync } = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-manual-'))
const memoryDir = path.join(tmp, '.dsh-memory')

// 没有任何服务的 ctx —— llm 拿不到，会在守卫之后停下
const ctx = { get: () => undefined }

try {
  mod.configure({ enableExtraction: false })

  const auto = await mod.extractFromTurn(ctx, null, memoryDir)
  check('自动路径：开关关闭时应被拒', auto.skipped === 'extraction disabled', JSON.stringify(auto))

  const manual = await mod.extractFromTurn(ctx, null, memoryDir, { manual: true })
  check(
    '手动路径：开关关闭时不应再被拒',
    manual.skipped !== 'extraction disabled',
    JSON.stringify(manual),
  )
  check(
    '手动路径：应在更后面的环节停下（无 llm）',
    manual.skipped === 'llm unavailable',
    JSON.stringify(manual),
  )

  mod.configure({ enableExtraction: true })
  const autoOn = await mod.extractFromTurn(ctx, null, memoryDir)
  check('自动路径：开关打开时不再被开关拦住', autoOn.skipped !== 'extraction disabled', JSON.stringify(autoOn))
} finally {
  rmSync(tmp, { recursive: true, force: true })
  mod.configure(undefined)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
