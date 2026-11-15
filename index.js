/**
 * dsh-workspace-memory — Host half.
 *
 * 工作区级持久记忆。设计参考 Claude Code 的 auto-memory 模块，但只做其中的
 * **自动记忆层**（指令文件层由宿主已有的 AGENTS.md 注入负责，这里不重复造）。
 *
 * 三个刻意的取舍，都是为了避开上一代实现（@yolk_vat-y/dsh-project-memory）踩过的坑：
 *
 * 1. **只索引 memories/ 的正文**。上一代把整个工作区扫进索引，905 个文件里
 *    394 个是 MCP 文档转储、366 个是第三方源码树（lcu-src）、119 个是一次性
 *    PDF 转换产物，真正的项目代码一个都没进去。结果中文查询会返回 int16 / sha1
 *    这类无关符号并打 97-100 分 —— 分数不可信比没有检索更危险。
 *
 * 2. **一条记忆一个 Markdown 文件**。插件坏了、被卸了、你自己换编辑器，记忆都还在，
 *    而且可以 git 管、可以 diff。数据不锁在插件的私有格式里。
 *
 * 3. **注入失败绝不拖垮主对话**。注入、检索、向量构建全部 try/catch 兜底，
 *    任何一环出问题就静默降级（向量→纯关键词→空），绝不让记忆功能把会话搞挂。
 *
 * 存储布局（与 Claude Code 一致）：
 *
 *   ~/.dsh/projects/<编码后的工作区路径>/
 *   ├── memory/                    # 只有记忆，和 CC 一模一样
 *   │   ├── MEMORY.md              # 索引，一行一条，每轮注入（上限 200 行 / 25KB）
 *   │   └── <slug>.md              # 一条记忆一个文件，文件名是英文 slug
 *   └── .memory-state/             # 插件私有，只在有草稿时出现
 *       └── pending/               # 待确认草稿
 *
 *   ~/.dsh/dsh-workspace-memory/global/   # 全局按需库（scope: global + load: on-demand），布局与项目库完全相同
 *   ├── memory/
 *   └── .memory-state/             # 只有 history/；草稿永远放在会话所在项目的 pending/
 *
 * `~/.dsh` 是宿主主目录：`$DSH_HOME` 非空白时用它（见 dshHome()）。
 * 去向由两个独立的选择决定：scope（适用范围）× load（加载方式），见 memory_remember。
 * 向量索引**不落盘**，只活在进程内存里（见 vectorStore）。
 */

import { existsSync } from 'node:fs'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-workspace-memory'

/** systemPrompt 是核心（注入索引），其余各自负责一块能力面。 */
export const inject = [
  'tools',
  'commands',
  'sessions',
  'workingDirectory',
  'systemPrompt',
  'agents',
  'webServer',
]

/* ------------------------------------------------------------------ 常量 */

/**
 * 记忆目录的布局（与 Claude Code 一致）：
 *
 *   ~/.dsh/projects/<编码后的项目路径>/memory/
 *   ├── MEMORY.md          # 索引
 *   ├── <slug>.md          # 一条记忆一个文件，与索引同级
 *   ├── pending/           # 待确认草稿（本插件扩展）
 *   └── .index/            # 向量索引（本插件扩展）
 */
const INDEX_FILE = 'MEMORY.md'
/** 插件私有状态目录名：与 memory/ 同级，不在其内部。目前只放待确认草稿。 */
const STATE_DIR = '.memory-state'
const PENDING_DIR = 'pending'

/**
 * 记忆类型：Claude Code 的 4 种 + `pitfall`。
 *
 * 为什么加 pitfall：审计（2026-11-14）里「踩到并验证过的坑」没有对应类型，只能硬塞进
 * feedback / project，判据也就跟着错位——feedback 要求「用户纠正」，project 要求「用户说的决定」，
 * 而坑是模型自己验证出来的。单列一类，门槛（必须验证过、写明失效条件）才说得清。
 */
const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'pitfall']

/**
 * `memory_remember` 的 type 里三个「不是记忆」的取值（§13.1）：流程、全仓库的规则、项目文档。
 * 选了它们工具什么都不保存，只告诉模型这类内容该写到哪（skill / 项目 AGENTS.md / README）。
 * 它们永远不会被保存，所以**不进 MEMORY_TYPES**：存储、面板的类型下拉、validateMemoryPatch、抽取的类型都不认。
 */
export const ROUTED_TYPES = ['procedure', 'repo-rule', 'docs']

/** memory_remember 的 type 参数接受的全部取值：五种记忆 + 三种改道。 */
const REMEMBER_TYPES = [...MEMORY_TYPES, ...ROUTED_TYPES]

/**
 * 加载方式：on-demand（召回时出现）/ always（每轮常驻，只有 AGENTS.md 一个去处）。
 * 与 scope 分开：以前一个 scope 同时决定「适用范围」和「加载方式」，
 * 「所有项目都适用、但只在特定场景才用」的知识没有去处，只能塞进常驻的 AGENTS.md。
 */
const MEMORY_LOADS = ['on-demand', 'always']

/** 内容来源：user = 用户亲口说的（要核对证据）；agent = 模型自己得出的（默认进待确认）。 */
const MEMORY_SOURCES = ['user', 'agent']

/** 向量维度（leanvec 固定 256）。 */
const VECTOR_DIM = 256

/**
 * 可配置项与默认值。
 *
 * 覆盖方式：在该插件行的 `config` 里写同名键，例如
 *
 * ```yaml
 * - id: dsh-workspace-memory
 *   name: dsh-workspace-memory
 *   config:
 *     minVectorScore: 0.35
 *     enableExtraction: true
 * ```
 *
 * 没有声明 `export const Config`（那需要 @deepseek-ai/schemastery，对 link 安装的
 * 插件未必能解析到）。代价是 Settings 面板不会渲染成表单，但值仍然生效并会被
 * 校验——校验问题通过 memory_status 工具暴露出来。
 */
const DEFAULT_CONFIG = {
  /**
   * 非空则固定使用这个目录（绝对路径或 `~` 开头），跳过按工作区推导。
   * 默认空 = `~/.dsh/projects/<编码后的工作区路径>/memory/`（同 Claude Code）。
   */
  memoryDir: '',

  /** 注入上限：前 N 行或前 N 字节，先到者为准（照抄 Claude Code 的 200 行 / 25KB）。 */
  indexMaxLines: 200,
  indexMaxBytes: 25 * 1024,

  /** 向量与关键词的融合权重。 */
  weightVector: 0.65,
  weightKeyword: 0.35,

  /**
   * 入选门槛。2026-11-01 实测标定（leanvec dim 256，4 条种子记忆）：
   *   · 完全无关查询的最佳向量相似度落在 0.09–0.17
   *   · 命中查询在 0.44 以上
   * 取 0.30 作分界。立场是「宁缺毋滥」：返回空 = 没记录过，
   * 而不是返回一堆低分项让模型自己猜。
   */
  minVectorScore: 0.3,
  minKeywordScore: 0.5,

  /**
   * 融合分的最终闸门。默认 0.34。
   *
   * 为什么需要它：`minVectorScore` / `minKeywordScore` 是「任一通道过线就入选」的
   * 前置筛，而 leanvec 是静态嵌入，任意文本的余弦都容易过 0.3——等于没闸门。
   * 金标集实测（`eval/golden.mjs`）：关掉闸门时负样本误召 **100%**。
   *
   * 0.34 是 `eval/sweep-min-score.mjs` 扫出来的最优点：
   *   0.30 → 误召 50% / 0.33 → 13% / **0.34 → 0%** / 0.35 → 召回掉到 80%
   * 注意这是个**陡崖**（0.33 与 0.34 之间误召从 13% 跳到 0%），
   * 说明它是在 18 条小样本上调出来的；真实语料变大后应重跑扫描再定。
   *
   * 判据必须是**融合分**而不是单通道：低于它就当库里没有，返回空。
   * 「库里没有答案时敢说没有」比多召回几条重要得多。
   */
  minScore: 0.34,

  /** 单条记忆的字段上限，是格式闸门的实体。 */
  maxTitleChars: 200,
  maxBodyChars: 20000,
  maxTags: 20,
  maxTagChars: 40,

  /** 自动抽取（阶段 2）。默认关，打开后才会在回合收尾跑 LLM 抽取。 */
  enableExtraction: false,
  extractMaxPerTurn: 3,

  /**
   * 每 N 个回合抽一次。
   *
   * 抽取挂在 `agent/turn-stopping`（serial，会被 await），所以每回合都抽等于
   * 给每回合加一次模型调用。5 是把"别漏太多"和"别太贵"折中后的默认值。
   */
  extractEveryTurns: 5,

  /** 抽取结果的去重阈值：与已有记忆余弦相似度超过它就不入队。 */
  dedupeThreshold: 0.9,

  /**
   * 每条记忆保留多少个历史版本。0 = 不留。
   *
   * 为什么需要：记忆是**不可逆**的——实测有一天之内旧规则被新规则取代、旧文件
   * 被删得干干净净，写错了就再也回不去。这里在覆盖/删除前把旧内容存一份到
   * `.memory-state/history/<slug>/`，只保留最近 N 版。
   */
  historyLimit: 20,

  /**
   * 全局指令文件。空 = `<dshHome>/AGENTS.md`（DSH 每个会话都会加载它；dshHome 见 dshHome()）。
   * 「搬到全局」就是往这个文件追加一节。
   */
  agentsFile: '',

  /**
   * 全局 AGENTS.md 的字节上限。超了就拒绝写入。
   *
   * 为什么需要：AGENTS.md **每轮请求都会注入**，它不是存储而是常驻上下文成本。
   * 没有上限时「记一条教训」的边际成本看起来是 0，实际是每次对话都在付费，
   * 条目会单调增长到把真正重要的规则挤出去。上限逼着先合并、先删。
   * 0 = 不限制（不推荐）。
   */
  maxAgentsBytes: 10000,

  /**
   * 打开 AGENTS.md 用的编辑器可执行文件。空 = 自动找 Typora
   * （Windows 先查 App Paths 注册表，再查常见安装路径）。
   * 找不到就退回系统默认程序打开。
   */
  editorExe: '',

  /**
   * 全局按需库（scope: global + load: on-demand）的目录。绝对路径或 `~` 开头。
   * 默认空 = `<dshHome>/dsh-workspace-memory/global/memory/`。解析只走 globalMemoryDirOf()。
   *
   * 为什么要有这个库：「任何项目都成立、但只在特定场景才用」的知识以前只能进常驻的
   * AGENTS.md（审计里全局 AGENTS.md 约 46% 是这类场景性知识），每轮都在付它的上下文成本。
   */
  globalMemoryDir: '',

  /**
   * 每轮注入的全局按需库索引最多几行。0 = 不注入（仍可经召回/预取/paths 提示出现）。
   * 比项目库的 indexMaxLines 小得多：它在每个项目的每一轮都注入，是跨项目的常驻成本。
   */
  globalIndexMaxLines: 60,

  /**
   * 模型自己得出的内容（source: agent）怎么处理：
   *   'review'（默认）→ 进待确认队列，由人收下；'direct' → 直接入库。
   *
   * 取代旧的置信度门槛：审计里 confidence 19 次有 18 次 ≥0.9，与后来是否被推翻毫无关系，
   * 而「没有用户信号、模型自行总结」的 6 条里 4 条被替换/推翻/删除。来源比自评可靠。
   * load: always 的 agent 内容不受这个开关影响，永远要人确认（写错影响每个项目的每一轮）。
   */
  agentWrites: 'review',

  /**
   * 写入前查重：同一个主题被记两次时，不要悄悄产生两条互相矛盾的记忆。
   *
   * 为什么需要：`memory_remember` 只在 slug 相同时覆盖，slug 不同就并存。
   * 于是「本地脚本兜底」和「本地脚本已关闭」这类前后矛盾的条目会同时存在，
   * 召回时读到哪条全看分数——这比没有记忆更糟。
   *
   * 机制与 AGENTS.md 的 newChapter 一致：命中就**拒写**并回候选，
   * 由调用方显式选择「覆盖旧的（supersedes）」还是「确实是新的（newMemory）」。
   * 不做自动合并，因为语义重复判断不准（实测字面相似度区间与不相关条目重叠）。
   */
  duplicateCheck: true,

  /** 查重阈值：融合分（0..1）达到它就认为「可能是同一个主题」。 */
  duplicateThreshold: 0.62,

  /** 查重时回几个候选。 */
  duplicateCandidates: 3,

  /**
   * `paths` 触发提示：读到/改到某条记忆标注过的文件时，在工具结果末尾附一行
   * 「相关记忆 <id>」。
   *
   * 为什么值得做：`paths` 字段以前纯粹是摆设——写入时能标，读取时没人看。
   * 而「什么时候该 recall」原本只能靠模型自己想起来，这是最不可靠的一环。
   * 改成按文件触发，等于把「按需加载」的入口交给真实的动作，而不是靠猜。
   *
   * 只给 id + 标题，不给正文：正文一旦附上，每次读文件都在付 token 税。
   */
  pathsHint: true,

  /** 一次提示最多列几条，避免把工具结果撑长。 */
  pathsHintLimit: 3,

  /**
   * 用户消息进来时**预取**相关记忆，列进本轮的系统提示。
   *
   * 为什么需要：`paths` 提示只在碰文件时触发；用户提问时没有任何触发点，
   * 「要不要 recall」全靠模型自觉——这是整条链路里最不可靠的一环。
   *
   * 实现要点：`system-prompt/assemble` 的 context.text 是**同步**的，拿不到用户消息；
   * 而 `agent/pre-step` 是 async waterfall 且带 `messages`。所以在 pre-step 里 await 一次
   * 真正的 recall（用的就是金标集标定过的 minScore），把结果缓存；注入时只读缓存。
   * **不往 messages 里塞东西**——那会污染对话记录。
   *
   * 只给 id + 标题：它回答的是「这几十条里哪 3 条跟这次请求有关」，
   * 正文仍然要 memory_recall 取。
   *
   * 关掉它不影响同一个 pre-step 监听里收用户原话（证据核对的主路径，见 appendUserTexts）。
   */
  prefetchRecall: true,

  /** 预取最多列几条。 */
  prefetchLimit: 3,

  /**
   * 记忆条数上限。默认 50。
   *
   * 成本在哪：`MEMORY.md` 索引**每轮注入**，一条一行摘要。条数涨上去，
   * 每轮请求都在付这份钱——和 AGENTS.md 的字节预算是同一个道理。
   *
   * 所以这里**硬限**：满了拒写，并把「hits 最少、最久没读过」的几条列出来当淘汰候选。
   * 0 = 不限制。
   */
  maxMemoryCount: 50,

  /**
   * 单条正文的**提醒**阈值（不是硬上限）。默认 2000 字符。
   *
   * 为什么不硬拦：正文只在 `memory_recall` 命中的那一次进上下文，
   * 而不是每轮。内容确实需要长，就该长——截断会直接丢信息。
   * 所以只做两件事：写入时提示「可以考虑拆成几条原子记忆」，面板里显示体量。
   */
  warnBodyChars: 2000,

  /**
   * 一次召回的**总体积**预算。默认 12000 字符（约 3000 tokens）。
   *
   * 收敛的是「返回几条」，不是「每条切多长」：
   * 一条正文该多长是多长，超预算就不再多带一条，并说明还有几条没返回。
   */
  recallMaxChars: 12000,
}

/** 生效中的配置。apply() 里替换；离线测试直接调函数时用默认值。 */
let CONFIG = { ...DEFAULT_CONFIG }

/** 配置校验时收集的问题，通过 memory_status 暴露。 */
let configIssues = []

const NUMERIC_RULES = {
  prefetchLimit: [1, 10],
  minScore: [0, 1],
  maxMemoryCount: [0, 10000],
  warnBodyChars: [200, 1000000],
  recallMaxChars: [100, 1000000],
  pathsHintLimit: [1, 10],
  duplicateThreshold: [0, 1],
  duplicateCandidates: [1, 20],
  maxAgentsBytes: [0, 1024 * 1024],
  indexMaxLines: [50, 5000],
  indexMaxBytes: [4096, 1024 * 1024],
  weightVector: [0, 1],
  weightKeyword: [0, 1],
  minVectorScore: [0, 1],
  minKeywordScore: [0, 1],
  maxTitleChars: [10, 2000],
  maxBodyChars: [100, 500000],
  maxTags: [1, 200],
  maxTagChars: [1, 200],
  extractMaxPerTurn: [1, 20],
  extractEveryTurns: [1, 100],
  dedupeThreshold: [0.5, 1],
  historyLimit: [0, 200],
  globalIndexMaxLines: [0, 200],
}

const BOOLEAN_KEYS = ['enableExtraction', 'duplicateCheck', 'pathsHint', 'prefetchRecall']

/**
 * 纯字符串选项（空串表示「用默认值」）。
 *
 * `agentsFile` / `editorExe` 原本就在 DEFAULT_CONFIG 里，但 resolveConfig 没有对应的
 * 处理分支：它们通过了「已知键」检查后既不写入结果也不报错——**被静默丢弃**。
 * 配置项写了却根本不生效，比直接报错更糟（`editorExe` 因此一直没生效过）。
 */
const STRING_KEYS = ['agentsFile', 'editorExe', 'agentWrites']

/** 只接受固定取值的字符串键：非法值回落默认并记 issue（不能静默当成别的值）。 */
const STRING_CHOICES = { agentWrites: ['review', 'direct'] }

/** 目录键：绝对路径或 `~` 开头，空串 = 默认目录。两个键规则相同，共用一个分支。 */
const PATH_KEYS = ['memoryDir', 'globalMemoryDir']

/**
 * 已废弃的键：不能当成「未知键」——用户配置里写着它们，说明以前确实生效过，
 * issue 要告诉他现在由什么取代，而不是一句「未知配置项」让人以为自己拼错了。
 */
const DEPRECATED_KEYS = {
  directWriteConfidence: '已废弃：分流改为按来源，见 agentWrites',
  minExtractConfidence: '已废弃：分流改为按来源，见 agentWrites',
}

/**
 * 校验并归一化一行 config。**不抛异常**：坏值退回默认值并记录问题，
 * 因为一个配置笔误不该让整个记忆系统不加载。
 */
export function configure(rawConfig) {
  const resolved = resolveConfig(rawConfig)
  CONFIG = resolved.config
  configIssues = resolved.issues
  return { config: CONFIG, issues: configIssues }
}

export function resolveConfig(raw) {
  const issues = []
  const out = { ...DEFAULT_CONFIG }

  if (raw === undefined || raw === null) return { config: out, issues }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push('config 必须是一个对象，已全部使用默认值')
    return { config: out, issues }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key in DEPRECATED_KEYS) {
      issues.push(`${key}: ${DEPRECATED_KEYS[key]}`)
      continue
    }
    if (!(key in DEFAULT_CONFIG)) {
      issues.push(`${key}: 未知配置项，已忽略`)
      continue
    }

    if (PATH_KEYS.includes(key)) {
      if (typeof value !== 'string') {
        issues.push(`${key}: 必须是字符串`)
        continue
      }
      const trimmed = value.trim()
      if (trimmed === '') {
        out[key] = ''
        continue
      }
      const expanded = trimmed.startsWith('~')
        ? path.join(os.homedir(), trimmed.slice(1))
        : trimmed
      if (!path.isAbsolute(expanded)) {
        issues.push(`${key}: 必须是绝对路径或以 ~ 开头`)
        continue
      }
      out[key] = expanded
      continue
    }

    if (BOOLEAN_KEYS.includes(key)) {
      if (typeof value !== 'boolean') {
        issues.push(`${key}: 必须是布尔值`)
        continue
      }
      out[key] = value
      continue
    }

    if (STRING_KEYS.includes(key)) {
      if (typeof value !== 'string') {
        issues.push(`${key}: 必须是字符串`)
        continue
      }
      const trimmed = value.trim()
      const choices = STRING_CHOICES[key]
      if (choices) {
        // 空串 = 用默认值；其余必须是列出的取值之一
        if (trimmed === '') continue
        if (!choices.includes(trimmed)) {
          issues.push(`${key}: 只能是 ${choices.join(' / ')}（收到 ${JSON.stringify(trimmed.slice(0, 40))}），已使用默认值 ${DEFAULT_CONFIG[key]}`)
          continue
        }
      }
      out[key] = trimmed
      continue
    }

    const rule = NUMERIC_RULES[key]
    if (rule) {
      const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      if (typeof num !== 'number' || !Number.isFinite(num)) {
        issues.push(`${key}: 必须是数字`)
        continue
      }
      if (num < rule[0] || num > rule[1]) {
        issues.push(`${key}: 必须在 ${rule[0]} 与 ${rule[1]} 之间（收到 ${num}），已忽略`)
        continue
      }
      out[key] = num
    }
  }

  // 危险的库目录（第五轮）：库目录等于主目录、是主目录的上级、或就是 AGENTS.md 所在目录时，
  // 主目录里的 AGENTS.md 等文件会被当成「记忆」列出来，memory_forget / 面板删除能把它们删掉。记 issue 并回落默认目录。
  // 第六轮补上宿主的共享 agents 根（$DSH_AGENTS_HOME 或 ~/.agents）：宿主同样从那里加载用户级 AGENTS.md
  // （官方 dsh-home-paths「Resolving the shared agents root」），库目录等于或包含它，同样会把那份 AGENTS.md 当成记忆删掉。
  const home = dshHome()
  const agentsRoot = sharedAgentsHome()
  const agentsDir = path.dirname(path.resolve(expandHomePath(out.agentsFile || path.join(home, 'AGENTS.md'))))
  const isSameOrAbove = (dir, root) => {
    const rel = path.relative(dir, root)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }
  for (const key of PATH_KEYS) {
    if (!out[key]) continue
    const dir = path.resolve(out[key])
    if (isSameOrAbove(dir, home) || isSameOrAbove(dir, agentsRoot) || sameDir(dir, agentsDir)) {
      issues.push(`${key}: 不能是主目录、共享 agents 根目录、它们的上级目录或 AGENTS.md 所在目录（${dir}），已使用默认目录`)
      out[key] = ''
    }
  }

  return { config: out, issues }
}

/* ------------------------------------------------------------ 根目录与路径 */

/**
 * 只展开 `~`、`~/…`、`~\…`（照官方 dsh-home-paths 的 expandHomePath）；`~alice/…` 之类原样返回。
 */
function expandHomePath(p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * **宿主主目录的唯一解析入口。** 任何地方都不要再手拼 `os.homedir(), '.dsh'`。
 *
 * 规则照官方 dsh-home-paths（README「Resolving the home」）：`$DSH_HOME` 非空白就用它（支持 `~`），
 * 否则 `~/.dsh`；空白的环境变量视为未设置——否则空串会被 resolve 成当前工作目录。
 * 为什么要跟宿主一致：宿主（含 AGENTS.md 加载、sessions 目录）都按这条规则找主目录，
 * 插件自己写死 `~/.dsh` 的话，设了 DSH_HOME 的用户会读写到另一棵树，记忆与宿主对不上。
 * 不调用官方包本身：link 安装解析不到宿主的依赖（见 CLAUDE.md）。
 * 每次调用都重读环境变量（便宜），测试才能临时改 DSH_HOME 再恢复。
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  const selected = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : path.join(os.homedir(), '.dsh')
  return path.resolve(expandHomePath(selected))
}

/**
 * 宿主的共享 agents 根：`$DSH_AGENTS_HOME` 非空白时用它（支持 `~`），否则 `~/.agents`。
 * 照官方 dsh-home-paths「Resolving the shared agents root」：它刻意放在 DSH 主目录之外（别的 agent 工具也读），
 * dsh-agent-instructions 从这里读用户级 AGENTS.md。插件只用它做「库目录不能落在这里」的检查（resolveConfig），不读写它。
 */
export function sharedAgentsHome() {
  const fromEnv = process.env.DSH_AGENTS_HOME
  const selected = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : path.join(os.homedir(), '.agents')
  return path.resolve(expandHomePath(selected))
}

/**
 * 主目录在**给用户或模型看的文字**里的写法：解析结果就是默认的 `~/.dsh` 时写 `~/.dsh`，否则写 `$DSH_HOME`。
 *
 * 照官方 dsh-home-paths README「Displaying a home」：「the default harness home displays as `~/.dsh`,
 * any configured harness home as `$DSH_HOME`」——比较的是解析后的路径，所以把 DSH_HOME 显式设成默认目录
 * 仍显示 `~/.dsh`；两种写法都不泄露本机的绝对路径。Windows 路径不分大小写，按小写比。
 */
export function dshHomeDisplay() {
  const fold = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p
  return fold(dshHome()) === fold(path.resolve(path.join(os.homedir(), '.dsh'))) ? '~/.dsh' : '$DSH_HOME'
}

/**
 * 全局 AGENTS.md 在工具返回文字里的写法（待确认提示、写入结果、/memory pending 的去向都经这里）。
 *   · 没配置 agentsFile：`<主目录符号>/AGENTS.md`（主目录用符号形式，见 dshHomeDisplay）；
 *   · 配置了、且位于 DSH 主目录之下：把主目录前缀换成符号形式，例如 `$DSH_HOME/custom/AGENTS.md`；
 *   · 配置在主目录之外：原样显示配置的那个路径——那是用户自己写的，模型要改这个文件时需要真实位置。
 * 以前恒为 `<主目录>/AGENTS.md`，配置了自定义路径的用户在文案里看到的是一个不存在的文件。
 */
export function agentsFileDisplay() {
  const configured = typeof CONFIG.agentsFile === 'string' ? CONFIG.agentsFile.trim() : ''
  if (!configured) return `${dshHomeDisplay()}/AGENTS.md`
  const rel = path.relative(dshHome(), path.resolve(expandHomePath(configured)))
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return `${dshHomeDisplay()}/${rel.split(path.sep).join('/')}`
  return configured
}

/**
 * 项目目录编码：**与 DSH 自己的 sessions 目录一致**。
 *
 *   C:\Users\lenovo\Documents\DSH-Workspace  ->  --C-Users-lenovo-Documents-DSH-Workspace--
 *   D:\huangxiang\weining\pmis-agent         ->  --D-huangxiang-weining-pmis-agent--
 *
 * 规则：去掉盘符后的冒号、路径分隔符换成单横线、两头各包一个 `--`。
 *
 * 这样 `~/.dsh/projects/` 与 `~/.dsh/sessions/` 用的是同一个键，
 * 同一个项目在两棵树下对得上，不用记两套拼写。
 * （注意这与 Claude Code 的 `C--Users-...` 不同：CC 把冒号也换成横线。
 * 这里选了跟宿主一致，因为你要在同一台机器上对照两个目录。）
 */
export function encodeProjectPath(absPath) {
  const body = String(absPath)
    .replace(/:/g, '')
    .replace(/[\\/]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return body ? `--${body}--` : '--'
}

/** 已注册的 DSH 工作区根路径，供同步解析使用。由 refreshWorkspaceRoots 维护。 */
let workspaceRoots = []

/**
 * 重新读一遍宿主的工作区注册表（`list()` 是同步的内存列表，读一次很便宜）。
 *
 * 只在 apply 时抓一次有两个坑：插件加载之后才注册的工作区永远看不到；
 * 加载时注册表还没填好，整个进程生命周期里每个会话都会落到「以 cwd 为键」的另一个库。
 * 读不到（没有注册表、抛错、返回的不是数组）就保持上一次的结果，不清空。
 */
export function refreshWorkspaceRoots(ctx) {
  try {
    const list = ctx.get?.('workspaceRegistry')?.list?.()
    if (Array.isArray(list)) {
      workspaceRoots = list.map((workspace) => workspace?.path).filter((p) => typeof p === 'string' && p)
    }
  } catch {
    // 保持上一次的结果
  }
  return workspaceRoots
}

/**
 * 项目根：取「包含 cwd 的最长已注册工作区路径」，没有已注册工作区就退回 cwd。
 *
 * 为什么不用 git repo root（Claude Code 的做法）：这个工作区里每个子项目
 * （dsh-profile-stats、dsh-command-context …）各自是一个 git 仓库，用 git root
 * 会让每个子项目各建一个记忆库。DSH 有 workspaceRegistry，用它才是原生做法，
 * 也正好满足「整个工作区共用一个库」。
 */
export function projectRootFor(cwd, roots = workspaceRoots) {
  const abs = path.resolve(cwd)
  // Windows 的路径不分大小写：cwd 的盘符/目录大小写与注册的工作区不一致时，
  // 区分大小写的比较会悄悄落到另一个（空的）记忆库。返回值仍用注册时的写法，键才稳定。
  const fold = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p
  const foldedAbs = fold(abs)
  let best = ''
  for (const root of roots) {
    if (!root) continue
    const normalized = path.resolve(String(root))
    const foldedRoot = fold(normalized)
    const prefix = foldedRoot.endsWith(path.sep) ? foldedRoot : foldedRoot + path.sep
    if (foldedAbs === foldedRoot || foldedAbs.startsWith(prefix)) {
      if (normalized.length > best.length) best = normalized
    }
  }
  return best || abs
}

/**
 * 记忆目录：`~/.dsh/projects/<编码后的项目路径>/memory/`
 *
 * 与 Claude Code 一致：MEMORY.md 和所有记忆文件同级平铺、机器本地、不进版本库。
 */
function resolveMemoryDir(cwd) {
  // 配置里写了固定目录就优先用它
  if (CONFIG.memoryDir) return CONFIG.memoryDir
  return path.join(dshHome(), 'projects', encodeProjectPath(projectRootFor(cwd)), 'memory')
}

/**
 * **全局按需库目录的唯一解析入口。** 任何地方都不要自己拼这个路径。
 *
 * 默认 `<dshHome>/dsh-workspace-memory/global/memory`：以包名做命名空间（官方首方包的先例；
 * 插件已有的 `.dsh-workspace-memory-history`、`dsh-workspace-memory-deps` 也是这个形态），
 * 不在主目录根下另占一个通用名字。
 *
 * 与项目库同构：`<dir>` 下是 MEMORY.md + 记忆文件，状态目录是同级的 `.memory-state/`
 * （只放 history；草稿永远在会话所在项目的 pending/ 里，收下时才落到这里）。
 * 测试必须经 `apply(ctx, { globalMemoryDir: 临时路径 })` 传入，否则会碰到真实目录。
 */
export function globalMemoryDirOf() {
  return CONFIG.globalMemoryDir || path.join(dshHome(), 'dsh-workspace-memory', 'global', 'memory')
}

/**
 * 宿主加载「项目指令」的根：从会话工作目录往上，**最近一个含 `.git` 的目录**；找不到就是工作目录本身。
 *
 * 照官方 dsh-agent-instructions 的 findProjectRoot（默认 projectRootMarkers = ['.git']，
 * 「Walk upward to the first directory containing a configured root marker … or cwd when no marker exists」）。
 * 只用于告诉模型「项目 AGENTS.md 在哪」——宿主只从这个根往下加载项目指令，指向别处等于让模型写一个不会被加载的文件。
 * 注意它与 projectRootFor（记忆库的键，按已注册工作区）不是一回事。`exists` 可注入，方便测试。
 */
export function instructionsRootFor(cwd, exists = existsSync) {
  const start = path.resolve(String(cwd))
  let current = start
  for (;;) {
    let marked = false
    try {
      marked = exists(path.join(current, '.git'))
    } catch {
      marked = false
    }
    if (marked) return current
    const parent = path.dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/** 两条路径是否指同一个目录（Windows 不分大小写）。 */
function sameDir(a, b) {
  const fold = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p
  return fold(path.resolve(String(a))) === fold(path.resolve(String(b)))
}

/**
 * 一个会话能看到的记忆库：项目库在前、全局按需库在后（召回同分时项目库优先）。
 * 两者被配置成同一个目录时只算一次，否则每条记忆都会出现两遍。
 */
function librariesFor(projectDir) {
  const libs = [{ scope: 'project', dir: projectDir }]
  const globalDir = globalMemoryDirOf()
  if (!sameDir(globalDir, projectDir)) libs.push({ scope: 'global', dir: globalDir })
  return libs
}

/** scope → 目录。 */
const libraryDir = (projectDir, scope) => (scope === 'global' ? globalMemoryDirOf() : projectDir)

const ensureDir = (dir) => mkdirSync(dir, { recursive: true })
/** 记忆文件与 MEMORY.md 同级平铺（同 Claude Code），没有 memories/ 子目录。 */
const memoriesPath = (memoryDir) => memoryDir
const indexPath = (memoryDir) => path.join(memoryDir, INDEX_FILE)

/**
 * 原子写：先写同目录临时文件再 rename，崩溃/断电时目标文件要么是旧的、要么是新的，
 * 不会被截成半个。rename 失败（Windows 上编辑器占着文件时是 EPERM/EBUSY）就退回直接写。
 * 目标是符号链接/junction 时对真实文件操作，否则 rename 会把链接本身换成普通文件。
 */
function writeFileAtomic(file, data) {
  let target = file
  try {
    target = realpathSync(file)
  } catch {
    // 文件还不存在：就写在原路径
  }
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temp, data, 'utf8')
    renameSync(temp, target)
  } catch {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 临时文件清不掉不影响后续的直接写
    }
    writeFileSync(target, data, 'utf8')
  }
}

/**
 * 记忆 id 就是文件名（不含 `.md`），而 id 会从工具参数 / HTTP 请求体里原样进来。
 * 不过滤的话 `../../../AGENTS` 之类的 id 能读、写、删库外的任意 `.md`。
 *
 * 允许：中日韩字符、全角标点（`：（）`）、点号等真实存在的 id 写法；
 * 拒绝：路径分隔符与 Windows 非法字符（仅 ASCII，全角 `：` 可以）、控制字符、
 * 首尾空白、结尾的 `.`、`.` / `..`、空串、超过 200 字符。
 */
export function isSafeId(id) {
  if (typeof id !== 'string') return false
  if (id === '' || id === '.' || id === '..' || id.length > 200) return false
  if (id !== id.trim() || id.endsWith('.')) return false
  if (/[\\/:*?"<>|]/.test(id)) return false
  if (/[\u0000-\u001f\u007f-\u009f]/.test(id)) return false
  return true
}

/**
 * 在 dir 下解析 `name`，并断言结果就在 dir 里（平铺，不含子目录）。不满足返回 null。
 * 返回 path.join 的结果（与 memoryCache 的键同形），不是 resolve 后的绝对路径。
 */
function containedPath(dir, name) {
  const base = path.resolve(dir)
  const rel = path.relative(base, path.resolve(base, name))
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`) || rel.includes(path.sep)) {
    return null
  }
  return path.join(dir, name)
}

/** `<dir>/<id>.md`；id 不安全或会逃出 dir 时返回 null。 */
const idFile = (dir, id) => (isSafeId(id) ? containedPath(dir, `${id}.md`) : null)

/**
 * 插件私有状态目录：放在 `memory/` **外面**，与它同级。
 *
 *   ~/.dsh/projects/<编码>/memory/             ← 只有 MEMORY.md + 记忆文件，与 CC 一致
 *   ~/.dsh/projects/<编码>/.memory-state/
 *       ├── pending/                            ← 待确认草稿（空则整个目录被收掉）
 *       └── history/<slug>/<时间戳>.md          ← 历史版本（覆盖/删除前留档）
 */
function statePath(memoryDir) {
  return path.join(path.dirname(memoryDir), STATE_DIR)
}

const historyPath = (memoryDir) => path.join(statePath(memoryDir), 'history')

/**
 * 覆盖或删除前，把当前内容留一份历史。
 *
 * 记忆是不可逆的：误改一次就永久丢失，而且它是纯 Markdown、没有 git 兜底。
 * 这里按「一条记忆一个子目录、只留最近 N 版」的方式留档，
 * 回退时直接把历史文件拷回 `memory/<slug>.md` 即可。
 */
function archiveVersion(memoryDir, id, raw) {
  const limit = CONFIG.historyLimit
  if (!limit || limit <= 0) return
  if (typeof raw !== 'string' || raw.trim() === '') return
  try {
    const dir = isSafeId(id) ? containedPath(historyPath(memoryDir), id) : null
    if (!dir) return
    ensureDir(dir)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(path.join(dir, `${stamp}.md`), raw, 'utf8')
    const kept = readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
    // 文件名按时间戳排序，最旧的在前面
    for (const stale of kept.slice(0, Math.max(0, kept.length - limit))) {
      rmSync(path.join(dir, stale), { force: true })
    }
  } catch {
    // 留档失败不影响主流程——宁可少一份历史，也不能让写入失败
  }
}

/** 列出某条记忆的历史版本（新的在前）。 */
export function listHistory(memoryDir, id) {
  try {
    const dir = isSafeId(id) ? containedPath(historyPath(memoryDir), id) : null
    if (!dir || !existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .reverse()
      .map((name) => ({ name, file: path.join(dir, name) }))
  } catch {
    return []
  }
}

/* ------------------------------------------------------------ frontmatter */

/**
 * 极简 YAML frontmatter 解析：`key: value` 与 `key: [a, b]`。
 *
 * 与 serializeFrontmatter 互为逆运算：序列化器只在「会产生歧义」时才给值加 JSON 引号
 * （换行、首尾空白、`: `、` #`、以 `[ " ' { # …` 开头、空串），所以普通值仍是裸文本，
 * 旧文件的解析结果不变。
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** 这两个键一直是数组：写成 `[...]` 就按数组读，不做括号配对检查（兼容旧文件里含 `]` 的标签）。 */
const FRONTMATTER_ARRAY_KEYS = new Set(['tags', 'paths'])

/**
 * 去引号只在「一对配套引号整个包住值」时发生，绝不单端剥：
 * `Don't use "foo"` 末尾的引号是内容，不是定界符。
 */
function decodeScalar(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const decoded = JSON.parse(value)
      if (typeof decoded === 'string') return decoded
    } catch {
      // 不是合法 JSON 串（手写的、或旧版序列化器输出）：退回旧行为，剥掉外层引号
    }
    return value.slice(1, -1)
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    const inner = value.slice(1, -1)
    // 合法的 YAML 单引号串里，内部的 ' 一定成对写成 ''
    return inner.replace(/''/g, '').includes("'") ? inner : inner.replace(/''/g, "'")
  }
  return value
}

/** 按逗号切数组项，但以 `"` 开头的项按 JSON 字符串整体读（里面的逗号、括号不算）。 */
function splitFlowItems(inner) {
  const items = []
  let pos = 0
  for (;;) {
    let start = pos
    while (start < inner.length && /\s/.test(inner[start])) start += 1
    if (inner[start] === '"') {
      let k = start + 1
      while (k < inner.length && inner[k] !== '"') k += inner[k] === '\\' ? 2 : 1
      if (k < inner.length) {
        let m = k + 1
        while (m < inner.length && /\s/.test(inner[m])) m += 1
        if (m >= inner.length || inner[m] === ',') {
          items.push(inner.slice(start, k + 1))
          if (m >= inner.length) return items
          pos = m + 1
          continue
        }
      }
    }
    const comma = inner.indexOf(',', pos)
    if (comma < 0) {
      items.push(inner.slice(pos))
      return items
    }
    items.push(inner.slice(pos, comma))
    pos = comma + 1
  }
}

export function parseFrontmatter(text) {
  // 记事本等编辑器存成「UTF-8 带 BOM」时，开头的 \uFEFF 会让 `^---` 匹配失败，
  // 整个 frontmatter 被当成正文——下次写入还会把它嵌进新文件里。
  const source = typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const match = FRONTMATTER_RE.exec(source)
  if (!match) return { data: {}, body: source }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    const [, key, rawValue] = kv
    if (key === '__proto__') continue
    const value = rawValue.trim()
    if (value.length >= 2 && value.startsWith('[') && value.endsWith(']')) {
      const items = splitFlowItems(value.slice(1, -1)).map((item) => item.trim())
      // `[WIP] Foo [x]` 是标量不是数组：括号必须真正整个包住值。
      // 判据：未加引号的项里不再出现方括号。
      const enclosed =
        FRONTMATTER_ARRAY_KEYS.has(key) || items.every((item) => item.startsWith('"') || !/[[\]]/.test(item))
      if (enclosed) {
        data[key] = items.map(decodeScalar).filter(Boolean)
        continue
      }
    }
    data[key] = decodeScalar(value)
  }
  return { data, body: match[2] }
}

