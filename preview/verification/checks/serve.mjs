// 交互检查用的只读静态服务：把仓库根目录挂在 127.0.0.1 上（只响应 GET，不出仓库目录）。
// 用法：node serve.mjs <仓库根目录> <端口>。GET /__quit 退出；10 分钟没有请求也自动退出。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(process.argv[2] || '.')
const port = Number(process.argv[3] || 47431)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }
let idle = null
const touch = () => {
  clearTimeout(idle)
  idle = setTimeout(() => process.exit(0), 10 * 60 * 1000)
}
const server = createServer(async (req, res) => {
  touch()
  if (req.method !== 'GET') {
    res.writeHead(405)
    return res.end()
  }
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (pathname === '/__quit') {
    res.end('bye')
    return server.close(() => process.exit(0))
  }
  const file = path.resolve(root, '.' + pathname)
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403)
    return res.end()
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
})
server.listen(port, '127.0.0.1', () => {
  touch()
  console.log('serving', root, 'on', port)
})
