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
 * 向量索引**不落盘**，只活在进程内存里（见 vectorStore）。
 */

import { existsSync } from 'node:fs'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

/** 记忆类型，对齐 Claude Code 的 4 种。 */
const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']

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

  /** 诊断端点。默认关：它是给「没有浏览器控制」时排查用的，不该常驻。 */
  enableDiagEndpoint: false,

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
   * 全局指令文件。空 = `~/.dsh/AGENTS.md`（DSH 每个会话都会加载它）。
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
   * 抽取准入的置信度门槛。
   *
   * `confidence` 是**模型自评**，不是用户判断，所以：UI 只读、由模型填。
   * 它唯一的用途就是这个门槛：低于它的候选不写进待确认队列。
   * 丢弃数量会在 /memory extract 的结果里明说，不做静默丢弃。
   *
   * 注意模型漏填时会兜底成 0.6，正好等于默认门槛——即"漏填＝放行"，
   * 避免模型少写一个字段就把整批候选清空。
   */
  minExtractConfidence: 0.6,

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

  /**
   * `memory_remember` 的直写门槛。
   *
   * 模型自评置信度 ≥ 这个值时直接入库；低于它则写进待确认队列，由人收下或丢弃。
   * 依据：模型自己都说没把握的条目，不该绕过人的判断直接进库。
   * 设为 0 等于「全部直接入库」，设为 1 等于「全部要人确认」。
   */
  directWriteConfidence: 0.8,
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
  minExtractConfidence: [0, 1],
  directWriteConfidence: [0, 1],
  historyLimit: [0, 200],
}

const BOOLEAN_KEYS = ['enableDiagEndpoint', 'enableExtraction', 'duplicateCheck', 'pathsHint', 'prefetchRecall']

/**
 * 纯字符串选项（空串表示「用默认值」）。
 *
 * `agentsFile` / `editorExe` 原本就在 DEFAULT_CONFIG 里，但 resolveConfig 没有对应的
 * 处理分支：它们通过了「已知键」检查后既不写入结果也不报错——**被静默丢弃**。
 * 配置项写了却根本不生效，比直接报错更糟（`editorExe` 因此一直没生效过）。
 */
const STRING_KEYS = ['agentsFile', 'editorExe']

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
    if (!(key in DEFAULT_CONFIG)) {
      issues.push(`${key}: 未知配置项，已忽略`)
      continue
    }

    if (key === 'memoryDir') {
      if (typeof value !== 'string') {
        issues.push('memoryDir: 必须是字符串')
        continue
      }
      const trimmed = value.trim()
      if (trimmed === '') {
        out.memoryDir = ''
        continue
      }
      const expanded = trimmed.startsWith('~')
        ? path.join(os.homedir(), trimmed.slice(1))
        : trimmed
      if (!path.isAbsolute(expanded)) {
        issues.push('memoryDir: 必须是绝对路径或以 ~ 开头')
        continue
      }
      out.memoryDir = expanded
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
      out[key] = value.trim()
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

  return { config: out, issues }
}

/* ------------------------------------------------------------ 根目录与路径 */

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

/** 已注册的 DSH 工作区根路径。apply() 时抓一次，供同步解析使用。 */
let workspaceRoots = []

/**
 * 项目根：取「包含 cwd 的最长已注册工作区路径」，没有已注册工作区就退回 cwd。
 *
 * 为什么不用 git repo root（Claude Code 的做法）：这个工作区里每个子项目
 * （dsh-profile-stats、dsh-command-context …）各自是一个 git 仓库，用 git root
 * 会让每个子项目各建一个记忆库。DSH 有 workspaceRegistry，用它才是原生做法，
 * 也正好满足「整个工作区共用一个库」。
 */
