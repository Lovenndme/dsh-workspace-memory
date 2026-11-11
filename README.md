# dsh-workspace-memory

工作区级持久记忆插件（DeepSeek Harness / Cordis）。设计参考 Claude Code 的 auto-memory 模块，**只做其中的自动记忆层**——指令文件层（AGENTS.md / 路径作用域规则）由宿主已有的注入机制负责，这里不重复造。

## 它解决什么问题

上一代实现（`@yolk_vat-y/dsh-project-memory`）的实测状态：905 个索引文件里 760 个是 MCP 文档转储与第三方源码树，真正在维护的项目一个都没进去；中文查询会返回 `int16` / `sha1` 这类无关符号并打 97–100 分。

**分数不可信比没有检索更危险**——你会误以为「库里没有」而重新推导一遍。这个插件的第一原则是：宁可返回空，不返回噪声。

## 存储布局

`memory/` 与 Claude Code 的 auto-memory 完全一致；插件自己的状态放在**它外面**，而且只在真有草稿时才出现：

```
~/.dsh/projects/<编码后的工作区路径>/
├── memory/                              ← 只有记忆，与 CC 一模一样
│   ├── MEMORY.md                        # 索引，一行一条，每轮注入
│   ├── no-explanatory-text-in-ui.md     # 一条记忆一个文件，和索引同级
│   ├── hot-reload-local-bundle-generation.md
│   └── pnpm-remove-link-deletes-target.md
└── .memory-state/                       ← 本插件私有；没有草稿/历史时不存在
    ├── pending/                         # 待确认草稿
    └── history/<slug>/<时间戳>.md        # 历史版本（覆盖/删除前留档）
```

### 向量索引不落盘

语义检索用的 256 维向量**只活在进程内存里**（`vectorStore`），磁盘上没有任何索引文件。

- **首次检索**时懒建，之后全走内存。实测 5 条 77ms、200 条约 650ms；同一进程内第二次 1ms
- 进程重启后重建一次，这是唯一代价
- 换来的是：不再有格式版本、mtime 失效、文件损坏这一整类问题
- `.memory-state/` 只剩草稿，**整个目录删掉也只丢草稿，记忆本体分毫不动**

> 为什么不用 DSH 的 `storage` / `storageDomain`：`DomainSpec` 强制要求 `valueSchema: ZodType`，
> 而这个插件是 link 装在工作区里的，Node 按真实路径解析依赖，**`zod` 与
> `@deepseek-ai/dsh-storage-domain` 都解析不到**（和 leanvec 需要专门做回退查找同一个原因）。
> 要用它得先加 `zod` 依赖、再走一次安全的 link 重装，代价大于收益，所以选择内存化。

项目路径按 **DSH 自己的 sessions 目录同一套规则**编码：去掉盘符冒号、分隔符换成单横线、两头包 `--`。
`C:\Users\lenovo\Documents\DSH-Workspace` → `--C-Users-lenovo-Documents-DSH-Workspace--`。

这样 `~/.dsh/projects/` 和 `~/.dsh/sessions/` 用的是同一个键，同一个项目在两棵树下对得上。
（Claude Code 用的是 `C--Users-...`，把冒号也换成横线；这里选了跟宿主一致。）

### 文件名是独立的英文 slug

**索引行要求「英文在前、中文说明在后」，所以文件名必须是英文 slug：**

```md
- [No explanatory text in ui](no-explanatory-text-in-ui.md) — 界面只呈现数据与控件，不加解释性文案
```

- slug 是**独立标识**，不从中文标题派生。改标题**不会**重命名文件
- 只有显式改 slug 才重命名，并删除旧文件（不留两份）
- 撞名自动加 `-2`（**不分大小写**比较——Windows 上 `Docs.md` 与 `docs.md` 是同一个文件），不覆盖别人的记忆
- `memory_remember` 写项目记忆时，标题含非 ASCII 字符却没给可用的英文 slug → **拒写**并返回 `needs-slug`，
  要求模型补一个英文 slug 再调。实测此前真实库里 3 条有 2 条因为模型漏给 slug 落成了中文文件名
- 抽取草稿、手写文件等其它路径没给 slug 时仍退回标题派生（降级路径）

`memory_remember` 有 `slug` 参数、抽取提示词也会要求模型给英文 slug、面板里可直接编辑（面板拒绝非 ASCII slug）。

> 一处与 CC 的有意偏离：**「项目」取自 DSH 的 `workspaceRegistry`，不是 git repo root。**
> 这个工作区里 `dsh-profile-stats`、`dsh-command-context` 各自是独立 git 仓库，
> 用 git root 会让每个子项目各建一个记忆库；用工作区才能做到「整个工作区共用一个库」。

`MEMORY.md` 照抄 CC 的形态：

```md
# Memory Index

- [Hot reload local bundle generation](hot-reload-local-bundle-generation.md) — 本地 bundle 改完不热更：disable→enable 切一次插件行来换模块代次
- [Profile stats auto npm publish](profile-stats-auto-npm-publish.md) — profile-stats 每次改完自动发 npm（测试 → 升版本 → 提交 → publish → 校验）
```

不写 root / count / 分组标题 / 标签 / id 前缀——那些是噪声，每行宽度应该留给真正的摘要。
链接文字由 slug 机械还原（`-` 换空格、首字母大写），所以**不需要单独维护一个显示名**。

记忆文件本体：

