/**
 * `/memory` 斜杠命令族的用户体验（2026-11-15，HANDOFF 第二十八节）：
 *   · 输入提示与补全菜单那一行；
 *   · 总览按面板「记忆地图」排：待确认、每轮都读（全局指令 / 项目指令）、用到才查（通用记忆 / 项目记忆）、每轮固定开销；
 *     不出现本机路径、配置键名、向量维度；
 *   · 每轮固定开销与面板同一套算法：把宿主路由的真实响应喂给 client.js 的 normalize* / costParts / tokensOf 对拍；
 *   · /memory status、/memory help、未知子命令的「你是不是想输入」；
 *   · /memory pending 每条两行、/memory list 的截断与相对时间、/memory forget 的文案；
 *   · 中文按显示宽度对齐；
 *   · 客户端：命令卡的按钮、只敲 /memory 时的子命令选单（commandUi.decorate）。
 *
 * 全部在临时目录（经 apply 的 rawConfig 传路径），结束时比对真实 ~/.dsh/AGENTS.md 与全局按需库的哈希。
 * 不启动任何进程；路径断言不依赖分隔符，Linux CI 上同样成立。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHost, makeReporter, realFilesGuard } from './fake-host.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const API = '/api/dsh-workspace-memory'
const DAY = 864e5

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()

/* —— 取 client.js 的纯函数与插件定义（与 client-logic.test.mjs 同一办法：伪造 window.__ModuleLoader__ 与 require('react')） —— */
let pure = null
globalThis.__wsmCollectPure = (helpers) => {
  pure = helpers
}
let definition = null
globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
new Function('window', 'globalThis', readFileSync(path.join(HERE, '..', 'client.js'), 'utf8'))(globalThis.window, globalThis)
/** 极简的 createElement：只为了在 Node 里看清命令卡渲染出了什么。 */
const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
const plugin = definition.factory((name) => {
  if (name === 'react') return { createElement: el, useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }), useReducer: () => [0, () => {}] }
  throw new Error(`unexpected require: ${name}`)
})
const { normalizeAgents, normalizeProject, costParts, tokensOf, relTime } = pure

/** 宿主路由的响应 → client 的 api() 返回形状 `{ ok, status, payload }`。 */
const asApi = (res) => ({ ok: res.status >= 200 && res.status < 300, status: res.status, payload: res.body })

/** 文本里有没有本机路径（临时目录、主目录、任何盘符 / 绝对路径的样子）。 */
function leaksPath(text, host) {
  // 太短的（容器里主目录可能就是 /）不拿来比，免得把 /memory_list 当成路径
  const needles = [host.root, host.workspace, host.memoryDir, host.globalDir, os.homedir(), os.tmpdir(), process.env.DSH_HOME].filter((p) => p && p.length > 3)
  return needles.some((needle) => text.includes(needle)) || /[A-Za-z]:\\|\/(?:Users|home|tmp)\//.test(text)
}

/** 写一条记忆文件，modified 由测试指定（writeMemory 会把 modified 设成现在）。 */
function writeDated(dir, id, { title, type = 'project', modified, description = '' }) {
  mkdirSync(dir, { recursive: true })
  const lines = ['---', `title: ${title}`, `type: ${type}`, ...(description ? [`description: ${description}`] : []), ...(modified ? [`modified: ${modified}`] : []), '---', '', 'body', '']
  writeFileSync(path.join(dir, `${id}.md`), lines.join('\n'), 'utf8')
}

section('输入提示与补全菜单那一行')
{
  const host = makeHost(mod)
  try {
    const def = host.commands.get('memory')
    check('hint 只放最常用的几个，带中文含义', def.input?.hint === 'pending 待确认 · extract 抽取 · list 全部 · help 更多', def.input?.hint)
    check('  …hint 非空（空 hint 会让插件激活失败）', typeof def.input.hint === 'string' && def.input.hint.trim().length > 0)
    check('description 是一句中文，指向 help', /[一-鿿]/.test(def.description) && def.description.includes('/memory help') && !def.description.includes('|'), def.description)
    check('只注册 /memory 与 /memory_list（/memory_extract、/memory_pending 已收回成子命令）', host.commands.has('memory') && host.commands.has('memory_list') && !host.commands.has('memory_extract') && !host.commands.has('memory_pending') && host.commands.size === 2, [...host.commands.keys()].join(','))
  } finally {
    host.cleanup()
  }
}