/** 标量需要加引号吗：只要裸写会被读歧义（或根本不是合法 YAML）就要。 */
function needsQuoting(text) {
  return (
    text === '' ||
    text !== text.trim() ||
    /[\u0000-\u0008\u000a-\u001f\u007f\u2028\u2029]/.test(text) ||
    /^[["'{#&*!|>%@`]/.test(text) ||
    /^[-?:]\s/.test(text) ||
    text.endsWith(':') ||
    text.includes(': ') ||
    text.includes(' #')
  )
}

/** JSON 引号串。U+2028/2029 要转义：JSON.stringify 原样输出它们，而解析按行匹配时 `.` 不认它们，整行会被丢掉。 */
const quote = (text) => JSON.stringify(text).replace(/[\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16)}`)

const encodeScalar = (value) => {
  const text = String(value)
  return needsQuoting(text) ? quote(text) : text
}

/** 数组项另外要避开流式序列的定界符：逗号、方括号、花括号、引号。 */
const encodeItem = (value) => {
  const text = String(value)
  return needsQuoting(text) || /[,[\]{}"]/.test(text) ? quote(text) : text
}

function serializeFrontmatter(data, body) {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      lines.push(`${key}: [${value.map(encodeItem).join(', ')}]`)
    } else {
      lines.push(`${key}: ${encodeScalar(value)}`)
    }
  }
  lines.push('---', '')
  // 正文开头的空行要剥掉：解析时分隔用的那个空行会留在 body 里，
  // 不剥的话「读→写」每循环一次文件就多一个空行（每次 recall 都会触发）。
  return `${lines.join('\n')}\n${String(body).replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()}\n`
}

/** 标题/摘要是单行字段：换行折成一个空格，作为落盘前最后一道防线。 */
const oneLine = (text) => String(text ?? '').replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim()

/* ---------------------------------------------------------------- 记忆读写 */

/**
 * 标题派生的兜底 slug：只在调用方没给英文 slug 时使用。
 * 中文保留，只把非法文件名字符与空白换成 `-`。
 */
export function slugify(title) {
  // 按码点截断（不劈开代理对），截断后再收一次尾部分隔符——结果必须满足 isSafeId，
  // 否则 writeMemory 会因为「标题派生的 id 不合法」而抛错。
  const cleaned = Array.from(
    String(title ?? '')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, ''),
  )
    .slice(0, 80)
    .join('')
    .replace(/[-.]+$/g, '')
  return cleaned && isSafeId(cleaned) ? cleaned : `memory-${Date.now().toString(36)}`
}

/**
 * 英文 slug：**文件名与索引里的链接文字都用它**。
 * 小写、非字母数字一律换 `-`，与 Claude Code 的记忆文件名风格一致。
 *
 * 索引行要求「英文在前、中文说明在后」，所以文件名必须是英文；
 * 中文标题留在 frontmatter 的 title 与 description 里。
 */
export function asciiSlug(input) {
  const cleaned = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return cleaned || `memory-${Date.now().toString(36)}`
}

/** 把 slug 还原成人读的链接文字：`no-explanatory-text-in-ui` -> `No explanatory text in ui`。 */
function humanizeId(id) {
  const words = String(id).replace(/[-_]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(id)
}

/**
 * 在目录里挑一个不与别的记忆冲突的 slug（selfId 是「自己」，不参与冲突）。
 * `alsoTaken`：另一个按需库里已有的 id，按同样的规则避开（加 `-2` / `-3`）——
 * 两个库各有一条同 id 的记忆时，面板按 id 选中会同时高亮两行、第二条打不开，所以从源头不让它出现。
 */
function uniqueSlug(memoryDir, base, selfId, alsoTaken = []) {
  // Windows / macOS 的文件系统不分大小写：`Docs.md` 与 `docs.md` 是同一个文件，
  // 区分大小写地比较会让后写的静默覆盖先写的，所以统一按小写判重。
  const fold = (id) => id.toLowerCase()
  const self = selfId == null ? null : fold(selfId)
  const taken = new Set(
    [...listMemories(memoryDir).map((item) => item.id), ...(Array.isArray(alsoTaken) ? alsoTaken : [])]
      .filter((id) => typeof id === 'string')
      .map(fold)
      .filter((id) => id !== self),
  )
  if (!taken.has(fold(base))) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`
    if (!taken.has(fold(candidate))) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/** description 的上限：索引一行要能扫读，超过就截断。 */
const MAX_DESCRIPTION_CHARS = 120

/**
 * 取正文里最像「摘要」的一行：跳过空行，剥掉标题井号与 `**加粗标签**：` 前缀，
 * 截断到 MAX_DESCRIPTION_CHARS。
 *
 * 单纯取首行会得到 `**错误模式**：xxx` 这种——那不是摘要，是正文小节的标题。
 */
function firstLine(text) {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.trim()
    if (!line) continue
    line = line.replace(/^#+\s*/, '')
    line = line.replace(/^\*\*(.+?)\*\*\s*[：:]\s*/, '$1：')
    line = line.replace(/^\*\*(.+?)\*\*$/, '$1')
    line = line.trim()
    if (!line) continue
    return line.length > MAX_DESCRIPTION_CHARS ? `${line.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : line
  }
  return ''
}

/**
 * 标出哪些行在围栏代码块（``` 或 ~~~）里，含围栏行本身。
 *
 * 围栏里的 `#` / `## ` 是代码（shell 注释、示例标题），不是 Markdown 标题——
 * 解析章节、重排编号、下沉标题时都必须跳过它们，否则会把代码改坏。
 * 规则取 CommonMark 的：开栏 ≥3 个同种字符（缩进 ≤3），收栏同种且不短于开栏、后面无其它文字；
 * 到文末仍没收栏就一直算围栏内。
 */
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false)
  let open = null
  for (let i = 0; i < lines.length; i += 1) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (open) {
      mask[i] = true
      if (fence && fence[1][0] === open.char && fence[1].length >= open.length && fence[2].trim() === '') open = null
    } else if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      mask[i] = true
      open = { char: fence[1][0], length: fence[1].length }
    }
  }
  return mask
}

/**
 * 从正文派生 description（MEMORY.md 里每轮注入的那一行摘要）。
 *
 * 正文常以 `## 规则` 这样的小节标题开头，只取首行会得到「规则」——一个词，毫无信息量。
 * 所以优先取第一行**非标题、非围栏代码、非分隔线**的正文；全是标题时才退回标题文字。
 */
function deriveDescription(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const fenced = fenceMask(lines)
  const prose = lines.filter((raw, index) => {
    const line = raw.trim()
    if (fenced[index] || line === '') return false
    return !/^#{1,6}(?:\s|$)/.test(line) && !/^(?:[-*_]\s*){3,}$/.test(line)
  })
  return firstLine(prose.join('\n')) || firstLine(text)
}

/** 读一条记忆（含 frontmatter）。文件不存在、或 id 不安全（会逃出记忆目录）返回 undefined。 */
function readMemory(memoryDir, id) {
  const file = idFile(memoriesPath(memoryDir), id)
  if (!file || !existsSync(file)) return undefined
  const raw = readFileSync(file, 'utf8')
  const { data, body } = parseFrontmatter(raw)
  return { id, file, meta: data, body: body.trim(), raw }
}

/**
 * 已解析记忆的内存缓存：文件路径 → { mtimeMs, size, item }。
 *
 * 为什么需要：实测（2026-11-01）listMemories 每次都 statSync + readFileSync + 正则
 * 解析每一个文件，200 条要 39 ms、500 条要 228 ms；而 recall 每次调用都要跑一遍。
 * 命中缓存后这部分成本降到接近 0。
 *
 * 失效策略是 mtime + size 双判据（单看 mtime 在同一毫秒内连续写会漏判），
 * 另外写入/删除时显式 delete，不留「同毫秒同大小」的边角。
 */
const memoryCache = new Map()

/** 一个库里已有的全部 id（给「新 id 避开另一个库」用）。 */
const idsOf = (memoryDir) => listMemories(memoryDir).map((row) => row.id)

/**
 * 列出全部记忆元信息。走内存缓存，只对变更过的文件重新读盘解析。
 */
export function listMemories(memoryDir) {
  const dir = memoriesPath(memoryDir)
  // 缓存键是 path.join(dir, 文件名)，所以「这个目录的条目」就是 dirname 等于它的那些
  const dirKey = path.dirname(path.join(dir, 'x'))
  const alive = new Set()
  const evictGone = () => {
    // 只回收**本目录**里已不存在的文件：多个项目库交替查询时，不能互相把对方的缓存清掉
    for (const key of memoryCache.keys()) {
      if (path.dirname(key) === dirKey && !alive.has(key)) memoryCache.delete(key)
    }
  }
  if (!existsSync(dir)) {
    evictGone()
    return []
  }
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    // 记忆文件和 MEMORY.md 同级，索引文件自己不是一条记忆
    if (entry.name === INDEX_FILE) continue
    const file = path.join(dir, entry.name)
    let stat
    try {
      stat = statSync(file)
    } catch {
      continue // 列举与 stat 之间被删了
    }
    alive.add(file)
    const cached = memoryCache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      out.push(cached.item)
      continue
    }
    try {
      const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
      const item = {
        id: entry.name.slice(0, -3),
        file,
        meta: data,
        body: body.trim(),
        mtime: stat.mtimeMs,
      }
      memoryCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, item })
      out.push(item)
    } catch {
      // 坏文件跳过，不让它拖垮整个列表
    }
  }
  // 回收已不存在文件的缓存，避免长期驻留
  evictGone()
  return out.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
}

/**
 * 写一条记忆并重建索引。返回落盘路径。
 *
 * 文件名 = 由标题派生的 slug（与 Claude Code 一致），所以：
 *   · 新建时按标题生成；
 *   · **改标题会同步重命名文件** —— 否则索引指向旧名、文件名和内容对不上；
 *   · 撞名时自动加 `-2` / `-3`（不分大小写），绝不覆盖别人的记忆。
 *
 * 显式给的 `id` 不安全（含路径分隔符等，见 isSafeId）时**抛错**，不写任何文件。
 */
export function writeMemory(memoryDir, input) {
  if (input.id && !isSafeId(String(input.id))) {
    throw new Error(`不安全的记忆 id：${JSON.stringify(String(input.id).slice(0, 80))}`)
  }
  const existing = input.id ? readMemory(memoryDir, String(input.id)) : undefined
  // 没传 type 时必须沿用原值，不能一律回落成 project——
  // 否则「只改摘要」这类局部更新会静默把分类冲掉。
  const type = MEMORY_TYPES.includes(input.type)
    ? input.type
    : MEMORY_TYPES.includes(existing?.meta?.type)
      ? existing.meta.type
      : 'project'
  const now = new Date().toISOString()

  const body = input.body ?? existing?.body ?? input.title ?? ''
  const title = oneLine(input.title ?? existing?.meta?.title ?? '') || firstLine(body) || existing?.id || 'memory'

  // 文件名 = 英文 slug。规则：
  //   · 显式给 slug 且与当前不同 → 重命名（标题变化本身不再触发重命名，
  //     因为文件名现在是独立标识，不再从中文标题派生）；
  //   · 新建且没给 slug → 退回标题派生（中文标题会得到中文文件名，属于降级路径）；
  //   · 其余情况保持原 id。
  const requestedSlug =
    typeof input.slug === 'string' && input.slug.trim() !== '' ? asciiSlug(input.slug) : ''

  // input.avoidIds：另一个按需库里已有的 id。只在「定一个新 id」时参与（新建、改名），原地更新保持原 id。
  let id = existing?.id ?? (input.id ? String(input.id) : '')
  if (!id) {
    id = uniqueSlug(memoryDir, requestedSlug || slugify(title), null, input.avoidIds)
  } else if (requestedSlug && requestedSlug.toLowerCase() !== id.toLowerCase()) {
    // 只差大小写不算改名：在不分大小写的文件系统上那是同一个文件，改名后删旧文件会把新文件一起删掉
    id = uniqueSlug(memoryDir, requestedSlug, id, input.avoidIds)
  }

  // description 就是 MEMORY.md 里那一行的摘要：索引与正文是同一份数据的两个投影。
  //   · 显式给了就用给的；
  //   · 正文变了且没给，就按新正文重新取首行（否则索引摘要会和正文对不上）；
  //   · 正文没变就保持原摘要，避免只改标签也把摘要冲掉。
  const nextBody = String(body ?? '')
  const bodyChanged = !existing || nextBody.trim() !== String(existing.body ?? '').trim()
  let description
  if (input.description !== undefined) {
    description = oneLine(input.description)
  } else if (existing && !bodyChanged) {
    description = oneLine(existing.meta.description) || deriveDescription(nextBody) || title
  } else {
    description = deriveDescription(nextBody) || oneLine(existing?.meta?.description) || title
  }

  const meta = {
    // 先铺上原有的全部键：hits / lastHit 与任何未知键（手写的、别的工具加的）更新时必须原样保留，
    // 下面显式列出的键再覆盖它们。
    ...existing?.meta,
    name: id,
    description,
    // scope 由所在的库决定（项目库 / 全局按需库），这里只是把它记进文件，便于手工查看。
    // 没传就沿用原值：项目库里的旧文件可能写着 global（旧版「该挪去 AGENTS.md」的提示），不擅自改掉。
    scope: input.scope === 'global' ? 'global' : input.scope === 'project' ? 'project' : (existing?.meta?.scope ?? 'project'),
    type,
    status: input.status ?? existing?.meta?.status ?? 'confirmed',
    tags: input.tags ?? existing?.meta?.tags ?? [],
    paths: input.paths ?? existing?.meta?.paths ?? [],
    created: input.created ?? existing?.meta?.created ?? now,
    modified: now,
    // 不再写 confidence（分流改为按来源）。旧文件里的 confidence 经上面的 `...existing.meta` 原样保留。
    // source / evidence 留作审计与面板展示：谁说的、原话是什么。
    source: MEMORY_SOURCES.includes(input.source) ? input.source : existing?.meta?.source,
    evidence:
      typeof input.evidence === 'string' && input.evidence.trim() !== ''
        ? oneLine(input.evidence)
        : existing?.meta?.evidence,
    // 证据核实过没有（第六轮，只对 source: user 有意义）：显式给了就用给的；这次写成 agent 来源就去掉；
    // 没说（面板编辑、只改标签）就沿用原值。收下草稿时由 acceptPending 原样带过来，不因为人点了收下就变成 true。
    evidenceVerified:
      input.source === 'agent'
        ? undefined
        : typeof input.evidenceVerified === 'boolean'
          ? input.evidenceVerified
          : existing?.meta?.evidenceVerified,
    // 这条记忆取代了哪一条（覆盖旧偏好时留下可追溯的线索）
    supersedes: input.supersedes ?? existing?.meta?.supersedes ?? undefined,
    title,
  }

  ensureDir(memoriesPath(memoryDir))
  const file = idFile(memoriesPath(memoryDir), id)
  if (!file) throw new Error(`不安全的记忆 id：${JSON.stringify(id.slice(0, 80))}`)
  const nextRaw = serializeFrontmatter(meta, body)
  // 只有「实质内容」变了才留档。
  // modified / hits / lastHit 每次写入都会变，直接比原文等于永远算"变了"，
  // 会把历史冲成一堆没有意义的版本。所以先把这几个易变字段剔除再比。
  const stableOf = (text) =>
    String(text ?? '')
      .split(/\r?\n/)
      .filter((line) => !/^(modified|hits|lastHit)\s*:/.test(line))
      .join('\n')
  if (existing?.raw && stableOf(existing.raw) !== stableOf(nextRaw)) {
    archiveVersion(memoryDir, existing.id, existing.raw)
  }
  writeFileAtomic(file, nextRaw)

  // 重命名后必须删掉旧文件，否则同一条记忆会留下两份
  if (existing && existing.file !== file) {
    try {
      rmSync(existing.file, { force: true })
    } catch {
      // 旧文件删不掉不影响新文件
    }
    memoryCache.delete(existing.file)
  }
  memoryCache.delete(file) // 显式失效：同毫秒同大小的重写不能靠 mtime/size 判出来
  rebuildIndexQuietly(memoryDir)
  return file
}

/** 删一条记忆。返回是否真的删掉了；id 不安全（会逃出记忆目录）一律返回 false，不碰任何文件。 */
export function deleteMemory(memoryDir, id) {
  const file = idFile(memoriesPath(memoryDir), id)
  if (!file || !existsSync(file)) return false
  // 删除同样留档——取代/清理都可能是误操作
  const current = readMemory(memoryDir, id)
  if (current?.raw) archiveVersion(memoryDir, id, current.raw)
  rmSync(file, { force: true })
  memoryCache.delete(file)
  rebuildIndexQuietly(memoryDir)
  return true
}

/**
 * 写入 / 删除 / 移库之后重建索引：失败只记录、不抛（第五轮）。
 * 索引是派生物，记忆文件已经落盘或删掉了；这时再抛错，调用方会以为整次操作失败而重试——
 * 重复写入、面板显示与磁盘不符（审查 v3：MEMORY.md 被占用或被换成目录时，移库报 500 却留下了两份）。
 * 下一次成功的写入或 /memory reindex 会把索引补齐。显式的 rebuildIndex（reindex 命令、脚本）照常抛错。
 */