```yaml
---
name: no-explanatory-text-in-ui            # = 文件名
description: 界面只呈现数据与控件，不加解释性文案   # = 索引里破折号后那句
type: feedback
status: confirmed
tags: [lesson, README]
paths: []
created: 2026-11-01T07:51:07.279Z
modified: 2026-11-02T01:37:55.091Z
confidence: 0.95
title: 界面里不要自行添加解释性说明文字        # 中文标题，只在面板里显示
---
界面里不要出现多余的说明文案。
```

`description` 是索引与正文的公共投影：**显式给了就用给的；正文变了且没给就按新正文重新取一行；正文没变则保持原摘要**，避免只改标签也把摘要冲掉。上限 120 字符（它就是索引那一行）。
自动取行时**跳过标题、代码围栏与分隔线**——正文以 `## 规则` 开头时，以前索引里那一行就只剩「规则」两个字。

frontmatter 是 YAML 的一个子集，读写互为逆运算：

- 值会产生歧义时（换行、首尾空白、`: `、` #`、以 `[ " ' { # …` 开头、空串）序列化器写成 **JSON 双引号串**（也是合法 YAML），普通值仍是裸文本，所以旧文件解析结果不变
- 数组项含 `,` `[` `]` `"` 时同样加引号；`[WIP] Foo [x]` 这种标量不会被误读成数组
- `title` / `description` 是单行字段，落盘前换行一律折成空格；开头的 UTF-8 BOM（记事本另存）会被忽略
- 更新时保留 `hits` / `lastHit` 与所有未知键（手写的、别的工具加的）

`type` 有四种，对齐 Claude Code：`user`（角色偏好）、`feedback`（纠正与确认过的方法）、`project`（进行中的工作与非显然决策）、`reference`（仓库外信息的存放位置）。

> 局部更新（只改摘要 / 只改 slug）**不会**冲掉 `type`、`tags`、`created`——没传的字段一律沿用原值。
> 早期版本在「没传 type」时会回落成 `project`，已修复并加回归断言。

一条记忆一个 Markdown 文件，插件坏了、被卸了、换编辑器，记忆都还在。
**但请注意**：放进 `~/.dsh` 后记忆不再位于工作区内，**不能用 git 管**——这是 CC 的取舍（机器本地、不进版本库）。

## 注入

每轮通过 `ctx.systemPrompt.context()` 注入 `MEMORY.md`，上限 **200 行 / 25KB**（先到者为准，照抄 Claude Code 的口径）。超限时**不静默截断**：注入文本末尾追加一行 `[WARNING] N of M memory entries are NOT listed above…`，并为这行预留预算，保证它一定进得去。

> 以前警告是追加在 `MEMORY.md` **文件末尾**的，而注入是从头截断——超限时被截掉的恰好就是警告本身。

库里一条都没有时不注入（只剩 `# Memory Index` 标题没有意义）。

`interpolate: false` 是必需的：记忆正文可能含 `{{ }}` 或 `[]`，让它们被当成插值语法解析会把注入搞崩。

注入失败、检索失败、向量构建失败全部 `try/catch` 兜底并降级，**绝不让记忆功能拖垮主对话**。

## 检索：向量 + 关键词混合

本地 embedding 用 `leanvec`（静态嵌入表，dim 256，中文/英文/俄文/代码剪枝，零依赖、不联网、按 token 懒读行）。

融合权重：向量 0.65 / 关键词 0.35。关键词通道对中日韩文字（含假名、谚文）做二元组切分；
拉丁文按词，且**只在词首命中**（`ci` 不再命中 "spe**ci**fied"，`recall` 仍能命中 `memory_recall`）。

真正的闸门是**融合分 `minScore`（默认 0.34）**，由金标集扫描标定，见下文「召回质量怎么衡量」。
`minVectorScore` / `minKeywordScore` 只是前置筛：leanvec 是静态嵌入，任意文本余弦都容易过 0.3，单靠它们等于没有闸门。

向量与文件内容按哈希对账：手改过文件、或新文件还没有向量时，`recall` 会就地增量重嵌，不会继续用旧向量。

## 已知限制

**不做跨语言语义桥接。** leanvec 是按语言与字面聚类的静态嵌入表，不是多语言语义模型。实测：中文提问「怎样把服务发布上线前的检查跑一遍」对一条英文记忆只给出 0.45 的相似度，却把同类中文记忆排到了第一。

**记忆尽量与提问同语言书写。** 这条没有在代码里硬撑——测试单独列出并只报告实测值，不假装它做不到的事。

`embed()` 对希腊/希伯来/阿拉伯/泰文返回 `null`（leanvec 未覆盖这些文字），这些内容在建索引时被跳过，检索退回纯关键词。

## 工具

| 工具 | 作用 |
| - | - |
| `memory_remember` | 写一条记忆，落盘 + 重建索引 + 重建向量 |
| `memory_recall` | 混合检索，返回带出处的正文；无匹配时明确说「视为没记录过」 |
| `memory_forget` | 按 id 删除 |
| `memory_status` | 根目录、条数、索引体积、向量覆盖 |

## 命令与界面

```
/memory             概览（命令卡默认展开，不需要再点一下）
/memory list        列出全部记忆
/memory reindex     重建索引与向量
/memory pending     列出待确认草稿
/memory accept <id> 收下草稿，搬进正式库并重建索引与向量
/memory reject <id> 丢弃草稿
/memory forget <id> 删除一条记忆（别名 delete，支持唯一前缀；删除前留历史版本）
/memory extract     立刻跑一次抽取（不管 enableExtraction 与节流）
/memory_list        在右侧栏打开记忆面板
/memory_extract     同 /memory extract（独立命令，便于在补全菜单里点选）
/memory_pending     同 /memory pending
```