section('显示宽度：中文算 2 格')
{
  check('displayWidth：ASCII 1、中文 2、全角标点 2', mod.displayWidth('ab') === 2 && mod.displayWidth('中文') === 4 && mod.displayWidth('「」') === 4 && mod.displayWidth('a·b') === 3)
  check('padDisplay 按显示宽度补齐', mod.padDisplay('中', 4) === '中  ' && mod.padDisplay('ab', 4) === 'ab  ' && mod.padDisplay('超出宽度', 2) === '超出宽度')
}

section('总览：有待确认、全局指令与项目指令都在')
{
  const host = makeHost(mod, { config: { maxMemoryCount: 30, maxAgentsBytes: 10000, agentWrites: 'review' } })
  try {
    mkdirSync(path.join(host.workspace, '.git'))
    writeFileSync(path.join(host.workspace, 'AGENTS.md'), 'team rule\n'.repeat(150), 'utf8') // 1500 字节
    host.write(host.agentsFile, `# 规则\n\n## 1. 回答风格\n\n先给结论。\n\n## 2. 提交\n\n${'x'.repeat(6000)}\n`)
    mod.writeMemory(host.memoryDir, { slug: 'p-dec', title: '项目决定一条', description: '一条项目决定', body: 'x', type: 'project' })
    mod.writeMemory(host.memoryDir, { slug: 'p-pit', title: '踩坑一条', body: 'x', type: 'pitfall' })
    mod.writeMemory(host.globalDir, { slug: 'g-ref', title: '资料在哪', body: 'x', type: 'reference', scope: 'global' })
    mod.writePending(host.memoryDir, { id: 'dr_one', title: '草稿', body: 'x', source: 'agent' })
    mod.writePending(host.memoryDir, { id: 'dr_two', title: '草稿二', body: 'x', source: 'agent' })

    const out = await host.command('memory', '')
    const lines = out.text.split('\n')
    check('第一行：记忆总览 · 工作区友好名', lines[0] === `记忆总览 · ${path.basename(host.workspace)}`, lines[0])
    check('第二行就是待确认，指向 pending 与面板', lines[1] === '待确认 2 条 → /memory pending 查看，或在记忆面板「待确认」页处理', lines[1])
    check('每轮都读：全局指令 章数 · 已用 / 上限 KB（百分比）', /^  全局指令  2 章 · 6\.\d \/ 10 KB（6\d%）$/m.test(out.text), out.text)
    check('每轮都读：项目指令 团队大小 · 仅你未创建', /^  项目指令  团队 1\.5 KB · 仅你 未创建$/m.test(out.text), out.text)
    check('用到才查：通用记忆在项目记忆前面（与面板地图的行序一致）', out.text.indexOf('  通用记忆  1 / 30 条 · 资料位置 1') > 0 && out.text.indexOf('  项目记忆  2 / 30 条 · 项目决定 1 · 踩坑经验 1') > out.text.indexOf('  通用记忆'), out.text)
    check('分组标题「每轮都读」「用到才查」', lines.includes('每轮都读') && lines.includes('用到才查') && lines.indexOf('每轮都读') < lines.indexOf('用到才查'))
    check('每轮固定开销约 N tokens，列出参与的几段', /^每轮固定开销约 [\d,]+ tokens（按字节粗估：全局指令 \+ 项目指令 · 团队 \+ 记忆索引）$/m.test(out.text), out.text)
    check('检索与写入方式是人话（agentWrites=review）', lines.some((l) => /^检索：(向量 \+ 关键词|只用关键词（装上 leanvec 能认出换个说法的问题）)$/.test(l)) && lines.includes('写入：Agent 自己总结的先进待确认；全局指令和项目指令只由你来写'), out.text)
    check('末尾一行指向面板与 help', lines.at(-1) === '/memory_list 打开面板 · /memory help 查看全部子命令', lines.at(-1))
    check('不超过 16 行', lines.length <= 16, String(lines.length))
    check('不出现本机路径', !leaksPath(out.text, host), out.text)
    check('不出现配置键名与向量维度', !/agentWrites|enableExtraction|maxAgentsBytes|256|leanvec，|dim/.test(out.text), out.text)
    check('不出现旧的子命令长串与英文', !/\| \/memory|Memories|Unknown/.test(out.text), out.text)

    // 每轮固定开销：宿主路由的真实响应 → 面板的 normalizeAgents / normalizeProject / costParts / tokensOf
    const sec = asApi(await host.http(`${API}/agents/sections`, { session: null }))
    const stat = asApi(await host.http(`${API}/agents`, { session: null }))
    const project = asApi(await host.http(`${API}/project-agents`))
    const list = asApi(await host.http(`${API}/list`))
    const D = { agents: normalizeAgents(sec, stat), project: normalizeProject(project), memories: list.payload.memories }
    const panelBytes = costParts(D).reduce((total, part) => total + part.bytes, 0)
    const panelTokens = tokensOf(panelBytes)
    const hostTokens = Number(/每轮固定开销约 ([\d,]+) tokens/.exec(out.text)?.[1].replace(/,/g, ''))
    check('（自检）面板这边四段都算到了', costParts(D).length === 3 && panelBytes > 6000, JSON.stringify(costParts(D)))
    check('总览的 tokens 与面板「每轮固定开销」一致', hostTokens === panelTokens, `宿主 ${hostTokens} / 面板 ${panelTokens}`)
    const hostParts = mod.perTurnCost({
      agentsBytes: D.agents.bytes,
      teamBytes: D.project.team.bytes,
      localBytes: D.project.local.bytes,
      libraries: ['project', 'global'].map((scope) => ({ items: D.memories.filter((m) => m.scope === scope) })),
    }).parts
    check('  …逐段字节也一致（全局指令 / 团队 / 索引）', JSON.stringify(hostParts.map((p) => [p.key, p.bytes])) === JSON.stringify(costParts(D).map((p) => [p.k, p.bytes])), `${JSON.stringify(hostParts)} / ${JSON.stringify(costParts(D))}`)

    // 加上「仅你」后同样一致：面板把 AGENTS.local.md 也算进每轮开销
    writeFileSync(path.join(host.workspace, 'AGENTS.local.md'), '只对我成立\n', 'utf8')
    const withLocal = await host.command('memory', '')
    const project2 = asApi(await host.http(`${API}/project-agents`))
    const D2 = { ...D, project: normalizeProject(project2) }
    const panel2 = tokensOf(costParts(D2).reduce((total, part) => total + part.bytes, 0))
    check('有「仅你」时：项目指令行显示它的大小（KB 写法与面板 kb() 相同）', /^  项目指令  团队 1\.5 KB · 仅你 0\.0 KB$/m.test(withLocal.text), withLocal.text)
    check('  …开销把「仅你」也算进去，仍与面板一致', Number(/约 ([\d,]+) tokens/.exec(withLocal.text)?.[1].replace(/,/g, '')) === panel2 && withLocal.text.includes('+ 项目指令 · 仅你 +'), withLocal.text)
  } finally {
    host.cleanup()
  }
}

