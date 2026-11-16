# HANDOFF

写给下一个接手的人（或下一轮的我）。记录**当前真实状态**、**踩过的坑**、**验证到了什么程度**。

---

## 一、当前状态（一句话）

2026-11-14 做完写入准入重设计（见第二十五节）：去向改由适用范围 × 加载方式决定并新增全局按需库，分流改为按来源并核对用户原话
（常驻一律由用户确认），新增 `pitfall` 类型，提示词按官方插件开发说明分层，面板跟上两个库。之后请没看过设计过程的审查者做了
**两次独立代码审查**并逐项修复（25.9）：第一次的结论是「不能装进真实 DSH」，复审的结论是「可以试用」。
接着由**代理模型评测**驱动改了一轮（25.5）：系统提示段迭代了三版，归宿判断改为「调用时必须归类」（`type` 的三个改道取值），`scope` 改为必填。
最后**在目标模型上完成了评测**（25.11）：用户逐条拍板「一条知识该放哪」，插件按此改了第九到十一轮（规则以 AGENTS.md 为准、
跨项目偏好强制进全局 AGENTS.md 常驻、常驻草稿收下时取代旧条）；之后又修了「说记下了却没调用工具」并在目标模型上复测，
最新合计在 46 个正常收尾的场景上判对 45 个（目标模型评测累计约 1670 次请求）。
`npm test` 40/40 通过。定稿状态下两种环境都重跑过：正常环境；以及把 `DSH_HOME` 指向一个预先放好 AGENTS.md、全局记忆、
项目记忆和旧位置记忆的模拟主目录——后者跑完后目录里的文件逐字节未变。

**三件事没有做完，接手前必须知道：**

1. **改动在工作区里，尚未提交。**
2. **评测是在模拟的对话里做的**：目标模型（DeepSeek V4.1 Flash）跑完了全部 52 个场景，但宿主是假的、仓库是虚拟的、每题只采样一次；
   仍判错的只有 F3（评测环境的局限），6 个场景 24 步用完没收尾，test 组有 4 题已不算留出；B、C、E、F、H、I、J、U 类的结果来自早两轮的版本，
   之后系统提示段改过两句、这些类别没有重跑，见 25.11。
3. **没有在真实 DSH 里装过、验证过**，面板的视觉也没有人看过；检查清单见 25.7，已知局限见 25.10。

上一轮（2026-11-11）的全量代码评测与修复见第二十四节，那一轮用户已在 DSH 里重载确认过（24.7）。
本目录从 2026-11-11 起是 git 仓库（`main`），每批修复一个提交。

---

## 二、本轮改动

| 文件 | 改了什么 |
|---|---|
| `client.js` | 面板整体重写（样式表 + 纯函数 + 5 个组件 + 状态机）；新增本地化键 101 条（中英各一份） |
| `test/markdown.test.mjs` | **新增**：Markdown 净化 / 链接协议 / 标签规范化 / 字段校验共 45 项断言 |
| `preview/verification/` | **新增**：3 张真实渲染截图 + 可重跑的渲染脚手架 |
| `README.md` | 待补：面板交互说明（编辑/预览、文件弹层、守卫） |

`index.js`（宿主）本轮**没有改**。存储布局、索引格式、检索与抽取逻辑均未动。

---

## 三、发现并已修复的真实 bug

1. **`isDirty()` 在没有草稿时返回 true**
   `sameDraft(null, null)` 返回 false，导致「面板打开后永远不自动选中第一条」，右侧一直空白。
   这个问题**只有真渲染才看得出来**，非渲染的 DOM 检查抓不到。

2. **保存目标用草稿 slug 反查 id**
   保存时本该用 `selectedId`。用 slug 反查会在「刚改过 slug」时找不到目标（改 slug 会换 id）。

3. **`action.openPanel` 文案缺失**
   `/memory_list` 卡片上的「打开记忆面板」按钮会直接显示原始 key。用脚本比对「使用的键 vs 字典里的键」才查出来。

4. **`renderMarkdown('')` 输出 `<p></p>`**
   空正文会渲染出一个空段落。已改为空白输入返回空串。

---

## 四、验证到了什么程度

**已做（可信）**

- `preview/verification/*.png`：把 **client.js 里真实的 MemoryPanel** 挂进页面渲染后截图
  （最小 hooks 运行时 + 真实样式表），三种形态：宽屏双栏、窄屏列表、窄屏详情
- 窄屏详情那张确认了**底部三个按钮在同一行**（用户反馈过的挤压问题）
- `node --check client.js` 通过
- `test/markdown.test.mjs` 45 项全通过（含 `javascript:` / `data:` / `file:` / 大小写变体 / 换行伪装等 XSS 用例）

**未验证（必须知道）**

- **没有在真实 DSH 宿主里看过**：浏览器控制不可用，无法对运行中的 Web UI 截图
- **预览 tab 的切换**：脚手架里点不动（详见「脚手架坑」3），只有代码路径推断，没有截图证据
- **未保存守卫弹窗**：同上，交互模拟没跑通
- **React 运行时语义**：脚手架是小运行时，并发/批处理/真实 diff 都不等价
- **leanvec 缺失下的语义检索**：见下

---

## 五、环境问题：leanvec 消失了（未修，需决策）

现象：`test/` 里 smoke / config / pending / extract / history 五套失败，根因是
`~/.dsh/profiles/desktop/node_modules/leanvec` 不存在 → 向量检索退化为纯关键词 → 语义查询 0 命中。

时间线：profile `package.json` 于 **16:27** 被改、`.modules.yaml` 15:20 —— 有别的会话跑过 `pnpm install`。

**根因是设计脆弱**：`leanvec` 声明在**这个 link 包**的 `optionalDependencies` 里，
pnpm 不保证为 link 目标安装依赖。首次能存在是历史遗留，下一次 install 就被剪掉。

建议（择一）：
- 把 `leanvec` 提到 profile 的 `dependencies`（需走 `install_bundle` 的安全流程）
- 或让插件从 dsh 安装目录解析 leanvec
- 或接受纯关键词模式，并让 `memory_status` 明确提示「向量不可用」

**未擅自处理**：跑 pnpm 有动到 link/junction 的风险（见记忆 `pnpm-remove-link-deletes-target`），需人工确认。

---

## 六、脚手架坑（重跑截图前必读）

`preview/verification/render-harness.html` 用最小 hooks 运行时挂真组件。踩过的坑：

1. **`file://` 下 `fetch` 不可用** → fixture 必须用 `<script>` 同步注入（`.wsm-fixture.js`）。
2. **hooks 不能用全局平铺数组** → 不同组件会串号（症状：输入框显示 `[object Object]`）。已改为按「组件实例路径」分槽。
3. **每帧重建 DOM 会让 ref 指向新节点** → `ResizeObserver` 盯着已摘除的旧节点、宽度读成 0，
   布局永远停在 `split`。对策：空依赖的效果每帧重跑 + 保留根容器。
4. **`ref` 必须真的挂上**，否则组件测不到容器宽度（同上症状）。
5. **`onChange` 要映射到 DOM 的 `input` 事件**（不是 `change`）。否则派发 `input` 时监听器不触发，
   守卫测试会假通过/假失败。
6. **`--dump-dom` 不等虚拟时间预算**，异步渲染看不到结果；**判断交互是否生效要用截图哈希比对**。
7. **headless 必须带 `--user-data-dir`**，否则命令被转交给已运行的 Edge 实例、静默什么都不做。
8. **URL 不要直接拼查询串**，PowerShell 会把 `?w=1` 拆成独立参数（用 `${var}?q=1`）。

重跑步骤：

1. `node --check client.js` 确认语法
2. 生成 fixture（**仓库里刻意不带**，因为它含真实记忆内容）：
   `GET /api/dsh-workspace-memory/list?session=<id>` + `GET /api/dsh-workspace-memory/agents`，
   合并写成 `preview/verification/fixture.js`，内容为 `window.__FIXTURE__ = { list, agents };`
3. headless 截图（**必须带 `--user-data-dir`**）：
   `msedge --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files --user-data-dir=<临时目录> --window-size=1440,900 --virtual-time-budget=12000 --screenshot=out.png file:///.../render-harness.html`
4. 交互与否 **用截图 SHA256 比对**，不要用 `--dump-dom` 判断（它不等虚拟时间预算）

---

## 七、写入 AGENTS.md 的格式规则（2026-11-02 补）

`promoteToAgents` 之前是**正文原样拼接**，实测有三个格式问题，已修：

| 问题 | 症状 | 现在的做法 |
|---|---|---|
| 正文自带 `##` 与外层 `## 标题` 同级 | 外层标题被架空，文档大纲被冲散 | 正文标题整体下沉：`#`/`##`→`###`，`###`→`####`（至少 `###`，永远挂在外层之下） |
| 尾部 `---` + 「迁移自 …」被带进来 | 条目出身混进全局准则，是噪音 | 剥掉尾部 provenance 块 |
| 连续空行 | 文件里出现 3+ 空行 | 压成单个空行 |

节与节之间统一一个空行，文件末尾一个换行；**只追加不改写**。

想追溯来源：promote 后记忆从项目库删除，但 `.memory-state/history/<slug>/<时间戳>.md` 留了完整副本。
**AGENTS.md 里刻意不写来源行**——与现有 5 节的风格保持一致（那 5 节也没有元数据）。

覆盖这部分的测试：`test/promote.test.mjs`（隔离临时目录 + 临时 AGENTS.md，15 组断言，
含标题层级、provenance 剥离、同名去重、作用域限制、删除留档、目标文件缺失）。

## 八、踩到的一个真 bug：字符串配置项被静默丢弃

`agentsFile` / `editorExe` 在 `DEFAULT_CONFIG` 里，但 `resolveConfig` 只有
`memoryDir`（字符串）、`BOOLEAN_KEYS`、`NUMERIC_RULES` 三个分支，**没有通用字符串分支**。
于是这两个键通过「已知键」检查后既不写入结果也不报错——**写了配置却完全不生效**。

后果：`editorExe` 从加入那天起就没生效过；第一次写 promote 测试时
`configure({ agentsFile: 临时路径 })` 被忽略，测试**直接写进了真实的 `~/.dsh/AGENTS.md`**
（已从备份还原，2471 字节 / 5 节，哈希核对未变）。

修法：加 `STRING_KEYS` 分支；`config.test.mjs` 补了 4 条回归断言。
**教训**：配置项加进 DEFAULT_CONFIG 不等于它生效，必须有一条「设置后读出来」的测试。

## 九、leanvec 缺失的根治（2026-11-02）

**根因**：`leanvec` 声明在本插件（link 安装）的 `optionalDependencies` 里，pnpm 不为 link 目标装依赖，
一次 `pnpm install` 就把它剪掉了 → 向量检索静默退化为纯关键词，5 套测试连锁失败。

**处理**：解析链加第 2 级——插件自有依赖目录 `~/.dsh/dsh-workspace-memory-deps/node_modules/leanvec`，
用 `node scripts/install-deps.mjs`（走 npm，不进 pnpm 依赖图）一次性安装。profile 怎么重装都碰不到它。

- 已验证：`resolveEmbedder()` 命中自有目录；**九套测试全绿**
- 换机 / 换 profile 只需重跑一次 `scripts/install-deps.mjs`
- 仍缺依赖时降级为 `keyword` 模式，不报错（`memory_status` 显示当前模式）

## 十、当前数据状态（2026-11-02 19:20）

- `~/.dsh/AGENTS.md`：**10 节 / 9054 字节**（原 5 节 + 新写入的 5 条跨项目记忆），
  每节末尾有 `<!-- 来自记忆 <slug>，写入于 YYYY-MM-DD -->` 来源注释（HTML 注释，渲染不可见）
- 项目记忆库：已清空（5 条全部 promote 到全局），只剩空 `MEMORY.md`
- 回退手段：`.memory-state/history/<slug>/` 保留 5 条完整副本；
  另有写入前的完整备份 `%TEMP%\AGENTS-before-promote-*.md`

## 十一、审核闭环（2026-11-02 晚）

用户定的规则：**置信度高的直接入库，只有不确定的才由人审核**。已落地：

- 新配置 `directWriteConfidence`（默认 0.8，`[0,1]`），`rememberRoute()` 判定分流，含边界等号
- `memory_remember` 低于门槛 → 写 `writePending`，返回 `pending: true` 与草稿 id；不写库
- 新增 `/memory forget <id>`（别名 `delete`，支持前缀匹配，歧义时报出全部候选）
- 面板待确认空状态文案改为说明「低置信度写入也会落到这里」

**顺带修的三个坑**：

1. `/memory extract` 曾被 `enableExtraction` 挡住 → 手动命令加 `{ manual: true }` 绕过（`test/extract-manual.test.mjs`）
2. `writePending` 不接受 `paths`，会被静默丢弃 → 补上，并在 `acceptPending` 里带出去
3. 命令只声明了 `description`，没声明 `input.hint` → 用户看不到可用参数，`extract` 一度被当成不存在
   （DSH 的补全只补命令名，没有子命令补全；`input.hint` 是唯一能提示参数的位置）

**仍然缺的**：面板上没有「删除」按钮。当前只能靠 `/memory forget <id>` 命令删。
若要在面板内完成「审核 + 清理」闭环，需要再加一个 host 路由（`POST /forget`）+ 详情页按钮。

> 2026-11-02 20:15 补：**已实现**。新增 `POST /api/dsh-workspace-memory/forget` 路由 +
> 详情底部「删除」按钮（`.wsm-btn.danger`），确认框与 promote 共用（`confirm` 现在携带
> title/message/okLabel）。单栏 footer 的 grid 改为 4 列（`minmax(0,1fr) auto auto auto`）。
> 已用 headless 截图核对：504px 下四个按钮仍在同一行。

**脚手架又一个坑**：`<select>` 的 `value` 必须在 `option` 生成之后赋值，否则落到第一项。
之前截图里下拉框全显示第一项，是脚手架的问题，不是组件的问题——已修
（`applyProps` 遇到 SELECT 先记 `dataset.pendingValue`，插完子节点再赋值）。
**教训**：截图看到"不对"时先怀疑脚手架，别急着改组件。

> 2026-11-14 注：本节的置信度分流已被第二十五节取代（25.2「分流」）：改为按来源分流并核对用户原话，
> `directWriteConfidence` 已废弃（写了会得到一条废弃提示），待确认空状态文案也改成了「助手自己总结的记忆会进到这里」。
> 删除入口、`/memory forget` 仍然有效。

## 十二、让子命令能在菜单里点选（2026-11-02 20:30）

**需求**：敲 `/memory` 后，子命令应像 `memory` / `memory_list` 那样出现在补全列表里，而不是手打。

**先查能力**（AGENTS.md 第一条）：DSH **没有参数级补全**。
client Service 只有 layout / locale / sessions / slots / theme / timer / uiWorkspace / workspaces，
`CommandInputDescriptor` 只有 `{ hint, attachments }`。补全列表列的是**命令名**。

**做法**：把不需要参数的子命令各注册成一个独立命令（`memory_list` 本来就是这么做的）：

| 命令 | 说明 |
|---|---|
| `memory` | 总览；带参数时走子命令（`list/pending/accept/reject/extract/forget/reindex`） |
| `memory_extract` | 立即跑一次抽取 |
| `memory_pending` | 查看待确认 |
| `memory_list` | 打开右侧栏面板 |

带 id 的 `accept / reject / forget` **没有**拆成命令：从菜单选中后仍要手打 id，
不如在面板的待确认/详情页点按钮。`executeMemoryCommand(ctx, invocation, forcedSub)`
用一个 `forcedSub` 参数把子命令塞回 argv，其余取值逻辑不变。