DSH 只补全命令名、没有参数级补全，所以无参子命令各注册成一个独立命令；带 id 的 `accept / reject / forget` 仍走 `/memory <sub> <id>`。

### 命令卡为什么能默认展开

内置的 `GenericCommandCard` 折叠状态是组件内部 `useState(false)`，没有配置项。
能改的只有扩展点：占用按命令名分发的 keyed slot `conversation.chat.commandview`，
用 `key: 'memory'` 注册自己的卡片，直接铺开。

`/memory_list` 的卡片更进一步——挂载时调用 `ctx.layout.openRightbar()` 打开右侧栏，
再用 `ctx.sidebarRight.openTab('memory-list')` 切到记忆面板。这样命令本身不需要任何
「开窗口」的宿主能力。

### 右侧栏记忆面板

`sidebar.right.pane.tab`（keyed、会话级）注册面板主体，tab 类型由
`ctx.sidebarRightTabs.register()` 声明。

**响应式布局**：

- 宽度 ≥ 640px（例如全屏时）：左侧记忆列表 + 右侧详情，左右分栏
- 宽度不足（右侧栏常规宽度）：退化成「列表 → 点一条进入详情」，带「返回列表」

面板内容：

- 顶部：标题、工作区名、刷新
- 分组切换：已确认 N / 待确认 M
- 搜索框：在**标题、摘要、标签、正文**里本地过滤（不走向量检索）
- 列表项：标题、摘要（最多两行）、类型徽章。**不显示置信度百分比**——见下
- 详情：标题 / 类型（本地化标签 + 英文枚举）/ 标签 chips（可增删）/ 摘要 / 英文文件名 / 正文
- 正文编辑器带**行号 gutter** 与全屏模式，`textarea` 与 gutter 同步滚动
- 底部：来源文件名、更新时间、未保存提示、取消 / 保存
- 待确认项：**只读**，底部换成 **收下 / 丢弃** 两个按钮（与 `/memory accept|reject` 同一套宿主函数）。
  宿主没有「改草稿」的接口，以前允许编辑，改完点收下修改会被静默丢掉
- 标题与摘要是单行字段：回车被拦下（输入法组字中的回车除外），粘贴进来的换行折成空格

「取消」在有未保存改动时会先确认，不会静默丢弃。切换记忆、切换页签、在 AGENTS.md 页签换章或切回记忆库，都走同一个守卫。

`Ctrl/⌘ S` 只在「面板可见、焦点在面板内、当前页签有未保存修改」时接管，否则不拦截宿主别处的快捷键。

保存以宿主回读的记忆为准（改 slug 会换 id，不再按标题去列表里反查）；保存期间切走了，迟到的响应不会写进另一条记忆的编辑器。换会话时面板整体重挂。

### `/memory_list` 的自动打开语义

只在**这次命令真的刚完成**时打开一次，之后不会再自动弹开：

- 判定依据是「卡片首次挂载时结果是否已经存在」——刚敲完时结果是 `null`，随后才出现；
  切回会话或刷新页面时结果已经在，说明只是回放历史，不该打开
- 另有第二道守卫（按命令调用身份记在 `sessionStorage`），防止命令还在跑时重挂载开两次
- 卡片上始终有「打开记忆面板」按钮，任何情况下都能手动打开

> 早期版本用组件内 `useRef` 做「只开一次」的守卫，但它随挂载重置——
> 结果是关掉侧边栏后切会话回来又自己弹开。已改为上面的挂载态判据。

## 数据通道与会话定位

界面与宿主之间走宿主 HTTP 路由，和工作区里 `dsh-profile-stats` 同一条路：

```
GET  /api/dsh-workspace-memory/list?session=<id>
POST /api/dsh-workspace-memory/save?session=<id>
POST /api/dsh-workspace-memory/accept?session=<id>          # 收下草稿
POST /api/dsh-workspace-memory/reject?session=<id>          # 丢弃草稿
POST /api/dsh-workspace-memory/forget?session=<id>          # 删除记忆
POST /api/dsh-workspace-memory/promote?session=<id>         # 把一条记忆搬进 AGENTS.md
GET  /api/dsh-workspace-memory/agents                       # AGENTS.md 概况 + 探测到的编辑器
POST /api/dsh-workspace-memory/open-agents                  # 用指定编辑器打开 AGENTS.md
GET  /api/dsh-workspace-memory/agents/sections              # AGENTS.md 按章切分
POST /api/dsh-workspace-memory/agents/save-section          # { index, expectedTitle, title, body }
POST /api/dsh-workspace-memory/agents/delete-section        # { index, expectedTitle }
POST /api/dsh-workspace-memory/agents/add-section           # { title, body }
```

**所有 POST 必须带 `Content-Type: application/json`**，否则 415。浏览器跨站发出的「简单请求」只能是
`text/plain` / 表单类型，带 JSON 类型就必须先过 CORS 预检——只要宿主不对跨站预检放行，
网页就没法借本机端口改写每轮都会注入的 AGENTS.md。（宿主的 CORS 策略未核实；AGENTS.md 相关路由不要求 session。）

失败统一返回 `{ ok: false, reason, errors }`：

| 状态 | reason |
|---|---|
| 400 | `no-session`、`invalid-id`、`invalid-index`、`invalid-json` |
| 404 | 记忆 / 草稿不存在 |
| 409 | `section-moved`（章节已被外部改动挪了位置）、`library-full` |
| 413 | `body-too-large`（上限 1 MiB） |
| 415 | `unsupported-media-type` |
| 500 | 未预期的异常 |

AGENTS.md 的章节是按**位置**寻址的。面板写入时带上用户看到的标题 `expectedTitle`，
文件在外部编辑器里被改过、位置对不上时返回 `section-moved`，面板重新读取，不会改到或删到别的章。

