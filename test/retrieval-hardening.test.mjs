/**
 * 检索与注入的回归测试（来自一次代码审查，每一节都对应一个真实复现过的缺陷）：
 *
 *   · keywordScore：拉丁词只在词首命中（`ci` 不该命中 "specified"）、Unicode 感知（`über`）、
 *     假名与谚文进二元组通道
 *   · recall 的向量新鲜度：手写进来的新文件、手改过的正文，不能因为向量索引落后于磁盘而被漏掉或误召
 *   · pathMatches：按路径段匹配、Windows 不分大小写、`**` 匹配零段或多段
 *   · recordHits：只改 hits / lastHit 两行，手写的 YAML 块列表与注释原样保留，空行不增长
 *   · 索引注入：超限必须明说省略了多少条（警告自己也要放得下）；一条记忆都没有就不注入
 *
 * 全部在临时目录里跑，不碰 ~/.dsh。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeHost, makeReporter } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const { keywordScore, pathMatches, recall, rebuildVectors, resolveEmbedder, writeMemory, listMemories } = mod

section('keywordScore：词首匹配')
{
  check('空查询 → 0', keywordScore('', 'anything') === 0)
  check('纯标点 → 0', keywordScore('???!!!', 'anything') === 0)
  check('单个拉丁字母不成词 → 0', keywordScore('a', 'abc') === 0)
  check('`ci` 不命中 "specified"（词中）', keywordScore('ci', 'the specified value') === 0)
  check('`ci` 命中 "CI pipeline"（词首）', keywordScore('ci', 'The CI pipeline') === 1)
  check('`id` 不命中 "valid"', keywordScore('id', 'a valid provider') === 0)
  check('前缀仍然算：`deploy` 命中 "deployment"', keywordScore('deploy', 'the deployment guide') === 1)
  check('下划线是边界：`recall` 命中 `memory_recall`', keywordScore('recall', 'call memory_recall first') === 1)
  check('连字符是边界：`link` 命中 "pnpm-link"', keywordScore('link', 'avoid pnpm-link here') === 1)
  check('CJK 紧挨着的英文词算词首：`pnpm` 命中「使用pnpm安装」', keywordScore('pnpm', '使用pnpm安装依赖') === 1)
  check('大小写不敏感', keywordScore('PNPM', 'use pnpm') === 1)

  check('`über` 作为一个词整体匹配（不被切成 `ber`）', keywordScore('über', 'der Über-Wert') === 1)
  check('`über` 不命中 "ber" 开头的词', keywordScore('über', 'berlin ber') === 0)
  check('组合写法的 ü 与预组合写法等价（NFC）', keywordScore('u\u0308ber', 'der über wert') === 1)
  check('`straße` 能命中自身', keywordScore('straße', 'die straße ist lang') === 1)

  check('假名进二元组通道：「デプロイ」命中自身', keywordScore('デプロイ', '本番へのデプロイ手順') > 0)
  check('假名二元组：不相关文本 → 0', keywordScore('デプロイ', 'コーヒーを飲む') === 0)
  check('谚文进二元组通道：「배포」命中自身', keywordScore('배포', '운영 배포 절차') > 0)
  check('长音符不劈开片假名：「サーバー」命中自身', keywordScore('サーバー', 'サーバーを再起動') === 1)
  check('汉字二元组行为不变', keywordScore('部署流程', '生产部署流程说明') === 1)
  check('中英混写：两类词项各算各的', Math.abs(keywordScore('部署 pnpm', '用 pnpm 做部署') - 1) < 1e-9)
}

section('recall：向量索引落后于磁盘时按内容哈希对账')
{
  const embedder = await resolveEmbedder()
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-fresh-'))
  const memoryDir = path.join(root, 'memory')
  mkdirSync(memoryDir)
  try {
    writeMemory(memoryDir, { slug: 'npm-publish', title: 'npm 发布只走 GitHub Actions', description: 'npm 发布只能通过 GitHub Actions 每 4 小时批量发', body: '发布 npm 包不要手动 npm publish，用 GitHub Actions 批量发布。', type: 'project' })
    writeMemory(memoryDir, { slug: 'ui-text', title: '界面不要加解释文案', description: '界面里不要自行添加解释性说明文字', body: '用户要求界面不出现多余说明文案。', type: 'feedback' })
    await rebuildVectors(memoryDir)

    // 绕过插件的写入：直接落一个新文件（手写、别的进程、同步工具……）
    writeFileSync(
      path.join(memoryDir, 'db-migrate.md'),
      '---\nname: db-migrate\ndescription: 数据库迁移前必须先做备份\ntype: project\ntitle: 数据库迁移必须先备份\n---\n\n跑数据库迁移之前一定先备份数据，迁移失败无法回滚。\n',
      'utf8',
    )
    const found = await recall(memoryDir, '迁移之前要备份吗', 5, { recordHits: false })
    check('手写进来的新文件无需 rebuild 就能被召回', found.results.some((row) => row.id === 'db-migrate'), JSON.stringify(found.results.map((row) => row.id)))
    if (embedder) {
      const row = found.results.find((r) => r.id === 'db-migrate')
      check('  …而且是带着向量分召回的（不是靠关键词凑过门槛）', row && row.vector > 0, JSON.stringify(row && row.vector))
    }

    // 手改正文：旧向量不能继续代表新内容
    const file = path.join(memoryDir, 'ui-text.md')
    writeFileSync(
      file,
      readFileSync(file, 'utf8')
        .replace('用户要求界面不出现多余说明文案。', 'Kubernetes ingress controller must terminate TLS everywhere in production.')
        .replace('界面里不要自行添加解释性说明文字', 'Kubernetes ingress TLS rule')
        .replace('界面不要加解释文案', 'Kubernetes ingress TLS'),
      'utf8',
    )
    const stale = await recall(memoryDir, '界面里的解释说明文字', 5, { recordHits: false })
    check('手改后，旧主题的提问不再召回它（旧向量已作废）', !stale.results.some((row) => row.id === 'ui-text'), JSON.stringify(stale.results.map((row) => [row.id, row.score])))
    const fresh = await recall(memoryDir, 'kubernetes ingress tls', 5, { recordHits: false })
    check('手改后，新主题的提问能召回它', fresh.results.some((row) => row.id === 'ui-text'))

    // 已经一致时不重复嵌入：再来一次 rebuild 应当全部复用
    const again = await rebuildVectors(memoryDir)
    if (embedder) check('对账之后索引与磁盘一致：rebuild 全部复用、不重嵌', again.embedded === 0 && again.reused === 3, JSON.stringify(again))

    // 删除后不会冒出已删除的记忆
    mod.deleteMemory(memoryDir, 'db-migrate')
    const gone = await recall(memoryDir, '迁移之前要备份吗', 5, { recordHits: false })
    check('已删除的记忆不再被召回', !gone.results.some((row) => row.id === 'db-migrate'))

    // 成本：50 条记忆下，一致性检查本身（命中缓存的哈希）应当可以忽略
    for (let i = 0; i < 48; i += 1) {
      writeMemory(memoryDir, { slug: `filler-${i}`, title: `填充 ${i}`, description: `填充说明 ${i}`, body: `填充正文内容 ${i} `.repeat(80), type: 'project' })
    }
    await rebuildVectors(memoryDir)
    await recall(memoryDir, '预热', 3, { recordHits: false })
    const rounds = 30
    const started = performance.now()
    for (let i = 0; i < rounds; i += 1) await recall(memoryDir, '部署流程怎么走', 3, { recordHits: false })
    const perCall = (performance.now() - started) / rounds
    console.log(`  （50 条记忆，稳态 recall ≈ ${perCall.toFixed(2)} ms/次）`)
    check('50 条记忆下稳态 recall < 25 ms', perCall < 25, `${perCall.toFixed(2)} ms`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

section('pathMatches：按路径段、Windows 不分大小写、`**` 零段或多段')
{
  const win = (pattern, target) => pathMatches(pattern, target, { caseInsensitive: true })
  const posix = (pattern, target) => pathMatches(pattern, target, { caseInsensitive: false })

  check('目录形式不命中 `mysrc/`', !pathMatches('src/', 'C:\\proj\\mysrc\\a.js') && !pathMatches('lib/', '/usr/stdlib/x.js'))
  check('目录形式命中其下的文件', pathMatches('src/', 'C:\\proj\\src\\a.js') && pathMatches('src/', '/ws/src/deep/er/a.js'))
  check('目录形式要求目录之下还有东西', !pathMatches('src/', '/ws/src'))
  check('目录形式可以在路径中间', pathMatches('dsh-workspace-memory/', 'D:\\ws\\dsh-workspace-memory\\test\\a.mjs'))
  check('多级目录形式', pathMatches('a/b/', '/x/a/b/c.js') && !pathMatches('a/b/', '/x/a/c/b/d.js'))

  check('Windows：目录大小写无关', win('Src/', 'C:\\proj\\src\\a.js'))
  check('Windows：文件名大小写无关', win('client.js', 'C:\\proj\\DSH-Workspace\\Client.js'))
  check('POSIX：大小写敏感', !posix('client.js', '/proj/Client.js') && posix('Client.js', '/proj/Client.js'))
  check('默认值：win32 不分大小写、其余平台区分', pathMatches('client.js', '/p/Client.js') === (process.platform === 'win32'))

  check('光写文件名：命中任何目录下的同名文件', pathMatches('index.js', 'D:\\ws\\a\\b\\index.js') && pathMatches('index.js', 'index.js'))
  check('光写文件名：必须整段（`xindex.js` 不算）', !pathMatches('index.js', 'D:\\ws\\xindex.js') && !pathMatches('index.js', 'D:\\ws\\index.js.bak'))
  check('带目录的模式不会命中前缀不同的目录', pathMatches('dsh-workspace-memory/index.js', 'D:\\ws\\dsh-workspace-memory\\index.js') && !pathMatches('dsh-workspace-memory/index.js', 'D:\\ws\\xdsh-workspace-memory\\index.js'))

  check('`*` 匹配一段内的任意字符', pathMatches('src/*.js', '/ws/src/a.js') && pathMatches('*.md', '/ws/docs/x.md'))
  check('`*` 不跨目录', !pathMatches('src/*.js', '/ws/src/x/a.js'))
  check('`**` 匹配零段：`src/**/*.js` 命中 `src/a.js`', pathMatches('src/**/*.js', '/ws/src/a.js'))
  check('`**` 匹配多段：`src/**/*.js` 命中 `src/x/y/a.js`', pathMatches('src/**/*.js', '/ws/src/x/y/a.js'))
  check('`src/**` 命中其下任意深度', pathMatches('src/**', '/ws/src/x/a.js') && pathMatches('src/**', '/ws/src/a.js'))
  check('`**/*.test.mjs`', pathMatches('**/*.test.mjs', '/ws/test/a.test.mjs') && !pathMatches('**/*.test.mjs', '/ws/test/a.mjs'))
  check('`**` 之后的段仍然要匹配', !pathMatches('src/**/*.js', '/ws/src/x/a.ts'))

  check('`./` 前缀与首尾空白被忽略', pathMatches('./src/a.js', '/ws/src/a.js') && pathMatches(' src/a.js ', '/ws/src/a.js'))
  check('反斜杠、重复分隔符被规整', pathMatches('src\\a.js', '/ws//src//a.js'))
  check('正则元字符按字面：`(a|b).js`', pathMatches('src/(a|b).js', '/ws/src/(a|b).js') && !pathMatches('src/(a|b).js', '/ws/src/a.js'))
  check('空模式 / 空路径 → false', !pathMatches('', '/a') && !pathMatches('/', '/a') && !pathMatches('a', ''))
  check('病态模式不会卡死（线性回溯）', (() => {
    const started = performance.now()
    const result = pathMatches('**/**/**/**/**/**/**/x.js', `${'a/'.repeat(60)}y.js`)
    return result === false && performance.now() - started < 200
  })())
}

section('recordHits：只改 hits / lastHit 两行')
{
  const host = makeHost(mod)
  try {
    const hand = path.join(host.memoryDir, 'blk.md')
    const original =
      '---\r\nname: blk\r\ndescription: block list sample\r\ntype: project\r\ntags:\r\n  - alpha\r\n  - beta\r\npaths:\r\n  - src/a.js\r\n# a comment\r\ntitle: Block sample\r\n---\r\n\r\nunique-token-zebra body\r\n'
    writeFileSync(hand, original, 'utf8')
    await host.tool('memory_recall', { query: 'unique-token-zebra' })
    let after = readFileSync(hand, 'utf8')
    check('召回之后：除 hits / lastHit 外一个字节没变（YAML 块列表、注释、CRLF 都在）',
      after.replace(/\r\nhits: 1\r\nlastHit: [^\r\n]+(?=\r\n---)/, '') === original,
      JSON.stringify(after))
    check('hits 与 lastHit 被追加在收尾的 --- 之前', /\r\nhits: 1\r\nlastHit: \d{4}-[^\r\n]+\r\n---\r\n/.test(after))

    for (let i = 0; i < 3; i += 1) await host.tool('memory_recall', { query: 'unique-token-zebra' })
    after = readFileSync(hand, 'utf8')
    check('再召回 3 次：hits 累加到 4，不重复追加', /\r\nhits: 4\r\n/.test(after) && (after.match(/^hits:/gm) ?? []).length === 1)
    check('正文前后的空行不增长', after.endsWith('---\r\n\r\nunique-token-zebra body\r\n'))

    // 通过插件写入的文件：召回 3 次，空行不增长
    await host.tool('memory_remember', { slug: 'plain', title: 'Plain memory', body: 'plain body with zebra-quartz token', description: 'plain' })
    const plain = path.join(host.memoryDir, 'plain.md')
    const countBlank = (text) => text.split('---\n')[2]?.match(/^\n*/)[0].length
    const before = countBlank(readFileSync(plain, 'utf8'))
    for (let i = 0; i < 3; i += 1) await host.tool('memory_recall', { query: 'zebra-quartz' })
    check('插件写入的文件：召回多次后空行数不变', countBlank(readFileSync(plain, 'utf8')) === before, `${before} → ${countBlank(readFileSync(plain, 'utf8'))}`)
    check('  …hits 在累加', listMemories(host.memoryDir).find((m) => m.id === 'plain')?.meta.hits === '3')

    // hits 写坏了：当作 0 重新计数，不写出 NaN
    const bad = path.join(host.memoryDir, 'bad-hits.md')
    writeFileSync(bad, '---\nname: bad-hits\ndescription: d\nhits: lots\ntitle: Bad hits\n---\n\nquartz-marker body\n', 'utf8')
    await host.tool('memory_recall', { query: 'quartz-marker' })
    check('hits 不是数字时从 0 重新计数', /^hits: 1$/m.test(readFileSync(bad, 'utf8')) && !/NaN/.test(readFileSync(bad, 'utf8')))

    // 没有 frontmatter 的文件不碰
    const bare = path.join(host.memoryDir, 'bare.md')
    writeFileSync(bare, 'bare-marker content without frontmatter\n', 'utf8')
    await host.tool('memory_recall', { query: 'bare-marker' })
    check('没有 frontmatter 的文件原样保留', readFileSync(bare, 'utf8') === 'bare-marker content without frontmatter\n')
  } finally {
    host.cleanup()
  }
}

section('索引注入：超限要明说省略了多少条；空索引不注入')
{
  const host = makeHost(mod, { config: { maxMemoryCount: 0 } })
  try {
    check('一条记忆都没有：不注入', host.contextText() === '')

    host.write(path.join(host.memoryDir, 'MEMORY.md'), '# Memory Index\n')
    check('只有标题的索引：不注入', host.contextText() === '')

    await host.tool('memory_remember', { slug: 'tmp-one', title: 'Tmp', body: 'tmp body text', description: 'x' })
    check('有条目就注入', host.contextText().includes('(tmp-one.md)'))
    await host.tool('memory_forget', { id: 'tmp-one' })
    check('删光之后重新不注入（不再每轮带一个空标题）', host.contextText() === '')

    // 字节超限：描述写满 120 个汉字
    const cjk = '这是一条用来测试索引字节上限的中文摘要'.repeat(8).slice(0, 118)
    for (let i = 0; i < 80; i += 1) {
      writeMemory(host.memoryDir, { slug: `entry-${String(i).padStart(3, '0')}`, title: `T${i}`, description: cjk, body: `body ${i}`, type: 'project' })
    }
    const maxBytes = 25 * 1024
    const injected = host.contextText()
    const index = injected.slice(injected.indexOf('# Memory Index'))
    const listed = (index.match(/^- \[/gm) ?? []).length
    check('超过字节上限：确实截断了', listed < 80 && listed > 0, `列出 ${listed}/80`)
    const warning = /\[WARNING\] (\d+) of (\d+) memory entries are NOT listed above/.exec(index)
    check('  …并且写明了省略的条数', warning && Number(warning[1]) === 80 - listed && Number(warning[2]) === 80, warning && warning[0])
    check('  …整段索引（含警告）不超过字节上限', Buffer.byteLength(index, 'utf8') <= maxBytes, `${Buffer.byteLength(index, 'utf8')} bytes`)
    check('  …警告是最后一行', index.trimEnd().split('\n').pop().startsWith('[WARNING]'))

    // 行数超限
    const lines = makeHost(mod, { config: { maxMemoryCount: 0, indexMaxLines: 50 } })
    try {
      for (let i = 0; i < 70; i += 1) writeMemory(lines.memoryDir, { slug: `e-${String(i).padStart(3, '0')}`, title: `T${i}`, description: 's', body: `body ${i}`, type: 'project' })
      const text = lines.contextText()
      const idx = text.slice(text.indexOf('# Memory Index'))
      const shown = (idx.match(/^- \[/gm) ?? []).length
      check('超过行数上限：截断并写明省略条数', /\[WARNING\] (\d+) of 70 memory entries/.test(idx) && shown < 70, `列出 ${shown}`)
      check('  …整段索引（含警告）不超过行数上限', idx.split('\n').length <= 50, `${idx.split('\n').length} 行`)
    } finally {
      lines.cleanup()
    }

    // 没超限：不出现警告，原样注入
    const small = makeHost(mod)
    try {
      for (let i = 0; i < 5; i += 1) writeMemory(small.memoryDir, { slug: `s-${i}`, title: `S${i}`, description: 'ok', body: `b${i} body`, type: 'project' })
      const text = small.contextText()
      check('没超限：不出现警告', !text.includes('[WARNING]') && (text.match(/^- \[/gm) ?? []).length === 5)
    } finally {
      small.cleanup()
    }
  } finally {
    host.cleanup()
  }
}

section('预取段与索引拼接')
{
  const host = makeHost(mod, { config: { maxMemoryCount: 0, indexMaxLines: 50 } })
  try {
    for (let i = 0; i < 70; i += 1) writeMemory(host.memoryDir, { slug: `p-${String(i).padStart(3, '0')}`, title: `Topic ${i}`, description: `desc ${i}`, body: i === 3 ? 'zebra-quartz unique marker' : `body ${i}`, type: 'project' })
    await host.fire('agent/pre-step', { agent: { id: 'agent-1' }, messages: [{ role: 'user', content: 'tell me about zebra-quartz unique marker' }], turn: 1 })
    const text = host.contextText()
    const warnAt = text.indexOf('[WARNING]')
    const prefetchAt = text.indexOf('[相关记忆]')
    check('截断警告与预取段同时存在', warnAt > 0 && prefetchAt > 0, `warn ${warnAt} prefetch ${prefetchAt}`)
    check('预取段在警告之后、各占自己的段落', prefetchAt > warnAt && text.slice(warnAt, prefetchAt).endsWith('\n\n'))
    check('预取段命中了该条', text.slice(prefetchAt).includes('p-003'))
  } finally {
    host.cleanup()
  }
}

summary()
