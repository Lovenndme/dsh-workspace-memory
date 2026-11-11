# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

DeepSeek Harness（DSH / Cordis）插件：工作区级持久记忆，仿 Claude Code 的 auto-memory 层。设计取舍与事故记录分别在 `README.md`（设计）和 `HANDOFF.MD`（当前状态 + 踩坑），改动前先读相关章节，改完同步更新。

- **没有构建步骤、没有运行时依赖**（只有可选的 `leanvec`）。纯 ESM，Node ≥ 18。
- git 仓库（`main`，2026-11-11 建立），`.gitattributes` 固定 LF。插件是 link 装进 profile 的——对它做 pnpm remove/重装会顺着 junction 删穿工作区（含 `.git`），见 `~/.dsh/AGENTS.md`。
- 以 link（junction）方式装进 DSH profile。改完后在 DSH 里对插件行 disable → enable 一次才会换模块代次；注册类改动后要确认 `application` 状态为 `applied` 且无 diagnostic，不能只看「没抛异常」。

## 常用命令

```bash
npm test                                                  # 全部（node --test 自动发现）
node test/recall.test.mjs                                 # 跑单个测试
node --check index.js && node --check client.js          # 语法检查（client.js 无法在 Node 里实际运行）
node --test --experimental-test-coverage --test-coverage-include=index.js   # 覆盖率
node eval/golden.mjs                                      # 召回金标集打分（纯本地）
node eval/sweep-min-score.mjs                             # 扫 minScore 闸门曲线
node eval/run.mjs                                         # 抽取准入评测（调 LLM，手动跑）
node scripts/install-deps.mjs                             # 把 leanvec 装进 ~/.dsh/dsh-workspace-memory-deps（约 85MB）
node scripts/reindex.mjs                                  # 手改记忆文件后重建 MEMORY.md
```

测试是独立脚本（自带 PASS/FAIL 打印，失败时 `process.exit(1)`），`node --test` 只负责发现与汇总。路由与工具测试用 `test/fake-host.mjs` 的假宿主（记录 `webServer/tools/commands` 注册、构造 req/res）。没装 leanvec 时检索退化为纯关键词，`golden.test.mjs` 会自动用放宽的门槛。

## 架构

两半，由 `package.json` 的 `dsh` 字段和 `cordis.patch.yml` 挂进宿主：

- **`index.js`（宿主半，Node）**：所有存储、检索、抽取逻辑，以及 `apply(ctx, rawConfig)` 里的全部注册。纯函数大多被 `export` 出来供测试直接调用。
- **`client.js`（客户端半，浏览器）**：`window.__ModuleLoader__.load({...})` 包裹，React 通过 `require('react')` 取得，无 JSX/打包。注册 `conversation.chat.commandview`（key `memory` / `memory_list`）卡片和 `sidebar.right.pane.tab` 记忆面板。中英文案字典**内联在 client.js 里**（`ZH` / `EN`），`locale/*.json` 只有包元信息。样式整体 scope 在 `.wsm-panel` 下，经 `ctx.effect` 注入 `<style>`。

### 存储

- 项目记忆：`~/.dsh/projects/<encodeProjectPath(项目根)>/memory/`，`MEMORY.md` 索引 + 每条一个 `<英文 slug>.md`（平铺）。插件私有状态在**同级**的 `.memory-state/{pending,history}/`。
- 「项目根」= 包含 cwd 的**最长已注册 DSH 工作区路径**（`projectRootFor`），不是 git root。编码规则与 DSH sessions 目录一致：`C:\a\b` → `--C-a-b--`。
- 全局记忆 = `~/.dsh/AGENTS.md`（`scope: 'global'`）。按 `## N.` 切章、写入后统一重排编号；受 `maxAgentsBytes` 硬限；更新协议是 `chapter: N` / 标题精确同名 / `newChapter: true`，三者都不满足就拒写并返回章清单（语义去重不可靠，故意不自动合并）。
- 向量**只在进程内存**（`vectorStore`），从不落盘；`recall` 按内容哈希对账，缺失或过期就增量重嵌。`leanvec` 三级解析：常规解析 → `~/.dsh/dsh-workspace-memory-deps/` → `~/.dsh/profiles/<name>/node_modules/`；都没有则降级为纯关键词（正常分支，不是故障）。

### 写入路径（`memory_remember`）

置信度分流 `rememberRoute()`（≥ `directWriteConfidence` 直写，否则进 pending）→ 条数硬限 `maxMemoryCount` → 查重（复用 `recall` 打分，`recordHits: false`）→ 命中 ≥ `duplicateThreshold` 则拒写，除非传 `supersedes: <id>`（覆盖并归档旧条）或 `newMemory: true`。覆盖/删除前都经 `archiveVersion` 留档到 `history/`。UI 编辑唯一入口是 `validateMemoryPatch`，落盘永远走 `serializeFrontmatter`。

### 召回与三个触发点

