/**
 * 现状体检：把「哪里慢、慢多少」量出来，而不是猜。
 *
 * 关心三件事：
 *   1. listMemories() 的缓存命中代价（首次全量读盘 + 解析 frontmatter）
 *   2. recall() 一次要读几遍盘
 *   3. 向量索引的内存占用（不落盘，只占进程内存）
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mod = await import('../index.js')

function ms(fn) {
  const t0 = process.hrtime.bigint()
  const out = fn()
  const t1 = process.hrtime.bigint()
  return { out, ms: Number(t1 - t0) / 1e6 }
}

async function msAsync(fn) {
  const t0 = process.hrtime.bigint()
  const out = await fn()
  const t1 = process.hrtime.bigint()
  return { out, ms: Number(t1 - t0) / 1e6 }
}

/* ---------------------------------------------------------- 造一个 N 条的库 */
function buildStore(n) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsm-bench-'))
  const dir = path.join(tmp, '.dsh-memory')
  const body = '这是一条用于基准测试的记忆正文。'.repeat(40)
  for (let i = 0; i < n; i += 1) {
    mod.writeMemory(dir, {
      title: `基准测试记忆 ${i}`,
      body: `${body}\n\n编号 ${i}`,
      type: ['user', 'feedback', 'project', 'reference', 'pitfall'][i % 5],
      tags: ['bench', `t${i % 7}`],
      // 不再传 confidence：分流改为按来源（source），写入的记忆不带置信度
      source: 'agent',
    })
  }
  return { tmp, dir }
}

console.log('=== 1. listMemories() 全量读盘成本 ===')
for (const n of [5, 50, 200, 500]) {
  const { tmp, dir } = buildStore(n)
  // 预热一次，排除首次磁盘缓存影响
  mod.listMemories(dir)
  const runs = 5
  let total = 0
  for (let i = 0; i < runs; i += 1) total += ms(() => mod.listMemories(dir)).ms
  const per = total / runs
  console.log(`  ${String(n).padStart(4)} 条 -> ${per.toFixed(2)} ms/次`)
  rmSync(tmp, { recursive: true, force: true })
}

console.log('\n=== 2. recall() 一次要读几遍盘 ===')
{
  const { tmp, dir } = buildStore(200)
  await mod.rebuildVectors(dir) // 先把向量建好，模拟常态
  const once = await msAsync(() => mod.recall(dir, '基准测试记忆', 5))
  console.log(`  200 条、向量已就绪 -> recall 一次 ${once.ms.toFixed(2)} ms，返回 ${once.out.results.length} 条`)
  const miss = await msAsync(() => mod.recall(dir, '今天天气怎么样', 5))
  console.log(`  200 条、查无匹配     -> recall 一次 ${miss.ms.toFixed(2)} ms，返回 ${miss.out.results.length} 条`)
  rmSync(tmp, { recursive: true, force: true })
}

console.log('\n=== 3. rebuildVectors() 全量重嵌成本（每次写入都会触发） ===')
for (const n of [5, 50, 200]) {
  const { tmp, dir } = buildStore(n)
  const built = await msAsync(() => mod.rebuildVectors(dir))
  console.log(`  ${String(n).padStart(4)} 条 -> ${built.ms.toFixed(1)} ms（${built.out.indexed} 条入索引）`)
  // 再测一次「只改一条却全量重嵌」的代价
  const items = mod.listMemories(dir)
  const one = await msAsync(() => mod.rebuildVectors(dir))
  console.log(`         改 1 条也要全量重嵌：${one.ms.toFixed(1)} ms`)
  rmSync(tmp, { recursive: true, force: true })
}

console.log('\n=== 4. 向量索引体积（现在只在内存里） ===')
{
  // 向量不再落盘，体积只影响进程内存占用：每条 256 维 Float32 = 1 KiB
  const perEntry = 256 * 4
  console.log(`  每条记忆 ≈ ${perEntry} 字节（256 维 Float32，纯内存，不写磁盘）`)
  for (const n of [200, 1000]) {
    console.log(`  外推 ${n} 条 -> 约 ${(perEntry * n / 1024 / 1024).toFixed(2)} MB 内存`)
  }
  console.log('  磁盘上不再有向量文件；进程重启后首次检索时按需重建。')
}

console.log('\n=== 5. 注入路径（每步模型调用都会跑） ===')
{
  // 用临时库量，不读 ~/.dsh 下的真实记忆（以前读的是真实工作区的 MEMORY.md）
  const { tmp, dir } = buildStore(5)
  const index = path.join(dir, 'MEMORY.md')
  const runs = 20
  let total = 0
  for (let i = 0; i < runs; i += 1) total += ms(() => readFileSync(index, 'utf8')).ms
  console.log(`  读 MEMORY.md 一次 ${(total / runs).toFixed(3)} ms（5 条 / ${Buffer.byteLength(readFileSync(index, 'utf8'), 'utf8')} 字节）`)
  let composed = 0
  for (let i = 0; i < runs; i += 1) composed += ms(() => mod.composeInjection(dir, '')).ms
  console.log(`  拼一次动态 context（composeInjection）${(composed / runs).toFixed(3)} ms`)
  rmSync(tmp, { recursive: true, force: true })
}
