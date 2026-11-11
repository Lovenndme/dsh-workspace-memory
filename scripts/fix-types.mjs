/**
 * 一次性修复：`type` 被之前的 bug 重置成 project 的三条记忆。
 *
 * 起因：writeMemory 早期版本在「没传 type」时一律回落 project，
 * 而补 slug 的迁移脚本只传了 id/slug/description，于是分类被静默冲掉。
 * 代码已修（未传时沿用原值），这里把数据拨回来。
 */
import os from 'node:os'
import path from 'node:path'

const mod = await import('../index.js')

const DIR = path.join(
  os.homedir(),
  '.dsh',
  'projects',
  mod.encodeProjectPath('C:\\Users\\lenovo\\Documents\\DSH-Workspace'),
  'memory',
)

const FIX = [
  ['no-explanatory-text-in-ui', 'feedback'],
  ['small-verifiable-ui-refactors', 'feedback'],
  ['profile-stats-auto-npm-publish', 'user'],
]

console.log(`目录：${DIR}\n`)
for (const [id, type] of FIX) {
  const before = mod.listMemories(DIR).find((item) => item.id === id)?.meta?.type
  mod.writeMemory(DIR, { id, type })
  const after = mod.listMemories(DIR).find((item) => item.id === id)?.meta?.type
  const ok = after === type
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${id}: ${before} -> ${after}`)
}

const built = await mod.rebuildVectors(DIR)
console.log(`\n向量重建：${built.mode} / ${built.indexed} 条`)
console.log('\n=== 最终分类 ===')
for (const item of mod.listMemories(DIR).sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(`  [${String(item.meta.type).padEnd(9)}] ${item.id}`)
}
