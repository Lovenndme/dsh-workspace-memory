/**
 * 写入 AGENTS.md（promote）的格式与保护测试。
 *
 * 全部使用**隔离临时数据**：临时记忆库 + 临时 AGENTS.md 文件，
 * 不读写真实的 ~/.dsh/AGENTS.md，也不动真实记忆库。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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

/** 建一个隔离环境：临时记忆库 + 临时 AGENTS.md。 */
function makeEnv(initialAgents) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-promote-'))
  const memoryDir = path.join(root, 'memory')
  const agentsFile = path.join(root, 'AGENTS.md')
  writeFileSync(agentsFile, initialAgents, 'utf8')
  mod.configure({ agentsFile })
  return { root, memoryDir, agentsFile, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const BASE_AGENTS = '# 全局工作准则\n\n## 已有的一节\n\n已有内容。\n'

console.log('== 标题层级：正文标题必须下沉到 ### ==')
{
  const env = makeEnv(BASE_AGENTS)
  try {
    mod.writeMemory(env.memoryDir, {
      slug: 'a',
      title: '新规则',
      description: '摘要',
      type: 'project',
      scope: 'global',
      body: '## 子标题\n\n正文内容。\n\n### 孙标题\n\n更深的内容。',
    })
    const result = mod.promoteToAgents(env.memoryDir, 'a')
    check('promote 成功', result.ok === true, JSON.stringify(result))

    const text = readFileSync(env.agentsFile, 'utf8')
    // 文件既有约定：`## N. 标题` + `### N.M 子标题`，promote 必须跟随编号，
    // 否则每写入一次就把 AGENTS.md 的统一格式破坏一次。
    check('外层标题带编号', /^## 1\. 新规则$/m.test(text), text)
    check('正文 ## 下沉成带编号的 ###', /^### 1\.1 子标题$/m.test(text), text)
    check('正文 ### 下沉成 ####', /^#### 孙标题$/m.test(text), text)
    check('不存在与外壳同级的裸 ## 子标题', !/^## 子标题$/m.test(text), text)
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 尾部出身说明被剥离 ==')
{
  const env = makeEnv(BASE_AGENTS)
  try {
    mod.writeMemory(env.memoryDir, {
      slug: 'b',
      title: '带迁移备注',
      description: '摘要',
      type: 'project',
      scope: 'global',
      body: '正文。\n\n---\n\n迁移自 @yolk_vat-y/dsh-project-memory：id=ins_1',
    })
    mod.promoteToAgents(env.memoryDir, 'b')
    const text = readFileSync(env.agentsFile, 'utf8')
    check('正文保留', text.includes('正文。'), text)
    check('迁移备注被剥离', !text.includes('迁移自'), text)
    check('分隔线一并剥离', !/^---$/m.test(text.split('## 带迁移备注')[1] ?? ''), text)
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 不破坏已有内容 ==')
{
  const env = makeEnv(BASE_AGENTS)
  try {
    mod.writeMemory(env.memoryDir, {
      slug: 'c',
      title: '追加项',
      description: '摘要',
      type: 'project',
      scope: 'global',
      body: '只有正文。',
    })
    mod.promoteToAgents(env.memoryDir, 'c')
    const text = readFileSync(env.agentsFile, 'utf8')
    check('原有标题仍在', text.startsWith('# 全局工作准则\n\n## 已有的一节'), text.slice(0, 60))
    check('原有正文仍在', text.includes('已有内容。'), text)
    check('新节追加在末尾', text.trimEnd().endsWith('-->'), text.slice(-60))
    check('带来源注释（HTML 注释，渲染时不可见）', /<!-- 来自记忆 c，写入于 \d{4}-\d{2}-\d{2} -->/.test(text), text.slice(-80))
    check('节之间只有一个空行', !/\n{3,}/.test(text), JSON.stringify(text.match(/\n{3,}/g)))
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 保护 1：同名不重复追加 ==')
{
  const env = makeEnv(BASE_AGENTS + '\n## 同名节\n\n原有内容。\n')
  try {
    mod.writeMemory(env.memoryDir, {
      slug: 'd',
      title: '同名节',
      description: '摘要',
      type: 'project',
      scope: 'global',
      body: '新内容。',
    })
    const result = mod.promoteToAgents(env.memoryDir, 'd')
    check('被拒绝', result.ok === false && result.reason === 'already-present', JSON.stringify(result))
    const text = readFileSync(env.agentsFile, 'utf8')
    check('文件未被改动', (text.match(/## 同名节/g) ?? []).length === 1, text)
    check('记忆仍保留', existsSync(path.join(env.memoryDir, 'd.md')), '被误删')
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 保护 2：非跨项目记忆不允许写 ==')
{
  const env = makeEnv(BASE_AGENTS)
  try {
    mod.writeMemory(env.memoryDir, {
      slug: 'e',
      title: '仅本项目',
      description: '摘要',
      type: 'project',
      scope: 'project',
      body: '内容。',
    })
    const result = mod.promoteToAgents(env.memoryDir, 'e')
    check('被拒绝', result.ok === false && result.reason === 'scope-not-global', JSON.stringify(result))
    check('AGENTS.md 未被改动', readFileSync(env.agentsFile, 'utf8') === BASE_AGENTS)
    check('记忆仍保留', existsSync(path.join(env.memoryDir, 'e.md')))
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 保护 3：写入后记忆移出项目库，但历史留档 ==')
{
  const env = makeEnv(BASE_AGENTS)
  try {
    mod.writeMemory(env.memoryDir, {
      slug: 'f',
      title: '会被搬走',
      description: '摘要',
      type: 'project',
      scope: 'global',
      body: '搬走前的正文。',
    })
    const result = mod.promoteToAgents(env.memoryDir, 'f')
    check('结果为成功且已移除', result.ok === true && result.memoryRemoved === true, JSON.stringify(result))
    check('记忆文件已删除', !existsSync(path.join(env.memoryDir, 'f.md')))
    const history = mod.listHistory(env.memoryDir, 'f')
    check('历史里留了一份', history.length === 1, String(history.length))
    check('历史内容可回退', history.length ? readFileSync(history[0].file, 'utf8').includes('搬走前的正文。') : false)
  } finally {
    env.cleanup()
    mod.configure(undefined)
  }
}

console.log('\n== 保护 4：AGENTS.md 不存在时明确失败 ==')
{
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-promote-'))
  try {
    mod.configure({ agentsFile: path.join(root, 'missing.md') })
    mod.writeMemory(path.join(root, 'memory'), {
      slug: 'g',
      title: '目标文件缺失',
      description: '摘要',
      type: 'project',
      scope: 'global',
      body: '内容。',
    })
    const result = mod.promoteToAgents(path.join(root, 'memory'), 'g')
    check('返回 agents-missing', result.ok === false && result.reason === 'agents-missing', JSON.stringify(result))
    check('记忆未被删除', existsSync(path.join(root, 'memory', 'g.md')))
  } finally {
    rmSync(root, { recursive: true, force: true })
    mod.configure(undefined)
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
