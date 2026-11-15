/**
 * 重放：把一份结果文件里**真实模型写出的** memory_remember / memory_recall 调用，原样重放到指定的插件版本上。
 *
 * 为什么需要：网关额度不够时，插件改了几轮却没法在模型上验证。之前的运行里存着模型给出的每一次工具调用，
 * 原样喂给新版本，就能检验新版本的**代码路径**在真实模型写出的内容上表现如何——证据核对、相关性判断、
 * 分流、查重、返回文案。它检验不了「新提示词会不会改变模型行为」：入参全部来自旧运行，模型没有重新采样。
 *
 * 做法（每个已完成的场景一个全新的假宿主，与原运行同样的预置数据和用户消息）：
 *   1. 照真实宿主的顺序，先对场景的每条用户消息触发一次 agent/pre-step（官方消息形状），
 *      新版的「用户原话」缓存与 snapshotEvents() 回落两路都有数据；
 *   2. 按原顺序重放记录下的 memory_remember / memory_recall（入参原样，不补不改）；通用工具一律跳过；
 *   3. 用现有计分规则给重放后的场景打分：remember 的结果与库状态取重放，
 *      模型的最终回复、文件写入、是否用尽步数取原运行（这些不随插件变）。
 */
import { makeScenarioHost } from './remember-host.mjs'
import { rememberOutcome, routedHomeOf, scoreRow } from './remember-score.mjs'

export const REPLAY_DISCLAIMER =
  '重放不重新采样模型：调用的入参全部来自原运行，检验的是插件代码路径（证据核对、相关性判断、分流、查重、返回文案），' +
  '不是新提示词对模型行为的影响。新版提示词会不会让模型换一种写法、换一个去向，只能等真跑。'

/** 结果的简短中文标签：直写 / 待确认(原因) / 拒写(原因)。 */
export function outcomeLabel(outcome) {
  if (!outcome) return '—'
  if (outcome.outcome === 'direct') return '直写'
  if (outcome.outcome === 'pending') return `待确认(${outcome.reason ?? '—'})`
  // 改道不是拒写：工具把它指向 skill / 项目 AGENTS.md / README（见 remember-score.mjs 的 routedHomeOf）
  const home = routedHomeOf(outcome)
  if (home) return `改道(${home})`
  return `拒写(${outcome.reason ?? '—'})`
}

/**
 * source: user 的证据核对明细：只调插件导出的函数（没导出就是 null = 不适用），不自己实现一份。
 * 相关性分两种口径各算一次：[标题, 摘要, 正文] 与只用 [标题, 摘要]，用来看正文对判断的贡献。
 */
function evidenceDetail(mod, texts, args) {
  const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : ''
  const found = typeof mod.verifyEvidence === 'function' ? mod.verifyEvidence(texts, evidence) : null
  const canRelate = typeof mod.evidenceRelates === 'function'
  return {
    evidence,
    title: args.title ?? null,
    found: found ? Boolean(found.verified) : null,
    match: found?.verified ? (found.match ?? '未标注') : null,
    relatesFull: canRelate ? Boolean(mod.evidenceRelates(evidence, [args.title, args.description, args.body])) : null,
    relatesTitleDesc: canRelate ? Boolean(mod.evidenceRelates(evidence, [args.title, args.description])) : null,
  }
}

const idsOf = (value) => (Array.isArray(value?.results) ? value.results.map((row) => row.id) : [])

/**
 * 重放一个已完成的场景。返回 { calls, scored } 或 { error }。
 *
 * @param mod         要检验的插件模块实例
 * @param kase        场景定义（预置数据、accept、约束）
 * @param row         原结果文件里的那一行（status === 'ok'）
 * @param schemaProps 要检验的插件的 memory_remember properties（计分用）
 */