**踩的坑（重要）**：给无参命令也声明了 `input: { hint: '' }`，导致
`command "memory_extract" input hint must not be empty` —— **整个插件激活失败**。
`input` 是可选的，无参命令**不要声明**它。
教训：注册类改动后要确认 `application` 是 `applied` 且无 diagnostic，不要只看「没抛异常」。

## 十三、两个用户报障（2026-11-02 21:00）

### 13.1 VS Code 打不开 AGENTS.md

**根因**：`Code.exe` 只是 Electron 启动器，`spawn(Code.exe, [file])` **不会**把文件交给窗口
（实测：进程带不上文件参数，0 个匹配）。

**加剧因素**：`process.env.LOCALAPPDATA` 在 **C: 盘**，而 VS Code 装在 **D: 盘**，
所以按 `LOCALAPPDATA` 猜目录全部落空，只能靠 `App Paths` 注册表拿到 exe。

**修法**：先解析出 `Code.exe`（注册表优先），再找它**同级**的 `bin\code.cmd` 作为启动器，
标记 `viaShell: true`，用 `spawn(cmdString, { shell: true })` 启动。
Cursor 同理（`resources\app\bin\cursor.cmd`）。

**实证**：`POST /open-agents {editor:'vscode'}` → 进程 `Code.exe "...\AGENTS.md"` 出现，文件确实被打开。

### 13.2 AGENTS.md 格式统一

用户反馈：没有编号、列表标记混用（`-` 与 `1.` 各占一半）。

**新约定**（已写入 AGENTS.md 本身）：

1. 章节 `## N. 标题`，连续编号
2. 子节 `### N.M 标题`
3. 列表**一律有序数字**，不用 `-` / `*` / `·`
4. 标签固定四种、顺序固定：`**现象**` → `**做法**` → `**为什么**` → `**关联文件**`

**关键连带修改**：`promoteToAgents` 原来写 `## 标题`（无编号），
**每 promote 一次就把新格式破坏一次**。已改为：
`nextAgentsSectionNumber()` 取现有最大编号 +1，`formatAgentsBody(body, N)` 把正文标题
下沉后编号为 `N.1 / N.2 …`。演练验证：对真实文件副本追加一节得到 `## 12.` + `### 12.1/12.2`。

**内容零丢失核对**：30 条关键短语（命令、路径、数字、报错串）逐条比对旧文件，
全部保留（`objects/refs` 一条是格式差异导致的误报，内容在）。

## 十四、全局记忆：先调研，再自己做（2026-11-03）

**调研结论**（市场里 244 个记忆插件，只有 3 个沾「全局」）：

| 插件 | 全局载体 | 能管已有 AGENTS.md 章节？ |
|---|---|---|
| `@dennisrongo/dsh-memory` 0.1.3 (MIT) | 就是 `$DSH_HOME/AGENTS.md` | ❌ 只往 `## Memories` 追加 |
| `solopup-memory` 0.21-beta (MIT) | 自建库 + SQLite 控制库 | ❌ 无关 |
| `dsh-my-memory` 0.3.0 (MIT) | 自建 `memory.json` | ❌ 无关 |

后两个都另建全局库 → 会重新制造「两份全局真值」。所以自己加一个全局页签，
但**借鉴 dennisrongo 的判断**：全局记忆就该是 AGENTS.md，不另建存储。

**实现**：`parseAgentsSections` / `renumberAgentsLines` / `readAgentsDocument` /
`saveAgentsSection` / `deleteAgentsSection` / `appendAgentsSection` + 4 个端点 + 客户端 `AgentsPane`。

**两个被测试逼出来的设计决定**：

1. `#` 一级标题必须算「前言」，不能算章节——否则整个文件被当成一个块，写入时内容重复。
2. 保存时剥掉标题里的旧编号再重排——否则标题不匹配 `^## N.`，会丢掉章号。

**做不到的**：loader 不暴露服务，无法权威判断「是否被字节预算截断」，只能显示大小。

> 2026-11-14 注：「全局记忆就该是 AGENTS.md，不另建存储」这一结论已被第二十五节取代（25.2「三个问题」与去向表）：
> 全局记忆拆成两处——每轮常驻的仍是 AGENTS.md，「任何项目都成立、但只在特定场景才用」的进新增的全局按需库。
> 原因是审计时全局 AGENTS.md 里约 46% 的字节是这类场景性知识（25.1）。AGENTS.md 页签与章节读写函数仍然有效。

## 十五、记忆归属：scope 参数（2026-11-03）

之前 `memory_remember` **只能写项目库**（工具里连 `scope` 字段都没有），所以跨项目规则
（如 npm 发布规则）必然在项目库里另起一条，与 AGENTS.md 分叉。现在：

| `scope` | 去向 |
|---|---|
| `project`（默认） | `~/.dsh/projects/<key>/memory/<slug>.md` |
| `global` | `~/.dsh/AGENTS.md` 的一章：**同名章更新**，没有才追加（`upsertAgentsChapter`） |

低置信度（< `directWriteConfidence`）**仍然先入待确认**；收下时按草稿记录的 scope
落到 AGENTS.md（`acceptPending` 里分流）。理由：AGENTS.md 每轮注入所有项目，写错代价比项目记忆大。

### 事故：测试把章节写进了真实的 ~/.dsh/AGENTS.md

**现象**：`scope-routing.test.mjs` 第一版里 `configure({agentsFile: temp})` 之后再
`apply(ctx)`，结果真实 AGENTS.md 被追加了「## 12. 全局规则甲」。

**根因**：`apply(ctx, rawConfig)` 第一行就是 `configure(rawConfig)`。
传 `undefined` → 重置为默认值 → `agentsFile` 变回真实的 `~/.dsh/AGENTS.md`。
「先 configure 再 apply」等于没设置。

**修法**：config 必须经 `apply(ctx, { agentsFile, ... })` 传入；并加一条硬断言：
测试开始/结束时比对真实 AGENTS.md 全文，任何改动立刻 FAIL。
被污染的那一章已用 `deleteAgentsSection` 删除，文件恢复 **10499 字节 / 11 章**。

**教训**：写「会改用户全局文件」的功能时，**测试必须先证明自己没碰到真文件**，
而不是相信 configure 生效了。快照 + 前后比对是最便宜的证据。

> 2026-11-14 注：本节的 `scope` 设计已被第二十五节取代（25.2）：`scope` 只表示适用范围，加载方式由新参数 `load` 决定，
> `scope: global` 不再等于 AGENTS.md（`global + on-demand` 进全局按需库，`global + always` 才进 AGENTS.md）；
> 「低置信度先入待确认」改为按来源分流。本节的测试事故与教训仍然有效，全局按需库的测试同样要经 `apply` 传 `globalMemoryDir`。

## 十六、语义重复：不自动合并，改成强制确认（2026-11-03）

**先做了实验**（以本机 11 章标题为基准，字符二元组 Dice）：

| 同一主题换说法 | 相似度 |
|---|---|
| 换语序 | 0.90 |
| 缩短 | 0.47 |
| 口语化 | 0.23 |
| 换词（release/CI 定时批量） | 0.24 |
| **不相关的「界面文案不要加解释」** | **0.35** |

真重复 0.23–0.90，假重复 0.35 → **区间重叠**。所以「相似度超阈值就自动更新」这条路被否掉：
设 0.6 漏掉 3/4 的真重复，设 0.3 会把不相关的内容覆盖进去。

**改成协议层的强制确认**（`upsertAgentsChapter`）：

1. `chapter: N` → 覆盖第 N 章
2. 标题精确同名 → 更新
3. `newChapter: true` → 追加
4. 都不满足 → 拒写 + 回现有章清单，逼调用方逐条比一遍

代价：真正的新主题要多一次工具调用。收益：**不可能再悄悄产生分叉**。

## 十七、防止 AGENTS.md 膨胀（2026-11-03）

**问题**：AGENTS.md 每轮注入，条目只增不减 → 迟早把重要规则挤掉。实测瘦身前 10499 字节
≈ 4772 tokens/轮，其中 §11 一章占 29%，但里面 2/3 是 CI 文件路径、6 个步骤、run id
——这些要么能从仓库代码看出来，要么该在项目 README。

**原则**：常驻区只放**规则 + 指向细节的指针**，细节按需读取（渐进式加载）。

**准入五条**：跨项目成立 / 不能从代码推出 / 违反代价大 / 能写成动作 / 已发生 ≥2 次或单次代价极高。

**硬约束**：`maxAgentsBytes`（默认 10000，0 = 不限）。超限 `writeAgentsDocument` 返回
`agents-full` + `bytes/limit/current`，工具与面板都翻译成可操作提示（"先合并或删除一章"）。
删除是缩小，不受限制。

**实际瘦身**（用 `chapter: N` 通道改的，顺便验证了该通道）：

| 章 | 前 | 后 | 做法 |
|---|---|---|---|
| §11 npm 发布 | 3064 B | 927 B | 只留 4 条规则 + 门禁一行 + 指向 workflow 文件 |
| §10 bundle 热更 | 1266 B | 678 B | 现象/做法/为什么三行 + 指向 `dsh-command-context/README.zh.md` |
| **全文件** | **10499 B** | **7774 B** | 省 2726 B ≈ 1239 tokens/轮 |

**顺带修的格式 bug**：章节块的边界是「下一章标题的位置」，本身**不含**分隔空行，
替换后 `## 下一章` 会粘在上一章最后一行（Markdown 里标题失效）。已在 `writeAgentsDocument`
的组装层统一补空行，并加断言锁住。

`acceptPending` 走全局分支时直接传 `newChapter: true`——人已经在面板里按过「收下」，
不该再要求二次确认。

**编号策略**（用户 2026-11-03 定）：保持重排。删第 3 章后原 4–11 前移为 3–10，
子节 `11.1–11.6` 同步变 `10.1–10.6`。已知代价：正文里若写「见 §11」这类序号引用会漂移，目前没有这种引用。

> 2026-11-14 注：「准入五条」已被第二十五节取代（25.2「类型」）：它原本只为 AGENTS.md 防膨胀，搬去管所有写入后对
> user / feedback / reference 过严；现在「常驻与否」由 `load` 决定，「记不记」由各类型自己的门槛（`TYPE_RULES`）决定。
> `maxAgentsBytes` 硬限与「常驻区只放规则与指针」仍然有效。

## 十八、记忆库查重 + 覆盖（2026-11-03）

**问题**：`memory_remember` 只在 slug 相同时覆盖，slug 不同就并存。
于是「本地脚本是兜底」与「本地脚本已关闭」同时存在，召回读到哪条看分数
——**比没有记忆更糟**。这是用户列出的七项改进里排第一的（矛盾共存）。

**机制**（与 AGENTS.md 的 `newChapter` 同构，都是「拒写 + 回清单」）：

| 情况 | 行为 |
|---|---|
| 库空 / 无相近条目 | 直接写 |
| 最高分 ≥ `duplicateThreshold`（默认 0.62） | 拒写，返回 top-3 候选（id / 标题 / 分数） |
| `supersedes: "<id>"` | 覆盖：新条目记 `supersedes`，旧 id 删除并归档到 `history/` |
| `newMemory: true` | 确认独立，照常写 |
| `duplicateCheck: false` | 整体关闭 |

**两个实现细节**：

1. **查重不计 hits**：`recall` 新增 `options.recordHits`。查重是内部调用，若计数
   会把所有条目刷一遍 hits，淘汰统计立刻失真。
2. **覆盖时 slug 变了要删旧文件**：`writeMemory` 按新 slug 写新文件，
   若不删旧的就会出现「新旧并存」——正是要消灭的情况。所以 supersede 后
   显式 `deleteMemory(old)`（它自带归档），并返回 `replaced` 便于核对。

**测试**（`test/duplicate.test.mjs`，22 条断言）：空库不受影响、疑似重复拒写并回候选、
hits 不增长、`newMemory` 并存、`supersedes` 覆盖且旧正文进 history、
不相关主题不误拦、指向不存在的 id 明确报错、开关可关闭。

**未做**：`duplicateThreshold` 默认 0.62 是拍的，还没有金标集验证。
下一步按用户列的七项，第 2 项是 `paths` 触发提示——那个字段现在完全没用上。

## 十九、paths 触发提示（2026-11-03）

**问题**：`paths` 字段是纯摆设。写入时能标，读取时没有任何人看，
「什么时候该 recall」全靠模型自觉——整条链路里最不可靠的一环。

**做法**：监听宿主 `tools/post-execute`（waterfall，可 enrich 工具结果）。
工具参数里有真实路径，这是唯一能**精确**判断「此刻该想起哪条记忆」的位置。

| 约束 | 原因 |
|---|---|
| 只给 id + 标题 | 附正文等于每次读文件都在付 token 税 |
| 同一轮同一条只提示一次 | 读 10 个文件不该重复喊 |
| 异常/不命中一律 `next()` | 提示不能拖垮工具调用 |

`pathMatches` 的约定：相对工作区根、`*` 不跨目录、判据是「真实路径以模式结尾」
（所以绝对路径也能中），`foo/` 目录形式匹配其下所有文件。
**真机验证**（在本会话里做的，不是单测）：写一条 paths 指向
`dsh-workspace-memory/package.json` 的记忆，然后 `read` 该文件 —— 结果末尾确实出现
`[记忆] 这个文件有相关记忆…`，且未附带正文。验证后已删除探针。

### 踩到的坑：显式 `undefined` 不是 lossless JSON

第一次真机验证时，`memory_remember` **写入成功但工具报错**：

```
tool "memory_remember" returned invalid output: value is not lossless JSON
```

根因是我写 `replaced: replaced || undefined` —— 属性值为 `undefined` 时整条校验失败。
**注意危险点**：操作已经生效（记忆真的写进去了），但调用方收到的是错误，
会误判"没写成"而重试，于是产生重复条目。

修法：用条件展开 `...(replaced ? { replaced } : {})`，让键**不存在**而不是值为 undefined。
教训：工具返回值里永远不要出现 `undefined` / `NaN` / `Infinity`，用条件展开代替。

## 二十、体量与条数预算（2026-11-03）

用户的一句约束定了方向：**「如果确实需要比较长的说明，你给它截断了也不太好吧」**。
所以不是「一刀切字数」，而是按**成本发生在哪**分别处理：

| 成本 | 时机 | 策略 | 配置 |
|---|---|---|---|
| 条数（索引每轮注入） | **每轮** | 硬限，满了拒写 | `maxMemoryCount: 50` |
| 单条正文长度 | 只在 recall 那次 | **只提醒，不拦不截** | `warnBodyChars: 2000` |
| 一次召回总体积 | 特定调用 | 少带一条，不切正文 | `recallMaxChars: 12000` |

**库满时的拒绝**带淘汰候选（按 hits 最少、lastHit 最久排序——现有数据里最接近「该删」的信号），
并给两条出路：`supersedes: "<id>"` 合并，或先删；都值得留就调高上限。
`supersedes` 是替换不增加条数，**不受条数上限拦截**（有测试锁住）。

**召回预算的实现**：按分数顺序装入结果，累计正文超过 `recallMaxChars` 就停止，
返回 `omitted` 告知还有几条没返回。**单条正文永不截断**——
测试专门断言「返回的 body 与写入时完全一致」。

**踩到的坑**：`recallMaxChars` 的下限我一开始设成 1000，测试传 400 被 config 校验拒掉、
静默回落到 12000，于是预算测试假通过（以为没生效是逻辑问题）。改下限为 100 后正常。
教训：数值配置的下限要考虑可测试性，否则测试根本测不到那条路径。

## 二十一、召回金标集 + 负样本（2026-11-03）

**产出**：`eval/golden/`（语料 + 查询集）、`eval/golden.mjs`（跑分）、
`eval/sweep-min-score.mjs`（阈值扫描）、`test/golden.test.mjs`（CI 门槛）。