function rebuildIndexQuietly(memoryDir) {
  const key = path.resolve(memoryDir)
  try {
    rebuildIndex(memoryDir)
    staleIndexes.delete(key)
    return true
  } catch (error) {
    // 失败要能被看见（第六轮）：记下这个库，写入类工具的返回值带 indexStale、memory_status 会比对条目数
    staleIndexes.add(key)
    console.error(`[workspace-memory] 重建索引失败 ${memoryDir}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** 上一次重建索引失败的库（resolve 后的路径）。成功重建一次就移出。 */
const staleIndexes = new Set()

/** 这个库的索引是不是停在上一次失败的重建上（写入类工具据此在返回值里带 indexStale）。 */
const indexIsStale = (memoryDir) => staleIndexes.has(path.resolve(memoryDir))

/** 写入结果末尾那句：索引没更新。 */
const INDEX_STALE_TEXT =
  ' Warning: rebuilding the index (MEMORY.md) failed, so the per-turn index does not reflect this change until /memory reindex succeeds.'

/**
 * MEMORY.md 里列了几条记忆（`- [..](id.md)` 行数）；读不到返回 null。
 * memory_status 拿它与记忆文件数比：对不上就是上次重建失败，或有人手改了文件。
 */
function indexEntryCount(memoryDir) {
  try {
    const text = readFileSync(indexPath(memoryDir), 'utf8')
    return text.split(/\r?\n/).filter((line) => /^- \[[^\]]*\]\([^)]+\.md\)/.test(line)).length
  } catch (error) {
    // 没有 MEMORY.md 而且也没有记忆文件，是「空库」的正常形态，算 0
    if (error?.code === 'ENOENT') return 0
    return null
  }
}

/**
 * 在两个按需库之间移动一条记忆（项目库 ⇄ 全局按需库）。面板改了「适用范围」时由 save 路由调用。
 *
 *   · 移动前在**源库**的 history/ 里留一份（archiveVersion），误移可回退；
 *   · 目标库已有同 id（不分大小写——Windows 上是同一个文件）→ 拒绝 `target-exists`，不覆盖；
 *   · 目标库满（maxMemoryCount 两个库分别计数）→ 拒绝 `library-full`；
 *   · 只改 frontmatter 里的 scope 一行（withFrontmatterFields），其余字节原样搬过去：
 *     hits / created / 手写的 YAML 都不能因为换了个库就变样。
 *
 * `options.toScope`：目标库的 scope，写进文件；不给就不改这一行。
 * 同步函数、不重建向量：召回时按内容哈希对账，缺的会自动补上。
 */
export function moveMemory(fromDir, toDir, id, options = {}) {
  if (!isSafeId(id)) return { ok: false, reason: 'invalid-id', id: String(id ?? '').slice(0, 80) }
  if (sameDir(fromDir, toDir)) return { ok: false, reason: 'same-library', id }
  const item = readMemory(fromDir, id)
  if (!item) return { ok: false, reason: 'not-found', id }
  const target = idFile(memoriesPath(toDir), id)
  if (!target) return { ok: false, reason: 'invalid-id', id }
  const clash = listMemories(toDir).find((row) => row.id.toLowerCase() === id.toLowerCase())
  if (clash) return { ok: false, reason: 'target-exists', id, existing: clash.id }
  if (CONFIG.maxMemoryCount > 0) {
    const count = listMemories(toDir).length
    if (count >= CONFIG.maxMemoryCount) return { ok: false, reason: 'library-full', id, count, limit: CONFIG.maxMemoryCount }
  }

  archiveVersion(fromDir, id, item.raw)
  const moved =
    options.toScope === 'global' || options.toScope === 'project'
      ? (withFrontmatterFields(item.raw, { scope: options.toScope }) ?? item.raw)
      : item.raw
  try {
    ensureDir(memoriesPath(toDir))
    writeFileAtomic(target, moved)
  } catch (error) {
    return { ok: false, reason: 'move-failed', id, error: error instanceof Error ? error.message : String(error) }
  }
  memoryCache.delete(target)
  // 新位置落盘成功之后才删旧的。删不掉（编辑器占着、权限）就把新位置回滚：
  // 两个库各留一份同 id 的条目，面板按 id 选中时会同时高亮两行、第二条打不开（第五轮）。
  try {
    removeFileImpl(item.file)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    let rolledBack = false
    try {
      rmSync(target, { force: true })
      rolledBack = !existsSync(target)
    } catch {
      rolledBack = false
    }
    memoryCache.delete(target)
    // 回滚也失败（第六轮）：两个库里各有一份，单独的原因码 move-partial——与「已回滚、条目仍在原库」的 move-failed
    // 区分开，面板与模型才知道要去另一个库删掉多出的那份
    if (!rolledBack) {
      rebuildIndexQuietly(toDir)
      return { ok: false, reason: 'move-partial', id, error: detail }
    }
    return { ok: false, reason: 'move-failed', id, error: detail }
  }
  memoryCache.delete(item.file)
  // 索引是派生物：重建失败（MEMORY.md 被占用、被换成目录……）只记录，不让已经完成的移动报失败
  for (const dir of [toDir, fromDir]) rebuildIndexQuietly(dir)
  return { ok: true, id, file: target }
}

/** moveMemory 删源文件用的实现（测试可替换，见 setRemoveFileForTests）。 */
const realRemoveFile = (file) => rmSync(file, { force: true })
let removeFileImpl = realRemoveFile

/**
 * 测试用：替换 moveMemory 删源文件的实现，返回还原函数。
 * 「删源失败要回滚目标」在真实文件系统上很难稳定复现（Windows 上占着的文件 Node 也能删），所以经这里注入失败。
 */
export function setRemoveFileForTests(fn) {
  const previous = removeFileImpl
  removeFileImpl = typeof fn === 'function' ? fn : realRemoveFile
  return () => {
    removeFileImpl = previous
  }
}

/* -------------------------------------------------------- 待确认队列 */

/**
 * pending/ 里的条目还没进正式记忆库：不注入、不参与检索、不影响 MEMORY.md。
 * 只有 /memory accept 之后才会被搬进 memories/ 并重建索引。
 *
 * 抽取产物一律落在这里，是「自动积累但不让模型自作主张」的关键一环。
 */
function pendingPath(memoryDir) {
  // 草稿属于插件状态，同样放在 memory/ 外面
  return path.join(statePath(memoryDir), PENDING_DIR)
}

/** 列出待确认条目。与 listMemories 同构，但不走缓存（数量少、变动频繁）。 */
export function listPending(memoryDir) {
  const dir = pendingPath(memoryDir)
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const file = path.join(dir, entry.name)
    try {
      const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
      out.push({ id: entry.name.slice(0, -3), file, meta: data, body: body.trim(), mtime: statSync(file).mtimeMs })
    } catch {
      // 坏文件跳过
    }
  }
  return out.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
}

/** `<pending>/<id>.md`；id 不安全或会逃出 pending 目录时返回 null。 */
const pendingFile = (memoryDir, id) => idFile(pendingPath(memoryDir), id)

/**
 * 写一条待确认记忆。返回落盘路径。
 *
 * 默认 id 带随机后缀：同一批抽取的几条候选在同一毫秒内连续落盘，
 * 只用时间戳会互相覆盖（`queued` 报 3 条，实际只剩 1 个文件）。
 * `supersedes`：这条草稿被收下时要取代的已有记忆 id，由 acceptPending 执行。
 */
export function writePending(memoryDir, input) {
  const type = MEMORY_TYPES.includes(input.type) ? input.type : 'project'
  const id = input.id ?? `dr_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
  const now = new Date().toISOString()
  const file = pendingFile(memoryDir, id)
  if (!file) throw new Error(`不安全的草稿 id：${JSON.stringify(String(id).slice(0, 80))}`)
  const supersedes = typeof input.supersedes === 'string' ? input.supersedes.trim() : ''
  ensureDir(pendingPath(memoryDir))
  writeFileAtomic(
    file,
    serializeFrontmatter(
      {
        id,
        // 草稿阶段就记下英文 slug 与摘要，accept 时直接沿用
        slug: input.slug ? asciiSlug(input.slug) : undefined,
        description: input.description == null ? undefined : oneLine(input.description),
        scope: input.scope === 'global' ? 'global' : 'project',
        // 没给 load 就**不写**这个字段：acceptPending 对「无 load 且 scope: global」的草稿按旧含义
        // 落进 AGENTS.md。工具与抽取总是显式给 load，只有旧调用方（及旧草稿）走兼容分支。
        load: MEMORY_LOADS.includes(input.load) ? input.load : undefined,
        source: MEMORY_SOURCES.includes(input.source) ? input.source : undefined,
        evidence: typeof input.evidence === 'string' && input.evidence.trim() !== '' ? oneLine(input.evidence) : undefined,
        // 证据核实过没有（第六轮）：只在 source: user 时写。收下时原样带进正式记忆（见 acceptPending）
        evidenceVerified: input.source === 'user' && typeof input.evidenceVerified === 'boolean' ? input.evidenceVerified : undefined,
        type,
        status: 'draft',
        tags: input.tags ?? [],
        // paths 也要带上：accept 后写库时一并沿用，否则路径触发信息会丢
        paths: Array.isArray(input.paths) ? input.paths : [],
        supersedes: supersedes || undefined,
        // 常驻草稿取代的旧记忆在哪个库（第十一轮）：收下时写完 AGENTS.md 就在这个库里归档删除它。按需草稿不写
        supersedesScope: supersedes && (input.supersedesScope === 'global' || input.supersedesScope === 'project') ? input.supersedesScope : undefined,
        // 常驻草稿要更新哪一章（第五轮）：章号 + 写草稿时那一章的标题。收下时按标题找那一章（第六轮），
        // 章号只是写草稿时的位置，供面板显示。以前没存章号，收下时一律按新章追加，AGENTS.md 里出现两份。
        chapter: Number.isInteger(input.chapter) && input.chapter > 0 ? input.chapter : undefined,
        chapterTitle: typeof input.chapterTitle === 'string' && input.chapterTitle.trim() !== '' ? oneLine(input.chapterTitle) : undefined,
        newChapter: input.newChapter === true ? true : undefined,
        created: now,
        modified: now,
        title: input.title == null ? undefined : oneLine(input.title),
      },
      input.body ?? '',
    ),
  )
  return file
}

/**
 * frontmatter 里的布尔：解析器把所有标量都读成字符串，所以 `true` / `false` 读出来是 'true' / 'false'。
 * 只认这两个值（与布尔本身）；其它一律 undefined——手写的「yes」不能被当成「已核实」。
 */
export function parseFrontmatterBoolean(value) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

/**
 * 文字输出（/memory pending 等）里一条记忆或草稿的来源标签，规则与面板相同：
 * source 是 user 且 evidenceVerified 为真 →「用户原话」；source 是 user 但没核实（含没有该字段的旧数据）→「未核实」；
 * source 是 agent →「模型得出」；其它（没有 source 的旧数据）不标。返回值带前导空格，没有标签时是空串。
 */
export function sourceLabel(meta) {
  if (meta?.source === 'user') return parseFrontmatterBoolean(meta.evidenceVerified) === true ? '  用户原话' : '  未核实'
  if (meta?.source === 'agent') return '  模型得出'
  return ''
}

/**
 * 草稿里「收下后要做的事」的签名：去向（scope + load）、要取代谁（常驻草稿还有它所在的库）、常驻草稿要动哪一章。
 * 常驻草稿带取代对象（第十一轮）时同样成立：取代对象不同（或一条有、一条没有）就是不同的意图，不互相覆盖、不被直写清掉。
 */
function draftIntent(meta) {
  const { scope, load } = draftTarget(meta)
  return JSON.stringify([
    scope,
    load,
    typeof meta?.supersedes === 'string' ? meta.supersedes.trim() : '',
    String(meta?.chapter ?? ''),
    meta?.newChapter === true || meta?.newChapter === 'true',
    typeof meta?.supersedesScope === 'string' ? meta.supersedesScope : '',
  ])
}

/**
 * 入队一条草稿；队列里已有同 slug、**且收下后要做的事也相同**的草稿就覆盖它，而不是再加一条。
 *
 * 为什么覆盖：审计里 20 次写入有 14 次是在 4 个主题上反复改写。直写有查重兜着，
 * 进队列的却会堆出一串同主题草稿，人得逐条比对哪条是最新的。
 * 为什么还要看去向（第五轮）：只看 slug 时，一条「常驻 + 取代 X」的草稿会被同 slug 的普通草稿整个盖掉，
 * 去向和要取代的条目都丢了、也没留档。去向、supersedes、章号任一不同，就给新草稿一个新 id，两条都留给人选。
 * 返回 { file, id, replacedDraft?, sameSlugDrafts? }：sameSlugDrafts 是队列里同 slug、意图不同、因而**没有**被覆盖的草稿
 * （第六轮：在返回文本里点名，免得人把两条都收下、库里多出 `xxx-2`）。
 */
function queuePending(memoryDir, input) {
  const slug = typeof input.slug === 'string' && input.slug.trim() !== '' ? asciiSlug(input.slug) : ''
  const intent = draftIntent({
    scope: input.scope === 'global' ? 'global' : 'project',
    load: input.load,
    supersedes: input.supersedes,
    chapter: Number.isInteger(input.chapter) && input.chapter > 0 ? input.chapter : undefined,
    newChapter: input.newChapter === true,
    // 与 writePending 同一口径：只有带了 supersedes 时才记它所在的库
    supersedesScope: typeof input.supersedes === 'string' && input.supersedes.trim() !== '' ? input.supersedesScope : undefined,
  })
  const sameSlug = slug
    ? listPending(memoryDir).filter((draft) => typeof draft.meta.slug === 'string' && draft.meta.slug.toLowerCase() === slug)
    : []
  const previous = sameSlug.find((draft) => draftIntent(draft.meta) === intent)
  const others = sameSlug.filter((draft) => draft !== previous).map((draft) => draft.id)
  const file = writePending(memoryDir, { ...input, ...(previous ? { id: previous.id } : {}) })
  return {
    file,
    id: path.basename(file, '.md'),
    ...(previous ? { replacedDraft: previous.id } : {}),
    ...(others.length > 0 ? { sameSlugDrafts: others } : {}),
  }
}

/**
 * 直写成功后，删掉队列里**意图被这次写入完全覆盖**的草稿：slug 相同，且 draftIntent（去向 + supersedes + 章号）相同。
 * 与 queuePending 的覆盖用同一个判据（第六轮）：第五轮只看 slug + 去向，一条不带 supersedes 的直写会把
 * 「取代 X」的草稿一起清掉——那条草稿要做的事（删掉 X）这次写入并没有做。
 * 典型情形：第一次证据没核对上进了待确认，换一句原话重试后直写成功——旧草稿还在队列里，之后有人收下就多出 `xxx-2`。
 * `target`：{ scope, load, supersedes?, chapter?, newChapter? }。返回删掉的草稿 id；删不掉的跳过（留给人处置）。
 */
function clearDraftsFor(memoryDir, slug, target) {
  const wanted = typeof slug === 'string' && slug.trim() !== '' ? asciiSlug(slug) : ''
  if (!wanted) return []
  const intent = draftIntent(target)
  const removed = []
  for (const draft of listPending(memoryDir)) {
    if (typeof draft.meta.slug !== 'string' || draft.meta.slug.toLowerCase() !== wanted) continue
    if (draftIntent(draft.meta) !== intent) continue
    try {
      rmSync(draft.file, { force: true })
      removed.push(draft.id)
    } catch {
      // 删不掉就留着
    }
  }
  if (removed.length > 0) pruneEmptyState(memoryDir)
  return removed
}

/**
 * 草稿的去向：scope + load。旧草稿兼容：没有 load 且 scope: global 的，按 always（AGENTS.md）处理，
 * 那是写下它时的含义——旧版的 global 只有 AGENTS.md 一个去处。
 */
function draftTarget(meta) {
  const scope = meta?.scope === 'global' ? 'global' : 'project'
  const load = MEMORY_LOADS.includes(meta?.load) ? meta.load : scope === 'global' ? 'always' : 'on-demand'
  return { scope, load }
}

/**
 * 草稿清空后，把空的 pending/ 与空的 .memory-state/ 一并收掉。
 *
 * 这样「`.memory-state` 只在真有草稿时才存在」才是一句实话，
 * 而不是留下一个空目录让人猜它是干什么的。
 */
function pruneEmptyState(memoryDir) {
  try {
    const pendingDir = pendingPath(memoryDir)
    if (existsSync(pendingDir) && readdirSync(pendingDir).length === 0) {
      rmSync(pendingDir, { recursive: true, force: true })
    }
    const stateDir = statePath(memoryDir)
    if (existsSync(stateDir) && readdirSync(stateDir).length === 0) {
      rmSync(stateDir, { recursive: true, force: true })
    }
  } catch {
    // 清理失败不影响主流程
  }
}

/**
 * 收下一条待确认记忆：按草稿的 scope + load 落到对应去向，并重建索引与向量。
 *
 *   project + on-demand → 项目库（memoryDir，也就是草稿所在的项目）
 *   global  + on-demand → 全局按需库（options.globalDir，默认 globalMemoryDirOf()）
 *   global  + always    → ~/.dsh/AGENTS.md 的一章
 *   project + always    → 不收（插件不写项目 AGENTS.md），草稿留在队列里
 *
 * 草稿永远在 `memoryDir` 的 pending/ 里，与去向无关。
 */
export async function acceptPending(memoryDir, id, options = {}) {
  // 失败结果的约定与其它路由一致：原因码在 `reason`（状态码由路由按 REASON_STATUS 定），`error` 只放给人看的说明
  const file = pendingFile(memoryDir, id)
  if (!file) return { ok: false, reason: 'invalid-id', error: `不合法的草稿 id：${JSON.stringify(String(id).slice(0, 80))}` }
  if (!existsSync(file)) return { ok: false, reason: 'not-found', error: `待确认队列里没有 ${id}` }
  try {
    const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
    const { scope, load } = draftTarget(data)

    // 常驻 + 只在本项目成立：归宿是项目自己的 AGENTS.md，插件不写它（共享文件、会被章节重排弄乱）。
    // 工具不会产生这种草稿；手写/外来的草稿走到这里时拒收，草稿留在队列里由人丢弃（面板只能收下或丢弃，不能改草稿）。
    if (scope === 'project' && load === 'always') {
      return {
        ok: false,
        reason: 'belongs-in-project-agents',
        error: '这条草稿要求在本项目每轮常驻，归宿是项目自己的 AGENTS.md；插件不写该文件。请改成按需加载或跨项目后再收下（草稿仍在队列里）',
      }
    }

    // 常驻 + 跨项目：进 ~/.dsh/AGENTS.md。人已经在面板里按过「收下」，不再二次确认语义重复，直接追加/更新
    if (load === 'always') {
      // 草稿要更新某一章：**按章标题定位**（第六轮）。第五轮按章号核对，用户删掉前面任意一章后编号整体前移，
      // 草稿就永远收不下了。现在在当前 AGENTS.md 里找标题等于 chapterTitle 的章（去掉编号前缀与首尾空白、做 NFKC 再比），
      // 唯一命中就覆盖那一章，不管它现在是第几章；找不到（被删或改名）或有多个同名章才返回 section-moved，草稿留着。
      // 只有章号、没有章标题的手写草稿无从定位，同样 section-moved，不盲写。带 newChapter 或两者都没有（旧草稿）按新章追加。
      const chapter = /^\d+$/.test(String(data.chapter ?? '').trim()) ? Number(data.chapter) : undefined
      const chapterTitle = typeof data.chapterTitle === 'string' && data.chapterTitle.trim() !== '' ? data.chapterTitle : null
      const newChapter = data.newChapter === true || data.newChapter === 'true'
      let upserted
      if (((chapter !== undefined && chapter > 0) || chapterTitle) && !newChapter) {
        const moved = (detail, extra = {}) => ({
          ok: false,
          reason: 'section-moved',
          scope,
          ...(chapter !== undefined ? { chapter } : {}),
          ...extra,
          error: `AGENTS.md 里${detail}，没有写入；草稿仍在队列里`,
        })
        if (!chapterTitle) return moved('无法定位这条草稿要更新的那一章（草稿只有章号、没有章标题）')
        const doc = readAgentsDocument()
        if (!doc.ok) {
          upserted = doc
        } else {
          const norm = (title) => stripChapterNumber(String(title ?? '').normalize('NFKC')).trim()
          const hits = doc.sections.filter((section) => norm(section.title) === norm(chapterTitle))
          if (hits.length === 0) return moved(`找不到「${chapterTitle}」这一章了（被删除或改了名）`)
          if (hits.length > 1) return moved(`有 ${hits.length} 个叫「${chapterTitle}」的章，不知道该更新哪一个`, { matches: hits.length })
          const hit = hits[0]
          const saved = saveAgentsSection(hit.index, { title: data.title ?? id, body, expectedTitle: hit.title })
          if (!saved.ok && (saved.reason === 'section-moved' || saved.reason === 'section-not-found' || saved.reason === 'invalid-index')) {
            return moved(`「${chapterTitle}」这一章在写入前又变了`)
          }
          upserted = saved.ok ? { ...saved, action: 'updated', chapter: hit.index + 1 } : saved
        }
      } else {
        upserted = upsertAgentsChapter({ title: data.title ?? id, body, newChapter: true })
      }
      if (!upserted.ok) {
        // 以前把原因码塞在 error 里、状态落到默认 404；现在码进 reason，agents-full 带上字节数给面板拼文案
        return {
          ok: false,
          reason: upserted.reason ?? 'write-failed',
          scope,
          error: `AGENTS.md 写入失败（${upserted.reason ?? 'write-failed'}）；草稿仍在队列里`,
          ...(Number.isFinite(upserted.bytes) ? { bytes: upserted.bytes } : {}),
          ...(Number.isFinite(upserted.limit) ? { limit: upserted.limit } : {}),
        }
      }
      // 章节写成功之后才处置被取代的旧记忆（第十一轮）：跨项目偏好以全局 AGENTS.md 为唯一出处，旧的按需条目归档后删除。
      // 章节写入失败（section-moved / agents-full …）在上面已经返回，什么都没删。
      const retired = await retireSupersededMemory(memoryDir, data, options)
      rmSync(file, { force: true })
      pruneEmptyState(memoryDir)
      return { ok: true, scope, load, agents: upserted, action: upserted.action, path: upserted.path, ...retired }
    }

    const globalDir = options.globalDir ?? globalMemoryDirOf()
    const targetDir = scope === 'global' ? globalDir : memoryDir
    const otherDir = scope === 'global' ? memoryDir : globalDir

    // 草稿声明了要取代的旧记忆：先在目标库里找；目标还在才算「取代」（不占新名额、写完要把旧的归档删掉）。
    // 目标库没有、另一个按需库有 → 跨库取代：先用 moveMemory 把旧条搬进目标库（源库留档），
    // 再按同库取代处理。与 memory_remember 的跨库取代、面板改 scope 的移动共用 moveMemory。
    const wanted = typeof data.supersedes === 'string' ? data.supersedes.trim() : ''
    let target = wanted ? readMemory(targetDir, wanted) : undefined
    if (wanted && !target && !sameDir(otherDir, targetDir) && readMemory(otherDir, wanted)) {
      const moved = moveMemory(otherDir, targetDir, wanted, { toScope: scope })
      if (!moved.ok) {
        return {
          ok: false,
          reason: moved.reason,
          scope,
          error: `要取代的 ${wanted} 在另一个库里，搬过来失败（${moved.reason}）；草稿仍在队列里`,
        }
      }
      await rebuildVectors(otherDir)
      target = readMemory(targetDir, wanted)
    }

    // 条数硬限与 memory_remember 一致（两个库分别计数）：满了就拒收，草稿留在队列里。取代不增加条数，不拦。
    if (!target && CONFIG.maxMemoryCount > 0) {
      const count = listMemories(targetDir).length
      if (count >= CONFIG.maxMemoryCount) {
        return {
          ok: false,
          reason: 'library-full',
          scope,
          error: `${scope === 'global' ? '全局按需库' : '记忆库'}已有 ${count} 条，达到 ${CONFIG.maxMemoryCount} 条上限；先合并或删除一条再收下（草稿仍在队列里）`,
          count,
          limit: CONFIG.maxMemoryCount,
        }
      }
    }

    // 新旧 slug 相同就原地更新（保留 created / hits，历史里留旧版）；
    // 否则不传 id——正式库的文件名要用数据里的英文 slug，而不是草稿的 dr_xxx
    const inPlace = target && typeof data.slug === 'string' && asciiSlug(data.slug) === target.id
    const saved = writeMemory(targetDir, {
      ...(inPlace ? { id: target.id } : {}),
      slug: data.slug,
      // 新 id 同时避开另一个按需库（与库内重名同样处理）；原地更新保持原 id
      avoidIds: sameDir(otherDir, targetDir) ? [] : idsOf(otherDir),
      title: data.title ?? id,
      description: data.description,
      scope,
      body,
      type: data.type,
      tags: Array.isArray(data.tags) ? data.tags : [],
      paths: Array.isArray(data.paths) ? data.paths : [],
      source: data.source,
      evidence: data.evidence,
      // 证据核实过没有：草稿里怎么写的就原样带过来（第六轮）——人点了「收下」不等于证据被核实了。
      // 旧草稿没有这个字段就不写（列表接口也就不返回这个键）
      ...(data.source === 'user' && parseFrontmatterBoolean(data.evidenceVerified) !== undefined
        ? { evidenceVerified: parseFrontmatterBoolean(data.evidenceVerified) }
        : {}),
      status: 'confirmed',
      ...(target && !inPlace ? { supersedes: target.id } : {}),
    })
    // 取代：新条落盘成功之后才删旧的（deleteMemory 先归档，可回退）
    const savedId = path.basename(saved, '.md')
    const replaced = target && savedId !== target.id && deleteMemory(targetDir, target.id) ? target.id : ''
    rmSync(file, { force: true })
    pruneEmptyState(memoryDir)
    const built = await rebuildVectors(targetDir)
    return {
      ok: true,
      scope,
      load,
      file: path.relative(targetDir, saved),
      ...(replaced ? { replaced } : {}),
      ...(indexIsStale(targetDir) ? { indexStale: true } : {}),
      vectorMode: built.mode,
      vectorCount: built.indexed,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 常驻草稿收下、章节已经写进 AGENTS.md 之后：把草稿声明要取代的旧记忆归档删除（deleteMemory 先归档，可回退）。
 *
 * 只在草稿记下的那个库里按**精确 id** 找（supersedesScope；没记库的旧/手写草稿依次看全局库、项目库）——
 * 收下前旧条被删掉、改了名或搬去了别的库，就只写章节、不报错，返回 replacedMissing 说明旧条已不存在，
 * 不去别处猜一条同名的删。删除本身出错也不让整次收下失败：章节已经写了，再报失败会让人重复收下、多出一章；
 * 改为返回 replaceFailed，旧条留着由人处理。
 * 返回要并进收下结果的字段：{ replaced, replacedScope, indexStale? } / { replacedMissing } / { replaceFailed } / {}。
 */
async function retireSupersededMemory(memoryDir, data, options = {}) {
  const wanted = typeof data?.supersedes === 'string' ? data.supersedes.trim() : ''
  if (!wanted) return {}
  const globalDir = options.globalDir ?? globalMemoryDirOf()
  const libraries = [
    { scope: 'global', dir: globalDir },
    ...(sameDir(globalDir, memoryDir) ? [] : [{ scope: 'project', dir: memoryDir }]),
  ]
  const recorded = data.supersedesScope === 'global' || data.supersedesScope === 'project' ? data.supersedesScope : ''
  const candidates = recorded ? libraries.filter((library) => library.scope === recorded) : libraries
  try {
    const library = candidates.find((entry) => readMemory(entry.dir, wanted))
    if (!library || !deleteMemory(library.dir, wanted)) return { replacedMissing: wanted }
    await rebuildVectors(library.dir)
    return { replaced: wanted, replacedScope: library.scope, ...(indexIsStale(library.dir) ? { indexStale: true } : {}) }
  } catch (error) {
    console.error(`[workspace-memory] 收下常驻草稿后删除旧记忆 ${wanted} 失败: ${error instanceof Error ? error.message : String(error)}`)
    return { replaceFailed: wanted }
  }
}

/** 丢弃一条待确认记忆。被取代的旧记忆不动（第十一轮：常驻草稿带取代对象时也一样）。 */
export function rejectPending(memoryDir, id) {
  const file = pendingFile(memoryDir, id)
  if (!file) return { ok: false, reason: 'invalid-id', error: `不合法的草稿 id：${JSON.stringify(String(id).slice(0, 80))}` }
  if (!existsSync(file)) return { ok: false, reason: 'not-found', error: `待确认队列里没有 ${id}` }
  try {
    rmSync(file, { force: true })
    pruneEmptyState(memoryDir)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* -------------------------------------------------------- 自动抽取 */

/** 每 N 回合抽一次：sessionId → 已计回合数。 */
const turnCounter = new Map()

/**
 * 取最近一段对话的纯文本，用于抽取。
 *
 * 只取 user / assistant 的文本块；工具结果一律不取——那里全是文件内容和命令输出，
 * 既费 token 又几乎不含"值得记住"的东西（要记的判据通常在用户说什么、我承诺什么）。
 */
function recentTranscript(session, maxChars = 6000) {
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return ''
  }
  const parts = []
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    // 注入的上下文也是 user/message（见 isHumanMessage）：标成「用户：」会让抽取模型把它当原话抄进 evidence
    if (event.type === 'user/message' && !isHumanMessage(event.data)) continue
    const message = event.type === 'user/message' ? event.data : event.data?.message
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      // 跳过运行时注入的 <system-reminder> 块（任意位置）和记忆注入块
      const text = stripReminders(block.text)
      if (!text || isInjectedText(text)) continue
      parts.push(`${event.type === 'user/message' ? '用户' : '助手'}：${text}`)
    }
  }
  const joined = parts.join('\n\n')
  return joined.length > maxChars ? joined.slice(-maxChars) : joined
}

/** 注入块（运行时的 <system-reminder>、本插件的 [workspace-memory]）不是用户说的话。 */
const isInjectedText = (text) => text.startsWith('<system-reminder>') || text.startsWith('[workspace-memory]')

/**
 * 剥掉文本里**任意位置**的 `<system-reminder>…</system-reminder>` 块，再去首尾空白。
 * 宿主会把提醒附在用户消息的同一个文本块里（不一定在开头），只看开头会让提醒里的话被当成用户原话。
 * 没闭合的 `<system-reminder>` 开头仍由 isInjectedText 整块丢掉。
 */
const stripReminders = (text) => String(text).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

/**
 * 这条 `user/message` 是不是人亲手发的。
 *
 * 宿主的 `user/message` 不只装人说的话：`agent.inject()` 的上下文（子目录 AGENTS.md、skill 内容、
 * 文件变更通知）、每轮的 runtime-context 快照（本插件的记忆索引就在里面）、跨会话引用（session-reference）、
 * 工作目录说明……全都是 user/message，靠 `data.source.kind` 区分（官方 session.md 的 SessionEventMap；
 * persistence-catalog 的 MessageSource 表）。人直接发的消息 kind 是 `'user'`。
 * 只靠文本前缀过滤挡不住：快照里多个上下文拼在一起时，记忆索引不一定在开头。
 *
 * **只认明确标记为用户的消息**（第五轮）：真实宿主里 `source` 是必填（persistence-catalog 的 UserMessage），
 * 没有 source 的消息来路不明——以前放行它，等于让任何不带 source 注入的上下文都能给证据作保。
 * `user-question-reply`（迟到的提问回答）不算：回答里常是模型自己写的选项文字，算作原话会让模型自证。
 */
function isHumanMessage(data) {
  const source = data?.source
  return Boolean(source) && typeof source === 'object' && source.kind === 'user'
}

/**
 * 一条 UserMessage 里**人写的**文本；不是人发的、或没有文本块时返回 ''。
 *
 * UserMessage 的形状照官方 persistence-catalog：`{ id, role: 'user', content: ContentBlock[], source: MessageSource }`。
 * 过滤口径只有这一份，快照（userTextsOf）、pre-step 缓存（appendUserTexts）与预取查询共用：
 *   · 只认明确标记为用户的消息（isHumanMessage，没有 source 的不算）；
 *   · 剥掉任意位置的 `<system-reminder>…</system-reminder>` 块，剥完为空就丢弃；
 *     再跳过 `<system-reminder>`（没闭合）与 `[workspace-memory]` 开头的注入块——否则模型可以拿注入进来的
 *     记忆索引、AGENTS.md 当「用户原话」，证据核对就形同虚设；
 *   · content 只取 `type: 'text'` 的块（文本、图片、文件块混排）；字符串形式只为兼容旧记录。
 * 一条消息的多个文本块用换行连成一个元素：证据不允许跨消息拼接，但同一条消息里的几段算一句话的上下文。
 */
export function humanTextOf(message) {
  if (!isHumanMessage(message)) return ''
  const content = message?.content
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  const parts = []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const text = stripReminders(block.text)
    if (!text || isInjectedText(text)) continue
    parts.push(text)
  }
  return parts.join('\n')
}

/**
 * 会话里每条用户消息的文本（一条消息一个元素），**全会话、不截断**。
 *
 * 过滤规则见 humanTextOf。拿不到会话或事件就返回 []（核对一律不通过，宁可多进一次待确认）。
 *
 * 注意：它读的是 `session.snapshotEvents()`，官方 session.md 已把该接口标为 `@deprecated`
 * （「Existing logic may remain unmigrated for now, but new calls are prohibited」）。
 * 所以证据核对的**主路径**改成了 pre-step 缓存（见 appendUserTexts / verifyEvidenceFrom），这里只剩两处用途：
 *   · 证据核对的回落：DSH 重启后恢复的会话，早先的用户消息不在进程内缓存里；
 *   · 自动抽取的证据核对：抽取的对话记录本来就取自同一份快照（recentTranscript，属「existing logic」）。
 * 宿主将来移除该接口时，这里返回 []，核对退化为「进待确认」，不会报错。
 */
export function userTextsOf(session) {
  let events
  try {
    events = session?.snapshotEvents?.()
  } catch {
    return []
  }
  if (!Array.isArray(events)) return []
  const out = []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const text = humanTextOf(event.data)
    if (text) out.push(text)
  }
  return out
}

/** pre-step 缓存：每个 agent 最多保留最近多少条人写的用户消息。 */
export const USER_TEXT_CACHE_LIMIT = 200
/** pre-step 缓存：单条消息超过这么多字符就截断（只留开头）。 */
export const USER_TEXT_MAX_CHARS = 20000

/**
 * 把 `agent/pre-step` 这一批消息里**人写的**文本追加进进程内缓存 `Map<agentId, string[]>`（旧的在前）。
 * 返回追加的条数。
 *
 * 为什么在 pre-step 里收：官方 core.md 的 `agent/pre-step` payload 带 `messages: UserMessage[]`
 * （「messages removed from the inbox for this step」，且是 exclusive claimed batch：每条消息只被领取一次，
 * 被拒的步骤里领取的消息也不会再回来），这是不依赖任何已弃用接口、也不需要宿主包就能拿到用户原话的地方。
 * 读的是 payload 上原始领取的那一批，而不是下游 next() 返回的 enter 批次：下游监听器可能改写或替换消息，
 * 证据要的是用户敲进来的话。
 *
 * 为什么不用官方推荐的替代 `ctx.sessionProjections`：投影的 stateSchema 要求 Zod 类型，
 * 而本插件是 link 安装，解析不到宿主的 zod（见 CLAUDE.md），离线也无法验证——本轮不做投影。
 *
 * 有上限：每个 agent 最近 USER_TEXT_CACHE_LIMIT 条，单条超过 USER_TEXT_MAX_CHARS 字符截断；
 * 截掉的尾部若正是证据，核对会落到快照回落那一步，不会误判通过。
 */
export function appendUserTexts(cache, agentId, messages) {
  if (!(cache instanceof Map) || !agentId || !Array.isArray(messages)) return 0
  let added = 0
  for (const message of messages) {
    let text
    try {
      text = humanTextOf(message)
    } catch {
      continue // 单条消息结构异常（例如访问器抛错）只跳过它
    }
    if (!text) continue
    if (text.length > USER_TEXT_MAX_CHARS) {
      text = text.slice(0, USER_TEXT_MAX_CHARS)
      // 别把代理对劈成半个字符
      if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
    }
    let list = cache.get(agentId)
    if (!list) {
      list = []
      cache.set(agentId, list)
    }
    list.push(text)
    added += 1
  }
  const list = cache.get(agentId)
  if (list && list.length > USER_TEXT_CACHE_LIMIT) list.splice(0, list.length - USER_TEXT_CACHE_LIMIT)
  return added
}

/**
 * 证据核对的取数顺序：先用 pre-step 缓存核对；没通过（或缓存为空）再回落到会话快照。
 * 返回 `{ verified, via }`，via 是做出结论的那一路：`'prestep-cache'` / `'snapshot-fallback'`。
 *
 *   · `getSession` 是函数：缓存命中时根本不去取会话；
 *   · 回落前先判断 `typeof session.snapshotEvents === 'function'`——宿主移除这个已弃用接口后，
 *     这里不抛错，结论是「未通过」（进待确认），via 停在 prestep-cache；
 *   · 保留回落只为一种情况：DSH 重启后恢复的会话，早先的用户消息不在进程内缓存里。
 */
export function verifyEvidenceFrom({ cached, getSession, evidence } = {}) {
  const texts = Array.isArray(cached) ? cached : []
  if (texts.length > 0 && verifyEvidence(texts, evidence).verified) return { verified: true, via: 'prestep-cache' }
  let session
  try {
    session = typeof getSession === 'function' ? getSession() : undefined
  } catch {
    session = undefined
  }
  if (typeof session?.snapshotEvents !== 'function') return { verified: false, via: 'prestep-cache' }
  return { verified: verifyEvidence(userTextsOf(session), evidence).verified, via: 'snapshot-fallback' }
}

/**
 * 证据比对用的归一化：NFKC（全半角统一）、小写、去掉全部空白，再去掉 Unicode 标点与符号（`\p{P}`、`\p{S}`）。
 * 去标点是第四轮加的：模型抄原话时常把逗号换成句号、丢掉感叹号或加上引号，这些都不算改写。
 * 首尾的引号也是标点，一并去掉。
 */
const foldEvidence = (text) => String(text).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

/** 近似匹配只对归一化后至少这么长的段开放；更短的段差一个字就可能变成另一句话，只走精确匹配。 */
export const EVIDENCE_APPROX_MIN_LENGTH = 10
/** 近似匹配只看每条用户消息的前这么多字符（性能上限）；精确匹配不受限。 */
export const EVIDENCE_APPROX_MAX_CHARS = 20000
/**
 * 近似匹配的另外两道上限（第五轮）：归一化后超过这么长的段只做精确匹配；近似只在最近这么多条用户消息上做。
 * 为什么：核对是在工具调用里**同步**算的，Ukkonen 截断在低熵文本（重复的日志、代码）上几乎不起作用，
 * 审查实测「1000 字证据 × 200 条 20000 字消息」要数秒、缓存加快照回落要近 10 秒，整个回合都卡着。
 * 抄错一两个字的情形只会出现在短句上；长证据要么原样抄对，要么就不是原话。精确匹配不受这两道上限。
 */
export const EVIDENCE_APPROX_MAX_SEGMENT = 500
export const EVIDENCE_APPROX_RECENT_MESSAGES = 50

/** 字符串 → 码点数组：中日韩字符、emoji 都按一个字算，编辑距离才是「几个字」。 */
const codePointsOf = (text) => {
  const out = []
  for (const ch of text) out.push(ch.codePointAt(0))
  return out
}

/**
 * 近似子串匹配：在 `text[from..]` 里找一个与 `pattern` 编辑距离（插入、删除、替换各算 1）不超过 `k` 的
 * **连续片段**，返回最早的结束位置（不含）；找不到返回 -1。参数都是码点数组。
 *
 * Sellers 算法：按列推进的编辑距离 DP，但首行全为 0（匹配可以从文本任何位置开始），末行 ≤ k 即命中。
 * 加了 Ukkonen 的截断：只算到「最后一个 ≤ k 的格子」的下一格，期望耗时 O(k·n) 而不是 O(m·n)。
 * （Navarro, "A guided tour to approximate string matching", 2001，§5.3 的写法。）
 *
 * 为什么不用「公共子序列占比」之类的度量：那种度量能被分散在长消息各处的字符凑出来；
 * 这里要求的是一个连续片段，只差几个字。
 * 取最早的结束位置：多段按顺序核对时给后面的段留出最多空间（贪心在这里是最优的）。
 */
export function approxMatchEnd(pattern, text, k, from = 0) {
  const m = pattern.length
  if (m === 0 || k >= m) return from // 空模式（或允许整段删光）在起点就算命中
  const column = new Int32Array(m + 1)
  for (let i = 0; i <= m; i += 1) column[i] = i
  let lastActive = k + 1 // 最后一个可能 ≤ k 的格子；k < m，所以不越界
  for (let pos = from; pos < text.length; pos += 1) {
    const ch = text[pos]
    let diagonal = 0 // 上一列的 column[i-1]
    let above = 0 // 本列的 column[i-1]（首行恒为 0）
    for (let i = 1; i <= lastActive; i += 1) {
      let value
      if (pattern[i - 1] === ch) value = diagonal
      else value = Math.min(diagonal, above, column[i]) + 1
      diagonal = column[i]
      column[i] = value
      above = value
    }
    while (column[lastActive] > k) lastActive -= 1
    if (lastActive === m) return pos + 1
    lastActive += 1
  }
  return -1
}

/**
 * 核对 `evidence` 是不是用户的原话。目的是确认「这句话出自用户」，不是逐字校对。
 * 返回 `{ verified: true, match: 'exact' | 'approx' }`，未通过时只有 `{ verified: false }`。
 *
 *   · 归一化（foldEvidence）：NFKC、小写、去全部空白、去标点与符号——这些差异不算改写；
 *   · 按省略号（`…` 或连续 2 个以上的 `.`）切段，**在去标点之前**切：允许跳过中间的话，但每段 ≥ 2 字、
 *     合计 ≥ 4 字，防止拿「好」「的」这种单字凑出任意证据；首尾的省略号只是「前后还有话」，切出的空段不算一段；
 *   · 所有段必须**按顺序**落在**同一条**用户消息里——跨消息拼接能拼出用户从没说过的话。
 * 两步，任一通过即算通过：
 *   1. 精确：每段都是那条消息（归一化后）的子串；
 *   2. 近似：长度在 10–500 之间的段允许与某个连续片段有不超过 floor(长度 / 10) 的编辑距离（approxMatchEnd），
 *      其余的段仍须精确出现；下一段从上一段匹配片段的结束位置往后找。
 *      只在最近 EVIDENCE_APPROX_RECENT_MESSAGES 条消息上做，每条只看前 EVIDENCE_APPROX_MAX_CHARS 个字符（上限的理由见常量）。
 *   评测里模型抄原话时漏了一个字（「不用每步问我」对「不用每步都问我」），核对不过、白进了一次待确认。
 *
 * **局限：只核对「字面出现过」，不判断语义。** 截取用户否定句的后半段（「不要每次都提交到主分支」→
 * 「每次都提交到主分支」）、用省略号跳过否定词、近似匹配里一字之差翻转了意思，都可能通过。这些代码判断不了，
 * 也不该用否定词黑名单之类的办法去补（误伤与漏网都会很多）：靠 evidenceRelates 要求证据确实在说这条记忆、
 * 常驻写入一律由人确认，以及人在面板里能看到 evidence 原文。
 */
export function verifyEvidence(userTexts, evidence) {
  if (typeof evidence !== 'string' || !Array.isArray(userTexts) || userTexts.length === 0) return { verified: false }
  // 抽取提示词让模型从「用户：」开头的行里抄；它可能连前缀一起抄来，前缀不是用户的话
  const raw = evidence.normalize('NFKC').trim().replace(/^用户\s*[:：]\s*/u, '')
  // 先按省略号切段，再逐段去标点（去标点会把省略号本身也去掉）
  const segments = raw
    .split(/…|\.{2,}/u)
    .map((part) => foldEvidence(part))
    .filter((part) => part !== '')
  if (segments.length === 0) return { verified: false }
  const points = segments.map(codePointsOf)
  const lengths = points.map((part) => part.length)
  if (lengths.some((n) => n < 2) || lengths.reduce((a, b) => a + b, 0) < 4) return { verified: false }
  const texts = userTexts.filter((text) => typeof text === 'string')

  // 1) 精确
  for (const text of texts) {
    const hay = foldEvidence(text)
    let at = 0
    let matched = true
    for (const part of segments) {
      const found = hay.indexOf(part, at)
      if (found < 0) {
        matched = false
        break
      }
      at = found + part.length
    }
    if (matched) return { verified: true, match: 'exact' }
  }

  // 2) 近似：没有一段落在 [10, 500] 里时，这一步与精确等价，不用再跑
  const approxable = (n) => n >= EVIDENCE_APPROX_MIN_LENGTH && n <= EVIDENCE_APPROX_MAX_SEGMENT
  if (!lengths.some(approxable)) return { verified: false }
  for (const text of texts.slice(-EVIDENCE_APPROX_RECENT_MESSAGES)) {
    const hay = foldEvidence(text.slice(0, EVIDENCE_APPROX_MAX_CHARS))
    let at = 0 // hay 里的字符串下标（总落在码点边界上）
    let matched = true
    for (let i = 0; i < segments.length; i += 1) {
      let end = -1
      if (approxable(lengths[i])) {
        // 编辑距离按码点算（一个汉字、一个 emoji 都是一个字），算完换回字符串下标
        const rest = codePointsOf(hay.slice(at))
        const cpEnd = approxMatchEnd(points[i], rest, Math.floor(lengths[i] / 10), 0)
        if (cpEnd >= 0) {
          let units = 0
          for (let c = 0; c < cpEnd; c += 1) units += rest[c] > 0xffff ? 2 : 1
          end = at + units
        }
      } else {
        // 短段与超长段都只做精确：用 indexOf，不用朴素逐位比较（低熵长文本上会退化成 O(n·m)）
        const found = hay.indexOf(segments[i], at)
        if (found >= 0) end = found + segments[i].length
      }
      if (end < 0) {
        matched = false
        break
      }
      at = end
    }
    if (matched) return { verified: true, match: 'approx' }
  }
  return { verified: false }
}

/**
 * 证据是不是在说**这条记忆**：与这条记忆的文字（标题、摘要、正文）有没有字面交集。
 *
 * 定位（第六轮按复审改）：它**只拦「拿一句完全无关的回复当证据」**——用户回一句「好的，继续」，模型拿它当证据
 * 写进任意内容。它不是「证据确实陈述了这条规则」的证明：字面交集挡不住把用户的话抄进标题（复审实测 6 个绕过样例都过），
 * 而第五轮只比标题和摘要、门槛偏高时，模型用自己的话写标题，约两成真实纠正被误判（没写摘要时一半）。所以：
 *   · 比对范围是 `texts`（调用处传 [标题, 摘要, 正文]）：正文按 BODY_RULE 写 Why，通常引用用户的话；
 *   · 共有 ≥ 2 个不同的中日韩二元组（同一段连续文字里相邻的两个字；标点、空格处断开），或
 *     共有 ≥ 1 个长度 ≥ 3 的 ASCII 字母数字词（dev、git、npm、sql 这类短技术词要算）；
 *   · 证据归一化后不足 6 个字的短纠正（「说大白话」「别用 emoji」）只要求共有 ≥ 1 个二元组或 ≥ 1 个词。
 * 两边做同样的归一化（NFKC、小写）。真正的把关是：常驻一律由人确认、核对结果存进 evidenceVerified 给人看。
 * 为兼容旧调用，第二个参数不是数组时，把其余参数都当成要比的文字。
 */
export function evidenceRelates(evidence, texts, ...rest) {
  const list = (Array.isArray(texts) ? texts : [texts, ...rest]).filter((text) => typeof text === 'string')
  const fold = (text) => String(text ?? '').normalize('NFKC').toLowerCase()
  const bigramsOf = (text) => {
    const out = new Set()
    for (const run of fold(text).match(CJK_RUN) ?? []) {
      const chars = Array.from(run)
      for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1])
    }
    return out
  }
  const wordsOf = (text) => new Set((fold(text).match(/[a-z0-9]+/g) ?? []).filter((word) => word.length >= 3))
  const target = list.join('\n')
  const targetGrams = bigramsOf(target)
  const targetWords = wordsOf(target)
  let sharedGrams = 0
  for (const gram of bigramsOf(evidence)) if (targetGrams.has(gram)) sharedGrams += 1
  let sharedWords = 0
  for (const word of wordsOf(evidence)) if (targetWords.has(word)) sharedWords += 1
  const short = Array.from(foldEvidence(evidence ?? '')).length < 6
  return sharedGrams >= (short ? 1 : 2) || sharedWords >= 1
}

/**
 * 正文里像「下周就过期」的值：提交哈希、版本号。只提示，不拦截、不改写（策略不是过滤器）。
 *
 * 审计里 24 条记忆有 13 条「规则对，但混了提交哈希、计数、版本号、安装路径」——
 * 规则还对，那些值早已过期，召回时反而误导。
 *   · 哈希：7–40 位十六进制，且同时含字母和数字（纯数字是计数/日期，纯字母是单词）；
 *   · 版本号：`v?\d+\.\d+\.\d+`；type 为 pitfall 时不算（版本正是坑的失效条件）；
 *   · 围栏代码块里不检：那是命令或输出样例，不是规则本身。
 */
export function stalenessHints(body, type) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n')
  const fenced = fenceMask(lines)
  const text = lines.filter((_, i) => !fenced[i]).join('\n')
  const found = []
  const add = (value) => {
    if (!found.includes(value)) found.push(value)
  }
  for (const match of text.matchAll(/(?<![0-9A-Za-z])[0-9a-f]{7,40}(?![0-9A-Za-z])/giu)) {
    if (/[a-f]/i.test(match[0]) && /\d/.test(match[0])) add(match[0])
  }
  if (type !== 'pitfall') {
    for (const match of text.matchAll(/(?<![\w.])v?\d+\.\d+\.\d+(?!\w|\.\d)/gu)) add(match[0])
  }
  return found
}

/** stalenessHints 命中时追加在写入结果末尾的一句；没命中返回空串。 */
function stalenessNote(values) {
  if (!Array.isArray(values) || values.length === 0) return ''
  const named = values.slice(0, 5).map((value) => `"${value}"`).join(', ')
  return (
    ` Note: the body mentions ${named}${values.length > 5 ? ` and ${values.length - 5} more` : ''}. ` +
    'Values like these go stale; keep them only if they are the condition under which this memory stops applying.'
  )
}

/**
 * 从模型输出里抠出 JSON 数组，容忍 ```json 围栏和前后闲聊。
 *
 * 逐个尝试候选串，第一个能解析成「含合法条目的数组」的胜出：
 *   1. 整段文本；
 *   2. 整段被围栏包住时，围栏**内**的内容（取到最后一个 ```，所以正文里的 ``` 不会截断它）；
 *   3. 从每一个 `[` 起、到最后一个 `]` 止（前后有闲聊、闲聊里还带着 `[2]` 之类的方括号）。
 * 不用「第一个 ``` 对」去切——条目的 body 本来就是 Markdown，里面常有代码围栏。
 * 回复被 maxTokens 截断时没有任何候选能解析，返回 []（不猜、不补全）。
 */
export function parseExtractionJson(text) {
  // 模型输出/上游异常什么都可能传进来，先兜住非字符串
  const source = typeof text === 'string' ? text.trim() : ''
  if (!source) return []

  const candidates = [source]
  if (source.startsWith('```')) {
    const opening = /^```[^\n]*\n/.exec(source)
    const lastFence = source.lastIndexOf('```')
    if (opening && lastFence >= opening[0].length) candidates.push(source.slice(opening[0].length, lastFence))
  }
  const last = source.lastIndexOf(']')
  let attempts = 0
  for (let start = source.indexOf('['); start >= 0 && start < last && attempts < 64; attempts += 1) {
    candidates.push(source.slice(start, last + 1))
    start = source.indexOf('[', start + 1)
  }

  for (const candidate of candidates) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    const valid = parsed.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.title === 'string' &&
        item.title.trim() &&
        typeof item.body === 'string' &&
        item.body.trim(),
    )
    if (valid.length > 0) return valid
  }
  return []
}

/** 抽取一次的墙钟上限：流卡住时回合收尾最多被拖这么久。 */
const EXTRACT_TIMEOUT_MS = 60_000

/* ---------------------------------------------- 提示词分层（系统提示段 / 工具说明 / 参数说明） */

/*
 * 「该不该记、记到哪、怎么写」分三层放，**同一条规则只出现一处**（官方 tool-design.md：
 * 「Say each fact once. Do not repeat the tool definition in its system-prompt section, a parameter
 * description in the tool description …」「Put parameter rules on the parameter.」）：
 *
 *   · MEMORY_SECTION        系统提示段（ctx.systemPrompt.section，静态）：何时想到要记、四个归宿怎么选。
 *                           practices.md：「Add prompt text with ctx.systemPrompt.section()」。
 *   · REMEMBER_DESCRIPTION  工具说明：只写工具做什么、何时用、返回什么。
 *   · *_RULE                参数说明：每条规则挂在它管的那个参数上。
 *
 * 抽取提示词是另一次独立的模型调用（没有工具 schema、没有系统提示段），由同一批常量拼成，不算重复。
 * 文本逐字来自设计说明 §6.1；措辞会在评测里反复改，test/admission.test.mjs 只守结构（哪段在哪、不重复）。
 */

/**
 * 系统提示段（中文）。审计里漏记的 12 条有约 9 条是用户对做法/表达方式的纠正，漏记时模型推理里一次都没想到写记忆：
 * 以前每轮注入只讲召回、库为空时什么都不注入。放进系统提示段而不是动态 context：它是不随轮次变化的行为指引，
 * 放在静态段里可以被前缀缓存复用，也不依赖「库里有没有东西」。
 *
 * 第二版（设计说明 §12.1，代理模型评测驱动）：四个归宿以前只是并列列出，没有判断依据，发布流程、仓库规则、设计取舍
 * 3/3 被存成记忆——改成先问「这是给谁用的」；「都要处理，不要略过」有歧义（当场改正也算处理了），不带「以后」的纠正会漏——
 * 改成明说「当场改正，并记进记忆」。
 */
export const MEMORY_SECTION = [
  '# 记忆与知识沉淀',
  '',
  // 第四版（设计说明 §14.1，2026-11-15）：用户看了评测题后逐条拍板——规则以 AGENTS.md 为准、项目记忆库不存规则；
  // 跨项目的做事与表达偏好进全局 AGENTS.md 常驻（scope global + load always，进待确认），推翻了「偏好放按需库就够」；
  // 「这次」的不记。目标模型评测里另有两处：只纠正一个结果却归纳出做法去记、收工时泛泛地问要不要记一笔。
  '学到以后还用得上的东西时，先判断它该写到哪：',
  '- 可重复的多步操作流程（怎么部署、怎么排查某类故障、怎么出报表）→ skill，不管是只有你用还是大家都用',
  '- 必须遵守的规则以 AGENTS.md 为准：进这个仓库的人和 agent 都要遵守的 → 项目的 AGENTS.md；只对这位用户成立的项目规则 → 同目录的 AGENTS.local.md。决定仓库里会留下什么的约定（提交说明、代码风格、命名）也算这个仓库的规则。规则不往记忆里存第二份',
  // 「用户是谁」挪到这一行：用户 2026-11-15 定的常驻范围含「我是做后端的」「只用 Windows」这类，
  // 代码（resolveLoad）也把 user / feedback + global 一律按常驻处理，文字要与它一致。
  '- 用户是谁、用户对你做事和表达方式的长期要求，在所有项目都成立的 → 全局 AGENTS.md：调用 memory_remember，scope 选 global、load 选 always，它会进待确认，由用户在面板里收下',
  '- 项目说明、用法、设计取舍 → README 或仓库文档',
  '- 其余只有你和这位用户用得上的：代码里看不出的进行中决定与期限、仓库外资源的位置、你验证过的坑 → 记忆（memory_remember）',
  '代码、git 历史、现有文档里已经有的，哪里都不用写。',
  '',
  '用户说「以后 / 每次 / 记住 / 默认」只说明这件事要长期保留，去处仍按上面判断；话里明确说了「这次」的，只管这一次，不记。用户指出你的做法或表达不对时，哪怕只说一次、没说「以后」，也要做两件事：当场改正，并把这条做法写下来。只在回复里答应「以后会注意」没有用：下次会话你不记得这次对话，写下来才算数。没有调用 memory_remember 并拿到返回之前，不要对用户说「记下了」；决定先问用户写到哪时，就说明还没记。用户只是指出这次的结果不对（算错了、写错了），改对就行，不要自己归纳出一条做法去记。',
  '',
  'skill、AGENTS.md、README 是共享文件：先说明想写什么、为什么，用户同意后再用文件工具写；用户明确要求时直接写。等用户答复期间不要先往记忆里存一份，否则同一条内容会有两个出处。拿不准去处，或者拿不准是长期规则还是只管这一次，就在回复末尾问用户一句并给出选项；没有具体要记的东西时，不要泛泛地问要不要记点什么。你自己踩到并验证过的坑不用先问，直接存：它会进待确认，由用户决定收不收。只为当前任务服务的指令、进度、中途结论不记。',
  '',
  '记忆写的是当时的情况。照着记忆里提到的文件、命令、配置去做之前，先确认它们还在。',
].join('\n')

/**
 * 系统提示段的排序值。外部插件可取任意有限数（官方 dsh-system-prompt README「Contribute a prompt section」）。
 * 首方的工具指引段占 1000–3100（TOOL_BASH … MCP_SERVERS），TOOLS_SDK 是 5000，
 * 带环境信息的后缀从 10000 起（HARNESS_SOURCE / WEB_SURFACE / 部署人设后缀）。
 * 这一段是「怎么用本插件工具」的静态指引，所以紧跟在首方工具指引之后（3200），
 * 仍在可复用前缀里、在环境后缀之前；3200 没有被任何首方段占用。
 */
export const MEMORY_SECTION_ORDER = 3200

/** 值得记 / 不值得记：工具说明与抽取提示词共用这一句（两次独立的模型调用，不算重复）。 */
export const WORTH_SAVING =
  'Worth saving: what stays true and useful in a later session and would change what you do next time. Not worth saving: instructions, progress or results of the current task; what the diff or docs already show; your opinion of the user; generic advice; secrets or tokens.'

/** memory_remember 的工具说明：只写做什么、何时用、返回什么。判据挂在参数上，归宿判断在系统提示段里。 */
export const REMEMBER_DESCRIPTION = [
  // §13.3：归宿判断从「看系统提示段的建议」改成「调用时用 type 表态」（代理模型判错时其实知道答案，只是没被要求表态）
  'Save one memory for future sessions. Say what kind of thing it is with type: memories are saved; for a procedure, a repo-wide rule or project documentation the tool tells you where it belongs instead.',
  WORTH_SAVING,
  'Save at once on an explicit ask or a correction; anything else at the end of the task, because mid-task conclusions get overturned.',
  // 提示词第二版（§12.4）：代理模型评测里，更新已有记忆时模型新建了一条、被查重拒写——「改主意用取代」以前只写在参数上。
  // 这句不进 WORTH_SAVING（抽取提示词复用 WORTH_SAVING，那里只要 worth / not worth 两句）。
  'To change or correct a memory that already exists, pass supersedes instead of saving a second one.',
  // 第四轮：去掉括号里的「告诉用户在面板里等确认」——评测里它让模型在直写成功时也这么说。
  // 该怎么对用户说由返回文本给出（直写：active now；待确认：waiting in the memory panel）。
  "Returns the saved id, a pending id when the memory waits for the user's review, or a refusal that says what to change.",
].join(' ')

/**
 * `slug` 参数（第四轮设为必填）：评测里 8 次成功写入有 6 次第一次没给 slug，被 needs-slug 拒掉重试，每次白花一轮。
 * needs-slug 的拒写仍保留，作为模型仍漏填时的兜底（宿主不替 raw JSON-Schema 工具校验 required）。
 */
export const SLUG_RULE = 'Short English kebab-case file name: lowercase ASCII words joined by hyphens, e.g. "no-explanatory-text-in-ui".'

/**
 * `description` 参数与抽取提示词共用（第四轮）：按需库的索引每轮注入，每条记忆在索引里只有这一行，
 * 所以这一行要写记忆本身。注意：跨项目的做事 / 表达偏好按用户 2026-11-15 的决定进全局 AGENTS.md 常驻（§14），
 * 不要以「索引行每轮可见」为由把它们留在按需库。
 */
