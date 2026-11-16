/**
 * 模型可见文字的基线守卫（2026-11-15，/memory 命令优化时加）。
 *
 * 系统提示段、工具说明 / 参数说明 / 输出 schema、MEMORY.md 索引格式、每轮注入的索引上下文都经过模型评测
 * （eval/remember.mjs 等），改一个字都可能改变模型的行为。只改给人看的文字（命令回执、面板）时，这些必须一字不变。
 * 这里把它们与 `test/fixtures/model-visible-text.json` 逐项比对：基线由 e16ba87（v0.8.3）的 index.js 生成。
 *
 * 真的要改模型可见文字时：先重跑评测确认效果，再执行
 *   node test/model-visible-text.test.mjs --update
 * 重写基线，并在提交说明里写明评测结果。
 *
 * command-labels.test.mjs 守的是「这些文字里不出现面板叫法」（语义），这里守的是「一字不变」（字面）。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHost, makeReporter, realFilesGuard } from './fake-host.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'model-visible-text.json')
const UPDATE = process.argv.includes('--update')

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()

/** 采集当前代码的模型可见文字。示例数据是固定的虚构内容，结果与运行环境无关（不含路径、时间）。 */
function collect() {
  const host = makeHost(mod)
  try {
    const sections = host.sections.map((def) => ({
      name: def.name,
      order: def.order,
      interpolate: def.interpolate,
      text: typeof def.text === 'function' ? def.text() : def.text,
    }))
    const tools = [...host.tools.values()]
      .map((def) => ({ name: def.name, description: def.description, parameters: def.parameters, outputSchema: def.output?.schema ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name))
    // 索引格式与每轮注入的上下文：两个库各写一条固定的示例
    mod.writeMemory(host.memoryDir, { slug: 'build-command', title: 'Build command', description: 'use the all-in-one build script', body: 'x', type: 'project' })
    mod.writeMemory(host.globalDir, { slug: 'docs-location', title: 'Docs location', description: 'where the shared docs live', body: 'x', type: 'reference', scope: 'global' })
    const index = readFileSync(path.join(host.memoryDir, 'MEMORY.md'), 'utf8').replace(/\r\n/g, '\n')
    const context = String(host.contextText()).replace(/\r\n/g, '\n')
    return { sections, tools, index, context }
  } finally {
    host.cleanup()
  }
}

const current = collect()

if (UPDATE) {
  mkdirSync(path.dirname(FIXTURE), { recursive: true })
  writeFileSync(FIXTURE, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  console.log(`已重写基线：${path.relative(process.cwd(), FIXTURE)}`)
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const RERUN = '改了模型可见文字要重跑评测（eval/remember.mjs 等），确认后用 node test/model-visible-text.test.mjs --update 重写基线'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
/** 第一处不同的位置，方便定位（只给片段，不整段打印）。 */
const firstDiff = (a, b) => {
  const x = JSON.stringify(a) ?? ''
  const y = JSON.stringify(b) ?? ''
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i += 1
  return `第 ${i} 个字符起不同：基线 …${y.slice(Math.max(0, i - 30), i + 50)}… / 现在 …${x.slice(Math.max(0, i - 30), i + 50)}…`
}

section('系统提示段（ctx.systemPrompt.section）全文与基线一致')
{
  check('（自检）收集到了系统提示段', current.sections.length > 0 && current.sections.every((s) => typeof s.text === 'string' && s.text.length > 200))
  check('段的数量与名字不变', same(current.sections.map((s) => s.name), baseline.sections.map((s) => s.name)), RERUN)
  for (const s of baseline.sections) {
    const now = current.sections.find((x) => x.name === s.name)
    check(`段 ${s.name}：文字、顺序、interpolate 一字不变`, now && same(now, s), now ? `${RERUN}\n        ${firstDiff(now, s)}` : RERUN)
  }
}

section('工具：说明、参数说明、输出 schema 与基线一致')
{
  check('（自检）收集到了四个工具', current.tools.length === 4 && current.tools.every((tool) => tool.description.length > 50))
  check('工具清单不变', same(current.tools.map((tool) => tool.name), baseline.tools.map((tool) => tool.name)), RERUN)
  for (const tool of baseline.tools) {
    const now = current.tools.find((x) => x.name === tool.name)
    check(`${tool.name}：description 一字不变`, now && now.description === tool.description, now ? `${RERUN}\n        ${firstDiff(now.description, tool.description)}` : RERUN)
    check(`${tool.name}：参数与参数说明一字不变`, now && same(now.parameters, tool.parameters), now ? `${RERUN}\n        ${firstDiff(now.parameters, tool.parameters)}` : RERUN)
    check(`${tool.name}：输出 schema 不变`, now && same(now.outputSchema, tool.outputSchema), now ? `${RERUN}\n        ${firstDiff(now.outputSchema, tool.outputSchema)}` : RERUN)
  }
}

section('MEMORY.md 索引格式与每轮注入的索引上下文与基线一致')
{
  check('（自检）索引里有条目行', /^- \[.+\]\(build-command\.md\)/m.test(current.index), current.index)
  check('MEMORY.md 索引格式不变', current.index === baseline.index, `${RERUN}\n        ${firstDiff(current.index, baseline.index)}`)
  check('每轮注入的索引上下文不变', current.context === baseline.context, `${RERUN}\n        ${firstDiff(current.context, baseline.context)}`)
}

check('真实的 ~/.dsh/AGENTS.md 与全局按需库一个字节没变', guard.unchanged())
summary()