融合分 = 向量 0.65 + 关键词 0.35，再过 `minScore`（0.34，在金标集上扫出来的陡崖值）。**动了检索/权重/闸门就必须跑 `test/golden.test.mjs`，负样本误召（库里没有答案时返回了东西）是首要指标。**

| 宿主事件 | 作用 |
|---|---|
| `ctx.systemPrompt.context`（同步） | 每轮注入 `MEMORY.md`（200 行 / 25KB，超限写警告不静默截断）+ 预取缓存；`interpolate: false` 必须保留 |
| `agent/pre-step`（async waterfall） | 用用户消息 `await recall` 写入 `prefetchCache`；不往 messages 里塞合成消息 |
| `tools/post-execute` | 工具参数里的路径命中记忆 `paths` 时，结果末尾附 id + 标题（每轮每条一次） |
| `agent/turn-stopping` | 清预取缓存；自动抽取（默认关）→ 写 pending |

后两个触发点只给 id + 标题，正文必须走 `memory_recall`。注入、检索、抽取全部 try/catch 降级，**绝不能让记忆功能拖垮主对话**。

### 宿主 ↔ 面板

面板通过 `ctx.webServer.register` 的 HTTP 路由 `/api/dsh-workspace-memory/*` 通信。**`session` 查询参数必需**：宿主用它反查会话工作目录，查不到返回 400，绝不回退到默认目录（那会静默读到 0 条）。

## 会再踩的坑（均来自 HANDOFF 的真实事故）

- **id → 路径一律走 `idFile(dir, id)`**（内含 `isSafeId` + 包含性检查），写文件一律走 `writeFileAtomic`，frontmatter 一律走 `serializeFrontmatter`（歧义值 JSON 加引号，与 `parseFrontmatter` 互逆）。直接 `path.join(dir, \`${id}.md\`)` 曾让 `memory_forget` 能删掉 `~/.dsh/AGENTS.md`。只改 `hits/lastHit` 这类元数据时用 `withFrontmatterFields` 按行修补，不要整份重写。
- **HTTP 路由**用 `apply()` 里的 `getRoute` / `postRoute` / `replyOf` 包装：POST 强制 `application/json`（415），抛 `RequestError(status, reason, msg)` 表达可预期的失败，reason → 状态码在 `REASON_STATUS`。客户端的 `KNOWN_REASONS` 与 ZH/EN 的 `reason.*` 文案要同步加（`test/client-logic.test.mjs` 会查）。
- **AGENTS.md 按行处理时先算 `fenceMask(lines)`**，围栏代码里的 `#` 不是标题。只有 `## N.` / `### N.M` 算编号。
- **测试绝不能真的启动进程**：会走到 `openAgentsFile` 的测试先 `mod.setSpawnForTests(假实现)`，只断言命令行。2026-11-11 有条测试用 `cmd /c start AGENTS.bat` 验证启动，每跑一次 `npm test` 就在用户桌面上留下一个终端窗口。
- **测试会写真实的 `~/.dsh/AGENTS.md`**：`apply(ctx, rawConfig)` 第一行就 `configure(rawConfig)`，所以「先 `configure()` 再 `apply()`」等于重置为默认路径。配置必须经 `apply(ctx, { agentsFile: 临时路径, ... })` 传入；凡涉及 AGENTS.md 的测试都要像 `test/scope-routing.test.mjs` 那样前后快照比对真实文件。
- **新增配置键**：加进 `DEFAULT_CONFIG` 还不够，必须同时进 `STRING_KEYS` / `BOOLEAN_KEYS` / `NUMERIC_RULES` 之一，否则被静默忽略；坏值也会静默回落默认值，所以数值下限要容得下测试用值，并补一条「设置后读出来」的断言。
- **工具返回值不能含 `undefined` / `NaN` / `Infinity`**：宿主报 `value is not lossless JSON`，但副作用已经发生，调用方重试会造成重复写入。用条件展开 `...(x ? { x } : {})`。
- **无参命令不要声明 `input`**：`input: { hint: '' }` 会让整个插件激活失败。DSH 没有子命令补全，所以无参子命令拆成独立命令（`memory_extract` / `memory_pending` / `memory_list`），带 id 的仍走 `/memory <sub> <id>`。
- **不要在 profile 里跑 `pnpm install` / `pnpm remove`**，除非用户确认：插件是 link 安装，pnpm 会剪掉 link 目标的依赖，`pnpm remove` 还会删掉 link 目标本身。
- **link 安装解析不到宿主的 `zod` / `@deepseek-ai/schemastery` / storage-domain**，所以没有 `export const Config`，也不用 DSH storage；别引入需要它们的写法。
- **`memory_remember` 的 description 承载准入判据**，`test/admission.test.mjs` 逐条守住，改描述时同步改测试。
- **面板视觉验证**：`preview/verification/render-harness.html` 用迷你 hooks 运行时挂真实组件做 headless 截图；fixture 刻意不入库（含真实记忆）。重跑步骤与脚手架坑见 HANDOFF 第六节——截图「不对」时先怀疑脚手架。