**语料**：5 条真实记忆（从 `history/` 取的原文）+ 5 条不同主题的合成记忆 = 10 条 10 主题。
**查询**：10 正（用症状/口语提问，不抄标题）+ 8 负（库里确实没有的主题）。

### 第一次跑就抓到一个严重缺陷

```
recall@1 70%  recall@3 90%  负样本误召 100%   ← 8 个库里没有的问题，全部返回了东西
```

根因：原来的判据是「向量分 ≥ 0.3 **或** 关键词分 ≥ 0.5 就入选」。
leanvec 是静态嵌入，任意文本余弦都容易过 0.3，**等于没有闸门**。
只测正样本的话，这个缺陷永远看不见——这正是负样本的价值。

### 修法：加融合分闸门 `minScore`

先用分布看能不能分开：正样本 top1 落在 0.378–0.650，负样本 0.214–0.332，中间有空档。
再扫 `minScore`：

| minScore | recall@3 | 负样本误召 |
|---|---|---|
| 0.30 | 90% | 50% |
| 0.33 | 90% | 13% |
| **0.34** | **90%** | **0%** |
| 0.35 | 80% | 0% |

取 **0.34**。注意 0.33→0.34 之间误召从 13% 跳到 0%，**是陡崖**——说明这是 18 条小样本
调出来的，真实语料变大后必须重跑 `sweep-min-score.mjs` 再定。

**顺带修的一个浪费**：`indexTextOf` 原来只拼 title/tags/body，**漏掉了 `description`**
（人工写的一行摘要，信息密度最高）。已补上。

### CI 门槛

`test/golden.test.mjs` 断言 recall@1 ≥ 70%、recall@3 ≥ 85%、负样本误召 ≤ 12%
（略低于实测，留一条余量；没有 leanvec 的机器退化成纯关键词，用放宽的门槛）。
已知未命中：`pos-npm-cadence`（"包改完就想发版" 与 "npm 发布" 的字面/语义距离偏大）。

**方法论**：这个评测不调 LLM、纯本地，所以能进 CI；而 `eval/run.mjs`（抽取准入）
必须调模型，只能手动跑。两者量的是不同环节，别混。

## 二十二、召回触发点③：用户消息预取（2026-11-03）

**缺口**：原本只有两个触发点——会话开始（索引注入）、碰到文件（paths 提示）。
用户直接提问时**没有任何触发**，「要不要 recall」全看模型自觉。

**宿主能力调研**（决定了实现路径）：

| 事件 | 能否注入 | 能否看到用户消息 |
|---|---|---|
| `system-prompt/assemble` | ✅ 可改 contexts | ❌ `AssembleContext` 只有 `{scope, signal}` |
| `agent/pre-step` | ⚠️ 只能**替换** messages | ✅ `messages: UserMessage[]` |

**所以**：在 `agent/pre-step`（async waterfall）里 `await` 一次真正的 recall，存进
`prefetchCache`；注入的 `context.text`（同步）只读缓存。**不往 messages 里塞合成消息**
——那会污染对话记录，也没有必要。

注入效果：

```
[相关记忆] 与本轮请求最接近的条目（需要细节时调 memory_recall）：
- npm-publish-cadence — npm 发布：只走 GitHub Actions 每 4 小时批量发
```

只给 id + 标题；用金标集标定过的同一个 `minScore` 闸门，所以无关提问不会乱列。
回合结束（`agent/turn-stopping`）清缓存，避免跨轮污染。`prefetchRecall: false` 可关。

### 测试里踩的两个坑

1. **拿整段注入去断言「无关条目不在里面」是错的**——索引本身就会列出全部条目。
   必须只截 `[相关记忆]` 之后那段来断言。
2. **测试用的提问要实测过闸门**：我一开始拿 `pos-npm-cadence` 那个已知未命中的说法
   （"这个包改完就想发版…"）当 fixture，结果自然没有预取段。换成实测 0.40 分的那句才行。
   顺带发现：同一条记忆，**正文越长关键词分被稀释得越厉害**（同样的提问在短正文下 0.358、
   长正文下直接掉到闸门以下），这解释了金标集里那条未命中。

## 二十三、准入判据与写入/更新时机（2026-11-03）

**决定**：这一层主要是**策略**，不是过滤器。代码没法可靠判定「这句话值不值得记」，
硬拦会误伤（"改成 X" 有时确实是长期约定）。所以：

| 承载物 | 装什么 | 成本 |
|---|---|---|
| `memory_remember` 的 **description** | 五条准入判据 + 写入/更新时机 + 反例 | 随工具 schema 进入上下文，**不额外占注入预算** |
| 代码护栏 | `paths` 有效性校验 | 确定性、可测 |

工具描述里写的（`test/admission.test.mjs` 逐条守住，防止被重写时无声退化）：

1. **五条准入**：任务结束后仍成立 / 不能从代码推出 / 违反代价大 / 能写成动作 / 已发生≥2 次或单次代价极高
2. **明确不记**：任务指令、状态（"我在做 X"）、diff 里能看到的、可能明天就被推翻的决定
3. **写入时机**：用户显式要求或**纠正**（最强信号）立即写；强结论在**任务结束**时写，不在中途
4. **更新时机**：用户改主意就用 `supersedes`，不要让两条互相矛盾的记忆并存
5. `paths` 的用途（驱动文件提示），写错就永远不触发

**代码护栏**：`pathHintIssue()` 识别 `"插件配置"`、URL 这类不是路径的条目，
写入时在结果里点名并给出正确写法——**不硬拦**，因为可能有正当用法。

**一个刻意的边界**：测试里专门断言「明显像任务指令的内容也不会被拦」。
这是把"不做内容过滤"这个决定写进测试，免得以后有人加个正则当过滤器以为更严格。

> 2026-11-14 注：「判据写在工具描述里」与「五条准入」已被第二十五节取代（25.2「提示词分层」）：行为指引移到系统提示段
> `MEMORY_SECTION`，各条规则挂在各自的参数上（`TYPE_RULES` 等常量，抽取提示词复用同一批），工具说明只写做什么、何时用、
> 返回什么；`test/admission.test.mjs` 改为只守结构，不再逐条守句子。「策略不是过滤器」、`paths` 护栏与上面这条边界断言仍然有效。

## 二十四、全量代码评测与修复（2026-11-11）

### 24.1 怎么做的

先评测、后修复，全程 git 分批提交（`3ee7205` 基线 → `0df44ff` 面板 → `8088161` 存储/AGENTS.md → `6104a1e` 宿主路由/检索/工具）。
评测按「存储 + AGENTS.md / 检索 + 路由 + 工具 / 面板」三块并行审查，每条发现都在临时目录里复现或回到源码核实过；
修复由三块各自的审查者完成，逐批 diff 审过再提交。全程没有读写真实 `~/.dsh`（AGENTS.md 修改时间前后核对未变）。

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 测试 | 19 个文件 | 26 个文件（`npm test`），新增 routes / storage-hardening / agents-format / retrieval-hardening / remember-hardening / client-logic |
| `index.js` 覆盖率（行 / 分支 / 函数） | 77% / 76% / 81% | 92% / 84% / 93% |
| 召回金标集 | R@1 70% · R@3 90% · MRR 0.80 · 负样本误召 0% | **完全不变**（逐条结果一致，minScore 扫描曲线一致） |

### 24.2 真实数据里已经发生的问题（最有说服力的证据）

- 主工作区 3 条记忆有 2 条是中文文件名：模型调 `memory_remember` 时漏了 `slug`，走了降级路径 → 加 `needs-slug` 拒写
- 两次 `supersedes` 都生成了 `-2` 副本（同 slug 覆盖会换 id、重置 created/hits）→ 改为原地更新
- 每轮注入的索引里有一行摘要是「规则」：正文首行是 `## 规则` → 摘要派生跳过标题

用户重载插件确认无误后，已按用户要求整理（见 24.7）。

### 24.3 修了什么（按危害）