section('总览：没有待确认、全局指令不存在、项目指令缺失、上限为 0 = 不限')
{
  const host = makeHost(mod, { config: { maxMemoryCount: 0, maxAgentsBytes: 0, agentWrites: 'direct' } })
  try {
    mkdirSync(path.join(host.workspace, '.git'))
    const out = await host.command('memory', '')
    const lines = out.text.split('\n')
    check('没有待确认 → 一句话', lines[1] === '没有待确认的内容', lines[1])
    check('全局指令不存在 →「还没有创建」，不报路径', /^  全局指令  还没有创建$/m.test(out.text), out.text)
    check('项目指令两份都没有 → 都「未创建」', /^  项目指令  团队 未创建 · 仅你 未创建$/m.test(out.text), out.text)
    check('两个库都空 →「还没有记忆」', /^  通用记忆  还没有记忆$/m.test(out.text) && /^  项目记忆  还没有记忆$/m.test(out.text), out.text)
    check('什么都没有 → 每轮没有固定开销', lines.includes('每轮没有固定带上的内容'), out.text)
    check('agentWrites=direct 的写入说明（直接存，不说成先进待确认）', lines.includes('写入：Agent 自己总结的记忆直接存；全局指令和项目指令只由你来写'), out.text)

    host.write(host.agentsFile, '# 规则\n\n## 1. 只有一章\n\n内容\n')
    mod.writeMemory(host.memoryDir, { slug: 'only', title: '唯一一条', body: 'x', type: 'user' })
    const unlimited = await host.command('memory', '')
    check('maxAgentsBytes = 0 → 不显示上限，写「不限大小」', /^  全局指令  1 章 · 0\.\d KB（不限大小）$/m.test(unlimited.text), unlimited.text)
    check('maxMemoryCount = 0 → 只写条数', /^  项目记忆  1 条 · 关于你 1$/m.test(unlimited.text), unlimited.text)
    check('不出现本机路径', !leaksPath(unlimited.text, host), unlimited.text)
  } finally {
    host.cleanup()
  }
}

