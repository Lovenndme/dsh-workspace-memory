/**
 * 一次性迁移：把旧插件 @yolk_vat-y/dsh-project-memory 的 8 条 insights
 * 转成 dsh-workspace-memory 的一条记忆一个 Markdown 文件。
 *
 * 取舍：
 *   · 旧 kind（lesson/decision/procedure/experience）→ 新 type（四选一），
 *     原 kind 保留在 tags 里，不丢信息
 *   · 正文按旧字段重组成 markdown 小节，而不是把 JSON 塞进去
 *   · 追溯信息（旧 id / hitCount / 创建时间）放正文末尾，可回溯到 insights.json
 *   · triggerDerived.paths 有值的，迁到新库的 paths（路径作用域字段已预留）
 */
import { existsSync, readFileSync } from 'node:fs'

const OLD = 'C:\\Users\\lenovo\\Documents\\DSH-Workspace\\.dsh-project-memory\\insights.json'
const memoryDir = 'C:\\Users\\lenovo\\Documents\\DSH-Workspace\\.dsh-memory'

const mod = await import('../index.js')

/** 旧 kind → 新 type。 */
const KIND_TO_TYPE = {
  lesson: 'feedback',
  experience: 'feedback',
  decision: 'project',
  procedure: 'project',
}

function buildBody(ins) {
  const parts = []

  if (ins.pattern) parts.push(`**错误模式**：${ins.pattern}`)
  if (ins.fix) parts.push(`**修正做法**：${ins.fix}`)
  if (ins.choice) parts.push(`**选了什么**：${ins.choice}`)
  if (ins.reason) parts.push(`**为什么**：${ins.reason}`)

  if (Array.isArray(ins.steps) && ins.steps.length > 0) {
    parts.push('**步骤**：')
    parts.push(ins.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'))
  }

  if (Array.isArray(ins.files) && ins.files.length > 0) {
    parts.push('**关联文件**：')
    parts.push(ins.files.map((f) => `- ${f}`).join('\n'))
  }

  parts.push(
    '---',
    `迁移自 @yolk_vat-y/dsh-project-memory：id=${ins.id}, kind=${ins.kind}, ` +
      `hitCount=${ins.hitCount ?? 0}, createdAt=${ins.createdAt ?? '?'}`,
  )

  return parts.join('\n\n')
}

if (!existsSync(OLD)) {
  console.error(`旧 insights.json 不存在：${OLD}`)
  process.exit(1)
}

const items = JSON.parse(readFileSync(OLD, 'utf8')).items ?? []
if (items.length === 0) {
  console.error('旧 insights.json 里没有条目')
  process.exit(1)
}

console.log(`迁移 ${items.length} 条 -> ${memoryDir}\n`)

const written = []
for (const ins of items) {
  const type = KIND_TO_TYPE[ins.kind] ?? 'project'
  const paths = Array.isArray(ins.triggerDerived?.paths) ? ins.triggerDerived.paths : []
  const keywords = Array.isArray(ins.triggerDerived?.keywords) ? ins.triggerDerived.keywords : []
  const tags = [ins.kind, ...keywords].filter(Boolean).slice(0, 8)

  const file = mod.writeMemory(memoryDir, {
    title: ins.title,
    body: buildBody(ins),
    type,
    tags,
    paths,
    confidence: ins.confidence ?? 0.8,
  })
  written.push({ from: ins.id, to: file })
  console.log(`  [${ins.kind} -> ${type}] ${ins.title}`)
  if (paths.length) console.log(`      paths: ${paths.join(', ')}`)
}

const built = await mod.rebuildVectors(memoryDir)
const listed = mod.listMemories(memoryDir)

console.log(`\n写入 ${written.length} 条；库内现有 ${listed.length} 条`)
console.log(`向量索引：${built.mode}, ${built.indexed} 条`)

const index = readFileSync(`${memoryDir}\\MEMORY.md`, 'utf8')
console.log(`\nMEMORY.md（${Buffer.byteLength(index, 'utf8')} bytes / ${index.split('\n').length} 行）：`)
console.log(index)
