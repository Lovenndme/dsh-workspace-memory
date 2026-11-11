/**
 * 给现有记忆补上英文 slug 与中文摘要。
 *
 * 目标格式（索引行英文在前、中文说明在后）：
 *   - [No explanatory text in ui](no-explanatory-text-in-ui.md) — 界面只呈现数据与控件…
 *
 * 说明：slug 是**独立的标识**，不再从中文标题派生。改标题不会重命名文件，
 * 只有显式改 slug 才会。
 */
import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mod = await import('../index.js')

const ENCODED = mod.encodeProjectPath('C:\\Users\\lenovo\\Documents\\DSH-Workspace')
const DIR = path.join(os.homedir(), '.dsh', 'projects', ENCODED, 'memory')

/** 标题关键字 -> { slug, description }。故意手写，机器翻译的 slug 不如人选的准。 */
const PLAN = [
  {
    match: '界面里不要自行添加解释性说明文字',
    slug: 'no-explanatory-text-in-ui',
    description: '界面只呈现数据与控件，不加解释性文案；需要的解释写进 README',
  },
  {
    match: 'pnpm 删除 link',
    slug: 'pnpm-remove-link-deletes-target',
    description: 'pnpm 删 link 依赖会顺着 junction 删穿源目录，换源前必须先 rmdir 断链',
  },
  {
    match: '本地 bundle 改完代码不热更',
    slug: 'hot-reload-local-bundle-generation',
    description: '本地 bundle 改完不热更：disable→enable 切一次插件行来换模块代次',
  },
  {
    match: 'dsh-profile-stats：每次改动后自动发布 npm',
    slug: 'profile-stats-auto-npm-publish',
    description: 'profile-stats 每次改完自动发 npm（测试 → 升版本 → 提交 → publish → 校验）',
  },
  {
    match: '界面重构要小步',
    slug: 'small-verifiable-ui-refactors',
    description: '界面重构要小步可验证；一次性换样式层会被用户否决并回滚',
  },
]

console.log(`目录：${DIR}\n`)

const files = readdirSync(DIR).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md')
console.log(`现有记忆 ${files.length} 条\n`)

const done = []
for (const name of files) {
  const raw = readFileSync(path.join(DIR, name), 'utf8')
  const { data } = mod.parseFrontmatter(raw)
  const title = String(data.title ?? '').trim()

  const plan = PLAN.find((p) => title.includes(p.match))
  if (!plan) {
    console.log(`  跳过（没有对应计划）：${title}`)
    continue
  }

  const oldId = name.replace(/\.md$/, '')
  const file = mod.writeMemory(DIR, {
    id: oldId,
    slug: plan.slug,
    description: plan.description,
  })
  const newId = path.basename(file, '.md')
  done.push({ oldId, newId, description: plan.description })
  console.log(`  ${oldId}`)
  console.log(`    -> ${newId}`)
}

const built = await mod.rebuildVectors(DIR)
console.log(`\n完成 ${done.length} 条；向量 ${built.mode} / ${built.indexed} 条\n`)

console.log('=== 目录 ===')
for (const n of readdirSync(DIR).sort()) console.log(`  ${n}`)
console.log('\n=== MEMORY.md ===')
console.log(readFileSync(path.join(DIR, 'MEMORY.md'), 'utf8'))
