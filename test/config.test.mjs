/**
 * Config 校验测试。
 *
 * 原则：**一个配置笔误不该让整个记忆系统不加载**。所以 resolveConfig 永不抛，
 * 坏值退回默认值并记录 issue，issue 通过 memory_status 暴露给用户。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
const mod = await import('../index.js')

let failures = 0
const check = (label, cond, detail) => {
  if (cond) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const R = mod.resolveConfig

console.log('== 缺省 ==')
{
  for (const raw of [undefined, null]) {
    const r = R(raw)
    check(`raw=${String(raw)} 用默认值且无 issue`, r.issues.length === 0 && r.config.minVectorScore === 0.3, JSON.stringify(r.issues))
  }
}

console.log('\n== 合法覆盖 ==')
{
  const r = R({ minVectorScore: 0.4, weightVector: 0.5, indexMaxLines: 300, enableExtraction: true, memoryDir: 'C:\\tmp\\mem' })
  check('全部生效', r.issues.length === 0, JSON.stringify(r.issues))
  check('minVectorScore=0.4', r.config.minVectorScore === 0.4, String(r.config.minVectorScore))
  check('weightVector=0.5', r.config.weightVector === 0.5, String(r.config.weightVector))
  check('indexMaxLines=300', r.config.indexMaxLines === 300, String(r.config.indexMaxLines))
  check('enableExtraction=true', r.config.enableExtraction === true)
  check('memoryDir 保留绝对路径', r.config.memoryDir === 'C:\\tmp\\mem', r.config.memoryDir)
}

console.log('\n== 字符串数字可接受 ==')
{
  const r = R({ minKeywordScore: '0.7' })
  check('"0.7" -> 0.7', r.config.minKeywordScore === 0.7 && r.issues.length === 0, JSON.stringify(r))
}

console.log('\n== 坏值退回默认并记录 issue ==')
const BAD = [
  ['超范围 minVectorScore=9', { minVectorScore: 9 }, 'minVectorScore'],
  ['负数 maxTags', { maxTags: -3 }, 'maxTags'],
  ['非数字 weightVector', { weightVector: 'abc' }, 'weightVector'],
  ['布尔项传字符串', { enableExtraction: 'yes' }, 'enableExtraction'],
  ['memoryDir 非绝对路径', { memoryDir: 'relative/path' }, 'memoryDir'],
  ['memoryDir 非字符串', { memoryDir: 123 }, 'memoryDir'],
]
for (const [label, raw, field] of BAD) {
  const r = R(raw)
  const mentioned = r.issues.some((i) => i.startsWith(`${field}:`))
  check(`${label} -> 记录 issue 且不抛`, mentioned && r.issues.length > 0, JSON.stringify(r.issues))
}

console.log('\n== 未知键被忽略并提示 ==')
{
  const r = R({ totallyUnknownKey: 1 })
  check('记录未知键', r.issues.some((i) => i.includes('totallyUnknownKey')), JSON.stringify(r.issues))
  check('不写进 config', !('totallyUnknownKey' in r.config), JSON.stringify(Object.keys(r.config)))
}

console.log('\n== 非对象 config ==')
{
  for (const raw of ['str', 42, []]) {
    const r = R(raw)
    check(`拒绝 ${JSON.stringify(raw)}`, r.issues.length > 0 && typeof r.config === 'object', JSON.stringify(r.issues))
  }
}

console.log('\n== 覆盖项确实影响行为（阈值变严后噪声查询仍应 0 条） ==')
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-cfg-'))
  const dir = path.join(tmp, '.dsh-memory')
  try {
    mod.writeMemory(dir, { title: '发布前跑全量测试', body: '每次发布前必须跑完整测试套件并全绿。', type: 'project' })
    await mod.rebuildVectors(dir)
    const before = await mod.recall(dir, '今天天气怎么样', 3)
    check('默认阈值下无关查询 0 条', before.results.length === 0, JSON.stringify(before.results.map((r) => r.title)))
    const hit = await mod.recall(dir, '发布前要跑测试吗', 3)
    check('相关查询能命中', hit.results.length > 0 && hit.results[0].title.includes('发布'), JSON.stringify(hit.results.map((r) => r.title)))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\n== 字符串配置项必须真正生效（防「静默丢弃」回归）==')
{
  const os = await import('node:os')
  const path = await import('node:path')
  // 历史 bug：agentsFile / editorExe 在 DEFAULT_CONFIG 里，但 resolveConfig 没有
  // 对应分支，值被静默丢弃——配置写了却完全不生效，也不报错。
  const r = mod.configure({
    agentsFile: path.join(os.tmpdir(), 'wsm-agents.md'),
    editorExe: 'D:\\Tools\\Typora.exe',
  })
  check('agentsFile 被接受', r.config.agentsFile.endsWith('wsm-agents.md'), r.config.agentsFile)
  check('editorExe 被接受', r.config.editorExe === 'D:\\Tools\\Typora.exe', r.config.editorExe)
  check('没有产生 issues', r.issues.length === 0, r.issues.join(' | '))

  const bad = mod.configure({ agentsFile: 123 })
  check(
    '非字符串被拒绝并报错',
    bad.config.agentsFile === '' && bad.issues.some((issue) => issue.startsWith('agentsFile:')),
    bad.issues.join(' | '),
  )

  mod.configure(undefined)
}

console.log('\n== 写入准入重设计的三个新键：设置后读得出来 ==')
{
  const os = await import('node:os')
  const path = await import('node:path')
  const defaults = R({})
  check('默认 agentWrites = review', defaults.config.agentWrites === 'review')
  check('默认 globalMemoryDir 为空（= <dshHome>/dsh-workspace-memory/global/memory）', defaults.config.globalMemoryDir === '')
  check('默认 globalIndexMaxLines = 60', defaults.config.globalIndexMaxLines === 60)

  const dir = path.join(os.tmpdir(), 'wsm-global-cfg', 'memory')
  const r = mod.configure({ agentWrites: 'direct', globalMemoryDir: dir, globalIndexMaxLines: 0 })
  check('三个键都生效且没有 issue', r.issues.length === 0, r.issues.join(' | '))
  check('agentWrites = direct', r.config.agentWrites === 'direct')
  check('globalMemoryDir 原样保留绝对路径', r.config.globalMemoryDir === dir, r.config.globalMemoryDir)
  check('globalMemoryDirOf() 用的就是它', mod.globalMemoryDirOf() === dir, mod.globalMemoryDirOf())
  check('globalIndexMaxLines = 0（不注入全局索引）', r.config.globalIndexMaxLines === 0)

  const home = R({ globalMemoryDir: '~/somewhere/memory' })
  check('globalMemoryDir 支持 ~ 开头', home.config.globalMemoryDir === path.join(os.homedir(), 'somewhere', 'memory'), home.config.globalMemoryDir)
  check('globalIndexMaxLines 上限 200', R({ globalIndexMaxLines: 200 }).config.globalIndexMaxLines === 200)

  for (const [label, raw, field] of [
    ['agentWrites 非法值', { agentWrites: 'always' }, 'agentWrites'],
    ['agentWrites 非字符串', { agentWrites: 1 }, 'agentWrites'],
    ['globalMemoryDir 相对路径', { globalMemoryDir: 'relative/dir' }, 'globalMemoryDir'],
    ['globalMemoryDir 非字符串', { globalMemoryDir: 5 }, 'globalMemoryDir'],
    ['globalIndexMaxLines 超范围', { globalIndexMaxLines: 201 }, 'globalIndexMaxLines'],
    ['globalIndexMaxLines 负数', { globalIndexMaxLines: -1 }, 'globalIndexMaxLines'],
  ]) {
    const bad = R(raw)
    check(`${label} → 记录 issue 并退回默认`, bad.issues.some((i) => i.startsWith(`${field}:`)) && bad.config[field] === defaults.config[field], JSON.stringify(bad.issues))
  }
  check('agentWrites 空串 = 默认值，不算错', R({ agentWrites: '' }).issues.length === 0 && R({ agentWrites: '' }).config.agentWrites === 'review')

  mod.configure(undefined)
  // 2026-11-14 第二轮：默认位置改为以包名做命名空间（官方首方包先例），并跟随宿主主目录（dshHome()）
  check('恢复默认后 globalMemoryDirOf() 指向 <dshHome>/dsh-workspace-memory/global/memory',
    mod.globalMemoryDirOf() === path.join(mod.dshHome(), 'dsh-workspace-memory', 'global', 'memory'), mod.globalMemoryDirOf())
  // 只比路径字符串，不碰那个目录
  const saved = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    check('  …没设 DSH_HOME 时就是 ~/.dsh 下面', mod.globalMemoryDirOf() === path.join(os.homedir(), '.dsh', 'dsh-workspace-memory', 'global', 'memory'), mod.globalMemoryDirOf())
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
}

console.log('\n== 两个废弃键：给废弃 issue，不当成未知键 ==')
{
  for (const key of ['directWriteConfidence', 'minExtractConfidence']) {
    const r = R({ [key]: 0.8 })
    const issue = r.issues.find((i) => i.startsWith(`${key}:`)) ?? ''
    check(`${key} → 废弃说明（指向 agentWrites）`, /已废弃/.test(issue) && /agentWrites/.test(issue), issue)
    check(`${key} → 不说「未知配置项」`, !/未知配置项/.test(issue), issue)
    check(`${key} → 不进 config`, !(key in r.config))
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