export const DESCRIPTION_RULE =
  "One line (<=120 chars), shown in the index on every turn. State the memory itself (for a rule, the rule), in the user's language."

/** 直写成功的返回文本末尾那一句：与待确认的「waiting in the memory panel」分开，模型不会把直写说成待确认。 */
export const ACTIVE_NOW_TEXT = 'It is active now; no review is needed.'
/** 进待确认的返回文本里那一句。 */
export const PENDING_TELL_TEXT = 'Tell the user it is waiting in the memory panel.'

/**
 * `type` 参数：门槛按类型分开写（「五条全满足」那套原本是给 AGENTS.md 防膨胀的，搬来管所有写入过严）。
 * §13.1：加了三个「不是记忆」的取值（ROUTED_TYPES）——归宿判断变成调用时必须回答的问题。
 * 三版提示词在代理模型上「用户没明说去处」的场景始终不稳（2/9 → 5/9，两次采样会翻转）；
 * 模型判错时自己在正文里写着「所有 agent 都必须遵守」，仍存成 type: project——它知道答案，只是没被要求表态。
 */
export const TYPE_RULES =
  "Says what kind of thing this is and sets the bar. Five kinds are memories. user: who the user is (language, role, expertise, standing preferences); only what they said themselves, never your impression of them. feedback: the user corrected HOW you work or communicate, or confirmed a non-obvious approach; save it the first time, do not wait for a repeat; correcting this task's output (a wrong value, a typo) is not feedback, even if you could draw a lesson from it. project: a goal, decision, constraint or deadline in this user's work on the project that the code cannot show, stated by the user; absolute dates; not your own plan or progress, and not a standing rule for the repo (that is repo-rule). reference: where something lives outside the repo (URL, dashboard, account, doc) and what it is for. pitfall: something non-obvious you hit and VERIFIED, a trap and its fix or the one technique that works; name the situation that triggers it and when it stops applying (e.g. a version); a guess or mid-task theory is not a pitfall. Three kinds are not memories: choose them when they fit, and instead of saving, the tool tells you where the content belongs. procedure: a repeatable multi-step how-to. repo-rule: a rule everyone working on this repo must follow. docs: what the project is, how to use it, or why it is built this way."

/** `body` 参数：审计里 24 条有 13 条「规则对，但混了提交哈希、计数、版本号、安装路径」。 */
export const BODY_RULE =
  'The memory in Markdown: the rule in a sentence or two, then a "Why:" line and a "How to apply:" line. Write what the user asked for, not the mechanism you chose to implement it. Leave out what is stale next week: commit hashes, counts, version numbers, backup or install paths (a version is fine as a pitfall\'s expiry condition).'

/** `source` 参数：按来源分流，取代模型自评置信度。 */
export const SOURCE_RULE =
  '"user" = the user said it; give their words in evidence. "agent" = you worked it out yourself, as with most pitfalls; it waits for the user\'s review.'

/** `evidence` 参数。 */
export const EVIDENCE_RULE =
  'The user\'s exact words that state this memory, copied from their message. Needed when source is "user": when they are found in the conversation the memory is saved directly.'

/**
 * `scope` 参数：只表示适用范围，不再决定加载方式。
 * 提示词第二版（§12.3）：代理模型评测里 scope 全落在默认值 project（可选、有默认、还写着「拿不准就选 project」）。
 * 改为必填，并按内容举例说清两边各放什么；execute 里缺失仍取默认 project（宿主不校验 required，不能因漏填就拒写）。
 */
export const SCOPE_RULE =
  '"global" = holds in any project: who the user is, how they want you to work or communicate. "project" = holds only in this workspace: its decisions, deadlines, resources, pitfalls. When unsure choose "project".'

/**
 * `load` 参数：加载方式与适用范围分开，「处处适用但只在特定场景才用」的知识才有去处。
 * 第五轮：说清按需库的索引行每轮可见，常驻一律等用户确认。
 * §14.2（用户拍板）：跨项目的做事与表达要求放常驻（全局 AGENTS.md），不再是「几乎都放按需库」。
 */
export const LOAD_RULE =
  '"always" = a chapter in the user\'s global instructions file (AGENTS.md), injected into every turn of every project; it always waits for the user\'s review. Use it for the user\'s standing requirements about how you work or communicate that hold in every project, and for a trap whose damage cannot be undone. Needs scope "global". "on-demand" (default) = the index line is visible every turn and the body surfaces through recall; use it for everything else.'

/**
 * `supersedes` 参数：审计里 20 次写入有 14 次在 4 个主题上反复改写。
 * 提示词第二版（§12.4）：「什么时候用取代」挪进了工具说明（REMEMBER_DESCRIPTION），这里只留它是什么，避免重复。
 */
export const SUPERSEDES_RULE = 'Id of the memory this one replaces; the old body is archived.'

/** `paths` 参数：它驱动「碰到文件时提示相关记忆」。 */
export const PATHS_RULE =
  'Real files this memory is about (e.g. "src/index.js"). The memory surfaces when those files are touched; a wrong path means it never does.'

/**
 * 四个归宿（英文）：**只用在抽取提示词里**。交互会话里的归宿判断在 MEMORY_SECTION（中文）里，
 * 抽取是离线的另一次模型调用，看不到系统提示段，所以自己带一份。
 */
export const HOMES = [
  // 2026-11-15 按用户的去处决定同步（§14）：规则以 AGENTS.md 为准；跨项目的做事 / 表达偏好进全局 AGENTS.md 常驻。
  // 流程的例子换成与评测场景不重合的（原来的 release / verify / migrate 正是三道 skill 题）。
  'FIRST decide where it belongs; memory is one of these homes:',
  '- skill: a repeatable multi-step procedure (how to deploy, troubleshoot a kind of failure, produce a report).',
  "- the project's AGENTS.md: a rule every agent in this repo must follow; a project rule that holds only for this user goes in AGENTS.local.md. Rules are not kept a second time in memory.",
  "- the global AGENTS.md, through memory: the user's standing requirements about how you work or communicate that hold in every project. Save them with scope \"global\" and load \"always\"; they wait for the user's review.",
  '- README or repo docs: what the project is, how to use it, why it is built this way.',
  '- memory: the rest that only you and this user need: who they are, decisions and deadlines the code cannot show, where outside resources live, traps you verified.',
  'What the code, git history or existing docs already show goes nowhere.',
].join('\n')

/** 抽取提示词：与工具说明、参数说明用同一批常量拼成（§6.1(e)）。 */
export const EXTRACTION_SYSTEM = [
  [
    'You extract durable memories from a conversation for a coding agent. Most conversations yield none: return [] and nothing else. That is the normal answer.',
    'Return ONLY a JSON array, no prose. Each element:',
    '{"slug": string, "title": string, "description": string, "body": string, "type": "user"|"feedback"|"project"|"reference"|"pitfall", "scope": "project"|"global", "load": "on-demand"|"always", "source": "user"|"agent", "evidence": string, "tags": string[]}',
    'Field rules:',
    '- "slug": short ENGLISH kebab-case file name (lowercase ascii words joined by hyphens, at most 6 words, no Chinese), e.g. "no-explanatory-text-in-ui". It becomes the file name and the index link text.',
    '- "title": human-readable title in the conversation\'s language (Chinese is fine); it is NOT the file name.',
    `- "description": ${DESCRIPTION_RULE}`,
  ].join('\n'),
  HOMES,
  "Extract only items whose home is memory (including the global AGENTS.md, which is reached through memory). Something that belongs in a skill, the project's AGENTS.md or AGENTS.local.md, or the README is not a memory: skip it.",
  WORTH_SAVING,
  `type: ${TYPE_RULES}`,
  `body: ${BODY_RULE}`,
  `source: ${SOURCE_RULE}`,
  // 第六轮起核对不过的候选不再丢弃，而是以「未核实」入队；这句要与实际行为一致（原文写的是 dropped）
  `evidence: ${EVIDENCE_RULE} An item whose evidence is not found is marked unverified.`,
  `scope: ${SCOPE_RULE}`,
  `load: ${LOAD_RULE}`,
].join('\n\n')

/**
 * 跑一次抽取。**永不抛异常**，任何环节失败都返回 { skipped }。
 *
 * 用宿主播的当前模型（session.requestContext 里的 provider/model），
 * 不额外配 provider、不需要 key。
 *
 * `options.manual`：用户显式敲了 `/memory extract`。
 * `enableExtraction` 只管「每回合自动触发」；显式命令是明确意图，不该被这个开关挡住。
 * （之前手动命令也被挡住，但面板与帮助文案都在建议用户去跑它——那是句空话。）
 *
 * `options.signal`：回合的中止信号（`agent/turn-stopping` 的 payload.signal）。用户中止回合时
 * 抽取立刻停下、不入队（官方 tools.md / core.md：异步工作要观察并转发 signal）；墙钟超时照旧保留。
 */
export async function extractFromTurn(ctx, agent, memoryDir, options = {}) {
  const signal = options.signal
  try {
    if (!options.manual && !CONFIG.enableExtraction) return { skipped: 'extraction disabled' }
    if (signal?.aborted) return { skipped: 'extraction aborted' }

    const llm = ctx.get('llm')
    if (!llm?.stream) return { skipped: 'llm unavailable' }

    const session = ctx.sessions.get(agent.id)
    if (!session) return { skipped: 'session unavailable' }

    const transcript = recentTranscript(session)
    if (transcript.trim().length < 200) return { skipped: 'transcript too short' }

    const route = session.requestContext?.()
    const provider = route?.provider
    const model = route?.model
    if (!provider || !model) return { skipped: 'no routed model' }

    // 抽取挂在 turn-stopping（serial，会被 await）上：模型卡住不返回，回合就收不了尾。
    // 所以流循环有墙钟上限，到点就 abort 并停止迭代，用已收到的部分继续。
    let text = ''
    const controller = new AbortController()
    const stream = llm.stream({
      provider,
      model,
      system: EXTRACTION_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: `对话记录：\n\n${transcript}` }] }],
      maxTokens: 1200,
      temperature: 0,
      signal: controller.signal,
    })
    const iterator = (stream[Symbol.asyncIterator] ?? stream[Symbol.iterator]).call(stream)
    const TIMED_OUT = Symbol('timed-out')
    const ABORTED = Symbol('aborted')
    let timer
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(TIMED_OUT)
      }, options.timeoutMs ?? EXTRACT_TIMEOUT_MS)
    })
    // 回合被中止：转发给模型流并停止迭代。监听在 finally 里摘掉，不留在长寿的 signal 上。
    let onAbort = () => {}
    const cancelled = new Promise((resolve) => {
      onAbort = () => {
        // 先定结果再中止流：流在中止时同步拒绝 next() 的话，race 也已经落在 ABORTED 上
        resolve(ABORTED)
        controller.abort()
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
    })
    let timedOut = false
    let aborted = false
    try {
      for (;;) {
        const step = await Promise.race([iterator.next(), deadline, cancelled])
        if (step === TIMED_OUT) {
          timedOut = true
          break
        }
        if (step === ABORTED) {
          aborted = true
          break
        }
        if (step.done) break
        if (step.value?.type === 'text-delta') text += step.value.text
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      // 不 await：卡住的生成器可能永远不回应 return()
      if (timedOut || aborted) Promise.resolve(iterator.return?.()).catch(() => {})
    }
    // 中止 = 用户不要这一轮了：不拿半截输出入队（超时则用已收到的部分，那是「模型慢」不是「用户不要」）
    if (aborted || signal?.aborted) return { skipped: 'extraction aborted' }

    const candidates = parseExtractionJson(text).slice(0, CONFIG.extractMaxPerTurn)
    if (candidates.length === 0) {
      return { skipped: timedOut ? 'extraction timed out' : 'nothing worth remembering', raw: text.slice(0, 200) }
    }

    // 去重：与「两个按需库的已确认记忆 + 尚未处置的 pending 条目」一起比。
    // 只比 confirmed 会漏掉一种情况——同一段对话连续两回合抽出同一条，
    // 会在队列里堆出一串一模一样的草稿。全局按需库也要比（第五轮，与 memory_remember 的查重一致）：
    // 跨项目的规则已经在全局库里时，不该再从每个项目各抽一份。
    const embedder = await resolveEmbedder()
    const reference = []
    const globalDir = options.globalDir ?? globalMemoryDirOf()
    for (const dir of sameDir(globalDir, memoryDir) ? [memoryDir] : [memoryDir, globalDir]) {
      // 向量只在内存里、召回时才对账；抽取时可能还没建过，先补齐（没有嵌入器时 rebuildVectors 什么都不做）
      if (embedder && !vectorsCurrent(loadVectors(dir), listMemories(dir))) await rebuildVectors(dir)
      for (const entry of loadVectors(dir)?.entries ?? []) reference.push(entry.vec)
    }
    if (embedder) {
      for (const draft of listPending(memoryDir)) {
        try {
          const vec = embedder.lv.embed(`${draft.meta.title ?? ''}\n${draft.body}`)
          if (vec) reference.push(vec)
        } catch {
          // 单条 pending 嵌入失败不影响去重
        }
      }
    }

    let queued = 0
    let deduped = 0
    let unverified = 0
    let routed = 0
    // 证据核对用**全会话**的用户消息，不是送给模型的那 6000 字尾部：
    // 用户的纠正可能在很早之前，尾部截断会把真话判成「没说过」。
    const userTexts = userTextsOf(session)

    for (const candidate of candidates) {
      // 「不是记忆」的三类（procedure / repo-rule / docs，§13.1）：抽取是离线的，没法向用户提议写进仓库，跳过并计数
      if (ROUTED_TYPES.includes(candidate.type)) {
        routed += 1
        continue
      }
      // 证据核对（与 memory_remember 同一套：找得到原话，且原话与这条记忆的文字沾边）。
      // 第六轮：核对不过**不再丢弃**——抽取本来就只进待确认，丢掉等于替人做了决定，而 evidenceRelates 会误判
      // 改述式的真实纠正。改为以「未核实」入队（evidenceVerified: false），面板据此不把它标成「用户原话」。
      // unverified 计数 = 以未核实身份入队的条数。
      const source = candidate.source === 'user' ? 'user' : 'agent'
      const evidenceVerified =
        source === 'user' &&
        verifyEvidence(userTexts, candidate.evidence).verified &&
        evidenceRelates(candidate.evidence, [candidate.title, candidate.description, candidate.body])
      const scope = candidate.scope === 'global' ? 'global' : 'project'
      // 「只在本项目成立却要每轮常驻」的归宿是项目 AGENTS.md，插件不写；抽取是离线的没法问，
      // 降成按需加载入队——面板只能收下或丢弃草稿、不能改它，但按需的去向影响面小，收下了也只多一行索引，比丢掉稳妥。
      // §15.1：user / feedback + global 的候选一律常驻（与 memory_remember 同一条规则，见 resolveLoad）
      const load = scope === 'global' ? resolveLoad({ type: candidate.type, scope, load: candidate.load === 'always' ? 'always' : 'on-demand' }).load : 'on-demand'

      let vec = null
      let similar = 0
      if (embedder) {
        try {
          vec = embedder.lv.embed(`${candidate.title}\n${candidate.body}`)
          if (vec) {
            for (const other of reference) {
              const score = dot(vec, other)
              if (score > similar) similar = score
            }
          }
        } catch {
          // 嵌入失败就不去重，宁可多一条也别丢
        }
      }

      if (similar >= CONFIG.dedupeThreshold) {
        deduped += 1
        continue
      }

      queuePending(memoryDir, {
        slug: typeof candidate.slug === 'string' ? candidate.slug : undefined,
        title: candidate.title.trim(),
        description: typeof candidate.description === 'string' ? candidate.description : undefined,
        scope,
        load,
        source,
        ...(source === 'user' && typeof candidate.evidence === 'string' ? { evidence: candidate.evidence } : {}),
        ...(source === 'user' ? { evidenceVerified } : {}),
        body: candidate.body,
        type: candidate.type,
        tags: Array.isArray(candidate.tags) ? candidate.tags.filter((t) => typeof t === 'string') : [],
      })
      // 入队后立刻进参考集，防止同一批里出现两条近似候选
      if (vec) reference.push(vec)
      queued += 1
      if (source === 'user' && !evidenceVerified) unverified += 1
    }

    return { queued, deduped, unverified, routed, candidates: candidates.length }
  } catch (error) {
    return { skipped: `extraction failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 判断一次 `memory_remember` 该直接入库还是进待确认。返回 `{ route: 'direct' | 'pending', reason? }`。
 *
 * 按**来源**分流，取代模型自评置信度（审计里它与后来是否被推翻毫无关系）：
 *
 * | source | 证据核对 | load      | 结果 |
 * |--------|----------|-----------|------|
 * | 任意   | —        | always    | pending, always-needs-user |
 * | user   | 通过     | on-demand | 直写 |
 * | user   | 未通过   | on-demand | pending, evidence-not-found |
 * | agent  | —        | on-demand | agentWrites=direct 直写，否则 pending, agent-review |
 *
 * 常驻一律进待确认（第五轮）：AGENTS.md 每轮注入所有项目，写错影响面最大；而证据核对只能证明「这几个字出自用户」，
 * 证明不了用户想把它变成处处常驻的规则。`agentWrites: 'direct'` 也不影响这一行。
 * `source` 缺失或非法按 agent 处理：说不清是谁说的，就当模型自己得出的。
 * 抽成纯函数是为了能用 Node 直接验证分流表。
 */
/**
 * §15.1：type 是 user / feedback、scope 是 global 的，按定义就是「用户在所有项目都成立的做事 / 表达要求」；
 * 用户决定这类一律进全局 AGENTS.md 常驻，所以由代码判定，不再交给模型选——目标模型评测里三次在回复里说
 * 「已记到全局偏好」，load 却留在 on-demand（或没给），条目进了按需库。memory_remember 与自动抽取共用这一条。
 */
export const ALWAYS_TYPES = ['user', 'feedback']

/**
 * 解析最终的加载方式。`scope` 是解析默认值之后的值；`load` 是调用方给的原值（空白 = 没给）。
 * 返回 `{ load, forced }`：forced = 调用方**显式**给了 on-demand 而被改成 always（没给时不算覆盖）。
 */
export function resolveLoad({ type, scope, load } = {}) {
  const given = isBlank(load) ? '' : load
  if (scope === 'global' && ALWAYS_TYPES.includes(type)) return { load: 'always', forced: given === 'on-demand' }
  return { load: given || 'on-demand', forced: false }
}

/** 覆盖了模型选的 on-demand 时，返回文本里加的那一句（§15.1）。 */
export const LOAD_FORCED_TEXT =
  'Handled with load "always", not "on-demand": a user or feedback memory with scope "global" is a standing requirement about how you work or communicate that holds in every project, so by rule it goes into the global AGENTS.md and waits for the user\'s confirmation.'

export function rememberRoute({ source, verified, load } = {}) {
  if (load === 'always') return { route: 'pending', reason: 'always-needs-user' }
  if (source === 'user') return verified === true ? { route: 'direct' } : { route: 'pending', reason: 'evidence-not-found' }
  return CONFIG.agentWrites === 'direct' ? { route: 'direct' } : { route: 'pending', reason: 'agent-review' }
}

/**
 * 进待确认时告诉模型「为什么」：每种原因一句。
 * `evidence-not-found` 一个原因码对应两句：没给证据 / 没核对到。「没核对到」故意不分「找不到原话」与「与这条记忆不沾边」，
 * 也不说怎样才算沾边（第六轮）：说了就是在教模型把用户的话抄进标题来绕过。
 */
const PENDING_REASON_TEXT = {
  'agent-review': 'this was worked out by the agent rather than stated by the user, so the human reviews it first.',
  'evidence-not-found':
    'source is "user", but the evidence could not be verified against the user\'s messages in this session, so the human reviews it first.',
  'evidence-missing': 'source is "user", but no evidence (the user\'s own words) was given, so the human reviews it first.',
  'always-needs-user':
    'load "always" puts it into every turn of every project, so the user confirms it in the memory panel before it is written.',
}

/**
 * `project + always` 的拒写文本：这类规则的归宿是项目自己的 AGENTS.md。
 * 只做 existsSync，不读文件内容；插件本身不写它（共享文件，且章节重排会弄乱手工编排）。
 *
 * `instructionsRoot` 是 instructionsRootFor(会话工作目录) 的结果——宿主只从「往上最近的 .git 目录」
 * 往下加载项目指令（官方 dsh-agent-instructions README：.git 标记项目根，AGENTS.local.md 是追加的本地层），
 * 指向已注册工作区的根会让模型写一个宿主根本不加载的文件。
 */
function projectAgentsText(instructionsRoot) {
  return (
    'NOT written: a rule that must hold on every turn of THIS project belongs in the project\'s own AGENTS.md, not in memory. ' +
    projectAgentsFacts(instructionsRoot) +
    'If this is really the user\'s personal preference rather than a project rule, call memory_remember again with scope: "global" ' +
    '(it holds in every project), or with load: "on-demand" (kept in this workspace\'s memory and recalled when relevant).'
  )
}

/** 存在吗：只做 existsSync，不读内容；探测抛错当作不存在。 */
const fileExists = (file) => {
  try {
    return Boolean(file) && existsSync(file)
  } catch {
    return false
  }
}

/**
 * 项目 AGENTS.md 在哪、存在与否、AGENTS.local.md、先征得同意——`project + always` 的拒写与 `type: "repo-rule"` 的改道共用。
 * 末尾带一个空格，方便接下一句。
 */
function projectAgentsFacts(instructionsRoot) {
  const file = instructionsRoot ? path.join(instructionsRoot, 'AGENTS.md') : ''
  return (
    (file
      ? `The project AGENTS.md is ${file} (${fileExists(file) ? 'it exists' : 'it does not exist yet'}); the host loads project instructions from that directory down to the working directory. `
      : 'The project root could not be determined. ') +
    'A project rule that holds only for this user goes in AGENTS.local.md in the same directory instead (the host loads it too; keep it out of version control). ' +
    'AGENTS.md is a shared, versioned file: tell the user what you want to add and why, and edit it with your file tools once they agree. '
  )
}

/**
 * 三种改道共用的最后一句。
 * 「unless they already asked」是为了不与前文「用户已明确要求就直接创建」打架——
 * 原来的写法是无条件的「ask whether to write it」，两句放在一起自相矛盾。
 */
export const ROUTED_TELL_TEXT =
  'Tell the user now where this belongs, and ask whether to write it unless they already asked for exactly that.'

/**
 * `type` 是 procedure / repo-rule / docs 时的回复（§13.2）：什么都不保存，告诉模型该写到哪、路径、格式、先向用户提议。
 * 返回 `{ written: false, reason: 'belongs-elsewhere', home, text }`，home 是 skill / agents / readme。
 *
 * skill 的位置与格式照官方 dsh-skill-filesystem README：项目级根 `<projectRoot>/.dsh/skills`（项目根以 `.git` 为标记，
 * 与 instructionsRootFor 同一个根）、用户级根 `<DSH 主目录>/skills`；每个 skill 是 `<name>/SKILL.md`，
 * frontmatter 必填 name（kebab-case，与目录名一致）与 description。路径都由现有的解析与显示函数拼出来，不写死。
 */
export function routedReply(type, instructionsRoot) {
  const root = typeof instructionsRoot === 'string' && instructionsRoot ? instructionsRoot : ''
  if (type === 'procedure') {
    const projectSkill = root
      ? path.join(root, '.dsh', 'skills', '<name>', 'SKILL.md')
      : '.dsh/skills/<name>/SKILL.md under the repository root (the root could not be determined)'
    return {
      written: false,
      reason: 'belongs-elsewhere',
      home: 'skill',
      text:
        'NOT saved: a repeatable multi-step procedure belongs in a skill, not in memory. ' +
        `A skill used only in this repository goes in ${projectSkill}; one for every project goes in ${dshHomeDisplay()}/skills/<name>/SKILL.md. ` +
        'Format: the file starts with YAML frontmatter that must have name (kebab-case, the same as the directory name) and description ' +
        '(one sentence saying when to use it); the body is the steps. ' +
        'A skill is a shared file: tell the user what you want to write and why, and create it with your file tools once they agree ' +
        '(at once if they already asked for exactly that). Do not also save it to memory. ' +
        ROUTED_TELL_TEXT,
    }
  }
  if (type === 'repo-rule') {
    return {
      written: false,
      reason: 'belongs-elsewhere',
      home: 'agents',
      text:
        'NOT saved: a rule everyone working on this repo must follow belongs in the project\'s AGENTS.md, not in memory. ' +
        projectAgentsFacts(root) +
        'If this is really just this user\'s personal preference rather than a rule for everyone, call memory_remember again with type: "feedback" or "user". ' +
        'Do not also save it to memory. ' +
        ROUTED_TELL_TEXT,
    }
  }
  // docs
  const readme = root ? path.join(root, 'README.md') : ''
  return {
    written: false,
    reason: 'belongs-elsewhere',
    home: 'readme',
    text:
      'NOT saved: what the project is, how to use it, or why it is built this way belongs in the repository\'s README or docs, not in memory. ' +
      (readme
        ? `The README is ${readme} (${fileExists(readme) ? 'it exists' : 'it does not exist yet'}); longer material can go in the repo's docs. `
        : 'The repository root could not be determined. ') +
      'The README is a shared, versioned file: tell the user what you want to add and why, and edit it with your file tools once they agree ' +
      '(at once if they already asked for exactly that). Do not also save it to memory. ' +
      ROUTED_TELL_TEXT,
  }
}

/* -------------------------------------------------- 搬到全局 AGENTS.md */

const agentsFilePath = () => CONFIG.agentsFile || path.join(dshHome(), 'AGENTS.md')

/** 章标题去掉开头的编号（`3. xxx` → `xxx`），用来跨编号比较标题。 */
const stripChapterNumber = (title) => String(title ?? '').replace(/^\d+\.\s*/, '').trim()

/** 文件的换行风格：CRLF 行多于 LF 行就写回 CRLF，别把用户的 CRLF 文件悄悄改成 LF。 */
const detectEol = (text) =>
  (text.match(/\r\n/g) ?? []).length > (text.match(/(?<!\r)\n/g) ?? []).length ? '\r\n' : '\n'

/** 读 AGENTS.md 概况（给界面显示用）。 */
export function agentsStatus() {
  const file = agentsFilePath()
  try {
    if (!existsSync(file)) return { path: file, exists: false, bytes: 0, sections: 0 }
    const text = readFileSync(file, 'utf8')
    return {
      path: file,
      exists: true,
      bytes: Buffer.byteLength(text, 'utf8'),
      sections: parseAgentsSections(text).blocks.length,
    }
  } catch {
    return { path: file, exists: false, bytes: 0, sections: 0 }
  }
}

/**
 * 算下一章的编号：已有 `## N.` 编号的最大值 + 1（写入时 renumberAgentsLines 会再统一重排）。
 *
 * AGENTS.md 的既有约定是 `## N. 标题` + `### N.M 子标题`（连续编号）。
 * 追加必须跟着编号，否则每写入一次就把文件的统一格式破坏一次。
 */
function nextChapterNumber(blocks) {
  const numbers = blocks.map((block) => /^(\d+)\./.exec(block.title)).filter(Boolean).map((match) => Number(match[1]))
  return numbers.length > 0 ? Math.max(...numbers) + 1 : 1
}

/**
 * 把记忆正文整理成适合放进全局 AGENTS.md 的一节。
 *
 * 直接拼接实测有三个问题：
 *   1. 正文自带的 `##` 与外层 `## 标题` **同级** → 外层标题被架空，文档大纲被冲散
 *   2. 迁移备注（`---` + 「迁移自 …」）被原样带进全局准则文件，是历史噪音
 *   3. 空行不规整（连续多行、文件尾部多空行）
 *
 * 所以：正文标题整体下沉到 `###` 及以下，剥掉尾部出身说明，压平多余空行。
 * `sectionNumber` 用来给子标题排 `N.M` 编号，保持与文件既有格式一致。
 *
 * 围栏代码块（``` / ~~~）里的行一律原样保留：代码里的 `# 注释` 不是标题，
 * 不能被下沉、编号，里面的空行也不能被压。
 *
 * `forSave`：保存**已有**章节（面板编辑 / 按章号更新）。此时正文多半已经是规范格式，
 * 整体再下沉一级会让每次保存都把 `###` 压成 `####`，所以只把 `#` / `##` 压到 `###`
 * （保证正文里不会冒出新的章或文档标题），其余标题原样保留；不剥「出身说明」，也不编号。
 */
function formatAgentsBody(body, sectionNumber, { forSave = false } = {}) {
  let lines = String(body ?? '').replace(/\r\n?/g, '\n').trim().split('\n')

  // 尾部「--- + 迁移/来源说明」属于条目自己的出身，不该混进全局准则
  if (!forSave) {
    const fenced = fenceMask(lines)
    let marker = -1
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!fenced[i] && /^-{3,}\s*$/.test(lines[i])) {
        marker = i
        break
      }
    }
    if (marker >= 0 && /(迁移自|来源[:：]|origin\s*[:：])/i.test(lines.slice(marker).join('\n'))) {
      lines = lines.slice(0, marker)
    }
  }

  // 标题整体下沉：`#`→`###`、`##`→`###`、`###`→`####`，永远落在外层 `##` 之下；
  // 三级标题按出现顺序编号为 N.1 / N.2 …（与文件既有约定一致）
  const fenced = fenceMask(lines)
  let index = 0
  lines = lines.map((line, i) => {
    if (fenced[i]) return line
    const heading = /^(#{1,6})(\s+)(.*)$/.exec(line)
    if (!heading) return line
    const level = forSave ? Math.max(3, heading[1].length) : Math.min(6, Math.max(3, heading[1].length + 1))
    if (!forSave && sectionNumber && level === 3 && heading[3] !== '') {
      index += 1
      return `### ${sectionNumber}.${index} ${heading[3]}`
    }
    return `${'#'.repeat(level)}${heading[2]}${heading[3]}`
  })

  const out = []
  lines.forEach((line, i) => {
    if (!fenced[i] && line === '' && out[out.length - 1] === '') return
    out.push(line)
  })
  return out.join('\n').trim()
}

/**
 * 把一条记忆搬进全局 AGENTS.md：追加一节 `## 标题` + 正文，然后从项目库删除。
 *
 * 这是插件里**唯一**会写用户手写文件的地方（连同下面的章节读写），所以保护都走
 * appendAgentsSection：
 *   1. 标题已存在（不论带不带编号）就拒绝，绝不重复追加
 *   2. 只追加，不改写已有章节
 *   3. 字节预算 maxAgentsBytes 与写前留档同样适用
 *   4. 删记忆走 deleteMemory，历史里留一份，可回退
 *   5. 只有跨项目的记忆才允许搬（避免把项目内知识污染成全局规则）：
 *      全局按需库里的条目（`options.scope === 'global'`）本身就是跨项目的；
 *      项目库里的条目只有 frontmatter 写着 `scope: global` 的旧条目可以搬（旧版「该挪去全局」的提示）。
 *      「只在本项目成立却要常驻」的归宿是项目自己的 AGENTS.md，不是这个全局文件。
 */
export function promoteToAgents(memoryDir, id, options = {}) {
  const item = readMemory(memoryDir, id)
  if (!item) return { ok: false, reason: 'not-found', id }

  if (options.scope !== 'global' && item.meta.scope !== 'global') {
    return { ok: false, reason: 'scope-not-global', title: item.meta.title ?? id }
  }

  const file = agentsFilePath()
  if (!existsSync(file)) return { ok: false, reason: 'agents-missing', agentsPath: file }

  const title = String(item.meta.title ?? id).trim()
  if (!title) return { ok: false, reason: 'empty-title', id }
  if (!item.body) return { ok: false, reason: 'empty-body', title, agentsPath: file }

  let before
  try {
    before = Buffer.byteLength(readFileSync(file, 'utf8'), 'utf8')
  } catch (error) {
    return { ok: false, reason: 'read-failed', agentsPath: file, error: String(error?.message ?? error) }
  }

  // 来源注释：promote 后记忆从项目库删除，这里留一条不可见线索（HTML 注释渲染时看不到），
  // 便于日后追溯这一节来自哪条记忆。日期只取到天，避免同一内容反复写入产生差异。
  const stamp = new Date().toISOString().slice(0, 10)
  let added
  try {
    added = appendAgentsSection({ title, body: item.body, note: `来自记忆 ${id}，写入于 ${stamp}` })
  } catch (error) {
    return { ok: false, reason: 'write-failed', agentsPath: file, error: String(error?.message ?? error) }
  }
  if (!added.ok) {
    return {
      ok: false,
      reason: added.reason,
      title,
      agentsPath: file,
      ...(added.reason === 'agents-full' ? { bytes: added.bytes, limit: added.limit, current: added.current } : {}),
    }
  }

  // 搬走后从项目库删除；deleteMemory 会先留历史。AGENTS.md 已经写成功，删不掉不该报整体失败。
  let memoryRemoved = false
  try {
    memoryRemoved = deleteMemory(memoryDir, id)
  } catch {
    // 记忆还在项目库里：重复但不丢
  }
  return {
    ok: true,
    title,
    agentsPath: file,
    addedBytes: added.bytes - before,
    totalBytes: added.bytes,
    memoryRemoved,
  }
}

/* ------------------------------------------- 全局 AGENTS.md 的章节读写 */

/**
 * 把 AGENTS.md 切成「章」（`##` 级），其下的 `###` 归入该章正文。
 *
 * 两条刻意的规则：
 *   · `#` 一级标题是**文档标题**，连同它下面的说明一起算「前言」，不参与编辑；
 *   · 只有 `##` 成章，`###` 属于所在章的正文——编辑一章就是编辑这块整体，
 *     不会出现「删了大标题、子标题成了孤儿」。
 *
 * 返回的 `preamble` 是第一个 `##` 之前的内容，写回时必须原样保留。
 */
export function parseAgentsSections(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const fenced = fenceMask(lines)
  const blocks = []
  let preambleEnd = lines.length

  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue // 围栏代码里的 `## ` 是代码，不是章
    const matched = /^(#{1,6})\s+(.+)$/.exec(lines[i])
    if (!matched) continue
    if (matched[1].length !== 2) continue // `#` 标题与 `###` 以下都不单独成块
    if (preambleEnd === lines.length) preambleEnd = i
    blocks.push({ level: 2, title: matched[2].trim(), start: i, end: lines.length })
  }

  for (let i = 0; i < blocks.length; i += 1) {
    if (i + 1 < blocks.length) blocks[i].end = blocks[i + 1].start
  }

  return { lines, preamble: lines.slice(0, preambleEnd), blocks }
}

/**
 * 重排编号，让文件保持 `## N.` + `### N.M` 的连续约定。
 *
 * 删除或新增一章后必须调用，否则编号会出现断号，跟你要求的统一格式不符。
 * 只重写标题行，正文一个字不动；围栏代码块里的行完全跳过。
 * 只认既有的编号前缀（`## N.` 与 `### N.M`）：`### 5 Whys`、`### 2024 roadmap`
 * 的开头数字是标题内容，不是编号。
 */
export function renumberAgentsLines(lines) {
  const fenced = fenceMask(lines)
  let chapter = 0
  let section = 0
  return lines.map((line, i) => {
    if (fenced[i]) return line
    const heading2 = /^##\s+\d+\.\s+(.*)$/.exec(line)
    if (heading2) {
      chapter += 1
      section = 0
      return `## ${chapter}. ${heading2[1]}`
    }
    const heading3 = /^###\s+\d+\.\d+\s+(.*)$/.exec(line)
    if (heading3) {
      section += 1
      return `### ${chapter}.${section} ${heading3[1]}`
    }
    return line
  })
}

/**
 * 留档目录：按「被写的那个文件」分开。
 *
 * 真实 `~/.dsh/AGENTS.md` 写进全局历史目录；**其它路径**（测试的临时文件）写进
 * 它自己旁边的 `.agents-history/`。否则测试会把临时内容塞进真实历史，
 * 而历史只保留最近 20 份——真正的可回退版本会被测试产物挤掉。
 */
const agentsHistoryDir = (file) => {
  const home = dshHome()
  const realFile = path.join(home, 'AGENTS.md')
  return path.resolve(String(file)) === path.resolve(realFile)
    ? path.join(home, '.dsh-workspace-memory-history', 'agents')
    : path.join(path.dirname(String(file)), '.agents-history')
}

/** 写 AGENTS.md 之前留一份历史（保留最近 20 份），误删可回退。 */
function backupAgentsFile(file, text) {
  try {
    const dir = agentsHistoryDir(file)
    ensureDir(dir)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(path.join(dir, `${stamp}.md`), text, 'utf8')
    const kept = readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
    for (const stale of kept.slice(0, Math.max(0, kept.length - 20))) {
      rmSync(path.join(dir, stale), { force: true })
    }
  } catch {
    // 留档失败不阻断用户操作
  }
}

/** 读全局 AGENTS.md 的结构（给界面的「全局」页签用）。 */
export function readAgentsDocument() {
  const file = agentsFilePath()
  if (!existsSync(file)) return { ok: false, reason: 'agents-missing', path: file }

  const text = readFileSync(file, 'utf8')
  const parsed = parseAgentsSections(text)
  const sections = parsed.blocks.map((block, index) => {
    const body = parsed.lines.slice(block.start + 1, block.end).join('\n').trim()
    return {
      index,
      level: block.level,
      title: block.title,
      body,
      bytes: Buffer.byteLength(parsed.lines.slice(block.start, block.end).join('\n'), 'utf8'),
    }
  })

  return {
    ok: true,
    path: file,
    bytes: Buffer.byteLength(text, 'utf8'),
    preamble: parsed.preamble.join('\n').trim(),
    sections,
  }
}

/**
 * 整理一章（新写入或改过的）的行：`##` / `###` 标题前补空行，连续空行压成一行。
 * 围栏代码块里的内容原样保留——里面的空行和 `## ` 都是代码的一部分。
 */