1. **路径穿越**：id 未校验直接拼路径，`memory_forget {id:"../../../AGENTS"}` 会删掉 `~/.dsh/AGENTS.md`，`/save` 能覆盖库外任意 `.md`。→ `isSafeId` + 包含性检查
2. **frontmatter 换行注入**：`description: x⏎confidence: 0.1` 能改「只读」字段。→ 序列化器对歧义值 JSON 加引号，单行字段折行，校验拒换行
3. **静默丢信息**：BOM 文件 frontmatter 全丢；草稿 id 同毫秒互相覆盖；正文带代码围栏的抽取候选整批丢弃；`Docs` 覆盖 `docs.md`；每次召回整份重写文件（丢 YAML 块列表/注释、多空行）；更新时丢 `hits`；索引超限警告被截掉；面板编辑草稿后点收下修改丢失
4. **检索**：手改文件后继续用旧向量；关键词子串匹配（`ci` 命中 "specified"，单词查询无向量证据也能过闸门）；`paths` 子串匹配（`src/` 命中 `mysrc/`）
5. **AGENTS.md**：代码块里的 `#` 被当标题编号；`### 5 Whys` 被重排成 `### 1.1 Whys`；promote 的同名检查永远不匹配、不查预算、不留档；面板按位置写入，外部改过文件后会改到别的章；超限后连删章都被拒
6. **面板**：改 slug 后按标题反查失败会卡死在「保存中」；「保存并继续」回退到保存前内容；AGENTS 页签无未保存守卫；`Ctrl+S` 全局拦截；输入法回车误提交；原始 reason 码直接显示
7. **其它**：Windows `start` 兜底从来没启动过编辑器；spawn 无 error 监听；`reg.exe` 报错漏到宿主 stderr；`c:\` 与 `C:\` 分成两个库；工作区注册表只在 apply 时抓一次；抽取流无超时；非原子写
8. **测试本身**：`agents-sections` 的「写前留档」断言查的是真实历史目录，换台干净机器就会失败（假通过）

### 24.4 行为变化（调用方需要知道的）

- 所有 POST 必须 `Content-Type: application/json`，否则 415；失败统一 `{ ok:false, reason, errors }`，状态码见 `docs/DESIGN.md`「数据通道」
- `/diag` 端点与 `enableDiagEndpoint` 删除（客户端不再上报）
- `memory_remember` 新 reason：`needs-slug`、`supersedes-ambiguous`；同 slug 取代返回 `updated: true`
- 待确认草稿在面板里只读
- 判断宿主请求对象：同工作区的 `dsh-profile-stats` / `dsh-mcp-panel` 都按 `req.headers['content-type']` 读请求头，与本插件新增的 415 闸门用法一致

### 24.5 未验证（必须知道）

**没有在真实 DSH 里重载过插件。** 重载：`plugin_manager set_plugin` 对本插件先 `enabled=false` 再 `true`，`application` 应为 `applied` 且无 diagnostic。然后检查：

1. 面板能列出记忆（若所有 POST 都 415，说明宿主请求对象没有 `headers`——上面的旁证认为不会）
2. 改一条记忆的标题/摘要并保存；改 slug 后面板选中新文件、不卡「保存中」
3. AGENTS.md 页签：改一章保存；在外部编辑器里插一章后回面板保存，应提示「这一章在文件里已经变化」
4. `memory_status` 显示 `hybrid`

面板交互只在 headless 脚手架（合成 fixture）里验证过，同第六节的局限。

### 24.6 刻意没修 / 仍然存在

- `encodeProjectPath` 碰撞（`C:\a\my-app` 与 `C:\a\my\app` 同键）：改编码会让已有库「搬家」，需要迁移方案
- 留档失败后仍会删除（`archiveVersion` 吞掉异常）
- `/memory_list` 「只自动打开一次」的指纹在条数不变时会撞（宿主没提供命令调用 id）
- 长查询稀释关键词分、precision@3 只有 51.7%：金标集只有 18 条、没有长查询样本，调了也是过拟合。**扩充金标集是下一步召回优化的前提**
- 面板里硬编码了 200 / 20000 / 120 / 20 / 40 这几个上限，宿主改配置后两边会不一致
- AGENTS.md 相关路由不要求 session（客户端不带）；宿主的 CORS 策略未核实
- 标签仍禁止逗号与 `]`（新序列化器其实已能无损处理，可以放开）

### 24.7 真实记忆库整理（2026-11-11，用户授权）

用户在 DSH 里重载插件、确认面板与保存正常后，整理了两个真实记忆库。整理前完整备份到
`~/.dsh/.dsh-workspace-memory-history/memory-cleanup-2026-11-11/`（21 个文件，与原目录逐字节一致）。

| 库 | 原 id | 新 id | 另外改了什么 |
|---|---|---|---|
| DSH-Workspace | `Codex-子智能体需替换包内-codex.exe（…）` | `codex-subagent-replace-bundled-codex-exe` | `paths`：包名改目录形式；`cordis.patch.yml` / `config.toml` 收窄为 `profiles/desktop/cordis.patch.yml` / `.codex/config.toml`（原写法会命中工作区里每个插件的 patch 文件） |
| DSH-Workspace | `本地验收-DSH-Web-插件面板：…` | `verify-dsh-web-panel-via-authenticated-url` | — |
| DSH-Workspace | `jsdelivr-cache-must-be-purged-after-replacing-docs-images-2` | `readme-images-change-url-to-bust-camo-cache` | 摘要「规则」→ 真正的结论；旧 slug 的说法与正文结论相反（只 purge 无效）；`paths` 改为整个 `docs/` |
| pmis-agent | `never-commit-agents-md-2` | `never-commit-agents-md` | 删掉指向自己的 `supersedes` |

- 用插件自己的 `writeMemory` 改名：正文、`created`、`hits`、`lastHit`、`confidence`、`tags`、`title` 逐项核对未变
- 各条的历史版本并入新 id 的 `history/` 目录（含被取代的旧版）；删除了 11-03 验证留下的 `history/verify-paths-hint-probe/`
- 核对：两库各问几个问题，均命中新 id，无关提问返回空；`pathMatches` 对上真实路径；核对过程不改任何文件（`recordHits: false` + 前后哈希比对）
- 运行中的插件里向量按旧 id 存着，下一次 `recall` 会按内容哈希对账、自动重嵌

## 二十五、写入准入重设计（2026-11-14）

分十一轮实施，全部在 git 工作区里，**尚未提交**：

| 轮次 | 内容 |
|---|---|
| 第一轮 | 新设计落地：scope × load、全局按需库、按来源分流与证据核对、`pitfall`、过期值提示 |
| 第二轮 | 对齐官方插件开发说明：提示词分层、`dshHome()`、入参自行校验、post-execute 契约、supersedes 跨库等（25.3） |
| 第三轮 | 宿主半收尾：证据核对改以 pre-step 缓存为主、召回带「写于何时」、主目录的符号显示 |
| 第四轮 | 按主路径评测暴露的问题修正：`slug` 必填、索引那一行写记忆本身、证据核对容忍抄写出入、返回文本分清「已生效」和「待确认」 |
| 第五轮 | 第一次独立代码审查（11 项）的修复：常驻一律待确认、证据要与这条记忆相关、跨库只认精确 id、测试隔离等（25.9） |
| 第六轮 | 复审（8 项）的修复：相关性判断放宽并重新定位、`evidenceVerified`、章节草稿按标题定位、索引过期可见等（25.9） |
| 第七、八轮 | 代理模型评测驱动：系统提示段第二、三版、`scope` 必填、`type` 的三个改道取值（调用时必须归类）、更新留在原处（25.5） |
| 第九到十一轮 | 目标模型评测与用户的去处决定驱动：规则以 AGENTS.md 为准、跨项目偏好强制常驻（`resolveLoad`）、常驻草稿取代旧条（25.11） |
| 面板 | 跟上宿主的变化：两个库、换库、来源行、`pitfall`、待确认页的去向、语言 id；审查后补「未核实」、章节去向、移库失败文案（25.9） |

改动规模（第六轮定稿时统计）：相对改动前，33 个已跟踪文件 +4303 / −1091 行，另有 16 个新文件；之后没有重新统计。

设计取舍写在 `docs/DESIGN.md` 的「记忆写到哪」（含「调用时必须归类」）「记忆怎么进库：按来源分流」（含「局限：防线在哪几层」）
「什么值得记：提示词分层」（含「系统提示段的设计」）「写入怎么衡量：主路径评测」（含「离线重放」「代理模型评测」）几节；
这里记起因、对齐情况、评测、审查、行为变化与未验证项。

> 本节 25.2–25.8 写于第四轮之后，第五到第十一轮改掉的地方已就地改正（分流表、证据规则、常驻的写法、`type` 与归宿判断、`scope` 必填、偏好强制常驻）；25.5 的评测记录保留原文；
> 两次审查本身记在 25.9，局限在 25.10，代理模型评测在 25.5，目标模型评测与第九到十一轮在 25.11。

### 25.1 起因：审计

范围：两个工作区里带 `memory_remember` 工具的全部 29 个会话（2026-11-01 至 11-14），310 条用户消息，20 次写入调用，
模型都是 DeepSeek V4.1 Flash。这里只记聚合数字与类别，不记对话原文。

| 看什么 | 结果 |
|---|---|
| 该记的时刻 | 22 个，记下 10、漏掉 12。漏掉的约 9 条是用户对做法或表达方式的纠正；漏记时模型的推理里一次都没考虑过写记忆 |
| 记下的记忆（含历史版本与全局章节） | 24 条：7 条没问题，13 条「规则对，但混了提交哈希、计数、版本号、安装路径」，4 条不该记 |
| 反复改写 | 20 次调用里 14 次集中在 4 个主题上 |
| 模型自行总结（没有用户信号） | 6 条里 4 条后来被替换、推翻或删除 |
| confidence | 19 次里 18 次 ≥ 0.9，与后来是否被推翻无正相关；待确认队列从未被用过 |
| scope | 判错：跨项目规则落进项目库后又在全局重复一份；全局 AGENTS.md 里约 46% 的字节是只在特定场景才用得上的知识 |
| 工具摩擦 | 没有造成记忆丢失 |

根因六条：

1. 写入没有触发点：每轮注入只讲召回，库为空时什么都不注入；
2. 「五条全满足」原是给 AGENTS.md 防膨胀的，被整体搬来管所有写入；
3. 踩坑类内容没有对应类型；
4. 靠模型自评置信度分流；
5. `scope` 一个参数同时决定「适用范围」和「加载方式」；
6. 工具说明与抽取提示词是两套口径。

### 25.2 设计

**三个依次回答的问题。**

1. **归宿**，四选一：skill（可重复的多步流程）、项目的 AGENTS.md（进这个仓库的任何 agent 都要遵守的规则；只对当前用户成立的
   项目规则写同目录的 AGENTS.local.md）、README 或仓库文档（给人看的说明与设计取舍）、记忆。插件只写记忆；前三者由模型用
   文件工具写，先征得用户同意。拿不准就问用户——以前是「拿不准就不记」，而审计的主要问题恰恰是漏记。
   **判断方式（第九轮起的系统提示段）**：流程先按形态归 skill；必须遵守的规则以 AGENTS.md 为准（全员的写项目 AGENTS.md、只对用户本人成立的写
   AGENTS.local.md，决定仓库里会留下什么的约定也算，记忆不存第二份）；跨项目的做事与表达偏好经 `memory_remember` 进全局 AGENTS.md（待确认）；
   项目说明进 README；其余只有助手和这位用户用得上的进记忆。第七、八轮的写法是「先问给谁用」，第九轮按用户的决定改成现在这样（25.11）。
   调用时再用 `type` 表态：选了 `procedure` / `repo-rule` / `docs`，工具不保存、只返回去处
   （`reason: 'belongs-elsewhere'`、`home`）；更新一条确实存在的记忆时例外，按更新处理（`keptAsMemory: true`）。
2. **适用范围** `scope`：`global`（关于用户本人和协作方式）/ `project`（本工作区的决定、期限、资源、坑）。第七、八轮起**必填**（缺失仍取 `project`，不拒写）。
3. **加载方式** `load`：`on-demand`（默认）/ `always`。

| scope | load | 去向 |
|---|---|---|
| project | on-demand | 项目库 `<DSH 主目录>/projects/<key>/memory/` |
| global | on-demand | 全局按需库，默认 `<DSH 主目录>/dsh-workspace-memory/global/memory/`（配置键 `globalMemoryDir`） |
| global | always | `<DSH 主目录>/AGENTS.md` 的一章，一律进待确认，用户收下后才写入 |
| project | always | 不写，返回 `belongs-in-project-agents`，指向 git 根下的 AGENTS.md / AGENTS.local.md |

按需库的索引每轮注入，每条一行 `description`。第五到第八轮的设计倾向是「一条规则只要这一行写的是规则本身就每轮可见，偏好放按需库就够」；
**第九轮按用户的决定推翻了这一条**（25.11）：所有跨项目的做事与表达偏好都进全局 AGENTS.md 常驻；第十轮起 `type` 为 `user` / `feedback`
且 `scope: global` 的一律按常驻处理（`resolveLoad`），显式给了 `on-demand` 被覆盖时返回 `loadForced: true`；
第十一轮起常驻草稿可带要取代的旧条（`supersedes` + `supersedesScope`），收下时先写 AGENTS.md 章节、写成功后再归档删除旧条。
项目里必须遵守的规则以 AGENTS.md 为准，项目记忆库不存规则。

为什么插件不写项目 AGENTS.md：章节写入会统一重排编号，会打乱手工编排的项目 AGENTS.md；那是共享、进版本控制的文件，
改动应当由用户看过。拒写文本里的路径按宿主的项目指令根算（往上最近的 `.git`），不是记忆库用的已注册工作区根。

**类型**：存进文件的记忆是 `user` / `feedback` / `project` / `reference` / `pitfall` 五种（`MEMORY_TYPES`）。`pitfall` 是新增的：
踩到并验证过的坑，须写触发场景与失效条件。门槛按类型分开写（`TYPE_RULES`），取代「五条全满足」。
`memory_remember` 的 `type` 另接受三个不保存、只改道的取值 `procedure` / `repo-rule` / `docs`（`ROUTED_TYPES`，第七、八轮）；
存储、面板、编辑接口、抽取都不认它们。

**分流**（取代置信度，`rememberRoute()`；第五轮改为常驻一律待确认）：

| source | 证据 | load | 结果 |
|---|---|---|---|
| 任意 | — | always | **一律**待确认 `always-needs-user`（`agentWrites: direct` 也不例外）；模型不能直接写全局 AGENTS.md |
| user | 核实 | on-demand | 直写 |
| user | 未核实 | on-demand | 待确认 `evidence-not-found` |
| agent | — | on-demand | `agentWrites: direct` 则直写，否则待确认 `agent-review`（默认） |

> 第四轮时这张表是「user + 核对通过 + 任意 load → 直写」，也就是用户原话核对得上就能直写全局 AGENTS.md。第一次审查指出
> 用户一句很短的回复就能被拿来当证据，第五轮改成上表。

**证据核对**：「核实」要两条都满足。`source: user` 时总会核对一次（常驻写入也做，只用于记录），结果存进 `evidenceVerified`
（草稿与正式记忆都存；面板只有它为 true 时显示「用户原话」，否则显示「未核实」；用户收下草稿不会把它变成 true）。

1. **出处**：证据能在用户消息里核对到。
   - 取数：先用 `agent/pre-step` 时收进进程内缓存的人写消息，没通过再回落到 `session.snapshotEvents()`；
     只认 `source.kind === 'user'` 的消息，**没有 `source` 的消息不再放行**（第五轮）；任意位置的系统提醒块都先剥掉。
     `memory_status` 显示当前 agent 最近一次核对用的是哪一路、结果如何（第五轮起按 agent 分开记）。
   - 比对：归一化（NFKC、小写、去空白、去标点与符号）后精确匹配；长度 10–500 的段允许编辑距离 ≤ 长度的一成（近似子串匹配，
     只看最近 50 条用户消息）；超过 500 字的段只做精确匹配。所有段须按顺序落在同一条用户消息里。
2. **相关**：`evidenceRelates(evidence, [标题, 摘要, 正文])`——共有 ≥ 2 个不同的中日韩二元组，或 ≥ 1 个长度 ≥ 3 的 ASCII 词；
   证据归一化后不足 6 字时门槛降为 1 个。它只拦「拿一句无关的回复当证据」，不证明证据陈述了这条规则（25.10）。

自动抽取用同一套核对；核对不过的候选**不丢弃**，以未核实身份进待确认（第六轮；第四轮时是丢弃）。

**提示词分层**（官方 tool-design.md / practices.md）：

| 层 | 放什么 |
|---|---|
| 系统提示段 `ctx.systemPrompt.section`（name `workspace-memory`，order 3200，静态；常量 `MEMORY_SECTION`） | 四个归宿、何时处理、何时问用户、记忆写的是当时的情况 |
| 动态 `ctx.systemPrompt.context` | 只放两个库的索引和预取结果；都为空时返回空串 |
| `memory_remember` 的 description | 只写做什么、何时用、返回什么 |
| 各参数的说明 | 各条规则（`TYPE_RULES`、`BODY_RULE`、`SOURCE_RULE`、`EVIDENCE_RULE`、`SCOPE_RULE`、`LOAD_RULE`、`DESCRIPTION_RULE`、`SLUG_RULE`）；抽取提示词复用同一批常量 |

测试守的是这个结构，不是具体措辞。

**根因与改动的对应**：

| 根因 | 改动 |
|---|---|
| 1 写入没有触发点 | 系统提示段：用户纠正做法或表达方式（哪怕只说一次）、说了「记住 / 以后 / 每次 / 默认」都要处理 |
| 2 五条全满足 | 按类型分门槛；常驻与否由 `load` 单独决定 |
| 3 没有踩坑类型 | `pitfall` |
| 4 置信度分流 | 按来源分流 + 代码核对用户原话 |
| 5 scope 一身二职 | scope × load，新增全局按需库 |
| 6 两套口径 | 工具参数说明与抽取提示词由同一批常量拼成 |

另外两条针对审计数据：正文里像提交哈希、版本号的值在返回里点名提示（13 条「规则对但混了过期值」）；同 slug 且意图相同的待确认草稿
互相覆盖、查重在分流之前（14 次在 4 个主题上反复改写）。「意图相同」是第五、六轮补的，见 25.9。

### 25.3 与官方插件开发说明的对齐

官方文档在 DSH 安装包的 `resources/app.asar` 里：`@deepseek-ai/dsh-agent-preset/skills/dsh-doc/` 与 `@deepseek-ai/dsh/docs/`。
本轮依据的条文：practices.md、tool-design.md、user-actions.md、verification.md、subsystems/system-prompt.md、tools.md、session.md、core.md，
以及 dsh-home-paths、dsh-agent-instructions、dsh-skill-filesystem、dsh-client-locale 各包的 README。当时的 DSH 版本是 0.2.2-rc.3。

| 做了什么 | 依据 |
|---|---|
| 行为指引走 `ctx.systemPrompt.section`，context 只放运行时事实 | practices.md「Add prompt text with ctx.systemPrompt.section()」；system-prompt.md |
| 参数规则写在参数上、每件事只说一次；各工具说明只写行为与返回 | tool-design.md「Put parameter rules on the parameter」「Say each fact once」「Describe behavior, not implementation」 |
| 主目录统一经 `dshHome()` 解析，支持 `DSH_HOME`；文字里用 `~/.dsh` 或 `$DSH_HOME` | dsh-home-paths README |
| `memory_remember` 在 `execute` 里自行校验入参，非法值返回 `invalid-argument` | tools.md：直接注册的 raw JSON-Schema 工具自己校验输入 |
| `output.schema` 如实声明返回字段 | tools.md 的 schema 子集 |
| `tools/post-execute` 监听器始终经过 `next()`，只替换 content，不带 value | tools.md「tools/post-execute」、practices.md「Stability」 |
| 收下 / 丢弃草稿只留给用户，没有让 agent 自己收下草稿的工具 | user-actions.md |
| supersedes 跨库与面板换库共用 `moveMemory` | user-actions.md：同一操作两种调用方，共用一个实现 |
| 用户原话只认 `source.kind === 'user'`；证据核对以 pre-step 缓存为主 | session.md、core.md（pre-step 的 payload 带 messages） |
| `belongs-in-project-agents` 指向往上最近的 `.git` 目录下的 AGENTS.md，并提到 AGENTS.local.md | dsh-agent-instructions README |
| 回合收尾的抽取接上回合的取消信号 | core.md（turn-stopping 的 payload 带 signal） |
| 界面语言注册 id 从 `zh-CN` 改为 `zh` | dsh-client-locale README |
| 面板只做 JS 语法与逻辑测试，视觉验证留给真实 DSH | verification.md |

**用官方校验器源码做的离线核对。** 宿主注册工具时会用自己的校验器检查 `output.schema`，执行后再按它校验返回值——返回值不合法时整次调用被判失败，
而写入已经发生，模型重试就会重复写入。这两点原本只能在真实宿主里确认。安装包里带着这个校验器的源码与编译产物，于是在仓库之外一次性运行了它
（官方源码没有进仓库；它依赖的另外两个官方包没有随安装包解出，用的是按官方注释写的替身，边角行为可能与真实实现不同）：

- 读宿主注册与执行的源码确认：注册时只校验 `output.schema`，**不校验 `parameters`**；执行时入参不按 `parameters` 校验（所以枚举与必填必须在 `execute` 里自己查）；
  返回值依次经过「是否无损 JSON → 按 `output.schema` 校验 → 渲染」。
- 四个工具的 `output.schema` 与 `parameters` 全部通过官方的 schema 断言，源码版与编译版结果一致。
- 105 个分支的真实返回值（`memory_remember` 71、`memory_recall` 16、`memory_forget` 9、`memory_status` 9）逐个过官方的返回值校验：104 个直接通过，
  1 个被拒——记忆文件里的 `hits` 被手改成 `-0` 时，库满返回的候选清单带着它，官方校验器不接受 `-0`。已修（`finiteNumber` 把 `-0` 归一成 `0`），
  并在仓库里补了不依赖官方源码的回归测试；仓库自带的检查器原先会放过 `-0`，一并改成与宿主同口径。
- 没覆盖的分支：经工具触发的 `target-exists`、规划章节时的 `empty-title`（都被前面的检查先拦下，走不到）、兜底的 `write-failed`（本机构造不出）、纯关键词召回模式（字段形状与混合模式相同）。

**它说明不了的**：注册流程里 schema 之外的环节——同层工具重名、命令 / 系统提示段 / 路由 / 事件名各自的校验、与其它插件监听器的串联、
模型服务商对 `parameters` 的接受程度——仍然只能在真实 DSH 里确认（25.7）。

### 25.4 已知未对齐

都是离线无法验证、需要真实宿主的项；改错了可能让插件在真实 DSH 里无法激活，所以本轮没动，只记下来。

| # | 未对齐 | 为什么没做 |
|---|---|---|
| 1 | 没有 `export const Config`（官方要求 Schemastery schema，配置错误在加载时失败） | link 安装下解析不到宿主包。官方说可在 `peerDependencies` 与 `devDependencies` 同时声明后由宿主提供，未验证 |
| 2 | `webServer` / `llm` 没有声明为可选依赖（官方：optional services 放进 `inject`） | 可选注入在宿主里怎么解析，离线无法验证 |
| 3 | `session.snapshotEvents()` 已被官方标为弃用（「new calls are prohibited」） | 证据核对已改为以 pre-step 缓存为主，它只作回落（DSH 重启后恢复的会话）；自动抽取的 `recentTranscript` 仍在用，属于既有逻辑。官方替代 `ctx.sessionProjections` 的 `stateSchema` 需要 Zod，link 安装下拿不到 |
| 4 | 面板走自建 HTTP 路由，而不是官方建议的 Client 可调用的 Host 入口；面板的编辑、提升到 AGENTS.md、章节增删没有一一对应的工具（官方：同一操作两种调用方） | 换通道要在真实宿主里验证；本轮只把「换库」做成了两边共用 |
| 5 | 系统提示段是静态的，对没有记忆工具的 agent（如子 agent）也会出现 | 组装时拿到的上下文只有 scope / signal（dsh-agent 另加 agent / modelSelection），没有工具集信息，无法按「有没有 memory_remember」给不同文本；不为此引入猜测性的判断 |
| 6 | 预取结果拼在 context 里，每次变化会让宿主重发包含全部 context 的快照 | 换注入位置（例如 additionalContexts）要声明消息的 `source.kind`，离线无法验证 |
| 7 | 「本轮已提示过」的 paths 提示状态靠监听 `agent/status` 清理，官方建议等 `turn/end` 这类持久事件 | 事件时序离线无法验证 |
| 8 | `dsh.compatibility.dshReleases` 不是官方字段，宿主不读它；真正的兼容闸门是 `engines.dsh` | 本轮没有改 `package.json`。它留着不影响加载，但不要把它当成兼容声明 |

### 25.5 评测

**脚本**：`eval/remember.mjs`（主路径评测）。模拟一次对话，模型真实调用插件的 `memory_remember`，证据核对、分流、查重都走真代码，
全部写入临时目录。环境是一个内存里的虚拟项目，读写文件与常见命令有一致的输出。用法与参数见 `docs/DESIGN.md`「写入怎么衡量：主路径评测」。

**场景**：`eval/remember-cases.json`，52 个合成场景，dev 31 / test 21。类别：用户纠正做法或表达、项目决定与期限、仓库外资源、
用户是谁、负样本、模型自己踩的坑、归宿是 skill / AGENTS.md / README、有长期信号但去向不明、更新已有记忆。

**指标**：处理率、漏记数、误记数、归宿正确率、字段正确率、证据核对通过率、写入分布、红线命中、截断数、首轮 prompt token。

**评测环境返工过三次**，教训：

1. 固定回复的假工具会让模型反复试探环境，测到的是模型怎么对付假环境——换成了状态一致的虚拟项目；
2. 步数太少会在任务收尾前截断，而「记不记」恰恰发生在收尾——默认步数改为 16，截断的运行单独计数、不进分母；
3. 不要用「最后一步只开放记忆工具」来强制收尾：那会暗示模型去记。

另一条运维教训：两份评测并行跑时共用同一份额度，中途评测所用模型账户的额度用尽，两份都没跑完。
**同一时间只跑一个评测进程，并设 `--max-requests`**；缺的场景用 `--resume` 补。

**结果（不完整）**：

| 版本 | 完成的场景 |
|---|---|
| 改动前的插件 | dev 10 个、test 9 个 |
| 改动后（第二轮快照） | dev 9 个 |

两版都完成的 9 个 dev 场景：改动后 9/9 落在可接受范围，改动前 6/9。**样本太小，只说明方向，不能当结论。**

首轮提示词：

| | system prompt | `memory_remember` 定义 | 首轮 prompt token 均值 |
|---|---|---|---|
| 改动前 | 117 字符 | 4574 字符 | 1980 |
| 第二轮快照 | 610 字符 | 4753 字符 | 2327（约多 350 token） |

那 9 个场景暴露、并已在第四轮修掉的问题：6 次写入第一次没给 slug（被拒后重试）；1 次模型抄原话漏了一个字，核对没通过；
1 次直写成功后模型却对用户说「等你确认」。

每轮固定进上下文的字符数，按代码直接量（系统提示段 + 四个记忆工具的定义），不是评测数据：

| | 合计 | 系统提示段 | `memory_remember` 的 description | `memory_remember` 各参数说明合计 |
|---|---|---|---|---|
| 改动前 | 5722 | — | 1517 | 2150 |
| 第六轮 | 6681（多 959，约 17%） | 491 | 650 | 2961 |
| 定稿（第七、八轮之后） | **7516（多 1794，约 31%）** | 729 | 820 | 3347 |

第六轮到定稿的增量，来自第七、八轮为归宿判断与纠正类场景增加的措辞，以及 `type` 的三个改道取值。

**目标模型上的评测状态在第五到第八轮之后都没有变化**：只有第二轮快照的 9 个 dev 场景在目标模型上真跑过。

> 2026-11-15 注：本节以下写于目标模型评测之前，「目标模型上只跑过 9 个场景」「提示词只在代理模型上测过」等说法已过时；
> 目标模型上的完整评测、用户的去处决定与第九到十一轮的改动见 25.11。下面保留原文作为过程记录。

**离线重放（第六轮之后、第七、八轮之前）。** 为什么做：额度用尽后，第三到第六轮的改动没法在模型上验证，但已保存的运行里存着模型给出的每一次工具调用。
`node eval/remember.mjs --replay=<结果 JSON> --index=<要测的 index.js>` 把这些真实模型输出原样重放到指定版本上（完全离线，不发请求、
不读凭据；实现在 `eval/lib/remember-replay.mjs`，做法见 `docs/DESIGN.md`「离线重放」），检验新版本的**代码路径**：证据核对、相关性判断、分流、查重、返回文案。
它不重新采样模型，所以检验不了新提示词是否改变模型的行为。

- **自检**：把记录重放到它原本对应的那个版本上，结果必须逐次一致，否则说明重放本身有偏差。实际：14 次写入、4 次召回、9 个场景的主结果全部一致；
  另一份 3 个场景的记录同样全部一致。
- **对第六轮定稿版本的重放**（两份记录合计 12 个场景里的 17 次真实模型写入、5 次召回）：
  - 16 次声称来自用户的写入，证据全部在用户消息里核对到：15 次精确匹配，1 次近似匹配（模型抄原话时漏了一个字的那次）；
  - 相关性判断 16 次全部通过，只比标题和摘要就够，没有一次需要靠正文；
  - 3 次调用的结果变了，都是设计意图：漏抄一个字的那次由待确认变为直写；两次把语言偏好设为常驻的写入由直写变为待确认（常驻一律待确认）。
    其余结果不变；
  - 模型自己总结的踩坑仍进待确认；
  - 没有任何一次返回过期值提示。
- **重放另外带出两处返回文案的小问题，已修**：AGENTS.md 的显示路径忽略了自定义的 `agentsFile` 配置（现在配置在主目录下的显示为主目录符号加相对路径，
  在主目录外的原样显示）；要求确认章节时列出的清单编号重复（改动前就有；现在先去掉章标题里自带的编号再编号）。
- **没有被这次重放覆盖的**：样本只有 12 个场景，证据几乎都是原样抄写，「差一点」和「不相关」的证据没有真实样例。
  重放早于第七、八轮，第七、八轮的改道与「更新留在原处」不在重放过的代码里。

**代理模型评测（第七、八轮）。**

- **为什么做**：目标模型的额度用尽后，提示词改动没法在目标模型上重新采样，离线重放只能检验代码路径。为了让新提示词至少被某个模型重新采样，
  新增两个完全离线的模式：`--export-prompts=<目录>` 把每个场景第一步会看到的全部信息（系统提示、工具定义的 JSON Schema、对话）导出成自包含的文件，
  文件里没有标准答案；`--import-decisions=<目录>` 读回每个场景的一份答案（`{"tool_calls":[…],"final_reply":"…"}`），记忆工具调用放进插件真实执行，
  其余工具走虚拟项目，按同一套规则计分。用法见 `docs/DESIGN.md`「代理模型评测」。
- **怎么做**：每个场景交给一个**全新的、只见过这一个文件的小模型**独立作答（不是目标模型）。改动前与改动后的提示各导出一遍，
  得到同一个代理模型下的成对比较。提示词的迭代只看 dev 组，test 组留作检验。
- **局限**（必须知道）：
  1. 代理模型不是目标模型，绝对数字不能套用到目标模型上，只适合比较「同一个模型拿到新旧两套提示」；
  2. 单步作答：模型一次给出整轮的工具调用和最后一句话，看不到任何工具返回。被拒后重试、被改道后是否真的向用户提议，都测不到；
  3. 模型看不到仓库内容：`edit_file` 对不上原文而失败、或先 `read_file` 再说「读完后修改」，都被记成「什么都没做」，
     归宿类场景（要改 AGENTS.md / README 的）的自动分数因此**偏低**，需要人工读答案；
  4. 每个场景只采样一次，同一场景在两次采样之间会翻转，只有「同一类场景整体翻转」才算信号；
  5. 归类靠关键词启发式，会漏判（例如「放在项目文档里」没被认作提议）；
  6. test 组一共跑了两次（第三版一次、最终版一次）。第一次的结果被看过；没有针对 test 组的判错改任何东西，但第二次已不算严格的留出集。
- **结果**（代理模型，自动计分）：

  | | 改动前 | 第一版提示词 | 第二版 | 第三版 | 最终版（第三版提示词 + 调用时归类） |
  |---|---|---|---|---|---|
  | dev（31）落在可接受范围 | 22/31 | 24/30 | 28/31 | 只跑了 15 个的子集 | 25/31 |
  | dev 归宿场景被错存进记忆 | 4 | 3 | 2 | 3 | **0** |
  | dev 误记（负样本被记） | 1 | 0 | 0 | 0 | 0 |
  | test（21）落在可接受范围 | 14/21 | 未跑 | 未跑 | 18/21 | 19/21（修掉「改道使旧记忆过期」后，同一批答案是 20/21） |
  | test 归宿场景被错存进记忆 | 2 | 未跑 | 未跑 | 0 | 0 |
  | test 误记 | 2 | 未跑 | 未跑 | 2（都进了待确认，没进正式库） | 0 |

  **这是代理模型上的结果，不代表目标模型的表现。**
- **人工读答案**：最终版 dev 组的 6 个归宿场景，没有一个进记忆；5 个去了正确的共享归宿（其中 3 个被自动打分记成「什么都没做」，是局限 3 造成的假象）；
  1 个提议写进项目文档而不是 skill。
- **带出的三处改动**：
  1. **系统提示段第二、三版**：流程先按形态判断归 skill，其余先问「给谁用」；纠正要当场改正并记进记忆，「只答应以后注意没有用」；
     等用户答复期间不要先存一份；`scope` 进 `required` 并说清两边各放什么；工具说明补回「改已有记忆用 supersedes」；
     提示词里的流程例子换成与评测场景无关的（原来的例子正好是评测场景，等于把考题写进提示词）。最终文本以 `MEMORY_SECTION` 为准。
  2. **调用时必须归类**：三版提示词下，用户没明说去处的归宿场景始终不稳，而模型判错时自己在正文里写着「所有 agent 都必须遵守」——
     它知道答案，只是调用时没被要求表态。于是 `type` 增加 `procedure` / `repo-rule` / `docs`：工具不保存，返回 `belongs-elsewhere`、`home`
     与去处说明（skill 的目录与 frontmatter 格式、git 根下的 AGENTS.md 与 AGENTS.local.md、README 的位置），要求先向用户提议、不要再存一份。
     skill 格式这类细节只在用到时由工具给出，不必常驻提示词（官方 tool-design.md：先给最少的上下文，详细说明按需加载）。
  3. **更新留在原处**：改道引入过一个缺陷——用户更新一条已有记忆，模型带了 `supersedes` 却选了 `repo-rule`，改道后什么都没存，旧记忆成了过期的错误记忆。
     现在 `type` 是改道取值、同时 `supersedes` 能解析到确实存在的记忆时，不改道，按被取代那条的类型更新（加载方式固定为按需），返回 `keptAsMemory: true`；
     解析不到时照旧改道。上表 test 组的 19/21 → 20/21 就是这处修复，答案没有重新采样。
- **仍然存在的不足**：dev 组有两个纠正类场景这次没记（前几版记了），无法区分是随机波动还是退步；模型对自己踩的坑问了一句「要不要记」
  而没有直接存——已在系统提示段里补了一句，**补完之后没有再测**。

**验证状态的三个层次**（写于目标模型评测之前，已过时，现状见 25.11）：

| 层次 | 验证了什么 | 没验证什么 |
|---|---|---|
| 目标模型上真跑 | 第二轮快照的 9 个 dev 场景 | 第三到第八轮的一切 |
| 离线重放 | 第三到第六轮的**代码路径**（证据核对、相关性、分流、查重、返回文案），17 次真实模型写入 | 提示词对模型行为的影响；第七、八轮的改道与「更新留在原处」 |
| 代理模型 | 系统提示段第二、三版与「调用时归类」，在一个小模型上单步作答、每场景采样一次 | 目标模型的表现；多步行为（重试、被改道后是否提议） |

**还没有在目标模型上验证过的**（写于目标模型评测之前；其中大部分已在 25.11 里验证，仍未覆盖的见 25.11 末尾）：

- **新提示词与新 schema 对目标模型行为的影响**：第三到第八轮改了 `slug` 必填、`scope` 必填、`type` 的三个改道取值、多条参数说明
  （如 `TYPE_RULES`、`SCOPE_RULE`、`DESCRIPTION_RULE`、`EVIDENCE_RULE`、`LOAD_RULE`）、系统提示段（第七、八轮的第二、三版）、工具说明与多处返回文本。
  代理模型上的方向不能直接套用；第四轮针对评测里三个问题的修正修得对不对（例如模型是否就此每次都给 slug），同样没有目标模型数据；
- 模型是否会如实告诉用户「已生效」还是「等你确认」；
- 被改道之后，模型是否真的向用户提议写进 skill / AGENTS.md / README（任何评测都没有覆盖）；
- 负样本、归宿类、有长期信号但去向不明、更新已有记忆这几类场景在目标模型上的表现；
- 留出的 test 组在目标模型上（改动后的版本没有完成任何 test 场景）。

### 25.6 行为变化（调用方 / 用户需要知道的）

- `memory_remember` 参数：新增 `source`、`evidence`、`load`；删除 `confidence`；`required` 为 slug / title / body / type / source / scope
  （`scope` 第七、八轮进 `required`，缺失仍取 `project`、不拒写）。工具内部自行校验枚举值（宿主不校验直接注册的 schema），非法值返回 `invalid-argument`。
- **`type` 的三个改道取值**（第七、八轮）：`procedure` / `repo-rule` / `docs`。选了它们工具什么都不保存，返回 `written: false`、
  `reason: 'belongs-elsewhere'`、`home`（`skill` / `agents` / `readme`）与去处说明，要求先向用户提议、不要再往记忆里存一份。
  例外：同时带 `supersedes` 且能解析到一条确实存在的记忆时，按被取代那条的类型更新（按需），返回值带 `keptAsMemory: true`。
  自动抽取跳过这三类并计数。
- 新的拒写 / 待确认原因：`invalid-argument`、`belongs-in-project-agents`、`evidence-not-found`、`always-needs-user`、`agent-review`、
  `chapter-not-found`（常驻草稿指定的章不存在）；跨库 `supersedes` 只按前缀命中时也返回 `supersedes-ambiguous`。
  直写成功的返回文本末尾是「It is active now; no review is needed.」，进待确认的是「Tell the user it is waiting in the memory panel.」。
- **常驻写入一律进待确认**（第五轮），不论来源与证据；`memory_remember` 不再直写全局 AGENTS.md。章节协议在入队前校验，
  草稿存下章号与章标题，收下时按章标题定位。
- **跨项目偏好强制常驻**（第十轮）：`type` 为 `user` / `feedback` 且 `scope: global` 的，不论 `load` 给了什么都按常驻处理，进待确认；
  显式给了 `on-demand` 被覆盖时返回 `loadForced: true` 并在文本里说明。自动抽取用同一条规则。`scope: project` 的不受影响。
- **常驻草稿取代旧条**（第十一轮）：常驻写入带 `supersedes` 时照常解析（规则同按需写入，解析不到照样拒写），把旧条的 id 与所在库
  （`supersedesScope`）记进草稿；用户收下时先写 AGENTS.md 章节，写成功后再归档删除旧条，结果带 `replaced` / `replacedScope`；
  旧条已不存在时只写章节、返回 `replacedMissing`；删除出错不让收下失败、返回 `replaceFailed`。丢弃草稿或章节写入失败时旧条不动。
- 返回值新增 `evidenceVerified`（`source: user` 时）、`clearedDrafts`、`sameSlugDrafts`、`indexStale`；
  正式记忆与草稿的 frontmatter 多了 `evidenceVerified`，章节草稿多了 `chapter` / `chapterTitle` / `newChapter`。
- 配置：新增 `agentWrites`（`review` 默认 / `direct`）、`globalMemoryDir`、`globalIndexMaxLines`（默认 60）；
  `directWriteConfidence`、`minExtractConfidence` 已废弃（写了会得到一条废弃提示）。`memoryDir` / `globalMemoryDir` 不能是主目录、
  共享 agents 根（`$DSH_AGENTS_HOME` 或 `~/.agents`）或它们的上级，也不能是 AGENTS.md 所在目录，违反时记 issue 并回落默认。
- 主目录统一经 `dshHome()` 解析，支持 `DSH_HOME`；面向用户或模型的文本里用符号形式（`~/.dsh` 或 `$DSH_HOME`）。
- 查重与条数上限在分流之前；查重同时比对另一个库；两个按需库之间 id 不重复；同 slug **且意图相同**的待确认草稿互相覆盖，
  直写成功后清掉同 slug 且意图相同的旧草稿；`supersedes` 可跨库取代，但跨库只认精确 id。
- 正文里像提交哈希、版本号的值会在返回里提示（不拦截；`pitfall` 的版本号豁免）。
- `memory_recall` 跨两个库检索，结果带 `scope`、`updated`、`ageDays`；超过 30 天提示先核实。
- `memory_forget` 支持 `scope`，同 id 两处都有时拒绝并列出；`/memory forget <id> [project|global]` 同理。
- `memory_status` 报告两个库、`agentWrites` 和当前 agent 的 `last evidence check`；索引列出的条目数与记忆文件数对不上时明说，并给出 `/memory reindex`。
- 每轮注入：新增静态的系统提示段；动态 context 分「本工作区」「所有项目（按需）」两节，两个库都空且没有预取时为空串。
- `tools/post-execute` 监听器按官方契约重写：始终经过 `next()`，只替换 content，不带 value。
- 回合收尾的抽取接上了回合的取消信号；抽取不再按置信度丢弃，证据核对不过的候选以未核实身份入队
  （`/memory extract` 报告「其中 N 条以未核实身份入队」）；去重同时比对全局按需库。
- HTTP：`save` / `forget` / `promote` 的请求可带 `scope`；`patch.scope` 与所在库不同时 `save` 会换库；
  新原因码 `invalid-scope`、`belongs-in-project-agents`、`same-library`（400）与 `scope-ambiguous`、`target-exists`、
  `move-failed`、`move-partial`、`partially-saved`（409）；收下章节草稿找不到唯一同名章时返回 `section-moved`（409）。
- 面板：两个库的条目都显示；范围下拉保存后会移库；显示来源与证据原话，`source: user` 只有核实过才标「用户原话」、否则标「未核实」；
  不再显示置信度（旧记忆保留）；类型加「踩坑经验」；待确认页显示去向，常驻草稿显示「替换第 N 章」或「新章」；
  新增 `partially-saved`、`move-failed`、`move-partial` 与草稿场景下 `section-moved` 的文案；失败响应带 `moved: true` 时也刷新列表；
  界面语言注册 id 从 `zh-CN` 改为官方的 `zh`。
- `/memory pending` 的文字列表与面板同一套来源标签：`source: user` 核实过才标「用户原话」，否则标「未核实」。
- `eval/run.mjs` 的闸门由 `--min-conf` 换成证据核对，口径已跟上插件：候选全部入队，按「出处 + 相关」分成已核实 / 未核实，
  precision / recall 分「全部入队」与「已核实」两组报。它没有模拟抽取对三个改道取值的跳过。
- `eval/remember.mjs` 新增 `--replay`、`--export-prompts`、`--import-decisions` 三个离线模式（25.5）。
- 评测计分（25.11）：新增标准答案取值 `remember:always`（必须进全局 AGENTS.md 常驻）与错误细分「去处错（应常驻）」；`AGENTS.local.md` 计入 AGENTS 归宿；
  「提议写某处」必须是写入动作作用于该处（只提到 AGENTS.md 不算）；重算一律以当前题目文件的答案为准；虚拟仓库补齐了多个场景的前情。
- 系统提示段（第九、十轮）：规则以 AGENTS.md 为准、项目记忆库不存规则；跨项目偏好用 `scope: global` + `load: always`；
  「这次」的不记；只纠正结果时不归纳做法；没有具体要记的东西时不泛泛地问；决定仓库里会留下什么的约定也算仓库规则。`LOAD_RULE` 改为偏好用 always。
  之后又补了「没调用 `memory_remember` 并拿到返回前不要说记下了」，并把「用户是谁」挪到全局 AGENTS.md 那一行（25.11 第 8 点）。
- 面板：带 `supersedes` 的草稿显示「替换记忆 {id}」；收下后旧记忆没能删除时底部提示「已收下，但旧记忆 {id} 未能删除」。

### 25.7 未验证（必须知道）

**这批改动没有在真实 DSH 里装过。** 正在运行的 DSH 通过 link 加载的是另一份目录，这个工作区的改动还没进去过；
面板的视觉也没有人看过（只做了 `node --check` 与逻辑测试）。

重载插件后（对插件行 disable → enable）逐条检查：

1. 插件 `application` 状态为 `applied`、无 diagnostic。
2. 系统提示里出现「记忆与知识沉淀」那一段；宿主接受 order 3200。
3. 说一句只在本项目成立的纠正（或一个进行中的决定），模型调用 `memory_remember`（source user，`scope: project`，按需），直接写入；
   `memory_status` 显示 `last evidence check: prestep-cache (verified)`。
4. 让模型自己总结一条踩坑，它进入待确认；面板的待确认页能看到去向和来源。
5. 重启 DSH 后在旧会话里写入，`memory_status` 显示 `snapshot-fallback`。
6. 面板：全局条目有「跨项目」标签；范围下拉保存后移库；来源行与长原话的折行；旧记忆的置信度行照旧；窄屏不溢出；深浅色主题；中文界面全中文。
7. 读写带 `paths` 的文件时，工具结果末尾仍有记忆提示，且其它插件的后置监听器照常工作。
8. 斜杠命令展开的文字、子 agent 的创建提示，是否会被当成用户原话（来源标记可能与手敲消息相同，离线无法确认）。
9. 设置 `DSH_HOME` 后路径与显示是否正确（如果用到）。
10. 让模型拿一句与内容无关的回复当证据写一条记忆：草稿在面板上显示「未核实」，而不是「用户原话」。
11. 让模型写一条常驻规则（`scope: global` + `load: always`），即使给了核对得上的用户原话，也**一律进待确认**，全局 AGENTS.md 在收下前不变。
12. 让模型更新 AGENTS.md 已有的某一章，进待确认后，在 AGENTS 页签里删掉它**前面**的任意一章，再收下草稿：应当仍然更新到那一章，
    待确认页显示的是「替换第 N 章」。
13. 让 `MEMORY.md` 重建失败（例如在一个测试用的库里把它临时换成同名目录，测完恢复），之后写入一条：返回里带 `indexStale`，
    `memory_status` 明说索引过期并给出 `/memory reindex`。
14. 让模型把一个多步流程、一条全员都要遵守的仓库规则、一段项目说明交给记忆工具（模型选了 `procedure` / `repo-rule` / `docs`）：
    工具不保存，返回去处；模型随后应当**向用户提议**写进 skill / 项目 AGENTS.md / README，而不是自己又存一份记忆，也不是什么都不说。
    这一步评测都没有单独检查：代理模型评测是单步作答，看不到工具返回；目标模型评测的计分把「工具改道到正确归宿」本身就算判对，
    不看之后有没有提议。
15. 更新一条已有记忆（例如某条分支规则变了），即使模型把它归类成全员规则（`repo-rule`）并带着 `supersedes`：应当更新旧记忆
    （返回 `keptAsMemory: true`），而不是改道后留下那条过期的旧记忆。
16. 用户只说一次、不带「以后」的纠正：模型当场改正，并把这条做法写下来（系统提示段的「两件事」）；对自己验证过的坑直接存而不是先问；
    话里带「这次」的、只纠正这次结果的，不记。
17. **偏好写入进待确认、收下后进全局 AGENTS.md**：说一句在所有项目都成立的做事或表达要求，模型应调用 `memory_remember`（`type: feedback`
    或 `user`、`scope: global`），即使它给了 `load: on-demand` 也应进待确认（返回 `loadForced: true`）；在面板收下后，全局 AGENTS.md 多出那一章。
18. **收下取代旧偏好的草稿后，旧条应消失**：全局按需库里先放一条旧偏好，让模型更新它（带 `supersedes`）；收下草稿后 AGENTS.md 有新章，
    旧条从按需库里消失（历史里有留档）；丢弃草稿时旧条原样保留。
19. **模型不能在没调用工具时说「记下来了」**：目标模型评测里出现过（A4），用户会以为记了。系统提示段已补一句并在模拟对话里复测通过（25.11 第 8 点），
    真实使用中仍要留意回复里的这类说法有没有对应的工具调用。
20. **面板标出会被取代的旧记忆**：带 `supersedes` 的草稿在卡片和详情里显示「替换记忆 {id}」（旧记忆在另一个库时补上所在库）；
    收下后若旧记忆没能删除，底部提示「已收下，但旧记忆 {id} 未能删除」——这条提示和其它提示一样约 2 秒后消失，看是否来得及看到。

另外：目标模型评测见 25.11（评测是在模拟的对话里做的）；已知局限见 25.10。

### 25.8 现有真实数据的迁移建议（**未执行**）

新设计下，现有真实数据有几处放错了地方。以下只是建议，**都没有执行**，需要用户逐条确认后再动（动之前照 24.7 的做法先完整备份）：

1. 全局 AGENTS.md 里只适用于 DSH 插件开发的几章（pnpm 删 link、bundle 热更、npm 发布节奏）→ 移回该工作区的项目库，类型 `pitfall` 或 `feedback`。
2. 工具偏好类章节（浏览器自动化用哪个工具）→ 规则一句留在常驻区，安装路径与版本号移到按需库。
3. 项目库里跨项目成立的踩坑 → 移到全局按需库，类型改 `pitfall`，补失效条件。
4. 审计里漏掉的 12 条用户纠正 → 可作为草稿补进待确认，由用户收下。
5. 旧记忆正文里的提交哈希、计数、版本号、备份路径 → 逐条清掉。

### 25.9 两次独立代码审查（第五、六轮）

四轮实施与文档更新之后，请一位**没看过设计过程**的审查者对整份差异做了两次只读审查，每个发现都带复现脚本。

| | 结论 | 发现 | 修复 |
|---|---|---|---|
| 第一次审查 | 「不能装进真实 DSH」 | 11 项 | 第五轮 |
| 复审 | 「可以试用」 | 8 项 | 第六轮 |

两次审查时 `npm test` 都是全绿——下面这些全是测试没覆盖到的。

**第一次审查（11 项）与修复：**

| 问题 | 后果 | 修法 |
|---|---|---|
| 跨库 `supersedes` 支持唯一前缀匹配 | 往项目库写入时，可把全局库里不相关的记忆搬走删掉 | 另一个库只认精确 id；前缀命中返回 `supersedes-ambiguous` 并列出候选 |
| 待确认的「更新第 N 章」草稿丢了章号 | 收下后 AGENTS.md 出现原章与合并版两份 | 草稿存 `chapter` / `chapterTitle` / `newChapter` |
| 证据核对只证明「这几个字出自用户」，与内容无关 | 用户回一句很短的话，模型就能拿它当证据，把任意内容直写进全局 AGENTS.md | 常驻一律待确认；证据还要与这条记忆相关（定稿规则见 25.2） |
| 核对不过进待确认、重试直写成功后旧草稿残留 | 之后收下会出现重复条目 | 直写成功后清掉意图相同的旧草稿 |
| 部分测试没隔离全局库 | 在已启用全局库的机器上跑测试，会读、甚至搬走真实条目 | 新增 `test/isolate-home.mjs`，作为测试文件的第一个 import，把 `DSH_HOME` 指到临时目录；在「模拟的真实主目录」下验证文件一字未变 |
| 库目录可被配置成主目录 | AGENTS.md 被当成记忆，可被删除 | `globalMemoryDir` / `memoryDir` 不能是主目录或其上级、不能是 AGENTS.md 所在目录；违反则记 issue 并回落默认 |
| 移库不是原子操作 | 删源失败时两个库各有一份 | 删源失败回滚目标（`move-failed`）；换库成功而后续补丁失败返回 `partially-saved`，并带条目现在所在的库 |
| 近似匹配同步且无上限 | 极端输入要数秒 | 超过 500 字的证据段只做精确匹配；近似匹配只看最近 50 条用户消息 |
| 同 slug 草稿覆盖不看去向 | 一条草稿被另一条去向不同的整条替换 | 只有意图（slug + 去向 + supersedes + 章号）相同才覆盖，否则都保留 |
| 其它 | 抽取去重不比全局库；核对状态是进程级全局变量；预取查询含注入内容；没有 `source` 的消息被当成用户原话等 | 逐项修正 |

**复审（8 项）与修复：**

| 问题 | 修法 |
|---|---|
| 第五轮新加的「证据须与标题或摘要有字面交集」误判约两成真实纠正，又能被「把用户的话抄进标题」绕过 | 比对范围加上正文、短技术词也算、短纠正降低门槛；重新定位为「只拦无关回复」；返回文本保持中性，不说怎样才算沾边 |
| 没核对过的证据在面板里也显示成「用户原话」 | 草稿与正式记忆都存 `evidenceVerified`；面板只有它为 true 时显示「用户原话」，否则显示「未核实」；用户收下草稿不会把它变成 true |
| 章节草稿按章号定位，删掉前面任意一章后永远收不下 | 收下时按章标题找唯一匹配的章（去编号前缀、首尾空白，做 NFKC）；找不到或有多个同名才返回 `section-moved` |
| 清理草稿与覆盖草稿的判据不一致 | 统一用意图（`draftIntent`）判断；同 slug 不同意图的草稿在返回文本里点名 |
| 索引重建失败完全静默 | 写入类工具的返回带 `indexStale`；`memory_status` 比较索引条目数与文件数，对不上时明说并给出 `/memory reindex` |
| 回滚失败时仍提示「已恢复原状」 | 单独的原因码 `move-partial` |
| 目录配置检查漏了共享 agents 根 | 补上 `$DSH_AGENTS_HOME`（没设时 `~/.agents`） |
| 测试缺口 | 两次审查的每一项都补了反例测试（`test/review-fixes.test.mjs`、`test/review2-fixes.test.mjs`） |

复审的 8 项里有 6 项出在第五轮的修复本身（相关性判断、章号定位、草稿清理判据、索引重建不抛错却也不说、回滚失败的提示、目录检查漏项）：
修复也会引入新问题，所以修复同样要审。

**为什么单元测试全绿，却没发现这些问题。** 四轮实施期间每轮结束时的复核只看了两件事：`npm test` 是否通过、真实文件是否被动过。
没有人审实现本身。测试是实现者按自己的理解写的，测的是「按我设想的用法能不能跑通」；而审查发现的都是设想之外的输入或状态——
只写了个短前缀的 `supersedes`、一句无关的回复当证据、草稿入队后有人删了前面的章、删源失败、在已启用全局库的机器上跑测试。
写测试的人没想到的情形，测试不可能覆盖。

此后的做法：

1. 每条修复以**审查者的复现脚本**为验收标准：修复前能复现，修复后不再复现；
2. 每条修复补一条**反例测试**，钉住「之前会出事的那个输入」，而不只是正常用法；
3. 改动写入路径（分流、证据核对、草稿、移库、AGENTS.md）之后，另请没看过设计过程的人做带复现脚本的审查，不以「测试全绿」代替。

### 25.10 已知局限（第十一轮之后仍然存在，必须知道）

设计上的取舍与「为什么仍然这样做、防线在哪几层」写在 `docs/DESIGN.md`「局限：防线在哪几层」；这里列事实。

1. **证据核对只管出处，不管语义。** 模型截取用户否定句的后半段，字面上仍是用户说过的字，代码判断不了。
   不要用否定词黑名单之类的办法去补（误伤与漏网都会很多）。
2. **相关性判断是字面的。** 实测：正文引用了用户原话时，22 条真实纠正样例误判 0 条；标题、摘要、正文全部改述时误判 3 条
   （都是很短的纠正），误判的后果是进待确认；完全无关的回复当证据 5/5 被拦下；但把无关回复抄进标题或摘要可以绕过（6/6）。
   防线是另外三层：常驻一律由用户确认、未核实的在面板明示、提示文案不教模型怎么绕。
3. **插件的 HTTP 路由没有鉴权**：宿主的网页服务本身不提供（官方 dsh-host-webserver README：「No server-wide authentication or origin policy」）。
   agent 若用命令行访问这些路由，理论上能自己收下草稿；它的文件工具本来也能直接改 AGENTS.md。
   插件保证的是「记忆工具不直写 AGENTS.md」，不是「agent 无论如何写不了」。
4. 斜杠命令展开的文字、子 agent 的创建提示，其来源标记可能与用户手敲的消息相同，离线无法确认（25.7 第 8 项）。
5. 两条同 slug、意图不同的草稿都被收下时，库里会出现带 `-2` 后缀的第二条（返回文本会点名另一条草稿）。
6. 近似匹配加了上限之后，极端输入下仍约 1 秒。
7. `test/client-logic.test.mjs` 没有 import `isolate-home.mjs`：它只读 `client.js`、不加载 `index.js`，目前不需要；以后若让它加载宿主代码，要先补上。
8. **被改道之后，模型是否真的向用户提议，没有单独验证。** 工具返回了去处，但模型下一步怎么做——提议、默默跳过、还是改个 `type` 再存一次——
   代理模型评测看不到；目标模型评测的计分把「工具改道到正确归宿」本身算作判对，不看之后有没有提议（25.7 第 14 项）。
9. **代理模型评测本身的局限**（详见 25.5）：代理模型不是目标模型，数字只适合同一模型下新旧比较；单步作答，测不到重试与改道后的行为；
   看不到仓库内容，归宿场景的自动分数偏低、须人工读答案；每个场景只采样一次，单个场景的翻转不算信号；归类靠关键词启发式会漏判；
   test 组跑过两次、第一次的结果被看过，已不算严格的留出集。
10. **（已修）嘴上说「记下来了」，其实没调用记忆工具**（目标模型评测 A4）：最需要注意的失败形态——用户会以为记了，下次会话却什么都没有。
    插件拦不住（工具没被调用，插件什么都看不到），所以在系统提示段里补了一句「没有调用 memory_remember 并拿到返回之前不要说记下了」。
    验证方式：A4 在目标模型上跑 3 次，3 次都调用了工具；另 14 题复测中这种情况 0 次（25.11 第 8 点）。只是模拟对话里的验证，真实使用中仍要留意（25.7 第 19 项）。
11. 目标模型评测本身的局限（详见 25.11）：在模拟的对话里做，宿主是假的、仓库是虚拟的；每题只采样一次，同一题会翻转（A2 上一次记了、这次没记）；
    前情只有文字、没有工具调用记录，模型可能不把前情里的坑当作已验证（F3）；6 个场景 24 步用完没收尾，不计入；
    test 组里 4 题已被用来调整过提示词，不算留出；改动前版本只在 dev 组跑过，而且用的是早一些的评测环境与 16 步上限。
12. **（已修）** 面板的待确认页不显示「收下这条草稿会删掉哪条旧记忆」。现在草稿卡片与详情显示「替换记忆 {id}」，收下后旧记忆没能删除时底部提示。
    提示约 2 秒后消失，可能来不及看——需要在真实面板里确认（25.7 第 20 项）。
13. **（已修）** 系统提示段把「用户是谁」列在「记忆」一栏，与代码对 `type: user` + `scope: global` 强制常驻不一致。现在「用户是谁」挪到了全局 AGENTS.md 那一行，文字与代码一致。
14. 代理模型上记过的不足（两个纠正类场景没记、「自己验证过的坑直接存」补上后没再测）已被目标模型评测取代，见 25.11。
15. **常驻写入几乎总要多花一步**：模型第一次调用常驻写入时几乎都没给 `chapter` / `newChapter`，被 `needs-confirmation` 拒一次再重试；
    目标模型评测里全部重试成功，但个别场景因此更容易用满步数。章节协议没有放宽，是否放宽留给用户决定（25.11 第 8 点）。

（上一版这里记过的三条已经修掉：`/memory pending` 的文字列表现在与面板一样区分「用户原话 / 未核实」；`eval/run.mjs` 的口径已跟上插件；
抽取提示词里四个归宿的流程例子已换成与评测题不重合的。）

### 25.11 目标模型评测与第九到十一轮（2026-11-15）

> 本小节取代 25.5 里「目标模型上只跑过 9 个场景」「提示词只在代理模型上测过」等说法，也取代 25.2 里「偏好放按需库就够」的设计倾向。

**1. 在目标模型上完成了评测。** 用户授权改用 Ollama 托管的 DeepSeek V4.1 Flash——就是用户在 DSH 里实际使用的模型。评测参数：
`--key-env=OLLAMA_API_KEY --base=https://ollama.com/v1 --model=deepseek-v4.1-flash:1017`（凭据只写环境变量名）。这一阶段约 1530 次请求（加上第 8 点的复测，累计约 1670 次）；
期间 8 个场景因网络错误中断，用 `--resume` 补跑。步数上限用 24（`--max-steps=24`；脚本默认仍是 16）。

