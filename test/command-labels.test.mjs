/**
 * 斜杠命令回执的叫法（2026-11-15 面板重设计，接口约定 G）：
 *   · 只给人看的命令回执用面板的叫法：全局指令 / 项目指令 / 通用记忆 / 项目记忆；
 *     分类「关于你 / 做事要求 / 项目决定 / 资料位置 / 踩坑经验」；
 *     来源「你的原话 · 已核对 / 说是你的原话 · 没核对上 / 你的原话 · 旧条目未核对 / Agent 总结」；用「章」不用「节」。
 *   · 给模型看的文字一律不动（系统提示段、工具描述与参数说明、工具返回值、MEMORY.md 索引）——
 *     最后一节守住「这些文字里不出现面板叫法」，免得以后有人把它们顺手也改了。
 *
 * 全部在临时目录；结束时比对真实 ~/.dsh/AGENTS.md 与全局按需库的哈希。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
import { readFileSync } from 'node:fs'
import { makeHost, makeReporter, realFilesGuard } from './fake-host.mjs'

const mod = await import('../index.js')
const { check, section, summary } = makeReporter()
const guard = realFilesGuard()
const AGENTS = '# 规则\n\n## 1. 回答风格\n\n先给结论。\n'
const PANEL_WORDS = [
  ...Object.values(mod.LIBRARY_LABELS),
  ...Object.values(mod.INSTRUCTION_LABELS),
  ...Object.values(mod.TYPE_LABELS),
  '已核对',
  '没核对上',
  'Agent 总结',
]

section('显示名常量（与面板同一套）')
{
  check('分类', JSON.stringify(mod.TYPE_LABELS) === JSON.stringify({ user: '关于你', feedback: '做事要求', project: '项目决定', reference: '资料位置', pitfall: '踩坑经验' }))
  check('两个库', mod.LIBRARY_LABELS.project === '项目记忆' && mod.LIBRARY_LABELS.global === '通用记忆')
  check('两份指令', mod.INSTRUCTION_LABELS.global === '全局指令' && mod.INSTRUCTION_LABELS.project === '项目指令')
  check('来源四种', mod.sourceLabel({ source: 'user', evidenceVerified: true }) === '  你的原话 · 已核对' &&
    mod.sourceLabel({ source: 'user', evidenceVerified: 'false' }) === '  说是你的原话 · 没核对上' &&
    mod.sourceLabel({ source: 'user' }) === '  你的原话 · 旧条目未核对' &&
    mod.sourceLabel({ source: 'agent' }) === '  Agent 总结' &&
    mod.sourceLabel({}) === '')
}

section('/memory 总览、/memory list：两个库分开，分类用显示名')
{
  const host = makeHost(mod, { config: { maxMemoryCount: 30 } })
  try {
    const empty = await host.command('memory', 'list')
    check('两个库都空 → 一句话', empty.kind === 'success' && empty.text === '项目记忆和通用记忆里都还没有记忆。', empty.text)

    mod.writeMemory(host.memoryDir, { slug: 'p-dec', title: '项目决定一条', body: 'x', type: 'project' })
    mod.writeMemory(host.memoryDir, { slug: 'p-pit', title: '踩坑一条', body: 'x', type: 'pitfall' })
    mod.writeMemory(host.globalDir, { slug: 'g-ref', title: '资料在哪', body: 'x', type: 'reference', scope: 'global' })

    const overview = await host.command('memory', '')
    check('总览：项目记忆条数、上限与分类', /^项目记忆：2 条（上限 30 条）  项目决定 1 · 踩坑经验 1$/m.test(overview.text), overview.text)
    check('  …通用记忆单独一行', /^通用记忆：1 条（上限 30 条）  资料位置 1$/m.test(overview.text), overview.text)
    check('  …不再有英文的 Memories / Global 行，也没有裸分类键', !/Memories:|Global \(all projects|^\s+project: \d/m.test(overview.text), overview.text)

    const list = await host.command('memory', 'list')
    const lines = list.text.split('\n')
    check('/memory list：分组标题带库名、forget 用的英文键与条数', lines[0] === '项目记忆（project）2 条：' && lines.includes('通用记忆（global）1 条：'), list.text)
    check('  …每行分类是显示名', lines.some((line) => line === '  p-pit  [踩坑经验]  踩坑一条') && lines.some((line) => line === '  g-ref  [资料位置]  资料在哪'), list.text)
    check('  …通用记忆的条目在它自己的组里', list.text.indexOf('g-ref') > list.text.indexOf('通用记忆（global）'))

    const listCmd = await host.command('memory_list', undefined)
    check('/memory_list：两库分开计数 + 待确认', listCmd.kind === 'success' && listCmd.text.includes('项目记忆 2 条，通用记忆 1 条，待确认 0 条'), listCmd.text)
    check('  …描述新面板的四页，不再说「卡片」', /总览/.test(listCmd.text) && /待确认/.test(listCmd.text) && /指令/.test(listCmd.text) && /记忆里/.test(listCmd.text) && !listCmd.text.includes('卡片'), listCmd.text)
    const listDescription = host.commands.get('memory_list').description
    check('/memory_list 的命令描述（补全菜单那行）与新面板相符', listDescription === '打开记忆面板：总览、待确认、指令、记忆', listDescription)

    const forgot = await host.command('memory', 'forget g-ref')
    check('/memory forget 回执用库的显示名', forgot.kind === 'success' && forgot.text.startsWith('已删除 g-ref（通用记忆；') && !/undefined/.test(forgot.text), forgot.text)
    mod.writeMemory(host.globalDir, { slug: 'p-dec', title: '同名', body: 'x', scope: 'global' })
    const ambiguous = await host.command('memory', 'forget p-dec')
    check('  …两个库都命中：说明 project / global 各指哪个库', ambiguous.kind === 'error' && ambiguous.text.includes('project（项目记忆）或 global（通用记忆）') && ambiguous.text.includes('p-dec（项目记忆，project）'), ambiguous.text)

    const reindex = await host.command('memory', 'reindex')
    check('/memory reindex 回执用库的显示名', reindex.kind === 'success' && reindex.text.includes('项目记忆的索引已重建') && reindex.text.includes('通用记忆的索引已重建'), reindex.text)
  } finally {
    host.cleanup()
  }
}

section('/memory pending 与 /memory accept：去向、分类、来源用显示名，「章」不用「节」')
{
  const host = makeHost(mod)
  try {
    host.write(host.agentsFile, AGENTS)
    mod.writePending(host.memoryDir, { id: 'dr_upd', title: '回答风格', body: '先给结论再展开。', type: 'feedback', scope: 'global', load: 'always', chapter: 1, chapterTitle: '回答风格', source: 'user', evidence: '先给结论', evidenceVerified: true })
    mod.writePending(host.memoryDir, { id: 'dr_new', title: '新的一章', body: 'x', type: 'user', scope: 'global', load: 'always', newChapter: true, source: 'agent' })
    mod.writePending(host.memoryDir, { id: 'dr_projall', title: '本项目常驻', body: 'x', scope: 'project', load: 'always' })
    mod.writePending(host.memoryDir, { id: 'dr_glob', title: '通用的', body: 'x', type: 'reference', scope: 'global', load: 'on-demand', source: 'user', evidence: 'x', evidenceVerified: false })
    mod.writePending(host.memoryDir, { id: 'dr_proj', title: '项目的', body: 'x', type: 'project', scope: 'project', load: 'on-demand', slug: 'proj-draft' })
    const out = await host.command('memory', 'pending')
    const line = (id) => out.text.split('\n').find((l) => l.startsWith(id)) ?? ''
    check('写进全局指令、更新某一章：按章标题说', line('dr_upd').includes('[做事要求]') && line('dr_upd').includes('→ 全局指令（') && line('dr_upd').includes('更新「回答风格」这一章') && line('dr_upd').endsWith('你的原话 · 已核对'), line('dr_upd'))
    check('写进全局指令、新增一章', line('dr_new').includes('[关于你]') && line('dr_new').includes('新增一章') && line('dr_new').endsWith('Agent 总结'), line('dr_new'))
    check('本项目常驻 → 项目指令（插件不收）', line('dr_projall').includes('→ 项目指令（'), line('dr_projall'))
    check('通用记忆 / 项目记忆', line('dr_glob').includes('→ 通用记忆') && line('dr_glob').endsWith('说是你的原话 · 没核对上') && line('dr_proj').includes('→ 项目记忆'), out.text)
    check('不出现旧叫法与「节」', !/所有项目（按需）|本工作区|模型得出|未核实|节/.test(out.text), out.text)

    const accProj = await host.command('memory', 'accept dr_proj')
    check('/memory accept 按需草稿 → 项目记忆 <文件>', accProj.kind === 'success' && accProj.text.startsWith('已收下 dr_proj → 项目记忆 proj-draft.md') && !/undefined/.test(accProj.text), accProj.text)
    const accGlob = await host.command('memory', 'accept dr_glob')
    check('/memory accept 按需草稿 → 通用记忆', accGlob.kind === 'success' && accGlob.text.includes('→ 通用记忆 '), accGlob.text)
    const accUpd = await host.command('memory', 'accept dr_upd')
    check('/memory accept 常驻草稿 → 全局指令（带文件位置），更新了一章', accUpd.kind === 'success' && accUpd.text.includes('→ 全局指令（') && accUpd.text.includes('AGENTS.md') && accUpd.text.includes('更新了一章'), accUpd.text)
    check('  …章节确实更新了', readFileSync(host.agentsFile, 'utf8').includes('先给结论再展开。'))
  } finally {
    host.cleanup()
  }
}

section('给模型看的文字不用面板叫法（这些文字经过模型评测，不随面板改）')
{
  const host = makeHost(mod)
  try {
    const sections = host.sections.map((def) => (typeof def.text === 'function' ? def.text() : String(def.text ?? def.content ?? ''))).join('\n')
    const toolText = [...host.tools.values()].map((def) => JSON.stringify({ d: def.description, p: def.parameters })).join('\n')
    const hits = (text) => PANEL_WORDS.filter((word) => text.includes(word))
    check('（自检）系统提示段与工具定义确实收集到了', sections.length > 200 && host.tools.has('memory_remember') && toolText.length > 1000)
    check('系统提示段不含面板叫法', hits(sections).length === 0, hits(sections).join(', '))
    check('工具描述与参数说明不含面板叫法', hits(toolText).length === 0, hits(toolText).join(', '))
    // 留一条记忆、再删另一条：读 MEMORY.md 时库里确实有条目，索引检查才不是空转（复现 06a）
    mod.writeMemory(host.memoryDir, { slug: 'keep-rule', title: 'Keep this rule', description: 'a surviving entry', body: 'body', type: 'project' })
    mod.writeMemory(host.memoryDir, { slug: 'some-rule', title: 'Some rule', body: 'body' })
    const status = await host.tool('memory_status', {})
    check('memory_status 的返回文字照旧（[project] memories: …）', /\[project\] memories: 2/.test(status.text) && hits(status.text).length === 0, status.text)
    const forgot = await host.tool('memory_forget', { id: 'some-rule' })
    check('memory_forget 的返回文字照旧（英文，不含面板叫法）', /Deleted memory some-rule/.test(forgot.text) && hits(forgot.text).length === 0, forgot.text)
    const index = readFileSync(`${host.memoryDir}/MEMORY.md`, 'utf8')
    const entryLines = index.split(/\r?\n/).filter((line) => /^- \[.*\]\(.*\.md\)/.test(line))
    check('（自检）索引里确实有条目行，检查不是空转', entryLines.length === 1 && entryLines[0].includes('keep-rule.md'), index)
    check('MEMORY.md 索引（含条目行）不含面板叫法', hits(index).length === 0, index)
  } finally {
    host.cleanup()
  }
}

check('真实的 ~/.dsh/AGENTS.md 与全局按需库一个字节没变', guard.unchanged())
summary()