function tidyChapterLines(lines) {
  const fenced = fenceMask(lines)
  const out = []
  lines.forEach((line, i) => {
    if (!fenced[i]) {
      if (line === '' && out[out.length - 1] === '') return
      if (/^#{2,3}\s/.test(line) && out.length > 0 && out[out.length - 1].trim() !== '') out.push('')
    }
    out.push(line)
  })
  return out
}

/**
 * 用新的块数组写回文件（重排编号后原子落盘，写前留档）。
 *
 * 只有 `touched` 的块（改过 / 新增）会被整理空行；没碰过的章逐字保留。
 * 换行风格沿用原文件（CRLF 仍是 CRLF）。
 */
function writeAgentsDocument(file, original, parsed, blocks) {
  const lines = [...parsed.preamble]
  for (const block of blocks) {
    // 章与章之间必须有空行：改过的块不含分隔空行，直接拼接会把上一章最后一行
    // 和 `## 下一章` 粘在一起（Markdown 里标题会失效）。
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('')
    lines.push(...(block.touched ? tidyChapterLines(block.lines) : block.lines))
  }

  const eol = detectEol(original)
  const finalText = `${renumberAgentsLines(lines).join(eol).trimEnd()}${eol}`
  const size = Buffer.byteLength(finalText, 'utf8')
  const current = Buffer.byteLength(original, 'utf8')

  // 字节预算：AGENTS.md 每轮注入，不是免费存储。超了就不写，让调用方先合并或删。
  // 但文件本来就超限时，缩小的写入（删一章、改短一章）必须放行——
  // 否则「先删再合并」这条出路本身被预算堵死，只能一次删到线下。
  const limit = CONFIG.maxAgentsBytes
  if (limit > 0 && size > limit && size > current) {
    return { ok: false, reason: 'agents-full', bytes: size, limit, current }
  }

  backupAgentsFile(file, original)
  writeFileAtomic(file, finalText)
  return { ok: true, bytes: size }
}

/** 当前所有块（作为可编辑的行数组）。 */
function agentsBlocks(parsed) {
  return parsed.blocks.map((block) => ({
    ...block,
    lines: parsed.lines.slice(block.start, block.end),
  }))
}

/**
 * 按序号取目标章并校验。章序号是「读文件时的位置」，面板里的序号可能已经过期
 * （另一处刚增删过章）——传了 `expectedTitle` 就核对标题，对不上返回 section-moved，
 * 而不是静默改写/删掉另一章。
 */
function pickAgentsBlock(blocks, index, expectedTitle) {
  if (!Number.isInteger(index) || index < 0) return { error: { ok: false, reason: 'invalid-index' } }
  const target = blocks[index]
  if (!target) return { error: { ok: false, reason: 'section-not-found', index } }
  if (typeof expectedTitle === 'string' && stripChapterNumber(expectedTitle) !== stripChapterNumber(target.title)) {
    return { error: { ok: false, reason: 'section-moved', index, actualTitle: stripChapterNumber(target.title) } }
  }
  return { target }
}

/**
 * 保存某一章：标题 + 正文整体替换，其余章节逐字保留。
 * `input.expectedTitle`：面板打开这一章时看到的标题，用来发现序号已过期（见 pickAgentsBlock）。
 */
export function saveAgentsSection(index, input) {
  const file = agentsFilePath()
  if (!existsSync(file)) return { ok: false, reason: 'agents-missing', path: file }

  const original = readFileSync(file, 'utf8')
  const parsed = parseAgentsSections(original)
  const blocks = agentsBlocks(parsed)
  const picked = pickAgentsBlock(blocks, index, input?.expectedTitle)
  if (picked.error) return picked.error
  const target = picked.target

  // 标题里可能带着旧编号（`## 3. xxx`）；剥掉，交给 renumberAgentsLines 统一分配，
  // 否则保存后这一章会因为「不匹配 ^## N.」而丢掉编号。
  const bareTitle = oneLine(input?.title).replace(/^\d+(?:\.\d+)?\.\s*/, '')
  if (!bareTitle) return { ok: false, reason: 'empty-title' }

  const hashes = '#'.repeat(target.level)
  // 正文里的 `#` / `##` 压到 `###`：它们不能在保存后变成新的章
  const body = formatAgentsBody(input?.body, 0, { forSave: true })
  target.lines = [`${hashes} 0. ${bareTitle}`, '', ...(body ? body.split('\n') : [])]
  target.touched = true

  const written = writeAgentsDocument(file, original, parsed, blocks)
  if (!written.ok) return written
  return { ok: true, path: file, bytes: written.bytes, index }
}

/**
 * 删除某一章（连同它下面的子标题）。
 * `options.expectedTitle`：同 saveAgentsSection，序号过期就拒绝，不删错章。
 */
export function deleteAgentsSection(index, options) {
  const file = agentsFilePath()
  if (!existsSync(file)) return { ok: false, reason: 'agents-missing', path: file }

  const original = readFileSync(file, 'utf8')
  const parsed = parseAgentsSections(original)
  const blocks = agentsBlocks(parsed)
  const picked = pickAgentsBlock(blocks, index, options?.expectedTitle)
  if (picked.error) return picked.error
  const target = picked.target
  if (target.level !== 2) return { ok: false, reason: 'only-chapter', index }

  blocks.splice(index, 1)
  const written = writeAgentsDocument(file, original, parsed, blocks)
  if (!written.ok) return written
  return { ok: true, path: file, bytes: written.bytes, removed: target.title }
}

/**
 * 追加一章：编号自动顺延，正文按 promote 的规则下沉标题。
 * `input.note`：写在章末的 HTML 注释（渲染时不可见），promote 用它记录「来自哪条记忆」。
 */
export function appendAgentsSection(input) {
  const file = agentsFilePath()
  if (!existsSync(file)) return { ok: false, reason: 'agents-missing', path: file }

  const title = oneLine(input?.title)
  // 标题若自带旧编号，剥掉后由 renumberAgentsLines 统一分配
  const bareTitle = title.replace(/^\d+(?:\.\d+)?\.\s*/, '')
  if (!bareTitle) return { ok: false, reason: 'empty-title' }

  const original = readFileSync(file, 'utf8')
  const parsed = parseAgentsSections(original)

  // 同名章（不论带不带编号）已存在就拒绝；按解析出的章标题比，围栏代码里的 `## ` 不算
  if (parsed.blocks.some((block) => stripChapterNumber(block.title) === bareTitle)) {
    return { ok: false, reason: 'already-present', title: bareTitle }
  }

  const sectionNumber = nextChapterNumber(parsed.blocks)
  const body = formatAgentsBody(input?.body, sectionNumber)
  // 允许「先建空章再编辑」：空正文不算错误
  const hasBody = String(input?.body ?? '').trim() !== ''
  if (hasBody && !body) return { ok: false, reason: 'empty-body' }

  const blocks = agentsBlocks(parsed)
  blocks.push({
    level: 2,
    title: bareTitle,
    touched: true,
    lines: [
      `## ${sectionNumber}. ${bareTitle}`,
      '',
      ...(body ? body.split('\n') : []),
      ...(input?.note ? ['', `<!-- ${oneLine(input.note)} -->`] : []),
    ],
  })
  const written = writeAgentsDocument(file, original, parsed, blocks)
  if (!written.ok) return written
  return { ok: true, path: file, bytes: written.bytes, title }
}

/**
 * 把一条「全局」记忆写进 AGENTS.md。
 *
 * 协议是刻意做成「不给确认就不写」的。原因：语义重复没法靠字面相似度自动判断——
 * 实测同一主题换四种说法，与现有章节的相似度落在 0.23~0.90，而不相关的也有 0.35，
 * 区间重叠，任何阈值都会两边出错。所以机械层不做判断，只负责**逼出判断**：
 *
 *   1. 给了 `chapter`  → 更新那一章（调用方自己合并新旧内容）
 *   2. 标题精确同名    → 更新（不算新主题）
 *   3. `newChapter: true` → 显式声明「这是新主题」，追加
 *   4. 都不满足        → **拒写**，把现有章标题清单回给调用方，让它自己比一遍
 */
export function upsertAgentsChapter(input) {
  const title = String(input?.title ?? '').trim()
  if (!title) return { ok: false, reason: 'empty-title' }
  const bareTitle = title.replace(/^\d+(?:\.\d+)?\.\s*/, '')

  const doc = readAgentsDocument()
  if (!doc.ok) return doc

  // 1) 指定章号：按序号更新（序号即界面上看到的 N）
  if (Number.isInteger(input.chapter)) {
    const index = input.chapter - 1
    const target = doc.sections[index]
    if (!target) return { ok: false, reason: 'chapter-not-found', chapter: input.chapter, total: doc.sections.length }
    const result = saveAgentsSection(index, { title: bareTitle, body: input.body })
    return { ...result, action: 'updated', chapter: input.chapter }
  }

  // 2) 精确同名：更新，不追加
  const hit = doc.sections.find((section) => stripChapterNumber(section.title) === bareTitle)
  if (hit) {
    const result = saveAgentsSection(hit.index, { title: bareTitle, body: input.body })
    return { ...result, action: 'updated', chapter: hit.index + 1, title: bareTitle }
  }

  // 3) 调用方显式声明这是新主题
  if (input.newChapter === true) {
    const result = appendAgentsSection({ title: bareTitle, body: input.body })
    return { ...result, action: 'added', title: bareTitle }
  }

  // 4) 没确认 → 不写，回清单
  return {
    ok: false,
    reason: 'needs-confirmation',
    chapters: doc.sections.map((section) => section.title),
  }
}

/**
 * upsertAgentsChapter 的「只判断不写」版本（第五轮）：常驻写入一律进待确认，章节协议在入队前校验。
 * 返回 `{ ok: true, action: 'updated', chapter, chapterTitle }` / `{ ok: true, action: 'added' }`，
 * 或与 upsertAgentsChapter 相同的失败（empty-title / agents-missing / chapter-not-found / needs-confirmation）。
 * chapterTitle 是那一章**当时**的标题（去掉编号）：草稿存下它，收下时核对编号有没有漂移。
 * 字节预算不在这里判：收下时文件可能已经变了，以收下那一刻的 writeAgentsDocument 为准。
 */
export function planAgentsChapter(input) {
  const title = String(input?.title ?? '').trim()
  if (!title) return { ok: false, reason: 'empty-title' }
  const bareTitle = title.replace(/^\d+(?:\.\d+)?\.\s*/, '')

  const doc = readAgentsDocument()
  if (!doc.ok) return doc

  if (Number.isInteger(input.chapter)) {
    const target = doc.sections[input.chapter - 1]
    if (!target) return { ok: false, reason: 'chapter-not-found', chapter: input.chapter, total: doc.sections.length }
    return { ok: true, action: 'updated', chapter: input.chapter, chapterTitle: stripChapterNumber(target.title) }
  }
  const hit = doc.sections.find((section) => stripChapterNumber(section.title) === bareTitle)
  if (hit) return { ok: true, action: 'updated', chapter: hit.index + 1, chapterTitle: stripChapterNumber(hit.title) }
  if (input.newChapter === true) return { ok: true, action: 'added' }
  return { ok: false, reason: 'needs-confirmation', chapters: doc.sections.map((section) => section.title) }
}

/** 从 Windows App Paths 注册表取一个可执行文件的真实路径（Typora/VS Code 常装在非默认盘）。 */
function appPathFromRegistry(exeName) {
  if (process.platform !== 'win32') return null
  for (const root of ['HKLM', 'HKCU']) {
    try {
      const key = `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`
      // stderr 必须丢掉：键不存在时 reg 会往（继承来的）宿主 stderr 打一行本地化的错误文本
      const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      const matched = /REG_SZ\s+(.+?)\s*$/m.exec(out)
      const candidate = matched?.[1]?.trim()
      if (candidate && existsSync(candidate)) return candidate
    } catch {
      // 这个键不存在，继续下一个
    }
  }
  return null
}

/** 在一组候选路径里找第一个存在的。 */
function firstExisting(paths) {
  for (const candidate of paths.filter(Boolean)) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 探测本机可用的编辑器，供界面让你选。
 *
 * 探测顺序：配置里显式指定的 > Windows App Paths 注册表 > 常见安装路径。
 * 永远至少返回「系统默认」一项，保证入口不会失效。
 */
function probeEditors() {
  const found = []

  if (CONFIG.editorExe && existsSync(CONFIG.editorExe)) {
    found.push({ id: 'config', name: path.basename(CONFIG.editorExe, '.exe'), exe: CONFIG.editorExe })
  }

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA

    const typora =
      appPathFromRegistry('Typora.exe') ??
      firstExisting([
        local ? path.join(local, 'Programs', 'Typora', 'Typora.exe') : '',
        'C:\\Program Files\\Typora\\Typora.exe',
        'D:\\Program Files\\Typora\\Typora.exe',
      ])
    if (typora) found.push({ id: 'typora', name: 'Typora', exe: typora })

    // VS Code 的 Code.exe 只是 Electron 启动器：实测直接 `spawn(Code.exe, [file])`
    // 打不开文件（进程带不上参数），必须走同目录的 bin\code.cmd 这个 CLI 转发。
    //
    // 注意不能只按 LOCALAPPDATA 猜目录：本机 LOCALAPPDATA 在 C:，而 VS Code 装在 D:，
    // 猜路径全部落空。所以先尽力解析出 Code.exe（注册表优先），再找它**同级**的 CLI。
    const withSiblingCli = (exe, ...relative) => {
      const cli = path.join(path.dirname(exe), ...relative)
      return existsSync(cli) ? { exe: cli, viaShell: true } : { exe, viaShell: false }
    }

    const vscodeExe =
      appPathFromRegistry('Code.exe') ??
      firstExisting([
        local ? path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe') : '',
        'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      ])
    if (vscodeExe) {
      const resolved = withSiblingCli(vscodeExe, 'bin', 'code.cmd')
      found.push({ id: 'vscode', name: 'VS Code', ...resolved })
    }

    // Cursor 同理：优先它的 CLI（resources\app\bin\cursor.cmd）
    const cursorExe =
      appPathFromRegistry('Cursor.exe') ??
      firstExisting([local ? path.join(local, 'Programs', 'cursor', 'Cursor.exe') : ''])
    if (cursorExe) {
      const resolved = withSiblingCli(cursorExe, 'resources', 'app', 'bin', 'cursor.cmd')
      found.push({ id: 'cursor', name: 'Cursor', ...resolved })
    }
  }

  found.push({ id: 'system', name: '系统默认', exe: '' })
  return found
}

/**
 * 探测结果在进程生命周期内记一次：探测要同步起 `reg` 子进程（每次几十毫秒，最坏每个 3 秒），
 * 而 GET /agents 每次面板刷新都会调它，不能每次都堵宿主的事件循环。
 * 以 editorExe 配置为键——改了配置会重新探测；装了新编辑器要重载插件（或调 resetEditorCache）。
 */
let editorCache = null

export function detectEditors() {
  if (!editorCache || editorCache.key !== CONFIG.editorExe) {
    editorCache = { key: CONFIG.editorExe, list: probeEditors() }
  }
  return editorCache.list.map((entry) => ({ ...entry }))
}

/** 清掉 detectEditors 的缓存（测试用）。 */
export function resetEditorCache() {
  editorCache = null
}

const realSpawn = (command, args, options) => spawn(command, args, options)
let spawnImpl = realSpawn

/**
 * 测试用：替换真正的进程启动，返回还原函数。
 *
 * 测试绝不能真的启动编辑器或 `cmd /c start`——在 Windows 上那会在用户桌面上弹出窗口
 * （2026-11-11 一个测试用 `start AGENTS.bat` 验证命令行，每跑一次就留下一个终端窗口）。
 */
export function setSpawnForTests(fn) {
  const previous = spawnImpl
  spawnImpl = typeof fn === 'function' ? fn : realSpawn
  return () => {
    spawnImpl = previous
  }
}

/**
 * 启动一个不等待的子进程。
 *
 * 必须挂 'error' 监听：ENOENT / EACCES 之类是**异步**抛的，没人监听就是未捕获异常，
 * 而 try/catch 只接得住同步抛出——会把宿主进程带崩。
 */
function launchDetached(command, args, options = {}) {
  const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', ...options })
  child.on('error', (error) => console.error(`[workspace-memory] 打开 AGENTS.md 失败：${error.message}`))
  child.unref()
}

/**
 * 打开全局 AGENTS.md。
 *
 * editorId 为空时用配置的 editorExe；都不可用则退回系统默认程序。
 * 启动后立刻 unref，不等它退出——编辑器是长驻进程。
 */
export function openAgentsFile(editorId) {
  const file = agentsFilePath()
  if (!existsSync(file)) return { ok: false, reason: 'agents-missing', agentsPath: file }

  const editors = detectEditors()
  const wanted =
    (editorId ? editors.find((entry) => entry.id === editorId) : null) ??
    (CONFIG.editorExe ? editors.find((entry) => entry.id === 'config') : null) ??
    editors.find((entry) => entry.id !== 'system') ??
    editors.find((entry) => entry.id === 'system')

  try {
    if (wanted && wanted.exe) {
      if (wanted.viaShell) {
        // .cmd 转发器必须经 shell 启动，否则 spawn 会 ENOENT 或参数丢失
        launchDetached(`"${wanted.exe}" "${file}"`, [], { shell: true })
      } else {
        launchDetached(wanted.exe, [file])
      }
      return { ok: true, agentsPath: file, app: wanted.name, editorId: wanted.id }
    }
    if (process.platform === 'win32') {
      // 参数不要自己加引号：Node 会按需加并把内嵌引号转义成 \"，cmd 读不懂，start 就打不开文件
      launchDetached('cmd', ['/c', 'start', '', file])
      return { ok: true, agentsPath: file, app: 'system-default', editorId: 'system' }
    }
    launchDetached('xdg-open', [file])
    return { ok: true, agentsPath: file, app: 'system-default', editorId: 'system' }
  } catch (error) {
    return { ok: false, reason: 'launch-failed', agentsPath: file, error: String(error?.message ?? error) }
  }
}

/* -------------------------------------------------------- 格式闸门与编辑器接口 */

/*
 * 栏位长度上限现在来自 DEFAULT_CONFIG（maxTitleChars / maxBodyChars / maxTags /
 * maxTagChars），可在插件行的 config 里覆盖。这些数字是「格式把关」的实体：
 * 它们保证 MEMORY.md 索引不会因为某条记忆标题过长而挤爆注入预算，
 * 也保证正文不会被误粘成一整篇文档。
 */

/**
 * 手写文件里的数字字段可能是任何东西；NaN / Infinity 进了工具输出就不是 lossless JSON，宿主会整条拒掉。
 * -0 也一样：官方校验器（dsh-tools json-schema.ts 的 isJsonNumber）只收「有限且不是 -0」的数字，
 * 手改成 `hits: -0` 的文件会让库满候选整条输出判错。所以 -0 归一成 0。
 */
const finiteNumber = (value, fallback = 0) => {
  const number = Number(value ?? fallback)
  if (!Number.isFinite(number)) return fallback
  return number === 0 ? 0 : number
}

/** 单行字段（标题、摘要、标签、路径）里不允许出现的行分隔符。 */
const LINE_BREAK = /[\r\n\u{2028}\u{2029}]/u

/**
 * asciiSlug 的无兜底版：清洗后什么都不剩就返回空串，由调用方决定怎么办。
 * asciiSlug 在这种情况下会编一个 `memory-<时间戳>`，用来「校验」会让非法输入永远通过。
 */
const cleanSlug = (input) =>
  String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')

/**
 * 校验 UI 提交的编辑，并归一化成可落盘的值。
 *
 * 这是插件里唯一允许产生记忆文件的入口之一，所以规则必须集中在一处：
 *   · 未知字段直接忽略，不进文件
 *   · 任何一条不合法就整体拒绝，并逐条给出「字段: 原因」，前端原样展示
 *   · 归一化（去空白、去重、去空项）在通过校验后进行，保证落盘形态唯一
 *
 * 落盘永远走 serializeFrontmatter，所以文件格式不会因为 UI 编辑而漂移——
 * 手改文件会破坏格式，UI 改不会。
 */
export function validateMemoryPatch(input) {
  const errors = []
  const value = {}

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['payload 必须是一个对象'], value }
  }

  if (input.title !== undefined) {
    if (typeof input.title !== 'string') {
      errors.push('title: 必须是字符串')
    } else {
      const title = input.title.trim()
      if (title.length === 0) errors.push('title: 不能为空')
      else if (LINE_BREAK.test(title)) errors.push('title: 不能包含换行（它是单行字段）')
      else if (title.length > CONFIG.maxTitleChars) errors.push(`title: 不能超过 ${CONFIG.maxTitleChars} 字符（当前 ${title.length}）`)
      else value.title = title
    }
  }

  // 文件名必须是英文 slug：索引行要求「英文在前、中文说明在后」。
  // 含非 ASCII 字符一律拒绝——asciiSlug 会把它们悄悄丢掉（甚至整个换成 memory-<时间戳>），
  // 用户以为改成了自己输入的名字，实际文件名面目全非。
  if (input.slug !== undefined) {
    if (typeof input.slug !== 'string') {
      errors.push('slug: 必须是字符串')
    } else {
      const normalized = cleanSlug(input.slug)
      if (/[^\x00-\x7f]/.test(input.slug) || normalized.length < 2) {
        errors.push('slug: 只能包含小写英文字母、数字与连字符')
      } else {
        value.slug = normalized
      }
    }
  }

  // description 就是 MEMORY.md 里那一行的摘要，所以同样要过闸门
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      errors.push('description: 必须是字符串')
    } else {
      const description = input.description.trim()
      if (LINE_BREAK.test(description)) {
        errors.push('description: 不能包含换行——它就是索引里的那一行')
      } else if (description.length > MAX_DESCRIPTION_CHARS) {
        errors.push(`description: 不能超过 ${MAX_DESCRIPTION_CHARS} 字符（当前 ${description.length}）——它就是索引里的那一行`)
      } else {
        value.description = description
      }
    }
  }

  if (input.body !== undefined) {
    if (typeof input.body !== 'string') {
      errors.push('body: 必须是字符串')
    } else {
      const body = input.body.trim()
      if (body.length === 0) errors.push('body: 不能为空')
      else if (body.length > CONFIG.maxBodyChars) errors.push(`body: 不能超过 ${CONFIG.maxBodyChars} 字符（当前 ${body.length}）`)
      else value.body = body
    }
  }

  if (input.type !== undefined) {
    if (typeof input.type !== 'string') errors.push('type: 必须是字符串')
    else if (!MEMORY_TYPES.includes(input.type)) errors.push(`type: 只能是 ${MEMORY_TYPES.join(' / ')}`)
    else value.type = input.type
  }

  // scope 现在决定条目所在的库（项目库 / 全局按需库）。这里只校验取值；
  // 真正的「换库」由 save 路由在值变化时调 moveMemory 完成，不经 writeMemory 改字段。
  if (input.scope !== undefined) {
    if (input.scope !== 'global' && input.scope !== 'project') errors.push('scope: 只能是 global 或 project')
    else value.scope = input.scope
  }

  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      errors.push('tags: 必须是数组')
    } else if (input.tags.some((tag) => typeof tag !== 'string')) {
      errors.push('tags: 每一项都必须是字符串')
    } else {
      const tags = []
      for (const raw of input.tags) {
        const tag = raw.trim()
        if (!tag) continue
        if (LINE_BREAK.test(tag)) {
          errors.push('tags: 标签不能包含换行')
          break
        }
        if (tag.length > CONFIG.maxTagChars) {
          errors.push(`tags: 单个标签不能超过 ${CONFIG.maxTagChars} 字符（"${tag.slice(0, 20)}…"）`)
          break
        }
        if (!tags.includes(tag)) tags.push(tag)
      }
      if (errors.length === 0) {
        if (tags.length > CONFIG.maxTags) errors.push(`tags: 最多 ${CONFIG.maxTags} 个（当前 ${tags.length}）`)
        else if (tags.some((tag) => tag.includes(',') || tag.includes(']'))) {
          errors.push('tags: 不能包含英文逗号或右方括号（会破坏 frontmatter 的内联数组语法）')
        } else value.tags = tags
      }
    }
  }

  // 注意：`confidence` 故意不在这里接受。
  // 它是**模型自评**，不是用户判断——用户想表达"这条对/错"应该直接改正文或标签，
  // 而不是改一个概率数字。模型写入走 memory_remember / 抽取路径，不经过这个校验函数。
  if (input.confidence !== undefined) {
    errors.push('confidence: 只读字段（模型自评），不能通过编辑接口修改')
  }

  if (input.paths !== undefined) {
    if (!Array.isArray(input.paths) || input.paths.some((p) => typeof p !== 'string')) {
      errors.push('paths: 必须是字符串数组')
    } else if (input.paths.some((p) => LINE_BREAK.test(p.trim()))) {
      errors.push('paths: 路径不能包含换行')
    } else {
      value.paths = input.paths.map((p) => p.trim()).filter(Boolean)
    }
  }

  return { ok: errors.length === 0, errors, value }
}

/**
 * 把一条记忆摊平成 UI 需要的形状。
 *
 * `library`：条目所在的库（'project' / 'global'）。给了就以它为 scope——位置就是适用范围；
 * 没给（待确认草稿）就读 frontmatter。项目库里写着 `scope: global` 的旧条目 scope 报 project，
 * 但 `promotable: true`（仍可搬进 AGENTS.md，见 promoteToAgents）。
 * confidence 只在旧文件里有、且是有限数字时才给出：新条目不再有这个字段，编一个 0.8 出来会误导。
 */
function toUiShape(item, library) {
  const draft = library === undefined ? draftTarget(item.meta) : null
  const scope = draft ? draft.scope : library === 'global' ? 'global' : 'project'
  const confidence = Number(item.meta.confidence)
  // 草稿收下后要动 AGENTS.md 的哪一章（面板显示「替换第 N 章」/「新章」）。解析口径与 acceptPending 相同：
  // frontmatter 里 chapter 读出来是字符串、newChapter 可能是 'true'。只给草稿，已确认条目没有这些字段。
  const chapter = draft && /^\d+$/.test(String(item.meta.chapter ?? '').trim()) ? Number(item.meta.chapter) : 0
  const chapterTitle = draft && typeof item.meta.chapterTitle === 'string' ? item.meta.chapterTitle.trim() : ''
  // 草稿收下时要取代的旧记忆 id（第十一轮；按需与常驻草稿都给，面板以后可以展示）；常驻草稿还给它所在的库
  const supersedes = draft && typeof item.meta.supersedes === 'string' ? item.meta.supersedes.trim() : ''
  const supersedesScope = supersedes && (item.meta.supersedesScope === 'global' || item.meta.supersedesScope === 'project') ? item.meta.supersedesScope : ''
  return {
    id: item.id,
    name: item.meta.name ?? item.id,
    title: item.meta.title || item.body.split(/\r?\n/)[0] || item.id,
    description: item.meta.description ?? '',
    type: MEMORY_TYPES.includes(item.meta.type) ? item.meta.type : 'project',
    scope,
    load: draft ? draft.load : 'on-demand',
    // 草稿还不在任何库里，谈不上提升；已确认条目：全局库的、或带旧版 global 提示的项目库条目
    promotable: !draft && (scope === 'global' || item.meta.scope === 'global'),
    ...(draft
      ? {
          newChapter: item.meta.newChapter === true || item.meta.newChapter === 'true',
          ...(chapter > 0 ? { chapter } : {}),
          ...(chapterTitle ? { chapterTitle } : {}),
          ...(supersedes ? { supersedes } : {}),
          ...(supersedesScope ? { supersedesScope } : {}),
        }
      : {}),
    source: MEMORY_SOURCES.includes(item.meta.source) ? item.meta.source : null,
    evidence: typeof item.meta.evidence === 'string' ? item.meta.evidence : '',
    // 证据核实过没有（第六轮）：草稿与已确认条目都给；没有这个字段的旧数据不给这个键（面板据此显示「未核实」）
    ...(parseFrontmatterBoolean(item.meta.evidenceVerified) !== undefined ? { evidenceVerified: parseFrontmatterBoolean(item.meta.evidenceVerified) } : {}),
    status: item.meta.status ?? 'confirmed',
    tags: Array.isArray(item.meta.tags) ? item.meta.tags : [],
    paths: Array.isArray(item.meta.paths) ? item.meta.paths : [],
    ...(String(item.meta.confidence ?? '').trim() !== '' && Number.isFinite(confidence) ? { confidence } : {}),
    // 被召回次数与最近一次命中，用于判断哪条是死条目
    hits: finiteNumber(item.meta.hits, 0),
    lastHit: item.meta.lastHit ?? null,
    created: item.meta.created ?? null,
    modified: item.meta.modified ?? null,
    body: item.body,
  }
}

/**
 * 应用一次编辑。校验不通过时**不写任何东西**，把错误原样返回给调用方。
 * limit 说明：body 缺省时保留原文，因此编辑标题不会清空正文。
 */
async function applyMemoryPatch(memoryDir, id, patch, library = 'project', avoidIds = []) {
  const existing = readMemory(memoryDir, id)
  if (!existing) return { ok: false, status: 404, errors: [`找不到记忆 ${id}`] }

  const checked = validateMemoryPatch(patch)
  if (!checked.ok) return { ok: false, status: 400, errors: checked.errors }

  const next = checked.value
  try {
    const file = writeMemory(memoryDir, {
      id,
      slug: next.slug,
      // 改 slug（重命名）时新 id 同样避开另一个按需库
      avoidIds,
      title: next.title ?? existing.meta.title,
      // undefined 表示「不修改」，writeMemory 会沿用原值
      description: next.description,
      body: next.body ?? existing.body,
      type: next.type ?? existing.meta.type,
      // scope 不从这里传：它由所在的库决定，换库走 moveMemory（save 路由负责）。
      // 同库保存时沿用文件里的原值——项目库旧条目上的 `scope: global` 提示不因一次编辑被悄悄改掉。
      tags: next.tags ?? existing.meta.tags,
      paths: next.paths ?? existing.meta.paths,
      // confidence 不从这里传：它是模型自评，UI 编辑不得覆盖（见 validateMemoryPatch）
    })
    // 改了标题会重命名文件，id 也就变了——必须按新文件名回读
    const newId = path.basename(file, '.md')
    const built = await rebuildVectors(memoryDir)
    const saved = readMemory(memoryDir, newId)
    return {
      ok: true,
      status: 200,
      scope: library,
      memory: saved ? toUiShape(saved, library) : null,
      file: path.relative(memoryDir, file),
      renamed: newId !== id,
      previousId: newId === id ? undefined : id,
      vectorMode: built.mode,
      vectorCount: built.indexed,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 500, errors: [`写入失败：${detail}`] }
  }
}

/** 带 HTTP 状态码与原因码的请求错误：路由的统一 catch 据此回应，不再一律 400。 */
class RequestError extends Error {
  constructor(status, reason, message) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

/** 业务失败原因码 → HTTP 状态。表里没有的失败由路由给默认状态（400 / 404）。 */
const REASON_STATUS = {
  'invalid-id': 400,
  'invalid-index': 400,
  'invalid-scope': 400,
  'section-moved': 409,
  'library-full': 409,
  // 同一 id 两个库都有、请求又没说是哪个：不猜，让调用方带上 scope
  'scope-ambiguous': 409,
  // 换库时目标库已有同 id：不覆盖别人的记忆
  'target-exists': 409,
  // 手写/外来的「本项目常驻」草稿：插件不写项目 AGENTS.md
  'belongs-in-project-agents': 400,
  // 换库时目标库就是源库（例如两个库配置成了同一个目录）
  'same-library': 400,
  // 面板保存：已经换了库，其余字段没写成（响应里带条目现在所在的库）
  'partially-saved': 409,
  // 换库时写目标或删源失败（已回滚，条目仍在原库）。不用 write-failed：面板把那个码译成「写入 AGENTS.md 失败」
  'move-failed': 409,
  // 删源失败、回滚目标也失败：两个库里各有一份
  'move-partial': 409,
}

/**
 * 读 JSON 请求体：只收 `Content-Type: application/json`，体积限制 1 MiB。
 *
 * Content-Type 闸门是 CSRF 防线：`text/plain` / 表单这类跨站「简单请求」不触发 CORS 预检，
 * 任何网页都能直接发给本地路由；而 `application/json` 会触发预检，宿主不放行就发不出去。
 * 所以不是 JSON 的写请求一律 415，不看内容。
 */
function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') {
      reject(new RequestError(415, 'unsupported-media-type', '只接受 Content-Type: application/json'))
      return
    }
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limitBytes) {
        reject(new RequestError(413, 'body-too-large', `请求体超过 ${limitBytes} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new RequestError(400, 'invalid-json', '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

/* ---------------------------------------------------------------- MEMORY.md */

/**
 * 重建 MEMORY.md 索引。
 *
 * 格式照抄 Claude Code：
 *
 * ```md
 * # Memory Index
 *
 * - [UI 文案不要加解释](界面里不要自行添加解释性说明文字.md) — 用户要求界面不出现多余说明文案
 * ```
 *
 * 刻意**不写** root / count / 分组标题 / tags / id 前缀 —— 那些都是噪声，
 * 每行长度也应当留给真正的摘要。
 *
 * 超过行数/字节上限时**不静默截断**：把警告写进索引本身，注入时模型一定看得到。
 */
export function rebuildIndex(memoryDir) {
  const items = listMemories(memoryDir)
  const seen = new Map()
  for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item)

  // 按文件名排序：稳定、diff 干净，不会因为某条被改动就换位置
  const ordered = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN'))

  const lines = ['# Memory Index', '']
  for (const item of ordered) {
    // 索引行：英文在前（链接文字由英文 slug 还原），中文说明在后（description）
    const linkText = humanizeId(item.id)
    // 手工编辑过的文件可能塞进很长的 description，索引里再兜一层截断
    let summary = String(item.meta.description ?? '').trim()
    if (summary.length > MAX_DESCRIPTION_CHARS) {
      summary = `${summary.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
    }
    lines.push(summary ? `- [${linkText}](${item.id}.md) — ${summary}` : `- [${linkText}](${item.id}.md)`)
  }

  let text = lines.join('\n')
  if (ordered.length > 0) text += '\n'

  const lineCount = text.split(/\r?\n/).length
  const byteCount = Buffer.byteLength(text, 'utf8')
  if (lineCount > CONFIG.indexMaxLines || byteCount > CONFIG.indexMaxBytes) {
    text += [
      '',
      `WARNING: index over its read limit (${lineCount} lines / ${byteCount} bytes;`,
      `limit ${CONFIG.indexMaxLines} lines / ${CONFIG.indexMaxBytes} bytes).`,
      'Entries beyond the limit will not be injected next session.',
      'Shorten it: keep one line per entry, move detail into the memory bodies,',
      'and merge or delete stale entries.',
      '',
    ].join('\n')
  }

  ensureDir(memoryDir)
  writeFileAtomic(indexPath(memoryDir), text)
  return { count: seen.size, lineCount, byteCount }
}

/** 索引里一条记忆占一行，行首固定是 `- [`（见 rebuildIndex）。 */
const isIndexEntry = (line) => line.startsWith('- [')

/** rebuildIndex 写在文件末尾的超限警告的首行。注入时不原样用它，见 readIndexForInjection。 */
const INDEX_FILE_WARNING = 'WARNING: index over its read limit'

/**
 * 读索引正文，受行数/字节上限约束。永不抛异常。
 *
 *   · 一条记忆都没有（只剩标题）→ 返回空串，调用方就不注入这一段，省下每轮一段无用文字
 *   · 超限 → 截到上限内，并在末尾附一行警告，写明省略了多少条。警告的预算先扣出来，
 *     所以它自己永远放得下——截断不再是静默的。
 *     （文件里 rebuildIndex 写的那段警告在文件末尾，正好落在截断线之外，注入不了，所以这里重新生成。）
 */
function readIndexForInjection(memoryDir, limits = {}) {
  try {
    const file = indexPath(memoryDir)
    if (!existsSync(file)) return ''
    let lines = readFileSync(file, 'utf8').split(/\r?\n/)
    const warned = lines.findIndex((line) => line.startsWith(INDEX_FILE_WARNING))
    if (warned >= 0) lines = lines.slice(0, warned)
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    const total = lines.filter(isIndexEntry).length
    if (total === 0) return ''

    const maxLines = limits.maxLines ?? CONFIG.indexMaxLines
    const maxBytes = limits.maxBytes ?? CONFIG.indexMaxBytes
    const sizeOf = (list) => Buffer.byteLength(`${list.join('\n')}\n`, 'utf8')
    if (lines.length <= maxLines && sizeOf(lines) <= maxBytes) return lines.join('\n')

    const warning = (omitted) =>
      `[WARNING] ${omitted} of ${total} memory entries are NOT listed above (index limit: ${maxLines} lines / ${maxBytes} bytes). ` +
      'Use memory_recall to search for them, and tell the user the library needs trimming (delete or merge stale memories).'
    // 按「全部被省略」的最坏情形（数字位数最多）给警告留位置：一个空行 + 一行警告
    const reserve = Buffer.byteLength(`\n${warning(total)}\n`, 'utf8')
    const kept = []
    let bytes = 0
    for (const line of lines) {
      const size = Buffer.byteLength(`${line}\n`, 'utf8')
      if (kept.length + 3 > maxLines || bytes + size + reserve > maxBytes) break
      kept.push(line)
      bytes += size
    }
    const omitted = total - kept.filter(isIndexEntry).length
    return omitted > 0 ? [...kept, '', warning(omitted)].join('\n') : kept.join('\n')
  } catch {
    return ''
  }
}

/**
 * 每轮注入的动态 context（只放运行时事实：索引与预取结果）。永不抛异常。
 *
 *   [workspace-memory] 首行（recentTranscript / userTextsOf 靠这个前缀把注入块从对话记录里滤掉）
 *   ## 本工作区          项目库索引（去掉文件自己的 `# Memory Index` 标题，免得一级标题落在二级小节下）
 *   ## 所有项目（按需）    全局按需库索引，至多 globalIndexMaxLines 行，超出写警告不静默截断；0 = 不注入
 *   [相关记忆]           预取结果（调用方拼）
 *
 * 空的小节整节省略；**什么都没有时返回空串**（官方 system-prompt.md：Empty text contributes nothing）。
 * 行为指引不在这里：「何时写、写到哪」是静态的，放在 MEMORY_SECTION 系统提示段里（practices.md：
 * 提示文字用 ctx.systemPrompt.section()，context 只放会变的事实），所以空库时不需要再靠这里注入任何东西。
 */
export function composeInjection(projectDir, globalDir, prefetched = []) {
  const stripTitle = (text) => text.replace(/^# Memory Index[ \t]*(?:\r?\n[ \t]*)*(?:\r?\n|$)/, '')
  const header = '[workspace-memory] 记忆索引。需要细节时调 memory_recall 取全文。'
  const lines = [header]

  const local = projectDir ? stripTitle(readIndexForInjection(projectDir)) : ''
  if (local.trim()) lines.push('', '## 本工作区', local)

  if (globalDir && CONFIG.globalIndexMaxLines > 0 && !(projectDir && sameDir(globalDir, projectDir))) {
    const shared = stripTitle(readIndexForInjection(globalDir, { maxLines: CONFIG.globalIndexMaxLines }))
    if (shared.trim()) lines.push('', '## 所有项目（按需）', shared)
  }

  // 把 pre-step 算好的「本轮最接近的几条」附在后面。
  // 价值不是多给信息（索引里都有），而是**替模型排序**：几十条里哪几条跟当前请求有关。
  if (Array.isArray(prefetched) && prefetched.length > 0) {
    lines.push(
      '',
      '[相关记忆] 与本轮请求最接近的条目（需要细节时调 memory_recall）：',
      ...prefetched.map((hit) => `- ${hit.id} — ${hit.title}${hit.scope === 'global' ? '（所有项目）' : ''}`),
    )
  }
  // 只有首行 = 两个库都空、也没有预取结果：不贡献任何文本
  return lines.length === 1 ? '' : lines.join('\n')
}

/* -------------------------------------------------------------- leanvec */

/**
 * 解析本地 embedding 运行时。
 *
 * 优先按普通模块解析；失败则到 `<dsh home>/profiles/<name>/node_modules/leanvec` 里找
 * ——插件以 link 方式装进 profile 时，Node 会按真实路径（工作区目录）解析依赖，
 * 看不到 profile 的 node_modules，所以这条回退是必需的，不是可选优化。
 *
 * 全都找不到就返回 null，检索自动降级为纯关键词。这是设计内的正常分支。
 */
let embedderPromise

export async function resolveEmbedder() {
  if (embedderPromise) return embedderPromise
  embedderPromise = (async () => {
    const tryLoad = async (moduleDir) => {
      const mod = await import(pathToFileURL(path.join(moduleDir, 'src', 'embed.mjs')).href)
      const dist = path.join(moduleDir, 'dist')
      const table = path.join(dist, 'leanvec.f32')
      const tokenizer = path.join(dist, 'leanvec.tokenizer.json')
      if (!existsSync(table) || !existsSync(tokenizer)) return null
      const lv = mod.loadLeanvec({ table, tokenizer, cacheBytes: 8 * 1024 * 1024 })
      return { lv, moduleDir }
    }

    // 1) 常规模块解析
    try {
      const mod = await import('leanvec')
      const require_ = (await import('node:module')).createRequire(import.meta.url)
      const entry = require_.resolve('leanvec')
      const moduleDir = path.dirname(path.dirname(entry))
      const dist = path.join(moduleDir, 'dist')
      const table = path.join(dist, 'leanvec.f32')
      const tokenizer = path.join(dist, 'leanvec.tokenizer.json')
      if (existsSync(table) && existsSync(tokenizer)) {
        const lv = mod.loadLeanvec({ table, tokenizer, cacheBytes: 8 * 1024 * 1024 })
        return { lv, moduleDir }
      }
    } catch {
      // 落到回退路径
    }

    // 2) 插件自有依赖目录
    //
    // 为什么需要这一级：leanvec 曾声明在**这个 link 包**的 optionalDependencies 里，
    // 但 pnpm 不保证为 link 目标安装依赖 —— 用户下一次 `pnpm install` 就把它剪掉了，
    // 于是向量检索静默退化成纯关键词。
    // 所以给插件一个**不受 profile 依赖图影响**的位置：
    //   ~/.dsh/dsh-workspace-memory-deps/node_modules/leanvec
    // 由 `node scripts/install-deps.mjs` 一次性安装（用 npm，不进 pnpm 图）。
    const ownDeps = path.join(dshHome(), 'dsh-workspace-memory-deps', 'node_modules', 'leanvec')
    if (existsSync(path.join(ownDeps, 'src', 'embed.mjs'))) {
      try {
        const loaded = await tryLoad(ownDeps)
        if (loaded) return loaded
      } catch {
        // 坏的就跳过，继续找别的
      }
    }

    // 3) profile node_modules 回退
    const profiles = path.join(dshHome(), 'profiles')
    try {
      for (const entry of readdirSync(profiles, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const moduleDir = path.join(profiles, entry.name, 'node_modules', 'leanvec')
        if (!existsSync(path.join(moduleDir, 'src', 'embed.mjs'))) continue
        try {
          const loaded = await tryLoad(moduleDir)
          if (loaded) return loaded
        } catch {
          // 换下一个 profile
        }
      }
    } catch {
      // 没有 profiles 目录
    }

    return null
  })()
  return embedderPromise
}

/* ------------------------------------------------------------- 向量索引 */

/** 记忆正文的索引文本：标题 + 标签 + 正文，让向量多看一点语义。 */
function indexTextOf(item) {
  const tags = Array.isArray(item.meta.tags) ? item.meta.tags.join(' ') : ''
  // description 是人工写的一行摘要，信息密度最高，必须参与检索——
  // 之前漏了它，等于把最凝练的那句话排除在召回之外。
  return [item.meta.title, item.meta.description, tags, item.body]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000)
}

/**
 * 向量索引**只存在于内存**，不写磁盘。
 *
 * 为什么：它是纯派生数据——删掉就能从 `memory/` 重建。落盘还得处理格式版本、
 * mtime 失效、文件损坏一整类问题（前面几轮已经为此写过 VECTOR_FORMAT、
 * base64 编码、缓存失效）。实测全量重建 200 条约 650ms，**每个进程只付一次**：
 * 首次检索时懒建，之后全走内存。
 *
 * 附带好处：磁盘上不再有「看不出是什么」的索引文件，`memory/` 和
 * `.memory-state/` 都只剩人能读懂的东西。
 */
const vectorStore = new Map()

/** FNV-1a 32 位：只用来判断「这条记忆的索引文本变了没」，不需要密码学强度。 */
function hashText(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

/** 取本进程里已建好的索引；没有就返回 null，由调用方触发一次重建。 */
function loadVectors(memoryDir) {
  return vectorStore.get(memoryDir) ?? null
}

/** 存进内存。不写磁盘。 */
function saveVectors(memoryDir, payload) {
  vectorStore.set(memoryDir, payload)
}

/**
 * 每条记忆的检索派生数据：索引文本、内容哈希、规范化后的文本。
 * 挂在记忆对象上缓存（listMemories 在文件没变时返回同一个对象），所以每次召回
 * 不用对全部记忆重新拼文本、算哈希、转小写。
 */
const searchCache = new WeakMap()

function searchDataOf(item) {
  let data = searchCache.get(item)
  if (!data) {
    const text = indexTextOf(item)
    data = { text, hash: hashText(text), hay: foldText(text) }
    searchCache.set(item, data)
  }
  return data
}

/**
 * 向量索引是否与磁盘上的记忆一致：每条记忆都有哈希相同的向量，
 * 或者「这个哈希下确实嵌不出向量」（leanvec 对某些文字返回 null）的记录。
 * 手改过的文件、别的进程写入的文件、还没建过的索引都会判为不一致。
 */
function vectorsCurrent(stored, items) {
  if (!stored) return false
  const hashes = new Map(stored.entries.map((entry) => [entry.id, entry.hash]))
  return items.every((item) => {
    const { hash } = searchDataOf(item)
    return hashes.get(item.id) === hash || stored.skipped?.get(item.id) === hash
  })
}

/**
 * 重建向量索引。只覆盖 memories/ —— 这是与上一代实现最关键的差别。
 *
 * **增量**：每条记忆算一个索引文本哈希，与旧索引里同 id 的哈希比对；
 * 相同就原样复用向量，只有变过的才重新 embed。
 * 实测（2026-11-01）全量重嵌 200 条要 608 ms，改成增量后改一条只需一次 embed。
 *
 * 嵌不出向量的条目（空文本、leanvec 不支持的文字、embed 抛错）记在 `skipped` 里（id → 哈希），
 * 这样 recall 的一致性检查不会把它们当成「缺失」而每次都重建。
 *
 * 返回 { mode, indexed, reused, embedded }；leanvec 不可用时 mode='keyword' 且不抛。
 */
export async function rebuildVectors(memoryDir) {
  const embedder = await resolveEmbedder()
  if (!embedder) return { mode: 'keyword', indexed: 0, reused: 0, embedded: 0, reason: 'leanvec unavailable' }

  const items = listMemories(memoryDir)
  const previous = loadVectors(memoryDir)
  const previousById = new Map((previous?.entries ?? []).map((entry) => [entry.id, entry]))

  let reused = 0
  let embedded = 0
  const entries = []
  const skipped = new Map()

  for (const item of items) {
    const { text, hash } = searchDataOf(item)
    if (!text.trim()) {
      skipped.set(item.id, hash)
      continue
    }

    const prev = previousById.get(item.id)
    if (prev && prev.hash === hash && prev.vec) {
      entries.push({ id: item.id, hash, vec: prev.vec })
      reused += 1
      continue
    }

    try {
      const vec = embedder.lv.embed(text)
      if (vec) {
        entries.push({ id: item.id, hash, vec })
        embedded += 1
        continue
      }
    } catch {
      // 单条失败不影响整批
    }
    skipped.set(item.id, hash)
  }

  saveVectors(memoryDir, { model: 'leanvec', dim: VECTOR_DIM, builtAt: new Date().toISOString(), entries, skipped })
  return { mode: 'hybrid', indexed: entries.length, reused, embedded }
}

/* --------------------------------------------------------------- 检索 */

/** 点积即余弦（leanvec 输出已 L2 归一化）。 */
function dot(a, b) {
  let sum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i]
  return sum
}

/**
 * 中日韩文字（汉字、假名、谚文）：书写时不空格分词，所以按「字二元组 + 子串匹配」处理。
 * 长音符 ー（U+30FC）的 Script 是 Common，要单列，否则「サーバー」会被它劈成几段。
 */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]/u
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]+/gu
const WORD_TERM = /[\p{L}\p{N}_]{2,}/gu
const WORD_LETTER = /[\p{L}\p{N}]/u