section('总览：索引对不上、配置有问题时多一行提示')
{
  const host = makeHost(mod, { config: { notARealKey: 1 } })
  try {
    mod.writeMemory(host.memoryDir, { slug: 'listed', title: 'Listed', body: 'x' })
    writeDated(host.memoryDir, 'hand-written', { title: '手写的', modified: new Date().toISOString() }) // 手放的文件：索引里没有
    const out = await host.command('memory', '')
    check('索引和文件对不上 → 提示 /memory reindex', out.text.includes('注意：项目记忆的索引和记忆文件对不上') && out.text.includes('→ /memory reindex'), out.text)
    check('配置有问题 → 提示 /memory status', out.text.includes('注意：插件配置有 1 处问题，已按默认值处理 → /memory status 查看'), out.text)
    check('仍不超过 16 行', out.text.split('\n').length <= 16)
  } finally {
    host.cleanup()
  }
}

section('/memory status：诊断细节都在这里')
{
  const host = makeHost(mod, { config: { historyLimit: 0, unknownKey: true } })
  try {
    mkdirSync(path.join(host.workspace, '.git'))
    mod.writeMemory(host.memoryDir, { slug: 'p-one', title: 'P one', body: 'x' })
    const out = await host.command('memory', 'status')
    check('第一行：记忆状态 · 工作区名', out.kind === 'success' && out.text.split('\n')[0] === `记忆状态 · ${path.basename(host.workspace)}`, out.text)
    check('两个库各一组：位置、条数、每轮索引、索引文件、向量、历史版本', ['项目记忆', '通用记忆'].every((name) => out.text.split('\n').includes(name)) &&
      ['位置', '条数', '每轮索引', '索引文件', '向量', '历史版本'].every((label) => new RegExp(`^  ${label}\\s`, 'm').test(out.text)), out.text)
    check('全局指令、项目指令（团队 / 仅你）、待确认、检索、写入、自动抽取、配置问题', ['全局指令', '项目指令（会话目录往上最近的 .git 所在处）'].every((name) => out.text.includes(name)) &&
      ['团队', '仅你', '待确认', '检索', '写入', '自动抽取', '配置问题'].every((label) => new RegExp(`^ *${label}\\s`, 'm').test(out.text)), out.text)
    check('配置键名在诊断里照常出现（agentWrites、enableExtraction）', /agentWrites: direct/.test(out.text) && /enableExtraction/.test(out.text), out.text)
    check('配置问题逐条列出', out.text.includes('unknownKey: 未知配置项，已忽略'), out.text)
    check('historyLimit = 0 → 历史版本「不留」', /^  历史版本  不留（historyLimit 为 0）$/m.test(out.text), out.text)
    check('库的各项按显示宽度对齐（中文标签长短不一，值都从同一列开始）', (() => {
      const block = out.text.split('\n').filter((l) => /^ {2}(位置|条数|每轮索引|索引文件|向量|历史版本) /.test(l)).slice(0, 6)
      const valueAt = block.map((l) => {
        const m = /^( {2}\S+)( +)/u.exec(l)
        return m ? mod.displayWidth(m[1]) + m[2].length : -1
      })
      return block.length === 6 && new Set(valueAt).size === 1
    })(), out.text)
    const tool = await host.tool('memory_status', {})
    check('memory_status 工具（给模型的）没变：仍是英文的 [project] 行', /\[project\] memories: 1/.test(tool.text) && !tool.text.includes('记忆状态'), tool.text)
  } finally {
    host.cleanup()
  }
}

