/**
 * 按方案 A 重整记忆分类。
 *
 * 台账（用户选的 A：收拢到 Claude Code 原生四类，把纯步骤搬去 skill）：
 *
 *   改 type：
 *     feedback_mvxj6lua  技术坑(junction 删穿)      feedback -> project
 *     feedback_mvxj6luj  换代次操作                  feedback -> project
 *     project_mvxj6lu3   常驻要求(自动发 npm)        project  -> user
 *     project_mvxj6lud   大改被回滚的教训            project  -> feedback
 *     feedback_mvxj6lu7  界面不加解释文字            feedback（本来就是对的，不动）
 *
 *   搬去 skill 后删除（正文已完整转录到 ~/.dsh/skills/dsh-plugin-recipes/SKILL.md）：
 *     project_mvxj6lug  加斜杠命令 + 上下文占用口径   -> SKILL.md §1 §3
 *     project_mvxj6lul  link ↔ registry 换源          -> SKILL.md §4
 *     project_mvxj6luo  命令卡默认展开                -> SKILL.md §2
 *
 * 另外清掉两条迁移时从 triggerDerived.paths 带过来的无意义路径：
 *   feedback_mvxj6lua  paths [.git]        -> []      （.git 不是可写目标）
 *   feedback_mvxj6luj  paths [.loads.log]  -> []      （日志文件不是可写目标）
 */
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const memoryDir = 'C:\\Users\\lenovo\\Documents\\DSH-Workspace\\.dsh-memory'
const mod = await import('../index.js')

const RETYPE = [
  { id: 'feedback_mvxj6lua', type: 'project', why: '技术坑，不是用户反馈' },
  { id: 'feedback_mvxj6luj', type: 'project', why: '操作方法，不是用户反馈' },
  { id: 'project_mvxj6lu3', type: 'user', why: '常驻个人要求' },
  { id: 'project_mvxj6lud', type: 'feedback', why: '来自用户否决的教训' },
]

const CLEAR_PATHS = ['feedback_mvxj6lua', 'feedback_mvxj6luj']

const REMOVE = [
  { id: 'project_mvxj6lug', movedTo: 'dsh-plugin-recipes SKILL.md §1/§3' },
  { id: 'project_mvxj6lul', movedTo: 'dsh-plugin-recipes SKILL.md §4' },
  { id: 'project_mvxj6luo', movedTo: 'dsh-plugin-recipes SKILL.md §2' },
]

function readOne(id) {
  const file = path.join(memoryDir, 'memories', `${id}.md`)
  const raw = readFileSync(file, 'utf8')
  const { data, body } = mod.parseFrontmatter(raw)
  return { file, data, body }
}

function isForbiddenWriteTarget(p) {
  const s = String(p).trim()
  return s === '.git' || s.startsWith('.git/') || /\.log$/i.test(s)
}

console.log('== 改 type ==')
for (const item of RETYPE) {
  const before = readOne(item.id)
  mod.writeMemory(memoryDir, { id: item.id, type: item.type })
  const after = readOne(item.id)
  const ok = after.data.type === item.type
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${item.id}  ${before.data.type} -> ${after.data.type}  (${item.why})`)
  if (after.data.title !== before.data.title || after.data.created !== before.data.created) {
    console.log('       !! 标题或 created 被改动，请检查')
  }
}

console.log('\n== 清理无意义的 paths ==')
for (const id of CLEAR_PATHS) {
  const before = readOne(id)
  const paths = Array.isArray(before.data.paths) ? before.data.paths : []
  const keep = paths.filter((p) => !isForbiddenWriteTarget(p))
  if (keep.length === paths.length) {
    console.log(`  skip ${id}（没有需要清理的项）`)
    continue
  }
  mod.writeMemory(memoryDir, { id, paths: keep })
  const after = readOne(id)
  console.log(`  OK   ${id}  [${paths.join(', ')}] -> [${after.data.paths?.join(', ') ?? ''}]`)
}

console.log('\n== 删除已搬进 skill 的三条 ==')
for (const item of REMOVE) {
  const file = path.join(memoryDir, 'memories', `${item.id}.md`)
  try {
    rmSync(file, { force: true })
    console.log(`  OK   已删除 ${item.id}（正文已转录到 ${item.movedTo}）`)
  } catch (error) {
    console.log(`  FAIL ${item.id}: ${error.message}`)
  }
}

const rebuilt = mod.rebuildIndex(memoryDir)
const built = await mod.rebuildVectors(memoryDir)
console.log(`\n索引重建：${rebuilt.count} 条 / ${rebuilt.lineCount} 行 / ${rebuilt.byteCount} 字节`)
console.log(`向量重建：${built.mode}, ${built.indexed} 条`)

console.log('\n=== 最终 MEMORY.md ===')
console.log(readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'))

console.log('=== 逐条核对 ===')
for (const item of mod.listMemories(memoryDir)) {
  console.log(
    `  [${item.meta.type}] ${item.meta.title}` +
      (item.meta.paths?.length ? `  paths=[${item.meta.paths.join(', ')}]` : ''),
  )
}
