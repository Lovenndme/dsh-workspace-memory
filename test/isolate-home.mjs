/**
 * 测试隔离（第五轮）：把 DSH_HOME 指到**本测试文件独占**的临时目录，进程退出时恢复环境变量、删掉临时目录。
 *
 * 为什么：用 configure() 而没传 globalMemoryDir / agentsFile 的测试，默认路径会落到真实主目录——
 * 审查在模拟主目录下复现过 storage-hardening 搬走真实全局按需库里的条目。所以**每个测试文件的第一个 import**
 * 都是它（ESM 的静态 import 按顺序先于模块体执行，测试里 `await import('../index.js')` 在它之后）。
 *
 *   · 原来的 DSH_HOME（没设就是 null）记在 globalThis 上，realFilesGuard 据此守护它——
 *     在「模拟的真实主目录」下跑测试时，那个目录一个字节都不能变；
 *   · 嵌入模型（leanvec）在切换之前解析一次并缓存（原 DSH_HOME 下装了就用它，否则用默认 ~/.dsh 下的）：
 *     它装在主目录的 dsh-workspace-memory-deps / profiles 下，这一步只读加载代码、不碰任何记忆数据；
 *     不这样做，所有测试都会退化成纯关键词检索，金标集与预取的断言会因为环境而变；
 *   · 不是测试文件（文件名不带 .test），被 node --test 发现时只是一个空跑的模块。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEY = Symbol.for('dsh-workspace-memory.test.originalDshHome')

if (!(KEY in globalThis)) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME')
  const original = had ? process.env.DSH_HOME : undefined
  globalThis[KEY] = typeof original === 'string' && original.trim() !== '' ? original : null

  // 嵌入模型在哪个主目录下：先看原来的 DSH_HOME，那里没装就看默认的 ~/.dsh（只看 node_modules 里有没有 leanvec 的代码）。
  // 例如在「模拟的真实主目录」下跑测试时，模拟目录里没装 leanvec，检索会退化成纯关键词，
  // 依赖向量的断言（金标集、预取、抽取去重）就会因为环境而不是代码失败。
  const hasLeanvec = (home) => {
    const own = path.join(home, 'dsh-workspace-memory-deps', 'node_modules', 'leanvec', 'src', 'embed.mjs')
    if (existsSync(own)) return true
    try {
      return readdirSync(path.join(home, 'profiles'), { withFileTypes: true }).some(
        (entry) => entry.isDirectory() && existsSync(path.join(home, 'profiles', entry.name, 'node_modules', 'leanvec', 'src', 'embed.mjs')),
      )
    } catch {
      return false
    }
  }
  const candidates = [globalThis[KEY], path.join(os.homedir(), '.dsh')].filter((home) => typeof home === 'string')
  const embedderHome = candidates.find((home) => hasLeanvec(path.resolve(home)))
  try {
    if (embedderHome) process.env.DSH_HOME = embedderHome
    const mod = await import('../index.js')
    await mod.resolveEmbedder()
  } catch {
    // 解析不到就是纯关键词，与没装 leanvec 的环境一致
  }

  const home = mkdtempSync(path.join(os.tmpdir(), 'wsm-test-home-'))
  process.env.DSH_HOME = home
  process.on('exit', () => {
    if (had) process.env.DSH_HOME = original
    else delete process.env.DSH_HOME
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // 临时目录删不掉不影响测试结果
    }
  })
}

/** 本测试文件的临时主目录。 */
export const TEST_DSH_HOME = process.env.DSH_HOME
/** 测试开始前的 DSH_HOME（没设或空白为 null）。 */
export const ORIGINAL_DSH_HOME = globalThis[KEY]