section('/memory help：分组，每个子命令一行')
{
  const host = makeHost(mod)
  try {
    const out = await host.command('memory', 'help')
    const lines = out.text.split('\n')
    check('三组：常用 / 需要 id 的操作 / 整理', out.kind === 'success' && lines.includes('常用') && lines.some((l) => l.startsWith('需要 id 的操作')) && lines.some((l) => l.startsWith('整理：/memory reindex')), out.text)
    for (const sub of ['pending', 'extract', 'list', 'status', 'accept <id>', 'reject <id>', 'forget <id>']) {
      check(`  …/memory ${sub} 有一行说明`, lines.some((l) => l.startsWith(`  /memory ${sub} `)), out.text)
    }
    check('需要 id 的三个都注明面板里对应哪个按钮', ['「收下」', '「丢弃」', '「删除这条记忆」'].every((button) => out.text.includes(button)), out.text)
    check('常用组的说明列对齐（按显示宽度）', (() => {
      const common = lines.slice(lines.indexOf('常用') + 1, lines.indexOf('常用') + 6)
      return new Set(common.map((l) => /^( {2}\/memory\S*(?: \S+)?)( +)/.exec(l)).map((m) => (m ? m[1].length + m[2].length : -1))).size === 1
    })(), out.text)
    const upper = await host.command('memory', 'HELP')
    check('子命令不分大小写', upper.kind === 'success' && upper.text === out.text)
  } finally {
    host.cleanup()
  }
}

section('未知子命令：中文提示 +「你是不是想输入」+ help')
{
  check('suggestSubcommand：前缀、对调、错一个字母、中文含义', mod.suggestSubcommand('pend') === 'pending' && mod.suggestSubcommand('lsit') === 'list' &&
    mod.suggestSubcommand('stats') === 'status' && mod.suggestSubcommand('acept') === 'accept' && mod.suggestSubcommand('待确认') === 'pending' &&
    mod.suggestSubcommand('总览') === '' && mod.suggestSubcommand('foo') === null && mod.suggestSubcommand('xyzzy') === null && mod.suggestSubcommand('re') === null)
  const host = makeHost(mod)
  try {
    const foo = await host.command('memory', 'foo')
    check('猜不出来：只说没有这个子命令 + help', foo.kind === 'error' && foo.text === '没有「/memory foo」这个子命令。\n/memory help 查看全部子命令。', foo.text)
    const typo = await host.command('memory', 'acept dr_1')
    check('打错：建议里带上其余参数', typo.kind === 'error' && typo.text.includes('你是不是想输入 /memory accept dr_1？') && typo.text.includes('/memory help'), typo.text)
    const zh = await host.command('memory', '待确认')
    check('照着提示打了中文：给出英文子命令，不直接执行', zh.kind === 'error' && zh.text.includes('你是不是想输入 /memory pending？'), zh.text)
    const overview = await host.command('memory', '总览')
    check('「总览」→ 建议 /memory 本身', overview.text.includes('你是不是想输入 /memory？'), overview.text)
    check('全部中文，没有英文残留', ![foo, typo, zh].some((r) => /Unknown|Use:|failed/.test(r.text)))
  } finally {
    host.cleanup()
  }
}

section('/memory pending：每条两行，结尾指向面板')
{
  const host = makeHost(mod)
  try {
    host.write(host.agentsFile, '# 规则\n\n## 1. 回答风格\n\n先给结论。\n')
    mod.writeMemory(host.memoryDir, { slug: 'old-pref', title: '旧偏好', body: 'x', type: 'feedback' })
    mod.writePending(host.memoryDir, { id: 'dr_upd', title: '回答风格', body: 'x', type: 'feedback', scope: 'global', load: 'always', chapter: 1, chapterTitle: '回答风格', source: 'user', evidence: '先给结论', evidenceVerified: true })
    mod.writePending(host.memoryDir, { id: 'dr_rep', title: '替换旧偏好', body: 'x', type: 'feedback', scope: 'project', load: 'on-demand', supersedes: 'old-pref', source: 'agent' })
    const out = await host.command('memory', 'pending')
    const lines = out.text.split('\n')
    check('标题行：待确认 N 条', lines[0] === '待确认 2 条：', lines[0])
    const at = lines.findIndex((l) => /^\d+\. \[做事要求\] 回答风格$/.test(l))
    check('第一行「N. [类型] 标题」', at > 0, out.text)
    check('第二行缩进「→ 去向 · 来源 · id」', lines[at + 1] === '   → 全局指令 · 更新「回答风格」这一章 · 你的原话 · 已核对 · dr_upd', lines[at + 1])
    check('替换旧记忆的草稿写明「替换」', lines.some((l) => l === '   → 项目记忆 · 替换 old-pref · Agent 总结 · dr_rep'), out.text)
    check('结尾提示面板与 accept / reject', lines.at(-1) === '在面板「待确认」页逐条收下或丢弃更方便；也可以 /memory accept <id> / reject <id>', lines.at(-1))
    check('不出现本机路径（以前去向里带 AGENTS.md 的位置）', !leaksPath(out.text, host), out.text)

    for (let i = 0; i < 10; i += 1) mod.writePending(host.memoryDir, { id: `dr_n${i}`, title: `第 ${i} 条`, body: 'x' })
    const many = (await host.command('memory', 'pending')).text.split('\n')
    const ten = many.findIndex((l) => l.startsWith('10. '))
    check('两位数序号：第二行缩进跟着变宽', ten > 0 && many[ten + 1].startsWith('    → '), many.slice(ten, ten + 2).join('\n'))

    const accepted = await host.command('memory', 'accept nope')
    check('收下不存在的草稿：说去哪查 id', accepted.kind === 'error' && accepted.text === '待确认队列里没有 nope。用 /memory pending 查看现有草稿的 id。', accepted.text)
    const noId = await host.command('memory', 'reject')
    check('缺 id：用法 + 面板按钮', noId.kind === 'error' && noId.text.includes('用法：/memory reject <id>') && noId.text.includes('「丢弃」'), noId.text)
    const rejected = await host.command('memory', 'reject dr_n0')
    check('丢弃：说明不留历史', rejected.kind === 'success' && rejected.text === '已丢弃 dr_n0（草稿直接删除，不留历史）', rejected.text)
  } finally {
    host.cleanup()
  }
}