**`session` 参数是必需的，不是可选优化。** 2026-11-01 实测踩到：HTTP 请求没有 agent，
若退回 `workingDirectory.defaultDirectory` 会解析到进程默认目录（profile 目录），
面板读到 0 条记忆却返回 200——错得很安静。所以现在宿主用 `sessionId` 反查会话工作目录，
查不到就明确返回 400，绝不猜一个目录去读或写。

## 安全边界

记忆 id 就是文件名，而 id 会从工具参数、HTTP 请求体里原样进来。以前 `memory_forget {id: "../../../AGENTS"}`
会删掉 `~/.dsh/AGENTS.md`——模型一旦被网页或文件内容提示注入，就能触发。现在：

- `isSafeId`：拒绝路径分隔符、Windows 非法字符（仅 ASCII，全角 `：（）` 可以）、控制字符、首尾空白、结尾的 `.`、`.` / `..`、超过 200 字符
- 每处「id → 路径」再做一次包含性检查：解析结果必须平铺在目标目录里，否则不碰任何文件
- 记忆文件、草稿、`MEMORY.md`、AGENTS.md 一律「写临时文件再 rename」，崩溃不会留下半个文件
  （rename 失败——例如编辑器占着文件——时退回直接写）

## 格式闸门

`validateMemoryPatch` 是 UI 编辑唯一的落盘入口，规则集中在一处：

| 字段 | 规则 |
| - | - |
| `title` | 非空，≤ 200 字符，**不能含换行** |
| `body` | 非空，≤ 20000 字符 |
| `type` | 只能是 `user` / `feedback` / `project` / `reference` |
| `tags` | 字符串数组，≤ 20 个，单个 ≤ 40 字符，不能含换行、英文逗号或 `]` |
| `slug` | 归一化为小写英文 + 数字 + 连字符；含非 ASCII 字符或归一化后不足 2 字符**直接报错**（以前会静默换成 `memory-<时间戳>`） |
| `description` | ≤ 120 字符（它就是索引那一行），**不能含换行** |
| `paths` | 字符串数组，不能含换行 |

换行之所以要拦：frontmatter 一行一个键，`description: x⏎confidence: 0.1` 以前能直接改写「只读」的 confidence，
`x⏎---` 会把后面的元数据挤进正文。
| `confidence` | **只读**。它是模型自评，不是用户判断；经编辑接口传会被明确拒绝 |

未知字段直接忽略；任何一条不合法就**整体拒绝**，并逐字段给出原因，前端原样展示。
落盘永远走 `serializeFrontmatter`，所以 **UI 编辑不会让文件格式漂移**——
手改文件会，UI 改不会。

### 为什么 confidence 不给用户改

模型自评的「我对这条有多大把握」和用户的「这条对不对」是两种东西。让用户去填一个概率，
既没有校准依据，也会让人误以为它是质量指标。

它唯一的用途是**抽取准入**：低于 `minExtractConfidence`（默认 0.6）的候选不写进待确认队列。
而且丢弃**不静默**——`/memory extract` 会报告「候选 N 条 → 入队 a 条、去重 b 条、置信度不足丢弃 c 条」。

模型漏填 confidence 时兜底成 0.6，正好等于默认门槛，即「漏填＝放行」，
避免模型少写一个字段就把整批候选清空。

## 作用域提示：`scope`

记忆里有一个 `scope: global | project` 字段，但它**只是提示，不是路由**：

- 插件**没有全局记忆库**，所有记忆仍然存在当前项目的库下
- `scope: global` 的意思是「这条看起来适用于所有项目」，面板和 `/memory pending` 会标出来，
  提醒你可以把它搬去 `~/.dsh/AGENTS.md`（DSH 每个会话都会加载那个文件）
- **插件不会自动搬动，也不会写你的 AGENTS.md**——那是你手写的文件

为什么这么设计：跨项目偏好和项目内知识的生命周期不同。全局偏好应该由你维护、
长期稳定；而项目记忆会跟着项目演进。混在一个自动管理的库里，两边都会失控。

抽取时由模型判断 scope（判据写在提示词里，宁可判成 `project`），在待确认队列里标出来，
面板里可以改。judgement 不准的时候你一眼能改，比让它猜着自动搬家安全。

### 搬到全局：`POST /promote`

面板上对 `scope: global` 的记忆会出现「搬到 AGENTS.md」按钮。点击后（**先弹确认**）：

1. 往 `~/.dsh/AGENTS.md` 追加一节 `## <标题>` + 正文
2. 从本项目的记忆库里删除这条（`deleteMemory` 会先留历史版本，可回退）

这是插件里**唯一**会写用户手写文件的动作，所以有四道保护：

- 标题已存在 → 返回 `already-present`，**绝不重复追加**（按去掉编号后的标题比较）
- 只追加，不改写任何已有内容；受 `maxAgentsBytes` 约束，写前留档——和面板「新增章」走同一个 `appendAgentsSection`
- 删除走带留档的那条路径
- 只有 `scope: global` 的记忆才允许搬，避免把项目内知识污染成全局规则

> 以前 promote 自己拼字符串写文件：同名检查用的是不带编号的标题（实际标题都带 `N.`，永远匹配不上），
> 也不查字节上限、不留档。现在三道保护都由同一个函数承担。

> AGENTS.md 是**每轮都注入**的。搬太多进去会持续占用上下文，
> 建议只放真正跨项目、且长期稳定的规则。

### 打开 AGENTS.md