/** 检索用的规范化：NFC（`ü` 的组合写法与预组合写法等价）+ 小写。 */
const foldText = (text) => String(text ?? '').normalize('NFC').toLowerCase()

/** 把查询拆成两类词项：字母数字词（词首匹配）与 CJK 字二元组（子串匹配）。 */
function queryTerms(query) {
  const q = foldText(query)
  const words = new Set()
  const grams = new Set()
  for (const run of q.match(CJK_RUN) ?? []) {
    const chars = Array.from(run)
    if (chars.length === 1) grams.add(chars[0])
    for (let i = 0; i + 1 < chars.length; i += 1) grams.add(chars[i] + chars[i + 1])
  }
  for (const word of q.replace(CJK_RUN, ' ').match(WORD_TERM) ?? []) words.add(word)
  return { words, grams }
}

/**
 * 词首匹配：term 出现处的前一个字符不能是（非 CJK 的）字母或数字。
 * 只在词首才算命中：`ci` 不该命中 "specified"，`id` 不该命中 "valid"。
 * 前缀仍然算（`deploy` 命中 "deployment"），下划线、连字符、斜杠、CJK 都当边界
 * （所以 `recall` 命中 `memory_recall`，`pnpm` 命中「使用pnpm安装」）。
 */
function hasWordStart(hay, term) {
  for (let at = hay.indexOf(term); at >= 0; at = hay.indexOf(term, at + 1)) {
    if (at === 0) return true
    const prev = hay[at - 1]
    if (!WORD_LETTER.test(prev) || CJK_CHAR.test(prev)) return true
  }
  return false
}

function scoreTerms({ words, grams }, hay) {
  const total = words.size + grams.size
  if (total === 0) return 0
  let hits = 0
  for (const word of words) if (hasWordStart(hay, word)) hits += 1
  for (const gram of grams) if (hay.includes(gram)) hits += 1
  return hits / total
}

/** 关键词评分：字母数字词（词首匹配）+ CJK 二元组，命中数 / 查询词数，归一到 0..1。 */
export function keywordScore(query, text) {
  return scoreTerms(queryTerms(query), foldText(text))
}

/* —— 「写于何时」：召回结果带上更新日期与距今天数 ——————————————————————
 * 系统提示段已经告诉模型「记忆写的是当时的情况，照做前先确认还在」；没有日期它无从判断。 */

const realClock = () => Date.now()
let clockImpl = realClock

/** 测试用：替换「现在」（返回毫秒时间戳的函数），返回还原函数。测试不依赖真实日期。 */
export function setClockForTests(fn) {
  const previous = clockImpl
  clockImpl = typeof fn === 'function' ? fn : realClock
  return () => {
    clockImpl = previous
  }
}

/** 超过这么多天的记忆，召回文字里提醒「先核实再用」。 */
export const VERIFY_AFTER_DAYS = 30

const DAY_MS = 86_400_000

/**
 * 一条记忆的 `{ updated, ageDays }`：updated 是 ISO 日期（YYYY-MM-DD，UTC），取 frontmatter 的
 * `modified`，没有（或解析不了）就取 `created`；ageDays 是「今天」与该日期相差的整天数（按 UTC 日历日，
 * 与显示的日期一致；未来的日期按 0）。两个字段都拿不到就返回 {}——返回值里不能出现 undefined / NaN。
 *
 * 只读 frontmatter、不看文件 mtime：只记命中（hits / lastHit）不改 modified，而 mtime 每次召回都会变。
 */
export function memoryAge(meta, now = clockImpl()) {
  const toMs = (value) => {
    if (value instanceof Date) return value.getTime()
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.trim() !== '') return Date.parse(value.trim())
    return Number.NaN
  }
  const valid = (ms) => Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime())
  let at = toMs(meta?.modified)
  if (!valid(at)) at = toMs(meta?.created)
  const nowMs = toMs(now)
  if (!valid(at) || !valid(nowMs)) return {}
  return {
    updated: new Date(at).toISOString().slice(0, 10),
    ageDays: Math.max(0, Math.floor(nowMs / DAY_MS) - Math.floor(at / DAY_MS)),
  }
}

/** 召回文字里标题行后的那一段：`updated 2026-11-05, 9 days ago`，超过 VERIFY_AFTER_DAYS 天再提醒先核实。 */
export function ageNote(age) {
  const { updated, ageDays } = age ?? {}
  if (typeof updated !== 'string' || !Number.isInteger(ageDays)) return ''
  const ago = ageDays === 0 ? 'today' : ageDays === 1 ? '1 day ago' : `${ageDays} days ago`
  return `updated ${updated}, ${ago}${ageDays > VERIFY_AFTER_DAYS ? '; verify before relying on it' : ''}`
}

/**
 * 混合检索：向量 + 关键词加权融合。
 *
 * 与上一代的关键区别：**分数低就是低，不硬凑**。低于阈值的直接不返回，
 * 而不是像上一代那样把无关符号以 100 分吐出来。
 */
export async function recall(memoryDir, query, limit = 5, options = {}) {
  return recallLibraries([{ dir: memoryDir }], query, limit, options)
}

/**
 * 跨库召回：每个库各自打分（向量对账、闸门都按库进行），再按分数合并取前 limit、过总体积预算。
 *
 * `libraries`：`[{ dir, scope? }]`，顺序即同分时的优先级（项目库在前）。
 * 给了 scope 的库，结果行带 `scope`；没给就不带（单库调用的返回形状与以前一致）。
 * 结果行带 `updated` / `ageDays`（见 memoryAge；「现在」取 `options.now`，缺省取时钟）。
 * hits 只记给最终返回的条目，按各自的库落盘。
 */
export async function recallLibraries(libraries, query, limit = 5, options = {}) {
  const now = options.now ?? clockImpl()
  const scored = []
  const modes = new Set()
  let total = 0
  for (const library of libraries) {
    const part = await scoreLibrary(library.dir, query)
    total += part.count
    if (part.count > 0) modes.add(part.mode)
    for (const row of part.scored) scored.push({ ...row, library })
  }
  if (total === 0) return { mode: 'empty', results: [] }
  const mode = modes.has('hybrid') ? 'hybrid' : 'keyword'

  // 稳定排序：同分时保持库的先后（项目库优先）
  scored.sort((a, b) => b.score - a.score)
  const cap = Number.isFinite(Number(limit)) ? Number(limit) : 5
  let top = scored.slice(0, Math.max(1, Math.min(20, Math.floor(cap))))

  // 总体积预算：不收窄单条正文（长内容该长），而是**少带一条**。
  // 条数按分数顺序装入，超出预算就截断列表并如实说明还有几条。
  const budget = CONFIG.recallMaxChars
  if (budget > 0) {
    const fitted = []
    let used = 0
    for (const row of top) {
      const size = Buffer.byteLength(String(row.item.body ?? ''), 'utf8')
      if (fitted.length > 0 && used + size > budget) break
      fitted.push(row)
      used += size
    }
    top = fitted
  }
  const omittedByBudget = scored.length - top.length

  // 被召回才算「用过」：累计 hits / lastHit，给「哪些记忆该淘汰」提供依据。
  // 查重是内部调用，不算取用——否则每次写入都把条目刷一遍 hits，淘汰统计立刻失真。
  if (options.recordHits !== false) {
    for (const library of libraries) {
      recordHits(library.dir, top.filter((row) => row.library === library).map((row) => row.item.id))
    }
  }
  return {
    mode,
    results: top.map((row) => ({
      id: row.item.id,
      ...(row.library.scope ? { scope: row.library.scope } : {}),
      title: row.item.meta.title || row.item.body.split(/\r?\n/)[0] || row.item.id,
      type: row.item.meta.type ?? 'project',
      tags: row.item.meta.tags ?? [],
      score: Number(row.score.toFixed(4)),
      vector: Number(row.vec.toFixed(4)),
      keyword: Number(row.kw.toFixed(4)),
      body: row.item.body,
      chars: Buffer.byteLength(String(row.item.body ?? ''), 'utf8'),
      file: path.relative(row.library.dir, row.item.file),
      ...memoryAge(row.item.meta, now),
    })),
    // 预算或 limit 之外还有落选条目时如实报数，避免「以为只有这些」
    omitted: omittedByBudget,
  }
}

/** 给一个库里的全部记忆打分并过闸门。返回 { mode, count, scored: [{ item, score, kw, vec }] }。 */
async function scoreLibrary(memoryDir, query) {
  const items = listMemories(memoryDir)
  if (items.length === 0) return { mode: 'empty', count: 0, scored: [] }

  const byId = new Map(items.map((item) => [item.id, item]))
  const vectorScores = new Map()
  let mode = 'keyword'

  const embedder = await resolveEmbedder()
  if (embedder) {
    // 向量索引只在「经由本插件写入」时才更新。手改文件、别的进程写入、还没建过索引时它会落后于磁盘，
    // 所以每次召回先按内容哈希对账，缺的/旧的就增量补上（只重嵌变过的那几条）。
    if (!vectorsCurrent(loadVectors(memoryDir), items)) await rebuildVectors(memoryDir)
    const entries = loadVectors(memoryDir)?.entries ?? []
    try {
      const qvec = embedder.lv.embed(query)
      if (qvec) {
        mode = 'hybrid'
        for (const entry of entries) {
          if (!byId.has(entry.id)) continue // 记忆已删除，索引残留
          const cosine = dot(qvec, entry.vec)
          vectorScores.set(entry.id, Number.isFinite(cosine) ? Math.max(0, cosine) : 0)
        }
      }
    } catch {
      mode = 'keyword'
    }
  }

  const terms = queryTerms(query)
  const scored = []
  for (const item of items) {
    const kw = scoreTerms(terms, searchDataOf(item).hay)
    const vec = vectorScores.get(item.id) ?? 0
    // 任一通道达到门槛才入选：向量重语义，关键词重字面，互补
    if (vec < CONFIG.minVectorScore && kw < CONFIG.minKeywordScore) continue
    const score = mode === 'hybrid' ? CONFIG.weightVector * vec + CONFIG.weightKeyword * kw : kw
    // 融合分闸门：低于它就当库里没有。宁可返回空，也不要拿不相关的东西凑数。
    if (CONFIG.minScore > 0 && score < CONFIG.minScore) continue
    scored.push({ item, score, kw, vec })
  }

  scored.sort((a, b) => b.score - a.score)
  return { mode, count: items.length, scored }
}

/**
 * 找可能重复/冲突的记忆（写入前用）。
 *
 * 复用检索的打分，但**不计 hits**——查重不是「取用」。
 * 返回按分数降序，调用方只关心最高的几个。
 * `memoryDir` 也可以是 `[{ dir, scope }]`：跨库查重，候选行带 scope。
 */
export async function findSimilarMemories(memoryDir, text, limit = 3) {
  const query = String(text ?? '').trim()
  if (!query) return []
  const libraries = Array.isArray(memoryDir) ? memoryDir : [{ dir: memoryDir }]
  const found = await recallLibraries(libraries, query, Math.max(1, Math.min(20, limit)), { recordHits: false })
  return found.results ?? []
}

/**
 * 路径统一成「段」：反斜杠当分隔符，空段（`//`、结尾 `/`）与 `.` 段丢掉。
 * Windows 的路径不分大小写，所以按小写比（`caseInsensitive` 默认只在 win32 开）。
 */
function pathSegments(raw, caseInsensitive) {
  const text = caseInsensitive ? raw.toLowerCase() : raw
  return text.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.')
}

const segmentGlobCache = new Map()

/** 单段通配：`*` 匹配本段内任意字符（不跨 `/`，`*` 在这里可以是空串），其余字符按字面。 */
function segmentMatches(pattern, segment) {
  if (!pattern.includes('*')) return pattern === segment
  let regex = segmentGlobCache.get(pattern)
  if (!regex) {
    const body = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    regex = new RegExp(`^${body}$`)
    if (segmentGlobCache.size > 500) segmentGlobCache.clear()
    segmentGlobCache.set(pattern, regex)
  }
  return regex.test(segment)
}

/** 段序列通配匹配：`**` 匹配零段或多段，其余逐段比；线性回溯，不会指数爆炸。 */
function segmentsMatch(pattern, segments) {
  let p = 0
  let s = 0
  let star = -1
  let mark = 0
  while (s < segments.length) {
    if (p < pattern.length && pattern[p] === '**') {
      star = p
      p += 1
      mark = s
    } else if (p < pattern.length && segmentMatches(pattern[p], segments[s])) {
      p += 1
      s += 1
    } else if (star >= 0) {
      p = star + 1
      mark += 1
      s = mark
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '**') p += 1
  return p === pattern.length
}

/**
 * 记忆里标注的 `paths` 是否命中一个真实文件路径。
 *
 * 约定（与写入时的人工标注一致）：
 *   · 相对工作区根写，例如 `dsh-profile-stats/client.js`、`.github/workflows/x.yml`
 *   · 按**路径段**匹配，不按字符：`src/` 命中 `/ws/src/a.js`，不会命中 `/ws/mysrc/a.js`
 *   · 判据是「touched 路径以该模式结尾」，所以绝对路径也能匹配；光写文件名（`index.js`）
 *     命中任何目录下叫这个名字的文件，但必须是整段（`xindex.js` 不算）
 *   · `*` 匹配一段内的任意字符、不跨目录；`**` 匹配零段或多段（`src/**` 命中 src 之下任意深度的文件）
 *   · 结尾 `/` 表示该目录下的任何文件（至少再深一层）
 *   · Windows 上不分大小写
 */
export function pathMatches(memoryPath, touchedPath, options = {}) {
  const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32'
  const rawPattern = String(memoryPath ?? '').trim()
  const pattern = pathSegments(rawPattern, caseInsensitive)
  const target = pathSegments(String(touchedPath ?? ''), caseInsensitive)
  if (pattern.length === 0 || target.length === 0) return false
  // 目录形式要求目录之下还有东西，且目录可以在路径中间；文件形式锚在末尾
  return segmentsMatch(
    /[\\/]$/.test(rawPattern) ? ['**', ...pattern, '*', '**'] : ['**', ...pattern],
    target,
  )
}

/**
 * 检查一个 `paths` 条目是否像真实文件路径。
 *
 * 为什么值得校验：`paths` 是「读文件时带出相关记忆」的唯一触发依据。
 * 写成 `"插件配置"` 这种不是路径的东西不会报错，只会**永远不触发**——
 * 静默失效比报错难查得多。
 *
 * 返回空串表示看着没问题（允许 `*` 通配与目录形式）。
 */
export function pathHintIssue(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return 'empty'
  if (/^https?:\/\//i.test(value)) return 'url-not-path'
  if (value.includes('*')) return '' // 通配
  if (value.includes('/') || value.includes('\\')) return '' // 带目录
  if (/\.[a-z0-9]{1,10}$/i.test(value)) return '' // 带扩展名
  return 'not-a-path'
}

/** 从工具参数里挑出可能是文件路径的字符串（只认约定的几个键，避免把正文当路径）。 */export function pathsFromToolArgs(args) {
  const keys = ['file_path', 'filePath', 'path', 'target', 'notebook_path']
  const found = []
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    for (const [key, inner] of Object.entries(value)) {
      if (keys.includes(key) && typeof inner === 'string' && inner.trim()) found.push(inner.trim())
      else if (inner && typeof inner === 'object') visit(inner)
    }
  }
  visit(args)
  return found
}

/**
 * 找出与这些文件相关的记忆（按 paths 命中，不看分数——这是精确触发，不是语义检索）。
 *
 * 返回顺序稳定（按命中顺序），并且**只返回 id 与标题**：正文要靠 memory_recall 取，
 * 否则每次读文件都在往上下文里塞全文。
 */
export function memoriesForPaths(memoryDir, paths, limit = 3) {
  if (!Array.isArray(paths) || paths.length === 0) return []
  const hits = []
  const seen = new Set()
  for (const item of listMemories(memoryDir)) {
    const declared = Array.isArray(item.meta.paths) ? item.meta.paths : []
    if (declared.length === 0) continue
    const matched = declared.find((pattern) => paths.some((file) => pathMatches(pattern, file)))
    if (!matched || seen.has(item.id)) continue
    seen.add(item.id)
    hits.push({
      id: item.id,
      title: item.meta.title || item.body.split(/\r?\n/)[0] || item.id,
      matchedPath: matched,
    })
    if (hits.length >= limit) break
  }
  return hits
}

/**
 * 只改 frontmatter 里的 `key: value` 这一行（没有就追加在收尾的 `---` 之前），其余字节原样保留。
 * 不整体重新序列化：手写的 YAML 块列表、注释、引号风格、行尾（CRLF）都不能因为「被召回一次」而改变。
 * 没有 frontmatter 的文件返回 null——不碰它。
 */
function withFrontmatterFields(raw, fields) {
  const bom = raw.charCodeAt(0) === 0xfeff ? '\u{FEFF}' : ''
  const text = bom ? raw.slice(1) : raw
  const match = /^---(\r?\n)([\s\S]*?)(\r?\n---)(?=\r?\n|$)/.exec(text)
  if (!match) return null
  const eol = match[1]
  let section = match[2]
  for (const [key, value] of Object.entries(fields)) {
    let found = false
    section = section.replace(new RegExp(`^[ \\t]*${key}[ \\t]*:.*$`, 'gm'), () => {
      found = true
      return `${key}: ${value}`
    })
    if (!found) section += `${eol}${key}: ${value}`
  }
  return `${bom}---${eol}${section}${match[3]}${text.slice(match[0].length)}`
}

/**
 * 给被召回的条目累加 hits / lastHit。
 *
 * 刻意**不重建 MEMORY.md**：命中次数不进索引，重建纯属浪费；
 * 也**不留历史**：这是元数据抖动而非内容变更，留档会把历史冲爆。
 * 只改这两行（见 withFrontmatterFields），所以不会动到记忆的其它任何内容。
 */
function recordHits(memoryDir, ids) {
  if (ids.length === 0) return
  const now = new Date().toISOString()
  for (const id of ids) {
    try {
      const file = idFile(memoriesPath(memoryDir), id)
      if (!file || !existsSync(file)) continue
      const raw = readFileSync(file, 'utf8')
      const previous = Number(parseFrontmatter(raw).data.hits)
      const patched = withFrontmatterFields(raw, {
        hits: (Number.isFinite(previous) && previous >= 0 ? previous : 0) + 1,
        lastHit: now,
      })
      if (patched === null) continue
      writeFileAtomic(file, patched)
      memoryCache.delete(file)
    } catch {
      // 计数失败不影响检索本身
    }
  }
}

/* ------------------------------------------------------------ 上下文取用 */

/**
 * **唯一的记忆根解析入口。**
 *
 * 四种调用场景各自说明「谁在问」：
 *   · 工具执行   → `{ agent: exec.agent }`
 *   · 命令处理   → `{ agent: invocation.agent }`
 *   · HTTP 请求  → `{ sessionId: sessionIdOf(req) }`   请求里没有 agent
 *   · 每轮注入   → `{ useInitiator: true }`             只能靠当前发起者
 *
 * **绝不退回 `process.cwd()` / `workingDirectory.defaultDirectory`。**
 * 2026-11-01 一晚因此踩了两次：那条兜底会解析到进程默认目录（profile 目录），
 * 于是「明明有 8 条记忆却报 0 条」，而且 HTTP 还返回 200 —— 错得很安静。
 * 拿不到就返回 null，由调用方明确报错，绝不猜一个目录去读或写。
 */
function memoryDirOf(ctx, who = {}) {
  const cwd = sessionCwdOf(ctx, who)
  if (!cwd) return null
  refreshWorkspaceRoots(ctx)
  return resolveMemoryDir(cwd)
}

/**
 * 会话的「项目指令根」（instructionsRootFor：往上最近的 .git 目录，找不到就是工作目录）。
 * 只用于告诉模型「项目 AGENTS.md 在哪」，插件不读写那个文件。拿不到工作目录返回 null。
 */
function instructionsRootOf(ctx, who = {}) {
  const cwd = sessionCwdOf(ctx, who)
  if (!cwd) return null
  try {
    return instructionsRootFor(cwd)
  } catch {
    return null
  }
}

/** 「谁在问」→ 会话工作目录。见 memoryDirOf 的说明；拿不到返回 null，绝不猜。 */
function sessionCwdOf(ctx, { agent, sessionId, useInitiator = false } = {}) {
  const dirOfSession = (session) => {
    if (!session) return null
    try {
      return ctx.workingDirectory.get(session) || null
    } catch {
      return null
    }
  }

  const sessionOfAgent = (candidate) => {
    if (!candidate) return null
    try {
      return ctx.sessions.get(candidate.id) ?? null
    } catch {
      return null
    }
  }

  let cwd = dirOfSession(sessionOfAgent(agent))

  if (!cwd && typeof sessionId === 'string' && sessionId.trim() !== '') {
    try {
      cwd = dirOfSession(ctx.sessions.get(sessionId.trim()))
    } catch {
      cwd = null
    }
  }

  if (!cwd && useInitiator) {
    try {
      cwd = dirOfSession(sessionOfAgent(ctx.agents.currentInitiator()))
    } catch {
      cwd = null
    }
  }

  return cwd || null
}

/** 某条 id 在哪些库里存在（项目库在前）。id 不安全时返回 []。 */
function locateMemory(projectDir, id) {
  if (!isSafeId(id)) return []
  return librariesFor(projectDir).filter((library) => {
    const file = idFile(memoriesPath(library.dir), id)
    return Boolean(file) && existsSync(file)
  })
}

/** 从请求 URL 上取 `?session=`。 */
function sessionIdOf(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    return url.searchParams.get('session') ?? ''
  } catch {
    return ''
  }
}

/* ---------------------------------------------------------------- 工具输出 */

const textOutput = (schema) => ({
  schema,
  render(_args, value) {
    const text =
      value && typeof value === 'object' && typeof value.text === 'string'
        ? value.text
        : JSON.stringify(value, null, 2)
    return [{ type: 'text', text }]
  },
})

const stringArraySchema = { type: 'array', items: { type: 'string' } }

/*
 * 工具返回值的 schema（output.schema）。官方 tools.md：宿主按它校验每一个成功的返回值；raw schema 走「enforced subset」，
 * 对象节点显式写 additionalProperties。这里把**实际会出现的字段全部声明出来**（test/official-alignment 逐个分支校验完整性），
 * 但对象节点写 `additionalProperties: true`：写 false 时，将来某个分支多带一个字段，宿主就会在**写入已经发生之后**
 * 把整次调用判成失败——模型以为没写成而重试，造成重复写入（与 CLAUDE.md 记的 lossless JSON 事故同一类）。
 * 来自手写文件的字段（召回结果的标题、类型、标签）不声明类型：手改的 frontmatter 什么都可能有，召回不该因此整条失败。
 */
const SCHEMA_STRING = { type: 'string' }
const SCHEMA_NUMBER = { type: 'number' }
const SCHEMA_BOOLEAN = { type: 'boolean' }
const SCHEMA_STRINGS = { type: 'array', items: SCHEMA_STRING }
const FROM_FILE = { description: 'Copied from the memory file; a hand-edited file may hold any JSON value here.' }

export const REMEMBER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['text'],
  properties: {
    text: { type: 'string', description: 'What happened, in words for the model.' },
    id: SCHEMA_STRING,
    file: SCHEMA_STRING,
    scope: SCHEMA_STRING,
    load: SCHEMA_STRING,
    reason: SCHEMA_STRING,
    written: SCHEMA_BOOLEAN,
    pending: SCHEMA_BOOLEAN,
    action: SCHEMA_STRING,
    replacedDraft: SCHEMA_STRING,
    replaced: SCHEMA_STRING,
    replacedFrom: SCHEMA_STRING,
    // type 是 procedure / repo-rule / docs 时（reason: belongs-elsewhere）：内容该写到哪
    home: { type: 'string', enum: ['skill', 'agents', 'readme'] },
    // type 选了改道取值，但 supersedes 指向一条已有记忆：没有改道，作为记忆更新
    keptAsMemory: SCHEMA_BOOLEAN,
    // type 是 user / feedback、scope 是 global，调用方显式给了 load: on-demand，被按规则改成 always（§15.1）
    loadForced: SCHEMA_BOOLEAN,
    updated: SCHEMA_BOOLEAN,
    chars: SCHEMA_NUMBER,
    count: SCHEMA_NUMBER,
    limit: SCHEMA_NUMBER,
    staleValues: SCHEMA_STRINGS,
    pathWarnings: SCHEMA_STRINGS,
    // 直写成功后清掉的同 slug、同去向旧草稿
    clearedDrafts: SCHEMA_STRINGS,
    // 常驻草稿收下后要更新的章号
    chapter: SCHEMA_NUMBER,
    // source: user 时证据是否核实（找得到原话且与这条记忆的文字沾边）；agent 来源不带
    evidenceVerified: SCHEMA_BOOLEAN,
    // 写入成功但 MEMORY.md 没能重建
    indexStale: SCHEMA_BOOLEAN,
    // 同 slug、意图不同、没有被覆盖的待确认草稿
    sameSlugDrafts: SCHEMA_STRINGS,
    argument: SCHEMA_STRING,
    allowed: SCHEMA_STRINGS,
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: SCHEMA_STRING,
          title: SCHEMA_STRING,
          scope: SCHEMA_STRING,
          score: SCHEMA_NUMBER,
          hits: SCHEMA_NUMBER,
          lastHit: { oneOf: [SCHEMA_STRING, { type: 'null' }] },
        },
      },
    },
  },
}

export const RECALL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['text'],
  properties: {
    text: SCHEMA_STRING,
    mode: SCHEMA_STRING,
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: SCHEMA_STRING,
          scope: SCHEMA_STRING,
          title: FROM_FILE,
          type: FROM_FILE,
          tags: FROM_FILE,
          score: SCHEMA_NUMBER,
          vector: SCHEMA_NUMBER,
          keyword: SCHEMA_NUMBER,
          body: SCHEMA_STRING,
          chars: SCHEMA_NUMBER,
          file: SCHEMA_STRING,
          // 写于何时：frontmatter 的修改时间（没有就取创建时间）；两者都没有的手写文件不带这两个字段
          updated: { type: 'string', description: 'ISO date (YYYY-MM-DD) the memory was last modified, else created.' },
          ageDays: { type: 'integer', description: 'Whole days between that date and today.' },
        },
      },
    },
  },
}

export const FORGET_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['text'],
  properties: {
    text: SCHEMA_STRING,
    removed: SCHEMA_BOOLEAN,
    reason: SCHEMA_STRING,
    scope: SCHEMA_STRING,
    // 删掉了但 MEMORY.md 没能重建
    indexStale: SCHEMA_BOOLEAN,
    locations: {
      type: 'array',
      items: { type: 'object', additionalProperties: true, properties: { scope: SCHEMA_STRING, file: SCHEMA_STRING } },
    },
  },
}

export const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['text'],
  properties: {
    text: SCHEMA_STRING,
    // 最近一次证据核对走的哪一路：用来在真实 DSH 里确认 pre-step 缓存这条主路径生效了
    evidenceSource: { type: 'string', enum: ['prestep-cache', 'snapshot-fallback', 'none'] },
    // 有库的 MEMORY.md 条目数与记忆文件数对不上
    indexStale: SCHEMA_BOOLEAN,
    staleLibraries: SCHEMA_STRINGS,
  },
}

/** 缺省：undefined / null / 空白串。模型常给可选字符串参数填 ""，那是「没给」而不是一个取值。 */
const isBlank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

/**
 * memory_remember 的入参校验。返回 null = 通过；否则是一个拒写结果（reason: invalid-argument）。
 *
 * 直接注册的 raw JSON-Schema 工具由自己校验输入（官方 tools.md：「a raw ToolDefinition validates its own input」），
 * 宿主不会替我们挡 required / enum：
 *   · title / body 必须是非空字符串（空正文的记忆只会白占一行索引）；
 *   · type 缺失或不在枚举里 → 拒写并列出允许值（以前静默回落成 project，分类就悄悄错了）；
 *   · scope / load 缺省（含空白串）取默认值，给了非法值 → 拒写（以前非法值静默当成默认值，写到模型没想要的去处）；
 *   · source 缺失或非法不在这里拒：按 agent 处理（进待确认），见 rememberRoute。
 */
export function checkRememberArgs(args) {
  const shown = (value) => {
    let text
    try {
      text = JSON.stringify(value)
    } catch {
      text = undefined
    }
    text = typeof text === 'string' ? text : String(value)
    return text.length > 60 ? `${text.slice(0, 57)}...` : text
  }
  const refuse = (argument, problem, allowed) => ({
    reason: 'invalid-argument',
    written: false,
    argument,
    ...(allowed ? { allowed: [...allowed] } : {}),
    text: `NOT written: ${problem}${allowed ? ` Allowed values: ${allowed.join(', ')}.` : ''}`,
  })
  const input = args && typeof args === 'object' ? args : {}
  if (typeof input.title !== 'string' || input.title.trim() === '') return refuse('title', 'title is required and must be a non-empty string.')
  if (typeof input.body !== 'string' || input.body.trim() === '') return refuse('body', 'body is required and must be a non-empty string.')
  // 五种记忆 + 三种改道（procedure / repo-rule / docs，§13）都是合法取值
  if (!REMEMBER_TYPES.includes(input.type)) {
    return refuse('type', input.type === undefined ? 'type is required.' : `type ${shown(input.type)} is not a valid type.`, REMEMBER_TYPES)
  }
  if (!isBlank(input.scope) && input.scope !== 'project' && input.scope !== 'global') {
    return refuse('scope', `scope ${shown(input.scope)} is not valid.`, ['project', 'global'])
  }
  if (!isBlank(input.load) && !MEMORY_LOADS.includes(input.load)) {
    return refuse('load', `load ${shown(input.load)} is not valid.`, MEMORY_LOADS)
  }
  return null
}

/* -------------------------------------------------------------- 注册部分 */

