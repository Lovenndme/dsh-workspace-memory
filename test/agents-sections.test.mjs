/**
 * 全局 AGENTS.md 的章节读写。
 *
 * 全部使用隔离临时文件：configure({ agentsFile }) 指向临时路径，不读写真实的 ~/.dsh/AGENTS.md。
 *
 * 最关键的两条不变量：
 *   1. **只改目标章节**——其余章节必须逐字保留（否则用户手写的内容会被悄悄改写）。
 *   2. **编号始终连续**——删/增一章后 `## N.` 与 `### N.M` 要重排，符合文件既有约定。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mod = await import('../index.js')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const SAMPLE = [
  '# 全局工作约定',
  '',
  '适用于所有项目。',
  '',
  '## 1. 第一章',
  '',
  '1. 甲。',
  '2. 乙。',
  '',
  '## 2. 第二章',
  '',
  '### 2.1 子节',
  '',
  '内容 A。',
  '',
  '### 2.2 子节',
  '',
  '内容 B。',
  '',
  '## 3. 第三章',
  '',
  '末尾内容。',
  '',
].join('\n')

function makeEnv(text = SAMPLE) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-agents-'))
  const file = path.join(root, 'AGENTS.md')
  writeFileSync(file, text, 'utf8')
  mod.configure({ agentsFile: file })
  return { root, file, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

console.log('== 解析：只有 ## 成章，### 归入所在章 ==')
{
  const parsed = mod.parseAgentsSections(SAMPLE)
  check('识别 3 章（三个 ##）', parsed.blocks.length === 3, String(parsed.blocks.length))
  check('前言含文档标题与说明', parsed.preamble.join('\n').includes('# 全局工作约定'), parsed.preamble.join('|'))
  check('第 2 章跨到第 3 章之前', parsed.blocks[1].title.startsWith('2.') && parsed.blocks[1].end === parsed.blocks[2].start, `${parsed.blocks[1].start}-${parsed.blocks[1].end}`)
  const chapter2Body = parsed.lines.slice(parsed.blocks[1].start + 1, parsed.blocks[1].end).join('\n')
  check('第 2 章的正文包含它的子节', chapter2Body.includes('### 2.1 子节') && chapter2Body.includes('内容 B。'), chapter2Body.slice(0, 60))
}

console.log('\n== 编号重排 ==')
{
  const input = ['## 9. 甲', '', '### 9.7 子', '', '## 4. 乙', '']
  const out = mod.renumberAgentsLines(input)
  check('章号从头连续', out[0] === '## 1. 甲' && out[4] === '## 2. 乙', out.join(' / '))
  check('子号跟随所在章', out[2] === '### 1.1 子', out[2])
}

console.log('\n== 保存一章：只动目标章 ==')
{
  const env = makeEnv()
  try {
    const before = readFileSync(env.file, 'utf8')
    const result = mod.saveAgentsSection(0, { title: '第一章（改过）', body: '1. 新的甲。' })
    check('保存成功', result.ok === true, JSON.stringify(result))
    const after = readFileSync(env.file, 'utf8')

    check('新标题已写入', after.includes('## 1. 第一章（改过）'), after.slice(0, 200))
    check('新正文已写入', after.includes('1. 新的甲。'))
    check('旧正文已移除', !after.includes('2. 乙。'))
    // 其余章节逐字对比
    const restBefore = before.slice(before.indexOf('## 2. 第二章'))
    const restAfter = after.slice(after.indexOf('## 2. 第二章'))
    check('其它章节逐字未变', restBefore === restAfter, `${restBefore.length} vs ${restAfter.length}`)
    check('前言未变', after.startsWith('# 全局工作约定\n\n适用于所有项目。'), after.slice(0, 40))
    // 块边界不含分隔空行；若不补，上一章最后一行会和 `## 下一章` 粘在一起（标题失效）
    check('章之间有空行', !/[^\n]\n## \d+\./.test(after), after.slice(0, 300))
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 删除一章：连同子节，编号重排 ==')
{
  const env = makeEnv()
  try {
    const result = mod.deleteAgentsSection(1) // 第二章（含 2.1 / 2.2）
    check('删除成功', result.ok === true, JSON.stringify(result))
    const after = readFileSync(env.file, 'utf8')
    check('第二章标题已消失', !after.includes('## 2. 第二章'))
    check('它的子节也一起消失', !after.includes('### 2.1') && !after.includes('内容 A。'))
    check('第三章变成第二章', after.includes('## 2. 第三章'), after)
    check('没有留下 1、3 断号', !/^## 3\./m.test(after))
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 子节不能单独删（它不是独立章）==')
{
  const env = makeEnv()
  try {
    const doc = mod.readAgentsDocument()
    check('章节列表里没有 ### 子节', doc.sections.every((s) => !s.title.startsWith('2.1')), doc.sections.map((s) => s.title).join(' / '))
    const result = mod.deleteAgentsSection(1) // 第 2 章（含两个子节）
    check('删整章时子节一起走', result.ok === true && !readFileSync(env.file, 'utf8').includes('### 2.1'), JSON.stringify(result))
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 追加一章：编号顺延、正文标题下沉 ==')
{
  const env = makeEnv()
  try {
    const result = mod.appendAgentsSection({ title: '第四章', body: '## 子块\n\n正文。' })
    check('追加成功', result.ok === true, JSON.stringify(result))
    const after = readFileSync(env.file, 'utf8')
    check('编号顺延为 4', after.includes('## 4. 第四章'), after.slice(-200))
    check('正文 ## 下沉成 ### 且带 4.x 编号', after.includes('### 4.1 子块'), after.slice(-200))
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 追加重名被拒绝 ==')
{
  const env = makeEnv()
  try {
    const result = mod.appendAgentsSection({ title: '第一章', body: '重复内容' })
    check('拒绝同名', result.ok === false && result.reason === 'already-present', JSON.stringify(result))
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 字节预算：超限拒写 ==')
{
  const env = makeEnv()
  try {
    // AGENTS.md 是每轮注入的常驻成本，不是免费存储。上限设成「当前 + 10 字节」，
    // 追加一章必然超限 —— 此时必须拒写，而不是悄悄把文件撑大。
    const size = Buffer.byteLength(SAMPLE, 'utf8')
    mod.configure({ agentsFile: env.file, maxAgentsBytes: size + 10 })
    const before = readFileSync(env.file, 'utf8')

    const added = mod.appendAgentsSection({ title: '撑爆预算的一章', body: '正文。' })
    check('拒绝追加', added.ok === false && added.reason === 'agents-full', JSON.stringify(added))
    check('报出超限字节与上限', added.bytes > added.limit && added.limit === size + 10, JSON.stringify({ bytes: added.bytes, limit: added.limit }))
    check('文件未被改动', readFileSync(env.file, 'utf8') === before)

    // 删除是缩小，不该被预算拦住
    const removed = mod.deleteAgentsSection(2)
    check('删除不受预算限制', removed.ok === true, JSON.stringify(removed))
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 上限设为 0 = 不限制 ==')
{
  const env = makeEnv()
  try {
    mod.configure({ agentsFile: env.file, maxAgentsBytes: 0 })
    const added = mod.appendAgentsSection({ title: '不限制也能写', body: '正文。' })
    check('照常追加', added.ok === true, JSON.stringify(added))
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 写前留档 ==')
{
  const env = makeEnv()
  try {
    const before = readFileSync(env.file, 'utf8')
    mod.saveAgentsSection(0, { title: '改了', body: '正文' })
    // 非真实路径的留档落在目标文件旁边的 .agents-history/；断言真实 ~/.dsh 下的历史会因为它
    // 早就存在而空过（上一版就是这样），所以只看临时文件自己的这个目录。
    const histDir = path.join(env.root, '.agents-history')
    check('历史目录存在', existsSync(histDir), histDir)
    const backups = existsSync(histDir) ? readdirSync(histDir) : []
    check('恰好留了一份档', backups.length === 1, JSON.stringify(backups))
    check('留档内容是写入前的原文', backups.length === 1 && readFileSync(path.join(histDir, backups[0]), 'utf8') === before)
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 目标文件不存在时明确失败 ==')
{
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-agents-'))
  try {
    mod.configure({ agentsFile: path.join(root, 'missing.md') })
    const doc = mod.readAgentsDocument()
    check('readAgentsDocument 报 agents-missing', doc.ok === false && doc.reason === 'agents-missing', JSON.stringify(doc))
    const saved = mod.saveAgentsSection(0, { title: 't', body: 'b' })
    check('saveAgentsSection 报 agents-missing', saved.ok === false && saved.reason === 'agents-missing', JSON.stringify(saved))
  } finally {
    rmSync(root, { recursive: true, force: true })
    mod.configure(undefined)
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
