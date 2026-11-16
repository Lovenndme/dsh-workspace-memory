# 记忆面板设计（2026-11-15 重设计）

> 右侧栏「记忆」面板的设计依据与接口约定。视觉与交互以 [`preview/panel.html`](../preview/panel.html)（用户确认过的静态预览）为准，实现以 `client.js` / `index.js` 为准；三者与本文冲突时以代码为准，并回来修正本文。
> 旧面板（「记忆库 | AGENTS.md」两个页签）的设计记录在 [DESIGN.md](DESIGN.md)，已被本文取代。

## 1. 为什么重做

旧面板顶层是「记忆库 / AGENTS.md」——这是**存储方式的名字**，不是用户关心的问题。用户想知道的是：

1. Agent 现在记得我什么？在哪儿生效？什么时候会用上？
2. 有没有等我拍板的东西？为什么要我拍板？
3. 某一条想改 / 删 / 挪地方，怎么改，改完会发生什么？

插件内部的模型本来就是两个正交问题：**在哪儿生效**（所有项目 / 本项目，即 `scope`）和**什么时候读**（每轮都读 / 用到才查，即 `load`）。新面板把这两个问题直接摆成一张 2×2 的「记忆地图」。

旧面板的具体问题（重做前盘点，编号沿用）：草稿「收下后去哪」要用户从禁用的下拉里自己拼（U1/U8/U9）；同一个库有三种叫法、「AGENTS.md」不说是全局的（U2/U3）；工作区名显示成编码后的目录名（U4）；两个库混在一个列表里、上限按库算却显示合计（U5/U18）；列表按文件时间排序，召回命中会让条目跳动（U6）；「未核实」有两种含义（U7）；丢弃草稿不确认也不可恢复，确认框承诺了不存在的「可回退」（U11/U12）；改适用范围其实是搬文件但界面不说（U14）。

## 2. 命名（全面板只有一种叫法）

| 概念 | 界面叫法 | 一句话解释 |
|---|---|---|
| 全局 `~/.dsh/AGENTS.md` | **全局指令** | 每一轮都会发给 Agent，在所有项目里生效 |
| 项目 `AGENTS.md` | **项目指令 · 团队** | 进 git，进这个仓库的人和 Agent 都要守 |
| `AGENTS.local.md` | **项目指令 · 仅你** | 不进 git，只对你成立 |
| 跨项目记忆库 | **通用记忆** | Agent 用到时才去查，所有项目都能查到 |
| 项目记忆库 | **项目记忆** | Agent 用到时才去查，只在本项目 |
| 待确认 | **待你确认** | 写进去之前要你点头的草稿 |
| type | `user` 关于你 / `feedback` 做事要求 / `project` 项目决定 / `reference` 资料位置 / `pitfall` 踩坑经验 | 新名说内容是什么，旧名（用户偏好 / 纠正反馈 / 项目决策 / 参考索引）说的是来历 |
| 来源 | 你的原话 · 已核对 / 说是你的原话 · 没核对上 / 你的原话 · 旧条目未核对 / Agent 总结 | 分别对应 `evidenceVerified` 为 true / false / 缺键，以及 `source:'agent'` |
| 「写入 AGENTS.md」 | **升为全局指令** | 两个库的条目都可以 |
| 章 | 一律叫「章」，不叫「节」 | |

工作区显示为友好名（路径最后一段），完整路径放悬停提示。面板内不再出现「DeepSeek Harness」品牌字样。

**只改给人看的文字。** 系统提示段、工具描述与参数说明、工具返回给模型的文字、`MEMORY.md` 索引格式都经过模型评测，仍用旧说法；`test/command-labels.test.mjs` 断言这些地方不出现面板叫法。

## 3. 信息架构

顶部导航：**总览 · 待确认 (n) · 指令 · 记忆**，右侧刷新与专注模式。