**2. 用户对「一条知识该放哪」逐条拍板**（看了全部题目之后、看 test 组结果之前）：

| 决定 | 含义 |
|---|---|
| 项目里必须遵守的规则以 AGENTS.md 为准 | 全员规则写项目 AGENTS.md，只对用户本人成立的写 AGENTS.local.md；项目记忆库**不存规则**，只放进行中的决定与期限、外部资源位置、踩过的坑、未定成规则的想法；冲突以 AGENTS.md 为准 |
| 所有跨项目的做事与表达偏好进全局 AGENTS.md 常驻 | 推翻此前「索引行每轮可见，偏好放按需库就够」的设计倾向 |
| 写进全局 AGENTS.md 仍要用户在面板确认 | 常驻一律待确认不变 |
| 决定仓库里会留下什么的约定（提交说明、代码风格、命名）算这个仓库的规则 | 写项目 AGENTS.md |
| 只纠正这次结果的、话里带「这次」的 | 都不记 |

评测题的标准答案据此修改，改过的题都有 `note` 记录理由。

**3. 第九到十一轮插件改动**（每轮都用官方校验器源码核对了新增返回值，40 个测试文件全绿）：

| 轮次 | 改了什么 | 为什么 |
|---|---|---|
| 第九轮 | 系统提示段按上面的决定重写：规则以 AGENTS.md 为准；跨项目偏好用 `scope: global` + `load: always`；「这次」不记；只纠正结果时不要归纳出做法；没有具体要记的东西时不要泛泛地问。`LOAD_RULE` 改为偏好用 always；抽取提示词的归宿说明（`HOMES`）同步，流程例子换成与评测题不重合的 | 用户的决定；目标模型评测里出现过「只纠正一个结果却归纳出做法去记」「收工时泛泛地问要不要记一笔」 |
| 第十轮 | 代码强制：`type` 为 `user` / `feedback` 且 `scope: global` 的一律按常驻处理（`resolveLoad`，`ALWAYS_TYPES`）；模型显式给了 `on-demand` 被覆盖时返回 `loadForced: true` 并说明。系统提示段补「决定仓库里会留下什么的约定也算这个仓库的规则」 | 目标模型多次在回复里说「已记到全局偏好」，却把 `load` 留在 `on-demand`——条目进了按需库，不会每轮生效 |
| 第十一轮 | 常驻草稿带上要取代的旧条（`supersedes` + `supersedesScope`，解析规则同按需写入，见 `lookupSuperseded`）；用户在面板收下时先写 AGENTS.md 章节，写成功后再归档删除旧条（`retireSupersededMemory`）；丢弃草稿或章节写入失败时旧条不动 | 强制常驻后，取代按需库里旧偏好的写入会让同一条偏好留下两个出处（第十轮复现过：收下后旧条仍在全局按需库） |

