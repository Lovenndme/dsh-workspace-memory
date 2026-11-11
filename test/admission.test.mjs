/**
 * 准入判据（该不该记）与写入/更新时机。
 *
 * 这一层大部分是**策略**而不是过滤：什么值得记没法用代码判定，
 * 所以判据写在 `memory_remember` 的工具描述里——它随工具 schema 进入上下文，
 * 不额外占注入预算，正好是模型做决定的地方。
 *
 * 代码能给的是**确定性护栏**：
 *   · `paths` 写得不像路径 → 静默失效，必须当场说出来
 *
 * 本测试同时守住「策略文本没被改丢」——描述被重写而判据消失是无声的退化。
 */
import { mkdtempSync, rmSync } from 'node:fs'
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

function makeEnv(config = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-admission-'))
  const workspace = path.join(root, 'ws')
  const tools = []

  const ctx = {
    effect(fn) {
      try {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      } catch {
        return () => {}
      }
    },
    on() { return () => {} },
    commands: { register: () => {}, },
    tools: { register: (def) => { tools.push(def); return () => {} } },
    systemPrompt: { context: () => () => {} },
    webServer: { register: () => () => {} },
    agents: { currentInitiator: () => null, },
    sessions: { get: () => ({ id: 's-adm' }) },
    workingDirectory: { get: () => workspace },
    get() { return undefined },
  }

  mod.apply(ctx, { agentsFile: path.join(root, 'AGENTS.md'), duplicateCheck: false, ...config })

  const projectDir = path.join(os.homedir(), '.dsh', 'projects', mod.encodeProjectPath(workspace))
  return {
    root,
    tool: tools.find((entry) => entry.name === 'memory_remember'),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
      mod.configure(undefined)
    },
  }
}

console.log('== paths 校验：不像路径的必须能认出来 ==')
{
  check('带目录 → 通过', mod.pathHintIssue('dsh-workspace-memory/index.js') === '')
  check('带扩展名 → 通过', mod.pathHintIssue('README.md') === '')
  check('目录形式 → 通过', mod.pathHintIssue('docs/') === '')
  check('通配 → 通过', mod.pathHintIssue('*.md') === '')
  check('纯中文名词 → 不是路径', mod.pathHintIssue('插件配置') === 'not-a-path')
  check('URL → 不是路径', mod.pathHintIssue('https://example.com/a') === 'url-not-path')
  check('空串 → empty', mod.pathHintIssue('') === 'empty')
}

console.log('\n== 写入时把无效 paths 说出来（否则提示永远触发不了）==')
{
  const env = makeEnv()
  try {
    const bad = await env.tool.execute(
      {
        slug: 'with-bad-paths',
        title: '带错误路径的记忆',
        description: '测试',
        body: '正文。',
        paths: ['dsh-workspace-memory/index.js', '插件配置', 'https://example.com/x'],
        confidence: 0.95,
      },
      { agent: { id: 'a-adm' } },
    )
    check('仍然写入（不硬拦）', typeof bad.id === 'string', JSON.stringify(bad))
    check('返回里带 pathWarnings', Array.isArray(bad.pathWarnings) && bad.pathWarnings.length === 2, JSON.stringify(bad.pathWarnings))
    check('文本里点名了问题条目', bad.text.includes('插件配置'), bad.text)
    check('文本里给了正确写法', /relative to the workspace root/.test(bad.text))
    check('合法的那条没被误报', !(bad.pathWarnings ?? []).includes('dsh-workspace-memory/index.js'))

    const good = await env.tool.execute(
      {
        slug: 'with-good-paths',
        title: '路径都正确的记忆',
        description: '测试',
        body: '另一条正文。',
        paths: ['dsh-workspace-memory/index.js', 'dsh-workspace-memory/client.js'],
        confidence: 0.95,
      },
      { agent: { id: 'a-adm' } },
    )
    check('全合法时不出现 pathWarnings', good.pathWarnings === undefined, JSON.stringify(good.pathWarnings))
    check('文本里也没有警告', !/Warning:/.test(good.text), good.text)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 工具描述承载准入判据（防无声退化）==')
{
  const env = makeEnv()
  try {
    const description = env.tool.description ?? ''
    check('含五条准入测试', /Admission test/.test(description), description.slice(0, 120))
    check('明确排除任务指令', /task instruction/i.test(description))
    check('明确排除状态类', /status \("I am working on X"\)/.test(description) || /I am working on X/.test(description))
    check('指出纠正是最强信号', /corrections are the strongest signal/i.test(description))
    check('写入时机：任务结束而非中途', /at the END/i.test(description))
    check('更新时机：supersedes 而非新建', /supersedes="<id>"/.test(description))
    check('两张不同记忆并存更糟', /worse than one/i.test(description))
    check('scope 适用范围说明', /EVERY project/.test(description))
    check('paths 的用途说明', /file-triggered hint/i.test(description))
    check('描述长度可控（不超 2000 字符）', description.length < 2000, `${description.length} 字符`)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 判据是策略不是过滤器：明显是任务指令的也不会被硬拦 ==')
{
  const env = makeEnv()
  try {
    // 这一条是在记录「为什么不做内容过滤」：判据无法可靠自动化，
    // 硬拦会误伤（"改成 X" 有时确实是长期约定）。所以交给判据 + 人的审核。
    const result = await env.tool.execute(
      {
        slug: 'task-like',
        title: '把颜色改成蓝色',
        description: '看起来像任务指令',
        body: '把主色调改成蓝色。',
        confidence: 0.95,
      },
      { agent: { id: 'a-adm' } },
    )
    check('不硬拦（策略靠判据，不靠正则）', typeof result.id === 'string', JSON.stringify(result))
  } finally {
    env.cleanup()
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
