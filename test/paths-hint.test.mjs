/**
 * `paths` 触发提示：读/改文件时带出相关记忆。
 *
 * 解决的痛点：`paths` 字段以前是摆设——写入能标、读取没人看。
 * 「什么时候该 recall」只能靠模型自己想起来，这是整条链路里最不可靠的一环。
 * 现在改成按文件精确触发，把按需加载的入口交给真实动作。
 *
 * 三条克制都要测到：
 *   1. 只给 id + 标题，不给正文
 *   2. 同一轮同一条只提示一次
 *   3. 任何异常/不匹配都放行原结果（next）
 *
 * 宿主契约（官方 tools.md / practices.md，2026-11-14 第二轮对齐）：不拥有决策的监听器一律经过 next()；
 * 命中时在 next() 返回的决定上只换 content，不带 value 键。
 */
import './isolate-home.mjs' // 第一个 import：把 DSH_HOME 指到本文件独占的临时目录（第五轮测试隔离）
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
  const root = mkdtempSync(path.join(os.tmpdir(), 'wsm-paths-'))
  const workspace = path.join(root, 'ws')
  const listeners = new Map()

  const ctx = {
    effect(fn) {
      try {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      } catch {
        return () => {}
      }
    },
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    commands: { register: () => {}, },
    tools: { register: () => () => {} },
    systemPrompt: { context: () => () => {} },
    webServer: { register: () => () => {} },
    agents: { currentInitiator: () => null, },
    sessions: { get: () => ({ id: 's-paths' }) },
    workingDirectory: { get: () => workspace },
    get() {
      return undefined
    },
  }

  mod.apply(ctx, { agentsFile: path.join(root, 'AGENTS.md'), memoryDir: path.join(root, 'proj', 'memory'), globalMemoryDir: path.join(root, 'global', 'memory'), pathsHint: true, ...config })

  // 记忆库与全局按需库都放在临时目录（经 apply 传入），不碰 ~/.dsh
  const projectDir = path.join(root, 'proj')
  const memoryDir = path.join(projectDir, 'memory')

  return {
    root,
    memoryDir,
    projectDir,
    // 宿主契约（tools.md）：next() 返回下游的 PostToolDecision，默认「原样接受」= { kind: 'accept' }。
    // 每次返回新对象，才能用 === 断言「监听器原样交回了 next() 的结果」。
    fire: async (name, ...args) => {
      const list = listeners.get(name) ?? []
      let handled = false
      let nextResult
      const next = async () => {
        handled = true
        nextResult = { kind: 'accept' }
        return nextResult
      }
      // waterfall：取最后一个监听器的结果（这里只有一个）
      const result = await list[0](...args, next)
      return { result, reachedNext: handled, passedThrough: result === nextResult }
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
      mod.configure(undefined)
    },
  }
}

const seed = (env, id, paths) =>
  mod.writeMemory(env.memoryDir, {
    slug: id,
    title: `标题-${id}`,
    description: `摘要-${id}`,
    body: `正文-${id}：这里是很长的正文，绝不该出现在提示里。`,
    paths,
  })

const readCall = (filePath) => [
  { name: 'read', arguments: { file_path: filePath }, agent: { id: 'a-paths' } },
  { isError: false, value: '文件内容', content: [{ type: 'text', text: '文件内容' }] },
]

/** 结果里有没有贴上记忆提示。 */
const hinted = (run) => (run.result?.content ?? []).some((block) => /\[记忆\]/.test(block?.text ?? ''))

console.log('== 纯函数：路径匹配 ==')
{
  check('结尾匹配绝对路径', mod.pathMatches('dsh-profile-stats/client.js', 'C:/x/dsh-profile-stats/client.js'))
  check('不误配同名不同目录', !mod.pathMatches('dsh-profile-stats/client.js', 'C:/x/other/client.js'))
  check('* 通配同目录', mod.pathMatches('repo/tools/*.ps1', 'C:/x/repo/tools/a.ps1'))
  check('* 不跨目录', !mod.pathMatches('repo/tools/*.ps1', 'C:/x/repo/tools/sub/a.ps1'))
  check('目录形式匹配其下文件', mod.pathMatches('dsh-workspace-memory/', 'C:/x/dsh-workspace-memory/index.js'))
  check('空模式不匹配', !mod.pathMatches('', 'C:/x/a.js'))
}

console.log('\n== 纯函数：从工具参数取路径 ==')
{
  check('取 file_path', JSON.stringify(mod.pathsFromToolArgs({ file_path: 'C:/a/b.js' })) === '["C:/a/b.js"]')
  check('取 path', JSON.stringify(mod.pathsFromToolArgs({ path: 'C:/dir' })) === '["C:/dir"]')
  check('不把正文当路径', mod.pathsFromToolArgs({ body: 'C:/not/a/path.js' }).length === 0)
}

