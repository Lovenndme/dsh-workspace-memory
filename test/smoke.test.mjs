/**
 * Offline smoke test for dsh-workspace-memory.
 *
 * 不依赖宿主，只验证模块可导入、纯函数行为正确、以及 leanvec 能否解析。
 * 需要临时目录时用 os.tmpdir()，跑完删掉。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mod = await import('../index.js')

let failures = 0
const ok = (label) => console.log(`  PASS  ${label}`)
const bad = (label, detail) => {
  failures += 1
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
}
const check = (label, cond, detail) => (cond ? ok(label) : bad(label, detail))

console.log('== module shape ==')
check('exports name', mod.name === 'dsh-workspace-memory', `got ${mod.name}`)
check('exports apply()', typeof mod.apply === 'function')
check('inject lists services', Array.isArray(mod.inject) && mod.inject.length > 0, mod.inject?.join(','))
check('inject includes systemPrompt', mod.inject?.includes('systemPrompt'))

console.log('\n== project path encoding（与 DSH sessions 同规则）==')
{
  const cases = [
    ['C:\\Users\\lenovo\\Documents\\DSH-Workspace', '--C-Users-lenovo-Documents-DSH-Workspace--'],
    ['D:\\huangxiang\\weining\\pmis-agent', '--D-huangxiang-weining-pmis-agent--'],
    ['C:\\Users\\lenovo\\.dsh\\bot-workspace', '--C-Users-lenovo-.dsh-bot-workspace--'],
    ['C:\\Users\\lenovo\\Documents\\DSH-Workspace\\', '--C-Users-lenovo-Documents-DSH-Workspace--'],
  ]
  for (const [input, want] of cases) {
    const got = mod.encodeProjectPath(input)
    check(`${input} → ${want}`, got === want, `got ${got}`)
  }
}

console.log('\n== parseFrontmatter ==')
{
  const text = '---\nid: fb_1\ntype: feedback\ntags: [ui, 约定]\n---\n\n正文内容\n'
  const { data, body } = mod.parseFrontmatter(text)
  check('parses scalar', data.id === 'fb_1', JSON.stringify(data))
  check('parses inline array', Array.isArray(data.tags) && data.tags.length === 2, JSON.stringify(data.tags))
  check('parses CJK array item', data.tags?.[1] === '约定', JSON.stringify(data.tags))
  check('separates body', body.trim() === '正文内容', JSON.stringify(body))
}
{
  const { data, body } = mod.parseFrontmatter('no frontmatter here')
  check('no-frontmatter passthrough', Object.keys(data).length === 0 && body === 'no frontmatter here')
}

console.log('\n== keywordScore ==')
{
  const hit = mod.keywordScore('npm publish', 'always run npm publish after tests')
  const miss = mod.keywordScore('npm publish', 'int16 sha1 drop_h1')
  check('latin hit scores high', hit > 0.9, `hit=${hit}`)
  check('latin miss scores 0', miss === 0, `miss=${miss}`)
}
{
  const zh = mod.keywordScore('界面不要加解释文字', '界面里不要自行添加解释性说明文字')
  check('CJK bigram hit scores high', zh > 0.5, `zh=${zh}`)
  const noise = mod.keywordScore('界面不要加解释文字', 'int16(value << 16) drop_h1')
  check('CJK miss on noise scores 0', noise === 0, `noise=${noise}`)
}

console.log('\n== rebuildIndex on empty dir ==')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-test-'))
try {
  const memoryDir = path.join(tmp, '.dsh-memory')
  const built = mod.rebuildIndex(memoryDir)
  check('creates index on empty', existsSync(path.join(memoryDir, 'MEMORY.md')))
  check('reports zero count', built.count === 0, JSON.stringify(built))
  const text = readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')
  check('索引标题是 # Memory Index', text.startsWith('# Memory Index'), text.slice(0, 120))
  check('不写 root / count 噪声行', !text.includes('root:') && !text.includes('count:'), text.slice(0, 160))
}
catch (error) {
  bad('rebuildIndex on empty dir threw', error.message)
}

console.log('\n== leanvec resolution ==')
{
  // 通过 apply() 内部路径无法直接测，这里复刻同一套解析逻辑的可观测结果：
  // 用 /memory 的 status 分支等价判断——改为直接调用一次 recall 依赖的 embed。
  const probe = await import('node:module')
  const req = probe.createRequire(import.meta.url)
  let resolved = null
  try {
    resolved = req.resolve('leanvec')
  } catch {
    resolved = null
  }
  if (resolved) {
    ok(`leanvec resolves from plugin dir: ${resolved}`)
  } else {
    // 预期内：link 安装时从工作区目录解析不到，插件内有 profile 回退
    const profiles = path.join(os.homedir(), '.dsh', 'profiles')
    let found = false
    try {
      for (const d of (await import('node:fs')).readdirSync(profiles, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const dir = path.join(profiles, d.name, 'node_modules', 'leanvec')
        if (existsSync(path.join(dir, 'src', 'embed.mjs')) && existsSync(path.join(dir, 'dist', 'leanvec.f32'))) {
          ok(`leanvec found in fallback path: ${dir}`)
          found = true
          break
        }
      }
    } catch {}
    // 插件的自有依赖目录（npm 装、不受 profile 的 pnpm 依赖图影响）也算回退路径
    const own = path.join(os.homedir(), '.dsh', 'dsh-workspace-memory-deps', 'node_modules', 'leanvec')
    if (existsSync(path.join(own, 'src', 'embed.mjs')) && existsSync(path.join(own, 'dist', 'leanvec.f32'))) {
      ok(`leanvec found in plugin-owned deps dir: ${own}`)
      found = true
    }
    check(
      'leanvec reachable via fallback (or plugin degrades)',
      found,
      'neither direct, plugin-owned, nor profile fallback found leanvec',
    )
  }
}

rmSync(tmp, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