**4. 评测脚本的改动**：

- 新的标准答案取值 `remember:always`：必须进全局 AGENTS.md 常驻；新的错误细分「去处错（应常驻）」——该常驻的偏好记进了按需库，记了但下次不会自动生效；
- `AGENTS.local.md` 计入 AGENTS 归宿；
- 「提议写某处」必须是**写入动作作用于该处**，只提到 AGENTS.md 不算；
- 重算一律以当前题目文件的答案为准；
- 虚拟仓库补齐了多个场景的前情（F2 的链接依赖、H2 的面板、J1 的轮询代码等），避免模型核实之后认为前情是编的；
- 步数上限用 24。

**5. 目标模型上的结果**（最新合计：受第十、十一轮影响的 17 个场景取第十一轮的最后一次重跑，其余取第九轮那次，A 类与 K 类再取第 8 点的复测；按当前标准答案计分）：

| 类别 | 判对 |
|---|---|
| 纠正做法 / 表达（A） | 10/10（第 8 点复测后；之前是 8/10） |
| 项目决定与期限（B） | 3/3 |
| 外部资源（C） | 2/2 |
| 用户是谁（D） | 2/2 |
| 不该记的（E） | 12/12 |
| 自己踩的坑（F） | 2/3 |
| 归宿 skill / AGENTS.md / README（H/I/J） | 9/9 |
| 去向不明（K） | 3/3（K1 经人工复核：模型先追问、条件性提议，自动归类误判为提议写入） |
| 更新已有记忆（U） | 2/2 |
| **合计** | **45/46**（第 8 点之前是 43/46）；另有 6 个场景 24 步用完没收尾（B2、E10、E13、E14、E16、F2），不计入 |

