/**
 * 全局 AGENTS.md 读写的格式回归测试（代码评审后的修复）。
 *
 *   · 围栏代码块（``` / ~~~）里的行不是标题：解析、重排编号、下沉标题、压空行都要跳过
 *   · 重排编号只认 `## N.` 与 `### N.M`，`### 5 Whys` 这类标题内容不被吃掉
 *   · 没碰过的章逐字保留；换行风格（CRLF）沿用原文件
 *   · promote 走 appendAgentsSection：带编号的同名也拒绝、字节预算与写前留档都生效
 *   · 超预算的文件允许缩小的写入；按章号写/删时可带 expectedTitle 防序号过期
 *
 * 全部使用隔离临时文件：configure({ agentsFile }) 指向临时路径，不读写真实的 ~/.dsh/AGENTS.md。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
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

function makeEnv(text, config = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-agents-fmt-'))
  const file = path.join(root, 'AGENTS.md')
  writeFileSync(file, text, 'utf8')
  mod.configure({ agentsFile: file, ...config })
  return {
    root,
    file,
    memoryDir: path.join(root, 'memory'),
    historyDir: path.join(root, '.agents-history'),
    read: () => readFileSync(file, 'utf8'),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
      mod.configure(undefined)
    },
  }
}

const FENCE = '```'
const SAMPLE = ['# 全局工作约定', '', '## 1. 第一章', '', '内容甲。', '', '## 2. 第二章', '', '### 2.1 子节', '', '内容乙。', '', '## 3. 第三章', '', '内容丙。', ''].join('\n')

console.log('== 围栏感知：围栏里的 `## ` 不成章 ==')
{
  const doc = ['# 标题', '', '## 1. 真章', '', `${FENCE}md`, '## 2. 示例标题（在围栏里）', '### 1.1 示例子标题', FENCE, '', '## 2. 下一章', '', '内容。', ''].join('\n')
  const titles = mod.parseAgentsSections(doc).blocks.map((b) => b.title)
  check('只识别 2 个真章', JSON.stringify(titles) === JSON.stringify(['1. 真章', '2. 下一章']), JSON.stringify(titles))

  const tilde = ['## 1. A', '~~~', '## 2. 波浪线围栏里', '~~~', '## 2. B'].join('\n')
  check('~~~ 围栏同样跳过', mod.parseAgentsSections(tilde).blocks.length === 2)

  const nested = ['## 1. A', '````', FENCE, '## 9. 内层围栏之后仍在外层围栏里', FENCE, '````', '## 2. B'].join('\n')
  check('长围栏里的短围栏不收栏', mod.parseAgentsSections(nested).blocks.length === 2, JSON.stringify(mod.parseAgentsSections(nested).blocks.map((b) => b.title)))

  const env = makeEnv(doc)
  try {
    check('agentsStatus.sections 与解析一致', mod.agentsStatus().sections === 2, String(mod.agentsStatus().sections))
    const sections = mod.readAgentsDocument().sections
    check('readAgentsDocument 的章清单没有围栏里的假章', sections.length === 2 && sections[0].body.includes('## 2. 示例标题（在围栏里）'), JSON.stringify(sections.map((s) => s.title)))
    // 删除真正的第 1 章：围栏跟着它一起走，不会留下半个围栏
    const removed = mod.deleteAgentsSection(0)
    check('删第 1 章成功', removed.ok === true && removed.removed === '1. 真章', JSON.stringify(removed))
    check('围栏没有被劈开（不留下孤立的 ```）', !env.read().includes(FENCE), env.read())
    check('剩下的章重排成第 1 章', env.read().includes('## 1. 下一章'), env.read())
  } finally {
    env.cleanup()
  }
}

console.log('\n== 重排编号：只认 `## N.` / `### N.M`，围栏里不动 ==')
{
  const out = mod.renumberAgentsLines([
    '## 5. A',
    '### 5 Whys',
    '### 2024 roadmap',
    '### 9.9 子节',
    FENCE,
    '## 7. 围栏里的',
    '### 3.3 围栏里的',
    FENCE,
    '## 8. B',
    '### 1.1 x',
    '### 1.2 y',
  ])
  check('章号连续', out[0] === '## 1. A' && out[9 - 0] === '### 2.1 x' && out[8] === '## 2. B', JSON.stringify(out))
  check('`### 5 Whys` 保持原样', out[1] === '### 5 Whys', out[1])
  check('`### 2024 roadmap` 保持原样', out[2] === '### 2024 roadmap', out[2])
  check('N.M 子号跟随所在章，且不计入非编号标题', out[3] === '### 1.1 子节', out[3])
  check('围栏里的编号原样保留', out[5] === '## 7. 围栏里的' && out[6] === '### 3.3 围栏里的', JSON.stringify(out.slice(4, 8)))
  check('子号在新章里从 1 重新开始', out[9] === '### 2.1 x' && out[10] === '### 2.2 y', JSON.stringify(out.slice(8)))
}

console.log('\n== 追加：围栏里的 `#` 注释不被下沉/编号，围栏内空行不被压；围栏外照常整理 ==')
{
  const env = makeEnv(SAMPLE)
  try {
    const inner = ['# install deps', 'pnpm i', '', '', '## two', 'pnpm build']
    const body = ['## 子块', '', `${FENCE}bash`, ...inner, FENCE, '', '', '', '结尾。', '# 顶级标题'].join('\n')
    const result = mod.appendAgentsSection({ title: '命令集', body })
    check('追加成功', result.ok === true, JSON.stringify(result))
    const text = env.read()
    check('围栏内容逐字保留（含 `#`、`##`、连续空行）', text.includes(`${FENCE}bash\n${inner.join('\n')}\n${FENCE}`), text.slice(-260))
    check('围栏外的 `## 子块` 下沉并编号', text.includes('### 4.1 子块'), text.slice(-260))
    check('围栏外的 `# 顶级标题` 下沉并编号', text.includes('### 4.2 顶级标题'), text.slice(-260))
    check('围栏里没有冒出编号标题', !/^### 4\.\d (install deps|two)/m.test(text))
    check('围栏外的连续空行被压成一个', /\n\n结尾。/.test(text) && !/\n\n\n结尾。/.test(text), JSON.stringify(text.slice(-120)))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 没碰过的章逐字保留：不压它们的空行、不动它们的围栏 ==')
{
  const messy = ['# 前言', '', '## 1. 带空行的章', '', '段一。', '', '', '', '段二（上面隔了三个空行）。', '', `${FENCE}`, '行一', '', '', '', '行二（围栏里隔了三个空行）', FENCE, '', '## 2. 要被删的章', '', '内容。', '', '## 3. 另一章', '', '尾部。', ''].join('\n')
  const env = makeEnv(messy)
  try {
    const before = env.read()
    const chapterOne = before.slice(before.indexOf('## 1.'), before.indexOf('## 2.'))
    const chapterThree = before.slice(before.indexOf('## 3.'))
    const result = mod.deleteAgentsSection(1)
    check('删除成功', result.ok === true, JSON.stringify(result))
    const after = env.read()
    check('第 1 章逐字未变（空行没被压）', after.includes(chapterOne), JSON.stringify(after.slice(0, 200)))
    check('原第 3 章只有章号变了', after.includes(chapterThree.replace('## 3.', '## 2.')), JSON.stringify(after.slice(-80)))
    check('前言未变', after.startsWith('# 前言\n\n## 1. 带空行的章'))
  } finally {
    env.cleanup()
  }
}

console.log('\n== promote 走 appendAgentsSection：同名（带编号）拒绝、围栏里的假同名不算 ==')
{
  const env = makeEnv(['# 全局', '', '## 1. 已有章', '', '内容。', '', `${FENCE}md`, '## 2. 假同名', FENCE, ''].join('\n'))
  try {
    mod.writeMemory(env.memoryDir, { slug: 'dup', title: '已有章', description: '摘要', scope: 'global', body: '新内容。' })
    const before = env.read()
    const dup = mod.promoteToAgents(env.memoryDir, 'dup')
    check('带编号的同名章：拒绝 already-present', dup.ok === false && dup.reason === 'already-present', JSON.stringify(dup))
    check('文件未改、记忆仍在', env.read() === before && existsSync(path.join(env.memoryDir, 'dup.md')))

    mod.writeMemory(env.memoryDir, { slug: 'fake', title: '假同名', description: '摘要', scope: 'global', body: '围栏里那个不是章，所以这条可以写入。' })
    const fake = mod.promoteToAgents(env.memoryDir, 'fake')
    check('与围栏里的 `## 2. 假同名` 同名：照常写入', fake.ok === true, JSON.stringify(fake))
    const text = env.read()
    check('写成第 2 章（围栏里的那个不算章）', /^## 2\. 假同名$/m.test(text), text)
    check('带来源注释，且在章末', /<!-- 来自记忆 fake，写入于 \d{4}-\d{2}-\d{2} -->\n$/.test(text), JSON.stringify(text.slice(-90)))
    check('返回体积信息', fake.addedBytes > 0 && fake.totalBytes === Buffer.byteLength(text, 'utf8') && fake.memoryRemoved === true, JSON.stringify(fake))
  } finally {
    env.cleanup()
  }
}

console.log('\n== promote 受字节预算约束，并写前留档 ==')
{
  const env = makeEnv(SAMPLE, { maxAgentsBytes: Buffer.byteLength(SAMPLE, 'utf8') + 20 })
  try {
    mod.writeMemory(env.memoryDir, { slug: 'big', title: '很长的一条', description: '摘要', scope: 'global', body: '正文。'.repeat(80) })
    const before = env.read()
    const refused = mod.promoteToAgents(env.memoryDir, 'big')
    check('超预算：拒绝 agents-full 并报出字节', refused.ok === false && refused.reason === 'agents-full' && refused.bytes > refused.limit, JSON.stringify(refused))
    check('文件未改、记忆仍在、没有留档', env.read() === before && existsSync(path.join(env.memoryDir, 'big.md')) && !existsSync(env.historyDir))

    mod.configure({ agentsFile: env.file })
    mod.writeMemory(env.memoryDir, { slug: 'small', title: '很短的一条', description: '摘要', scope: 'global', body: '一句话。' })
    const ok = mod.promoteToAgents(env.memoryDir, 'small')
    check('预算内：写入成功', ok.ok === true, JSON.stringify(ok))
    const backups = existsSync(env.historyDir) ? readdirSync(env.historyDir) : []
    check('写前留了一份档（临时文件旁的 .agents-history/）', backups.length === 1, JSON.stringify(backups))
    check('留档内容是写入前的原文', backups.length === 1 && readFileSync(path.join(env.historyDir, backups[0]), 'utf8') === before)
    check('没有 .tmp 残留', readdirSync(env.root).every((name) => !name.endsWith('.tmp')))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 超预算的文件：允许缩小的写入，拒绝变大的写入 ==')
{
  const big = ['# 大文件', '', '## 1. 甲', '', '甲'.repeat(120), '', '## 2. 乙', '', '乙'.repeat(120), '', '## 3. 丙', '', '丙'.repeat(120), ''].join('\n')
  const size = Buffer.byteLength(big, 'utf8')
  const env = makeEnv(big, { maxAgentsBytes: size - 400 }) // 已经远超上限
  try {
    const grow = mod.appendAgentsSection({ title: '再加一章', body: '更多内容。' })
    check('变大：拒绝 agents-full', grow.ok === false && grow.reason === 'agents-full', JSON.stringify(grow))
    const longer = mod.saveAgentsSection(0, { title: '甲', body: '甲'.repeat(300) })
    check('改长：拒绝', longer.ok === false && longer.reason === 'agents-full', JSON.stringify(longer))
    const shorter = mod.saveAgentsSection(0, { title: '甲', body: '甲'.repeat(10) })
    check('改短（仍超上限）：放行', shorter.ok === true, JSON.stringify(shorter))
    const removed = mod.deleteAgentsSection(1)
    check('删一章（仍超上限）：放行', removed.ok === true, JSON.stringify(removed))
    check('文件确实变小了', Buffer.byteLength(env.read(), 'utf8') < size)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 保存已有章：`#` / `##` 压到 `###`，已规范的 `###` 不再下沉，保存幂等 ==')
{
  const env = makeEnv(SAMPLE)
  try {
    const before = env.read()
    const doc = mod.readAgentsDocument()
    const second = doc.sections[1]
    const same = mod.saveAgentsSection(1, { title: second.title, body: second.body })
    check('原样保存成功', same.ok === true, JSON.stringify(same))
    check('原样保存不改变文件（`### 2.1` 没被压成 `####`）', env.read() === before, env.read())

    const result = mod.saveAgentsSection(0, { title: '第一章', body: ['介绍。', '## 新子块', '更多。', '# 顶级', '### 保持三级', '#### 保持四级', `${FENCE}sh`, '# 注释', FENCE].join('\n') })
    check('保存成功', result.ok === true, JSON.stringify(result))
    const text = env.read()
    check('正文里的 `##` 压成 `###`，没有变成新章', mod.parseAgentsSections(text).blocks.length === 3 && /^### 新子块$/m.test(text), text)
    check('`#` 压成 `###`', /^### 顶级$/m.test(text))
    check('已是 `###` / `####` 的保持原级', /^### 保持三级$/m.test(text) && /^#### 保持四级$/m.test(text))
    check('围栏里的 `# 注释` 不动', text.includes(`${FENCE}sh\n# 注释\n${FENCE}`))

    const doc2 = mod.readAgentsDocument().sections[0]
    mod.saveAgentsSection(0, { title: doc2.title, body: doc2.body })
    const afterOnce = env.read()
    const doc3 = mod.readAgentsDocument().sections[0]
    mod.saveAgentsSection(0, { title: doc3.title, body: doc3.body })
    check('再保存两次结果不变（幂等）', env.read() === afterOnce)
  } finally {
    env.cleanup()
  }
}

console.log('\n== upsert 按章号更新：正文里的 `##` 同样不成新章 ==')
{
  const env = makeEnv(SAMPLE)
  try {
    const result = mod.upsertAgentsChapter({ chapter: 1, title: '第一章', body: '介绍\n## 子标题\n更多' })
    check('更新成功', result.ok === true && result.action === 'updated', JSON.stringify(result))
    check('章数不变', mod.parseAgentsSections(env.read()).blocks.length === 3)
    check('子标题成了 `###`', /^### 子标题$/m.test(env.read()))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 换行风格沿用原文件 ==')
{
  const crlf = SAMPLE.replace(/\n/g, '\r\n')
  const env = makeEnv(crlf)
  try {
    const saved = mod.saveAgentsSection(0, { title: '第一章（改）', body: '新内容。\n第二行。' })
    check('保存成功', saved.ok === true, JSON.stringify(saved))
    const text = env.read()
    check('CRLF 仍是 CRLF（没有裸 LF）', text.includes('\r\n') && !/(?<!\r)\n/.test(text), JSON.stringify(text.slice(0, 80)))
    const appended = mod.appendAgentsSection({ title: '新章', body: '正文。' })
    check('追加后仍无裸 LF', appended.ok === true && !/(?<!\r)\n/.test(env.read()))
    const removed = mod.deleteAgentsSection(0)
    check('删除后仍无裸 LF', removed.ok === true && !/(?<!\r)\n/.test(env.read()))
  } finally {
    env.cleanup()
  }
  const lfEnv = makeEnv(SAMPLE)
  try {
    mod.saveAgentsSection(0, { title: '第一章', body: '新内容。' })
    check('LF 文件保持 LF（不引入 \\r）', !lfEnv.read().includes('\r'))
  } finally {
    lfEnv.cleanup()
  }
}

console.log('\n== 按章号写/删：invalid-index 与 expectedTitle（序号过期保护）==')
{
  const env = makeEnv(SAMPLE)
  try {
    const before = env.read()
    for (const bad of [-1, 1.5, '1', NaN, undefined, null, Infinity]) {
      const saved = mod.saveAgentsSection(bad, { title: 't', body: 'b' })
      const deleted = mod.deleteAgentsSection(bad)
      check(`index=${String(bad)}：两个入口都 invalid-index`, saved.ok === false && saved.reason === 'invalid-index' && deleted.ok === false && deleted.reason === 'invalid-index', JSON.stringify([saved, deleted]))
    }
    check('越界仍是 section-not-found', mod.saveAgentsSection(9, { title: 't', body: 'b' }).reason === 'section-not-found' && mod.deleteAgentsSection(9).reason === 'section-not-found')
    check('以上都没改文件', env.read() === before)

    // 面板里「第 2 章」的序号已过期：别处刚删了第 1 章，现在第 2 章是原来的第 3 章
    const stale = mod.deleteAgentsSection(1, { expectedTitle: '2. 第二章' })
    check('标题对得上：删除放行', stale.ok === true && stale.removed === '2. 第二章', JSON.stringify(stale))
    const after = env.read() // 现在：1. 第一章 / 2. 第三章
    const moved = mod.deleteAgentsSection(1, { expectedTitle: '第二章' })
    check('序号过期：拒绝 section-moved，且带上实际标题', moved.ok === false && moved.reason === 'section-moved' && moved.actualTitle === '第三章', JSON.stringify(moved))
    const movedSave = mod.saveAgentsSection(1, { title: '被误改的章', body: 'x', expectedTitle: '2. 第二章' })
    check('保存同样拒绝 section-moved', movedSave.ok === false && movedSave.reason === 'section-moved', JSON.stringify(movedSave))
    check('拒绝后文件没变', env.read() === after)

    const okByBare = mod.saveAgentsSection(1, { title: '第三章（改）', body: '改了。', expectedTitle: '第三章' })
    check('expectedTitle 不带编号也能对上', okByBare.ok === true, JSON.stringify(okByBare))
    const noExpected = mod.saveAgentsSection(0, { title: '第一章（再改）', body: '又改了。' })
    check('不传 expectedTitle：照旧工作（向后兼容）', noExpected.ok === true, JSON.stringify(noExpected))
    check('非字符串 expectedTitle 被忽略', mod.saveAgentsSection(0, { title: '第一章', body: 'z', expectedTitle: 42 }).ok === true)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 标题的单行化与空标题 ==')
{
  const env = makeEnv(SAMPLE)
  try {
    const added = mod.appendAgentsSection({ title: '两行\n## 注入的章', body: '正文。' })
    check('标题里的换行折成空格，不会冒出新章', added.ok === true && mod.parseAgentsSections(env.read()).blocks.length === 4 && env.read().includes('## 4. 两行 ## 注入的章'), env.read().slice(-100))
    check('只有编号的标题视为空', mod.appendAgentsSection({ title: '3.', body: 'x' }).reason === 'empty-title' && mod.saveAgentsSection(0, { title: ' 1. ', body: 'x' }).reason === 'empty-title')
  } finally {
    env.cleanup()
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
