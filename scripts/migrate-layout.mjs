/**
 * 一次性迁移：把旧布局（<工作区>/.dsh-memory/memories/*.md，id 形如 feedback_mvxj6luj）
 * 搬到 Claude Code 风格的新布局：
 *
 *   ~/.dsh/projects/C--Users-lenovo-Documents-DSH-Workspace/memory/
 *   ├── MEMORY.md
 *   └── <标题 slug>.md
 *
 * 迁移动作：
 *   · 文件名改为标题派生的语义 slug
 *   · 补齐 description（索引行摘要）
 *   · 保留 created / confidence / tags / paths / type / status
 *   · 旧目录**不删除**，留作回滚
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mod = await import('../index.js')

const OLD = 'C:\\Users\\lenovo\\Documents\\DSH-Workspace\\.dsh-memory'
const PROJECT = 'C:\\Users\\lenovo\\Documents\\DSH-Workspace'
// 目标路径从编码器推导，避免脚本和运行时各写各的
const ENCODED = mod.encodeProjectPath(PROJECT)
const NEW = path.join(os.homedir(), '.dsh', 'projects', ENCODED, 'memory')

console.log(`旧库：${OLD}`)
console.log(`项目：${PROJECT}`)
console.log(`编码：${ENCODED}`)
console.log(`新库：${NEW}`)

const oldMemories = path.join(OLD, 'memories')
if (!existsSync(oldMemories)) {
  console.error(`旧库没有 memories/ 目录：${oldMemories}`)
  process.exit(1)
}

const files = readdirSync(oldMemories).filter((n) => n.endsWith('.md'))
console.log(`\n发现 ${files.length} 条待迁移记忆\n`)

const report = []
for (const name of files) {
  const raw = readFileSync(path.join(oldMemories, name), 'utf8')
  const { data, body } = mod.parseFrontmatter(raw)
  const title = String(data.title ?? '').trim() || name.replace(/\.md$/, '')
  const oldId = name.replace(/\.md$/, '')

  const file = mod.writeMemory(NEW, {
    title,
    body,
    description: undefined, // 让它按正文首行生成
    type: data.type,
    tags: Array.isArray(data.tags) ? data.tags : [],
    paths: Array.isArray(data.paths) ? data.paths : [],
    confidence: data.confidence,
    status: data.status ?? 'confirmed',
    created: data.created,
  })

  const newId = path.basename(file, '.md')
  report.push({ oldId, newId, title })
  console.log(`  ${oldId}.md`)
  console.log(`    -> ${newId}.md`)
}

const built = await mod.rebuildVectors(NEW)
const listed = mod.listMemories(NEW)

console.log(`\n迁移完成：${listed.length} 条，向量 ${built.mode} / ${built.indexed} 条`)
console.log(`文件数校验：目录内 .md 共 ${readdirSync(NEW).filter((n) => n.endsWith('.md')).length} 个（含 MEMORY.md）`)

console.log('\n=== 新目录内容 ===')
for (const n of readdirSync(NEW).sort()) console.log(`  ${n}`)

console.log('\n=== MEMORY.md ===')
console.log(readFileSync(path.join(NEW, 'MEMORY.md'), 'utf8'))