面板顶部显示 `AGENTS.md · 体量 / 节数`，旁边是「打开方式」下拉和「打开」按钮：

- 探测顺序：配置 `editorExe` → Windows `App Paths` 注册表 → 常见安装路径
- 目前识别 Typora、VS Code、Cursor，另有「系统默认」兜底
- **不写死某个编辑器**：Typora 常装在非默认盘（本机在 `D:\Program Files`），
  所以注册表优先，而不是猜路径
- 选择结果记在浏览器 `localStorage`，下次沿用

### 交互反馈

`hover` / `active` / `focus-visible` 内联样式写不了，所以 `apply` 里挂一份真实样式表
（`ctx.effect` 注入 `<style>`，卸载时移除）。只定义内联样式没设置的属性
（`transform` / `filter` / `outline`），否则会被内联样式覆盖。

底部操作区用 `.wsm-footer` 分行：元信息可收缩、按钮组 `flex-wrap: nowrap`。
之前窄屏时「取消」和「保存」会被挤成上下两行，就是缺少这条约束。

## 记忆怎么进库：置信度分流

`memory_remember`（模型主动记）**不是无脑入库**，而是按模型自评置信度分流：

| 置信度 | 去向 |
|---|---|
| ≥ `directWriteConfidence`（默认 0.8） | 直接写进记忆库 |
| < 该门槛 | 写进待确认队列，由人在面板里**收下 / 丢弃** |

判据是「模型自己都说没把握的，不该绕过人的判断直接进库」。
`rememberRoute()`（已导出、有测试）就是这个判断，边界含等号。

待确认队列的三个来源：`memory_remember` 低于门槛的写入、手动 `/memory extract`、自动抽取（默认关闭）。

**删除入口**：面板详情底部有「删除」按钮（红色描边，与保存按钮并列），
也可用 `/memory forget <id>`（支持前缀）。两处都走 `deleteMemory`，删除前留历史版本可回退。
之前只有模型能调 `memory_forget` 工具，人删不掉——高置信度直接入库时这个缺口很致命。

## 面板里的两个作用域：本项目记忆库 / 全局 AGENTS.md

面板顶部有「记忆库 | AGENTS.md」切换：

| 作用域 | 数据 | 能做什么 |
|---|---|---|
| 记忆库 | `~/.dsh/projects/<key>/memory/*.md` | 按置信度审核（收下/丢弃）、编辑、删除、搬到 AGENTS.md |
| AGENTS.md | `~/.dsh/AGENTS.md` | 直接改章：编辑标题与正文、增删章、编号自动重排 |

**章节切分规则**：`##` 成章，其下的 `###` 属于该章正文；`#` 一级标题算文档前言、不参与编辑。
所以删一章会连同它的子节一起删，不会留下孤儿标题。

**代码块**：围栏代码（```` ``` ```` / `~~~`）里的 `#` / `## ` 是代码，不参与切章、编号与标题下沉。

**编号**：写入后统一重排为 `## N.` + `### N.M`，删章不留断号；标题里即便带旧编号也会被剥掉重排。
只有 `N.` / `N.M` 这种形态算编号：`### 5 Whys`、`### 2024 roadmap` 原样保留。没改动的章逐字节保留，原文件的换行风格（CRLF/LF）也保留。

**安全**：每次写盘前把原文件复制到 `~/.dsh/.dsh-workspace-memory-history/agents/`（保留最近 20 份）。
超出 `maxAgentsBytes` 时拒写，但**让文件变小的编辑始终允许**——否则超限之后连删一章都删不掉。

**做不到的**：DSH 的指令加载器（`@deepseek-ai/dsh-agent-instructions`）不对外暴露服务，
所以**无法权威判断**某个文件是否被字节预算截断——面板只能显示文件大小。

## 记忆写入哪一边：`scope` 参数

`memory_remember` 有 `scope`（默认 `project`）：

| `scope` | 去向 | 注入范围 |
|---|---|---|
| `project` | `~/.dsh/projects/<key>/memory/` | 只在本工作区 |
| `global` | `~/.dsh/AGENTS.md` 的一章 | **所有项目**，每轮注入 |

`global` 先按标题精确匹配：同名就更新那一章；**不匹配时不会自动追加**，
必须先由调用方确认——见下面的「语义重复」。
置信度低于 `directWriteConfidence`（默认 0.8）时仍先进待确认队列；
收下时按草稿记录的 scope 落到对应位置。

### 语义重复：不自动判断，强制确认

同一个主题换个说法，字面相似度会落在很宽的区间。实测（以本机 11 章标题为基准）：

| 新写法 | 相似度 |
|---|---|
| 换语序 | 0.90 |
| 缩短 | 0.47 |
| 口语化 | 0.23 |
| 换词 | 0.24 |
| **不相关（假阳性）** | **0.35** |

真重复 0.23–0.90、假重复 0.35，**区间重叠**——任何阈值都会两边出错，所以不做自动合并，
改为在协议上**逼出判断**：

| 调用 | 行为 |
|---|---|
| `chapter: N` | 覆盖第 N 章（新旧内容由调用方自己合并） |
| 标题精确同名 | 更新那一章 |
| `newChapter: true` | 显式声明新主题，追加 |
| 以上都不满足 | **拒写**，返回现有章标题清单 |

### 内容怎么放：常驻区只放指针（渐进式加载）

AGENTS.md **每轮请求都会注入**，它不是存储而是常驻成本。所以按「读到它的代价」分层：