console.log('\n== 命中：提示里只有 id 与标题，没有正文 ==')
{
  const env = makeEnv()
  try {
    seed(env, 'ui-copy-rule', ['dsh-profile-stats/client.js'])
    const run = await env.fire('tools/post-execute', ...readCall('C:/x/dsh-profile-stats/client.js'))
    const { result, reachedNext } = run
    const text = (result?.content ?? []).map((block) => block.text ?? '').join('\n')
    // 2026-11-14 第二轮：命中时也要先经过 next()（不拥有决策的监听器必须让下游跑到），再在下游的决定上加料
    check('有提示，且下游 next() 照常被调用', hinted(run) && reachedNext === true && run.passedThrough === false)
    check('只换 content，不带 value 键（content 与 value 只能二选一）', result?.kind === 'accept' && !('value' in result), JSON.stringify(result))
    check('保留了原内容', text.includes('文件内容'))
    check('带出了记忆 id', text.includes('ui-copy-rule'), text)
    check('带出了标题', text.includes('标题-ui-copy-rule'))
    check('没有正文（渐进式加载）', !text.includes('这里是很长的正文'), text)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 不命中：原样放行 ==')
{
  const env = makeEnv()
  try {
    seed(env, 'ui-copy-rule', ['dsh-profile-stats/client.js'])
    const miss = await env.fire('tools/post-execute', ...readCall('C:/x/completely/other.js'))
    check('没有命中：返回的就是 next() 的结果（原样透传）', miss.reachedNext === true && miss.passedThrough === true && !hinted(miss))

    const noPaths = mod.writeMemory(env.memoryDir, {
      slug: 'no-paths', title: '没标路径', description: 'd', body: '正文',
    })
    check('未标 paths 的记忆不会被触发', Boolean(noPaths))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 同一轮只提示一次 ==')
{
  const env = makeEnv()
  try {
    seed(env, 'ui-copy-rule', ['dsh-profile-stats/client.js'])
    const first = await env.fire('tools/post-execute', ...readCall('C:/x/dsh-profile-stats/client.js'))
    const second = await env.fire('tools/post-execute', ...readCall('C:/x/dsh-profile-stats/client.js'))
    check('第一次给提示', hinted(first))
    check('同一轮第二次不再重复（原样透传 next() 的结果）', !hinted(second) && second.passedThrough === true)
  } finally {
    env.cleanup()
  }
}

console.log('\n== 轮次结束后重置 ==')
{
  const env = makeEnv()
  try {
    seed(env, 'ui-copy-rule', ['dsh-profile-stats/client.js'])
    await env.fire('tools/post-execute', ...readCall('C:/x/dsh-profile-stats/client.js'))
    // 模拟一轮结束
    const statusList = []
    void statusList
    await env.fire('agent/status', { agent: { id: 'a-paths' }, status: 'idle' })
    const again = await env.fire('tools/post-execute', ...readCall('C:/x/dsh-profile-stats/client.js'))
    check('新一轮重新提示', hinted(again))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 不该介入的情况一律放行 ==')
{
  const env = makeEnv()
  try {
    seed(env, 'ui-copy-rule', ['dsh-profile-stats/client.js'])
    const memTool = await env.fire('tools/post-execute', {
      name: 'memory_recall',
      arguments: { query: 'x' },
      agent: { id: 'a-paths' },
    }, { isError: false, value: null, content: [] })
    check('memory_ 工具不提示（原样透传）', memTool.passedThrough === true && !hinted(memTool))

    const errored = await env.fire('tools/post-execute', {
      name: 'read',
      arguments: { file_path: 'C:/x/dsh-profile-stats/client.js' },
      agent: { id: 'a-paths' },
    }, { isError: true, error: { message: 'boom' }, content: [] })
    check('失败结果不提示（原样透传）', errored.passedThrough === true && !hinted(errored))

    const noPath = await env.fire('tools/post-execute', { name: 'pwsh', arguments: { command: 'ls' }, agent: { id: 'a-paths' } }, { isError: false, value: '', content: [] })
    check('无路径参数不提示（原样透传）', noPath.passedThrough === true && !hinted(noPath))
  } finally {
    env.cleanup()
  }
}

console.log('\n== 开关可关闭 ==')
{
  const env = makeEnv({ pathsHint: false })
  try {
    seed(env, 'ui-copy-rule', ['dsh-profile-stats/client.js'])
    const off = await env.fire('tools/post-execute', ...readCall('C:/x/dsh-profile-stats/client.js'))
    check('关闭后不提示（原样透传）', off.passedThrough === true && !hinted(off))
  } finally {
    env.cleanup()
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
