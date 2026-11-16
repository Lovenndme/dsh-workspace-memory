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
| G | 斜杠命令输出 | `/memory`、`list`、`pending`、`accept`、`forget`、`reindex`、`extract`、`/memory_list` 的回执与 `/memory_list` 的命令描述统一用 §2 的叫法；两库分开计数 |

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
- 「开始」页入口：`render-harness.html?view=guide` 是「开始」页仿真（见 §8.2），`checks/06-start-entry.check.js` 断言登记与点击；仿真不等于真实宿主。

## 8. 如何打开面板、前端加载注意事项（2026-11-16）

以下源码路径都在 DSH 安装包 `resources\app.asar` 的 `dsh/node_modules/@deepseek-ai/<包>/` 下（2026-11-16 按 Electron 44.7.0 那一版核对；asar 里带 `src/`，可以用任意 asar 读取脚本抽出来看）。

### 8.1 三个入口

1. 右侧栏「开始」页（没有打开任何页签时右侧栏显示的那一页）上的「记忆」一行。
2. `/memory_list` 命令卡：命令刚执行完时自动打开；卡上的「打开记忆面板」按钮随时可点。
3. 已经打开过的「记忆」页签。

三者打开的是同一个页签类型（kind `memory-list`，定义 id `dsh-workspace-memory/list`，面板本体在 `sidebar.right.pane.tab` 下按这个 id 注册）。

### 8.2 「开始」页入口的机制

- **入口从哪来**：`dsh-client-ui-sidebar-right` 的 `src/client/tab-registry.ts`。页签类型定义 `SidebarRightTabDefinition` 有可选字段 `guide: SidebarRightGuideEntry[]`，每项是 `{ id, order, title(), description?(), icon?, commandId? }`；注册表的 `guide()` 把所有生效类型的入口摊平、按 `order` 升序排好，「开始」页就画这份列表。插件不需要（也不应该）自己往「开始」页里塞 DOM，只要在 `sidebarRightTabs.register()` 的定义里带上 `guide`。
- **怎么画、点了做什么**：`src/client/tabs/guide/GuideBody.tsx`。每个入口画成一个胶囊（图标 + 标题，入口不超过 4 个时才显示说明行，图标尺寸 22，带说明时 26）；点击是宿主自己的 `tab.actions.openTab(kind, { replaceTab: true })`，然后关掉「开始」页——也就是按 kind 打开我们的页签，和 `/memory_list` 卡上 `sidebarRight.openTab('memory-list')` 是同一条路。图标格的颜色是宿主给的 `var(--dsw-alias-label-secondary)`（`GuideBody.module.css` 的 `.entryIcon`），所以图标用 `currentColor`、不写颜色。
- **「更多工具」永远在最后**：同一个文件里，「更多工具」卡在所有入口之后单独渲染（`sidebar.right.tab.guide.actions` 有注册时才出现），所以**没法排到它下面**；我们取 `order: 70`（内置：工作区文件 10、代码审查和变更 15、新建终端 20、浏览器 30、会话数据诊断 60），落在「更多工具」正上方。
- **用户可以隐藏它**：「更多工具」菜单（`dsh-client-ui-entry-customization`）列出所有入口并能取消固定；固定状态只存在内存里（`guide-pins.ts`，默认全部显示）。
- **实现**：`client.js` 的 `memoryTabDefinition()`（定义 + `guide: [{ id: 'open', order: 70, title, description, icon: MemoryGuideIcon }]`），文案键 `guide.title` / `guide.description`（ZH「记忆」/ EN「Memory」）。图标是自绘线性 SVG：viewBox 16，描边 22px 及以上为 1、更小为 1.3，两张叠放的卡片加两行正文（与 `icon.svg` 同一个意象）。没有快捷键（不声明 `commandId`）。不认识 `guide` 的旧宿主忽略这个字段。插件释放时页签定义随 `ctx.effect` 撤回，入口一起消失。
- **没用到的口子**：`sidebar.right.tab.guide.entry` 是按 provider 的 keyed 槽位，可以整个替换入口的渲染（终端插件用它做 shell 选择）；记忆入口只要默认胶囊，没有注册。
- **只在仿真里验证过**：`preview/verification/render-harness.html?view=guide` 照 `GuideBody` 的排法画了一份「开始」页（内置入口是写死的仿制品，只有「记忆」一行来自 `client.js` 的真实登记），`checks/06-start-entry.check.js` 断言登记、位置、图标与点击后发出的 `openTab`。**未在真实 DSH 验证**。

### 8.3 前端没生效：2026-11-16 的排查结论

**现象**：disable → enable 后宿主半是新的（`/memory_list` 回执是新文字），但 `/memory_list` 的结果是宿主默认的可折叠命令卡，右侧栏没有「记忆」页签。

**原因**：包名在 `a4eeb52`（2026-11-15，发布到 npm）从 `dsh-workspace-memory` 改成了 `@lovenndme/dsh-workspace-memory`，`cordis.patch.yml` 的行名跟着改了，但 `client.js` 还在用 `window.__ModuleLoader__.load({ id: 'dsh-workspace-memory', … })` 注册。宿主的规则（`dsh-client-modules`）：

