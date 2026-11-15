/**
 * 准入判据（该不该记、记到哪）的**摆放结构**，以及「策略不是过滤器」。
 *
 * 2026-11-14 第二轮按官方插件开发说明分三层，同一条规则只出现一处：
 *   · 系统提示段 MEMORY_SECTION（ctx.systemPrompt.section）：何时想到要记、四个归宿怎么选；
 *     practices.md：「Add prompt text with ctx.systemPrompt.section()」。
 *   · 工具说明 REMEMBER_DESCRIPTION：只写做什么、何时用、返回什么。
 *   · 参数说明：TYPE_RULES / BODY_RULE / SOURCE_RULE … 各挂在自己的参数上；
 *     tool-design.md：「Put parameter rules on the parameter」「Say each fact once」。
 * 抽取提示词是另一次独立的模型调用，由同一批常量拼成。
 *
 * 措辞会在评测里反复改，所以这里**只守结构**（哪段在哪、各出现一次、长度上限），不断言具体句子。
 *
 * 代码能给的是**确定性护栏**：`paths` 写得不像路径 → 静默失效，必须当场说出来。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { makeHost, makeReporter, realFilesGuard } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()

/** 全部路径都在临时目录（makeHost 经 apply 传入）；agentWrites: direct 让「agent 来源」直写——这里测的是写进去之后的提示，不是分流。 */
const host = (config = {}) => makeHost(mod, { config: { duplicateCheck: false, ...config } })

/** text 里 needle 出现了几次（不重叠计数）。 */
const occurrences = (text, needle) => (needle ? text.split(needle).length - 1 : 0)

section('paths 校验：不像路径的必须能认出来')
{
  check('带目录 → 通过', mod.pathHintIssue('dsh-workspace-memory/index.js') === '')
  check('带扩展名 → 通过', mod.pathHintIssue('README.md') === '')
  check('目录形式 → 通过', mod.pathHintIssue('docs/') === '')
  check('通配 → 通过', mod.pathHintIssue('*.md') === '')
  check('纯中文名词 → 不是路径', mod.pathHintIssue('插件配置') === 'not-a-path')
  check('URL → 不是路径', mod.pathHintIssue('https://example.com/a') === 'url-not-path')
  check('空串 → empty', mod.pathHintIssue('') === 'empty')
}

section('写入时把无效 paths 说出来（否则提示永远触发不了）')
{
  const env = host()
  try {
    const bad = await env.tool('memory_remember', {
      slug: 'with-bad-paths',
      title: '带错误路径的记忆',
      description: '测试',
      body: '正文。',
      type: 'reference',
      source: 'agent',
      paths: ['dsh-workspace-memory/index.js', '插件配置', 'https://example.com/x'],
    })
    check('仍然写入（不硬拦）', typeof bad.id === 'string', JSON.stringify(bad))
    check('返回里带 pathWarnings', Array.isArray(bad.pathWarnings) && bad.pathWarnings.length === 2, JSON.stringify(bad.pathWarnings))
    check('文本里点名了问题条目', bad.text.includes('插件配置'), bad.text)
    check('文本里给了正确写法', /relative to the workspace root/.test(bad.text))
    check('合法的那条没被误报', !(bad.pathWarnings ?? []).includes('dsh-workspace-memory/index.js'))

    const good = await env.tool('memory_remember', {
      slug: 'with-good-paths',
      title: '路径都正确的记忆',
      description: '测试',
      body: '另一条正文。',
      type: 'reference',
      source: 'agent',
      paths: ['dsh-workspace-memory/index.js', 'dsh-workspace-memory/client.js'],
    })
    check('全合法时不出现 pathWarnings', good.pathWarnings === undefined, JSON.stringify(good.pathWarnings))
    check('文本里也没有警告', !/Warning:/.test(good.text), good.text)
  } finally {
    env.cleanup()
  }
}

/** 规则常量 → 它挂在哪个参数上（§6.1(d)）。 */
const PARAM_RULES = {
  // 第四轮：slug 必填（评测里 8 次写入有 6 次第一次漏 slug）；description 写记忆本身（索引每轮可见）
  slug: 'SLUG_RULE',
  description: 'DESCRIPTION_RULE',
  type: 'TYPE_RULES',
  body: 'BODY_RULE',
  source: 'SOURCE_RULE',
  evidence: 'EVIDENCE_RULE',
  scope: 'SCOPE_RULE',
  load: 'LOAD_RULE',
  supersedes: 'SUPERSEDES_RULE',
  paths: 'PATHS_RULE',
}