- **总览**：待确认横幅；记忆地图（列「每轮都读 / 用到才查」× 行「所有项目 / 本项目」，四格各带数量、预算或上限、最近更新，点击跳到对应页面）；每轮固定开销（全局指令 + 项目指令 + 记忆索引的堆叠条，「约 N tokens」按字节粗估）；最近变化；可能过时（60 天没被用过，或从未被用过且创建超过 30 天）；可折叠的「Agent 怎么决定记到哪」流程图。
- **待确认**：卡片流。每张卡顶部一句完整去向（如「→ 全局指令 · 覆盖第 2 章「沟通与输出」」，章号注明是入队时的位置）和「为什么要你确认」；覆盖章节或替换旧记忆时给新旧对比；证据原话做成引用卡；常驻草稿注明「只有标题和正文会写进全局指令」；丢弃二次确认；快捷键 J/K/A/D 只作用于焦点所在的卡片。
- **指令**：「全局 | 本项目」分段。全局：预算条、用编辑器打开、只读前言、目录、按章就地编辑（编号单独显示）、新增与删除章；文件不存在时有专门空状态和「新建」。本项目：团队 / 仅你两张只读卡。
- **记忆**：搜索、范围分段（全部 / 本项目 / 所有项目）、按库显示上限、类型筛选；列表按 `modified` 倒序；详情是文档式（标题与摘要就地编辑、属性区、正文编辑 / 预览）；改适用范围就地说明会移库；`user` / `feedback` 选「所有项目」时引导升为全局指令；只有改动过才出现保存条。

断点按面板宽度：<560 单栏推入，560–899 紧凑分栏，≥900 分栏；右侧栏最小 300px，不能出现横向滚动。

## 4. 宿主视觉约束（来自 DSH 安装包，2026-11-15 核对）

- 颜色只用 `--dsw-alias-*`。`brand-primary` 在浅色是近黑、深色是近白，是主按钮色，**不是蓝色**；蓝色提示用 `state-business-primary`，克制使用。
- 浅色主题下 `bg-base` 与 `bg-layer-1/2/3` 都是白色，层次靠 0.5px 发丝线与填充区分。
- 宿主**没有** `--dsw-alias-bg-canvas`、`--dsw-alias-bg-layer-4`、`--dsw-font-mono`，不要用。
- 宿主 token 声明在 `body` 上，深色是 `body[data-ds-dark-theme]`；组件 CSS 只引用变量，不依赖主题选择器。
- 列表行照插件管理页：行间距 2px 无分隔线，hover 面左右外扩 8px、圆角 20，标题 14/20 500，描述 13/18 单行。图标是自绘线性 SVG：viewBox 16，描边 1 / 1.3。
- 不往 `document.body` 追加 DOM：tooltip、菜单、对话框都渲染在面板根节点内。

## 5. 接口：新增与变更

前缀 `/api/dsh-workspace-memory`。共用约定（405 / 415 / 413、`?session=`、失败信封、`REASON_STATUS`）不变；既有字段只增不改。