| 层 | 放什么 | 何时进入上下文 |
|---|---|---|
| **AGENTS.md** | 跨项目铁律 + 「细节见 X」的指针 | 每轮 |
| 项目 README / HANDOFF | 实现细节、操作步骤、事故经过 | 任务相关时按需读 |
| 项目记忆库 | 本项目决策与踩坑 | `memory_recall` 命中时 |
| 不记 | 能从代码一眼推出的一次性信息 | 永不 |

**准入五条**（同时满足才进 AGENTS.md）：

1. 跨项目成立
2. 不能从代码/文档一眼推出
3. 违反后果不可逆或代价大
4. 能写成动作（做 X / 不做 Y），不是「要注意」
5. 已发生 ≥2 次，或单次代价极高

**硬约束**：`maxAgentsBytes`（默认 10000）。超了**拒写**并报当前字节与上限，
逼着先合并或删除——否则「记一条教训」的边际成本看起来是 0，实际每轮都在付费。

## 记忆库的查重与覆盖（`supersedes` / `newMemory`）

项目记忆只在 slug 相同时覆盖，slug 不同就并存。于是「本地脚本是兜底」和
「本地脚本已关闭」会同时躺在库里——**召回读到哪条全看分数，比没有记忆更糟**。

所以 `memory_remember` 写入前会查重（复用检索的打分，但**不计 hits**）：

| 情况 | 行为 |
|---|---|
| 库里没有相近条目 | 直接写入 |
| 有候选 ≥ `duplicateThreshold`（默认 0.62） | **拒写**，返回候选清单与分数 |
| 传 `supersedes: "<id>"` | 覆盖那条：旧正文归档到 `history/`，新条目记 `supersedes: <旧 id>` |
| `supersedes` 且新 slug 与旧 id 相同 | **原地更新**：旧版进 `history/`，保留 `created` / `hits`，不再生成 `-2` 副本 |
| `supersedes` 是多条记忆的共同前缀 | **拒写**并列出候选（以前静默取最近一条删掉） |
| 低置信度 + `supersedes` | 草稿里记下 `supersedes`，收下时才执行取代 |
| 传 `newMemory: true` | 确认是独立的一条，照常写入 |

不做自动合并的理由和 AGENTS.md 那套一样：语义重复判断不准。
`duplicateCheck: false` 可整体关闭。

## `paths` 触发提示：按文件把记忆带到眼前

写入时标注的 `paths` 以前是纯摆设——写的时候能标，读的时候没人看，
「什么时候该 recall」只能靠模型自己想起来。

现在读/改到命中 `paths` 的文件时，工具结果末尾会多一行：

```
[记忆] 这个文件有相关记忆（需要细节时调 memory_recall）：
- no-explanatory-text-in-ui — 界面里不要自行添加解释性文字
```

三条克制：

| 约束 | 原因 |
|---|---|
| 只给 id + 标题，**不给正文** | 正文一附上，每次读文件都在付 token 税；要看细节调 `memory_recall` |
| 同一轮同一条**只提示一次** | 读 10 个文件不该重复喊同一句话 |
| 异常/不命中一律放行原结果 | 提示是锦上添花，不能拖垮工具调用 |

匹配规则（按路径**段**比较，不做子串匹配）：

- 相对工作区根书写，判据是「真实路径的末尾若干段与模式逐段相符」，所以绝对路径也能命中
- `*` 只在一段之内通配；`**` 匹配零到多段
- 目录形式（`foo/`）匹配其下所有文件；`src/` 不会再命中 `mysrc/`
- 只写文件名（`client.js`）时匹配任意目录下的同名文件
- Windows 上不分大小写
- 花括号展开（`*.{ts,tsx}`）不支持

实现走宿主的 `tools/post-execute` waterfall（可 enrich 工具结果），
只在工具参数里的 `file_path` / `path` 等字段上判断——不猜、不做语义检索。
`pathsHint: false` 可关闭。

## 体量与条数预算：成本发生在哪，就在哪设限

| 成本 | 什么时候付 | 策略 |
|---|---|---|
| **条数**（`MEMORY.md` 索引每轮注入，一条一行摘要） | **每轮请求** | `maxMemoryCount`（默认 50）**硬限**，满了拒写 |
| **单条正文长度** | 只在 `memory_recall` 命中的那一次 | `warnBodyChars`（默认 2000）**只提醒，不拦不截** |
| **一次召回的总体积** | 特定调用 | `recallMaxChars`（默认 12000）收敛「返回几条」 |

**为什么不截断长正文**：正文不是每轮成本，只在真正召回到它时才进上下文。
内容确实需要长，就该长——截断等于直接丢信息。所以超阈值只是提醒
「可以考虑拆成 2-3 条原子记忆」，存进去的和传进去的一模一样。

**库满时拒写的返回**里带淘汰候选，按「hits 最少、最久没读」排序——这是现有数据里
最接近「该删」的信号。提示里给两条出路：`supersedes: "<id>"` 合并进去，
或先删一条；确实都值得留就调高 `maxMemoryCount`。

## 依赖解析

插件以 link 方式装进 profile 时，Node 会按真实路径（工作区目录）解析依赖，看不到 profile 的 `node_modules`。

`leanvec`（向量检索，可选）走**三级**解析：

1. 常规模块解析
2. **插件自有依赖目录** `~/.dsh/dsh-workspace-memory-deps/node_modules/leanvec`
3. `~/.dsh/profiles/<name>/node_modules/leanvec`

三级都找不到就降级为纯关键词检索——这是设计内的正常分支，不是故障。

**为什么需要第 2 级**：`leanvec` 曾声明在本插件的 `optionalDependencies` 里，但 pnpm **不保证为 link 目标安装依赖**，
用户下一次 `pnpm install` 就把它剪掉了，向量检索**静默退化**成纯关键词（实测发生过一次）。
自有依赖目录不受 profile 依赖图影响，用 npm 装：