section('三层结构：参数规则就是对应常量，工具说明只写做什么 / 何时用 / 返回什么')
{
  const env = host()
  try {
    const tool = env.tools.get('memory_remember')
    const schema = tool.parameters
    const description = tool.description ?? ''

    check('注册的工具说明就是导出的 REMEMBER_DESCRIPTION', description === mod.REMEMBER_DESCRIPTION)
    for (const [param, name] of Object.entries(PARAM_RULES)) {
      check(`${name} 已导出且非空`, typeof mod[name] === 'string' && mod[name].trim().length > 0)
      check(`  …${param} 参数的说明就是 ${name}`, schema.properties[param]?.description === mod[name], schema.properties[param]?.description)
    }
    check('工具说明含 WORTH_SAVING（与抽取提示词共用的「值得记 / 不值得记」）', description.includes(mod.WORTH_SAVING))

    // 不重复：每条规则在「工具说明 + 全部参数说明」里只出现一次（官方：Say each fact once）
    const toolText = [description, ...Object.values(schema.properties).map((p) => p.description ?? '')].join('\n')
    for (const name of [...Object.values(PARAM_RULES), 'WORTH_SAVING']) {
      check(`${name} 在工具说明 + 参数说明里恰好出现一次`, occurrences(toolText, mod[name]) === 1, `${occurrences(toolText, mod[name])} 次`)
    }
    check('工具说明里没有任何一条参数规则（参数规则写在参数上）', Object.values(PARAM_RULES).every((name) => !description.includes(mod[name])))
    check('工具定义里不重复系统提示段的归宿判断（HOMES 只给离线抽取用）', !toolText.includes(mod.HOMES) && !toolText.includes(mod.MEMORY_SECTION))

    // 长度：description 的上限从第一轮的 4800 收紧到 1000——规则挪到了参数上，说明只剩「做什么、何时用、返回什么」。
    // 合计上限 4500：工具定义每次请求都随 schema 发出（官方 tool-design.md：Measure the change）。
    const paramChars = Object.values(schema.properties).reduce((sum, p) => sum + (p.description ?? '').length, 0)
    check('工具说明 < 1000 字符', description.length < 1000, `${description.length} 字符`)
    check('工具说明 + 全部参数说明 < 4500 字符', description.length + paramChars < 4500, `${description.length} + ${paramChars} = ${description.length + paramChars}`)

    // 第四轮加了 slug；提示词第二版（§12.3）加了 scope——代理模型评测里 scope 多数没填、全落在默认值
    check('required = slug / title / body / type / source / scope', JSON.stringify([...schema.required].sort()) === JSON.stringify(['body', 'scope', 'slug', 'source', 'title', 'type']), JSON.stringify(schema.required))
    // 宿主不校验 required：模型仍漏填 scope 时照常写入，取默认 project（不因漏填拒写）
    const noScope = await env.tool('memory_remember', { slug: 'no-scope-given', title: 'No scope given', body: 'x', type: 'project', source: 'agent' })
    check('scope 缺失 → 取默认 project 照常写入（不拒写）', typeof noScope.id === 'string' && noScope.scope === 'project' && !noScope.reason, JSON.stringify(noScope))
    check('「改主意 / 改错用 supersedes」写在工具说明里，supersedes 参数只说它是什么（不重复）',
      /pass supersedes instead of saving a second one/.test(description) && schema.properties.supersedes.description === mod.SUPERSEDES_RULE && !/changed their mind|turned out wrong/.test(mod.SUPERSEDES_RULE))
    check('WORTH_SAVING 只含 worth / not worth 两句（supersedes 那句不进抽取提示词复用的这一段）', !/supersedes/.test(mod.WORTH_SAVING) && mod.WORTH_SAVING.split('. ').length <= 3)
    // §9.4：说明里不再让模型「告诉用户在面板里等」——直写时它也这么说了；怎么对用户说由返回文本给出
    check('工具说明不再叫模型说「在面板里等确认」', !/memory panel/.test(description) && description.endsWith("Returns the saved id, a pending id when the memory waits for the user's review, or a refusal that says what to change."), description)
    check('source / load / type 有枚举，type 含 pitfall', schema.properties.source?.enum?.join() === 'user,agent' && schema.properties.load?.enum?.join() === 'on-demand,always' && schema.properties.type.enum.includes('pitfall'))
    check('chapter / newChapter 写明只在 load: always 时有意义',
      /Only with load "always"/.test(schema.properties.chapter.description) && /Only with load "always"/.test(schema.properties.newChapter.description))
    check('不再有自评置信度（参数与说明里都没有）', !('confidence' in schema.properties) && !/confidence/i.test(toolText))
  } finally {
    env.cleanup()
  }
}

