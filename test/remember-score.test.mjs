/** 只测离线计分函数和题目约束，不调用模型或评测入口。 */
import './isolate-home.mjs'
import { readFileSync } from 'node:fs'
import { acceptIncludes, scoreRow } from '../eval/lib/remember-score.mjs'
import { makeReporter } from './fake-host.mjs'

const { check, section, summary } = makeReporter()
const cases = JSON.parse(readFileSync(new URL('../eval/remember-cases.json', import.meta.url), 'utf8')).cases
const ids = ['A1', 'A2', 'A3', 'A4', 'A5', 'A7', 'A9', 'A10', 'D1', 'D2', 'K1', 'K2']

section('跨项目偏好接受普通 remember，scope 仍约束为 global')
for (const id of ids) {
  const kase = cases.find((item) => item.id === id)
  check(`${id} 接受 remember`, kase?.accept.includes('remember') && !kase.accept.includes('remember:always'))
  check(`${id} 保留跨项目范围或空约束`, id.startsWith('K') ? kase.remember == null : kase.remember.scope?.join() === 'global')
}

section('旧结果重算：成功写入不再细分常驻，旧 accept 和 primaryWrite 会被重建')
const kase = cases.find((item) => item.id === 'A1')
for (const schemaProps of [
  { type: {}, scope: {}, source: {} },
  { type: {}, scope: {}, source: {}, load: {} },
]) {
  for (const load of [undefined, 'on-demand', 'always']) {
    const row = {
      accept: ['remember:always'],
      primaryWrite: { always: true },
      rememberCalls: [{ outcome: 'pending', args: { type: 'feedback', scope: 'global', source: 'user', ...(load ? { load } : {}) } }],
      fileWrites: [],
      files: {},
    }
    scoreRow(kase, row, schemaProps)
    check(`load=${load} 统一记为 remember`, row.main === 'remember' && row.inAccept === true && row.errorKind === null)
    check('旧常驻分类被移除，scope 约束继续生效', !('always' in row.primaryWrite) && row.accept.join() === 'remember' && row.constraints.scope.status === 'pass')
  }
}
check('改道与提议归宿的等价关系保留', acceptIncludes(['propose:agents'], 'routed:agents'))
summary()