```bash
node scripts/install-deps.mjs   # 一次性，约 85 MB，装到 ~/.dsh/dsh-workspace-memory-deps
```

装完重载一次插件即可切到向量模式。`memory_status` 会显示当前是 `hybrid` 还是 `keyword`。

## 召回质量怎么衡量：金标集 + 负样本

`eval/golden/` 放语料与查询集，`eval/golden.mjs` 跑分，`test/golden.test.mjs` 把门槛写进 CI。

| 指标 | 含义 | 当前基线 |
|---|---|---|
| recall@1 | 第一条就命中期望记忆 | 70% |
| recall@3 | top-3 内命中 | 90% |
| MRR | 命中排名的倒数均值 | 0.80 |
| **负样本误召** | **库里没有答案时，返回了东西的比例** | **0%** |

负样本是最容易被忽略的一半：只测正样本的话，「随便返回点什么」也能拿高分。
本插件最初的判据是「向量分或关键词分过线就入选」，实测负样本误召 **100%**——
leanvec 是静态嵌入，任意文本余弦都容易过 0.3，等于没有闸门。因此引入了融合分闸门
`minScore`（默认 0.34，由 `eval/sweep-min-score.mjs` 扫出来）。

阈值是**在 18 条样本上**调的，且 0.33→0.34 之间误召从 13% 直接跳到 0%，
是个陡崖。真实语料变大后应重跑扫描再定，不要把它当成普适常数。

`eval/run.mjs` 量的是**抽取准入**（该不该记，要调模型，手动跑）；
这里量的是**召回**（记下的能不能找回来，纯本地，可进 CI）。两者不能混为一谈。

## 什么时候触发召回：三个触发点

「记下来」只是第一步，能不能在**该想起来的时候想起来**才是关键。本插件有三个触发点：

| 触发点 | 实现 | 给什么 |
|---|---|---|
| **每轮固定** | `system-prompt/context` 注入 `MEMORY.md` 索引 | 全部条目的「一行摘要」 |
| **碰到文件** | `tools/post-execute` 比对 `paths` | 命中文件的 id + 标题 |
| **用户发消息** | `agent/pre-step` 里预取 | 与本轮请求最接近的 3 条 id + 标题 |

后两个都只给 id 与标题，正文一律要 `memory_recall` 取——这是渐进式加载的底线。

**预取为什么绕这么一圈**：注入用的 `context.text` 是**同步**的，拿不到用户消息；
而 `agent/pre-step` 是 async waterfall 且带 `messages`。所以在 pre-step 里 `await` 一次
真正的 recall（用的就是金标集标定过的 `minScore`），把结果缓存起来，注入时只读缓存。
**不往 messages 里塞合成消息**——那会污染对话记录。

预取在回合结束时清空，不会让上一轮的相关记忆污染下一轮。`prefetchRecall: false` 可关闭。

## 什么值得记：判据写在工具描述里

「该不该记」没法用代码判定，硬拦会误伤——"改成 X" 有时确实是长期约定。
所以判据放在 `memory_remember` 的 **description** 里：它随工具 schema 进入上下文，
不额外占注入预算，正好是模型做决定的地方。

**五条准入**（全过才记）：

1. 这个任务结束后仍然成立（任务指令不算）
2. 不能从代码 / git 历史 / 文档推出
3. 违反的代价大（返工、数据丢失、发布事故），不只是不优雅
4. 能写成动作（做 X / 不做 Y），不是感受
5. 已发生 ≥2 次，或单次代价极高

**不记**：任务指令、状态（"我在做 X"）、diff 里能看到的、明天就可能被推翻的决定。

**写入时机**：用户显式要求或**纠正**（最强信号）时立即写；强结论在**任务结束**时写，
不在中途——中途的决定经常被推翻。

**更新时机**：用户改主意就传 `supersedes`，不要让两条互相矛盾的记忆并存。

**代码护栏**（确定性的部分）：`paths` 写得不像路径（如 `"插件配置"`、URL）时，
写入结果会点名并给出正确写法——否则那个字段永远静默失效。

## 测试

```bash
npm test                        # 全部（node --test 自动发现 test/ 下的文件）
node test/recall.test.mjs       # 单个文件；每个测试都是独立脚本，失败时退出码为 1
```

测试文件统一用 `*.test.mjs` 后缀，`test/fake-host.mjs` 是路由/工具测试共用的假宿主。**别只挑几个跑**：曾经因为冒烟测试叫 `smoke.mjs`、
循环里拼成 `smoke.test.mjs`，被误判成「PowerShell 退出码不可靠」查了三次。

所有测试只在临时目录里读写。涉及 AGENTS.md 的测试必须经 `apply(ctx, { agentsFile: 临时路径 })` 传配置，
并前后比对真实 `~/.dsh/AGENTS.md`（见 `test/scope-routing.test.mjs`）。

## 配置

所有可调项都写在插件行的 `config` 里，改完重载插件生效。

**没有声明 `export const Config`**（那需要 `@deepseek-ai/schemastery`，对 link 安装的插件未必能解析到），所以 Settings 面板不会渲染成表单，但值会生效并被校验；校验问题通过 `memory_status` 暴露。

```yaml
- id: dsh-workspace-memory
  name: dsh-workspace-memory
  config:
    enableExtraction: true      # 打开回合收尾自动抽取
    extractEveryTurns: 5        # 每 5 回合抽一次
    minVectorScore: 0.35        # 调严召回门槛
```

