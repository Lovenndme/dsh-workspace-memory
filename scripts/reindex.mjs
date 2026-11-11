/**
 * 重建记忆库索引。
 *
 * 向量索引现在只活在进程内存里，所以这个脚本只做两件落盘的事：
 *   1. 重建 MEMORY.md（让它与 memory/ 下的文件一致）
 *   2. 在本进程内建一遍向量以验证检索可用——跑完即释放，不会写磁盘
 *
 * 用途：手工改过 memory/ 下的文件后跑一次。
 */
import path from 'node:path'

const mod = await import('../index.js')

// 默认目录从编码器推导，避免脚本里再硬编码一份拼写
const memoryDir =
  process.argv[2] ??
  path.join(os.homedir(), '.dsh', 'projects', mod.encodeProjectPath('C:\\Users\\lenovo\\Documents\\DSH-Workspace'), 'memory')

const index = mod.rebuildIndex(memoryDir)
const built = await mod.rebuildVectors(memoryDir)

console.log(`目录：${memoryDir}`)
console.log(`记忆条数：${index.count}（索引 ${index.lineCount} 行 / ${index.byteCount} 字节）`)
console.log(`向量：mode=${built.mode} indexed=${built.indexed} reused=${built.reused} embedded=${built.embedded}`)
console.log('注意：向量只存在于本进程内存，进程结束即释放；下次使用会按需重建。')

// 幂等性验证：再跑一次应全部 reused
const second = await mod.rebuildVectors(memoryDir)
console.log(`\n再跑一次（幂等性）：reused=${second.reused} embedded=${second.embedded} ← embedded 应为 0`)
