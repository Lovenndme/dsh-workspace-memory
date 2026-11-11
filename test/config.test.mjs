/**
 * Config 校验测试。
 *
 * 原则：**一个配置笔误不该让整个记忆系统不加载**。所以 resolveConfig 永不抛，
 * 坏值退回默认值并记录 issue，issue 通过 memory_status 暴露给用户。
 */
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

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