| # | 接口 | 约定 |
|---|---|---|
| A | `GET /project-agents?session=`（新增） | 只读返回 `{ok, workspace:{path,name}, root:{path,name}, team:FileInfo, local:FileInfo}`。文件所在目录是宿主实际加载项目指令的根 `instructionsRootFor(cwd)`（往上最近的 `.git`，没有就是 cwd），`workspace` 与 `/list` 一致（已注册工作区）。只认 `AGENTS.md`、`AGENTS.local.md` 两个固定文件名，不接受客户端路径；根与文件都取 realpath，逃出根当作不存在。`body` 上限 64 KiB（按字符边界截断，`truncated`），`bytes` 是真实大小。是目录时 `exists:true` 加中文 `error` |
| B | `GET /list` | 增加 `workspace:{path,name}`、`limits:{maxMemoryCount,maxTitleChars,maxDescriptionChars,maxBodyChars,maxTags,maxTagChars}`（宿主实际生效的值）、`historyDir:{project,global}`、`pending[].slug`（经 `asciiSlug`，与收下后的文件名一致，撞名加 `-2` 除外）。`memories[].promotable` 对已确认条目一律 true |
| C | `GET /agents`、`/agents/sections` | 增加 `limit`（`maxAgentsBytes`）、`mtime`、`historyLimit`（20）、`historyDir`；`agents-missing` 也带 |
| D | `POST /promote` | 项目库条目不再返回 `scope-not-global`，与通用记忆走同一逻辑：追加新章 → 成功后归档并删除来源条目；响应加 `fromScope`。写章失败来源不动；删除来源失败返回 `ok:true, memoryRemoved:false, removeError` |
| E | `POST /open-agents` | 可选 `target:'global'|'team'|'local'`（缺省 global，行为不变）；team / local 需要 session，与 A 同一套校验；文件不存在 400 `file-missing`；非字符串或未知 target 400 `invalid-target` |
| F | `POST /agents/create`（新增） | 全局 AGENTS.md 不存在时独占创建，内容一行 `# AGENTS.md`；任何已有目录项（含悬空链接）返回 409 `already-exists` |
| G | 斜杠命令输出 | `/memory`、`list`、`pending`、`accept`、`forget`、`reindex`、`extract`、`/memory_list` 的回执与 `/memory_list` 的命令描述统一用 §2 的叫法；两库分开计数。2026-11-15 第二轮（HANDOFF 第二十八节）：`/memory` 总览按 §3 记忆地图排——第一行「记忆总览 · 工作区名」，接着待确认，再「每轮都读」（全局指令 N 章 · 已用 / 上限 KB；项目指令 团队 / 仅你）与「用到才查」（通用记忆、项目记忆：条数 / 上限 + 按类型计数），「每轮固定开销约 N tokens」与总览页同一算法（全局指令 + 团队 + 仅你 + 索引估算，字节 ÷ 3.5；测试拿两边对拍），不出现本机路径与配置键名；诊断细节移到新增的 `/memory status`；新增 `/memory help`（常用 / 需要 id / 整理三组）与未知子命令的「你是不是想输入」；`pending` 每条两行（`N. [类型] 标题` + `→ 去向 · 来源 · id`）；`list` 带相对更新时间、单库最多 30 条；`forget` 只说旧版留在 `.memory-state/history/<id>/`。输入提示 `pending 待确认 · extract 抽取 · list 全部 · help 更多`；只敲 `/memory` 时客户端弹子命令选单（`commandUi.decorate`）；命令卡下加「打开记忆面板」/「去面板处理」按钮 |

新原因码：`file-missing`（400）、`already-exists`（409）、`invalid-target`（400，经 RequestError）。客户端按原因码处理，不看状态码。

**Windows 打开文件不让 cmd 解释路径**（审查发现的命令注入，已修）：系统默认与 `.cmd` 编辑器都走 `cmd /d /s /c "<inner>"` + `windowsVerbatimArguments`，路径放在内层双引号里；含 `%` 或 `"` 的路径直接拒绝（`launch-failed`）。目录名 `p&ver&echo` 一类已用真实参数形态重放验证不再执行命令。

## 6. 用户拍板（2026-11-15）

1. type 改名（§2）。
2. 「指令 · 本项目」只读展示项目的 AGENTS.md 与 AGENTS.local.md（接口 A）。
3. 项目记忆可以一步升为全局指令（接口 D）。

## 7. 验证

- 静态预览：`preview/panel.html`（单文件，内联示例数据与宿主真实 token；顶部预览控制条切浅色 / 深色、宽度、数据状态）。
- 真实组件：`preview/verification/render-harness.html` 用迷你运行时（或 `?react=<url>` 换真 React）挂载 `client.js`，fetch 读 `fixture.json`；`?data=` 切状态。截图在 `preview/verification/*.png`（浅色 340 / 960 各页 + 深色）。
- 两轮独立只读审查（宿主半、客户端各一轮，均带复现脚本），问题与修复记在 HANDOFF 第二十六节。
- 没在真实 DSH 里跑过之前，不算验收完成：对插件 disable → enable，确认 `application` 为 `applied`、无 diagnostic，再点一遍四个页面。
