/**
 * 把 leanvec 装进**插件自有的依赖目录**。
 *
 * 为什么不用 profile 的 node_modules：本插件是以 link（junction）方式装进 profile 的，
 * pnpm **不保证为 link 目标安装依赖**。leanvec 因此曾在一次 `pnpm install` 后被静默剪掉，
 * 向量检索退化成纯关键词。
 *
 * 所以用一个不受 profile 依赖图影响的位置，用 npm 装：
 *   ~/.dsh/dsh-workspace-memory-deps/node_modules/leanvec
 * 插件解析 leanvec 时会在「常规模块解析」之后优先查这里。
 *
 * 用法：node scripts/install-deps.mjs
 * 体积提示：leanvec 的向量表约 85 MB，首次安装会下载较久。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const target = path.join(os.homedir(), '.dsh', 'dsh-workspace-memory-deps')
const moduleDir = path.join(target, 'node_modules', 'leanvec')
const entry = path.join(moduleDir, 'src', 'embed.mjs')
const table = path.join(moduleDir, 'dist', 'leanvec.f32')

function report() {
  if (!existsSync(entry)) return false
  const ok = existsSync(table)
  let version = '?'
  try {
    version = JSON.parse(readFileSync(path.join(moduleDir, 'package.json'), 'utf8')).version
  } catch {
    // 版本读不到不影响可用性
  }
  console.log(`  leanvec ${version} 已就位：${moduleDir}`)
  console.log(`  向量表: ${ok ? '存在' : '缺失（会退化为纯关键词）'}`)
  return ok
}

console.log(`目标目录: ${target}`)

if (report()) {
  console.log('\n已安装，无需重复安装。')
  process.exit(0)
}

mkdirSync(target, { recursive: true })
console.log('\n正在用 npm 安装 leanvec（约 85 MB，首次较慢）…')

try {
  // 用整条命令串 + shell，避免「shell:true 与参数数组并用」的注入告警
  const command = `npm install --prefix "${target}" --no-save --no-package-lock leanvec@^0.2.0`
  execFileSync(command, { stdio: 'inherit', shell: true, timeout: 600000 })
} catch (error) {
  console.error(`\n安装失败：${error?.message ?? error}`)
  console.error('插件仍可用，但向量检索会退化为纯关键词模式。')
  process.exit(1)
}

console.log('')
if (!report()) {
  console.error('安装命令成功，但目录结构不符合预期（缺 src/embed.mjs 或 dist 资源）。')
  process.exit(1)
}
console.log('\n完成。若插件已在运行，需要重载一次插件才会切换到向量模式。')