1. `src/index.ts` 的 `resolveMeta` → `locatePkgJson` → `nearestPackage`：浏览器行的 id **取 package.json 的 `name`**；而且 profile 行写的是裸包名时，只认 `name` 与之完全相同的 package.json，对不上就当「不是客户端行」——**静默跳过，不报错**，浏览器根本不去取 `client.js`。
2. `src/client/system.ts` 的 `arrive()`：浏览器载入 `plugins/??<包名>/client.js&rev=…` 后，等的是 `id === 包名` 的 factory；`client.js` 用别的 id 注册时报 `could not load "<包名>": … loaded without registering "<包名>" via __ModuleLoader__.load`（单资源地址重试时还会多一条 `duplicate factory registration`），这一行记为页面同步失败，插件条目根本没创建——命令卡、页签、面板一个都不会注册。
3. 于是 `dsh-client-ui-chat` 的 `CommandNodeView.tsx` 在 `conversation.chat.commandview` 下按命令名找不到注册，渲染 `fallback` 即 `GenericCommandCard`（默认的可折叠卡）。对照：注册了但渲染时抛错的卡片不会回落成默认卡，而是一个空的 `data-slot-error` 格子（`dsh-client-ui-renderer` 的 `scoped-slots.tsx`）。所以「看到默认卡」= 「根本没注册」，不是组件崩了。

**复现**（用安装包里真实的 `dsh-client-modules` 宿主半 `lib/index.js` 与浏览器半 `lib/client.js`，在 Node 里组图、取 bundle、物化；只把 cordis 的 `Service` 基类换成桩，Loader 的解析假定这一行能被宿主解析）：

| profile 行名 | package.json name | client.js id | 结果 |
|---|---|---|---|
| `dsh-workspace-memory` | `dsh-workspace-memory`（改名前） | `dsh-workspace-memory` | 成功，`apply` 可用（对照组：新面板代码本身没问题） |
| `@lovenndme/dsh-workspace-memory` | `@lovenndme/dsh-workspace-memory` | `dsh-workspace-memory`（修复前） | `could not load … loaded without registering` |
| `dsh-workspace-memory` | `@lovenndme/dsh-workspace-memory` | 任意 | 宿主组不出客户端行（`__DSH_BOOT__.entries` 里没有它），静默 |
| `@lovenndme/dsh-workspace-memory` | `@lovenndme/dsh-workspace-memory` | `@lovenndme/dsh-workspace-memory`（修复后） | 成功 |

**修复**：`client.js` 的模块 id 改成 `@lovenndme/dsh-workspace-memory`；`test/client-logic.test.mjs`「模块身份」一节断言 `client.js` 的 id、`package.json` 的 name、`cordis.patch.yml` 的行名三者相同。**以后改包名，三处一起改。**

**改名的另一个后果（需要用户自查 profile）**：`cordis-plugin-include` 的 `src/patch.ts` 在应用覆盖项时，覆盖项写了 `name` 且与插入行的 `name` 不同就整条跳过（日志 `patch: name mismatch for … skipping`）。profile 自己的 `cordis.patch.yml` 里如果还有 `- id: dsh-workspace-memory` + `name: dsh-workspace-memory` + `config: …` 这样的覆盖项，改名之后它不再生效，插件回到默认配置（例如 `agentWrites`、`enableExtraction`）。把覆盖项的 `name` 改成新包名，或者删掉 `name` 只按 `id` 覆盖。

### 8.4 前端更新怎么生效、什么时候要重载窗口

- **原地改 `client.js`**：宿主每 500ms 查一次每个客户端行的 `client.js` 的 mtime / ctime / 大小（`dsh-client-hmr` 的 `src/index.ts`，`pollIntervalMs`；revision 只由这三项算出，不看内容），变了就经 `/plugins/events` 推 `rebuilt`，页面只替换这一个插件（`dsh-client-modules` 的 `src/client/entries.ts` `reload` / `replace`）。通常什么都不用做，面板里的 React 状态会被重置。
- **disable → enable**：宿主把这一行移出再加回图，页面卸载旧条目、重新取 bundle 并激活；`package.json` 也只在这时（或宿主重启时）重新读——只改 `package.json` 不重启条目不会被察觉（`dsh-client-modules` README「已知限制」）。
- **要重载页面的情况**：① 页面提示宿主换了 release（DSH 升级后，页面在重载前不应用新 release 的图）；② `/plugins/events` 断了（例如宿主重启时这个路由先回了非 200），之后页面收不到任何插件变化；③ 替换失败后旧 bundle 不会恢复——先去「设置 → 插件 → 插件列表」点重试（它按最新的图重试，revision 没变也会重试），不行再重载。
- **怎么重载**：桌面版正式包**没有** Ctrl+R——`lib/main.js` 里「重新加载页面」菜单项只在开发版出现，Windows 正式版的应用菜单只有两个隐藏的「切换开发者工具」快捷键（Ctrl+Shift+I 与 F12）。所以：按 F12 打开开发者工具，在 Console 里执行 `location.reload()`；或者从托盘菜单退出 DSH 再重新打开（最稳）。
- **怎么判断是哪一种**：「设置 → 插件 → 插件列表」会显示当前页面的同步失败（例如上面的 `loaded without registering`）并提供重试；F12 开发者工具的 Console 里有 `client-modules: …` 的报错；`window.__DSH_BOOT__.entries.map(e => e.id)` 是页面载入时宿主发布的全部客户端行（重载后才是最新的）——里面没有本插件，说明宿主没把它当客户端行（profile 行名与 package.json 的 name 不一致，见 §8.3 第 1 条），这时改 `client.js` 没用。