section('/memory list：按更新时间倒序、相对时间、单库超过 30 条截断')
{
  const host = makeHost(mod)
  try {
    const now = Date.now()
    writeDated(host.memoryDir, 'three-days', { title: '三天前的', modified: new Date(now - 3 * DAY - 60e3).toISOString() })
    writeDated(host.memoryDir, 'yesterday', { title: '昨天的', type: 'pitfall', modified: new Date(now - DAY - 60e3).toISOString() })
    writeDated(host.memoryDir, 'two-months', { title: 'An English title', type: 'reference', modified: new Date(now - 65 * DAY).toISOString() })
    writeDated(host.memoryDir, 'no-modified', { title: '没有 modified 字段' }) // 回落文件时间：刚写的
    const out = await host.command('memory', 'list')
    const rows = out.text.split('\n').filter((l) => l.startsWith('  '))
    check('按更新时间倒序', rows.map((l) => l.trim().split(/\s+/)[0]).join(',') === 'no-modified,yesterday,three-days,two-months', out.text)
    check('相对时间：刚刚 / 昨天 / 3 天前 / 2 个月前', rows[0].endsWith('刚刚') && rows[1].endsWith('昨天') && rows[2].endsWith('3 天前') && rows[3].endsWith('2 个月前'), out.text)
    check('与面板 relTime 措辞一致', [0, 5 * 60e3, 3 * 3600e3, DAY + 1000, 6 * DAY, 95 * DAY].every((ago) => mod.relativeTimeZh(now - ago, now) === relTime(new Date(now - ago).toISOString(), now)))
    // 时间列从同一列开始：中英文标题混排时按显示宽度补齐
    const timeAt = rows.map((l) => mod.displayWidth(l.replace(/(刚刚|昨天|\d+ 天前|\d+ 个月前)$/, '')))
    check('中文标题与英文标题混排，时间列对齐', new Set(timeAt).size === 1, out.text)

    for (let i = 0; i < 33; i += 1) writeDated(host.globalDir, `g-${String(i).padStart(2, '0')}`, { title: `通用 ${i}`, modified: new Date(now - i * 3600e3).toISOString() })
    const many = await host.command('memory', 'list')
    const lines = many.text.split('\n')
    check('单库超过 30 条：标题写明只列最近 30 条', lines.includes('通用记忆（global）33 条，只列最近更新的 30 条：'), many.text)
    check('  …确实只列了 30 条，最旧的 3 条不在', lines.filter((l) => /^ {2}g-\d\d /.test(l)).length === 30 && !many.text.includes('g-32') && many.text.includes('g-00'), many.text)
    check('  …末尾指向面板看全部', lines.at(-1) === '全部条目在记忆面板「记忆」页查看：/memory_list', lines.at(-1))
    check('没超过的库照常列全', lines.includes('项目记忆（project）4 条：'))
  } finally {
    host.cleanup()
  }
}