export function apply(ctx, rawConfig) {
  const resolved = configure(rawConfig)
  if (resolved.issues.length > 0) {
    for (const issue of resolved.issues) console.error(`[workspace-memory] config: ${issue}`)
  }

  // 记忆库的「项目」就是已注册的工作区，而不是每个子项目各建一个（那些子目录各自是独立 git 仓库）。
  // 这里先读一次；之后每次解析记忆目录时 memoryDirOf 都会再读（见 refreshWorkspaceRoots）。
  refreshWorkspaceRoots(ctx)

  /* —— 预取缓存：pre-step 里算好，注入时只读 —————————————————— */
  const prefetchCache = new Map() // agentId -> { turn, hits: [{id,title,score}] }

  /* —— 用户原话缓存：pre-step 里收，证据核对时先读它（见 appendUserTexts / verifyEvidenceFrom）——
   * agentId -> string[]（人写的用户消息，旧的在前，有上限）。agent/disposed 时清掉。 */
  const userTextCache = new Map()
  /**
   * 每个 agent 最近一次证据核对：agentId -> { via, verified, related?, missing? }。memory_status 报告当前 agent 的。
   * 按 agent 记（第五轮）：以前是进程级的一个变量，多个会话并行时 A 的状态会显示在 B 的 memory_status 里。
   */
  const lastEvidenceChecks = new Map()

  /* —— 系统提示段：何时想到要记、四个归宿怎么选（静态，不随轮次变）————————————
   * 官方 practices.md：「Add prompt text with ctx.systemPrompt.section()」；动态 context 只放运行时事实。
   * 单独一个 effect：注册失败要让插件激活报错（看得见），不能连带吞掉别的注册。
   *
   * 已知事项：这段对所有 agent 一样，包括没有记忆工具的 agent。组装时拿到的 AssembleContext 只有
   * scope / signal（dsh-agent 另加 agent / modelSelection），没有工具集信息，无法按「这个 agent 有没有
   * memory_remember」给不同文本；不为此引入猜测性的判断。 */
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'workspace-memory',
        order: MEMORY_SECTION_ORDER,
        text: MEMORY_SECTION,
        // 文本里没有 {{变量}}；关掉插值是为了以后改文案时不会被误当成变量而让整次组装失败
        interpolate: false,
      }),
    'workspace-memory section',
  )

  /* —— 每轮注入 MEMORY.md（动态 context：只放索引与预取结果）————————————— */
  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: 'workspace-memory',
        order: 60,
        // interpolate:false 是必须的——记忆正文里可能含 {{ }} 或 []，
        // 让它们被当成插值语法解析会把注入搞崩。
        interpolate: false,
        required: false,
        text: () => {
          try {
            // 拿不到会话工作目录：不知道是谁在问，什么都不注入。
            // 两个库都为空且没有预取结果时同样是空串（行为指引在系统提示段里，不靠这里）。
            const memoryDir = memoryDirOf(ctx, { useInitiator: true })
            if (!memoryDir) return ''
            let agent
            try {
              agent = ctx.agents?.currentInitiator?.()
            } catch {
              agent = undefined
            }
            const prefetched = agent ? prefetchCache.get(agent.id) : undefined
            return composeInjection(memoryDir, globalMemoryDirOf(), prefetched?.hits ?? [])
          } catch {
            return ''
          }
        },
      }),
    'workspace-memory injection',
  )

  /* —— 用户消息进来时：记下原话 + 预取 ————————————————————————————
   *
   * 同一个监听做两件事，都只是旁路：
   *   ① 把本批消息里人写的文本追加进 userTextCache（证据核对的主路径，不依赖已弃用的 snapshotEvents）；
   *   ② 预取：pre-step 是 async waterfall 且带 messages，所以这里能 await 真正的 recall；
   *      注入用的 context.text 是同步的，只能读 prefetchCache。
   * 这个监听不拥有决策：**始终 return next()**，而且只调一次；两件事各自 try/catch，任何失败都不能挡住步骤。
   */
  ctx.effect(() =>
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        appendUserTexts(userTextCache, payload?.agent?.id, payload?.messages)
      } catch {
        // 缓存失败不影响步骤（证据核对会回落到快照）
      }

      try {
        const agent = payload?.agent
        // 查询文本只取人写的（humanTextOf，第五轮）：注入的上下文（AGENTS.md、skill、runtime-context 里的记忆索引本身）
        // 参与查询会让召回被它们带偏——索引里本来就列着全部条目。
        const messages = Array.isArray(payload?.messages) ? payload.messages : []
        const text = !CONFIG.prefetchRecall || !agent
          ? ''
          : messages
              .map((message) => {
                try {
                  return humanTextOf(message)
                } catch {
                  return ''
                }
              })
              .filter(Boolean)
              .join('\n')
              .trim()
        // 后续步骤没有新用户消息：保留上一份缓存
        const memoryDir = text ? memoryDirOf(ctx, { agent }) : null
        if (memoryDir) {
          // 两个库一起查、按分数合并：全局按需库的条目只有经召回才会出现，预取是它最主要的入口
          const found = await recallLibraries(librariesFor(memoryDir), text.slice(0, 2000), CONFIG.prefetchLimit, { recordHits: false })
          prefetchCache.set(agent.id, {
            turn: payload.turn,
            hits: found.results.map((row) => ({ id: row.id, title: row.title, score: row.score, scope: row.scope })),
          })
        }
      } catch {
        // 预取失败不影响步骤
      }
      return next()
    }),
  )

  /* —— 回合收尾自动抽取 ——————————————————————————————————————
   * 挂在 `agent/turn-stopping`：官方为「回合即将结束」留的 serial 座位，
   * 每回合都会触发，不依赖压缩插件（本 profile 的 compaction-basic 是关闭的，
   * 所以「压缩前触发」永远不会发生 —— 这是实测后改过来的设计）。
   *
   * 这个监听会被 await，所以：默认关闭、按 N 回合节流、全程 try/catch，
   * 任何失败都不允许影响主对话。 */
  ctx.effect(() =>
    ctx.on('agent/turn-stopping', async (payload) => {
      if (!CONFIG.enableExtraction) return
      const agent = payload?.agent
      if (!agent) return

      const count = (turnCounter.get(agent.id) ?? 0) + 1
      turnCounter.set(agent.id, count)
      if (count % CONFIG.extractEveryTurns !== 0) return

      const memoryDir = memoryDirOf(ctx, { agent })
      if (!memoryDir) return

      try {
        // 回合的中止信号一并交过去：用户中止回合时抽取立刻停下，不再拖住收尾
        await extractFromTurn(ctx, agent, memoryDir, { signal: payload?.signal })
      } catch {
        // 抽取是旁路，永远不冒泡
      }
    }),
  )

  // 会话销毁时清掉计数器、预取与用户原话缓存，避免长期驻留
  ctx.effect(() =>
    ctx.on('agent/disposed', (payload) => {
      if (payload?.agent?.id) {
        turnCounter.delete(payload.agent.id)
        prefetchCache.delete(payload.agent.id)
        userTextCache.delete(payload.agent.id)
        lastEvidenceChecks.delete(payload.agent.id)
      }
    }),
  )

  // 回合结束清掉预取：下一轮该按新的用户消息重新算，
  // 留着会让「上一轮的相关记忆」污染下一轮。
  ctx.effect(() =>
    ctx.on('agent/turn-stopping', (payload) => {
      if (payload?.agent?.id) prefetchCache.delete(payload.agent.id)
    }),
  )

  /* —— paths 触发提示 ————————————————————————————————————————————
   *
   * 读到/改到某条记忆标注过的文件时，在工具结果末尾贴一行「相关记忆 <id>」。
   *
   * 为什么放在 post-execute 而不是写进 system prompt：system prompt 里只能说
   * 「你可能该 recall 了」，无法知道当前在碰哪个文件；而工具参数里正好有路径，
   * 这是唯一能**精确**判断「此刻该想起哪条记忆」的地方。
   *
   * 三条克制：
   *   1. 只给 id + 标题，不给正文（正文要 memory_recall 取，渐进式加载）
   *   2. 同一轮里同一条只提示一次（读 10 个文件不该重复喊同一句）
   *   3. 任何异常都放行原结果——提示是锦上添花，不能拖垮工具调用
   */
  const hintedThisTurn = new Map()

  ctx.effect(() =>
    ctx.on('agent/status', (payload) => {
      try {
        if (payload?.status !== 'running' && payload?.agent?.id) hintedThisTurn.delete(payload.agent.id)
      } catch {
        // 清理失败无影响
      }
    }),
  )

  /*
   * 契约（官方 tools.md「tools/post-execute」与 practices.md「Stability」）：
   *   · 这个监听器不拥有决策，所以**一律经过 next()**——不需要提示时 `return next()`；
   *     需要提示时先 `await next()` 拿到下游的决定，再在它上面加料，下游监听器不会被跳过；
   *   · PostToolDecision 里 content 与 value 只能二选一：我们只换 content（展示层），返回值**不带 value 键**；
   *   · 下游 block 了或换了 value → 原样交回，不改它的决定；
   *   · `result` 是 ToolExecutionResult（isError / value / content / meta…），它没有 `kind` 字段，不能拿它判断。
   * 不改用 additionalContexts 注入：那是 UserMessage，source.kind 要按 MessageSourceMap 声明，离线无法验证。
   */
  ctx.effect(() =>
    ctx.on('tools/post-execute', async (exec, result, next) => {
      // 第一步只算「要不要提示、提示什么」，不碰 next()：任何异常都等于不提示
      let hint = ''
      let markSeen = () => {}
      try {
        const toolName = String(exec?.name ?? '')
        // 记忆工具自己的结果不需要再提示记忆；失败的结果不加料
        if (CONFIG.pathsHint && result && !result.isError && toolName && !toolName.startsWith('memory_')) {
          const touched = pathsFromToolArgs(exec?.arguments)
          const memoryDir = touched.length > 0 ? memoryDirOf(ctx, { agent: exec?.agent }) : null
          if (memoryDir) {
            // 两个库都查（项目库在前），合并后再截到上限
            const hits = librariesFor(memoryDir)
              .flatMap((library) =>
                memoriesForPaths(library.dir, touched, CONFIG.pathsHintLimit).map((hit) => ({ ...hit, scope: library.scope })),
              )
              .slice(0, CONFIG.pathsHintLimit)
            const agentKey = exec?.agent?.id ?? ''
            const seen = hintedThisTurn.get(agentKey) ?? new Set()
            // 两个库可能有同名 id，去重键要带上库
            const keyOf = (hit) => `${hit.scope}:${hit.id}`
            const fresh = hits.filter((hit) => !seen.has(keyOf(hit)))
            if (fresh.length > 0) {
              const lines = fresh.map((hit) => `- ${hit.id} — ${hit.title}${hit.scope === 'global' ? '（所有项目）' : ''}`)
              hint = `\n\n[记忆] 这个文件有相关记忆（需要细节时调 memory_recall）：\n${lines.join('\n')}`
              // 真正贴上去之后才记「本轮提示过」：下游拦掉了，下次碰到还要再提示
              markSeen = () => {
                for (const hit of fresh) seen.add(keyOf(hit))
                hintedThisTurn.set(agentKey, seen)
              }
            }
          }
        }
      } catch {
        hint = ''
      }
      if (!hint) return next()

      const decision = await next()
      try {
        // 下游拦截、或已经换了 value（content 与 value 只能二选一）→ 原样交回
        if (!decision || decision.kind !== 'accept' || decision.value !== undefined) return decision
        const base = Array.isArray(decision.content) ? decision.content : Array.isArray(result.content) ? result.content : []
        markSeen()
        return {
          kind: 'accept',
          content: [...base, { type: 'text', text: hint }],
          ...(Array.isArray(decision.additionalContexts) ? { additionalContexts: decision.additionalContexts } : {}),
        }
      } catch {
        return decision
      }
    }),
  )

  /* —— 浏览器半区的数据接口 ——————————————————————————————————
   * 走宿主 HTTP 路由而不是包私有 RPC：工作区里 dsh-profile-stats 已经用这条路
   * 跑通，行为可预测，也不需要额外的 Remote/typert 声明。
   * 全部在本包自己的命名空间下，不与他人冲突。
   *
   * 三道共用的闸门，路由本身不再各写一遍：
   *   · 方法：GET 路由只收 GET/HEAD，写路由只收 POST（405）
   *   · Content-Type：写路由只收 application/json（415，见 readJsonBody）
   *   · session：记忆库相关路由必须带能反查出工作目录的 `?session=`（400），绝不回退到默认目录
   * 业务代码只管返回 `{ status, payload }` 或抛 RequestError；其余异常一律 500，绝不抛进宿主。
   *
   * 边界（第六轮写明）：宿主的网页服务**不提供鉴权**（官方 dsh-host-webserver README：
   * 「No server-wide authentication or origin policy」）。这些路由——包括「收下草稿」「写 AGENTS.md 章节」——
   * 本机上任何能发 HTTP 请求的进程都能调，agent 用 shell 工具 curl 一下也能。Content-Type 闸门只挡浏览器跨站的简单请求。
   * 所以插件保证的是「记忆工具（memory_remember 等）不直写 AGENTS.md、常驻写入一律等人收下」，
   * **不是**「agent 无论如何写不了 AGENTS.md」——它本来就能用文件工具直接改那个文件。这里不另造鉴权机制。 */
  {
    const API = '/api/dsh-workspace-memory'

    const failure = (error) => {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        status: error instanceof RequestError ? error.status : 500,
        payload: { ok: false, ...(error instanceof RequestError ? { reason: error.reason } : {}), errors: [detail] },
      }
    }

    /** 业务结果 → 响应：成功 200；失败按原因码取状态，没有对应原因码的用 failStatus。 */
    const replyOf = (result, failStatus = 400) => ({
      status: result.ok ? 200 : (REASON_STATUS[result.reason] ?? failStatus),
      payload: result,
    })

    const getRoute = (run) =>
      async function handleGet(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, errors: ['只接受 GET'] })
          return
        }
        try {
          const reply = await run(req)
          sendJson(res, reply.status, reply.payload)
        } catch (error) {
          const reply = failure(error)
          sendJson(res, reply.status, reply.payload)
        }
      }

    const postRoute = (run) =>
      async function handlePost(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
          return
        }
        try {
          const body = await readJsonBody(req)
          const reply = await run(body, req)
          sendJson(res, reply.status, reply.payload)
        } catch (error) {
          const reply = failure(error)
          sendJson(res, reply.status, reply.payload)
        }
      }

    /** 请求对应的记忆目录；session 查不到就是 400。 */
    const memoryDirFor = (req) => {
      const memoryDir = memoryDirOf(ctx, { sessionId: sessionIdOf(req) })
      if (!memoryDir) throw new RequestError(400, 'no-session', '无法确定工作区：请求缺少有效的 session 参数')
      return memoryDir
    }

    /** 请求体里的记忆 id；空或不安全（会逃出记忆目录）就是 400 invalid-id，不碰任何文件。 */
    const memoryIdOf = (body) => {
      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      if (!id) throw new RequestError(400, 'invalid-id', 'id: 不能为空')
      if (!isSafeId(id)) throw new RequestError(400, 'invalid-id', 'id: 不合法')
      return id
    }

    const register = (path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))

    /** 请求体里可选的 `scope`（条目所在的库）：缺省返回 ''，非法值 400 invalid-scope。 */
    const scopeOf = (value) => {
      if (value === undefined || value === null || value === '') return ''
      if (value !== 'project' && value !== 'global') throw new RequestError(400, 'invalid-scope', 'scope: 只能是 project 或 global')
      return value
    }

    /**
     * 定位一条已确认记忆所在的库。给了 scope 就用它；没给就两个库都找：
     * 只有一处 → 用它；两处都有 → 409 scope-ambiguous（不猜，猜错就改/删了另一条）；都没有 → null。
     */
    const libraryFor = (memoryDir, id, requested) => {
      if (requested) return { scope: requested, dir: libraryDir(memoryDir, requested) }
      const found = locateMemory(memoryDir, id)
      if (found.length > 1) {
        throw new RequestError(409, 'scope-ambiguous', `两个库里都有 id 为 ${id} 的记忆，请带上 scope（project 或 global）`)
      }
      return found[0] ?? null
    }

    register(
      `${API}/list`,
      getRoute((req) => {
        const memoryDir = memoryDirFor(req)
        const libraries = librariesFor(memoryDir)
        return {
          status: 200,
          payload: {
            ok: true,
            root: memoryDir,
            globalRoot: globalMemoryDirOf(),
            // 两个库的条目都在这里，每条带 scope（= 所在的库）
            memories: libraries.flatMap((library) => listMemories(library.dir).map((item) => toUiShape(item, library.scope))),
            // 草稿只在会话所在项目的队列里；scope / load 读草稿自己的 frontmatter
            pending: listPending(memoryDir).map((item) => ({ ...toUiShape(item), status: 'draft' })),
            pendingEnabled: CONFIG.enableExtraction,
            agentWrites: CONFIG.agentWrites,
          },
        }
      }),
    )

    /*
     * 保存一条已确认记忆。`patch.scope` 与条目所在的库不同 → 先 moveMemory 换库，再在新库里应用其余字段。
     * 顺序是「先校验 → 再移动 → 再写字段」：校验是纯函数，放在最前面保证校验失败时什么都没动；
     * 移动自己会检查目标库同 id / 库满，失败就整体不做。
     */
    register(
      `${API}/save`,
      postRoute(async (body, req) => {
        const memoryDir = memoryDirFor(req)
        const id = memoryIdOf(body)
        const patch = body?.patch && typeof body.patch === 'object' ? body.patch : {}
        const checked = validateMemoryPatch(patch)
        if (!checked.ok) return { status: 400, payload: { ok: false, status: 400, errors: checked.errors } }

        const library = libraryFor(memoryDir, id, scopeOf(body?.scope))
        if (!library) return { status: 404, payload: { ok: false, status: 404, errors: [`找不到记忆 ${id}`] } }

        let current = library
        let moved = false
        const wanted = checked.value.scope
        if (wanted && wanted !== library.scope) {
          const toDir = libraryDir(memoryDir, wanted)
          const result = moveMemory(library.dir, toDir, id, { toScope: wanted })
          if (!result.ok) return replyOf({ ...result, scope: library.scope }, result.reason === 'not-found' ? 404 : 400)
          current = { scope: wanted, dir: toDir }
          moved = true
          await rebuildVectors(library.dir)
        }

        const { scope: _ignored, ...rest } = patch
        const otherDir = libraryDir(memoryDir, current.scope === 'global' ? 'project' : 'global')
        const result = await applyMemoryPatch(current.dir, id, rest, current.scope, sameDir(otherDir, current.dir) ? [] : idsOf(otherDir))
        if (!moved) return { status: result.status, payload: result }
        if (!result.ok) {
          // 已经换了库、其余字段却没写成（第五轮）：不能回 500 让面板以为什么都没变——条目**现在**在新库里。
          // 回 409 + 当前所在的库，面板据此刷新列表；字段没保存上，用户可以在新库里再改一次。
          return {
            status: 409,
            payload: { ...result, ok: false, status: 409, reason: 'partially-saved', moved: true, scope: current.scope, previousScope: library.scope },
          }
        }
        return { status: result.status, payload: { ...result, moved: true, previousScope: library.scope } }
      }),
    )

    // 待确认草稿的处置。与 /memory accept|reject 走同一套函数，只是换个入口，
    // 免得「命令能做的事界面做不到」或反过来出现两套逻辑。
    for (const action of ['accept', 'reject']) {
      register(
        `${API}/${action}`,
        postRoute(async (body, req) => {
          const memoryDir = memoryDirFor(req)
          const id = memoryIdOf(body)
          // 与其它路由同一套约定：原因码在 reason，状态按 REASON_STATUS；表里没有的码 400，只有「草稿不存在」是 404
          const result = action === 'accept' ? await acceptPending(memoryDir, id) : rejectPending(memoryDir, id)
          return replyOf(result, result.reason === 'not-found' ? 404 : 400)
        }),
      )
    }

    /* —— 删除已确认的记忆 ——
     * 面板的「删除」按钮走这里。高置信度记忆是直接入库的，所以人必须能自己删掉记错的东西；
     * 删除走 deleteMemory，会先在 .memory-state/history/ 留一份，可回退。
     */
    register(
      `${API}/forget`,
      postRoute(async (body, req) => {
        const memoryDir = memoryDirFor(req)
        const id = memoryIdOf(body)
        const library = libraryFor(memoryDir, id, scopeOf(body?.scope))
        if (!library || !deleteMemory(library.dir, id)) return { status: 404, payload: { ok: false, errors: [`找不到记忆：${id}`] } }
        const built = await rebuildVectors(library.dir)
        return {
          status: 200,
          payload: { ok: true, removed: id, scope: library.scope, vectorMode: built.mode, vectorCount: built.indexed },
        }
      }),
    )

    /* —— 全局 AGENTS.md：查看、搬迁、打开、章节管理 ——
     * 全局文件不属于任何工作区，面板读写它时不带 session，所以这些路由没有 session 闸门；
     * 写路由靠上面的 Content-Type 闸门挡住跨站的简单请求。 */
    register(
      `${API}/agents`,
      // 顺带把探测到的编辑器一起给出去，界面据此渲染「打开方式」下拉
      getRoute(() => ({ status: 200, payload: { ok: true, agents: agentsStatus(), editors: detectEditors() } })),
    )

    // 两个库的条目都能提升为 AGENTS.md 的一章；body.scope 指明条目在哪个库（缺省时两个库都找）
    register(
      `${API}/promote`,
      postRoute(async (body, req) => {
        const memoryDir = memoryDirFor(req)
        const id = memoryIdOf(body)
        const library = libraryFor(memoryDir, id, scopeOf(body?.scope)) ?? { scope: 'project', dir: memoryDir }
        const result = promoteToAgents(library.dir, id, { scope: library.scope })
        return replyOf({ ...result, scope: library.scope })
      }),
    )

    register(
      `${API}/open-agents`,
      postRoute(async (body) => replyOf(openAgentsFile(typeof body?.editor === 'string' ? body.editor : ''))),
    )

    register(`${API}/agents/sections`, getRoute(() => ({ status: 200, payload: readAgentsDocument() })))

    // `index` 原样交给 saveAgentsSection / deleteAgentsSection 校验（必须是真整数，不做字符串转换）；
    // `expectedTitle` 是面板打开这一章时看到的标题，序号过期就返回 section-moved（409），不改错章。
    register(
      `${API}/agents/save-section`,
      postRoute(async (body) =>
        replyOf(saveAgentsSection(body?.index, { title: body?.title, body: body?.body, expectedTitle: body?.expectedTitle })),
      ),
    )
    register(
      `${API}/agents/delete-section`,
      postRoute(async (body) => replyOf(deleteAgentsSection(body?.index, { expectedTitle: body?.expectedTitle }))),
    )
    register(
      `${API}/agents/add-section`,
      postRoute(async (body) => replyOf(appendAgentsSection({ title: body?.title, body: body?.body }))),
    )
  }

  /* —— memory_remember ——————————————————————————————————————— */

  /** 取代谁：先精确 id，再「唯一」的前缀。返回 { target } / { ambiguous } / {}。 */
  const resolveSupersedes = (dir, wanted) => {
    const items = listMemories(dir)
    const exact = items.find((row) => row.id === wanted)
    if (exact) return { target: exact }
    const byPrefix = items.filter((row) => row.id.startsWith(wanted))
    if (byPrefix.length > 1) return { ambiguous: byPrefix }
    return byPrefix.length === 1 ? { target: byPrefix[0] } : {}
  }

  /**
   * type 选了改道取值、同时带着 supersedes 时：被取代的记忆是否**确实存在**（§13 补丁）。存在就返回那一条，否则 null。
   * 解析规则与正常写入完全相同（见 memory_remember 里的 supersedes 解析）：两个库的精确 id 优先；目标库里的唯一前缀也算；
   * 目标库里前缀有歧义、或只在另一个库里前缀命中，都算解析不到——这时照旧改道，不报 supersedes-not-found。
   */
  const keptAsMemoryTarget = (memoryDir, scope, wanted) => {
    if (!memoryDir || !wanted) return null
    const inTarget = resolveSupersedes(libraryDir(memoryDir, scope), wanted)
    const other = librariesFor(memoryDir).find((library) => library.scope !== scope)
    const inOther = other ? resolveSupersedes(other.dir, wanted) : {}
    if (inTarget.target?.id === wanted) return inTarget.target
    if (inOther.target?.id === wanted) return inOther.target
    if (inTarget.ambiguous) return null
    return inTarget.target ?? null
  }

  /**
   * memory_remember 的 supersedes 解析：按需写入与常驻写入共用（第十一轮：常驻草稿也带取代对象，收下时删掉旧条）。
   * 返回 `{ target, crossFrom? }`（crossFrom = 被取代条目所在的另一个库），或 `{ refusal }`（原样返回给模型的拒写）。
   *
   * 官方 user-actions.md：面板能做的数据操作（换库），工具也要能做，且共用一个实现（moveMemory）。
   * 以前另一库命中时拒写并让模型换 scope 重来——但模型要的就是「新内容放在这个库、旧的那条作废」。
   * 顺序：两个库的**精确 id** 优先于任何前缀匹配——否则目标库里一个碰巧以它开头的条目会被错删。
   * 跨库只认**精确 id**（第五轮）：以前另一个库里「唯一前缀」命中也会执行，往项目库写 supersedes: "npm"
   * 就能把全局库里不相关的 npm-publish-cadence 搬走删掉。另一个库里只有前缀命中时一律不执行，
   * 回 supersedes-ambiguous 并列出候选（带各自所在的库），让模型带着精确 id 再来。库内的前缀规则不变。
   * 前缀匹配到多条就拒写——删错一条记忆比多问一句代价大得多。
   */
  const lookupSuperseded = (memoryDir, scope, wanted) => {
    const targetDir = libraryDir(memoryDir, scope)
    const other = librariesFor(memoryDir).find((library) => library.scope !== scope)
    const ambiguousReply = (rows, where) => {
      const candidates = rows.slice(0, 10).map((row) => ({ id: row.id, title: oneLine(row.meta?.title ?? row.id), scope: where }))
      return {
        reason: 'supersedes-ambiguous',
        written: false,
        candidates,
        text:
          `NOT written: "${wanted}" is a prefix of ${rows.length} memories in ${libraryLabel(where)}, so it is unclear which one to replace.\n\n` +
          `${candidates.map((row) => `  ${row.id}  ${row.title}`).join('\n')}\n\n` +
          'Call again with supersedes set to the exact id.',
      }
    }
    const inTarget = resolveSupersedes(targetDir, wanted)
    const inOther = other ? resolveSupersedes(other.dir, wanted) : {}
    if (inTarget.target?.id === wanted) return { target: inTarget.target }
    if (inOther.target?.id === wanted) return { target: inOther.target, crossFrom: other }
    if (inTarget.ambiguous) return { refusal: ambiguousReply(inTarget.ambiguous, scope) }
    if (inTarget.target) return { target: inTarget.target }
    if (inOther.ambiguous || inOther.target) {
      const rows = inOther.ambiguous ?? [inOther.target]
      const candidates = rows.slice(0, 10).map((row) => ({ id: row.id, title: oneLine(row.meta?.title ?? row.id), scope: other.scope }))
      return {
        refusal: {
          reason: 'supersedes-ambiguous',
          written: false,
          candidates,
          text:
            `NOT written: "${wanted}" matches no memory in ${libraryLabel(scope)}, and only as a prefix in ${libraryLabel(other.scope)}. ` +
            'Replacing a memory in the other library needs its exact id:\n\n' +
            `${candidates.map((row) => `  ${row.id}  [${row.scope}]  ${row.title}`).join('\n')}\n\n` +
            'Call again with supersedes set to the exact id, or leave supersedes out if this is a separate memory.',
        },
      }
    }
    return {
      refusal: {
        reason: 'supersedes-not-found',
        written: false,
        text: `NOT written: no memory matches "${wanted}" in either library. Call memory_recall first to get the exact id.`,
      },
    }
  }

  /**
   * 因为在更新已有记忆而没有改道：返回值带 keptAsMemory: true，文本加一句说明（§13 补丁）。
   * 那句放在过期值提示之前（§4.6：过期值提示固定在全文最后）。
   */
  const withKeptAsMemory = (result, id, staleTail) => {
    if (!result || typeof result.text !== 'string') return result
    const saved = typeof result.id === 'string' // 直写或进了待确认
    const note =
      ` ${saved ? 'Kept as a memory' : 'Handled as a memory update, not redirected,'} because it updates the existing memory ${id}. ` +
      'If this content really belongs in a rule for everyone on the repo, a procedure or the project docs, propose writing it there to the user, ' +
      'and delete this memory once that is written.'
    const text =
      staleTail && result.text.endsWith(staleTail)
        ? `${result.text.slice(0, result.text.length - staleTail.length)}${note}${staleTail}`
        : `${result.text}${note}`
    return { ...result, keptAsMemory: true, text }
  }

  /**
   * 调用方显式给了 load: on-demand、被按 §15.1 改成 always：返回值带 loadForced: true，文本加 LOAD_FORCED_TEXT。
   * 常驻分支的每种结果都带（进待确认、needs-confirmation、chapter-not-found、agents-missing……）——
   * 模型要知道为什么自己选的按需变成了章节协议。那句同样放在过期值提示之前（§4.6）。
   */
  const withLoadForced = (result, staleTail) => {
    if (!result || typeof result.text !== 'string') return result
    const note = ` ${LOAD_FORCED_TEXT}`
    const text =
      staleTail && result.text.endsWith(staleTail)
        ? `${result.text.slice(0, result.text.length - staleTail.length)}${note}${staleTail}`
        : `${result.text}${note}`
    return { ...result, loadForced: true, text }
  }

  /** 库的人话名字（写进工具返回文本）。 */
  const libraryLabel = (scope) => (scope === 'global' ? 'the all-projects on-demand library (scope "global")' : "this workspace's library (scope \"project\")")

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'memory_remember',
        // 三层各放各的（见「提示词分层」）：工具说明只写做什么、何时用、返回什么；
        // 各条判据挂在它管的参数上（官方 tool-design.md：Put parameter rules on the parameter）。
        description: REMEMBER_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: SLUG_RULE },
            title: { type: 'string', description: 'Human-readable title (may be Chinese). Not the file name.' },
            description: { type: 'string', description: DESCRIPTION_RULE },
            body: { type: 'string', description: BODY_RULE },
            // 五种记忆 + 三种「不是记忆」的改道（§13.1）
            type: { type: 'string', enum: REMEMBER_TYPES, description: TYPE_RULES },
            source: { type: 'string', enum: MEMORY_SOURCES, description: SOURCE_RULE },
            evidence: { type: 'string', description: EVIDENCE_RULE },
            tags: stringArraySchema,
            paths: { ...stringArraySchema, description: PATHS_RULE },
            scope: { type: 'string', enum: ['project', 'global'], description: SCOPE_RULE },
            load: { type: 'string', enum: MEMORY_LOADS, description: LOAD_RULE },
            supersedes: { type: 'string', description: SUPERSEDES_RULE },
            newMemory: {
              type: 'boolean',
              description: 'Only with load "on-demand". Set true to confirm this is a separate memory after a refusal listed similar ones.',
            },
            chapter: {
              type: 'number',
              description:
                'Only with load "always". The 1-based AGENTS.md chapter to overwrite with this content; merge old and new into body yourself.',
            },
            newChapter: {
              type: 'boolean',
              description: 'Only with load "always". Set true to confirm this is a new topic, not an existing chapter under another title.',
            },
          },
          // scope 也必填（§12.3）；宿主不校验 required，execute 里缺失仍取默认 project
          required: ['slug', 'title', 'body', 'type', 'source', 'scope'],
          additionalProperties: false,
        },
        output: textOutput(REMEMBER_OUTPUT_SCHEMA),
        async execute(rawArgs, exec) {
          try {
            const input = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}

            // —— 0) 入参自行校验：直接注册的 raw JSON-Schema 工具自己负责校验输入
            //        （官方 tools.md：「a raw ToolDefinition validates its own input」，宿主不替我们挡）——
            // 放在最前面：校验失败时一个字都不写，连工作区都不用解析。
            const invalid = checkRememberArgs(input)
            if (invalid) return invalid

            // —— 归类是第一道判断（§13.2）：type 是流程 / 全仓库规则 / 项目文档时什么都不保存——不进库、不进待确认、
            // 不做证据核对、不查重，也不因为缺 slug / source / evidence 先返回别的拒写——只告诉模型该写到哪。
            // 唯一的例外（§13 补丁）：supersedes 能解析到一条**确实存在**的记忆时，更新留在原处——
            // 否则旧记忆原样留在库里，成了与用户最新说法相反的错误记忆（代理模型评测：用户说「现在从 dev 拉，不再从 test 拉」，
            // 模型带着 supersedes 却选了 repo-rule，旧的「从 test 拉」一直留着）。这时按被取代那条记忆自己的类型走正常写入，
            // 加载方式固定为 on-demand（被取代的条目在按需库里；常驻会把这次更新引到 AGENTS.md，旧条照样留着）。
            let args = input
            let keptFor = null // 因为在更新已有记忆而没有改道：被取代的那条记忆的 id
            let loadForced = false // 调用方显式给的 on-demand 被按 §15.1 改成了 always
            if (ROUTED_TYPES.includes(input.type)) {
              const wanted = String(input.supersedes ?? '').trim()
              const existing = wanted
                ? keptAsMemoryTarget(memoryDirOf(ctx, { agent: exec?.agent }), isBlank(input.scope) ? 'project' : input.scope, wanted)
                : null
              if (!existing) return routedReply(input.type, instructionsRootOf(ctx, { agent: exec?.agent }))
              args = { ...input, type: MEMORY_TYPES.includes(existing.meta?.type) ? existing.meta.type : 'project', load: 'on-demand' }
              keptFor = existing.id
            }

            const result = await (async () => {
              const memoryDir = memoryDirOf(ctx, { agent: exec?.agent })
              if (!memoryDir) return { text: '无法定位工作区记忆库：当前会话没有可用工作目录。' }

              // —— 三个独立的选择：适用范围、加载方式、来源 ——
              // scope / load 缺省（含空串）取默认值，给了非法值已在上面拒掉；source 缺失或非法按 agent 处理。
              const scope = isBlank(args.scope) ? 'project' : args.scope
              // §15.1：user / feedback + global 一律常驻（resolveLoad），之后走现有的常驻分支。
              // 「更新留在原处」（keptFor）不受影响：被取代的记忆在按需库里，更新仍按按需处理。
              const resolved = keptFor ? { load: isBlank(args.load) ? 'on-demand' : args.load, forced: false } : resolveLoad({ type: args.type, scope, load: args.load })
              const load = resolved.load
              loadForced = resolved.forced
              const source = args.source === 'user' ? 'user' : 'agent'
              const evidence = source === 'user' && typeof args.evidence === 'string' ? args.evidence.trim() : ''

              // 过期值只提示、不拦（策略不是过滤器）：直写与进队列都在文本末尾点名
              const stale = stalenessHints(args.body, args.type)
              const staleTail = stalenessNote(stale)
              const staleField = stale.length > 0 ? { staleValues: stale } : {}

              // —— 1) 只在本项目成立却要每轮常驻：归宿是项目自己的 AGENTS.md，插件不写 ——
              if (scope === 'project' && load === 'always') {
                return {
                  reason: 'belongs-in-project-agents',
                  written: false,
                  text: projectAgentsText(instructionsRootOf(ctx, { agent: exec?.agent })),
                }
              }

              // —— 分流：按来源，不按自评置信度；常驻一律进待确认（rememberRoute）——
              // source: user 时**总是**核对一次证据（第六轮：常驻写入也做——它照样进待确认，核对结果只用于记录），
              // 两道都过才算核实：
              //   ① 找得到原话：先读 pre-step 缓存，没通过再回落到会话快照（verifyEvidenceFrom）；
              //   ② 原话与这条记忆的文字沾边（evidenceRelates：标题、摘要、正文）——挡「好的，继续」当证据。
              // 核实结果存进 evidenceVerified（草稿与正式记忆都存），面板据此区分「用户原话」与「未核实」；
              // 以前没核实的证据也存成 source: user，面板照样显示「用户原话」，审草稿的人会被误导。
              // 没给证据也照常记一次核对状态，memory_status 能看出来。
              const agentId = exec?.agent?.id
              let verified = false
              if (source === 'user') {
                const check = verifyEvidenceFrom({
                  cached: agentId ? userTextCache.get(agentId) : undefined,
                  getSession: () => (agentId ? ctx.sessions.get(agentId) : undefined),
                  evidence,
                })
                const related = check.verified && evidenceRelates(evidence, [args.title, args.description, args.body])
                if (agentId) {
                  lastEvidenceChecks.set(agentId, {
                    via: check.via,
                    verified: check.verified && related,
                    ...(evidence === '' ? { missing: true } : {}),
                  })
                }
                verified = check.verified && related
              }
              const route = rememberRoute({ source, verified, load })
              // 原因码仍是 evidence-not-found。文案中性（第六轮）：只说没在用户消息里核对到，
              // 不说「要与标题共享词语」——那等于教模型把用户的话抄进标题来绕过。「没给证据」单独一句。
              const reasonText =
                route.reason === 'evidence-not-found'
                  ? PENDING_REASON_TEXT[evidence === '' ? 'evidence-missing' : 'evidence-not-found']
                  : PENDING_REASON_TEXT[route.reason]
              // 只在 source: user 时写这个字段（agent 来源谈不上「核实」）
              const verifiedField = source === 'user' ? { evidenceVerified: verified } : {}

              const draftFields = {
                title: args.title,
                description: args.description,
                body: args.body,
                type: args.type,
                tags: args.tags,
                paths: args.paths,
                scope,
                load,
                source,
                ...(evidence ? { evidence } : {}),
                ...verifiedField,
              }
              // plan：常驻草稿收下后写到哪一章（planAgentsChapter 的结果）；按需草稿不传。
              // 常驻草稿的 target 是 { id, scope }：收下时先写 AGENTS.md，写成功后把这条旧记忆归档删除（第十一轮）
              const destination = (plan) =>
                `${load === 'always' ? agentsFileDisplay() : libraryLabel(scope)}` +
                `${plan?.action === 'updated' ? `, replacing chapter "${plan.chapterTitle}" (now chapter ${plan.chapter})` : plan?.action === 'added' ? ' as a new chapter' : ''}`
              const acceptingText = (target, fromScope, plan) =>
                load === 'always'
                  ? `Accepting it writes it into ${destination(plan)}` +
                    `${target ? ` and then deletes the old memory ${target.id} from ${libraryLabel(target.scope)} (its body is archived in history/ first)` : ''}.`
                  : `Accepting it ${target ? `will replace ${target.id}${fromScope ? ` (now in ${libraryLabel(fromScope)})` : ''} and ` : ''}writes it into ${destination(plan)}.`
              const pendingReply = (queued, target, fromScope, plan) => ({
                id: queued.id,
                file: path.relative(memoryDir, queued.file),
                pending: true,
                reason: route.reason,
                scope,
                load,
                ...(plan?.action === 'updated' ? { chapter: plan.chapter } : {}),
                ...(queued.replacedDraft ? { replacedDraft: queued.replacedDraft } : {}),
                ...(queued.sameSlugDrafts ? { sameSlugDrafts: queued.sameSlugDrafts } : {}),
                ...verifiedField,
                ...staleField,
                text:
                  `Queued as pending ${queued.id}: ${reasonText} ${PENDING_TELL_TEXT} ` +
                  acceptingText(target, fromScope, plan) +
                  `${queued.replacedDraft ? ` It overwrote the earlier draft ${queued.replacedDraft} with the same slug and intent.` : ''}` +
                  // 同 slug、意图不同的草稿没被覆盖，两条都在队列里：点名，免得人两条都收下
                  `${queued.sameSlugDrafts ? ` Another pending draft with the same slug but a different destination or replacement target is still queued: ${queued.sameSlugDrafts.join(', ')}.` : ''}` +
                  staleTail,
              })

              // —— 2) 跨项目 + 常驻：~/.dsh/AGENTS.md 的一章，一律进待确认（第五轮）——
              // AGENTS.md 每轮注入所有项目，写错影响面最大；证据核对只能证明「这几个字出自用户」，
              // 证明不了用户要把它变成处处常驻的规则——所以不论来源、不论证据，都等用户在面板里收下。
              // 章节协议（更新第 N 章 / 标题同名 / newChapter）在进队列**之前**校验，照旧按原因码拒写；
              // 通过后把章号与当时那一章的标题存进草稿，收下时核对（acceptPending），不会再变成「新章追加、出现两份」。
              if (load === 'always') {
                // 取代按需库里的旧条（第十一轮）：跨项目偏好以全局 AGENTS.md 为唯一出处，旧的按需条目不能留着——
                // 否则收下后同一条偏好有两个出处（第十轮复现：强制常驻 + supersedes，收下后旧条仍在全局按需库）。
                // 解析规则与按需写入相同（lookupSuperseded），解析不到照样拒写；现在什么都不动，被取代条目的 id 与所在库记进草稿，
                // 收下时先写章节、写成功后再归档删除（acceptPending）。
                const wantedOld = String(args.supersedes ?? '').trim()
                let superseded = null
                if (wantedOld) {
                  const found = lookupSuperseded(memoryDir, scope, wantedOld)
                  if (found.refusal) return found.refusal
                  superseded = { id: found.target.id, scope: found.crossFrom ? found.crossFrom.scope : scope }
                }
                const plan = planAgentsChapter({ title: args.title, chapter: args.chapter, newChapter: args.newChapter })
                if (!plan.ok) {
                  // 语义重复的拦截：把清单交回去，让调用方自己比一遍再决定
                  if (plan.reason === 'needs-confirmation') {
                    // 章标题在文件里本身带编号（「1. 安全」），以前列表又加一遍成了「1. 1. 安全」，模型可能拿错 chapter 值。
                    // 只留一个编号，而且它就是调用方该传的 chapter：第 N 个 `##` 章（与 planAgentsChapter 的口径相同），
                    // 不是文件里写的那个数字——文件编号断号或没编号时两者不一样。
                    const list = plan.chapters.map((title, i) => `${i + 1}. ${stripChapterNumber(title)}`).join('\n')
                    return {
                      reason: 'needs-confirmation',
                      written: false,
                      text:
                        'NOT written: no existing chapter has this exact title, and this is a global file injected into every ' +
                        'project, so a duplicate must not be added silently.\n\n' +
                        `Existing chapters:\n${list}\n\n` +
                        'If one of them is the same topic, call again with chapter: <number> and a body that merges old and new. ' +
                        'If this really is a new topic, call again with newChapter: true.',
                    }
                  }
                  if (plan.reason === 'chapter-not-found') {
                    return {
                      reason: 'chapter-not-found',
                      written: false,
                      text: `NOT written: ${agentsFileDisplay()} has no chapter ${plan.chapter} (it has ${plan.total}). Pass an existing chapter number, or newChapter: true for a new topic.`,
                    }
                  }
                  return { reason: plan.reason ?? 'write-failed', written: false, text: `NOT written: ${agentsFileDisplay()} cannot take this chapter (${plan.reason ?? 'unknown'}).` }
                }
                const queued = queuePending(memoryDir, {
                  ...draftFields,
                  slug: args.slug,
                  ...(plan.action === 'updated' ? { chapter: plan.chapter, chapterTitle: plan.chapterTitle } : { newChapter: true }),
                  ...(superseded ? { supersedes: superseded.id, supersedesScope: superseded.scope } : {}),
                })
                return pendingReply(queued, superseded, null, plan)
              }

              // —— 3) 两个按需库共用的流程：needs-slug → supersedes → 查重 → 条数上限 → 分流 → 写入 ——
              const libraries = librariesFor(memoryDir)
              const targetDir = libraryDir(memoryDir, scope)
              const other = libraries.find((library) => library.scope !== scope)

              // 文件名是英文 slug（索引行要求英文在前）。标题含非 ASCII 字符又没给 slug 时，
              // writeMemory 会退回「由标题派生」，得到中文文件名——真实库里 3 条有 2 条就是这样来的。
              // 所以这里一个字都不写（连待确认队列也不进），让模型带着 slug 重来。
              const slug = cleanSlug(args.slug)
              if (!slug && /[^\x00-\x7f]/.test(String(args.title ?? ''))) {
                return {
                  reason: 'needs-slug',
                  written: false,
                  text:
                    'NOT written: the title is not plain ASCII and no usable English slug was given, so the memory would get a ' +
                    'non-English file name. Nothing was saved. Call memory_remember again with the same arguments plus ' +
                    'slug: a short English kebab-case name (lowercase ASCII words joined by hyphens), e.g. "no-explanatory-text-in-ui".' +
                    (args.supersedes ? ' To update the memory you are superseding in place, pass its id as the slug.' : ''),
                }
              }

              // 取代谁：先在目标库里找，找不到再到另一个按需库里找（跨库取代，见下面「分流」之后的搬移）。
              // 解析规则见 lookupSuperseded（与常驻写入共用）。
              let target
              let crossFrom // 被取代的条目在另一个库里时，记下那个库：直写前先用 moveMemory 搬过来
              const wanted = String(args.supersedes ?? '').trim()
              if (wanted) {
                const found = lookupSuperseded(memoryDir, scope, wanted)
                if (found.refusal) return found.refusal
                target = found.target
                crossFrom = found.crossFrom
              }

              // —— 写入前查重（在分流之前：进待确认的写入同样不能堆出同主题的条目）——
              // 两个库一起比：跨项目的规则落进项目库、之后又在全局重复一份，是审计里的真实情况。
              // 明确要取代某条时不查重（目标就是那条）。
              if (!target && CONFIG.duplicateCheck && args.newMemory !== true) {
                const candidates = await findSimilarMemories(
                  [{ dir: targetDir, scope }, ...(other ? [other] : [])],
                  `${args.title} ${args.description ?? ''}`,
                  CONFIG.duplicateCandidates,
                )
                const top = candidates.find((row) => row.score >= CONFIG.duplicateThreshold)
                if (top) {
                  const list = candidates
                    .map((row) => `  ${row.id}  [${row.scope}]  (score ${row.score})  ${row.title}`)
                    .join('\n')
                  return {
                    reason: 'needs-review',
                    written: false,
                    // 标题来自记忆文件（可能被手改成任何东西），转成字符串，返回值才符合声明的 schema
                    candidates: candidates.map((row) => ({ id: row.id, title: oneLine(String(row.title ?? row.id)), score: row.score, scope: row.scope })),
                    text:
                      'NOT written: the memory libraries already have something close to this topic, and two memories ' +
                      'that disagree are worse than one.\n\n' +
                      `Closest matches ([project] = this workspace, [global] = all projects):\n${list}\n\n` +
                      `If one of them is the same topic, call again with supersedes: "<id>" — that replaces it (in either library) and ` +
                      'archives the old body. If this really is a separate memory, call again with newMemory: true.',
                  }
                }
              }

              // —— 条数上限：索引每轮注入，条数就是常驻成本（两个库分别计数）——
              // 同库 supersedes 是替换，不增加条数，不该被拦；跨库取代会让目标库多一条，照常检查。
              if (CONFIG.maxMemoryCount > 0 && (!target || crossFrom)) {
                const items = listMemories(targetDir)
                if (items.length >= CONFIG.maxMemoryCount) {
                  // 按「最少被用、最久没读」排淘汰候选：这是现有数据里最接近「该删」的信号
                  const candidates = [...items]
                    .sort((a, b) => {
                      const hitsA = finiteNumber(a.meta?.hits)
                      const hitsB = finiteNumber(b.meta?.hits)
                      if (hitsA !== hitsB) return hitsA - hitsB
                      const readA = String(a.meta?.lastHit ?? a.meta?.modified ?? '')
                      const readB = String(b.meta?.lastHit ?? b.meta?.modified ?? '')
                      return readA.localeCompare(readB)
                    })
                    .slice(0, 5)
                    .map((row) => ({
                      id: row.id,
                      title: oneLine(row.meta?.title ?? row.id),
                      // 手写文件里 hits 可能是任何东西；NaN 进工具输出会让宿主整条拒掉（而不是回一句拒写）
                      hits: finiteNumber(row.meta?.hits),
                      lastHit: typeof row.meta?.lastHit === 'string' ? row.meta.lastHit : null,
                    }))
                  const list = candidates.map((row) => `  ${row.id}  (hits ${row.hits})  ${row.title}`).join('\n')
                  return {
                    reason: 'library-full',
                    written: false,
                    scope,
                    count: items.length,
                    limit: CONFIG.maxMemoryCount,
                    candidates,
                    text:
                      `NOT written: ${libraryLabel(scope)} already holds ${items.length} memories, at the ${CONFIG.maxMemoryCount}-memory ` +
                      'budget. The index is injected into every request, so the count is a per-turn cost.\n\n' +
                      `Least-used memories (best eviction candidates):\n${list}\n\n` +
                      'Either merge this into an existing memory (pass supersedes: "<id>"), or delete/merge one first. ' +
                      'Raise maxMemoryCount if these are all genuinely worth keeping.',
                  }
                }
              }

              // —— 分流：进待确认时把「要取代谁」带进草稿，收下时才真正取代（否则新旧会并存）——
              if (route.route === 'pending') {
                // 跨库取代的草稿也只记 id：acceptPending 收下时先在目标库找，找不到再去另一个库搬（同一个 moveMemory）
                return pendingReply(
                  queuePending(memoryDir, { ...draftFields, slug: slug || undefined, supersedes: target?.id }),
                  target,
                  crossFrom?.scope,
                )
              }

              // 跨库取代：先把旧条搬进目标库（源库 history 留档；目标库同 id / 满了就拒绝，什么都不动），
              // 然后与同库取代走完全相同的路——原地更新或新写一条再删旧的。旧内容在两个库的 history 里都有一份。
              if (crossFrom) {
                const moved = moveMemory(crossFrom.dir, targetDir, target.id, { toScope: scope })
                if (!moved.ok) {
                  return {
                    reason: moved.reason,
                    written: false,
                    scope,
                    text:
                      `NOT written: ${target.id} is in ${libraryLabel(crossFrom.scope)} and could not be moved into ${libraryLabel(scope)} to be replaced (${moved.reason}). ` +
                      (moved.reason === 'target-exists'
                        ? `${libraryLabel(scope)} already has a memory with that id (${moved.existing}); supersede that one instead, or remove one of them with memory_forget first.`
                        : moved.reason === 'move-partial'
                          ? `The move did not complete: both libraries now hold a copy of ${target.id}. Remove the extra one with memory_forget (pass its scope).`
                          : 'Nothing was changed.'),
                  }
                }
                await rebuildVectors(crossFrom.dir)
              }

              // 新 slug 与被取代条目的 id 相同：原地更新（旧版留档，created / hits 保留）。
              // 走「新写一条再删旧的」会因为重名写出 `-2`，文件名就这样被污染了。
              const inPlace = Boolean(target) && slug.toLowerCase() === target.id.toLowerCase()
              const file = writeMemory(targetDir, {
                ...(inPlace ? { id: target.id } : {}),
                slug: slug || undefined,
                // 新 id 同时避开另一个按需库（与库内重名一样加 -2）：两个库同 id 时面板按 id 选不准
                avoidIds: other ? idsOf(other.dir) : [],
                title: args.title,
                description: args.description,
                body: args.body,
                type: args.type,
                tags: args.tags,
                paths: args.paths,
                scope,
                source,
                ...(evidence ? { evidence } : {}),
                ...verifiedField,
                ...(target && !inPlace ? { supersedes: target.id } : {}),
              })
              const id = path.basename(file, '.md')

              // 覆盖旧偏好：新内容换了 slug 时，旧条目必须删掉（deleteMemory 会先归档），
              // 否则「新旧并存」——正是这一步要消灭的情况。
              let replaced = ''
              if (target && !inPlace && id !== target.id) {
                deleteMemory(targetDir, target.id)
                replaced = target.id
              }

              // 同步重建向量，让下一次 recall 立刻能看到这条
              const built = await rebuildVectors(targetDir)

              // 正文偏长只提醒、不拦：正文只在 recall 命中的那一次进上下文，
              // 内容确实需要长就该长，截断会直接丢信息。
              const bodyChars = Buffer.byteLength(String(args.body ?? ''), 'utf8')
              const tooLong = CONFIG.warnBodyChars > 0 && bodyChars > CONFIG.warnBodyChars

              // paths 写得不像路径 → 文件触发提示永远生效不了，必须说出来
              const oddPaths = (Array.isArray(args.paths) ? args.paths : []).filter((entry) => pathHintIssue(entry) !== '')

              // 直写成功后清掉**意图被这次写入完全覆盖**的旧草稿（第五轮加、第六轮改用 draftIntent）：
              // 同 slug、同去向、要取代的条目也相同。第一次证据没核对上进了待确认、重试直写成功时，旧草稿留在队列里，
              // 之后有人收下就多出 `xxx-2`；而「取代 X」的草稿不是这次不带 supersedes 的写入能替代的，留给人处置。
              const clearedDrafts = clearDraftsFor(memoryDir, slug, { scope, load, supersedes: target?.id ?? '' })
              // 索引重建失败要说出来（第六轮）：记忆已经落盘，但每轮注入的索引里没有它
              const indexStale = indexIsStale(targetDir) || (crossFrom ? indexIsStale(crossFrom.dir) : false)

              return {
                id,
                scope,
                file: path.relative(targetDir, file),
                chars: bodyChars,
                // 不能写 `replaced: undefined`——显式的 undefined 不是 lossless JSON，
                // 工具输出校验会整条报错（写入其实已成功，调用方却以为失败）。
                ...(replaced ? { replaced } : {}),
                ...(inPlace ? { updated: true } : {}),
                // 跨库取代：被取代的那条原本在哪个库（它已被搬过来再取代，原库 history 里留有一份）
                ...(crossFrom ? { replacedFrom: crossFrom.scope } : {}),
                ...(clearedDrafts.length > 0 ? { clearedDrafts } : {}),
                ...(oddPaths.length > 0 ? { pathWarnings: oddPaths } : {}),
                ...verifiedField,
                ...(indexStale ? { indexStale: true } : {}),
                ...staleField,
                text:
                  `${inPlace ? 'Updated' : 'Saved'} memory ${id} ${inPlace ? 'in place' : 'to'} ${path.relative(targetDir, file)} in ${libraryLabel(scope)}` +
                  `${inPlace ? ' (the previous version is in history/)' : ''}` +
                  `${replaced ? `, replacing ${replaced} (its old body is in history/)` : ''}` +
                  `${crossFrom ? `; the replaced memory came from ${libraryLabel(crossFrom.scope)} and is no longer there` : ''}` +
                  ` (vector index: ${built.mode}, ${built.indexed} entries).` +
                  `${clearedDrafts.length > 0 ? ` Removed the earlier pending draft${clearedDrafts.length > 1 ? 's' : ''} ${clearedDrafts.join(', ')} with the same slug, destination and replacement target.` : ''}` +
                  `${indexStale ? INDEX_STALE_TEXT : ''}` +
                  `${tooLong ? ` Note: body is ${bodyChars} chars, above the ${CONFIG.warnBodyChars} soft threshold — saved unchanged, but consider splitting it into 2-3 atomic memories for better recall.` : ''}` +
                  `${oddPaths.length > 0 ? ` Warning: ${oddPaths.map((entry) => JSON.stringify(entry)).join(', ')} do not look like file paths, so the file-triggered hint will never match them. Use paths relative to the workspace root, e.g. "dsh-workspace-memory/index.js".` : ''}` +
                  // 直写成功：说清「已生效、不用确认」（评测里模型把直写说成了「在面板里等你确认」）。
                  // 放在过期值提示之前：那句提示按 §4.6 固定在全文最后（没有过期值时这句就是最后一句）。
                  ` ${ACTIVE_NOW_TEXT}` +
                  staleTail,
              }
            })()
            const staleTail = stalenessNote(stalenessHints(args.body, args.type))
            if (keptFor) return withKeptAsMemory(result, keptFor, staleTail)
            return loadForced ? withLoadForced(result, staleTail) : result
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            return { text: `Could not save the memory: ${detail}` }
          }
        },
      }),
    'memory_remember registration',
  )

  /* —— memory_recall ————————————————————————————————————————— */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'memory_recall',
        // 只写做什么、返回什么（官方 tool-design.md：Describe behavior, not implementation）。
        // 「怎么按 id 取」写在 query 参数上；检索方式、降级提示是实现与结果里的标记，不写进说明。
        description:
          "Search saved memories in this workspace's library and the all-projects library, and return the closest matches " +
          'with full bodies, file paths, scope and the date each was last updated. An empty result means nothing relevant is recorded.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you are trying to remember, or an exact memory id.' },
            limit: { type: 'number', description: 'Max results, 1..20. Default 5.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        output: textOutput(RECALL_OUTPUT_SCHEMA),
        async execute(args, exec) {
          try {
            const memoryDir = memoryDirOf(ctx, { agent: exec?.agent })
            if (!memoryDir) return { text: '无法定位工作区记忆库：当前会话没有可用工作目录。' }
            const libraries = librariesFor(memoryDir)
            const query = String(args?.query ?? '')
            // 「现在」取一次，id 与检索两条路径同一个基准（测试经 setClockForTests 注入）
            const now = clockImpl()
            // 标题行后一段「写于何时」：系统提示段让模型照做前先确认，它得知道这条有多旧
            const render = (results) =>
              results
                .map((row, i) => {
                  const age = ageNote(row)
                  return (
                    `${i + 1}. [${row.type}] ${row.title}  (${row.scope === 'global' ? 'all projects' : 'this workspace'}; score ${row.score}; vec ${row.vector}; kw ${row.keyword})` +
                    `${age ? `\n   ${age}` : ''}\n   ${row.file}\n\n${row.body}`
                  )
                })
                .join('\n\n---\n\n')

            // 按 id 取全文：索引行、预取与 paths 提示给的都是 id。先项目库后全局库，两处都有就都给。
            const wantedId = query.trim()
            if (wantedId && isSafeId(wantedId)) {
              const exact = libraries
                .map((library) => ({ library, item: listMemories(library.dir).find((row) => row.id === wantedId) }))
                .filter((entry) => entry.item)
              if (exact.length > 0) {
                for (const { library, item } of exact) recordHits(library.dir, [item.id])
                const results = exact.map(({ library, item }) => ({
                  id: item.id,
                  scope: library.scope,
                  title: item.meta.title || item.body.split(/\r?\n/)[0] || item.id,
                  type: item.meta.type ?? 'project',
                  tags: Array.isArray(item.meta.tags) ? item.meta.tags : [],
                  score: 1,
                  vector: 0,
                  keyword: 1,
                  body: item.body,
                  chars: Buffer.byteLength(String(item.body ?? ''), 'utf8'),
                  file: path.relative(library.dir, item.file),
                  ...memoryAge(item.meta, now),
                }))
                return { mode: 'id', results, text: render(results) }
              }
            }

            const found = await recallLibraries(libraries, query, args?.limit ?? 5, { now })
            if (found.results.length === 0) {
              return {
                mode: found.mode,
                results: [],
                text: `No memory matched "${query}" (mode: ${found.mode}). Treat this as "not recorded".`,
              }
            }
            // 退化必须说出口：leanvec 不可用时检索只剩关键词通道，质量会明显下降。
            // 静默降级比报错更坏——你会以为"库里没有"，其实只是没检索到。
            const warning =
              found.mode === 'keyword'
                ? '\n\n[注意] 本地嵌入模型不可用，本次只用了关键词检索，召回质量下降。用 memory_status 查看详情。'
                : ''
            return { mode: found.mode, results: found.results, text: render(found.results) + warning }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            return { text: `Recall failed: ${detail}` }
          }
        },
      }),
    'memory_recall registration',
  )

  /* —— memory_forget ————————————————————————————————————————— */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'memory_forget',
        // 「两个库都有时传 scope」写在 scope 参数上，不在说明里重复（官方 tool-design.md：Say each fact once）
        description: 'Delete one memory by id when it is outdated or wrong. Returns whether it was removed and from which library.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Exact memory id from MEMORY.md or memory_recall.' },
            scope: {
              type: 'string',
              enum: ['project', 'global'],
              description: "Which library: 'project' = this workspace, 'global' = the all-projects on-demand library. Optional unless the id is in both.",
            },
          },
          required: ['id'],
          additionalProperties: false,
        },
        output: textOutput(FORGET_OUTPUT_SCHEMA),
        async execute(args, exec) {
          try {
            const memoryDir = memoryDirOf(ctx, { agent: exec?.agent })
            if (!memoryDir) return { text: '无法定位工作区记忆库：当前会话没有可用工作目录。' }
            const id = String(args?.id ?? '').trim()
            // id 会逃出记忆目录（`../..`、路径分隔符）时直接拒绝，不去碰任何文件
            if (!isSafeId(id)) {
              return {
                removed: false,
                reason: 'invalid-id',
                text: `Invalid memory id ${JSON.stringify(id.slice(0, 80))}. Use the exact id from MEMORY.md or memory_recall (a file name without ".md", no path separators).`,
              }
            }
            const requested = args?.scope === 'global' || args?.scope === 'project' ? args.scope : ''
            const found = requested ? [{ scope: requested, dir: libraryDir(memoryDir, requested) }] : locateMemory(memoryDir, id)
            // 两个库都有同一个 id 又没说删哪个：不猜，猜错就删了另一条
            if (found.length > 1) {
              return {
                removed: false,
                reason: 'scope-ambiguous',
                locations: found.map((library) => ({ scope: library.scope, file: path.join(library.dir, `${id}.md`) })),
                text:
                  `NOT deleted: ${id} exists in both libraries:\n` +
                  found.map((library) => `  [${library.scope}] ${path.join(library.dir, `${id}.md`)}`).join('\n') +
                  '\nCall again with scope: "project" or scope: "global".',
              }
            }
            const library = found[0]
            const removed = library ? deleteMemory(library.dir, id) : false
            if (removed) await rebuildVectors(library.dir)
            // 索引重建失败要说出来（第六轮）：文件已删，但每轮注入的索引里还列着它
            const indexStale = removed && indexIsStale(library.dir)
            return {
              removed,
              ...(removed ? { scope: library.scope } : {}),
              ...(indexStale ? { indexStale: true } : {}),
              text: removed
                ? `Deleted memory ${id} from ${libraryLabel(library.scope)}.${indexStale ? INDEX_STALE_TEXT : ''}`
                : `No memory with id ${id}.`,
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            return { removed: false, text: `Could not delete the memory: ${detail}` }
          }
        },
      }),
    'memory_forget registration',
  )

  /* —— memory_status ————————————————————————————————————————— */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'memory_status',
        description:
          'Report the state of memory for troubleshooting: entry counts and index size of both libraries, pending drafts, ' +
          'whether recall runs at full quality or keyword-only, how agent-sourced memories are routed, and configuration problems.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOutput(STATUS_OUTPUT_SCHEMA),
        async execute(_args, exec) {
          try {
            // 当前 agent 自己最近一次的证据核对（按 agent 记，多会话不串）
            const lastCheck = exec?.agent?.id ? lastEvidenceChecks.get(exec.agent.id) : undefined
            const memoryDir = memoryDirOf(ctx, { agent: exec?.agent })
            if (!memoryDir) {
              return { evidenceSource: lastCheck ? lastCheck.via : 'none', text: '无法定位工作区记忆库：当前会话没有可用工作目录。' }
            }
            const libraries = librariesFor(memoryDir)
            const embedder = await resolveEmbedder()
            const lines = []
            const staleLibraries = []
            for (const library of libraries) {
              const items = listMemories(library.dir)
              const index = readIndexForInjection(
                library.dir,
                library.scope === 'global' ? { maxLines: CONFIG.globalIndexMaxLines } : {},
              )
              const vectors = loadVectors(library.dir)
              const limitLines = library.scope === 'global' ? CONFIG.globalIndexMaxLines : CONFIG.indexMaxLines
              // 索引（MEMORY.md）列出的条目数与记忆文件数对不上：上次重建失败（第六轮，见 rebuildIndexQuietly）
              const listed = indexEntryCount(library.dir)
              const stale = listed !== items.length
              if (stale) staleLibraries.push(library.scope)
              lines.push(
                `[${library.scope}] root: ${library.dir}`,
                `[${library.scope}] memories: ${items.length}${CONFIG.maxMemoryCount > 0 ? ` (limit ${CONFIG.maxMemoryCount})` : ''}`,
                `[${library.scope}] index: ${Buffer.byteLength(index, 'utf8')} bytes, ${index ? index.split(/\r?\n/).length : 0} lines injected (limit ${CONFIG.indexMaxBytes} / ${limitLines})`,
                ...(stale
                  ? [
                      `[${library.scope}] index out of date: MEMORY.md lists ${listed === null ? 'nothing (unreadable)' : `${listed} entries`} but there are ${items.length} memory files; ` +
                        'memories missing from it are not shown in the per-turn index. Fix: /memory reindex.',
                    ]
                  : []),
                `[${library.scope}] vectors: ${vectors ? `${vectors.entries.length} entries in memory, built ${vectors.builtAt}` : 'none yet (rebuilt in memory on first recall)'}`,
              )
            }
            const checkState = lastCheck ? (lastCheck.missing ? 'no evidence given' : lastCheck.verified ? 'verified' : 'not verified') : ''
            lines.push(
              `pending drafts: ${listPending(memoryDir).length}`,
              `agentWrites: ${CONFIG.agentWrites} (${CONFIG.agentWrites === 'direct' ? 'agent-sourced on-demand writes go straight in' : 'agent-sourced writes wait in the review queue'}; load "always" always waits for review)`,
              `embedder: ${embedder ? 'leanvec (dim 256)' : 'unavailable -> keyword-only recall'}`,
              `recall: minVector=${CONFIG.minVectorScore} minKeyword=${CONFIG.minKeywordScore} weights=${CONFIG.weightVector}/${CONFIG.weightKeyword}`,
              `extraction: ${CONFIG.enableExtraction ? 'on' : 'off'}`,
              // 证据核对走的哪一路：prestep-cache 是主路径；总是 snapshot-fallback 说明 pre-step 缓存没收到用户消息
              `last evidence check: ${lastCheck ? `${lastCheck.via} (${checkState})` : 'none'}`,
              `config issues: ${configIssues.length === 0 ? 'none' : configIssues.join(' | ')}`,
            )
            return {
              evidenceSource: lastCheck ? lastCheck.via : 'none',
              ...(staleLibraries.length > 0 ? { indexStale: true, staleLibraries } : {}),
              text: lines.join('\n'),
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            return { text: `Status unavailable: ${detail}` }
          }
        },
      }),
    'memory_status registration',
  )

  /* —— /memory ——————————————————————————————————————————————— */
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'memory',
        description:
          '查看与管理工作区记忆：/memory（总览）| list | pending | accept <id> | reject <id> | extract | forget <id> | reindex',
        // 补全菜单只补「命令名」，子命令补不出来；input.hint 就是给参数留的提示位，
        // 否则用户只能靠猜 /memory 后面能跟什么（extract 一度因此被认为不存在）。
        input: {
          hint: 'list | pending | accept <id> | reject <id> | extract | forget <id> | reindex',
        },
        handler: (invocation) => executeMemoryCommand(ctx, invocation),
      }),
    'memory command registration',
  )

  /* —— 无参子命令各注册一个独立命令 ——————————————————————————————
   * 为什么要拆：DSH 的命令补全只补**命令名**，没有参数级补全
   * （client Service 里没有任何 completion 接口）。所以想让用户从列表里点选
   * `/memory extract`，只能把 extract 本身注册成一个命令。
   * 带 id 的 accept / reject / forget 不拆分——选完还得手打 id，
   * 那几个操作在面板的待确认/详情页里点按钮更省事。
   */
  // 这两个子命令**不接受参数**，所以不能声明 input：
  // DSH 要求 input.hint 非空（实测 `input hint must not be empty` 会让整个插件激活失败）。
  const SUBCOMMAND_ENTRIES = [
    {
      name: 'memory_extract',
      description: '立即跑一次记忆抽取（不受自动抽取开关影响），结果进入待确认队列',
    },
    {
      name: 'memory_pending',
      description: '查看待确认的记忆草稿；在面板「待确认」页签里可逐条收下或丢弃',
    },
  ]

  for (const entry of SUBCOMMAND_ENTRIES) {
    const sub = entry.name.slice('memory_'.length)
    ctx.effect(
      () =>
        ctx.commands.register({
          name: entry.name,
          description: entry.description,
          handler: (invocation) => executeMemoryCommand(ctx, invocation, sub),
        }),
      `${entry.name} registration`,
    )
  }

  /* —— /memory_list ——————————————————————————————————————————
   * 这个命令自身只回一行确认文案。真正的动作在客户端半区：命令结果卡片挂载时
   * 打开右侧栏并切到记忆面板（见 client.js 里 key='memory_list' 的卡片）。
   * 这样不需要给命令增加任何「开窗口」的宿主能力，复用的是已文档化的插槽扩展点。 */
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'memory_list',
        description: '在右侧栏打开记忆面板：卡片式浏览、编辑并保存工作区记忆',
        handler: (invocation) => {
          try {
            const memoryDir = memoryDirOf(ctx, { agent: invocation?.agent })
            if (!memoryDir) {
              return { kind: 'error', text: '无法定位工作区记忆库：当前会话没有可用工作目录。' }
            }
            const count = listMemories(memoryDir).length
            return {
              kind: 'success',
              text: `右侧栏已打开记忆面板（${count} 条记忆）。可直接在卡片里编辑并保存。`,
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            return { kind: 'error', text: `无法打开记忆面板：${detail}` }
          }
        },
      }),
    'memory_list command registration',
  )
}

