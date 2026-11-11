/**
 * 存储层加固的回归测试（代码评审后的修复）。
 *
 *   · id 不能逃出记忆目录（读 / 写 / 删 / 留档 / 草稿处置）
 *   · frontmatter 读写互逆（引号、方括号、逗号、换行、BOM），旧文件解析结果不变
 *   · 更新时保留 hits / lastHit / 未知键；slug 判重不分大小写
 *   · 草稿 id 不撞、supersedes 落盘并在收下时执行、收下受条数硬限
 *   · parseExtractionJson 容错、抽取墙钟超时
 *   · 缓存只回收本目录、description 取首个非标题行、原子写不留临时文件
 *   · projectRootFor 大小写、detectEditors 记忆化、openAgentsFile 不因子进程错误崩溃
 *
 * 全部使用隔离临时目录；AGENTS.md 一律指向临时文件，绝不碰真实的 ~/.dsh。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
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

/** root 扮演 ~/.dsh：记忆库在 root/projects/--x--/memory，所以 `../../../X` 恰好指到 root/X。 */
function makeEnv(extraConfig = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-harden-'))
  const memoryDir = path.join(root, 'projects', '--x--', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const agentsFile = path.join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 临时全局文件\n\n## 1. 不能被动的章\n\n内容。\n', 'utf8')
  mod.configure({ agentsFile, historyLimit: 20, ...extraConfig })
  return {
    root,
    memoryDir,
    agentsFile,
    stateDir: path.join(root, 'projects', '--x--', '.memory-state'),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
      mod.configure(undefined)
    },
  }
}

/** 整棵树的快照（路径 + 内容 + 目录），用来断言「没有任何文件被碰过」。 */
function snapshot(dir) {
  const out = {}
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const rel = path.relative(dir, full)
      if (entry.isDirectory()) {
        out[`${rel}/`] = 1
        walk(full)
      } else out[rel] = readFileSync(full, 'utf8')
    }
  }
  walk(dir)
  return JSON.stringify(out)
}

const REAL_IDS = [
  'Codex-子智能体需替换包内-codex.exe（0.153.4-不认-gpt-6.1-sol）',
  '本地验收-DSH-Web-插件面板：先用-authenticatedUrl-生成带凭据的-GUI-地址',
]

/* ------------------------------------------------------------ 1. id 安全 */

console.log('== isSafeId：真实 id 放行，路径逃逸与非法字符拒绝 ==')
{
  for (const id of ['a', 'no-explanatory-text-in-ui', 'with.dots.inside', '..x', 'a b', '规则：全角冒号可以', ...REAL_IDS]) {
    check(`放行 ${JSON.stringify(id)}`, mod.isSafeId(id) === true)
  }
  const rejects = [
    ['空串', ''],
    ['.', '.'],
    ['..', '..'],
    ['../x', '../x'],
    ['..\\x', '..\\x'],
    ['a/b', 'a/b'],
    ['a\\b', 'a\\b'],
    ['a:b（ASCII 冒号）', 'a:b'],
    ['a*b', 'a*b'],
    ['a?b', 'a?b'],
    ['a"b', 'a"b'],
    ['a<b', 'a<b'],
    ['a>b', 'a>b'],
    ['a|b', 'a|b'],
    ['NUL 控制字符', 'a\u0000b'],
    ['换行', 'a\nb'],
    ['DEL', 'a\u007fb'],
    ['前导空白', ' lead'],
    ['尾随空白', 'trail '],
    ['全角空格结尾', 'trail\u3000'],
    ['结尾的点', 'dot.'],
    ['超过 200 字符', 'x'.repeat(201)],
  ]
  for (const [label, id] of rejects) check(`拒绝 ${label}`, mod.isSafeId(id) === false, JSON.stringify(id))
  check('200 字符整正好放行', mod.isSafeId('x'.repeat(200)) === true)
  for (const bad of [undefined, null, 42, {}, ['a']]) check(`拒绝非字符串 ${JSON.stringify(bad)}`, mod.isSafeId(bad) === false)
}