section('系统提示段：注册了 workspace-memory，文本是 MEMORY_SECTION')
{
  const env = host()
  try {
    const registered = env.sections.filter((def) => def.name === 'workspace-memory')
    check('恰好注册了一个名为 workspace-memory 的段', registered.length === 1, JSON.stringify(env.sections.map((def) => def.name)))
    const def = registered[0] ?? {}
    check('  …文本就是导出的 MEMORY_SECTION（静态字符串）', def.text === mod.MEMORY_SECTION && typeof def.text === 'string')
    check('  …order 是有限数（宿主对非有限数会抛错）', typeof def.order === 'number' && Number.isFinite(def.order), String(def.order))
    check('  …interpolate: false（文本按字面保留）', def.interpolate === false)
    for (const word of ['skill', 'AGENTS.md', 'AGENTS.local.md', 'README', 'memory_remember']) {
      check(`  …含「${word}」`, mod.MEMORY_SECTION.includes(word))
    }
    // §14.1（用户拍板）：跨项目的做事与表达要求进全局 AGENTS.md 常驻——段落里写明 scope global + load always
    for (const word of ['always', 'global']) {
      check(`  …含「${word}」（常驻去处写进了段落）`, mod.MEMORY_SECTION.includes(word))
    }
    for (const name of [...Object.values(PARAM_RULES), 'WORTH_SAVING', 'HOMES']) {
      check(`  …不含 ${name}（规则只出现在一处）`, !mod.MEMORY_SECTION.includes(mod[name]))
    }

    check('context 两个库都空时是空串', env.contextText() === '')
    mod.writeMemory(env.memoryDir, { slug: 'one', title: 'One', description: 'one entry', body: 'x' })
    const text = env.contextText()
    check('context 有条目时只放索引，不含系统提示段的内容', text.startsWith('[workspace-memory]') && !text.includes(mod.MEMORY_SECTION) && !text.includes('记忆与知识沉淀'), text.slice(0, 120))
  } finally {
    env.cleanup()
  }
}

section('第一轮的片段常量已作废（内容已分散到三层）')
{
  for (const name of ['HOME_ACTION', 'ADMISSION_RULE', 'NEVER_SAVE', 'WHERE_RULE', 'WRITE_HINT']) {
    check(`${name} 不再导出`, mod[name] === undefined)
  }
}

section('抽取提示词：同一批常量拼成（单一口径守卫）')
{
  const system = mod.EXTRACTION_SYSTEM
  for (const name of ['HOMES', 'WORTH_SAVING', 'DESCRIPTION_RULE', 'TYPE_RULES', 'BODY_RULE', 'SOURCE_RULE', 'EVIDENCE_RULE', 'SCOPE_RULE', 'LOAD_RULE']) {
    check(`EXTRACTION_SYSTEM 含 ${name}`, system.includes(mod[name]))
  }
  check('证据核对不过标为未核实（抽取侧补的一句）', system.includes(`${mod.EVIDENCE_RULE} An item whose evidence is not found is marked unverified.`))
  check('抽取提示词不再说「核对不过会被丢弃」', !system.includes('is dropped'))
  check('不含系统提示段（离线抽取看不到它，也不能提问、不能写文件）', !system.includes(mod.MEMORY_SECTION))
  check('只抽归宿是记忆的', /Extract only items whose home is memory/.test(system))
  check('「多数对话没有可记的」放在最前', system.startsWith('You extract durable memories') && /Most conversations yield none/.test(system.split('\n')[0]))
  check('字段含 load / source / evidence 与 pitfall 类型', /"load": "on-demand"\|"always"/.test(system) && /"source": "user"\|"agent"/.test(system) && /"evidence": string/.test(system) && /"pitfall"/.test(system))
  check('不再要 confidence', !/confidence/i.test(system))
}

section('判据是策略不是过滤器：明显是任务指令的也不会被硬拦')
{
  const env = host()
  try {
    // 这一条是在记录「为什么不做内容过滤」：判据无法可靠自动化，
    // 硬拦会误伤（"改成 X" 有时确实是长期约定）。所以交给判据 + 人的审核。
    const result = await env.tool('memory_remember', {
      slug: 'task-like',
      title: '把颜色改成蓝色',
      description: '看起来像任务指令',
      body: '把主色调改成蓝色。',
      type: 'project',
      source: 'agent',
    })
    check('不硬拦（策略靠判据，不靠正则）', typeof result.id === 'string' && !result.reason, JSON.stringify(result))
  } finally {
    env.cleanup()
  }
}

section('真实文件未被本次测试改动')
check('真实 AGENTS.md 与全局按需库的存在性与哈希不变', guard.unchanged())

summary()