section('/memory forget：准确说明旧版在哪，不说「可回退」')
{
  const host = makeHost(mod)
  try {
    mod.writeMemory(host.memoryDir, { slug: 'to-delete', title: '要删的', body: 'x' })
    const out = await host.command('memory', 'forget to-delete')
    check('第一行：已删除「标题」（id，库）', out.kind === 'success' && out.text.split('\n')[0] === '已删除「要删的」（to-delete，项目记忆）。', out.text)
    check('旧版位置用相对说法 + 怎么手动恢复', out.text.includes('旧版留在该库旁的 .memory-state/history/to-delete/ 里') && out.text.includes('改名为 to-delete.md，再 /memory reindex'), out.text)
    check('不说「可回退」，不出现本机路径', !out.text.includes('可回退') && !leaksPath(out.text, host), out.text)
    check('历史版本确实在那里', mod.listHistory(host.memoryDir, 'to-delete').length === 1)
    const missing = await host.command('memory', 'forget nope')
    check('找不到：中文 + 下一步', missing.kind === 'error' && missing.text.includes('/memory list'), missing.text)
  } finally {
    host.cleanup()
  }
  const noHistory = makeHost(mod, { config: { historyLimit: 0 } })
  try {
    mod.writeMemory(noHistory.memoryDir, { slug: 'gone', title: '没历史的', body: 'x' })
    const out = await noHistory.command('memory', 'forget gone')
    check('historyLimit = 0：如实说没有留历史版本', out.kind === 'success' && out.text.endsWith('配置里 historyLimit 为 0，没有留历史版本。') && !out.text.includes('.memory-state'), out.text)
  } finally {
    noHistory.cleanup()
  }
}

section('错误回执：没有英文残留，都给下一步')
{
  const host = makeHost(mod)
  try {
    host.state.cwd = null
    const noCwd = await host.command('memory', '')
    check('没有工作目录：中文 + 下一步', noCwd.kind === 'error' && noCwd.text.includes('请在打开了工作区的会话里') && !/Could not|memory root/.test(noCwd.text), noCwd.text)
  } finally {
    host.cleanup()
  }
  const source = readFileSync(path.join(HERE, '..', 'index.js'), 'utf8')
  const commandPart = source.slice(source.indexOf('async function executeMemoryCommand'))
  check('命令实现里不再有 Could not resolve / Memory command failed / Unknown subcommand', !/Could not resolve the memory root|Memory command failed|Unknown subcommand/.test(commandPart))
}

/* —— 客户端：命令卡与子命令选单 —— */

/** 用假 ctx 跑一遍 client 的 apply：收集命令卡组件与 decorate 的注册。 */
function applyClient({ commandUi, sessions, inject = true } = {}) {
  const cards = new Map()
  const opened = []
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: { inject: (_name, fn) => fn(), register: (meta, component) => (meta.key && cards.set(meta.key, component), () => {}) },
    get: (name) => {
      if (name === 'sidebarRightTabs') return { register: () => () => {} }
      if (name === 'layout') return { openRightbar: () => opened.push('rightbar') }
      if (name === 'sidebarRight') return { openTab: (kind) => opened.push(kind) }
      return undefined
    },
    ...(inject
      ? {
          inject: (deps, callback) => {
            const scope = { commandUi, sessions, effect: ctx.effect, get: (name) => ({ commandUi, sessions })[name] }
            if (deps.every((dep) => scope.get(dep))) callback(scope)
          },
        }
      : {}),
  }
  plugin.apply(ctx)
  return { cards, opened }
}
const textOf = (node) => (node == null ? '' : typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''))
const findAll = (node, type, out = []) => {
  if (node && typeof node === 'object') {
    if (node.type === type) out.push(node)
    for (const child of node.children ?? []) findAll(child, type, out)
  }
  return out
}

section('客户端命令卡：保留等宽文本，下面一个按钮')
{
  const { cards, opened } = applyClient()
  const Card = cards.get('memory')
  check('memory / memory_extract / memory_pending 共用同一张卡', Card && cards.get('memory_extract') === Card && cards.get('memory_pending') === Card)
  const list = Card({ node: { name: 'memory', args: ' list', outcome: { kind: 'success', text: '项目记忆（project）0 条' } } })
  const buttons = findAll(list, 'button')
  check('文本仍在 <pre> 里（对齐需要等宽）', findAll(list, 'pre').length === 1 && textOf(findAll(list, 'pre')[0]) === '项目记忆（project）0 条')
  check('标题带上子命令：/memory list', textOf(list.children[0]) === '/memory list', textOf(list.children[0]))
  check('普通卡的按钮：打开记忆面板', buttons.length === 1 && textOf(buttons[0]) === '打开记忆面板', textOf(buttons[0]))
  buttons[0].props.onClick()
  check('  …点了打开右侧栏的记忆面板', opened.includes('rightbar') && opened.includes('memory-list'), JSON.stringify(opened))
  const pendingSub = Card({ node: { name: 'memory', args: ' pending', outcome: { kind: 'success', text: 'x' } } })
  const pendingCmd = Card({ node: { name: 'memory_pending', args: null, outcome: { kind: 'success', text: 'x' } } })
  check('/memory pending 与 /memory_pending 的卡：去面板处理', textOf(findAll(pendingSub, 'button')[0]) === '去面板处理' && textOf(findAll(pendingCmd, 'button')[0]) === '去面板处理')
  const running = Card({ node: { name: 'memory', args: '', outcome: null } })
  check('还在执行时不出按钮', findAll(running, 'button').length === 0 && textOf(running).includes('…'))
  const error = Card({ node: { name: 'memory', args: ' foo', outcome: { kind: 'error', text: '没有「/memory foo」这个子命令。' } } })
  check('出错的卡也有按钮', findAll(error, 'button').length === 1)
}