export async function replayRow({ mod, kase, row, schemaProps, seedChapters }) {
  const userTexts = Array.isArray(row.userTexts)
    ? row.userTexts
    : [...kase.history.filter((message) => message.role === 'user').map((message) => message.content), kase.message]
  const host = makeScenarioHost(mod, { label: `replay-${row.id}-r${row.run}`, userTexts })
  try {
    if (kase.preset) {
      const preset = await host.preset(kase.preset)
      if (!preset.ok) return { error: `预置记忆失败（${preset.via}）` }
    }
    await host.firePreStep(userTexts)

    const rememberDef = host.tools.get('memory_remember')
    const recallDef = host.tools.get('memory_recall')
    // 证据明细与插件用同一份「用户原话」（新版只认 source.kind === 'user'，假会话已按官方形状给）
    const texts = typeof mod.userTextsOf === 'function' ? mod.userTextsOf(host.session) : userTexts

    const calls = []
    const replayedRemember = []
    let rememberIndex = 0
    for (const step of row.steps ?? []) {
      for (const call of step.toolCalls ?? []) {
        if (call.name !== 'memory_remember' && call.name !== 'memory_recall') continue
        const isRemember = call.name === 'memory_remember'
        const original = isRemember ? (row.rememberCalls?.[rememberIndex] ?? null) : null
        if (isRemember) rememberIndex += 1
        const entry = { n: calls.length + 1, step: step.step, name: call.name, args: call.args ?? null }

        // 原调用参数解析失败：没有可重放的入参，原样保留原结果
        if (!call.args || call.rawArguments !== undefined) {
          entry.skipped = '原调用参数不是合法 JSON，无法重放'
          entry.changed = false
          if (isRemember && original) replayedRemember.push(original)
          calls.push(entry)
          continue
        }

        let value
        let threw = null
        try {
          value = await (isRemember ? rememberDef : recallDef).execute(call.args, { agent: host.agent })
        } catch (error) {
          threw = error
        }
        entry.result = value ?? null
        if (threw) entry.threw = String(threw?.message ?? threw)

        if (isRemember) {
          const outcome = rememberOutcome(value, Boolean(threw))
          entry.original = original ? { outcome: original.outcome, reason: original.reason ?? null, result: { home: original.result?.home ?? null } } : null
          entry.replay = { outcome: outcome.outcome, reason: outcome.reason ?? null, result: { home: value?.home ?? null } }
          entry.changed = !original || original.outcome !== outcome.outcome || (original.reason ?? null) !== (outcome.reason ?? null)
          entry.evidenceVerified = typeof value?.evidenceVerified === 'boolean' ? value.evidenceVerified : null
          entry.staleValues = Array.isArray(value?.staleValues) ? value.staleValues : null
          if (call.args.source === 'user') entry.evidence = evidenceDetail(mod, texts, call.args)
          replayedRemember.push({
            step: step.step,
            args: call.args,
            result: value ?? null,
            outcome: outcome.outcome,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
            ...(call.args.source === 'user'
              ? { evidenceVerified: entry.evidenceVerified ?? (entry.evidence?.found === null ? null : Boolean(entry.evidence?.found)) }
              : {}),
          })
        } else {
          entry.original = { count: idsOf(call.result).length, ids: idsOf(call.result) }
          entry.replay = { count: idsOf(value).length, ids: idsOf(value) }
          entry.changed = JSON.stringify(entry.original.ids) !== JSON.stringify(entry.replay.ids)
        }
        calls.push(entry)
      }
    }

    // 计分：remember 的结果与库状态取重放；最终回复、文件写入、是否用尽步数取原运行
    const replayed = { ...row, rememberCalls: replayedRemember, files: host.snapshotFiles() }
    scoreRow(kase, replayed, schemaProps, { seedChapters })
    return {
      calls,
      scored: {
        main: replayed.main,
        inAccept: replayed.inAccept,
        errorKind: replayed.errorKind ?? null,
        primaryWrite: replayed.primaryWrite ?? null,
        constraints: replayed.constraints ?? null,
        bonus: replayed.bonus ?? null,
        redline: replayed.redline ?? null,
      },
    }
  } finally {
    host.cleanup()
  }
}