**注意**：B、C、E、F、H、I、J、U 类的结果来自早两轮的版本；之后系统提示段改过两句（「决定仓库里会留下什么的约定也算这个仓库的规则」、
「没调用工具前不要说记下了」），这些类别没有重跑。

第十一轮之后判错的三处，以及现在的状态：

- **A4（已修）**：模型在回复里说「这条要求我记下来了」，但没有调用记忆工具——最需要注意的失败形态，用户会以为记了。修复与复测见第 8 点；
- **A2（已解决）**：用大白话重讲了，但没记；同一题上一次运行是记了的，单次采样会翻转。第 8 点的复测里判对；
- **F3（仍判错）**：模型认为前情里没有验证过程，不肯把坑当作已验证的结论存下来。评测题的前情只有文字、没有工具调用记录，这是评测环境的局限。

**6. 与改动前版本对照**（同一目标模型，dev 组两版都正常收尾的 20 个场景）：改动前 13/20，最新版 18/20。

- 改动前的错误：两次漏记（先给预览再改、自己踩的坑）；三次把发布流程 / 仓库规则 / 设计取舍存进了记忆；两次把仓库约定存进了记忆；
- 最新版（第十一轮）的错误：A4、F3；其中 A4 之后已修（第 8 点），这 20 个场景里剩下的只有 F3；
- **注意**：改动前那一轮用的是早一些的评测环境与 16 步上限，且最后一个场景因请求上限没跑完；test 组没有跑改动前版本。

**7. 留出集**：test 组里 E3、E5、E11、E15 在第九轮提示词修改前已被看过结果，修改又参照了它们（以及用户的决定），这四题**不再算留出的检验**；
test 组其余题目没有用来调整过提示词。

**8. 之后的三处小改动与一轮复测。**

- **修「说记下了却没调用工具」**：统计已保存的目标模型运行，模型在回复里共 24 次说「记下了」，1 次没有真的调用工具——那一次模型想先问用户
  写项目 AGENTS.md 还是记忆，遵守了「等用户答复期间不要先存一份」，回复里却说成已记下。系统提示段补了一句：没有调用 `memory_remember`
  并拿到返回之前，不要对用户说「记下了」；决定先问用户写到哪时，就说明还没记。
- **系统提示段把「用户是谁」挪到全局 AGENTS.md 那一行**：原来列在「记忆」一栏，与代码把 `user` + `global` 强制常驻不一致；
  现在在所有项目都成立的「用户是谁」与做事、表达要求一起进全局 AGENTS.md。
- **面板标出会被取代的旧记忆**：草稿带 `supersedes` 时，卡片和详情显示「替换记忆 {id}」（旧记忆在另一个库时补上所在库）；
  收下后若旧记忆没能删除，底部提示「已收下，但旧记忆 {id} 未能删除」。
- **在目标模型上复测**（同一个 Ollama DeepSeek V4.1 Flash，约 140 次请求）：A4 跑 3 次，3 次都调用了工具、进了全局 AGENTS.md 待确认；
  其余偏好类与去向不明类 14 题各跑 1 次，全部判对（K1 经人工复核：模型说明「我先不记规则」并列出三个选项让用户选，
  自动归类把选项里的「写进仓库的 AGENTS.md」误判为提议写入）；「说记下了却没调用工具」0 次。
- **观察到的摩擦（未改）**：几乎每次常驻写入，模型第一次调用都没给 `chapter` / `newChapter`，被 `needs-confirmation` 拒一次再重试，多花一步；
  全部重试成功，但个别场景因此更容易用满步数。是否放宽这条章节协议，留给用户决定（25.10 第 15 项）。

**定稿时每轮固定进上下文的字符数**（系统提示段 + 四个记忆工具的定义，按代码直接量，口径与 25.5 相同）：7931，比改动前的 5722 多 2209，约 39%。
其中系统提示段 999，`memory_remember` 的 description 820、各参数说明合计 3492。

**仍然没有验证的：**

- 没有在真实 DSH 里装过（25.7 第 17–20 项是这几轮新增的检查点）；评测是在模拟的对话里做的；
- 被改道之后模型是否向用户提议（计分把改道本身算作判对）；
- 每题只采样一次（A4 跑了 3 次）：单题的对错会翻转，45/46 这个数字的波动范围不知道；B、C、E、F、H、I、J、U 类没有在最新系统提示段上重跑。

## 二十六、记忆面板重设计（2026-11-15）

设计依据、命名、信息架构、接口约定都在 [docs/PANEL.md](docs/PANEL.md)；视觉以 `preview/panel.html`（用户确认过的静态预览）为准。

