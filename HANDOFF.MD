# HANDOFF

写给下一个接手的人（或下一轮的我）。记录**当前真实状态**、**踩过的坑**、**验证到了什么程度**。

---

## 一、当前状态（一句话）

`client.js` 的记忆面板已按 `preview/panel.html` 重写为「文档式详情 + 编辑/预览 + 文件信息弹层 + 未保存守卫」，
样式从预览整表搬入并**全部 scope 在 `.wsm-panel` 下**。宿主逻辑未改动。

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














