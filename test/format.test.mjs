/**
 * 格式闸门测试。
 *
 * 这个插件的承诺是「UI 编辑不会让记忆文件格式漂移」。支撑这个承诺的就是
 * validateMemoryPatch：任何一条不合法就整体拒绝，落盘永远走 serializeFrontmatter。
 *
 * 这里逐个字段验证拒绝行为——拒绝比接受更值得测，因为接受错了会静默写坏文件。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
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

const V = mod.validateMemoryPatch

console.log('== 合法输入 ==')
{
  const r = V({ title: '  标题  ', body: ' 正文 ', type: 'feedback', tags: [' a ', 'b', 'a'], paths: ['x/**'] })
  check('接受完整合法补丁', r.ok, JSON.stringify(r.errors))
  check('title 去空白', r.value.title === '标题', r.value.title)
  check('body 去空白', r.value.body === '正文', r.value.body)
  check('tags 去空白去重', JSON.stringify(r.value.tags) === JSON.stringify(['a', 'b']), JSON.stringify(r.value.tags))
  check('slug 归一化为小写连字符', V({ slug: 'No_Explanatory Text' }).value.slug === 'no-explanatory-text', JSON.stringify(V({ slug: 'No_Explanatory Text' })))
}

console.log('\n== confidence 是只读字段 ==')
{
  const r = V({ title: 't', body: 'b', confidence: 0.9 })
  check('经编辑接口传 confidence 被拒绝', !r.ok && r.errors.some((e) => e.startsWith('confidence:')), JSON.stringify(r.errors))
  check('不传时不出现在结果里', !('confidence' in V({ title: 't', body: 'b' }).value))
}

console.log('\n== 未知字段被忽略 ==')
{
  const r = V({ title: 't', body: 'b', evil: 'should not pass' })
  check('未知字段不进结果', r.ok && !('evil' in r.value), JSON.stringify(r.value))
}

console.log('\n== 逐字段拒绝 ==')
const REJECTS = [
  ['空标题', { title: '   ', body: 'b' }, 'title'],
  ['标题非字符串', { title: 123, body: 'b' }, 'title'],
  ['空正文', { title: 't', body: '  ' }, 'body'],
  ['非法 type', { title: 't', body: 'b', type: 'nonsense' }, 'type'],
  ['tags 非数组', { title: 't', body: 'b', tags: 'a,b' }, 'tags'],
  ['tags 含非字符串项', { title: 't', body: 'b', tags: ['a', 3] }, 'tags'],
  ['tags 含逗号（会破坏内联数组语法）', { title: 't', body: 'b', tags: ['a,b'] }, 'tags'],
  ['tags 含右方括号', { title: 't', body: 'b', tags: ['a]b'] }, 'tags'],
  ['标题超长', { title: 'x'.repeat(201), body: 'b' }, 'title'],
  ['tags 超过 20 个', { title: 't', body: 'b', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, 'tags'],
]
for (const [label, input, field] of REJECTS) {
  const r = V(input)
  const mentions = r.errors.some((e) => e.startsWith(`${field}:`))
  check(`拒绝 ${label}`, !r.ok && mentions, `ok=${r.ok} errors=${JSON.stringify(r.errors)}`)
}

console.log('\n== 非对象 payload ==')
for (const bad of [null, [], 'str', 42]) {
  const r = V(bad)
  check(`拒绝 ${JSON.stringify(bad)}`, !r.ok && r.errors.length > 0, JSON.stringify(r.errors))
}

console.log('\n== 落盘格式不被 UI 编辑破坏 ==')
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-fmt-'))
  const memoryDir = path.join(tmp, '.dsh-memory')
  try {
    const file = mod.writeMemory(memoryDir, {
      slug: 'first-name',
      title: '原始标题',
      body: '原始正文',
      type: 'project',
    })
    check('文件名来自英文 slug', path.basename(file, '.md') === 'first-name', path.basename(file))

    // 只改标题：文件名是独立标识，不该被中文标题牵动
    const afterTitle = mod.writeMemory(memoryDir, {
      id: 'first-name',
      title: '新标题',
      body: '新正文',
      type: 'feedback',
      tags: ['a', 'b'],
      confidence: 0.6,
    })
    check('只改标题不重命名', afterTitle === file, `${path.basename(file)} -> ${path.basename(afterTitle)}`)

    // 显式改 slug：重命名并删掉旧文件
    const renamedFile = mod.writeMemory(memoryDir, {
      id: 'first-name',
      slug: 'second-name',
      description: '中文说明留在摘要里',
    })
    check('显式改 slug 会重命名', path.basename(renamedFile, '.md') === 'second-name', path.basename(renamedFile))
    check('旧文件已被删除', !existsSync(file), file)
    const onDisk = readdirSync(memoryDir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md')
    check('目录里只剩一条记忆，没留重复', onDisk.length === 1, JSON.stringify(onDisk))

    const raw = readFileSync(renamedFile, 'utf8')
    check('frontmatter 以 --- 开头', raw.startsWith('---\n'), raw.slice(0, 20))
    check('frontmatter 正常闭合', raw.split('---').length >= 3, `${raw.split('---').length} 段`)
    check('name 与文件名一致', raw.includes('name: second-name'), raw.slice(0, 300))
    check('title 保留中文标题', raw.includes('title: 新标题'), raw.slice(0, 300))
    check('description 是中文摘要', raw.includes('description: 中文说明留在摘要里'), raw.slice(0, 300))
    check('type 已更新', raw.includes('type: feedback'), raw.slice(0, 300))
    check('tags 写成内联数组', raw.includes('tags: [a, b]'), raw.slice(0, 300))
    check('created 被保留（未被覆盖成新时间）', /created: \d{4}-/.test(raw), raw.slice(0, 400))

    const parsed = mod.parseFrontmatter(raw)
    check('重新解析 type 正确', parsed.data.type === 'feedback', JSON.stringify(parsed.data))
    check('重新解析 tags 正确', JSON.stringify(parsed.data.tags) === JSON.stringify(['a', 'b']), JSON.stringify(parsed.data.tags))

    // MEMORY.md：英文在前（链接文字由 slug 还原）、中文说明在后
    const index = readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')
    check('索引是 # Memory Index', index.startsWith('# Memory Index'), index.slice(0, 80))
    check(
      '索引行 = [英文名](英文文件.md) — 中文摘要',
      /^- \[Second name\]\(second-name\.md\) — 中文说明留在摘要里$/m.test(index),
      index,
    )
    check('索引里不出现中文文件名', !/\]\([^)]*[\u4e00-\u9fff][^)]*\.md\)/.test(index), index)

    console.log(`\n  实际文件内容：\n${raw.split('\n').map((l) => `    ${l}`).join('\n')}`)
    console.log(`\n  实际 MEMORY.md：\n${index.split('\n').map((l) => `    ${l}`).join('\n')}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