**做了什么**：右侧栏面板从「记忆库 | AGENTS.md」两个页签改为「总览 · 待确认 · 指令 · 记忆」四页。总览是按「在哪儿生效 × 什么时候读」摆的 2×2 记忆地图，加上每轮固定开销和可能过时的记忆；待确认是审阅卡（完整去向、为什么要确认、新旧对比、证据引用）；指令页可以编辑全局指令、只读查看项目指令；记忆页的列表与详情按新叫法重做。宿主新增 `GET /project-agents`、`POST /agents/create`，扩展 `/list`、`/agents`、`/agents/sections`、`/promote`（项目记忆一步升为全局指令）、`/open-agents`（`target`）；斜杠命令回执统一新叫法。给模型看的文字（系统提示段、工具描述、工具返回值、MEMORY.md 索引）一字未改，`test/command-labels.test.mjs` 守着。

**流程**：盘点旧面板（95 项功能、25 个体验问题）→ 从 DSH 安装包抽出真实主题 token 与组件规格 → 静态预览给用户看 → 用户确认（并拍板 type 改名、项目指令只读页、项目记忆一步升级）→ 宿主半与客户端并行实现 → 两轮独立只读审查（带复现）→ 修复 → 复验。

**审查发现并已修复**：
- 宿主半（7 条）：`/open-agents` 经 cmd 打开项目路径时 `&` 被当命令分隔符（中，已用真实参数形态在 `p&ver&echo` 等 6 种目录名上重放确认修复：路径放进内层双引号 + `windowsVerbatimArguments`，含 `%` `"` 的路径拒绝）；`target` 数组绕过校验；`agents/create` 遇悬空链接会在目标处建目录；`promotable` 与 `/promote` 不一致；`pending[].slug` 未归一化；三处测试空转；`already-exists` 改 409。
- 客户端（14 条）：保存在途时输入被覆盖（高，改为按请求快照合并）；章节编辑器不随文件变化、再保存会回滚刚收下的整章（高，未改时跟随、改过时提示冲突）；快捷键 A 在没聚焦卡片时收下第一张、按住连发（中）；保存在途可以切换编辑对象（中）；自动链接把转义字符吞进 href；隐藏的编辑器响应 Ctrl+S / Esc；输入法组字时 Esc 触发放弃；标题带编号时提示「第 0 章」；改名后焦点丢失；partially-saved 错误显示在别的条目；升级与删除没有 busy；英文界面露中文标点；测试只覆盖纯函数。

**怎么验证**：
- `npm test`（42 个文件）。原因码覆盖测试从 `index.js` 读宿主会返回的码，宿主新增原因码而客户端没翻译时会失败。
- `bash preview/verification/checks/run.sh [React 18 UMD 目录 URL]`：用 render-harness 挂真实 `client.js`，53 项交互回归（保存在途、章节同步与冲突、快捷键与输入法、条目身份、卸载清理）。不给 URL 用迷你运行时，给了用真 React + StrictMode。脚本先 cd 到临时目录再调 playwright-cli（它会把日志写进当前目录）。
- `render-harness.html` 支持 `?data=`（状态）、`?delay=<ms>`（暴露请求在途窗口）、`?react=<url>`，`window.__harness.unmount()` 验证释放。

**还没验证**：没在真实 DSH 里跑过。重载后确认插件 `application` 为 `applied` 且无 diagnostic，再把四页点一遍（尤其：指令 · 本项目读到的是不是当前仓库的 AGENTS.md；「升为全局指令」一条项目记忆；在待确认里收下一条覆盖章节的草稿后，指令页的内容是否跟着变）。

**回退**：在插件目录 `git revert` 本次合并的提交（或 `git reset --hard 2fa2737`，会丢弃之后的改动），再在 DSH 里对插件 disable → enable。

**过程中的意外**：06:12 系统清空了会话暂存目录，设计说明、接口约定、盘点文件丢失，已按最终状态重写进 docs/PANEL.md；第一轮客户端审查的 playwright 日志曾写进另一个仓库的当前目录（已移走、已核对干净），检查脚本因此改为先 cd 到临时目录。

## 二十七、发布到 npm（2026-11-15）

**包名**：`@lovenndme/dsh-workspace-memory`。裸名 `dsh-workspace-memory` 已被 `luyy9apples` 占用
（npm 0.1.0，仓库 github.com/luyy9apples/dsh-workspace-memory），所以改用 scoped 名。

**仓库**：https://github.com/Lovenndme/dsh-workspace-memory（public，main）。
推送必须走 SSH：gh 的 OAuth token 只有 'gist'/'read:org'/'repo'，缺 `workflow` scope，
HTTPS 推 `.github/workflows/*` 会被拒（`refusing to allow an OAuth App to create or update workflow`）。
本机 SSH 已注册，改 remote 为 `git@github.com:...` 即可。

**链路**：`.github/workflows/publish-pending.yml`（沿用 dsh-profile-stats 的模板）：
cron `0 */4 * * *` + `workflow_dispatch`（含 dry_run）→ tag 门禁 → patch 升版（**node** 写 package.json）
→ 生成 CHANGELOG → `node --check` → 装可选依赖 → `npm test` → 提交 → `npm publish --access public`
→ 打 tag → `gh release create` → 轮询 registry（超时只告警，不让 CDN 慢把 job 判红）。

**首次发布**：先 `dry_run=true` 验证链路（它按设计仍会提交 `release: v0.8.1`，只是不发 npm、不打 tag），
再真实运行发出 **0.8.2**：registry latest=0.8.2、tag `v0.8.2`、GitHub Release v0.8.2 三处都到位。

**只在 Linux CI 上暴露的问题（本地 Windows 一直全绿）**——这是本次最大的收获：

1. `test/config.test.mjs` 硬编码 `C:\tmp\mem`，Linux 上不是绝对路径 → 改 `path.resolve('/tmp/...')`。
2. `test/extract.test.mjs` 的语义去重依赖向量嵌入，CI 没装 leanvec → 先探 `rebuildVectors().mode`，
   非 hybrid 时**打印 SKIP**，不假装通过。
3. `test/golden.test.mjs` 纯关键词模式下中文 recall 实测只有 20%（本地 hybrid 是 70%）→
   非 hybrid 时跳过召回阈值，只查语料结构与负样本。
4. `test/panel-routes.test.mjs` 两处 cmd 引号断言是 Windows 专属 → 非 Windows 打印 SKIP。
5. workflow 补一步 `npm install --no-save --include=optional`（装 leanvec）并 `continue-on-error`——
   装不上只是少测，不能让一次 85MB 下载把发版无限期卡住。

**教训**：本地 `npm test` 42 项全绿**不等于** CI 绿。发版门禁的价值恰恰在于它跑在另一个 OS 上；
「我这儿是好的」不是证据。

**还没验证**：npm 安装路径（`plugin_manager install_bundle --target @lovenndme/dsh-workspace-memory`）
没在这个 profile 里试过——当前 profile 仍以 link 装同一份源码，按「pnpm remove 会删穿 link 目标」的教训，
不主动动它，等下次要统一来源时再按那条流程做。

**副作用**：这次 HANDOFF 提交会被下一次 4 小时批量发成 0.8.3（任何提交都会触发一次 patch 发布，这是设计如此）。

**启动页入口与前端加载排查（2026-11-16）**——详细结论与源码依据在 [docs/PANEL.md](docs/PANEL.md) §8。

- **现象**：disable → enable 后宿主半是新的，但 `/memory_list` 显示宿主默认的折叠命令卡，右侧栏没有「记忆」页签。
- **根因**：上面「发布到 npm」把包名改成 `@lovenndme/dsh-workspace-memory`（`a4eeb52`），`cordis.patch.yml` 跟着改了，
  `client.js` 却仍以 `id: 'dsh-workspace-memory'` 注册。宿主 `dsh-client-modules` 按 **package.json 的 name** 找浏览器 factory：
  id 对不上时浏览器报 `could not load … loaded without registering … via __ModuleLoader__.load`，插件条目不创建，
  命令卡回落成 `GenericCommandCard`、页签与面板都不注册；profile 行名与 package.json 的 name 不一致时更糟——宿主根本不把它当客户端行，静默。
  跟面板重写无关：同一份新 `client.js` 在改名前的包名下用真实加载器能正常物化。
- **复现**：用 DSH 安装包里真实的 `dsh-client-modules`（宿主半 `lib/index.js` + 浏览器半 `lib/client.js`）在 Node 里组图、取 bundle、物化，
  四种组合的结果表在 PANEL.md §8.3。复现脚本在会话暂存目录，会被清掉，结论以文档为准。
- **修复**：`client.js` 的模块 id 改成 `@lovenndme/dsh-workspace-memory`；`test/client-logic.test.mjs` 新增「模块身份」一节，
  断言 `client.js` 的 id、`package.json` 的 name、`cordis.patch.yml` 的行名三者相同。**以后改包名三处一起改。**
- **启动页入口**：宿主「开始」页的入口来自页签类型定义的 `guide` 字段（`dsh-client-ui-sidebar-right` 的 `tab-registry.ts` / `GuideBody.tsx`），
  `client.js` 的 `memoryTabDefinition()` 加了 `guide: [{ id: 'open', order: 70, title, description, icon }]`，点击由宿主 `openTab('memory-list')`。
  「更多工具」卡被宿主固定画在所有入口之后，**排不到它下面**，`order: 70` 让「记忆」落在它正上方（内置入口最大是会话数据诊断 60）。
  图标自绘（viewBox 16，描边 1 / 1.3，`currentColor`）。
- **验证**：`npm test` 42 个文件全绿；`bash preview/verification/checks/run.sh` 迷你运行时与真 React 18.3.1 + StrictMode 各 67 项全过
  （原 53 项 + 新增 `06-start-entry.check.js` 14 项）；`render-harness.html` 加了 `?view=guide`（「开始」页仿真，内置入口是写死的仿制品）、
  `__harness.tabs` / `hostCalls` / `showGuide()`；迷你运行时改为跨多个根统计「本轮访问过的实例」（以前第二个根会把第一个根的组件当成已卸载）。
- **未在真实 DSH 验证**：入口在真实「开始」页的位置与样式、点击后真的打开面板、修复后的前端在真实页面里加载——都只在仿真与真实加载器的 Node 复现里验证过。
- **需要用户处理 / 决定**：
  1. 修复要进 live 目录（提交并拉到插件目录）后才生效；宿主会轮询 `client.js` 的 mtime / 大小自动替换，没好就去「设置 → 插件 → 插件列表」点重试，
     再不行 F12 打开开发者工具执行 `location.reload()`，或从托盘退出 DSH 再开（正式版没有 Ctrl+R）。
  2. 如果插件列表里**没有**同步失败、页面载入后 `window.__DSH_BOOT__.entries` 里也没有本插件，说明 profile 里这一行的 `name` 不是新包名，需要按新包名重装（注意「pnpm remove 会删穿 link 目标」）。
  3. 改名后 profile 自己的 `cordis.patch.yml` 里写了 `name: dsh-workspace-memory` 的覆盖项会被 `cordis-plugin-include` 整条跳过
     （`patch: name mismatch … skipping`），里面的 `config`（如 `agentWrites`、`enableExtraction`）不再生效，要改成新包名或去掉 `name`。
  4. 已发到 npm 的版本（0.8.2 起；0.8.1 只是 dry run）都带着这个 id 错位，从 npm 装的用户前端同样加载不上；修复提交推到 main 后 CI 会发下一个 patch 版本。

## 二十八、/memory 命令优化（2026-11-15）

只改给人看的部分：输入提示、命令回执、命令结果卡片。给模型看的文字一字未改（见下「守卫」）。

**核实到的 DSH 命令接口**（安装包 0.2.2-rc.3 的 app.asar）：
- 宿主侧 `ctx.commands.register` 的 `input` 只有 `hint` 与 `attachments`（`@deepseek-ai/dsh/docs/subsystems/commands.md`「输入元数据」`CommandInputDescriptor`），**没有参数候选**；hint 只在敲 `/memory ` 之后作为输入框占位出现（`dsh-client-ui-commands/src/client/service.ts` 的 `leadingClaim`），菜单行不显示它（`dsh-client-ui-input-trigger/src/client/MenuView.tsx` 不渲染 hint）。
- 客户端另有 `ctx.commandUi.decorate({ name, available, ui })`（`dsh-client-ui-commands/src/client/contract.ts` 的 `CommandDecoration`）：给**宿主命令的裸调用**（菜单选中或只敲命令名回车）挂一个 popupSelect / action，带参数的输入仍走宿主命令（`service.ts` 的 `dispatch` / `matchEnter`）。官方 `/feedback`（`dsh-client-ui-message-feedback`）与 `/permission`（`dsh-client-ui-permission-presets`，选中后 `session.command('/permission …')`）就是这个用法。

**做了什么**：
- 输入提示改成 `pending 待确认 · extract 抽取 · list 全部 · help 更多`（accept / reject / forget / reindex / status 照常可用，收进 help）；命令描述改成一句中文。
- 客户端 `registerMemoryPicker`：只敲 `/memory` 弹出子命令选单，三组（常用：总览、pending、extract、list、status；需要 id：accept、reject、forget——选中打开面板；整理：reindex、help）。总览标 active，回车两下 = 以前回车一下。选中经 `sessions.binding(id).session.command(line)` 执行，结果照常落成命令卡。没有 `ctx.inject` / `commandUi.decorate` 的旧版 DSH 什么都不做。
- `/memory` 总览按面板记忆地图重排（待确认 → 每轮都读 → 用到才查 → 每轮固定开销 → 检索 / 写入一句话），不出现本机路径、配置键名、向量维度；诊断细节移到新增的 `/memory status`；新增 `/memory help` 与未知子命令的「你是不是想输入」（前缀、编辑距离、照着提示打的中文）。`pending` 每条两行，`list` 带相对时间、单库最多 30 条，`forget` 改说旧版在 `.memory-state/history/<id>/` 与怎么手动拷回（以前写「可回退」，但没有恢复入口）。错误回执全部中文并给下一步。对齐按显示宽度（中文 2 格）。
- 每轮固定开销与面板一致：面板（`costParts`）算的是全局指令 + 项目指令**团队与仅你** + 索引估算，宿主 `perTurnCost` 照抄同一算法。
- 命令卡 `MemoryCommandCard`：标题带子命令，文本下加「打开记忆面板」按钮，`/memory pending` 与 `/memory_pending` 的卡写「去面板处理」（只打开面板，不能直接跳到「待确认」页：面板没有对外的切页入口）。

**守卫**：
- `test/model-visible-text.test.mjs`：系统提示段全文、四个工具的 description / 参数 / output schema、MEMORY.md 索引格式、每轮注入的索引上下文，与 `test/fixtures/model-visible-text.json`（由 e16ba87 生成）逐项比对；不一致就失败并提示「改了模型可见文字要重跑评测」。真要改时先跑评测，再 `node test/model-visible-text.test.mjs --update`。
- `test/memory-command.test.mjs`：总览各状态、status、help、建议、pending / list / forget 文案、显示宽度对齐、不含本机路径；把宿主路由的真实响应喂给 client.js 的 `normalizeAgents` / `normalizeProject` / `costParts` / `tokensOf`，与总览的 tokens 对拍；`relativeTimeZh` 与面板 `relTime` 对拍；用假 ctx 跑 client 的 `apply`，检查命令卡按钮与 decorate 的注册、选中行为、旧版降级。

**还没验证**：没在真实 DSH 里跑过。重载后确认 `application` 为 `applied`、无 diagnostic，再试：只敲 `/memory` 是否弹出选单、回车两下是否出总览、`/memory ` 加空格时输入框提示、选中「收下草稿」是否打开面板、命令卡按钮。