function projectRootFor(cwd) {
  const abs = path.resolve(cwd)
  let best = ''
  for (const root of workspaceRoots) {
    if (!root) continue
    const normalized = path.resolve(String(root))
    if (abs === normalized || abs.startsWith(normalized + path.sep)) {
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
  return path.join(os.homedir(), '.dsh', 'projects', encodeProjectPath(projectRootFor(cwd)), 'memory')
}

const ensureDir = (dir) => mkdirSync(dir, { recursive: true })
/** 记忆文件与 MEMORY.md 同级平铺（同 Claude Code），没有 memories/ 子目录。 */
const memoriesPath = (memoryDir) => memoryDir
const indexPath = (memoryDir) => path.join(memoryDir, INDEX_FILE)

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
    const dir = path.join(historyPath(memoryDir), id)
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
    const dir = path.join(historyPath(memoryDir), id)
    if (!existsSync(dir)) return []
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

/** 极简 YAML frontmatter 解析：只认 `key: value` 与 `key: [a, b]`。 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { data: {}, body: text }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    const [, key, rawValue] = kv
    const value = rawValue.trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else {
      data[key] = value.replace(/^["']|["']$/g, '')
    }
  }
  return { data, body: match[2] }
}

function serializeFrontmatter(data, body) {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      lines.push(`${key}: [${value.map((v) => String(v)).join(', ')}]`)
    } else {
      lines.push(`${key}: ${value}`)
    }
  }
  lines.push('---', '')
  return `${lines.join('\n')}\n${String(body).trimEnd()}\n`
}

/* ---------------------------------------------------------------- 记忆读写 */

/**
 * 标题派生的兜底 slug：只在调用方没给英文 slug 时使用。
 * 中文保留，只把非法文件名字符与空白换成 `-`。
 */
export function slugify(title) {
  const cleaned = String(title ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\r\n\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
  return cleaned || `memory-${Date.now().toString(36)}`
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

/** 在目录里挑一个不与别的记忆冲突的 slug（selfId 是「自己」，不参与冲突）。 */
function uniqueSlug(memoryDir, base, selfId) {
  const taken = new Set(listMemories(memoryDir).map((item) => item.id).filter((id) => id !== selfId))
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
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

/** 读一条记忆（含 frontmatter）。文件不存在返回 undefined。 */
function readMemory(memoryDir, id) {
  const file = path.join(memoriesPath(memoryDir), `${id}.md`)
  if (!existsSync(file)) return undefined
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

/**
 * 列出全部记忆元信息。走内存缓存，只对变更过的文件重新读盘解析。
 */
export function listMemories(memoryDir) {
  const dir = memoriesPath(memoryDir)
  if (!existsSync(dir)) return []
  const out = []
  const alive = new Set()
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
  for (const key of memoryCache.keys()) {
    if (!alive.has(key)) memoryCache.delete(key)
  }
  return out.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
}

/**
 * 写一条记忆并重建索引。返回落盘路径。
 *
 * 文件名 = 由标题派生的 slug（与 Claude Code 一致），所以：
 *   · 新建时按标题生成；
 *   · **改标题会同步重命名文件** —— 否则索引指向旧名、文件名和内容对不上；
 *   · 撞名时自动加 `-2` / `-3`，绝不覆盖别人的记忆。
 */
export function writeMemory(memoryDir, input) {
  const existing = input.id ? readMemory(memoryDir, input.id) : undefined
  // 没传 type 时必须沿用原值，不能一律回落成 project——
  // 否则「只改摘要」这类局部更新会静默把分类冲掉。
  const type = MEMORY_TYPES.includes(input.type)
    ? input.type
    : MEMORY_TYPES.includes(existing?.meta?.type)
      ? existing.meta.type
      : 'project'
  const now = new Date().toISOString()

  const body = input.body ?? existing?.body ?? input.title ?? ''
  const title =
    String(input.title ?? existing?.meta?.title ?? '').trim() || firstLine(body) || existing?.id || 'memory'

  // 文件名 = 英文 slug。规则：
  //   · 显式给 slug 且与当前不同 → 重命名（标题变化本身不再触发重命名，
  //     因为文件名现在是独立标识，不再从中文标题派生）；
  //   · 新建且没给 slug → 退回标题派生（中文标题会得到中文文件名，属于降级路径）；
  //   · 其余情况保持原 id。
  const requestedSlug =
    typeof input.slug === 'string' && input.slug.trim() !== '' ? asciiSlug(input.slug) : ''

  let id = existing?.id ?? (input.id ? String(input.id) : '')
  if (!id) {
    id = uniqueSlug(memoryDir, requestedSlug || slugify(title), null)
  } else if (requestedSlug && requestedSlug !== id) {
    id = uniqueSlug(memoryDir, requestedSlug, id)
  }

  // description 就是 MEMORY.md 里那一行的摘要：索引与正文是同一份数据的两个投影。
  //   · 显式给了就用给的；
  //   · 正文变了且没给，就按新正文重新取首行（否则索引摘要会和正文对不上）；
  //   · 正文没变就保持原摘要，避免只改标签也把摘要冲掉。
  const nextBody = String(body ?? '')
  const bodyChanged = !existing || nextBody.trim() !== String(existing.body ?? '').trim()
  let description
  if (input.description !== undefined) {
    description = String(input.description).trim()
  } else if (existing && !bodyChanged) {
    description = String(existing.meta.description ?? '').trim() || firstLine(nextBody) || title
  } else {
    description = firstLine(nextBody) || String(existing?.meta?.description ?? '').trim() || title
  }

  const meta = {
    name: id,
    description,
    // scope 只是提示（提示该不该挪去全局的 AGENTS.md），不影响存放位置
    scope: input.scope === 'global' ? 'global' : input.scope === 'project' ? 'project' : (existing?.meta?.scope ?? 'project'),
    type,
    status: input.status ?? existing?.meta?.status ?? 'confirmed',
    tags: input.tags ?? existing?.meta?.tags ?? [],
    paths: input.paths ?? existing?.meta?.paths ?? [],
    created: input.created ?? existing?.meta?.created ?? now,
    modified: now,
    confidence: input.confidence ?? existing?.meta?.confidence ?? '0.8',
    // 这条记忆取代了哪一条（覆盖旧偏好时留下可追溯的线索）
    supersedes: input.supersedes ?? existing?.meta?.supersedes ?? undefined,
    title,
  }

  ensureDir(memoriesPath(memoryDir))
  const file = path.join(memoriesPath(memoryDir), `${id}.md`)
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
  writeFileSync(file, nextRaw, 'utf8')

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
  rebuildIndex(memoryDir)
  return file
}

/** 删一条记忆。返回是否真的删掉了。 */
export function deleteMemory(memoryDir, id) {
  const file = path.join(memoriesPath(memoryDir), `${id}.md`)
  if (!existsSync(file)) return false
  // 删除同样留档——取代/清理都可能是误操作
  const current = readMemory(memoryDir, id)
  if (current?.raw) archiveVersion(memoryDir, id, current.raw)
  rmSync(file, { force: true })
  memoryCache.delete(file)
  rebuildIndex(memoryDir)
  return true
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

/** 写一条待确认记忆。返回落盘路径。 */
export function writePending(memoryDir, input) {
  const type = MEMORY_TYPES.includes(input.type) ? input.type : 'project'
  const id = input.id ?? `dr_${Date.now().toString(36)}`
  const now = new Date().toISOString()
  const file = path.join(pendingPath(memoryDir), `${id}.md`)
  ensureDir(pendingPath(memoryDir))
  writeFileSync(
    file,
    serializeFrontmatter(
      {
        id,
        // 草稿阶段就记下英文 slug 与摘要，accept 时直接沿用
        slug: input.slug ? asciiSlug(input.slug) : undefined,
        description: input.description,
        scope: input.scope === 'global' ? 'global' : 'project',
        type,
        status: 'draft',
        tags: input.tags ?? [],
        // paths 也要带上：accept 后写库时一并沿用，否则路径触发信息会丢
        paths: Array.isArray(input.paths) ? input.paths : [],
        created: now,
        modified: now,
        confidence: input.confidence ?? '0.6',
        title: input.title,
      },
      input.body ?? '',
    ),
    'utf8',
  )
  return file
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

/** 收下一条待确认记忆：搬进正式库（文件名用 slug）并重建索引与向量。 */
export async function acceptPending(memoryDir, id) {
  const file = path.join(pendingPath(memoryDir), `${id}.md`)
  if (!existsSync(file)) return { ok: false, error: `待确认队列里没有 ${id}` }
  try {
    const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))

    // 草稿如果是「全局」的，收下时应该进 AGENTS.md，而不是项目库——
    // 否则收下的动作和草稿声明的归属不一致，又是两份真值。
    if (data.scope === 'global') {
      // 人已经在面板里按过「收下」，这里不再二次确认语义重复，直接追加/更新
      const upserted = upsertAgentsChapter({ title: data.title ?? id, body, newChapter: true })
      if (!upserted.ok) return { ok: false, error: upserted.reason ?? 'AGENTS.md 写入失败' }
      rmSync(file, { force: true })
      pruneEmptyState(memoryDir)
      return { ok: true, agents: upserted, action: upserted.action, path: upserted.path }
    }

    // 不传 id：正式库的文件名要用数据里的英文 slug，而不是草稿的 dr_xxx
    const saved = writeMemory(memoryDir, {
      slug: data.slug,
      title: data.title ?? id,
      description: data.description,
      scope: data.scope,
      body,
      type: data.type,
      tags: Array.isArray(data.tags) ? data.tags : [],
      paths: Array.isArray(data.paths) ? data.paths : [],
      confidence: data.confidence,
      status: 'confirmed',
    })
    rmSync(file, { force: true })
    pruneEmptyState(memoryDir)
    const built = await rebuildVectors(memoryDir)
    return { ok: true, file: path.relative(memoryDir, saved), vectorMode: built.mode, vectorCount: built.indexed }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 丢弃一条待确认记忆。 */
export function rejectPending(memoryDir, id) {
  const file = path.join(pendingPath(memoryDir), `${id}.md`)
  if (!existsSync(file)) return { ok: false, error: `待确认队列里没有 ${id}` }
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
    const message = event.type === 'user/message' ? event.data : event.data?.message
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      const text = block.text.trim()
      // 跳过运行时注入的 <system-reminder> 块和记忆注入块
      if (!text || text.startsWith('<system-reminder>') || text.startsWith('[workspace-memory]')) continue
      parts.push(`${event.type === 'user/message' ? '用户' : '助手'}：${text}`)
    }
  }
  const joined = parts.join('\n\n')
  return joined.length > maxChars ? joined.slice(-maxChars) : joined
}

/** 从模型输出里抠出 JSON 数组，容忍 ```json 围栏和前后闲聊。 */
export function parseExtractionJson(text) {
  // 模型输出/上游异常什么都可能传进来，先兜住非字符串
  const source = typeof text === 'string' ? text : ''
  if (!source) return []
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)
  const candidate = (fenced ? fenced[1] : source).trim()
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.title === 'string' &&
        item.title.trim() &&
        typeof item.body === 'string' &&
        item.body.trim(),
    )
  } catch {
    return []
  }
}

export const EXTRACTION_SYSTEM = [
  'You extract durable memories from a conversation for a coding agent.',
  'Return ONLY a JSON array, no prose. Each element:',
  '{"slug": string, "title": string, "description": string, "body": string, "type": "user"|"feedback"|"project"|"reference", "scope": "global"|"project", "tags": string[], "confidence": number 0..1}',
  'Field rules:',
  '- "slug": short ENGLISH kebab-case file name (lowercase ascii words joined by hyphens, at most 6 words, no Chinese), e.g. "no-explanatory-text-in-ui". It becomes the file name and the index link text.',
  '- "title": human-readable title in the conversation\'s language (Chinese is fine); it is NOT the file name.',
  '- "description": one line under 120 chars, in the conversation\'s language; it becomes the summary after the em dash in MEMORY.md.',
  '- "body": the memory itself in Markdown; include the reason, not just the rule.',
  '- "scope": "global" when the rule would apply in ANY project (working style, UI conventions, toolchain pitfalls, how the human wants to be spoken to); "project" when it is about THIS repository\'s domain, data, or architecture. Be strict: when unsure, choose "project".',
  'Type rules:',
  '- type "user" = the human\'s standing preferences or role.',
  '- type "feedback" = a correction the human gave, or an approach they confirmed/rejected.',
  '- type "project" = in-flight work, deadlines, or decisions not derivable from the code.',
  '- type "reference" = where to find something outside the repo.',
  'What to skip:',
  '- Anything derivable from the repository: architecture, file paths, visible bug fixes.',
  '- Transient state: versions, counts, branch names, one-off command output.',
  '- Return [] when nothing is worth remembering. That is the normal answer.',
].join('\n')

/**
 * 跑一次抽取。**永不抛异常**，任何环节失败都返回 { skipped }。
 *
 * 用宿主播的当前模型（session.requestContext 里的 provider/model），
 * 不额外配 provider、不需要 key。
 *
 * `options.manual`：用户显式敲了 `/memory extract`。
 * `enableExtraction` 只管「每回合自动触发」；显式命令是明确意图，不该被这个开关挡住。
 * （之前手动命令也被挡住，但面板与帮助文案都在建议用户去跑它——那是句空话。）
 */
export async function extractFromTurn(ctx, agent, memoryDir, options = {}) {
  try {
    if (!options.manual && !CONFIG.enableExtraction) return { skipped: 'extraction disabled' }

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

    let text = ''
    const stream = llm.stream({
      provider,
      model,
      system: EXTRACTION_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: `对话记录：\n\n${transcript}` }] }],
      maxTokens: 1200,
      temperature: 0,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += chunk.text
    }

    const candidates = parseExtractionJson(text).slice(0, CONFIG.extractMaxPerTurn)
    if (candidates.length === 0) return { skipped: 'nothing worth remembering', raw: text.slice(0, 200) }

    // 去重：与「已确认记忆的向量 + 尚未处置的 pending 条目」一起比。
    // 只比 confirmed 会漏掉一种情况——同一段对话连续两回合抽出同一条，
    // 会在队列里堆出一串一模一样的草稿。
    const embedder = await resolveEmbedder()
    const reference = []
    for (const entry of loadVectors(memoryDir)?.entries ?? []) reference.push(entry.vec)
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
    let lowConfidence = 0

    for (const candidate of candidates) {
      // 置信度闸门放在最前面：便宜，而且被挡掉的条目没必要再去算向量
      const confidence = typeof candidate.confidence === 'number' ? candidate.confidence : 0.6
      if (confidence < CONFIG.minExtractConfidence) {
        lowConfidence += 1
        continue
      }

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

      writePending(memoryDir, {
        slug: typeof candidate.slug === 'string' ? candidate.slug : undefined,
        title: candidate.title.trim(),
        description: typeof candidate.description === 'string' ? candidate.description : undefined,
        scope: candidate.scope === 'global' ? 'global' : 'project',
        body: candidate.body,
        type: candidate.type,
        tags: Array.isArray(candidate.tags) ? candidate.tags.filter((t) => typeof t === 'string') : [],
        confidence,
      })
      // 入队后立刻进参考集，防止同一批里出现两条近似候选
      if (vec) reference.push(vec)
      queued += 1
    }

    return { queued, deduped, lowConfidence, candidates: candidates.length }
  } catch (error) {
    return { skipped: `extraction failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 判断一次 `memory_remember` 该直接入库还是进待确认。
 *
 * 抽成独立函数是为了能用 Node 直接验证分流规则——它原本写在工具回调里，
 * 只能靠人工点一遍才知道对不对。
 */
export function rememberRoute(confidence) {
  const value = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0.8
  return value >= CONFIG.directWriteConfidence ? 'direct' : 'pending'
}

/* -------------------------------------------------- 搬到全局 AGENTS.md */

const agentsFilePath = () => CONFIG.agentsFile || path.join(os.homedir(), '.dsh', 'AGENTS.md')

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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
      sections: (text.match(/^##\s+/gm) ?? []).length,
    }
  } catch {
    return { path: file, exists: false, bytes: 0, sections: 0 }
  }
}

/**
 * 算下一节的编号。
 *
 * AGENTS.md 的既有约定是 `## N. 标题` + `### N.M 子标题`（连续编号）。
 * promote 必须跟着编号，否则每写入一次就把文件的统一格式破坏一次。
 */
function nextAgentsSectionNumber(text) {
  const numbers = [...String(text).matchAll(/^##\s+(\d+)\.\s/gm)].map((match) => Number(match[1]))
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
 */
function formatAgentsBody(body, sectionNumber) {
  let text = String(body ?? '').replace(/\r\n?/g, '\n').trim()

  // 尾部「--- + 迁移/来源说明」属于条目自己的出身，不该混进全局准则
  const marker = text.lastIndexOf('\n---')
  if (marker >= 0 && /(迁移自|来源[:：]|origin\s*[:：])/i.test(text.slice(marker))) {
    text = text.slice(0, marker).trim()
  }

  // 标题整体下沉：`#`→`###`、`##`→`###`、`###`→`####`，永远落在外层 `##` 之下
  text = text.replace(/^(#{1,6})(\s+)/gm, (_, hashes, space) => {
    const level = Math.min(6, Math.max(3, hashes.length + 1))
    return `${'#'.repeat(level)}${space}`
  })

  // 三级标题按出现顺序编号为 N.1 / N.2 …（与文件既有约定一致）
  if (sectionNumber) {
    let index = 0
    text = text.replace(/^###\s+(.+)$/gm, (_, heading) => `### ${sectionNumber}.${(index += 1)} ${heading}`)
  }

  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 把一条记忆搬进全局 AGENTS.md：追加一节 `## 标题` + 正文，然后从项目库删除。
 *
 * 这是插件里**唯一**会写用户手写文件的地方，所以四道保护：
 *   1. 标题已存在就拒绝，绝不重复追加
 *   2. 只追加，不改写任何已有内容
 *   3. 删记忆走 deleteMemory，历史里留一份，可回退
 *   4. 只有 scope=global 的记忆才允许搬（避免把项目内知识污染成全局规则）
 */
export function promoteToAgents(memoryDir, id) {
  const item = readMemory(memoryDir, id)
  if (!item) return { ok: false, reason: 'not-found', id }

  if (item.meta.scope !== 'global') {
    return { ok: false, reason: 'scope-not-global', title: item.meta.title ?? id }
  }

  const file = agentsFilePath()
  if (!existsSync(file)) return { ok: false, reason: 'agents-missing', agentsPath: file }

  const title = String(item.meta.title ?? id).trim()
  if (!title) return { ok: false, reason: 'empty-title', id }

  let current
  try {
    current = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, reason: 'read-failed', agentsPath: file, error: String(error?.message ?? error) }
  }

  if (new RegExp(`^##\\s+${escapeRegExp(title)}\\s*$`, 'm').test(current)) {
    return { ok: false, reason: 'already-present', title, agentsPath: file }
  }

  const sectionNumber = nextAgentsSectionNumber(current)
  const body = formatAgentsBody(item.body, sectionNumber)
  if (!body) return { ok: false, reason: 'empty-body', title, agentsPath: file }
  // 来源注释：promote 后记忆从项目库删除，这里留一条不可见线索（HTML 注释渲染时看不到），
  // 便于日后追溯这一节来自哪条记忆。日期只取到天，避免同一内容反复写入产生差异。
  const stamp = new Date().toISOString().slice(0, 10)
  const addition = `\n## ${sectionNumber}. ${title}\n\n${body}\n\n<!-- 来自记忆 ${id}，写入于 ${stamp} -->\n`
  try {
    const next = `${current.replace(/\s*$/, '\n')}${addition}`
    writeFileSync(file, next, 'utf8')
    // 搬走后从项目库删除；deleteMemory 会先留历史
    deleteMemory(memoryDir, id)
    return {
      ok: true,
      title,
      agentsPath: file,
      addedBytes: Buffer.byteLength(addition, 'utf8'),
      totalBytes: Buffer.byteLength(next, 'utf8'),
      memoryRemoved: true,
    }
  } catch (error) {
    return { ok: false, reason: 'write-failed', agentsPath: file, error: String(error?.message ?? error) }
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
  const blocks = []
  let preambleEnd = lines.length

  for (let i = 0; i < lines.length; i += 1) {
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
 * 只重写标题行，正文一个字不动。
 */
export function renumberAgentsLines(lines) {
  let chapter = 0
  let section = 0
  return lines.map((line) => {
    const heading2 = /^##\s+\d+\.\s+(.*)$/.exec(line)
    if (heading2) {
      chapter += 1
      section = 0
      return `## ${chapter}. ${heading2[1]}`
    }
    const heading3 = /^###\s+\d+(?:\.\d+)?\s+(.*)$/.exec(line)
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
  const realFile = path.join(os.homedir(), '.dsh', 'AGENTS.md')
  return path.resolve(String(file)) === path.resolve(realFile)
    ? path.join(os.homedir(), '.dsh', '.dsh-workspace-memory-history', 'agents')
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

/** 用新的块数组写回文件（重排编号后落盘，写前留档）。 */
function writeAgentsDocument(file, original, parsed, blocks) {
  const lines = []
  for (const block of blocks) lines.push(...block.lines)

  // 章与章之间必须有空行：块的边界是「下一章标题的位置」，本身不含分隔空行，
  // 直接拼接会把上一章最后一行和 `## 下一章` 粘在一起（Markdown 里标题会失效）。
  const spaced = []
  for (const line of [...parsed.preamble, ...lines]) {
    if (/^#{2,3}\s/.test(line) && spaced.length > 0 && spaced[spaced.length - 1].trim() !== '') {
      spaced.push('')
    }
    spaced.push(line)
  }

  const merged = spaced.join('\n').replace(/\n{3,}/g, '\n\n')
  const finalText = `${renumberAgentsLines(merged.split('\n')).join('\n').replace(/\s*$/, '')}\n`
  const size = Buffer.byteLength(finalText, 'utf8')

  // 字节预算：AGENTS.md 每轮注入，不是免费存储。超了就不写，让调用方先合并或删。
  const limit = CONFIG.maxAgentsBytes
  if (limit > 0 && size > limit) {
    return { ok: false, reason: 'agents-full', bytes: size, limit, current: Buffer.byteLength(original, 'utf8') }
  }

  backupAgentsFile(file, original)
  writeFileSync(file, finalText, 'utf8')
  return { ok: true, bytes: size }
}

/** 当前所有块（作为可编辑的行数组）。 */
function agentsBlocks(parsed) {
  return parsed.blocks.map((block) => ({
    ...block,
    lines: parsed.lines.slice(block.start, block.end),
  }))
}

/** 保存某一章：标题 + 正文整体替换，其余章节逐字保留。 */
export function saveAgentsSection(index, input) {
  const file = agentsFilePath()
  if (!existsSync(file)) return { ok: false, reason: 'agents-missing', path: file }

  const original = readFileSync(file, 'utf8')
  const parsed = parseAgentsSections(original)
  const blocks = agentsBlocks(parsed)
  const target = blocks[Number(index)]
  if (!target) return { ok: false, reason: 'section-not-found', index }

  const title = String(input?.title ?? '').trim()
  if (!title) return { ok: false, reason: 'empty-title' }

  // 标题里可能带着旧编号（`## 3. xxx`）；剥掉，交给 renumberAgentsLines 统一分配，
  // 否则保存后这一章会因为「不匹配 ^## N.」而丢掉编号。
  const bareTitle = title.replace(/^\d+(?:\.\d+)?\.\s*/, '')
  const hashes = '#'.repeat(target.level)
  const body = String(input?.body ?? '').replace(/\r\n?/g, '\n').trim()
  target.lines = [`${hashes} 0. ${bareTitle}`, '', ...(body ? body.split('\n') : [])]

  const written = writeAgentsDocument(file, original, parsed, blocks)
  if (!written.ok) return written
  return { ok: true, path: file, bytes: written.bytes, index }
}

/** 删除某一章（连同它下面的子标题）。 */
export function deleteAgentsSection(index) {
  const file = agentsFilePath()
  if (!existsSync(file)) return { ok: false, reason: 'agents-missing', path: file }

  const original = readFileSync(file, 'utf8')
  const parsed = parseAgentsSections(original)
  const blocks = agentsBlocks(parsed)
  const target = blocks[Number(index)]
  if (!target) return { ok: false, reason: 'section-not-found', index }
  if (target.level !== 2) return { ok: false, reason: 'only-chapter', index }

  blocks.splice(Number(index), 1)
  const written = writeAgentsDocument(file, original, parsed, blocks)
  if (!written.ok) return written
  return { ok: true, path: file, bytes: written.bytes, removed: target.title }
}

/** 追加一章：编号自动顺延，正文按 promote 的规则下沉标题。 */
export function appendAgentsSection(input) {
  const file = agentsFilePath()
  if (!existsSync(file)) return { ok: false, reason: 'agents-missing', path: file }

  const title = String(input?.title ?? '').trim()
  if (!title) return { ok: false, reason: 'empty-title' }

  const original = readFileSync(file, 'utf8')
  const parsed = parseAgentsSections(original)
  const sectionNumber = nextAgentsSectionNumber(original)
  const body = formatAgentsBody(input?.body, sectionNumber)
  // 允许「先建空章再编辑」：空正文不算错误
  const hasBody = String(input?.body ?? '').trim() !== ''
  if (hasBody && !body) return { ok: false, reason: 'empty-body' }
  // 标题若自带旧编号，剥掉后由 renumberAgentsLines 统一分配
  const bareTitle = title.replace(/^\d+(?:\.\d+)?\.\s*/, '')

  if (new RegExp(`^##\\s+\\d+\\.\\s+${escapeRegExp(bareTitle)}\\s*$`, 'm').test(original)) {
    return { ok: false, reason: 'already-present', title: bareTitle }
  }

  const blocks = agentsBlocks(parsed)
  blocks.push({
    level: 2,
    title: bareTitle,
    lines: [`## ${sectionNumber}. ${bareTitle}`, '', ...(body ? body.split('\n') : [])],
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
  const hit = doc.sections.find((section) => section.title.replace(/^\d+\.\s*/, '') === bareTitle)
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

/** 从 Windows App Paths 注册表取一个可执行文件的真实路径（Typora/VS Code 常装在非默认盘）。 */
function appPathFromRegistry(exeName) {
  if (process.platform !== 'win32') return null
  for (const root of ['HKLM', 'HKCU']) {
    try {
      const key = `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`
      const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 3000 })
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
export function detectEditors() {
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
        spawn(`"${wanted.exe}" "${file}"`, { shell: true, detached: true, stdio: 'ignore' }).unref()
      } else {
        spawn(wanted.exe, [file], { detached: true, stdio: 'ignore' }).unref()
      }
      return { ok: true, agentsPath: file, app: wanted.name, editorId: wanted.id }
    }
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', `"${file}"`], { detached: true, stdio: 'ignore' }).unref()
      return { ok: true, agentsPath: file, app: 'system-default', editorId: 'system' }
    }
    spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref()
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
      else if (title.length > CONFIG.maxTitleChars) errors.push(`title: 不能超过 ${CONFIG.maxTitleChars} 字符（当前 ${title.length}）`)
      else value.title = title
    }
  }

  // 文件名必须是英文 slug：索引行要求「英文在前、中文说明在后」
  if (input.slug !== undefined) {
    if (typeof input.slug !== 'string') {
      errors.push('slug: 必须是字符串')
    } else {
      const normalized = asciiSlug(input.slug)
      if (!/^[a-z0-9-]+$/.test(normalized) || normalized.length < 2) {
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
      if (description.length > MAX_DESCRIPTION_CHARS) {
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

  // scope 是「该不该挪去全局」的提示，允许在面板里改
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
    } else {
      value.paths = input.paths.map((p) => p.trim()).filter(Boolean)
    }
  }

  return { ok: errors.length === 0, errors, value }
}

/** 把一条记忆摊平成 UI 需要的形状。 */
function toUiShape(item) {
  return {
    id: item.id,
    name: item.meta.name ?? item.id,
    title: item.meta.title || item.body.split(/\r?\n/)[0] || item.id,
    description: item.meta.description ?? '',
    type: MEMORY_TYPES.includes(item.meta.type) ? item.meta.type : 'project',
    scope: item.meta.scope === 'global' ? 'global' : 'project',
    status: item.meta.status ?? 'confirmed',
    tags: Array.isArray(item.meta.tags) ? item.meta.tags : [],
    paths: Array.isArray(item.meta.paths) ? item.meta.paths : [],
    confidence: Number(item.meta.confidence ?? 0.8),
    // 被召回次数与最近一次命中，用于判断哪条是死条目
    hits: Number(item.meta.hits ?? 0),
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
async function applyMemoryPatch(memoryDir, id, patch) {
  const existing = readMemory(memoryDir, id)
  if (!existing) return { ok: false, status: 404, errors: [`找不到记忆 ${id}`] }

  const checked = validateMemoryPatch(patch)
  if (!checked.ok) return { ok: false, status: 400, errors: checked.errors }

  const next = checked.value
  try {
    const file = writeMemory(memoryDir, {
      id,
      slug: next.slug,
      title: next.title ?? existing.meta.title,
      // undefined 表示「不修改」，writeMemory 会沿用原值
      description: next.description,
      body: next.body ?? existing.body,
      type: next.type ?? existing.meta.type,
      scope: next.scope,
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
      memory: saved ? toUiShape(saved) : null,
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

/** 读请求体（限制 1 MiB，防止误发大文件把宿主拖住）。 */
function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limitBytes) {
        reject(new Error(`请求体超过 ${limitBytes} 字节`))
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
        reject(new Error('请求体不是合法 JSON'))
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
  writeFileSync(indexPath(memoryDir), text, 'utf8')
  return { count: seen.size, lineCount, byteCount }
}

/** 读索引正文，受行数/字节上限约束。永不抛异常。 */
function readIndexForInjection(memoryDir) {
  try {
    const file = indexPath(memoryDir)
    if (!existsSync(file)) return ''
    const raw = readFileSync(file, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') <= CONFIG.indexMaxBytes) {
      const lines = raw.split(/\r?\n/)
      return (lines.length <= CONFIG.indexMaxLines ? lines : lines.slice(0, CONFIG.indexMaxLines)).join('\n')
    }
    // 超字节上限：按行累加，截到上限为止
    const kept = []
    let bytes = 0
    for (const line of raw.split(/\r?\n/)) {
      const size = Buffer.byteLength(`${line}\n`, 'utf8')
      if (bytes + size > CONFIG.indexMaxBytes) break
      kept.push(line)
      bytes += size
      if (kept.length >= CONFIG.indexMaxLines) break
    }
    return kept.join('\n')
  } catch {
    return ''
  }
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
    const ownDeps = path.join(os.homedir(), '.dsh', 'dsh-workspace-memory-deps', 'node_modules', 'leanvec')
    if (existsSync(path.join(ownDeps, 'src', 'embed.mjs'))) {
      try {
        const loaded = await tryLoad(ownDeps)
        if (loaded) return loaded
      } catch {
        // 坏的就跳过，继续找别的
      }
    }

    // 3) profile node_modules 回退
    const profiles = path.join(os.homedir(), '.dsh', 'profiles')
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
 * 重建向量索引。只覆盖 memories/ —— 这是与上一代实现最关键的差别。
 *
 * **增量**：每条记忆算一个索引文本哈希，与旧索引里同 id 的哈希比对；
 * 相同就原样复用向量，只有变过的才重新 embed。
 * 实测（2026-11-01）全量重嵌 200 条要 608 ms，改成增量后改一条只需一次 embed。
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

  for (const item of items) {
    const text = indexTextOf(item)
    if (!text.trim()) continue
    const hash = hashText(text)

    const prev = previousById.get(item.id)
    if (prev && prev.hash === hash && prev.vec) {
      entries.push({ id: item.id, hash, vec: prev.vec })
      reused += 1
      continue
    }

    try {
      const vec = embedder.lv.embed(text)
      if (!vec) continue // leanvec 对希腊/阿拉伯等文字返回 null，跳过即可
      entries.push({ id: item.id, hash, vec })
      embedded += 1
    } catch {
      // 单条失败不影响整批
    }
  }

  saveVectors(memoryDir, { model: 'leanvec', dim: VECTOR_DIM, builtAt: new Date().toISOString(), entries })
  return { mode: 'hybrid', indexed: entries.length, reused, embedded }
}

/* --------------------------------------------------------------- 检索 */

/** 点积即余弦（leanvec 输出已 L2 归一化）。 */function dot(a, b) {
  let sum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i]
  return sum
}

/** 关键词评分：拉丁词 + 中文二元组，命中数 / 查询词数，归一到 0..1。 */
export function keywordScore(query, text) {
  const q = String(query).toLowerCase()
  const hay = String(text).toLowerCase()
  const terms = new Set()
  for (const word of q.match(/[a-z0-9_]{2,}/g) ?? []) terms.add(word)
  const cjk = q.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjk) {
    if (run.length === 1) terms.add(run)
    for (let i = 0; i + 1 < run.length; i += 1) terms.add(run.slice(i, i + 2))
  }
  if (terms.size === 0) return 0
  let hits = 0
  for (const term of terms) if (hay.includes(term)) hits += 1
  return hits / terms.size
}

/**
 * 混合检索：向量 + 关键词加权融合。
 *
 * 与上一代的关键区别：**分数低就是低，不硬凑**。低于阈值的直接不返回，
 * 而不是像上一代那样把无关符号以 100 分吐出来。
 */
export async function recall(memoryDir, query, limit = 5, options = {}) {
  const items = listMemories(memoryDir)
  if (items.length === 0) return { mode: 'empty', results: [] }

  const byId = new Map(items.map((item) => [item.id, item]))
  const vectorScores = new Map()
  let mode = 'keyword'

  const embedder = await resolveEmbedder()
  if (embedder) {
    const stored = loadVectors(memoryDir)
    const cache = stored && stored.entries.length > 0 ? stored : null
    let entries = cache?.entries
    if (!entries) {
      // 索引缺失或为空：就地重建一次
      await rebuildVectors(memoryDir)
      entries = loadVectors(memoryDir)?.entries ?? []
    }
    try {
      const qvec = embedder.lv.embed(query)
      if (qvec) {
        mode = 'hybrid'
        for (const entry of entries) {
          const item = byId.get(entry.id)
          if (!item) continue // 记忆已删除，索引残留
          vectorScores.set(entry.id, Math.max(0, dot(qvec, entry.vec)))
        }
      }
    } catch {
      mode = 'keyword'
    }
  }

  const scored = []
  for (const item of items) {
    const kw = keywordScore(query, indexTextOf(item))
    const vec = vectorScores.get(item.id) ?? 0
    // 任一通道达到门槛才入选：向量重语义，关键词重字面，互补
    if (vec < CONFIG.minVectorScore && kw < CONFIG.minKeywordScore) continue
    const score = mode === 'hybrid' ? CONFIG.weightVector * vec + CONFIG.weightKeyword * kw : kw
    // 融合分闸门：低于它就当库里没有。宁可返回空，也不要拿不相关的东西凑数。
    if (CONFIG.minScore > 0 && score < CONFIG.minScore) continue
    scored.push({ item, score, kw, vec })
  }

  scored.sort((a, b) => b.score - a.score)
  let top = scored.slice(0, Math.max(1, Math.min(20, limit)))

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
  if (options.recordHits !== false) recordHits(memoryDir, top.map((row) => row.item.id))
  return {
    mode,
    results: top.map((row) => ({
      id: row.item.id,
      title: row.item.meta.title || row.item.body.split(/\r?\n/)[0] || row.item.id,
      type: row.item.meta.type ?? 'project',
      tags: row.item.meta.tags ?? [],
      score: Number(row.score.toFixed(4)),
      vector: Number(row.vec.toFixed(4)),
      keyword: Number(row.kw.toFixed(4)),
      body: row.item.body,
      chars: Buffer.byteLength(String(row.item.body ?? ''), 'utf8'),
      file: path.relative(memoryDir, row.item.file),
    })),
    // 预算或 limit 之外还有落选条目时如实报数，避免「以为只有这些」
    omitted: omittedByBudget,
  }
}

/**
 * 找可能重复/冲突的记忆（写入前用）。
 *
 * 复用检索的打分，但**不计 hits**——查重不是「取用」。
 * 返回按分数降序，调用方只关心最高的几个。
 */
export async function findSimilarMemories(memoryDir, text, limit = 3) {
  const query = String(text ?? '').trim()
  if (!query) return []
  const found = await recall(memoryDir, query, Math.max(1, Math.min(20, limit)), { recordHits: false })
  return found.results ?? []
}

/**
 * 记忆里标注的 `paths` 是否命中一个真实文件路径。
 *
 * 约定（与写入时的人工标注一致）：
 *   · 相对工作区根写，例如 `dsh-profile-stats/client.js`、`.github/workflows/x.yml`
 *   · 支持 `*` 通配，但**不跨目录**（`*` 不匹配 `/`）
 *   · 命中判据是「touched 路径以该模式结尾」，所以绝对路径也能匹配
 */
export function pathMatches(memoryPath, touchedPath) {
  const pattern = String(memoryPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
  const target = String(touchedPath ?? '').replace(/\\/g, '/')
  if (!pattern || !target) return false
  // 结尾目录形式（`foo/`）表示该目录下的任何文件
  if (pattern.endsWith('/')) return target.includes(`/${pattern}`) || target.includes(pattern)
  const body = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')
  try {
    return new RegExp(`(^|/)${body}$`).test(target)
  } catch {
    return false
  }
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
 * 给被召回的条目累加 hits / lastHit。
 *
 * 刻意**不重建 MEMORY.md**：命中次数不进索引，重建纯属浪费；
 * 也**不留历史**：这是元数据抖动而非内容变更，留档会把历史冲爆。
 */
function recordHits(memoryDir, ids) {
  if (ids.length === 0) return
  const now = new Date().toISOString()
  for (const id of ids) {
    try {
      const file = path.join(memoriesPath(memoryDir), `${id}.md`)
      if (!existsSync(file)) continue
      const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
      writeFileSync(
        file,
        serializeFrontmatter({ ...data, hits: Number(data.hits ?? 0) + 1, lastHit: now }, body),
        'utf8',
      )
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
function memoryDirOf(ctx, { agent, sessionId, useInitiator = false } = {}) {
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

  return cwd ? resolveMemoryDir(cwd) : null
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

/**
 * 浏览器半区的能力自检回执。
 *
 * 客户端跑在浏览器里，控制台我看不到；客户端 ctx 能拿到哪些服务，只有它自己知道。
 * 所以让它在 apply 时把探测结果 POST 回来，宿主存一份，用 GET 读。
 * 这不是产品功能，是给「没有浏览器控制」这类环境用的诊断通道。
 */
let lastClientDiag = null

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

/* -------------------------------------------------------------- 注册部分 */

export function apply(ctx, rawConfig) {
  const resolved = configure(rawConfig)
  if (resolved.issues.length > 0) {
    for (const issue of resolved.issues) console.error(`[workspace-memory] config: ${issue}`)
  }

  // 抓一次已注册工作区根路径：记忆库的「项目」就是这个工作区，
  // 而不是每个子项目各建一个（那些子目录各自是独立 git 仓库）。
  try {
    const registry = ctx.get?.('workspaceRegistry')
    const list = registry?.list?.() ?? []
    workspaceRoots = list.map((workspace) => workspace?.path).filter((p) => typeof p === 'string' && p)
  } catch {
    workspaceRoots = []
  }

  /* —— 预取缓存：pre-step 里算好，注入时只读 —————————————————— */
  const prefetchCache = new Map() // agentId -> { turn, hits: [{id,title,score}] }

  /* —— 每轮注入 MEMORY.md ——————————————————————————————————— */
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
            const memoryDir = memoryDirOf(ctx, { useInitiator: true })
            if (!memoryDir) return ''
            const index = readIndexForInjection(memoryDir)
            if (!index.trim()) return ''

            const lines = [
              '[workspace-memory] 已确认的工作区记忆。需要细节时调 memory_recall 取全文。',
              index,
            ]

            // 把 pre-step 算好的「本轮最接近的几条」附在后面。
            // 价值不是多给信息（索引里都有），而是**替模型排序**：
            // 几十条里哪几条跟当前请求有关，比让它自己扫一遍可靠得多。
            let agent
            try {
              agent = ctx.agents?.currentInitiator?.()
            } catch {
              agent = undefined
            }
            const prefetched = agent ? prefetchCache.get(agent.id) : undefined
            if (prefetched && prefetched.hits.length > 0) {
              lines.push(
                '',
                '[相关记忆] 与本轮请求最接近的条目（需要细节时调 memory_recall）：',
                ...prefetched.hits.map((hit) => `- ${hit.id} — ${hit.title}`),
              )
            }

            return lines.join('\n')
          } catch {
            return ''
          }
        },
      }),
    'workspace-memory injection',
  )

  /* —— 用户消息进来时预取 ————————————————————————————————————
   *
   * pre-step 是 async waterfall 且带 messages，所以这里能 await 真正的 recall；
   * 注入用的 context.text 是同步的，只能读上面那个缓存。
   * 失败一律放行——预取是锦上添花，绝不能挡住步骤。
   */
  ctx.effect(() =>
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        if (!CONFIG.prefetchRecall) return next()
        const agent = payload?.agent
        if (!agent) return next()

        const text = (payload?.messages ?? [])
          .map((message) => {
            const content = message?.content
            if (typeof content === 'string') return content
            if (Array.isArray(content)) {
              return content
                .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text)
                .join('\n')
            }
            return ''
          })
          .join('\n')
          .trim()
        if (!text) return next() // 后续步骤没有新用户消息，保留上一份缓存

        const memoryDir = memoryDirOf(ctx, { agent })
        if (!memoryDir) return next()

        const found = await recall(memoryDir, text.slice(0, 2000), CONFIG.prefetchLimit, { recordHits: false })
        prefetchCache.set(agent.id, {
          turn: payload.turn,
          hits: found.results.map((row) => ({ id: row.id, title: row.title, score: row.score })),
        })
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
        await extractFromTurn(ctx, agent, memoryDir)
      } catch {
        // 抽取是旁路，永远不冒泡
      }
    }),
  )

  // 会话销毁时清掉计数器，避免长期驻留
  ctx.effect(() =>
    ctx.on('agent/disposed', (payload) => {
      if (payload?.agent?.id) {
        turnCounter.delete(payload.agent.id)
        prefetchCache.delete(payload.agent.id)
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

  ctx.effect(() =>
    ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        if (!CONFIG.pathsHint) return next()
        if (!result || result.isError) return next()
        const toolName = String(exec?.name ?? '')
        // 记忆工具自己的结果不需要再提示记忆
        if (!toolName || toolName.startsWith('memory_')) return next()

        const touched = pathsFromToolArgs(exec?.arguments)
        if (touched.length === 0) return next()

        const memoryDir = memoryDirOf(ctx, { agent: exec.agent })
        if (!memoryDir) return next()

        const hits = memoriesForPaths(memoryDir, touched, CONFIG.pathsHintLimit)
        if (hits.length === 0) return next()

        const agentKey = exec.agent?.id ?? ''
        const seen = hintedThisTurn.get(agentKey) ?? new Set()
        const fresh = hits.filter((hit) => !seen.has(hit.id))
        if (fresh.length === 0) return next()
        for (const hit of fresh) seen.add(hit.id)
        hintedThisTurn.set(agentKey, seen)

        const lines = fresh.map((hit) => `- ${hit.id} — ${hit.title}`)
        const hint = `\n\n[记忆] 这个文件有相关记忆（需要细节时调 memory_recall）：\n${lines.join('\n')}`
        const content = Array.isArray(result.content) ? result.content : []
        return { kind: 'accept', content: [...content, { type: 'text', text: hint }] }
      } catch {
        return next()
      }
    }),
  )

  /* —— 浏览器半区的数据接口 ——————————————————————————————————
   * 走宿主 HTTP 路由而不是包私有 RPC：工作区里 dsh-profile-stats 已经用这条路
   * 跑通，行为可预测，也不需要额外的 Remote/typert 声明。
   * 只暴露两个端点，都是本包自己的命名空间，不与他人冲突。 */
  {
    const LIST_PATH = '/api/dsh-workspace-memory/list'
    const SAVE_PATH = '/api/dsh-workspace-memory/save'

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: LIST_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, errors: ['只接受 GET'] })
            return
          }
          try {
            const memoryDir = memoryDirOf(ctx, { sessionId: sessionIdOf(req) })
            if (!memoryDir) {
              sendJson(res, 400, {
                ok: false,
                errors: ['无法确定工作区：请求缺少有效的 session 参数'],
              })
              return
            }
            const items = listMemories(memoryDir).map(toUiShape)
            const drafts = listPending(memoryDir).map((item) => ({ ...toUiShape(item), status: 'draft' }))
            sendJson(res, 200, {
              ok: true,
              root: memoryDir,
              memories: items,
              pending: drafts,
              pendingEnabled: CONFIG.enableExtraction,
            })
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            sendJson(res, 500, { ok: false, errors: [`读取记忆失败：${detail}`] })
          }
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: SAVE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
            return
          }
          try {
            const body = await readJsonBody(req)
            const id = typeof body?.id === 'string' ? body.id.trim() : ''
            if (!id) {
              sendJson(res, 400, { ok: false, errors: ['id: 不能为空'] })
              return
            }
            const memoryDir = memoryDirOf(ctx, { sessionId: sessionIdOf(req) })
            if (!memoryDir) {
              sendJson(res, 400, {
                ok: false,
                errors: ['无法确定工作区：请求缺少有效的 session 参数'],
              })
              return
            }
            const result = await applyMemoryPatch(memoryDir, id, body?.patch ?? {})
            sendJson(res, result.status, result)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            sendJson(res, 400, { ok: false, errors: [detail] })
          }
        },
      }),
    )

    // 待确认草稿的处置。与 /memory accept|reject 走同一套函数，只是换个入口，
    // 免得「命令能做的事界面做不到」或反过来出现两套逻辑。
    const ACCEPT_PATH = '/api/dsh-workspace-memory/accept'
    const REJECT_PATH = '/api/dsh-workspace-memory/reject'

    const pendingAction = (action) =>
      async function handlePendingAction(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
          return
        }
        try {
          const body = await readJsonBody(req)
          const id = typeof body?.id === 'string' ? body.id.trim() : ''
          if (!id) {
            sendJson(res, 400, { ok: false, errors: ['id: 不能为空'] })
            return
          }
          const memoryDir = memoryDirOf(ctx, { sessionId: sessionIdOf(req) })
          if (!memoryDir) {
            sendJson(res, 400, { ok: false, errors: ['无法确定工作区：请求缺少有效的 session 参数'] })
            return
          }
          const result = action === 'accept' ? await acceptPending(memoryDir, id) : rejectPending(memoryDir, id)
          sendJson(res, result.ok ? 200 : 404, result)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          sendJson(res, 400, { ok: false, errors: [detail] })
        }
      }

    ctx.effect(() =>
      ctx.webServer.register({ kind: 'exact', path: ACCEPT_PATH, handler: pendingAction('accept') }),
    )
    ctx.effect(() =>
      ctx.webServer.register({ kind: 'exact', path: REJECT_PATH, handler: pendingAction('reject') }),
    )

    /* —— 删除已确认的记忆 ——
     * 面板的「删除」按钮走这里。高置信度记忆是直接入库的，所以人必须能自己删掉记错的东西；
     * 删除走 deleteMemory，会先在 .memory-state/history/ 留一份，可回退。
     */
    const FORGET_PATH = '/api/dsh-workspace-memory/forget'

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: FORGET_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
            return
          }
          try {
            const body = await readJsonBody(req)
            const id = typeof body?.id === 'string' ? body.id.trim() : ''
            if (!id) {
              sendJson(res, 400, { ok: false, errors: ['id: 不能为空'] })
              return
            }
            const memoryDir = memoryDirOf(ctx, { sessionId: sessionIdOf(req) })
            if (!memoryDir) {
              sendJson(res, 400, { ok: false, errors: ['无法确定工作区：请求缺少有效的 session 参数'] })
              return
            }
            if (!deleteMemory(memoryDir, id)) {
              sendJson(res, 404, { ok: false, errors: [`找不到记忆：${id}`] })
              return
            }
            const built = await rebuildVectors(memoryDir)
            sendJson(res, 200, { ok: true, removed: id, vectorMode: built.mode, vectorCount: built.indexed })
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            sendJson(res, 400, { ok: false, errors: [detail] })
          }
        },
      }),
    )

    /* —— 全局 AGENTS.md：查看、搬迁、打开 —— */

    const AGENTS_PATH = '/api/dsh-workspace-memory/agents'
    const PROMOTE_PATH = '/api/dsh-workspace-memory/promote'
    const OPEN_AGENTS_PATH = '/api/dsh-workspace-memory/open-agents'

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: AGENTS_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, errors: ['只接受 GET'] })
            return
          }
          // 顺带把探测到的编辑器一起给出去，界面据此渲染「打开方式」下拉
          sendJson(res, 200, { ok: true, agents: agentsStatus(), editors: detectEditors() })
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: PROMOTE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
            return
          }
          try {
            const body = await readJsonBody(req)
            const id = typeof body?.id === 'string' ? body.id.trim() : ''
            if (!id) {
              sendJson(res, 400, { ok: false, errors: ['id: 不能为空'] })
              return
            }
            const memoryDir = memoryDirOf(ctx, { sessionId: sessionIdOf(req) })
            if (!memoryDir) {
              sendJson(res, 400, { ok: false, errors: ['无法确定工作区：请求缺少有效的 session 参数'] })
              return
            }
            const result = promoteToAgents(memoryDir, id)
            sendJson(res, result.ok ? 200 : 400, result)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            sendJson(res, 400, { ok: false, errors: [detail] })
          }
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: OPEN_AGENTS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
            return
          }
          try {
            const body = await readJsonBody(req)
            const editor = typeof body?.editor === 'string' ? body.editor : ''
            const result = openAgentsFile(editor)
            sendJson(res, result.ok ? 200 : 400, result)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            sendJson(res, 400, { ok: false, errors: [detail] })
          }
        },
      }),
    )

    /* —— 全局 AGENTS.md 的章节管理（面板「全局」页签）—— */
    const AGENTS_SECTIONS_PATH = '/api/dsh-workspace-memory/agents/sections'
    const AGENTS_SECTION_SAVE_PATH = '/api/dsh-workspace-memory/agents/save-section'
    const AGENTS_SECTION_DELETE_PATH = '/api/dsh-workspace-memory/agents/delete-section'
    const AGENTS_SECTION_ADD_PATH = '/api/dsh-workspace-memory/agents/add-section'

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: AGENTS_SECTIONS_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, errors: ['只接受 GET'] })
            return
          }
          sendJson(res, 200, readAgentsDocument())
        },
      }),
    )

    // 三个写操作共用一套：读 body → 校验 → 执行 → 回新的大小
    const agentsWrite = (action) =>
      async function handleAgentsWrite(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
          return
        }
        try {
          const body = await readJsonBody(req)
          const result = action(body)
          sendJson(res, result.ok ? 200 : 400, result)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          sendJson(res, 400, { ok: false, errors: [detail] })
        }
      }

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: AGENTS_SECTION_SAVE_PATH,
        handler: agentsWrite((body) => saveAgentsSection(body?.index, { title: body?.title, body: body?.body })),
      }),
    )
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: AGENTS_SECTION_DELETE_PATH,
        handler: agentsWrite((body) => deleteAgentsSection(body?.index)),
      }),
    )
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: AGENTS_SECTION_ADD_PATH,
        handler: agentsWrite((body) => appendAgentsSection({ title: body?.title, body: body?.body })),
      }),
    )

    // 诊断：客户端把「apply 时探测到的服务与注册结果」回传到宿主，供无浏览器控制时排查。
    const DIAG_PATH = '/api/dsh-workspace-memory/diag'

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: DIAG_PATH,
        handler: async (req, res) => {
          // 默认关。这是排查用的后门，不该常驻；需要时在 config 里
          // 打开 enableDiagEndpoint 并重载插件。
          if (!CONFIG.enableDiagEndpoint) {
            sendJson(res, 404, { ok: false, errors: ['diagnostic endpoint disabled'] })
            return
          }
          if (req.method === 'GET' || req.method === 'HEAD') {
            sendJson(res, 200, { ok: true, diag: lastClientDiag })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, errors: ['只接受 GET / POST'] })
            return
          }
          try {
            lastClientDiag = await readJsonBody(req, 64 * 1024)
            sendJson(res, 200, { ok: true })
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            sendJson(res, 400, { ok: false, errors: [detail] })
          }
        },
      }),
    )
  }

  /* —— memory_remember ——————————————————————————————————————— */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'memory_remember',
        // 工具描述是「该不该记」最直接、最省的约束点：它随工具 schema 进入上下文，
        // 不需要额外注入任何段落。所以准入判据写在这里，而不是另加 system prompt。
        description:
          'Record ONE durable memory. Admission test — all five must hold, or do not call this:\n' +
          '1. It still holds after this task ends. A task instruction ("change X to Y", "add Z") is not a memory.\n' +
          '2. It cannot be re-derived from the code, git history, or existing docs.\n' +
          '3. Violating it is expensive — rework, data loss, a publish accident — not merely inelegant.\n' +
          '4. It can be written as an action ("do X" / "never do Y"), not as a feeling or a "be careful".\n' +
          '5. It happened at least twice, or once at very high cost.\n' +
          'Never record: task instructions, status ("I am working on X"), what the diff already shows, ' +
          'or a decision the user may reverse tomorrow.\n' +
          'WHEN: immediately on an explicit ask ("remember X") or a user correction ("do not do that", ' +
          '"I already said so") — corrections are the strongest signal. Record a strong conclusion at the END ' +
          'of a task, not mid-task: mid-task decisions get overturned.\n' +
          'UPDATING: if the user changed their mind about something already recorded, pass supersedes="<id>" ' +
          'instead of adding a second memory — two memories that disagree are worse than one. A write whose ' +
          'topic already exists and is not superseded is refused and returns candidates.\n' +
          'SCOPE: global only for cross-project rules; that writes a chapter into ~/.dsh/AGENTS.md, which is ' +
          'injected into EVERY project. Everything else is project scope.\n' +
          'PATHS: list the real files this memory is about (e.g. "dsh-workspace-memory/index.js"). They drive ' +
          'the file-triggered hint, so a wrong path means the memory never surfaces when it matters.',
        parameters: {
          type: 'object',
          properties: {
            slug: {
              type: 'string',
              description:
                'Short English kebab-case file name, e.g. "no-explanatory-text-in-ui". It becomes the file name and the index link text, so keep the index line English-led. Lowercase ASCII words joined by hyphens, no Chinese.',
            },
            title: { type: 'string', description: 'Human-readable title (may be Chinese). Not the file name.' },
            description: {
              type: 'string',
              description:
                'One line (<=120 chars) that becomes the summary after the em dash in MEMORY.md. Write it in the user\'s language.',
            },
            body: { type: 'string', description: 'The memory itself in Markdown. Include the reason, not just the rule.' },
            type: {
              type: 'string',
              enum: MEMORY_TYPES,
              description: 'user = role/preferences; feedback = a correction or confirmed approach; project = in-flight work or a non-obvious decision; reference = where to find something outside the repo.',
            },
            tags: stringArraySchema,
            paths: { ...stringArraySchema, description: 'Glob-ish path hints; these memories surface when those files are touched.' },
            confidence: { type: 'number', description: '0..1 self-assessed confidence.' },
            supersedes: {
              type: 'string',
              description:
                'Project scope only. Id of an existing memory this one replaces — the old body is archived to history/ and ' +
                'removed from the library. Use it when the user changed their mind about something already recorded.',
            },
            newMemory: {
              type: 'boolean',
              description:
                'Project scope only. Set true to assert this is a separate memory even though an existing one scored as a ' +
                'possible duplicate. Without it, a duplicate-looking write is refused and the candidates are returned.',
            },
            scope: {
              type: 'string',
              enum: ['project', 'global'],
              description:
                "Where this belongs. 'project' (default) = this workspace's memory library, loaded only here. " +
                "'global' = a chapter in ~/.dsh/AGENTS.md, injected into EVERY project on this machine — use it only for " +
                'cross-project rules and preferences. A global write with a title identical to an existing chapter updates it; ' +
                'otherwise the write is refused until you pass newChapter: true or chapter: N.',
            },
            chapter: {
              type: 'number',
              description:
                'Global only. The 1-based chapter number in AGENTS.md to overwrite with this content. Use it when the new ' +
                'content belongs to a chapter that already exists — merge old and new into body yourself.',
            },
            newChapter: {
              type: 'boolean',
              description:
                'Global only. Set true to assert this is a genuinely new topic. Without it, an unmatched title is refused and ' +
                'the existing chapter list is returned so you can check for a semantic duplicate first.',
            },
          },
          required: ['title', 'body'],
          additionalProperties: false,
        },
        output: textOutput({
          type: 'object',
          properties: { id: { type: 'string' }, file: { type: 'string' }, text: { type: 'string' } },
        }),
        async execute(args, exec) {
          try {
            const memoryDir = memoryDirOf(ctx, { agent: exec?.agent })
            if (!memoryDir) return { text: '无法定位工作区记忆库：当前会话没有可用工作目录。' }
            const confidence = typeof args.confidence === 'number' ? args.confidence : 0.8
            const scope = args.scope === 'global' ? 'global' : 'project'

            // —— 全局：写 AGENTS.md（跨项目规则）——
            if (scope === 'global') {
              // 低置信度仍然先给人看：AGENTS.md 每轮注入，写错影响所有项目
              if (rememberRoute(confidence) === 'pending') {
                const pendingFile = writePending(memoryDir, {
                  slug: args.slug,
                  title: args.title,
                  description: args.description,
                  body: args.body,
                  type: args.type,
                  tags: args.tags,
                  paths: args.paths,
                  confidence,
                  scope: 'global',
                })
                const pendingId = path.basename(pendingFile, '.md')
                return {
                  id: pendingId,
                  file: path.relative(memoryDir, pendingFile),
                  pending: true,
                  text:
                    `Confidence ${confidence.toFixed(2)} is below the direct-write threshold ` +
                    `${CONFIG.directWriteConfidence.toFixed(2)}, so this global rule was queued as pending ${pendingId}. ` +
                    'Accepting it in the panel writes it into ~/.dsh/AGENTS.md.',
                }
              }
              const upserted = upsertAgentsChapter({
                title: args.title,
                body: args.body,
                chapter: args.chapter,
                newChapter: args.newChapter,
              })
              if (!upserted.ok) {
                // 语义重复的拦截：把清单交回去，让调用方自己比一遍再决定
                if (upserted.reason === 'needs-confirmation') {
                  const list = upserted.chapters.map((title, i) => `${i + 1}. ${title}`).join('\n')
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
                if (upserted.reason === 'agents-full') {
                  return {
                    reason: 'agents-full',
                    written: false,
                    text:
                      `NOT written: ~/.dsh/AGENTS.md would become ${upserted.bytes} bytes, over the ${upserted.limit}-byte budget ` +
                      `(currently ${upserted.current}). AGENTS.md is injected into every request, so it has to stay small. ` +
                      'Either merge this content into an existing chapter (chapter: N), or shorten/remove a chapter first. ' +
                      'Only keep rules that are cross-project, not derivable from the code, and costly to violate.',
                  }
                }
                return { text: `Could not write AGENTS.md: ${upserted.reason ?? 'unknown'}` }
              }
              return {
                scope: 'global',
                action: upserted.action,
                file: upserted.path,
                text:
                  (upserted.action === 'updated'
                    ? `Updated chapter ${upserted.chapter} in ~/.dsh/AGENTS.md.`
                    : 'Added a chapter to ~/.dsh/AGENTS.md.') +
                  ` It is now injected into every project (file is ${Math.round(upserted.bytes / 1024)} KB).`,
              }
            }

            // 置信度分流：高置信度直接入库；不确定的进待确认，由人收下或丢弃。
            // 依据是 confidence 是模型自评——模型自己都说没把握的，不该绕过人的判断。
            if (rememberRoute(confidence) === 'pending') {
              const pendingFile = writePending(memoryDir, {
                slug: args.slug,
                title: args.title,
                description: args.description,
                body: args.body,
                type: args.type,
                tags: args.tags,
                paths: args.paths,
                confidence,
                scope: 'project',
              })
              const pendingId = path.basename(pendingFile, '.md')
              return {
                id: pendingId,
                file: path.relative(memoryDir, pendingFile),
                pending: true,
                text:
                  `Confidence ${confidence.toFixed(2)} is below the direct-write threshold ` +
                  `${CONFIG.directWriteConfidence.toFixed(2)}, so this was queued as pending ${pendingId} ` +
                  'instead of entering the library. The human can accept or discard it in the memory panel.',
              }
            }

            // —— 写入前查重：多条并存会产生互相矛盾的记忆 ——
            let supersedeId = ''
            if (args.supersedes) {
              const items = listMemories(memoryDir)
              const target =
                items.find((row) => row.id === String(args.supersedes)) ??
                items.find((row) => row.id.startsWith(String(args.supersedes)))
              if (!target) {
                return {
                  reason: 'supersedes-not-found',
                  written: false,
                  text: `No memory matches "${args.supersedes}". Call memory_recall first to get the exact id.`,
                }
              }
              supersedeId = target.id
            } else if (CONFIG.duplicateCheck && args.newMemory !== true) {
              const candidates = await findSimilarMemories(
                memoryDir,
                `${args.title} ${args.description ?? ''}`,
                CONFIG.duplicateCandidates,
              )
              const top = candidates.find((row) => row.score >= CONFIG.duplicateThreshold)
              if (top) {
                const list = candidates
                  .map((row) => `  ${row.id}  (score ${row.score})  ${row.title}`)
                  .join('\n')
                return {
                  reason: 'needs-review',
                  written: false,
                  candidates: candidates.map((row) => ({ id: row.id, title: row.title, score: row.score })),
                  text:
                    'NOT written: the library already has something close to this topic, and two memories ' +
                    'that disagree are worse than one.\n\n' +
                    `Closest matches:\n${list}\n\n` +
                    `If one of them is the same topic, call again with supersedes: "<id>" — that replaces it and ` +
                    'archives the old body. If this really is a separate memory, call again with newMemory: true.',
                }
              }
            }

            // —— 条数上限：索引每轮注入，条数就是常驻成本 ——
            // supersedes 是替换，不增加条数，不该被拦。
            if (CONFIG.maxMemoryCount > 0 && !supersedeId) {
              const items = listMemories(memoryDir)
              if (items.length >= CONFIG.maxMemoryCount) {
                // 按「最少被用、最久没读」排淘汰候选：这是现有数据里最接近「该删」的信号
                const candidates = [...items]
                  .sort((a, b) => {
                    const hitsA = Number(a.meta?.hits ?? 0)
                    const hitsB = Number(b.meta?.hits ?? 0)
                    if (hitsA !== hitsB) return hitsA - hitsB
                    const readA = String(a.meta?.lastHit ?? a.meta?.modified ?? '')
                    const readB = String(b.meta?.lastHit ?? b.meta?.modified ?? '')
                    return readA.localeCompare(readB)
                  })
                  .slice(0, 5)
                  .map((row) => ({
                    id: row.id,
                    title: row.meta?.title ?? row.id,
                    hits: Number(row.meta?.hits ?? 0),
                    lastHit: row.meta?.lastHit ?? null,
                  }))
                const list = candidates.map((row) => `  ${row.id}  (hits ${row.hits})  ${row.title}`).join('\n')
                return {
                  reason: 'library-full',
                  written: false,
                  count: items.length,
                  limit: CONFIG.maxMemoryCount,
                  candidates,
                  text:
                    `NOT written: the library already holds ${items.length} memories, at the ${CONFIG.maxMemoryCount}-memory ` +
                    'budget. The index is injected into every request, so the count is a per-turn cost.\n\n' +
                    `Least-used memories (best eviction candidates):\n${list}\n\n` +
                    'Either merge this into an existing memory (pass supersedes: "<id>"), or delete/merge one first. ' +
                    'Raise maxMemoryCount if these are all genuinely worth keeping.',
                }
              }
            }

            const file = writeMemory(memoryDir, {
              slug: args.slug,
              title: args.title,
              description: args.description,
              body: args.body,
              type: args.type,
              tags: args.tags,
              paths: args.paths,
              supersedes: supersedeId || undefined,
              confidence,
            })
            const id = path.basename(file, '.md')

            // 覆盖旧偏好：新内容换了 slug 时，旧条目必须删掉（deleteMemory 会先归档），
            // 否则「新旧并存」——正是这一步要消灭的情况。
            let replaced = ''
            if (supersedeId && id !== supersedeId) {
              deleteMemory(memoryDir, supersedeId)
              replaced = supersedeId
            }

            // 同步重建向量，让下一次 recall 立刻能看到这条
            const built = await rebuildVectors(memoryDir)

            // 正文偏长只提醒、不拦：正文只在 recall 命中的那一次进上下文，
            // 内容确实需要长就该长，截断会直接丢信息。
            const bodyChars = Buffer.byteLength(String(args.body ?? ''), 'utf8')
            const tooLong = CONFIG.warnBodyChars > 0 && bodyChars > CONFIG.warnBodyChars

            // paths 写得不像路径 → 文件触发提示永远生效不了，必须说出来
            const oddPaths = (Array.isArray(args.paths) ? args.paths : []).filter((entry) => pathHintIssue(entry) !== '')

            return {
              id,
              file: path.relative(memoryDir, file),
              chars: bodyChars,
              // 不能写 `replaced: undefined`——显式的 undefined 不是 lossless JSON，
              // 工具输出校验会整条报错（写入其实已成功，调用方却以为失败）。
              ...(replaced ? { replaced } : {}),
              ...(oddPaths.length > 0 ? { pathWarnings: oddPaths } : {}),
              text:
                `Saved memory ${id} to ${path.relative(memoryDir, file)}` +
                `${replaced ? `, replacing ${replaced} (its old body is in history/)` : ''}` +
                ` (vector index: ${built.mode}, ${built.indexed} entries).` +
                `${tooLong ? ` Note: body is ${bodyChars} chars, above the ${CONFIG.warnBodyChars} soft threshold — saved unchanged, but consider splitting it into 2-3 atomic memories for better recall.` : ''}` +
                `${oddPaths.length > 0 ? ` Warning: ${oddPaths.map((entry) => JSON.stringify(entry)).join(', ')} do not look like file paths, so the file-triggered hint will never match them. Use paths relative to the workspace root, e.g. "dsh-workspace-memory/index.js".` : ''}`,
            }
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
        description:
          'Search confirmed workspace memories and return full bodies with their file paths. Hybrid: local-embedding similarity blended with keyword matching. Returns nothing rather than low-confidence noise, so an empty result means "not recorded", not "search failed".',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you are trying to remember.' },
            limit: { type: 'number', description: 'Max results, 1..20. Default 5.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        output: textOutput({
          type: 'object',
          properties: { mode: { type: 'string' }, results: { type: 'array' }, text: { type: 'string' } },
        }),
        async execute(args, exec) {
          try {
            const memoryDir = memoryDirOf(ctx, { agent: exec?.agent })
            if (!memoryDir) return { text: '无法定位工作区记忆库：当前会话没有可用工作目录。' }
            const found = await recall(memoryDir, String(args.query ?? ''), args.limit ?? 5)
            if (found.results.length === 0) {
              return {
                mode: found.mode,
                results: [],
                text: `No memory matched "${args.query}" (mode: ${found.mode}). Treat this as "not recorded".`,
              }
            }
            const text = found.results
              .map(
                (row, i) =>
                  `${i + 1}. [${row.type}] ${row.title}  (score ${row.score}; vec ${row.vector}; kw ${row.keyword})\n   ${row.file}\n\n${row.body}`,
              )
              .join('\n\n---\n\n')
            // 退化必须说出口：leanvec 不可用时检索只剩关键词通道，质量会明显下降。
            // 静默降级比报错更坏——你会以为"库里没有"，其实只是没检索到。
            const warning =
              found.mode === 'keyword'
                ? '\n\n[注意] 本地嵌入模型不可用，本次只用了关键词检索，召回质量下降。用 memory_status 查看详情。'
                : ''
            return { mode: found.mode, results: found.results, text: text + warning }
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
        description: 'Delete one workspace memory by id. Use when a memory is outdated or wrong.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Exact memory id from MEMORY.md or memory_recall.' } },
          required: ['id'],
          additionalProperties: false,
        },
        output: textOutput({ type: 'object', properties: { removed: { type: 'boolean' }, text: { type: 'string' } } }),
        async execute(args, exec) {
          try {
            const memoryDir = memoryDirOf(ctx, { agent: exec?.agent })
            if (!memoryDir) return { text: '无法定位工作区记忆库：当前会话没有可用工作目录。' }
            const removed = deleteMemory(memoryDir, String(args.id ?? ''))
            if (removed) await rebuildVectors(memoryDir)
            return {
              removed,
              text: removed ? `Deleted memory ${args.id}.` : `No memory with id ${args.id}.`,
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
        description: 'Report workspace memory health: root directory, memory count, index size, and vector coverage.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOutput({ type: 'object', properties: { text: { type: 'string' } } }),
        async execute(_args, exec) {
          try {
            const memoryDir = memoryDirOf(ctx, { agent: exec?.agent })
            if (!memoryDir) return { text: '无法定位工作区记忆库：当前会话没有可用工作目录。' }
            const items = listMemories(memoryDir)
            const index = readIndexForInjection(memoryDir)
            const vectors = loadVectors(memoryDir)
            const embedder = await resolveEmbedder()
            const lines = [
              `root: ${memoryDir}`,
              `memories: ${items.length}`,
              `index: ${Buffer.byteLength(index, 'utf8')} bytes, ${index.split(/\r?\n/).length} lines (limit ${CONFIG.indexMaxBytes} / ${CONFIG.indexMaxLines})`,
              `embedder: ${embedder ? 'leanvec (dim 256)' : 'unavailable -> keyword-only recall'}`,
              `vectors: ${vectors ? `${vectors.entries.length} entries in memory, built ${vectors.builtAt}` : 'none yet (rebuilt in memory on first recall)'}`,
              `recall: minVector=${CONFIG.minVectorScore} minKeyword=${CONFIG.minKeywordScore} weights=${CONFIG.weightVector}/${CONFIG.weightKeyword}`,
              `extraction: ${CONFIG.enableExtraction ? 'on' : 'off'}  diag: ${CONFIG.enableDiagEndpoint ? 'on' : 'off'}`,
              `config issues: ${configIssues.length === 0 ? 'none' : configIssues.join(' | ')}`,
            ]
            return { text: lines.join('\n') }
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
  const parsed = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
  const argv = forcedSub ? [forcedSub, ...parsed] : parsed
  const sub = argv[0] ?? 'overview'

  let memoryDir
  try {
    memoryDir = memoryDirOf(ctx, { agent: invocation?.agent })
    if (!memoryDir) {
      return { kind: 'error', text: '无法定位工作区记忆库：当前会话没有可用工作目录。' }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `Could not resolve the memory root: ${detail}` }
  }

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
      const lines = [
        `Memory root: ${memoryDir}`,
        `Memories: ${items.length}`,
        ...MEMORY_TYPES.filter((type) => byType.has(type)).map((type) => `  ${type}: ${byType.get(type)}`),
        `Index: ${Buffer.byteLength(index, 'utf8')} bytes / ${index.split(/\r?\n/).length} lines`,
        `Embedder: ${embedder ? 'leanvec dim 256' : 'unavailable (keyword-only)'}`,
        `Vectors: ${vectors ? `${vectors.entries.length} entries` : 'not built'}`,
        '',
        'Subcommands: /memory list | /memory pending | /memory accept <id> | /memory reject <id> | /memory extract | /memory forget <id> | /memory reindex',
        CONFIG.enableExtraction
          ? 'Extraction is ON (every N turns); /memory extract runs it now.'
          : 'Extraction is OFF in config; /memory extract still runs it once on demand.',
      ]
      return { kind: 'success', text: lines.join('\n') }
    }

    if (sub === 'list') {
      const items = listMemories(memoryDir)
      if (items.length === 0) return { kind: 'success', text: 'No memories recorded yet.' }
      const lines = items.map((item) => {
        const title = item.meta.title || item.body.split(/\r?\n/)[0] || item.id
        return `${item.id}  [${item.meta.type ?? 'project'}]  ${title}`
      })
      return { kind: 'success', text: lines.join('\n') }
    }

    if (sub === 'reindex') {
      const rebuilt = rebuildIndex(memoryDir)
      const built = await rebuildVectors(memoryDir)
      return {
        kind: 'success',
        text: [
          `Index rebuilt: ${rebuilt.count} memories, ${rebuilt.lineCount} lines / ${rebuilt.byteCount} bytes.`,
          `Vector index: ${built.mode}${built.indexed !== undefined ? `, ${built.indexed} entries` : ''}.`,
        ].join('\n'),
      }
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
      const lines = drafts.map((item) => {
        const title = item.meta.title || item.body.split(/\r?\n/)[0] || item.id
        const mark = item.meta.scope === 'global' ? '  ← 跨项目，建议写进 ~/.dsh/AGENTS.md' : ''
        return `${item.id}  [${item.meta.type ?? 'project'}]  ${title}${mark}`
      })
      const hasGlobal = drafts.some((item) => item.meta.scope === 'global')
      return {
        kind: 'success',
        text: [
          `待确认 ${drafts.length} 条：`,
          ...lines,
          '',
          '用 /memory accept <id> 收下，/memory reject <id> 丢弃',
          hasGlobal
            ? '标了「跨项目」的条目，收下后只存在本项目的库里；如果它其实适用于所有项目，建议手工搬到 ~/.dsh/AGENTS.md。'
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    }

    if (sub === 'accept' || sub === 'reject') {
      const targetId = argv[1]
      if (!targetId) return { kind: 'error', text: `用法：/memory ${sub} <id>` }
      if (sub === 'accept') {
        const result = await acceptPending(memoryDir, targetId)
        if (!result.ok) return { kind: 'error', text: result.error }
        return {
          kind: 'success',
          text: `已收下 ${targetId} → ${result.file}（向量 ${result.vectorMode}, ${result.vectorCount} 条）`,
        }
      }
      const result = rejectPending(memoryDir, targetId)
      if (!result.ok) return { kind: 'error', text: result.error }
      return { kind: 'success', text: `已丢弃 ${targetId}` }
    }

    if (sub === 'extract') {
      // manual: true —— 显式命令不受 enableExtraction 影响
      const result = await extractFromTurn(ctx, invocation.agent, memoryDir, { manual: true })
      if (result.skipped) {
        return { kind: 'error', text: `未抽取：${result.skipped}${result.raw ? `\n模型原始输出片段：${result.raw}` : ''}` }
      }
      return {
        kind: 'success',
        text: [
          `抽取完成：候选 ${result.candidates} 条 → 入队 ${result.queued} 条，去重丢弃 ${result.deduped} 条。`,
          result.queued > 0 ? '用 /memory pending 查看，/memory accept <id> 收下。' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    }

    /**
     * 删除一条已确认的记忆。
     *
     * 之前没有这个入口：`memory_forget` 工具只有模型能调，面板只能改不能删。
     * 而高置信度记忆是直接入库的——记错了人却删不掉，闭环就是断的。
     * 删除会先留历史版本（deleteMemory 内部），可回退。
     */
    if (sub === 'forget' || sub === 'delete') {
      const targetId = argv[1]
      if (!targetId) return { kind: 'error', text: `用法：/memory ${sub} <id>（用 /memory list 查 id）` }
      const items = listMemories(memoryDir)
      // 先精确匹配，再按前缀匹配，方便少打几个字符
      const exact = items.find((item) => item.id === targetId)
      const byPrefix = exact ? [] : items.filter((item) => item.id.startsWith(targetId))
      const target = exact ?? (byPrefix.length === 1 ? byPrefix[0] : null)
      if (!target) {
        return byPrefix.length > 1
          ? {
              kind: 'error',
              text: `前缀「${targetId}」匹配到 ${byPrefix.length} 条，请写完整 id：${byPrefix.map((item) => item.id).join(', ')}`,
            }
          : { kind: 'error', text: `没有 id 为「${targetId}」的记忆。用 /memory list 查看。` }
      }
      if (!deleteMemory(memoryDir, target.id)) {
        return { kind: 'error', text: `删除失败：${target.id} 不存在` }
      }
      const built = await rebuildVectors(memoryDir)
      return {
        kind: 'success',
        text: `已删除 ${target.id}（历史留档可回退；向量 ${built.mode}, ${built.indexed} 条）`,
      }
    }

    return {
      kind: 'error',
      text: `Unknown subcommand "${sub}". Use: /memory | /memory list | /memory pending | /memory accept <id> | /memory reject <id> | /memory extract | /memory forget <id> | /memory reindex`,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `Memory command failed: ${detail}` }
  }
}
