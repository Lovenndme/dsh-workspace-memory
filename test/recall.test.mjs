/**
 * Recall integration test — 真实 leanvec 向量 + 关键词混合检索。
 *
 * 断言的是这套插件真正承诺的两件事：
 *   1. 相关查询能命中正确记忆（排在第一位）
 *   2. **无关查询返回零结果** —— 这是与上一代实现最关键的行为差异
 *
 * 跨语言（中文问 / 英文记忆）单独列为已知限制：leanvec 是按语言与字面聚类的
 * 静态嵌入表，不做中英语义桥接。这里只报告实测值，不假装它做不到的事。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mod = await import('../index.js')

let failures = 0
const check = (label, cond, detail) => {
  if (cond) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const embedder = await mod.resolveEmbedder()
if (!embedder) {
  console.log('SKIP: leanvec unavailable, hybrid recall cannot be exercised')
  process.exit(0)
}
console.log(`embedder ready: dim=${embedder.lv.dim}, vocab=${embedder.lv.size}\n`)

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-recall-'))
const memoryDir = path.join(tmp, '.dsh-memory')

const SEED = [
  {
    type: 'feedback',
    title: '界面里不要自行添加解释性说明文字',
    body: '用户明确要求：界面上不要出现多余的说明文案。功能自身说明清楚的事情不要再加一行解释。',
  },
  {
    type: 'lesson',
    title: '删除链接依赖会把真实工作区一起删掉',
    body: '使用 rmdir 断开链接而不是递归删除。递归删除会跟随链接把源目录连同 .git 一起删穿。',
  },
  {
    type: 'project',
    title: '输出被截成一个 token 的根因',
    body: '当 prompt 超过模型声明的 contextWindow 时，输出上限会被压成 1，模型只吐一个 token 就停止。',
  },
  {
    type: 'decision',
    title: 'northfield deploy checklist',
    body: 'Before shipping the northfield service, run the migration suite twice and archive the rollback snapshot.',
  },
]

console.log('== seed + index ==')
for (const item of SEED) {
  mod.writeMemory(memoryDir, { title: item.title, body: item.body, type: item.type })
}
const items = mod.listMemories(memoryDir)
check('four memories written', items.length === 4, `got ${items.length}`)

const built = await mod.rebuildVectors(memoryDir)
check('vector index built', built.mode === 'hybrid' && built.indexed === 4, JSON.stringify(built))

const idxFile = path.join(memoryDir, 'MEMORY.md')
check('MEMORY.md exists', existsSync(idxFile))
const idxText = readFileSync(idxFile, 'utf8')
// 索引行是「英文 slug 链接 + 中文摘要」，标题不再进索引，
// 所以断言每条记忆的文件链接都在，而不是断言中文标题出现。
check(
  '索引收录了每一条记忆的文件链接',
  mod.listMemories(memoryDir).every((item) => idxText.includes(`(${item.id}.md)`)),
  idxText.slice(0, 300),
)

console.log('\n== relevant queries rank the right memory first ==')
const CASES = [
  { q: 'UI 文案保持简洁不要啰嗦', expect: '界面里不要自行添加解释性说明文字', why: '同义改写' },
  { q: '删软链接把仓库一起删了', expect: '删除链接依赖会把真实工作区一起删掉', why: '同义改写' },
  { q: '上下文窗口超了输出只剩一个 token', expect: '输出被截成一个 token 的根因', why: '关键词重合' },
  { q: 'rmdir 和递归删除的区别', expect: '删除链接依赖会把真实工作区一起删掉', why: '关键词重合' },
]
for (const c of CASES) {
  const found = await mod.recall(memoryDir, c.q, 4)
  const top = found.results[0]
  check(
    `"${c.q}" -> ${c.expect}`,
    top?.title === c.expect,
    top ? `top was "${top.title}" score=${top.score} vec=${top.vector} kw=${top.keyword}` : 'no results at all',
  )
}

console.log('\n== off-topic queries must return NOTHING (anti-noise contract) ==')
const OFFTOPIC = ['今天天气怎么样', '红烧肉要炖多久', 'how tall is mount everest', 'int16 record sha1 drop_h1']
for (const q of OFFTOPIC) {
  const found = await mod.recall(memoryDir, q, 4)
  const top = found.results[0]
  check(
    `"${q}" -> 0 results`,
    found.results.length === 0,
    top ? `leaked "${top.title}" score=${top.score} vec=${top.vector} kw=${top.keyword}` : '',
  )
}

console.log('\n== known limitation: cross-lingual bridging (reported, not asserted) ==')
{
  const found = await mod.recall(memoryDir, '怎样把服务发布上线前的检查跑一遍', 4)
  const top = found.results[0]
  console.log(
    top
      ? `  中文问 / 英文记忆 -> "${top.title}" score=${top.score} vec=${top.vector} kw=${top.keyword}`
      : '  中文问 / 英文记忆 -> 0 results（向量与字面都没够到门槛）',
  )
  console.log('  leanvec 不做中英语义桥接：跨语言命中不可依赖，记忆尽量与提问同语言书写。')
}

console.log('\n== overwrite keeps one row per memory ==')
{
  const victim = items.find((i) => (i.meta.title ?? '').includes('token'))
  mod.writeMemory(memoryDir, { id: victim.id, title: victim.meta.title, body: victim.body })
  const after = await mod.rebuildVectors(memoryDir)
  check('no duplicate index rows after overwrite', after.indexed === 4, `indexed=${after.indexed}`)
}

rmSync(tmp, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