section('客户端：只敲 /memory 时的子命令选单（commandUi.decorate）')
{
  const decorations = []
  const ran = []
  const commandUi = { decorate: (decoration) => (decorations.push(decoration), () => {}) }
  let reply = { ok: true, value: { matched: true } }
  const sessions = { binding: (id) => (id === 's1' ? { session: { command: async (line) => (ran.push(line), reply) } } : undefined) }
  const { opened } = applyClient({ commandUi, sessions })
  const decoration = decorations[0]
  check('给宿主命令 memory 挂了一个 popupSelect', decorations.length === 1 && decoration.name === 'memory' && decoration.ui.kind === 'popupSelect' && decoration.available({ sessionId: 's1' }) === true)
  const options = await decoration.ui.options({ sessionId: 's1' }, new AbortController().signal)
  check('行序：总览、pending、extract、list、status | accept、reject、forget | reindex、help', options.map((o) => o.id).join(',') === 'overview,pending,extract,list,status,accept,reject,forget,reindex,help', options.map((o) => o.id).join(','))
  check('三组：常用 / 需要 id 的操作 / 整理', [...new Set(options.map((o) => o.group.label))].join('|') === '常用|需要 id 的操作（在面板里点按钮更方便）|整理')
  check('总览标 active：回车两下 = 以前的 /memory 回车', options.filter((o) => o.active).map((o) => o.id).join() === 'overview')
  check('每行有中文标题与说明，说明里写着对应的命令（搜索能按英文子命令找到）', options.every((o) => o.label && /\/memory/.test(o.detail)) && options.find((o) => o.id === 'pending').detail.startsWith('/memory pending'))
  check('搜索框文案', decoration.ui.searchLabels().placeholder === '筛选 /memory 子命令')

  await decoration.ui.onSelect(options.find((o) => o.id === 'pending'), { sessionId: 's1' })
  await decoration.ui.onSelect(options.find((o) => o.id === 'overview'), { sessionId: 's1' })
  check('选中常用项：经会话执行对应的命令行', ran.join('|') === '/memory pending|/memory', ran.join('|'))
  await decoration.ui.onSelect(options.find((o) => o.id === 'accept'), { sessionId: 's1' })
  check('选中需要 id 的项：打开面板，不执行命令', ran.length === 2 && opened.includes('memory-list'), JSON.stringify({ ran, opened }))
  reply = { ok: true, value: { matched: false } }
  let thrown = ''
  try {
    await decoration.ui.onSelect(options.find((o) => o.id === 'list'), { sessionId: 's1' })
  } catch (error) {
    thrown = error.message
  }
  check('宿主没认出命令：抛出中文错误（选单的错误条会显示）', thrown.startsWith('没能执行 /memory list：'), thrown)
  thrown = ''
  try {
    await decoration.ui.onSelect(options.find((o) => o.id === 'list'), { sessionId: 'gone' })
  } catch (error) {
    thrown = error.message
  }
  check('会话不在：抛出中文错误', thrown === '这个会话还没准备好，稍后再试', thrown)

  let threw = false
  try {
    applyClient({ commandUi: {}, sessions })
    applyClient({ inject: false })
  } catch {
    threw = true
  }
  check('旧版 DSH（commandUi 没有 decorate、ctx 没有 inject）：什么都不做，不抛', !threw)
}

check('真实的 ~/.dsh/AGENTS.md 与全局按需库一个字节没变', guard.unchanged())
summary()