/* --------------------------------------------------------------- 命令实现 */

/**
 * 执行 /memory 及其子命令。
 *
 * `forcedSub` 用于「把子命令注册成独立命令」的场景（如 memory_pending / memory_extract）：
 * DSH 只补全命令名、不支持参数补全，所以想让子命令出现在选择列表里，只能各注册一个命令。
 * 这里把 forcedSub 塞回 argv 开头，后续所有 `argv[1]` 的取值逻辑保持不变。
 */
async function executeMemoryCommand(ctx, invocation, forcedSub) {
  let memoryDir
  let argv
  try {
    // 无参命令（memory_pending / memory_extract）没声明 input，宿主给不给 rawInput 都不能让这里抛出去
    const parsed = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
    argv = forcedSub ? [forcedSub, ...parsed] : parsed
    memoryDir = memoryDirOf(ctx, { agent: invocation?.agent })
    if (!memoryDir) {
      return { kind: 'error', text: '无法定位工作区记忆库：当前会话没有可用工作目录。' }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `Could not resolve the memory root: ${detail}` }
  }
  const sub = argv[0] ?? 'overview'

  try {
    if (sub === 'overview' || sub === '') {
      const items = listMemories(memoryDir)
      const index = readIndexForInjection(memoryDir)
      const vectors = loadVectors(memoryDir)
      const embedder = await resolveEmbedder()
      const byType = new Map()
      for (const item of items) {
        const type = item.meta.type ?? 'project'
        byType.set(type, (byType.get(type) ?? 0) + 1)
      }
      const globalLibrary = librariesFor(memoryDir).find((library) => library.scope === 'global')
      const lines = [
        `Memory root: ${memoryDir}`,
        `Memories: ${items.length}`,
        ...MEMORY_TYPES.filter((type) => byType.has(type)).map((type) => `  ${type}: ${byType.get(type)}`),
        `Index: ${Buffer.byteLength(index, 'utf8')} bytes / ${index.split(/\r?\n/).length} lines`,
        ...(globalLibrary
          ? [`Global (all projects, on-demand): ${listMemories(globalLibrary.dir).length} memories in ${globalLibrary.dir}`]
          : []),
        `Agent-sourced writes: ${CONFIG.agentWrites}`,
        `Embedder: ${embedder ? 'leanvec dim 256' : 'unavailable (keyword-only)'}`,
        `Vectors: ${vectors ? `${vectors.entries.length} entries` : 'not built'}`,
        '',
        'Subcommands: /memory list | /memory pending | /memory accept <id> | /memory reject <id> | /memory extract | /memory forget <id> [project|global] | /memory reindex',
        CONFIG.enableExtraction
          ? 'Extraction is ON (every N turns); /memory extract runs it now.'
          : 'Extraction is OFF in config; /memory extract still runs it once on demand.',
      ]
      return { kind: 'success', text: lines.join('\n') }
    }

    if (sub === 'list') {
      // 两个库都列出来，每行标出所在的库（project = 本工作区，global = 所有项目按需）
      const rows = librariesFor(memoryDir).flatMap((library) =>
        listMemories(library.dir).map((item) => {
          const title = item.meta.title || item.body.split(/\r?\n/)[0] || item.id
          return `${item.id}  [${item.meta.type ?? 'project'}]  [${library.scope}]  ${title}`
        }),
      )
      if (rows.length === 0) return { kind: 'success', text: 'No memories recorded yet.' }
      return { kind: 'success', text: rows.join('\n') }
    }

    if (sub === 'reindex') {
      // 两个库都重建：手改过全局按需库文件后，同样需要这条出路
      const lines = []
      for (const library of librariesFor(memoryDir)) {
        // 全局按需库还不存在时不要凭空建出来
        if (library.scope === 'global' && !existsSync(library.dir)) continue
        const rebuilt = rebuildIndex(library.dir)
        const built = await rebuildVectors(library.dir)
        const prefix = library.scope === 'global' ? 'Global index rebuilt' : 'Index rebuilt'
        lines.push(
          `${prefix}: ${rebuilt.count} memories, ${rebuilt.lineCount} lines / ${rebuilt.byteCount} bytes.`,
          `Vector index: ${built.mode}${built.indexed !== undefined ? `, ${built.indexed} entries` : ''}.`,
        )
      }
      return { kind: 'success', text: lines.join('\n') }
    }

    if (sub === 'pending') {
      const drafts = listPending(memoryDir)
      if (drafts.length === 0) {
        return {
          kind: 'success',
          text: CONFIG.enableExtraction
            ? '待确认队列为空。抽取已开启（每 N 回合自动跑一次），也可以手动 /memory extract。'
            : '待确认队列为空。自动抽取未开启（config 里 enableExtraction），可以用 /memory extract 手动跑一次。',
        }
      }
      // 每条标出收下后的去向（scope × load），以及来源：模型自己得出的要多看一眼
      const destination = ({ scope, load }) =>
        load === 'always'
          ? scope === 'global'
            ? `→ ${agentsFileDisplay()}（每轮常驻）`
            : '→ 本项目常驻（应写进项目 AGENTS.md，插件不收）'
          : scope === 'global'
            ? '→ 所有项目（按需）'
            : '→ 本工作区'
      const lines = drafts.map((item) => {
        const title = item.meta.title || item.body.split(/\r?\n/)[0] || item.id
        const from = sourceLabel(item.meta)
        return `${item.id}  [${item.meta.type ?? 'project'}]  ${title}  ${destination(draftTarget(item.meta))}${from}`
      })
      return {
        kind: 'success',
        text: [`待确认 ${drafts.length} 条：`, ...lines, '', '用 /memory accept <id> 收下，/memory reject <id> 丢弃'].join('\n'),
      }
    }

    if (sub === 'accept' || sub === 'reject') {
      const targetId = argv[1]
      if (!targetId) return { kind: 'error', text: `用法：/memory ${sub} <id>` }
      if (sub === 'accept') {
        const result = await acceptPending(memoryDir, targetId)
        if (!result.ok) return { kind: 'error', text: result.error }
        // 常驻草稿收下后进的是 AGENTS.md，没有记忆文件也没有向量
        if (!result.file) {
          return {
            kind: 'success',
            text:
              `已收下 ${targetId} → 全局 AGENTS.md（${result.action === 'updated' ? '更新了一章' : '新增了一章'}）` +
              // 常驻草稿取代的旧记忆（第十一轮）
              `${result.replaced ? `，删除了旧记忆 ${result.replaced}（旧版在历史里）` : ''}` +
              `${result.replacedMissing ? `；要取代的旧记忆 ${result.replacedMissing} 已不存在，只写了章节` : ''}` +
              `${result.replaceFailed ? `；旧记忆 ${result.replaceFailed} 没能删除，请手动删除` : ''}`,
          }
        }
        return {
          kind: 'success',
          text:
            `已收下 ${targetId} → ${result.scope === 'global' ? '所有项目（按需）库' : '本工作区记忆库'} ${result.file}` +
            `${result.replaced ? `，取代 ${result.replaced}（旧版在历史里）` : ''}` +
            `（向量 ${result.vectorMode}, ${result.vectorCount} 条）`,
        }
      }
      const result = rejectPending(memoryDir, targetId)
      if (!result.ok) return { kind: 'error', text: result.error }
      return { kind: 'success', text: `已丢弃 ${targetId}` }
    }

    if (sub === 'extract') {
      // manual: true —— 显式命令不受 enableExtraction 影响
      const result = await extractFromTurn(ctx, invocation?.agent, memoryDir, { manual: true })
      if (result.skipped) {
        return { kind: 'error', text: `未抽取：${result.skipped}${result.raw ? `\n模型原始输出片段：${result.raw}` : ''}` }
      }
      return {
        kind: 'success',
        text: [
          `抽取完成：候选 ${result.candidates} 条 → 入队 ${result.queued} 条（其中 ${result.unverified} 条声称是用户说的、` +
            `但证据没核实到，以「未核实」入队），去重丢弃 ${result.deduped} 条` +
            // 「不是记忆」的三类（流程 / 仓库规则 / 文档）跳过不入队；只在有时才说，免得每次多一句
            `${result.routed > 0 ? `，${result.routed} 条不是记忆（流程 / 仓库规则 / 文档）已跳过` : ''}。`,
          result.queued > 0 ? '用 /memory pending 查看，/memory accept <id> 收下。' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    }

    /**
     * 删除一条已确认的记忆：`/memory forget <id> [project|global]`。
     *
     * 之前没有这个入口：`memory_forget` 工具只有模型能调，面板只能改不能删。
     * 而直接入库的记忆记错了人却删不掉，闭环就是断的。删除会先留历史版本（deleteMemory 内部），可回退。
     * 两个库都找；同一个 id（或唯一前缀）两个库都命中时不猜，要求写明库。
     */
    if (sub === 'forget' || sub === 'delete') {
      const targetId = argv[1]
      if (!targetId) return { kind: 'error', text: `用法：/memory ${sub} <id> [project|global]（用 /memory list 查 id）` }
      const wantedScope = argv[2] === 'project' || argv[2] === 'global' ? argv[2] : ''
      const libraries = librariesFor(memoryDir).filter((library) => !wantedScope || library.scope === wantedScope)
      // 先精确匹配，再按前缀匹配，方便少打几个字符
      const exact = libraries.flatMap((library) =>
        listMemories(library.dir).filter((item) => item.id === targetId).map((item) => ({ library, item })),
      )
      const byPrefix =
        exact.length > 0
          ? []
          : libraries.flatMap((library) =>
              listMemories(library.dir).filter((item) => item.id.startsWith(targetId)).map((item) => ({ library, item })),
            )
      const matches = exact.length > 0 ? exact : byPrefix
      if (matches.length !== 1) {
        if (matches.length === 0) return { kind: 'error', text: `没有 id 为「${targetId}」的记忆。用 /memory list 查看。` }
        return {
          kind: 'error',
          text:
            `「${targetId}」匹配到 ${matches.length} 条，请写完整 id，同名时在后面加 project 或 global：` +
            matches.map(({ library, item }) => `${item.id} [${library.scope}]`).join(', '),
        }
      }
      const { library, item: target } = matches[0]
      if (!deleteMemory(library.dir, target.id)) {
        return { kind: 'error', text: `删除失败：${target.id} 不存在` }
      }
      const built = await rebuildVectors(library.dir)
      return {
        kind: 'success',
        text: `已删除 ${target.id}（${library.scope === 'global' ? '所有项目按需库' : '本工作区'}；历史留档可回退；向量 ${built.mode}, ${built.indexed} 条）`,
      }
    }

    return {
      kind: 'error',
      text: `Unknown subcommand "${sub}". Use: /memory | /memory list | /memory pending | /memory accept <id> | /memory reject <id> | /memory extract | /memory forget <id> [project|global] | /memory reindex`,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `Memory command failed: ${detail}` }
  }
}