| 键 | 默认 | 说明 |
| - | - | - |
| `memoryDir` | `''` | 空 = `~/.dsh/projects/<编码后的工作区路径>/memory/`；非空必须是绝对路径或 `~/` 开头 |
| `indexMaxLines` / `indexMaxBytes` | 200 / 25KB | 注入上限 |
| `weightVector` / `weightKeyword` | 0.65 / 0.35 | 融合权重 |
| `minScore` | 0.34 | 融合分闸门（金标集标定，见「召回质量」） |
| `minVectorScore` / `minKeywordScore` | 0.3 / 0.5 | 前置筛（任一达标才进入融合打分） |
| `recallMaxChars` | 12000 | 一次召回的正文总预算（少带一条，不截断正文） |
| `maxTitleChars` / `maxBodyChars` | 200 / 20000 | 格式闸门 |
| `maxTags` / `maxTagChars` | 20 / 40 | 格式闸门 |
| `maxMemoryCount` | 50 | 条数硬限，满了拒写；`0` = 不限 |
| `warnBodyChars` | 2000 | 单条正文的提醒阈值（不拦不截） |
| `directWriteConfidence` | 0.8 | `memory_remember` 置信度 ≥ 它直写，否则进待确认 |
| `duplicateCheck` / `duplicateThreshold` / `duplicateCandidates` | `true` / 0.62 / 3 | 写入前查重 |
| `pathsHint` / `pathsHintLimit` | `true` / 3 | 碰到文件时的记忆提示 |
| `prefetchRecall` / `prefetchLimit` | `true` / 3 | 用户消息预取 |
| `enableExtraction` | `false` | 回合收尾自动抽取 |
| `extractEveryTurns` | 5 | 抽取节流 |
| `extractMaxPerTurn` | 3 | 单次最多入队几条 |
| `dedupeThreshold` | 0.9 | 与已有记忆/待确认条目的余弦相似度超过它就不入队 |
| `minExtractConfidence` | 0.6 | 抽取准入的置信度门槛，低于它的候选不入队 |
| `historyLimit` | 20 | 每条记忆保留多少个历史版本；`0` = 不留档 |
| `agentsFile` | `''` | 空 = `~/.dsh/AGENTS.md` |
| `maxAgentsBytes` | 10000 | AGENTS.md 字节上限，超了拒写（缩小的编辑始终允许）；`0` = 不限 |
| `editorExe` | `''` | 打开 AGENTS.md 用的编辑器；空 = 自动探测 |

坏值**不会抛异常**：退回默认值并记录 issue（`memory_status` 可见）。一个配置笔误不该让整个记忆系统不加载。
`enableDiagEndpoint` 已移除（诊断端点随客户端回执一起删掉了），旧配置里留着它只会被当作未知键忽略。

## 历史版本与命中计数

记忆是**纯 Markdown、没有 git 兜底**，改错一次就永久丢失。为此：

- **覆盖或删除前留档**到 `.memory-state/history/<slug>/<时间戳>.md`，只保留最近 `historyLimit` 版
- 只有**实质内容变化**才留档——`modified` / `hits` / `lastHit` 每次都会变，先剔除再比较，
  否则历史会变成一堆没意义的版本
- 回退方式很直接：把历史文件拷回 `memory/<slug>.md`，再 `/memory reindex`

**命中计数**：被 `memory_recall` 召回的条目会在 frontmatter 里累加 `hits` 并写 `lastHit`。

- **只改这两行**，文件其余部分逐字节不动（以前整份重写，手写的 YAML 块列表、注释会丢，每次还多一个空行）
- 计数器**不重建 MEMORY.md**（命中不进索引），也**不留历史**（属于元数据抖动）
- 只对**真正返回给调用方**的条目计数，未命中的不涨
- `modified` 不会被命中改动——语义内容没变

它的用途是回答「哪些记忆该淘汰」：长期 `hits = 0` 或 `lastHit` 很久以前的条目，
就是候选。没有这个信号，记忆只会越攒越多。

## 自动抽取与待确认队列

抽取挂在 `agent/turn-stopping`——官方为「回合即将结束」留的 serial 座位，每回合都触发。

> **为什么不是「压缩前」**：本 profile 的 `compaction-basic` 是 `inactive`，没有压缩实现，
> 「压缩前触发」永远不会发生；事件目录里也没有「压缩前」这个位。
> 这是实测后从原方案改过来的。

```
agent/turn-stopping（serial，会被 await）
  → 每 N 回合才真跑（默认 5）            成本闸门
  → 取本轮 user/assistant 文本            工具结果不取：费 token 且几无价值
  → ctx.llm.stream 用会话当前路由的模型    不额外配 provider
  → parseExtractionJson                  容忍 ```json 围栏与前后闲聊
  → 向量去重                              与 confirmed + pending 一起比
  → 写入 pending/<id>.md，status: draft
```

**默认关闭**。它会给每回合加一次模型调用，而且这个监听会被 `await`。任何环节失败都只记录、不冒泡——抽取是旁路，永远不许影响主对话。

`pending/` 里的条目**不注入、不参与检索、不进 MEMORY.md**，只有 accept 之后才搬进正式库。

- 草稿 id 是 `dr_<时间>_<随机后缀>`：同一批候选在同一毫秒落盘时，只用时间戳会互相覆盖
- 模型回复里候选正文带代码围栏、或前后夹着闲聊，都能正确解析；回复被截断时返回空，不猜
- 抽取流有 60 秒墙钟上限，模型卡住时不会拖住回合收尾
- 收下时受 `maxMemoryCount` 约束（取代旧条除外），满了返回 `library-full`，草稿留在队列里

## 许可

MIT