console.log('\n== 路径逃逸：任何入口都不能碰库外文件，也不创建库外目录 ==')
{
  const env = makeEnv()
  try {
    // 库外的「诱饵」：memory/../../../AGENTS.md 就是 root/AGENTS.md（扮演 ~/.dsh/AGENTS.md）
    writeFileSync(path.join(env.root, 'projects', 'notes.md'), '库外的笔记\n', 'utf8')
    mod.writePending(env.memoryDir, { id: 'dr_keep', title: '留着', body: '草稿' })
    mod.writeMemory(env.memoryDir, { slug: 'inside', title: '库内', body: '库内正文' })
    const before = snapshot(env.root)

    const evil = ['../../../AGENTS', '../../notes', '..\\..\\..\\AGENTS', '../x', 'a/../../b', 'C:\\Windows\\x', '..', '.']
    for (const id of evil) {
      check(`deleteMemory 拒绝 ${JSON.stringify(id)}`, mod.deleteMemory(env.memoryDir, id) === false)
      check(`listHistory 返回空 ${JSON.stringify(id)}`, mod.listHistory(env.memoryDir, id).length === 0)
      let threw = null
      try {
        mod.writeMemory(env.memoryDir, { id, title: 't', body: 'b' })
      } catch (error) {
        threw = error
      }
      check(`writeMemory 抛错而不是写文件 ${JSON.stringify(id)}`, threw instanceof Error && /不安全/.test(threw.message), String(threw))
      const accepted = await mod.acceptPending(env.memoryDir, id)
      check(`acceptPending invalid-id ${JSON.stringify(id)}`, accepted.ok === false && accepted.reason === 'invalid-id', JSON.stringify(accepted))
      const rejected = mod.rejectPending(env.memoryDir, id)
      check(`rejectPending invalid-id ${JSON.stringify(id)}`, rejected.ok === false && rejected.reason === 'invalid-id', JSON.stringify(rejected))
      let pendingThrew = false
      try {
        mod.writePending(env.memoryDir, { id, title: 't', body: 'b' })
      } catch {
        pendingThrew = true
      }
      check(`writePending 抛错 ${JSON.stringify(id)}`, pendingThrew)
      const promoted = mod.promoteToAgents(env.memoryDir, id)
      check(`promoteToAgents not-found ${JSON.stringify(id)}`, promoted.ok === false && promoted.reason === 'not-found', JSON.stringify(promoted))
    }
    check('整棵树没有任何变化（库外文件、history、pending 都没被碰）', snapshot(env.root) === before)
    check('扮演 ~/.dsh/AGENTS.md 的文件还在', existsSync(env.agentsFile))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 真实 id（CJK / 全角标点 / 点号）照常读写删并留档 ==')
{
  const env = makeEnv()
  try {
    for (const id of REAL_IDS) {
      writeFileSync(path.join(env.memoryDir, `${id}.md`), '---\nname: x\ntitle: 老记忆\n---\n\n旧正文\n', 'utf8')
      const file = mod.writeMemory(env.memoryDir, { id, body: '新正文' })
      check(`更新原地写回 ${id.slice(0, 12)}…`, path.basename(file, '.md') === id, path.basename(file))
      check('更新留了历史', mod.listHistory(env.memoryDir, id).length === 1)
      check('删除成功', mod.deleteMemory(env.memoryDir, id) === true)
      check('删除后历史有 2 份（更新前 + 删除前）', mod.listHistory(env.memoryDir, id).length === 2, String(mod.listHistory(env.memoryDir, id).length))
    }
  } finally {
    env.cleanup()
  }
}

console.log('\n== slugify 的产物永远是安全 id ==')
{
  for (const title of ['含 控制\u0007字符', '结尾是点...', `${'长'.repeat(120)}.`, 'a/b\\c:d*e?f"g<h>i|j', '  ', '\u0000', '..', 'CON', `${'😀'.repeat(60)}`]) {
    const slug = mod.slugify(title)
    check(`slugify(${JSON.stringify(title.slice(0, 16))}) 安全`, mod.isSafeId(slug), JSON.stringify(slug))
  }
}

/* ------------------------------------------------------------ 2. frontmatter */

console.log('\n== frontmatter：BOM、CRLF、引号、方括号、逗号、换行 ==')
{
  const withBom = mod.parseFrontmatter('\uFEFF---\nname: bom\ntitle: Has BOM\n---\n\nbody here\n')
  check('带 BOM 的文件照常解析', withBom.data.title === 'Has BOM' && withBom.body.trim() === 'body here', JSON.stringify(withBom))
  check('无 frontmatter 的 BOM 文本，body 也去掉 BOM', mod.parseFrontmatter('\uFEFFplain').body === 'plain')
  const crlf = mod.parseFrontmatter('---\r\nname: x\r\ntags: [a, b]\r\n---\r\n\r\nbody\r\n')
  check('CRLF 解析', crlf.data.name === 'x' && JSON.stringify(crlf.data.tags) === '["a","b"]', JSON.stringify(crlf.data))

  // 解析器的单点行为
  const p = (line) => mod.parseFrontmatter(`---\n${line}\n---\n`).data
  check('双引号 JSON 串解码', p('title: "a \\"quoted\\" b"').title === 'a "quoted" b', JSON.stringify(p('title: "a \\"quoted\\" b"')))
  check('双引号 \\n 解码成换行', p('title: "x\\ny"').title === 'x\ny')
  check("单引号 YAML 串的 '' 还原", p("title: 'it''s'").title === "it's")
  check('末尾的引号是内容，不单端剥', p('title: Don\'t use "foo"').title === 'Don\'t use "foo"', p('title: Don\'t use "foo"').title)
  check('开头的引号是内容，不单端剥', p('title: "foo bar').title === '"foo bar')
  check('不是合法 JSON 的双引号串：退回剥外层引号（旧行为）', p('title: "a" b "c"').title === 'a" b "c')
  check('`[WIP] Foo [x]` 是标量不是数组', p('title: [WIP] Foo [x]').title === '[WIP] Foo [x]', JSON.stringify(p('title: [WIP] Foo [x]')))
  check('`[a, b]` 仍是数组', JSON.stringify(p('key: [a, b]').key) === '["a","b"]')
  check('tags 里含 `]` 的旧写法仍按数组读（向后兼容）', JSON.stringify(p('tags: [a]b, c]').tags) === '["a]b","c"]', JSON.stringify(p('tags: [a]b, c]')))
  check('数组项按双引号整体读（逗号、括号在引号里不算）', JSON.stringify(p('paths: ["src/{a,b}.js", "x]y", plain]').paths) === '["src/{a,b}.js","x]y","plain"]', JSON.stringify(p('paths: ["src/{a,b}.js", "x]y", plain]').paths))
  check('空数组', JSON.stringify(p('tags: []').tags) === '[]')
  check('__proto__ 键被忽略', Object.keys(p('__proto__: [x]')).length === 0)
}

console.log('\n== 序列化：只在有歧义时才加 JSON 引号；读写互逆（确定性随机 + 精选用例）==')
{
  const env = makeEnv({ maxMemoryCount: 0, historyLimit: 0 })
  try {
    const oneLine = (t) => String(t ?? '').replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim()
    const roundTrip = (n, input) => {
      const slug = `rt-${n}`
      const file = mod.writeMemory(env.memoryDir, { slug, body: 'body', ...input })
      const item = mod.listMemories(env.memoryDir).find((m) => m.id === slug)
      return { item, raw: readFileSync(file, 'utf8') }
    }

    const curated = [
      '"Foo" bar "baz"',
      `Don't use "foo"`,
      '[WIP] Foo [x]',
      "'quoted'",
      'a: b # c',
      '# leading hash',
      '- dash item',
      'ends with colon:',
      '`tick`',
      '{ brace',
      '中文标题：全角冒号（括号）',
      '本地验收 DSH Web 插件面板：先用 authenticatedUrl 生成',
      '  padded  ',
    ]
    curated.forEach((title, i) => {
      const { item } = roundTrip(`c${i}`, { title, description: title })
      check(`标题/摘要往返 ${JSON.stringify(title)}`, item.meta.title === title.trim() && item.meta.description === title.trim(), JSON.stringify(item.meta.title))
    })

    const plain = roundTrip('plain', { title: '普通标题', description: '普通摘要，没有歧义' })
    check('无歧义的值保持裸写（旧文件格式不漂移）', plain.raw.includes('title: 普通标题\n') && plain.raw.includes('description: 普通摘要，没有歧义\n'), plain.raw.slice(0, 260))
    const quoted = roundTrip('quoted', { title: 'a: b', description: '[x] y' })
    check('有歧义的值加了 JSON 引号', quoted.raw.includes('title: "a: b"\n') && quoted.raw.includes('description: "[x] y"\n'), quoted.raw.slice(0, 260))

    // 标题/摘要是单行字段：换行折成一个空格
    const multi = roundTrip('multi', { title: 'line one\nline two\r\n---\nthree', description: 'x\ny: z' })
    check('标题里的换行折成空格', multi.item.meta.title === 'line one line two --- three', JSON.stringify(multi.item.meta.title))
    check('摘要里的换行折成空格，frontmatter 没被截断', multi.item.meta.description === 'x y: z' && multi.item.body === 'body', JSON.stringify(multi.item.meta))
    mod.writePending(env.memoryDir, { id: 'dr_multi', title: 'a\nb', description: 'c\n---\nd', body: '正文' })
    const draft = mod.listPending(env.memoryDir).find((d) => d.id === 'dr_multi')
    check('writePending 同样折叠换行', draft.meta.title === 'a b' && draft.meta.description === 'c --- d' && draft.body === '正文', JSON.stringify(draft.meta))

    // 数组：含逗号 / 括号 / 引号 / 首尾空白的项
    const arrays = roundTrip('arrays', {
      title: 't',
      tags: ['a,b', 'c]d', '[e]', 'say "hi"', ' edge ', 'plain', '#hash'],
      paths: ['src/**/*.{js,ts}', '**/*.test.js', 'C:\\dir\\file.js'],
    })
    check('tags 往返', JSON.stringify(arrays.item.meta.tags) === JSON.stringify(['a,b', 'c]d', '[e]', 'say "hi"', ' edge ', 'plain', '#hash']), JSON.stringify(arrays.item.meta.tags))
    check('paths（含花括号 glob、反斜杠）往返', JSON.stringify(arrays.item.meta.paths) === JSON.stringify(['src/**/*.{js,ts}', '**/*.test.js', 'C:\\dir\\file.js']), JSON.stringify(arrays.item.meta.paths))
    check('普通项仍裸写', arrays.raw.includes(', plain,'), arrays.raw.split('\n').find((l) => l.startsWith('tags:')))

    // 确定性随机往返
    const alphabet = [...'ab  :#"\'[],{}-\\\n\r\t中：&*!|>%@`?/.0', String.fromCharCode(0x2028), '\uFEFF', '\u00a0']
    let seed = 20261110
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
    const gen = (max) => Array.from({ length: Math.floor(rnd() * max) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('')
    const keep = (items) => JSON.stringify(items.filter((t) => t !== ''))
    let mismatches = 0
    let firstBad = ''
    for (let i = 0; i < 150; i += 1) {
      const title = `T${gen(14)}`
      const description = gen(14) || 'd'
      const tags = Array.from({ length: Math.floor(rnd() * 4) }, () => gen(8))
      const paths = Array.from({ length: Math.floor(rnd() * 3) }, () => gen(10))
      const { item } = roundTrip(`f${i}`, { title, description, tags, paths })
      const ok =
        item.meta.title === oneLine(title) &&
        item.meta.description === oneLine(description) &&
        JSON.stringify(item.meta.tags ?? []) === keep(tags) &&
        JSON.stringify(item.meta.paths ?? []) === keep(paths)
      if (!ok) {
        mismatches += 1
        firstBad ||= JSON.stringify({ title, description, tags, paths, got: item.meta })
      }
    }
    check('150 组随机标题/摘要/tags/paths 全部往返无损', mismatches === 0, firstBad)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 旧文件解析结果不变（向后兼容）==')
{
  const legacy = [
    ['普通标题', 'title: 普通标题', '普通标题'],
    ['全角冒号', 'title: 中文标题：全角冒号（括号）', '中文标题：全角冒号（括号）'],
    ['含 `: `', 'title: Foo: bar', 'Foo: bar'],
    ['含 ` #`', 'title: a # b', 'a # b'],
    ['整体双引号', 'title: "Done"', 'Done'],
    ['整体单引号', "title: 'Done'", 'Done'],
    ['时间戳', 'created: 2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z'],
    ['置信度', 'confidence: 0.8', '0.8'],
    ['空值', 'description: ', ''],
  ]
  for (const [label, line, expected] of legacy) {
    const key = line.split(':')[0]
    const parsed = mod.parseFrontmatter(`---\n${line}\n---\n`).data
    check(`旧写法 ${label}`, parsed[key] === expected, JSON.stringify(parsed))
  }
  check('旧数组写法', JSON.stringify(mod.parseFrontmatter('---\ntags: [发布, 流程]\n---\n').data.tags) === '["发布","流程"]')
}

console.log('\n== recall 重写文件不会每次多一个空行，也不改值 ==')
{
  const env = makeEnv()
  try {
    mod.writeMemory(env.memoryDir, { slug: 'zebra', title: '斑马条纹规则', description: '斑马条纹是黑白相间的', body: '斑马的条纹永远是黑白相间。' })
    // 手写一个带引号的旧风格文件：recall 重写它时值不能被改坏
    writeFileSync(
      path.join(env.memoryDir, 'quoted.md'),
      '---\nname: quoted\ndescription: "斑马 \\"黑白\\" 说明"\ntitle: \'斑马的 "颜色"\'\ntype: feedback\n---\n\n斑马的条纹永远是黑白相间。\n',
      'utf8',
    )
    await mod.rebuildVectors(env.memoryDir)
    // frontmatter 收尾的 `---` 之后到正文之前有几个换行
    const gapOf = (text) => /\n---\n(\n*)\S/.exec(text)?.[1].length
    await mod.recall(env.memoryDir, '斑马的条纹是什么颜色', 5)
    const afterOne = readFileSync(path.join(env.memoryDir, 'zebra.md'), 'utf8')
    for (let i = 0; i < 3; i += 1) await mod.recall(env.memoryDir, '斑马的条纹是什么颜色', 5)
    const afterFour = readFileSync(path.join(env.memoryDir, 'zebra.md'), 'utf8')
    const hitsOf = (text) => Number(/^hits: (\d+)$/m.exec(text)?.[1] ?? 0)
    check('确实被命中并累加 hits', hitsOf(afterFour) > hitsOf(afterOne) && hitsOf(afterOne) >= 1, `${hitsOf(afterOne)} -> ${hitsOf(afterFour)}`)
    check('正文前恒为一个空行，不随命中次数增长', gapOf(afterOne) === 1 && gapOf(afterFour) === 1, `${gapOf(afterOne)} / ${gapOf(afterFour)}`)
    const quotedRaw = readFileSync(path.join(env.memoryDir, 'quoted.md'), 'utf8')
    check('带引号的旧风格文件也确实被 recall 重写过', /^hits: [1-9]/m.test(quotedRaw), quotedRaw.slice(0, 300))
    const q = mod.listMemories(env.memoryDir).find((m) => m.id === 'quoted')
    check('旧风格带引号的值经 recall 重写后保持原义', q.meta.title === '斑马的 "颜色"' && q.meta.description === '斑马 "黑白" 说明', JSON.stringify(q.meta))
  } finally {
    env.cleanup()
  }
}

/* ------------------------------------------------------------ 3. writeMemory */

console.log('\n== 更新保留 hits / lastHit / 未知键；改标签不丢它们 ==')
{
  const env = makeEnv()
  try {
    writeFileSync(
      path.join(env.memoryDir, 'keep.md'),
      '---\nname: keep\ndescription: 摘要\nscope: project\ntype: feedback\nstatus: confirmed\ncreated: 2026-01-01T00:00:00.000Z\nmodified: 2026-01-01T00:00:00.000Z\nconfidence: 0.9\ntitle: 保留测试\nhits: 7\nlastHit: 2026-02-02T00:00:00.000Z\nreviewer: someone-else\n---\n\n正文\n',
      'utf8',
    )
    mod.writeMemory(env.memoryDir, { id: 'keep', tags: ['x'] })
    const parsed = mod.parseFrontmatter(readFileSync(path.join(env.memoryDir, 'keep.md'), 'utf8')).data
    check('hits 保留', parsed.hits === '7', JSON.stringify(parsed))
    check('lastHit 保留', parsed.lastHit === '2026-02-02T00:00:00.000Z')
    check('未知键保留', parsed.reviewer === 'someone-else')
    check('created 保留，本次改动生效', parsed.created === '2026-01-01T00:00:00.000Z' && JSON.stringify(parsed.tags) === '["x"]')
    mod.writeMemory(env.memoryDir, { id: 'keep', tags: [] })
    check('清空 tags 生效', mod.parseFrontmatter(readFileSync(path.join(env.memoryDir, 'keep.md'), 'utf8')).data.tags === undefined)
  } finally {
    env.cleanup()
  }
}

console.log('\n== slug 判重不分大小写（Windows / macOS 的 Docs.md 与 docs.md 是同一个文件）==')
{
  const env = makeEnv()
  try {
    mod.writeMemory(env.memoryDir, { slug: 'docs', title: '小写在先', body: 'ORIGINAL' })
    const second = mod.writeMemory(env.memoryDir, { title: 'Docs', body: 'NEW' }) // 无 slug：标题派生，保留大小写
    check('后写的拿到另一个名字', path.basename(second, '.md').toLowerCase() !== 'docs', path.basename(second))
    const original = mod.listMemories(env.memoryDir).find((m) => m.id === 'docs')
    check('先写的没被覆盖', original?.body === 'ORIGINAL', JSON.stringify(original?.body))
    check('两条都在', mod.listMemories(env.memoryDir).length === 2)

    // 只差大小写的 slug 不算改名（否则改名后删旧文件会把新文件一起删掉）
    writeFileSync(path.join(env.memoryDir, 'Mixed.md'), '---\nname: Mixed\ntitle: 混合大小写\n---\n\n正文\n', 'utf8')
    const same = mod.writeMemory(env.memoryDir, { id: 'Mixed', slug: 'mixed', body: '改了' })
    check('只差大小写：id 不变、文件还在', path.basename(same, '.md') === 'Mixed' && existsSync(path.join(env.memoryDir, 'Mixed.md')), path.basename(same))
  } finally {
    env.cleanup()
  }
}

console.log('\n== description：正文以标题开头时取第一行正文 ==')
{
  const env = makeEnv()
  try {
    const descOf = (n, body) => {
      mod.writeMemory(env.memoryDir, { slug: `d-${n}`, title: `标题${n}`, body })
      return mod.listMemories(env.memoryDir).find((m) => m.id === `d-${n}`).meta.description
    }
    check('`## 规则` 开头：不取「规则」', descOf(1, '## 规则\n\n发布前必须跑全量测试。\n\n更多细节。') === '发布前必须跑全量测试。')
    check('多个标题开头也跳过', descOf(2, '# 大标题\n## 小标题\n\n真正的摘要句。') === '真正的摘要句。')
    check('只有标题：退回标题文字', descOf(3, '## 只有标题') === '只有标题')
    check('跳过围栏代码块', descOf(4, '## 命令\n\n```bash\npnpm install\n```\n\n不要在 profile 里装依赖。') === '不要在 profile 里装依赖。')
    check('没有标题时行为不变（加粗标签仍被规整）', descOf(5, '**错误模式**：把 id 当路径') === '错误模式：把 id 当路径')
  } finally {
    env.cleanup()
  }
}

/* ------------------------------------------------------------ 4. pending */

console.log('\n== 草稿 id：同一毫秒连写不互相覆盖 ==')
{
  const env = makeEnv()
  try {
    const files = Array.from({ length: 25 }, (_, i) => mod.writePending(env.memoryDir, { title: `候选${i}`, body: `正文${i}` }))
    check('25 个 id 各不相同', new Set(files).size === 25)
    check('落盘 25 个文件', mod.listPending(env.memoryDir).length === 25, String(mod.listPending(env.memoryDir).length))
    check('id 形如 dr_<时间>_<随机>', /^dr_[0-9a-z]+_[0-9a-f]{6}$/.test(mod.listPending(env.memoryDir)[0].id), mod.listPending(env.memoryDir)[0].id)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 草稿 supersedes：落盘，收下时取代旧条并归档 ==')
{
  const env = makeEnv()
  try {
    mod.writeMemory(env.memoryDir, { slug: 'old-rule', title: '旧规则', body: '旧规则正文', tags: ['t'] })
    const file = mod.writePending(env.memoryDir, { slug: 'new-rule', title: '新规则', body: '新规则正文', supersedes: 'old-rule', confidence: 0.7 })
    check('supersedes 写进草稿 frontmatter', mod.parseFrontmatter(readFileSync(file, 'utf8')).data.supersedes === 'old-rule')
    const id = path.basename(file, '.md')
    const accepted = await mod.acceptPending(env.memoryDir, id)
    check('收下成功并报告被取代的 id', accepted.ok === true && accepted.replaced === 'old-rule', JSON.stringify(accepted))
    check('旧条已删除', !existsSync(path.join(env.memoryDir, 'old-rule.md')))
    check('旧条正文进了历史', mod.listHistory(env.memoryDir, 'old-rule').some((v) => readFileSync(v.file, 'utf8').includes('旧规则正文')))
    const fresh = mod.listMemories(env.memoryDir).find((m) => m.id === 'new-rule')
    check('新条落盘并记录 supersedes', fresh?.meta.supersedes === 'old-rule' && fresh.meta.status === 'confirmed', JSON.stringify(fresh?.meta))
    check('草稿已清空', mod.listPending(env.memoryDir).length === 0)

    // 新旧 slug 相同：原地更新（不产生 -2），保留 created / hits
    writeFileSync(path.join(env.memoryDir, 'same-slug.md'), '---\nname: same-slug\ntitle: 原条\ncreated: 2026-01-01T00:00:00.000Z\nhits: 5\n---\n\n原正文\n', 'utf8')
    const file2 = mod.writePending(env.memoryDir, { slug: 'same-slug', title: '更新后', body: '更新正文', supersedes: 'same-slug' })
    const accepted2 = await mod.acceptPending(env.memoryDir, path.basename(file2, '.md'))
    check('同 slug：原地更新', accepted2.ok === true && !accepted2.replaced && !existsSync(path.join(env.memoryDir, 'same-slug-2.md')), JSON.stringify(accepted2))
    const same = mod.listMemories(env.memoryDir).find((m) => m.id === 'same-slug')
    check('同 slug：内容更新、created 与 hits 保留', same.body === '更新正文' && same.meta.created === '2026-01-01T00:00:00.000Z' && same.meta.hits === '5', JSON.stringify(same.meta))
    check('同 slug：旧版进了历史', mod.listHistory(env.memoryDir, 'same-slug').some((v) => readFileSync(v.file, 'utf8').includes('原正文')))

    // 目标不存在：当普通收下，不报错
    const file3 = mod.writePending(env.memoryDir, { slug: 'ghost-target', title: '幽灵', body: '正文', supersedes: 'no-such-memory' })
    const accepted3 = await mod.acceptPending(env.memoryDir, path.basename(file3, '.md'))
    check('supersedes 指向不存在的条目：照常收下', accepted3.ok === true && !accepted3.replaced, JSON.stringify(accepted3))
  } finally {
    env.cleanup()
  }
}

console.log('\n== acceptPending 受 maxMemoryCount 硬限（取代除外）==')
{
  const env = makeEnv({ maxMemoryCount: 2 })
  try {
    mod.writeMemory(env.memoryDir, { slug: 'm-one', title: '一', body: '正文一' })
    mod.writeMemory(env.memoryDir, { slug: 'm-two', title: '二', body: '正文二' })
    const plain = mod.writePending(env.memoryDir, { slug: 'm-three', title: '三', body: '正文三' })
    const full = await mod.acceptPending(env.memoryDir, path.basename(plain, '.md'))
    check('库满：拒收 library-full', full.ok === false && full.reason === 'library-full' && full.count === 2 && full.limit === 2, JSON.stringify(full))
    check('库满：草稿留在队列、库里没多一条', mod.listPending(env.memoryDir).length === 1 && mod.listMemories(env.memoryDir).length === 2)

    const swap = mod.writePending(env.memoryDir, { slug: 'm-two-v2', title: '二（新）', body: '新正文二', supersedes: 'm-two' })
    const swapped = await mod.acceptPending(env.memoryDir, path.basename(swap, '.md'))
    check('取代不占名额：库满时照常收下', swapped.ok === true && swapped.replaced === 'm-two', JSON.stringify(swapped))
    check('取代后仍是 2 条', mod.listMemories(env.memoryDir).length === 2)

    mod.configure({ agentsFile: env.agentsFile, maxMemoryCount: 0 })
    const unlimited = await mod.acceptPending(env.memoryDir, path.basename(plain, '.md'))
    check('maxMemoryCount=0 不限制', unlimited.ok === true, JSON.stringify(unlimited))
  } finally {
    env.cleanup()
  }
}

/* ------------------------------------------------------------ 5. 抽取 */

console.log('\n== parseExtractionJson：正文里有代码围栏、前后闲聊、截断 ==')
{
  const item = { slug: 'x', title: 'T', body: 'Run:\n```bash\npnpm i\n```\nthen go', type: 'feedback' }
  const raw = JSON.stringify([item])
  check('裸数组，body 含 ```', mod.parseExtractionJson(raw)[0]?.body === item.body)
  check('```json 围栏包着，body 含 ```', mod.parseExtractionJson('```json\n' + raw + '\n```')[0]?.body === item.body)
  check('无语言标记的围栏', mod.parseExtractionJson('```\n' + raw + '\n```').length === 1)
  check('前后闲聊 + body 含 ```', mod.parseExtractionJson(`好的：\n${raw}\n以上。`)[0]?.body === item.body)
  check('闲聊里带 [2] 之类方括号', mod.parseExtractionJson(`共 [2] 条：${raw}`).length === 1)
  check('闲聊里带围栏 + body 含 ```', mod.parseExtractionJson('结果如下\n```json\n' + raw + '\n```\n完毕').length === 1)
  check('多条', mod.parseExtractionJson(JSON.stringify([item, { ...item, title: 'T2' }])).length === 2)
  const truncated = raw.slice(0, raw.length - 15)
  check('被 maxTokens 截断 -> []', mod.parseExtractionJson(truncated).length === 0)
  check('截断且最后一个 ] 是 tags 的 -> []', mod.parseExtractionJson('[{"title":"a","body":"b","tags":["x"]},{"title":"c","bo').length === 0)
  check('只有 [] -> []', mod.parseExtractionJson('[]').length === 0)
  check('对象而非数组 -> []', mod.parseExtractionJson('{"title":"a","body":"b"}').length === 0)
}

console.log('\n== extractFromTurn：墙钟超时，不会拖死 turn-stopping ==')
{
  const session = {
    snapshotEvents: () => [
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '以后每次改完插件都要先跑测试再提交，别再忘了。'.repeat(12) }] } },
    ],
    requestContext: () => ({ provider: 'p', model: 'm' }),
  }
  const makeCtx = (streamImpl) => ({
    ctx: { get: (key) => (key === 'llm' ? { stream: streamImpl } : undefined), sessions: { get: () => session } },
    agent: { id: 's' },
  })

  // 1) 一个字都不吐、永远不结束
  {
    const env = makeEnv()
    try {
      let seenSignal
      const { ctx, agent } = makeCtx((options) => {
        seenSignal = options.signal
        return (async function* () {
          await new Promise(() => {})
        })()
      })
      const started = Date.now()
      const result = await mod.extractFromTurn(ctx, agent, env.memoryDir, { manual: true, timeoutMs: 150 })
      const elapsed = Date.now() - started
      check('超时后返回而不是挂住', elapsed < 5000, `${elapsed}ms`)
      check('返回 skipped: extraction timed out', result.skipped === 'extraction timed out', JSON.stringify(result))
      check('传了 AbortSignal 且已被 abort', seenSignal instanceof AbortSignal && seenSignal.aborted === true)
      check('没写任何草稿', mod.listPending(env.memoryDir).length === 0)
    } finally {
      env.cleanup()
    }
  }

  // 2) 吐完整 JSON 之后卡住：用已收到的部分继续
  {
    const env = makeEnv()
    try {
      const reply = JSON.stringify([{ title: '先跑测试再提交', body: '用户要求：改完插件先跑测试。理由：避免推上坏版本。', type: 'feedback', confidence: 0.9 }])
      const { ctx, agent } = makeCtx(() =>
        (async function* () {
          yield { type: 'text-delta', text: reply }
          await new Promise(() => {})
        })(),
      )
      const result = await mod.extractFromTurn(ctx, agent, env.memoryDir, { manual: true, timeoutMs: 150 })
      check('卡住前收到的完整 JSON 仍被处理', result.queued === 1, JSON.stringify(result))
      check('草稿落盘', mod.listPending(env.memoryDir).length === 1)
    } finally {
      env.cleanup()
    }
  }

  // 3) 正常结束：不受影响，定时器不残留（进程能正常退出）
  {
    const env = makeEnv()
    try {
      const reply = JSON.stringify([{ title: '正常抽取', body: '正文。理由：因为。', type: 'user', confidence: 0.9 }])
      const { ctx, agent } = makeCtx(() =>
        (async function* () {
          yield { type: 'text-delta', text: reply }
        })(),
      )
      const result = await mod.extractFromTurn(ctx, agent, env.memoryDir, { manual: true })
      check('正常流照常入队', result.queued === 1, JSON.stringify(result))
    } finally {
      env.cleanup()
    }
  }
}

/* ------------------------------------------------------------ 6. 缓存 / 原子写 / 路径 / 编辑器 */

console.log('\n== listMemories 缓存：只回收本目录的条目 ==')
{
  const env = makeEnv()
  try {
    const dirB = path.join(env.root, 'projects', '--y--', 'memory')
    mkdirSync(dirB, { recursive: true })
    writeFileSync(path.join(dirB, 'b.md'), '---\nname: b\n---\n\nbb\n', 'utf8')
    mod.writeMemory(env.memoryDir, { slug: 'a', title: 'A', body: 'aa' })
    const first = mod.listMemories(env.memoryDir)[0]
    check('同目录二次读取命中缓存（同一个对象）', mod.listMemories(env.memoryDir)[0] === first)
    mod.listMemories(dirB)
    check('读另一个目录不会清掉本目录的缓存', mod.listMemories(env.memoryDir)[0] === first)
    rmSync(path.join(env.memoryDir, 'a.md'))
    check('本目录里被删的文件仍会被回收', mod.listMemories(env.memoryDir).length === 0)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 原子写：不留临时文件，内容完整 ==')
{
  const env = makeEnv()
  try {
    mod.writeMemory(env.memoryDir, { slug: 'atomic', title: '原子', body: '正文'.repeat(500) })
    mod.writeMemory(env.memoryDir, { id: 'atomic', body: '改写'.repeat(500) })
    mod.writePending(env.memoryDir, { id: 'dr_atomic', title: '草稿', body: '草稿正文' })
    await mod.acceptPending(env.memoryDir, 'dr_atomic')
    const leftovers = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.tmp')) : [])
    check('记忆目录无 .tmp 残留', leftovers(env.memoryDir).length === 0, JSON.stringify(leftovers(env.memoryDir)))
    check('草稿目录无 .tmp 残留', leftovers(path.join(env.stateDir, 'pending')).length === 0)
    check('文件内容完整', readFileSync(path.join(env.memoryDir, 'atomic.md'), 'utf8').endsWith(`${'改写'.repeat(500)}\n`))
    check('MEMORY.md 已重建', readFileSync(path.join(env.memoryDir, 'MEMORY.md'), 'utf8').includes('atomic.md'))
  } finally {
    env.cleanup()
  }
}

console.log('\n== projectRootFor：最长匹配、末尾分隔符、Windows 下不分大小写 ==')
{
  const sep = path.sep
  const base = process.platform === 'win32' ? 'C:\\Work' : '/work'
  const roots = [base, `${base}${sep}proj`, `${base}${sep}proj${sep}`]
  check('最长的已注册路径胜出', mod.projectRootFor(`${base}${sep}proj${sep}sub${sep}deep`, roots) === path.resolve(`${base}${sep}proj`))
  check('等于根本身', mod.projectRootFor(base, roots) === path.resolve(base))
  check('不是前缀匹配「proj」→「project2」', mod.projectRootFor(`${base}${sep}project2`, roots) === path.resolve(base))
  check('没有注册的工作区：退回 cwd', mod.projectRootFor(`${base}${sep}x`, []) === path.resolve(`${base}${sep}x`))
  const driveRoot = process.platform === 'win32' ? 'C:\\' : '/'
  check('根目录本身作为工作区也能匹配', mod.projectRootFor(`${driveRoot}${process.platform === 'win32' ? 'Users' : 'home'}`, [driveRoot]) === path.resolve(driveRoot))
  if (process.platform === 'win32') {
    check('盘符/目录大小写不同仍落到同一个库', mod.projectRootFor('c:\\work\\PROJ\\sub', roots) === path.resolve('C:\\Work\\proj'), mod.projectRootFor('c:\\work\\PROJ\\sub', roots))
    check('返回注册时的写法（键稳定）', mod.projectRootFor('C:\\WORK', roots) === path.resolve('C:\\Work'))
  } else {
    check('非 Windows 区分大小写', mod.projectRootFor('/WORK/x', ['/work']) === path.resolve('/WORK/x'))
  }
  check('encodeProjectPath 不变（现有库依赖它）', mod.encodeProjectPath('C:\\a\\b') === '--C-a-b--')
}

console.log('\n== detectEditors：记忆化；配置变了会重新探测 ==')
{
  const env = makeEnv()
  try {
    mod.resetEditorCache()
    const first = mod.detectEditors()
    const second = mod.detectEditors()
    check('永远至少有「系统默认」', first.some((e) => e.id === 'system'))
    check('两次结果相同', JSON.stringify(first) === JSON.stringify(second))
    first.push({ id: 'junk' })
    first[0].name = 'MUTATED'
    check('调用方改结果不会污染缓存', !mod.detectEditors().some((e) => e.id === 'junk') && mod.detectEditors()[0].name !== 'MUTATED')

    const fakeEditor = path.join(env.root, 'my-editor.exe')
    writeFileSync(fakeEditor, '', 'utf8')
    mod.configure({ agentsFile: env.agentsFile, editorExe: fakeEditor })
    check('editorExe 变了：重新探测并出现 config 项', mod.detectEditors().some((e) => e.id === 'config' && e.exe === fakeEditor))
    mod.configure({ agentsFile: env.agentsFile })
    check('editorExe 清空：config 项消失', !mod.detectEditors().some((e) => e.id === 'config'))
    mod.resetEditorCache()
  } finally {
    env.cleanup()
  }
}

console.log('\n== openAgentsFile：子进程启动失败不会变成未捕获异常 ==')
{
  const env = makeEnv()
  const logged = []
  const originalError = console.error
  console.error = (...args) => logged.push(args.join(' '))
  try {
    // editorExe 指向一个**存在但不可执行**的路径（目录）：existsSync 通过，spawn 异步报错
    mod.configure({ agentsFile: env.agentsFile, editorExe: env.root })
    mod.resetEditorCache()
    let uncaught = null
    const onUncaught = (error) => {
      uncaught = error
    }
    process.on('uncaughtException', onUncaught)
    const result = mod.openAgentsFile('')
    check('同步返回（异步错误另行处理）', result.ok === true && result.editorId === 'config', JSON.stringify(result))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    process.off('uncaughtException', onUncaught)
    check('进程没有收到未捕获异常', uncaught === null, String(uncaught))
    check('错误被记录而不是吞掉', logged.some((line) => line.includes('打开 AGENTS.md 失败')), JSON.stringify(logged))
  } finally {
    console.error = originalError
    mod.resetEditorCache()
    env.cleanup()
  }
}

if (process.platform === 'win32') {
  console.log('\n== openAgentsFile 的系统默认分支真的能启动文件（回归：旧写法 `start "" "\\"file\\""` 从不启动）==')
  const env = makeEnv()
  try {
    // 用一个会写标记文件的 .bat 当「AGENTS.md」：start 能启动它就说明命令行拼对了
    const marker = path.join(env.root, 'launched.txt')
    const bat = path.join(env.root, 'dir with space', 'AGENTS.bat')
    mkdirSync(path.dirname(bat), { recursive: true })
    writeFileSync(bat, `@echo off\r\necho ran> "${marker}"\r\n`, 'utf8')
    mod.configure({ agentsFile: bat })
    const result = mod.openAgentsFile('system')
    check('返回 system-default', result.ok === true && result.editorId === 'system', JSON.stringify(result))
    let launched = false
    for (let i = 0; i < 40 && !launched; i += 1) {
      launched = existsSync(marker)
      if (!launched) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    check('文件确实被启动了（路径含空格也行）', launched)
  } finally {
    env.cleanup()
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
