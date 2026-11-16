# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

DeepSeek Harness（DSH / Cordis）插件：工作区级持久记忆，仿 Claude Code 的 auto-memory 层。设计取舍与事故记录分别在 `docs/DESIGN.md`（设计）和 `HANDOFF.MD`（当前状态 + 踩坑），改动前先读相关章节，改完同步更新。根目录的 `README.md` 是写给使用者的安装与使用说明（随包发布），设计内容不要写进去，需要时一句话指向 `docs/DESIGN.md`。

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
node eval/remember.mjs --split=dev --max-requests=<N>     # 主路径评测（调 LLM、耗额度，手动跑，同一时间只跑一个）
node eval/remember.mjs --key-env=OLLAMA_API_KEY --base=https://ollama.com/v1 --model=deepseek-v4.1-flash:1017 --split=all --max-steps=24 --max-requests=<N>   # 目标模型评测的参数
node eval/remember.mjs --replay=<结果.json> --index=<插件>  # 离线重放已保存的模型调用，只检验代码路径（不发请求）
node eval/remember.mjs --export-prompts=<目录> --index=<插件>     # 导出每个场景第一步的提示（无答案），交给代理模型作答
node eval/remember.mjs --import-decisions=<目录> --index=<插件>   # 读回代理模型的答案，真实执行并计分（单步作答）
node eval/run.mjs                                         # 自动抽取旁路的评测（调 LLM，手动跑）
node scripts/install-deps.mjs                             # 把 leanvec 装进 ~/.dsh/dsh-workspace-memory-deps（约 85MB）
node scripts/reindex.mjs                                  # 手改记忆文件后重建 MEMORY.md
```

测试是独立脚本（自带 PASS/FAIL 打印，失败时 `process.exit(1)`），`node --test` 只负责发现与汇总。路由与工具测试用 `test/fake-host.mjs` 的假宿主（记录 `webServer/tools/commands` 注册、构造 req/res）。没装 leanvec 时检索退化为纯关键词，`golden.test.mjs` 会自动用放宽的门槛。

## 架构

两半，由 `package.json` 的 `dsh` 字段和 `cordis.patch.yml` 挂进宿主：

- **`index.js`（宿主半，Node）**：所有存储、检索、抽取逻辑，以及 `apply(ctx, rawConfig)` 里的全部注册。纯函数大多被 `export` 出来供测试直接调用。
- **`client.js`（客户端半，浏览器）**：`window.__ModuleLoader__.load({...})` 包裹，React 通过 `require('react')` 取得，无 JSX/打包。注册 `conversation.chat.commandview`（key `memory` / `memory_extract` / `memory_pending` / `memory_list`）卡片和 `sidebar.right.pane.tab` 记忆面板，页签定义带 `guide` 入口（右侧栏「开始」页的「记忆」一行）。面板 2026-11-15 重设计（总览 · 待确认 · 指令 · 记忆，视觉以 `preview/panel.html` 为准）：状态集中在每个实例一份的 store（`createPanel`），视图是「输入 store、输出元素」的普通函数，只有最外层 `MemoryPanel` 是 React 组件；视图用的 `h()` 是 `React.createElement` 的薄适配（`html` → `dangerouslySetInnerHTML`、CSS 文本 → style 对象、`onMount` / `onUpdate` 经 ref 回调），改视图时照这个写法。中英文案字典**内联在 client.js 里**（`ZH` / `EN`，键必须一一对应、占位符一致），中文以语言 id `zh` 注册（不是 `zh-CN`，那样中文界面会回落到英文），`locale/*.json` 只有包元信息。样式整体 scope 在 `.wsm-panel` 下（含 tooltip、菜单、对话框，都渲染在面板根节点内），颜色只用 `--dsw-alias-*`，经 `ctx.effect` 注入 `<style>`。上限（`limits`）、工作区名、历史目录都取宿主 `/list` 的返回，旧宿主缺这些字段时界面不显示上限、不拦长度，不能写死。

### 存储

- 主目录一律经 `dshHome()`（`$DSH_HOME` 非空白时用它，否则 `~/.dsh`），不要再手拼 `os.homedir(), '.dsh'`；写给用户或模型看的文字用 `dshHomeDisplay()`（`~/.dsh` 或 `$DSH_HOME`）。下文的 `~/.dsh` 都指它。
- 去向由 `scope`（适用范围）× `load`（加载方式）决定：`project + on-demand` 进项目库，`global + on-demand` 进全局按需库，`global + always` 进全局 AGENTS.md 的一章，`project + always` 不写（返回 `belongs-in-project-agents`，指向往上最近的 `.git` 目录下的项目 AGENTS.md）。`user` / `feedback` + `global` 一律按 `always` 处理。设计理由与用户的去处决定见 `docs/DESIGN.md`「记忆写到哪」。
- 项目库：`~/.dsh/projects/<encodeProjectPath(项目根)>/memory/`，`MEMORY.md` 索引 + 每条一个 `<英文 slug>.md`（平铺）。插件私有状态在**同级**的 `.memory-state/{pending,history}/`。
- 全局按需库：`~/.dsh/dsh-workspace-memory/global/memory/`，唯一入口 `globalMemoryDirOf()`（配置键 `globalMemoryDir`）。布局与项目库相同，`.memory-state/` 只放 history；草稿不论去向，永远在会话所在项目的 `pending/`。两个库之间 id 不重复（`avoidIds`）。
- 「项目根」= 包含 cwd 的**最长已注册 DSH 工作区路径**（`projectRootFor`），不是 git root。编码规则与 DSH sessions 目录一致：`C:\a\b` → `--C-a-b--`。项目指令的根（`instructionsRootFor`，往上最近的 `.git`）是另一回事，只用来告诉模型项目 AGENTS.md 在哪。
- 全局常驻 = `~/.dsh/AGENTS.md`（`scope: 'global'` + `load: 'always'`）。按 `## N.` 切章、写入后统一重排编号；受 `maxAgentsBytes` 硬限；更新协议是 `chapter: N` / 标题精确同名 / `newChapter: true`，三者都不满足就拒写并返回章清单（语义去重不可靠，故意不自动合并）。
- 向量**只在进程内存**（`vectorStore`），从不落盘；`recall` 按内容哈希对账，缺失或过期就增量重嵌。`leanvec` 三级解析：常规解析 → `~/.dsh/dsh-workspace-memory-deps/` → `~/.dsh/profiles/<name>/node_modules/`；都没有则降级为纯关键词（正常分支，不是故障）。

### 写入路径（`memory_remember`）

2026-11-14 重设计，之后经两次独立审查修复、一轮代理模型评测驱动的改动；设计与局限在 `docs/DESIGN.md`「记忆写到哪」「记忆怎么进库：按来源分流」，状态、审查、评测与未验证项在 HANDOFF 第二十五节。`execute` 的顺序：

1. `checkRememberArgs` 自行校验入参，非法枚举或缺必填返回 `invalid-argument`，一个字都不写（`scope` 在 `required` 里，但缺失仍取 `project`）。
2. **先看 `type` 是否属于改道类型**（`ROUTED_TYPES`：`procedure` / `repo-rule` / `docs`）：是就什么都不保存，`routedReply` 返回 `belongs-elsewhere` 与 `home` 及去处说明。例外是「更新留在原处」：同时带 `supersedes` 且能解析到确实存在的记忆（`keptAsMemoryTarget`）时不改道，按被取代那条的类型、`load: on-demand` 走下面的正常写入，返回带 `keptAsMemory: true`。
3. 定加载方式：`type` 为 `user` / `feedback` 且 `scope: global` 的一律 `always`（`resolveLoad`、`ALWAYS_TYPES`），调用方显式给了 `on-demand` 被覆盖时返回带 `loadForced: true`；「更新留在原处」的写入不受影响。然后 `project + always` 直接拒写（`belongs-in-project-agents`）。
4. `source: user` 时**总是**核对证据，两道都过才算核实：出处（`verifyEvidenceFrom`：先查 pre-step 缓存，没通过再回落会话快照）与相关（`evidenceRelates`，比对标题、摘要、正文）。结果存进 `evidenceVerified`（草稿与正式记忆都存）。然后 `rememberRoute()` 分流：`always` 不论来源一律进 pending；`user` 且核实的按需写入直写，未核实进 pending；`agent + on-demand` 看 `agentWrites`。
5. `load: always` 只用 `planAgentsChapter` 校验章节协议（只判断不写）再入队，草稿存章号与章标题；`memory_remember` 不直写 AGENTS.md。带 `supersedes` 时先用 `lookupSuperseded` 解析（解析不到照样拒写），把旧条 id 与 `supersedesScope` 记进草稿；用户收下时先写章节，写成功后 `retireSupersededMemory` 归档删除旧条，丢弃或章节写入失败时旧条不动。
6. 按需写入依次过 `needs-slug`、`supersedes` 解析（本库可用唯一前缀；跨库只认精确 id，跨库时先 `moveMemory` 搬过来）、查重（两个库一起比，复用 `recall` 打分，`recordHits: false`；命中 ≥ `duplicateThreshold` 拒写，除非 `supersedes` 或 `newMemory: true`）、条数上限（两个库分别计数），**之后**才按分流结果直写或入队。入队时同 slug 且同意图的草稿被覆盖（`queuePending`）；直写成功后清掉同 slug 且同意图的旧草稿（`clearDraftsFor`）。

覆盖/删除/换库前都经 `archiveVersion` 留档到 `history/`。写入后的索引重建走 `rebuildIndexQuietly`：失败不抛（记忆已落盘，抛了调用方会重试），但会记下来，返回值带 `indexStale`、`memory_status` 会明说。`moveMemory` 失败分 `move-failed`（已回滚）与 `move-partial`（回滚也失败，两个库各一份），换库后补丁失败是 `partially-saved`。UI 编辑唯一入口是 `validateMemoryPatch`，落盘永远走 `serializeFrontmatter`。

### 召回与三个触发点

融合分 = 向量 0.65 + 关键词 0.35，再过 `minScore`（0.34，在金标集上扫出来的陡崖值）。**动了检索/权重/闸门就必须跑 `test/golden.test.mjs`，负样本误召（库里没有答案时返回了东西）是首要指标。**

| 宿主事件 | 作用 |
|---|---|
| `ctx.systemPrompt.section`（静态，name `workspace-memory`，order 3200） | 写入的行为指引 `MEMORY_SECTION`：四个归宿、何时处理、何时问用户 |
| `ctx.systemPrompt.context`（同步） | 每轮注入两个库的索引（项目库 200 行 / 25KB，全局按需库 `globalIndexMaxLines` 行，超限写警告不静默截断）+ 预取缓存；两个库都空且没有预取时返回空串；`interpolate: false` 必须保留 |
| `agent/pre-step`（async waterfall） | 把人写的消息收进 `userTextCache`（证据核对的主路径）；用同一批人写的文本 `await recall` 两个库写入 `prefetchCache`；不往 messages 里塞合成消息；始终只调一次 `next()` |
| `tools/post-execute` | 工具参数里的路径命中两个库的记忆 `paths` 时，结果末尾附 id + 标题（每轮每条一次） |
| `agent/turn-stopping` | 清预取缓存；自动抽取（默认关，接上 `payload.signal`）→ 写 pending |
| `agent/status` / `agent/disposed` | 清「本轮已提示」；清计数器、预取与原话缓存 |

预取与 paths 提示只给 id + 标题，正文必须走 `memory_recall`。注入、检索、抽取全部 try/catch 降级，**绝不能让记忆功能拖垮主对话**。

### 宿主 ↔ 面板

面板通过 `ctx.webServer.register` 的 HTTP 路由 `/api/dsh-workspace-memory/*` 通信。**`session` 查询参数必需**：宿主用它反查会话工作目录，查不到返回 400，绝不回退到默认目录（那会静默读到 0 条）。

## 会再踩的坑（来自 HANDOFF 记录的真实事故与官方插件开发说明）

- **id → 路径一律走 `idFile(dir, id)`**（内含 `isSafeId` + 包含性检查），写文件一律走 `writeFileAtomic`，frontmatter 一律走 `serializeFrontmatter`（歧义值 JSON 加引号，与 `parseFrontmatter` 互逆）。直接 `path.join(dir, \`${id}.md\`)` 曾让 `memory_forget` 能删掉 `~/.dsh/AGENTS.md`。只改 `hits/lastHit` 这类元数据时用 `withFrontmatterFields` 按行修补，不要整份重写。
- **HTTP 路由**用 `apply()` 里的 `getRoute` / `postRoute` / `replyOf` 包装：POST 强制 `application/json`（415），抛 `RequestError(status, reason, msg)` 表达可预期的失败，reason → 状态码在 `REASON_STATUS`。客户端的 `KNOWN_REASONS` 与 ZH/EN 的 `reason.*` 文案要同步加（`test/client-logic.test.mjs` 会查）。
- **AGENTS.md 按行处理时先算 `fenceMask(lines)`**，围栏代码里的 `#` 不是标题。只有 `## N.` / `### N.M` 算编号。
- **测试绝不能真的启动进程**：会走到 `openAgentsFile` 的测试先 `mod.setSpawnForTests(假实现)`，只断言命令行。2026-11-11 有条测试用 `cmd /c start AGENTS.bat` 验证启动，每跑一次 `npm test` 就在用户桌面上留下一个终端窗口。
- **测试会写真实的 `~/.dsh/AGENTS.md` 和全局按需库**：`apply(ctx, rawConfig)` 第一行就 `configure(rawConfig)`，所以「先 `configure()` 再 `apply()`」等于重置为默认路径。配置必须经 `apply(ctx, { agentsFile: 临时路径, globalMemoryDir: 临时路径, ... })` 传入；凡涉及这两处的测试都要用 `test/fake-host.mjs` 的 `realFilesGuard()` 前后比对真实文件的哈希。
- **测试文件的第一个 import 必须是 `test/isolate-home.mjs`**：它把 `DSH_HOME` 指到本文件独占的临时目录（所有主目录路径都经 `dshHome()`，每次调用重读环境变量），退出时恢复并清理。漏了它，没传 `globalMemoryDir` 的测试会落到真实主目录——审查在模拟的真实主目录下复现过测试搬走全局库里的条目。新增测试文件时别忘了；目前只有只读 `client.js`、不加载 `index.js` 的 `client-logic.test.mjs` 例外。
- **新增配置键**：加进 `DEFAULT_CONFIG` 还不够，必须同时进 `STRING_KEYS`（固定取值的再进 `STRING_CHOICES`）/ `PATH_KEYS` / `BOOLEAN_KEYS` / `NUMERIC_RULES` 之一，否则被静默忽略；坏值也会静默回落默认值，所以数值下限要容得下测试用值，并补一条「设置后读出来」的断言。删掉的键挪进 `DEPRECATED_KEYS`，否则用户配置里的旧键只会得到一句「未知配置项」。
- **工具返回值不能含 `undefined` / `NaN` / `Infinity`**：宿主报 `value is not lossless JSON`，但副作用已经发生，调用方重试会造成重复写入。用条件展开 `...(x ? { x } : {})`。
- **无参命令不要声明 `input`**：`input: { hint: '' }` 会让整个插件激活失败。DSH 没有子命令补全，所以无参子命令拆成独立命令（`memory_extract` / `memory_pending` / `memory_list`），带 id 的仍走 `/memory <sub> <id>`。可点选的子命令列表只能在客户端做：`commandUi.decorate` 给「只敲 `/memory`」挂选单（client.js `registerMemoryPicker`，HANDOFF 第二十八节）。命令回执只给人看；给模型看的文字由 `test/model-visible-text.test.mjs` 按基线逐字守着。
- **不要在 profile 里跑 `pnpm install` / `pnpm remove`**，除非用户确认：插件是 link 安装，pnpm 会剪掉 link 目标的依赖，`pnpm remove` 还会删掉 link 目标本身。
- **link 安装解析不到宿主的 `zod` / `@deepseek-ai/schemastery` / storage-domain**，所以没有 `export const Config`，不用 DSH storage，也不用 `ctx.sessionProjections`；别引入需要它们的写法。
- **`client.js` 的模块 id、`package.json` 的 name、`cordis.patch.yml` 的行名必须是同一个字符串**（现在是 `@lovenndme/dsh-workspace-memory`）：宿主 `dsh-client-modules` 按包名找浏览器 factory，id 对不上时前端整半不加载（命令卡回落成宿主默认折叠卡、面板不注册），行名与包名不一致时宿主干脆不把它当客户端行、不报错。2026-11-16 改包名漏改 `client.js` 就是这样坏的；`test/client-logic.test.mjs`「模块身份」守着。前端没生效时的排查与重载方法见 `docs/PANEL.md` §8（正式版 DSH 没有 Ctrl+R）。
- **右侧栏「开始」页的入口只能经页签定义的 `guide` 字段贡献**（宿主 `tab-registry.ts` / `GuideBody.tsx`），「更多工具」卡被宿主固定在最后，插件入口排不到它下面；入口文案、`order`、图标见 `memoryTabDefinition()`。
- **提示词要分层，同一条规则只出现一处**（官方 tool-design.md）：行为指引走 `ctx.systemPrompt.section`（`MEMORY_SECTION`），参数规则写在参数上（`TYPE_RULES` 等常量，抽取提示词复用同一批），工具说明只写做什么、何时用、返回什么。改措辞时动的是常量；`test/admission.test.mjs` 守的是结构（哪段在哪、各出现一次、长度上限），不守句子。把规则塞回工具说明会让测试失败，也会让工具与抽取两套口径重新各自漂移。
- **宿主不校验直接注册的工具 schema**：`enum` / `required` 只是写给模型看的，非法值会原样进 `execute`。枚举与必填要在 `execute` 里自己校验（`checkRememberArgs`，返回 `invalid-argument`）；以前非法的 `scope` 被静默当成默认值，写到了模型没想要的地方。
- **用户原话只认 `source.kind === 'user'` 的消息**：宿主注入的上下文（子目录 AGENTS.md、skill、runtime-context 快照——本插件的记忆索引就在里面）在会话里也是 `user/message`。只按文本前缀过滤挡不住，证据核对会被注入内容「证实」。没有 `source` 的消息也不算，文本里任意位置的 `<system-reminder>` 块要先剥掉。过滤口径只有 `humanTextOf` 一份（缓存、快照回落、预取共用）。
- **`session.snapshotEvents()` 已被官方弃用**（new calls are prohibited），不要新增调用。证据核对的主路径是 `agent/pre-step` 收进来的缓存，快照只作回落（DSH 重启后恢复的会话）；自动抽取的 `recentTranscript` 是既有逻辑。
- **跨库操作只认精确 id，前缀匹配只在库内用**：跨库也接受唯一前缀时，往项目库写一条只带短前缀 `supersedes` 的记忆，就能把全局库里不相关的条目搬走删掉。
- **草稿的覆盖与清理都用意图（`draftIntent`：scope、load、supersedes、章号、newChapter）判断，不要只比 slug**：只比 slug 时，一条「常驻 + 取代 X」的草稿会被同 slug 的普通草稿整个盖掉，或被一次不带 supersedes 的直写清掉，它要做的事就丢了。
- **章节草稿按章标题定位，不按章号**：章号只供面板显示。按章号定位时，用户删掉前面任意一章、编号整体前移，草稿就永远收不下了。
- **证据核对是出处核对，不是语义校验**：它只证明「这句话出自用户、与这条记忆沾边」，截取否定句的后半段照样能过。别指望它判断语义，也别用否定词黑名单之类的办法去补（误伤与漏网都多）；防线是常驻一律待确认、面板标「未核实」、提示文案不教模型怎么绕——返回文本别说「怎样才算沾边」，那等于教模型把用户的话抄进标题。
- **单元测试全绿不代表实现没问题**：实施期间测试一直全绿，两次独立审查仍各发现 11 项、8 项，复审的问题多数出在上一轮的修复里。改动写入路径（分流、证据、草稿、移库、AGENTS.md）后，要另请没看过设计过程的人做带复现脚本的审查；修复以复现脚本为验收标准，并补反例测试（`test/review-fixes.test.mjs`、`test/review2-fixes.test.mjs`）。
- **归宿判断靠 `type` 上的归类，不靠提示词里的建议**：三版提示词下归宿场景始终不稳，让模型在调用时表态才稳。新增类型取值时分清「会保存的」（`MEMORY_TYPES`，存储、面板、编辑接口、抽取都认）和「只改道的」（`ROUTED_TYPES`，永远不落盘）；把改道类型加进 `MEMORY_TYPES` 会让它们被当成记忆存下来。
- **改道不能越过更新**：带 `supersedes` 且旧记忆确实存在时按更新处理（`keptAsMemory`），否则模型把一次更新归类成 `repo-rule` 时什么都不存，旧记忆就成了与用户最新说法相反的过期记忆。
- **提示词里的例子不要与评测场景重合**：否则等于把考题写进提示词，评测分数会虚高。
- **去处规则以用户的决定为准**：规则以 AGENTS.md 为准（项目记忆库不存规则），跨项目的做事与表达偏好进全局 AGENTS.md 常驻。不要为了省常驻开销把偏好挪回按需库——那是被用户推翻过的设计倾向（HANDOFF 25.11）。
- **强制常驻与取代旧条是一起的**：`user` / `feedback` + `global` 强制常驻之后，更新一条按需库里的旧偏好就会走常驻分支；常驻草稿若不带取代对象，收下后同一条偏好会有两个出处。改这两处任何一处时都要连着看另一处，并保证「先写章节、写成功再删旧条」的顺序。
- **评测里的「提议」要求写入动作作用于归宿**：只提到 AGENTS.md 不算提议；计分放宽这一条，「嘴上说说」就会被算成去对了归宿。
- **回复里说「记下了」必须以工具调用为准**：工具没被调用时插件什么都看不到、拦不住。目标模型曾在决定先问用户去处时，回复里却说成已记下，用户会以为记了；系统提示段为此写明「没调用 `memory_remember` 并拿到返回前不要说记下了」。评测时把「声称已记但没有成功调用工具」当作一项单独的检查。
- **代理模型评测（`--export-prompts` / `--import-decisions`）是单步作答**：模型看不到工具返回和仓库内容，自动分数会低估要改文件的归宿场景，下结论前要人工读答案；每个场景只采样一次，单个场景的翻转不算信号，只认同一类场景整体翻转。代理模型的数字也不能套用到目标模型上。
- **`tools/post-execute` 监听器必须经过 `next()`**：不提示时 `return next()`；要加料时先 `await next()`，只在下游接受且没换 value 时替换 content，返回值不带 `value` 键（content 与 value 只能二选一）。以前命中时不调 `next()`，会跳过其它插件的后置监听器。
- **主路径评测（`eval/remember.mjs`）的环境坑**：假工具回固定文本会让模型反复试探环境，测到的是它怎么对付假环境；步数太少会在收尾前截断，而「记不记」恰恰发生在收尾（默认 16 步）；不要用「最后一步只开放记忆工具」强制收尾，那等于暗示模型去记。评测会消耗模型额度：设 `--max-requests`，同一时间只跑一个——两份并行时曾在中途把额度耗尽，两份都没跑完。额度不够时可以用 `--replay` 把已保存的真实模型调用重放到新版本上检验代码路径，但它不重新采样模型，测不出提示词改动的效果；重放前先把记录重放到它原本对应的版本上自检，逐次一致才可信。
- **面板视觉验证**：`preview/verification/render-harness.html` 挂 client.js 里**真实的**面板组件（默认迷你 React 运行时；`?react=<React 18 UMD 目录>` 换真 React，`&strict=1` 包 StrictMode），宿主 token 与外框样式运行时从 `preview/panel.html` 取，数据读 `preview/verification/fixture.json`（虚构示例，POST 在内存里模拟）。必须经 http 打开（file:// 下 fetch 不可用），完成后标题以 READY 开头。截图与 `preview/panel.html` 同参数对照（`?w=340|960&view=…&theme=dark`），差异先怀疑脚手架。全局快捷键只在面板可见且焦点在面板内时生效——面板根节点 `tabIndex=-1` 就是为了让点到面板空白处也算「焦点在面板内」，别去掉。
- **面板交互回归**：`bash preview/verification/checks/run.sh [React 18 UMD 目录 URL]` 跑 `checks/*.check.js`（保存在途、章节与文件同步、快捷键与输入法、记忆身份与在途锁、卸载释放、「开始」页入口——后者用 `?view=guide` 的仿真，不等于真实宿主）；`?delay=<ms>` 让脚手架的每个接口延迟返回，专门暴露「请求在途」的窗口——2026-11-15 的独立审查查出的问题大多出在这个窗口里（在途时打字丢失、换编辑对象后回调落错地方）。改面板的保存 / 守卫 / 快捷键逻辑后跑一遍，迷你运行时与真 React（StrictMode）各一遍。playwright-cli 会把日志写进当前目录，脚本已先 cd 到临时目录；自己手动跑 playwright-cli 时也要先 cd 到仓库外。
