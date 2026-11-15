/**
 * dsh-workspace-memory — Client half.
 *
 * 三件事：
 *  1. `/memory`、`/memory_extract`、`/memory_pending` 的命令结果卡片默认铺开（内置卡的折叠是组件内部 state，无配置项）。
 *  2. `/memory_list` 的卡片在命令刚执行完时打开右侧栏并切到记忆面板（回放历史时不开）。
 *  3. 右侧栏「记忆」面板（2026-11-15 重设计，视觉与交互以 preview/panel.html 为准）：
 *     顶部导航「总览 · 待确认 · 指令 · 记忆」，按「在哪儿生效（所有项目 / 本项目）× 什么时候读（每轮都读 / 用到才查）」
 *     把四处存储（全局指令 = ~/.dsh/AGENTS.md、项目指令 = 工作区的 AGENTS.md / AGENTS.local.md、通用记忆 = 全局按需库、
 *     项目记忆 = 项目库）摆成一张地图。
 *
 * 数据通道是宿主 HTTP 路由（/api/dsh-workspace-memory/*）。
 *
 * 结构：面板的全部状态集中在一个 store（`createPanel` 的闭包），视图是「输入 store、输出 React 元素」的普通函数；
 * 只有最外层 `MemoryPanel` 是 React 组件（持有 store、负责重绘与生命周期）。这样移植时视图代码与已确认的预览一一对应。
 *
 * 关于 source / evidence：来源与证据原话由宿主写入时记下，这里只读展示。旧文件里的 confidence 是**模型自评**，
 * 同样只读展示（只在没有 source 的旧条目上出现）。
 *
 * 列表里是两个库（项目库 / 全局按需库）的条目，每条的 scope = 它所在的库；
 * 保存 / 删除 / 升为全局指令的请求都带上它（基线所在的库，不是下拉里的值），宿主据此定位。
 *
 * 官方规范：不往 document.body 追加 DOM、不写组件外的 DOM（tooltip、菜单渲染在面板根节点内，position: fixed；
 * 对话框用组件内的原生 <dialog> + showModal）；颜色只用 --dsw-alias-*；样式经 ctx.effect 注入、释放时清理；
 * 全局快捷键只在面板可见且焦点在面板内时生效。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-memory',

  factory(require) {
    const React = require('react')
    const h0 = React.createElement
    const { useEffect, useLayoutEffect, useRef, useReducer } = React

    const API = '/api/dsh-workspace-memory'
    const TAB_KIND = 'memory-list'
    const TAB_ID = 'dsh-workspace-memory/list'
    const EDITOR_KEY = 'dsh-workspace-memory:editor'

    const TYPES = ['user', 'feedback', 'project', 'reference', 'pitfall']

    /* ---------------------------------------------------------------- 文案 */

    const ZH = {
      'tab.title': '记忆',
      'action.openPanel': '打开记忆面板',

      'nav.label': '记忆面板',
      'nav.overview': '总览',
      'nav.pending': '待确认',
      'nav.instructions': '指令',
      'nav.memories': '记忆',
      'nav.pendingBadge': '{n} 条等你确认',
      'nav.unsaved': '有未保存的修改',
      'act.refresh': '刷新',
      'act.focus': '专注模式',
      'act.focus.tip': '专注模式：隐藏导航和列表',
      'act.focusExit': '退出专注模式（Esc）',
      'focus.label': '专注模式',

      'layer.globalInstr': '全局指令',
      'layer.globalInstr.desc': '每一轮都会发给 Agent，在所有项目里生效',
      'layer.projInstr': '项目指令',
      'layer.projInstr.desc': '每一轮都会发给 Agent，只在本项目生效',
      'layer.team': '项目指令 · 团队',
      'layer.team.short': '团队',
      'layer.team.desc': '进 git，进这个仓库的人和 Agent 都要守',
      'layer.local': '项目指令 · 仅你',
      'layer.local.short': '仅你',
      'layer.local.desc': '不进 git，只对你成立',
      'layer.globalMem': '通用记忆',
      'layer.globalMem.desc': 'Agent 用到时才去查，所有项目都能查到',
      'layer.projMem': '项目记忆',
      'layer.projMem.desc': 'Agent 用到时才去查，只在本项目',
      'layer.skill': 'skill',
      'layer.none': '不记',

      'axis.always': '每轮都读',
      'axis.ondemand': '用到才查',
      'axis.all': '所有项目',
      'axis.project': '本项目',
      'axis.always.sub': '整份发给 Agent',
      'axis.ondemand.sub': '平时只看一行摘要',

      'type.user': '关于你',
      'type.user.tip': '你是谁：语言、角色、专长、长期偏好。只记你自己说的。',
      'type.feedback': '做事要求',
      'type.feedback.tip': '你纠正过 Agent 做事或表达的方式，或者肯定过一个不明显的做法。',
      'type.project': '项目决定',
      'type.project.tip': '你说过的、从代码里看不出来的目标、决定、约束和期限。',
      'type.reference': '资料位置',
      'type.reference.tip': '仓库外的东西在哪（网址、面板、账号、文档），以及用来做什么。',
      'type.pitfall': '踩坑经验',
      'type.pitfall.tip': 'Agent 自己踩到并验证过的坑和修法，写明什么情况触发、什么时候失效。',

      'src.verified': '你的原话 · 已核对',
      'src.verified.tip': 'Agent 记下这条时，在对话记录里找到了这句原话。',
      'src.mismatch': '说是你的原话 · 没核对上',
      'src.mismatch.tip': 'Agent 说这是你的原话，但对话记录里找不到这句话，可能是转述。收下也不会把它变成「已核对」。',
      'src.legacy': '你的原话 · 旧条目未核对',
      'src.legacy.tip': '这条是旧版本记下的，那时还没有核对原话的机制。',
      'src.agent': 'Agent 总结',
      'src.agent.tip': 'Agent 从对话或工作里自己总结的，没有你的原话。',
      'src.confidence': '模型自评 {n}',
      'src.confidence.tip': '旧版本留下的模型自评分数，只读，仅供参考。',
      'src.none': '没有记录来源',
      'src.noQuote': '没有可核对的原话',

      'time.justNow': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.yesterday': '昨天',
      'time.days': '{n} 天前',
      'time.months': '{n} 个月前',
      'time.date': '{m}月{d}日 {hm}',
      'time.dateYear': '{y}年{m}月{d}日 {hm}',
      'time.updated': '{when}更新',
      'time.none': '—',

      'unit.kb': '{n} KB',
      'unit.tokens': '约 {n} tokens',
      'unit.chapters': '章',
      'unit.items': '条',
      'unit.listSep': '，',

      'ov.title': 'Agent 记得什么',
      'ov.workspace.tip': '工作区：{path}',
      'ov.workspace.unknown': '当前工作区',
      'ov.banner': '{n} 条新内容等你确认',
      'ov.banner.sub': '写进去之前要你点头：Agent 自己总结的、要写进全局指令的，都会先放这里。',
      'ov.banner.go': '去看看',
      'ov.map': '记忆地图',
      'ov.map.sub': '一条内容放在哪，取决于两件事：在哪儿生效，什么时候读。',
      'ov.cell.open': '打开{name}',
      'ov.cell.missing': '还没有创建这个文件',
      'ov.cell.unknown': '暂时读不到',
      'ov.cell.emptyMem': '还没有记忆',
      'ov.cell.budget': '{used} / {max} KB',
      'ov.cell.budget.tip': '已用 {used} 字节，上限 {max} 字节。到上限后插件会拒绝让它继续变大。',
      'ov.cell.bytes': '{used} KB',
      'ov.cell.bytes.tip': '已用 {used} 字节，没有设上限。',
      'ov.cell.count': '/ {max} 条',
      'ov.cell.count.tip': '这个库最多 {max} 条，满了要先合并或删除才能再记',
      'ov.cell.none': '未创建',
      'ov.cell.noTime': '没有更新记录',
      'ov.cost': '每轮固定开销',
      'ov.cost.sub': '每一轮都会固定带给模型的内容。越短，Agent 越专注。',
      'ov.cost.global': '全局指令',
      'ov.cost.team': '项目指令 · 团队',
      'ov.cost.local': '项目指令 · 仅你',
      'ov.cost.index': '记忆索引 · {n} 行',
      'ov.cost.index.tip': '每条记忆在索引里只占一行摘要，正文要用到时才查',
      'ov.cost.seg.tip': '{name}\n{bytes} 字节 · 约 {tokens} tokens',
      'ov.cost.estimate': '按 字节 ÷ 3.5 粗估',
      'ov.cost.tip': '记忆正文不算在里面：Agent 用到时才去读。',
      'ov.cost.empty': '现在每一轮都没有固定带上的内容。',
      'ov.cost.bytes': '{n} 字节',
      'ov.cost.total': '约 {n}',
      'ov.cost.unit': 'tokens',
      'ov.recent': '最近变化',
      'ov.recent.empty': '还没有记忆。',
      'ov.recent.all': '全部记忆',
      'ov.stale': '可能过时',
      'ov.stale.sub': '很久没被 Agent 用到的记忆，看看还要不要。',
      'ov.stale.unused': '{n} 天没被用过',
      'ov.stale.never': '建了 {n} 天，从没被用过',
      'ov.stale.look': '看看',
      'ov.stale.empty': '没有可能过时的记忆。',
      'ov.flow': 'Agent 怎么决定记到哪',
      'ov.flow.q1': '是可以照着重复做的操作流程？',
      'ov.flow.q2': '团队里每个人都要守？',
      'ov.flow.q3': '只对你成立，而且只在本项目？',
      'ov.flow.q4': '关于你，或者你对做事方式的要求？',
      'ov.flow.q4.note': '先到待确认',
      'ov.flow.rest': '其余的',
      'ov.flow.restNote': '看是否跨项目成立',
      'ov.flow.or': '或',
      'ov.flow.once': '只管这一次的事',
      'ov.flow.yes': '是',

      'pd.title': '待你确认',
      'pd.sub': '写进去之前要你点头的草稿。收下才生效；丢弃就删掉。',
      'pd.count': '{n} 条',
      'pd.dest.label': '去向',
      'pd.dest.append': '新增一章（第 {n} 章）',
      'pd.dest.overwrite': '覆盖第 {n} 章「{title}」',
      'pd.dest.overwriteNoNum': '覆盖「{title}」这一章',
      'pd.dest.position': '入队时的位置',
      'pd.dest.position.tip': '章号是草稿入队时这一章的位置。收下时按标题「{title}」找这一章，前面的章有增删也不影响。',
      'pd.dest.replace': '替换「{title}」',
      'pd.dest.replaceGone': '替换的旧条目已经不在了',
      'pd.dest.new': '新增一条',
      'pd.dest.blocked': '归宿是项目自己的 AGENTS.md',
      'pd.why.global': '写进全局指令的内容一律要你确认：它每一轮都会发给 Agent。',
      'pd.why.agent': '这是 Agent 自己总结的，没有你的原话可以对照。',
      'pd.why.unverified': '说是你的原话，但在对话记录里没核对上。',
      'pd.why.review': '当前设置是 Agent 写入前先给你过目。',
      'pd.onlyTitleBody': '只有标题和正文会写进全局指令',
      'pd.onlyTitleBody.tip': '摘要、标签、类型不会写进全局指令',
      'pd.summary': '摘要',
      'pd.summary.tip': '这一行会出现在每轮的记忆索引里',
      'pd.slug.tip': '收下后的文件名（预计；撞名时宿主会自动加 -2）',
      'pd.content': '内容',
      'pd.view.label': '查看方式',
      'pd.view.diff': '对比',
      'pd.view.after': '收下后',
      'pd.compare.chapter': '和现在的第 {n} 章对比',
      'pd.compare.memory': '和旧条目对比',
      'pd.compare.title': '标题',
      'pd.compare.body': '正文',
      'pd.note.overwrite': '收下后整章覆盖；写之前会自动备份全局指令（保留最近 {n} 份）。',
      'pd.note.overwriteNoNum': '收下后整章覆盖；写之前会自动备份全局指令。',
      'pd.note.replace': '收下后旧的这条会删掉（留历史版本）。',
      'pd.alsoRemove': '同时删除',
      'pd.alsoRemove.note': '（删之前留历史版本）。',
      'pd.alsoRemove.target': '{lib}「{title}」',
      'pd.viewOld': '查看旧条目',
      'pd.evidence': '出处',
      'pd.evidence.at': '{when} 的对话',
      'pd.queued': '{when}入队',
      'pd.accept': '收下',
      'pd.acceptReplace': '收下并替换',
      'pd.accepting': '写入中…',
      'pd.discard': '丢弃',
      'pd.keys.move': '上下切换',
      'pd.keys.accept': '收下',
      'pd.keys.discard': '丢弃',
      'pd.empty.title': '没有等你确认的内容',
      'pd.empty.body': 'Agent 自己总结的、要写进全局指令的东西会先到这里。',
      'pd.empty.extract': '想现在从对话里找找值得记的，可以用 /memory_extract。',
      'pd.discard.title': '丢弃这条草稿？',
      'pd.discard.msg': '「{title}」会被删除，无法恢复。',
      'pd.discard.ok': '丢弃',
      'pd.err.sectionMoved': '全局指令里找不到「{title}」这一章了（被删除或改了名），没有写入；草稿还在队列里。',
      'pd.err.blocked': '插件不写项目自己的 AGENTS.md。要收下这条，得先改成「用到才查」或「所有项目」。',
      'pd.err.full': '写进去后全局指令会到 {after} KB，超过 {max} KB 的上限，没有写入；草稿还在队列里。',
      'pd.err.libFull': '{lib}已经有 {n} 条，到上限了。先合并或删除一条再收下（草稿还在队列里）。',
      'pd.diff.same': '{n} 行没变',
      'pd.diff.del': '删掉：',
      'pd.diff.add': '新增：',
      'pd.region': '待确认草稿',

      'in.seg.label': '指令范围',
      'in.seg.global': '全局',
      'in.seg.project': '本项目',
      'in.global.title': '全局指令',
      'in.global.sub': '每一轮都会发给 Agent，在所有项目里生效。',
      'in.budget': '已用',
      'in.budget.v': '{used} / {max} KB',
      'in.budget.tip': '{used} / {max} 字节。到上限后，插件会拒绝让它继续变大；让它变小的修改始终放行。',
      'in.budget.only': '{used} KB',
      'in.budget.only.tip': '{used} 字节，没有设上限。',
      'in.open': '用编辑器打开',
      'in.open.with': '用 {app} 打开',
      'in.open.choose': '选择编辑器',
      'in.editor.auto': '自动',
      'in.editor.auto.desc': '用找到的第一个编辑器',
      'in.editor.system': '系统默认',
      'in.editor.system.desc': '交给系统关联的程序',
      'in.toc': '目录',
      'in.toc.label': '章节目录',
      'in.toc.current': '第 {n} 章 · {title}',
      'in.preamble': '前言',
      'in.preamble.note': '第一章之前的内容 · 只读',
      'in.chapter.n': '第 {n} 章',
      'in.edit': '编辑',
      'in.more': '第 {n} 章的更多操作',
      'in.delete': '删除这一章',
      'in.title.ph': '章标题',
      'in.title.label': '第 {n} 章标题',
      'in.body.label': '第 {n} 章正文',
      'in.body.ph': '这一章的内容，支持 Markdown',
      'in.save': '保存',
      'in.save.tip': '保存（Ctrl+S）',
      'in.saving': '保存中…',
      'in.discard': '放弃',
      'in.hint.save': '保存',
      'in.hint.cancel': '放弃',
      'in.delta': '{sign}{n} 字节',
      'in.add': '新增一章',
      'in.add.create': '添加这一章',
      'in.err.emptyTitle': '章标题不能为空',
      'in.err.dup': '已经有一章叫「{title}」了',
      'in.err.full': '保存后全局指令会到 {after} KB，超过 {max} KB 的上限。先精简一些再保存。',
      'in.err.moved': '这一章在文件里已经变了（被改名或删除）。你的修改还在，可以作为新的一章保存。',
      'in.conflict.note': '你改着的时候，文件里的这一章也变了（可能刚收下了覆盖它的草稿，或在外部编辑器里改过）。保存会用你现在的内容整章覆盖。',
      'in.conflict.title': '覆盖文件里的新内容？',
      'in.conflict.msg': '第 {n} 章在你编辑期间被改过。保存会用你的版本整章覆盖文件里的新内容；也可以放弃你的修改，改用文件里的内容。',
      'in.conflict.useFile': '改用文件里的内容',
      'in.conflict.overwrite': '仍然保存',
      'in.del.title': '删除第 {n} 章？',
      'in.del.msg': '会从全局指令里移除「{title}」和它的小节，后面的章号会前移。',
      'in.del.backup': '写之前会自动备份全局指令（保留最近 {k} 份）。',
      'in.del.backupNoNum': '写之前会自动备份全局指令。',
      'in.del.ok': '删除这一章',
      'in.discard.title': '放弃修改？',
      'in.discard.msg': '第 {n} 章的修改会丢失。',
      'in.discard.msgNew': '新的一章还没保存，会丢失。',
      'in.discard.ok': '放弃修改',
      'in.keep': '继续编辑',
      'in.missing.title': '还没有全局指令',
      'in.missing.body': '全局指令保存在下面这个文件里：每一轮都会发给 Agent，在所有项目里生效。适合写你是谁、希望 Agent 怎么沟通、所有项目都要守的规矩。',
      'in.missing.hint': '这个文件还不存在时，要写进全局指令的内容也进不了待确认。新建一个空文件就可以开始。',
      'in.missing.create': '新建全局指令文件',
      'in.error.title': '读不到全局指令',
      'in.empty.chapters': '全局指令里还没有章。',
      'in.proj.note': '项目指令由你和团队自己维护，插件只读、不写。',
      'in.proj.open': '在编辑器中打开',
      'in.proj.git': '进 git',
      'in.proj.nogit': '不进 git',
      'in.proj.missing': '这个仓库还没有 {file}',
      'in.proj.missing.team': '在仓库根目录新建 AGENTS.md，写下团队都要守的约定。它进 git，每个打开这个仓库的人和 Agent 都会读到。',
      'in.proj.missing.local': '在仓库根目录新建 AGENTS.local.md，写只对你成立、只在这个仓库里的要求。它不进 git（记得加进 .gitignore）。',
      'in.proj.expand': '展开全部',
      'in.proj.collapse': '收起',
      'in.proj.size': '{kb} KB · {when}',
      'in.proj.truncated': '文件有 {kb} KB，这里只显示开头的 64 KB；用编辑器打开能看到全部。',
      'in.proj.readError': '这个文件在，但读不出来：{error}',
      'in.proj.unavailable': '暂时读不到项目指令文件。插件宿主比面板旧时会这样，更新插件后再试。',

      'mm.search.ph': '搜索标题、正文、标签',
      'mm.search.label': '搜索记忆',
      'mm.search.clear': '清除搜索',
      'mm.search.kbd': '按 / 搜索',
      'mm.scope.label': '适用范围',
      'mm.scope.all': '全部',
      'mm.scope.project': '本项目',
      'mm.scope.global': '所有项目',
      'mm.type.label': '类型',
      'mm.type.all': '全部',
      'mm.lib.tip': '{name}：{n} 条，上限 {max} 条',
      'mm.lib.tipNoMax': '{name}：{n} 条',
      'mm.list.label': '记忆列表',
      'mm.count': '{n} 条记忆',
      'mm.empty.title': '还没有记忆',
      'mm.empty.body': 'Agent 在对话里遇到值得记住的事会记到这里；你也可以直接说「记住……」。',
      'mm.nomatch.q': '没有匹配「{q}」的记忆',
      'mm.nomatch.filter': '没有符合筛选条件的记忆',
      'mm.nomatch.body': '换个关键词，或者清除筛选。',
      'mm.clearFilters': '清除筛选',
      'mm.pick': '选一条记忆看看',
      'mm.pick.sub': '在左边点一条，就能在这里查看和修改。',
      'mm.back': '列表',
      'mm.unsaved': '未保存',
      'mm.more': '更多操作',
      'mm.title.ph': '标题',
      'mm.title.label': '标题',
      'mm.desc.ph': '添加一句摘要',
      'mm.desc.label': '摘要',
      'mm.prop.type': '类型',
      'mm.prop.scope': '适用范围',
      'mm.prop.tags': '标签',
      'mm.prop.source': '来源',
      'mm.prop.usage': '使用情况',
      'mm.prop.paths': '相关文件',
      'mm.prop.updated': '更新于',
      'mm.prop.file': '文件名',
      'mm.scope.opt.project': '本项目',
      'mm.scope.opt.project.desc': '只有本项目查得到 · 放在项目记忆',
      'mm.scope.opt.global': '所有项目',
      'mm.scope.opt.global.desc': '其他项目也查得到 · 放在通用记忆',
      'mm.scope.toGlobal': '移到「所有项目」后，其他项目也能查到；保存时会移到通用记忆。',
      'mm.scope.toProject': '移到「本项目」后，只有本项目能查到；保存时会移到项目记忆。',
      'mm.scope.shouldPromote': '「{type}」这类在所有项目都成立的内容，应该升为全局指令，让 Agent 每一轮都带着。',
      'mm.scope.promoteBtn': '改为升为全局指令',
      'mm.tags.add': '添加',
      'mm.tags.ph': '新标签',
      'mm.tags.remove': '删除标签 {tag}',
      'mm.usage': '被用过 {n} 次 · 最近一次 {when}',
      'mm.usage.noTime': '被用过 {n} 次',
      'mm.usage.never': '还没被用过',
      'mm.usage.stale': '可能过时',
      'mm.paths.none': '无',
      'mm.paths.tip': 'Agent 读写这些文件时会想起这条记忆',
      'mm.updated': '{abs} · {rel}',
      'mm.updated.tip': '创建于 {created}',
      'mm.file.tip': '改文件名会同时改这条记忆的 id',
      'mm.body': '正文',
      'mm.body.edit': '编辑',
      'mm.body.preview': '预览',
      'mm.body.count': '{n} / {max} 字',
      'mm.body.countNoMax': '{n} 字',
      'mm.body.empty': '正文是空的',
      'mm.save': '保存',
      'mm.save.tip': '保存（Ctrl+S）',
      'mm.saving': '保存中…',
      'mm.discard': '放弃',
      'mm.dirty': '有未保存的修改',
      'mm.menu.promote': '升为全局指令',
      'mm.menu.promote.desc': '让 Agent 每一轮都带着，并从记忆里移出',
      'mm.menu.delete': '删除这条记忆',
      'mm.del.title': '删除这条记忆？',
      'mm.del.msg': '「{title}」会从{lib}里移除。',
      'mm.del.history': '删之前会留一份历史版本，保存在：',
      'mm.del.ok': '删除',
      'mm.promote.title': '升为全局指令？',
      'mm.promote.msg': '「{title}」会追加为全局指令第 {n} 章，并从{lib}里移出。全局指令每一轮都会发给 Agent。',
      'mm.promote.fromProject': '这条现在在项目记忆里，会一步做完：移出项目记忆、写进全局指令。',
      'mm.promote.create': '全局指令文件还不存在，会先新建一个。',
      'mm.promote.budget': '全局指令会从 {before} KB 变成约 {after} KB（上限 {max} KB）',
      'mm.promote.budgetNoMax': '全局指令会从 {before} KB 变成约 {after} KB',
      'mm.promote.full': '会超过 {max} KB 的上限（约 {after} KB），宿主多半会拒绝写入。先精简全局指令或这条记忆再升级。',
      'mm.promote.history': '移出前会留一份历史版本。',
      'mm.promote.ok': '升为全局指令',
      'mm.discard.title': '放弃修改？',
      'mm.discard.msg': '「{title}」的修改会丢失。',
      'mm.discard.ok': '放弃修改',

      'guard.title': '有还没保存的修改',
      'guard.msg.mem': '「{title}」的修改还没保存。',
      'guard.msg.chap': '第 {n} 章的修改还没保存。',
      'guard.msg.new': '新的一章还没保存。',
      'guard.keep': '继续编辑',
      'guard.discard': '放弃修改',
      'guard.save': '保存并继续',
      'guard.promote.title': '升级前先处理未保存的修改',
      'guard.promote.discard': '放弃修改后升级',
      'guard.promote.save': '保存后升级',

      'err.title.empty': '标题不能为空',
      'err.title.long': '标题最多 {n} 个字',
      'err.title.line': '标题只能是一行',
      'err.desc.long': '摘要最多 {n} 个字',
      'err.desc.line': '摘要只能是一行',
      'err.body.empty': '正文不能为空',
      'err.body.long': '正文最多 {n} 个字',
      'err.type': '类型不合法',
      'err.scope': '适用范围不合法',
      'err.slug': '只能用小写英文字母、数字和连字符，至少 2 个字符',
      'err.slug.taken': '{lib}里已经有叫 {id} 的文件',
      'err.tag.empty': '标签不能为空',
      'err.tag.chars': '标签不能含逗号、] 或换行',
      'err.tag.long': '标签最多 {n} 个字',
      'err.tag.dup': '已经有这个标签了',
      'err.tag.many': '最多 {n} 个标签',
      'err.target.exists': '{lib}里已经有同名的「{id}」，没有移动，也没有保存。',
      'err.library.full': '{lib}已经有 {n} 条，到上限了；先合并或删除一条再移过去。',
      'err.fix': '先改好标出的地方',
      'err.save': '保存没有成功',
      'err.generic': '操作没有成功',
      'err.network': '连不上插件',
      'err.networkDetail': '连不上插件：{msg}',

      'toast.wroteChapter': '已写入 全局指令 · 第 {n} 章',
      'toast.wroteChapterNoNum': '已写入 全局指令',
      'toast.wroteMem': '已写入 {lib}',
      'toast.wroteReplace': '已写入 {lib}，替换了「{title}」',
      'toast.discarded': '已丢弃草稿',
      'toast.replaceFailed': '已写入 全局指令 · 第 {n} 章，但旧记忆「{title}」没能删除，需要你手动删掉。',
      'toast.replaceFailedNoNum': '已写入 全局指令，但旧记忆「{title}」没能删除，需要你手动删掉。',
      'toast.replaceFailed.go': '去删除',
      'toast.saved': '已保存',
      'toast.savedMoved': '已保存，并移到{lib}',
      'toast.deleted': '已删除「{title}」',
      'toast.deleteFailed': '没能删除「{title}」：{reason}',
      'toast.promoted': '已升为全局指令 · 第 {n} 章',
      'toast.promotedNoNum': '已升为全局指令',
      'toast.promotedKept': '已写入 全局指令 · 第 {n} 章，但「{title}」没能从{lib}里删掉，现在两处都有，需要你手动删除。',
      'toast.promotedKeptNoNum': '已写入全局指令，但「{title}」没能从{lib}里删掉，现在两处都有，需要你手动删除。',
      'toast.busy': '正在保存，等它完成再切换',
      'toast.saveFailedFor': '「{title}」没有保存成功：{reason}',
      'toast.chapterSaveFailed': '章节没有保存成功：{reason}',
      'toast.promoteFailed': '没能升为全局指令：{reason}',
      'toast.view': '查看',
      'toast.chapterSaved': '已保存第 {n} 章',
      'toast.chapterDeleted': '已删除第 {n} 章「{title}」',
      'toast.chapterDeleteFailed': '没能删除第 {n} 章：{reason}',
      'toast.chapterAdded': '已新增第 {n} 章「{title}」',
      'toast.opened': '已用 {app} 打开',
      'toast.openedSystem': '已用系统默认程序打开',
      'toast.openFailed': '没能打开：{reason}',
      'toast.created': '已新建全局指令文件',
      'toast.createFailed': '没能新建全局指令文件：{reason}',
      'toast.refreshed': '已刷新',
      'toast.refreshFailed': '刷新没有成功：{reason}',
      'toast.close': '关闭提示',

      'st.loading': '正在读取记忆…',
      'st.error.title': '读不到记忆',
      'st.error.body': '面板没能从插件拿到数据。可以重试；一直失败的话，重开一下这个会话。',
      'st.error.retry': '重试',
      'st.noSession': '没有可用的会话：打开一个会话后再看。',
      'dlg.close': '关闭',
      'dlg.cancel': '取消',

      // 宿主返回的失败原因码 → 人话（reasonText 只认 KNOWN_REASONS 里的码，原码绝不外露）
      'reason.invalid-id': '记忆 id 不合法',
      'reason.invalid-index': '章的位置不合法',
      'reason.not-found': '找不到这一条（可能已经被删掉了）',
      'reason.section-not-found': '找不到这一章',
      'reason.section-moved': '这一章在文件里已经变了，已重新读取',
      'reason.only-chapter': '这里只能删除整章',
      'reason.scope-not-global': '这条在项目记忆里，当前插件宿主不能直接升级：先把适用范围改成「所有项目」并保存，再升为全局指令',
      'reason.agents-missing': '全局指令文件（AGENTS.md）还不存在',
      'reason.agents-full': '全局指令已到字节上限，先合并或删除一章',
      'reason.agents-full.bytes': '全局指令会到 {bytes} 字节，超过 {limit} 字节的上限，先合并或删除一章',
      'reason.already-present': '全局指令里已经有同名的一章，没有重复追加',
      'reason.empty-title': '标题不能为空',
      'reason.empty-body': '正文不能为空',
      'reason.library-full': '这个库已经到条数上限，先合并或删掉一些',
      'reason.read-failed': '读取全局指令文件失败',
      'reason.write-failed': '写入全局指令文件失败',
      'reason.launch-failed': '启动不了编辑器',
      'reason.invalid-scope': '适用范围不合法',
      'reason.scope-ambiguous': '项目记忆和通用记忆里都有这个 id',
      'reason.target-exists': '另一个库里已经有同名的一条',
      'reason.belongs-in-project-agents': '只在本项目每轮都读的规则，应写进项目自己的 AGENTS.md',
      'reason.same-library': '已经在这个库里了',
      'reason.partially-saved': '已移到另一个库，但其余修改没有保存',
      'reason.move-failed': '移库没有完成，已恢复原状',
      'reason.move-partial': '移库没有完成，两个库里各留了一份',
      'reason.file-missing': '这个文件还不存在',
      'reason.already-exists': '这个文件已经存在了',
      'reason.invalid-target': '要打开的文件不合法',
      'reason.chapter-not-found': '全局指令里找不到要更新的那一章',
      'reason.needs-confirmation': '没说清是更新哪一章还是新增一章，没有写入',
      'reason.no-session': '没有可用的会话',
      'reason.unsupported-media-type': '请求格式不对（插件只接受 JSON）',
      'reason.body-too-large': '内容太大，插件没有接收',
      'reason.invalid-json': '请求内容不是合法的 JSON',
    }

    const EN = {
      'tab.title': 'Memory',
      'action.openPanel': 'Open memory panel',

      'nav.label': 'Memory panel',
      'nav.overview': 'Overview',
      'nav.pending': 'Review',
      'nav.instructions': 'Instructions',
      'nav.memories': 'Memories',
      'nav.pendingBadge': '{n} waiting for you',
      'nav.unsaved': 'Unsaved changes',
      'act.refresh': 'Refresh',
      'act.focus': 'Focus mode',
      'act.focus.tip': 'Focus mode: hide navigation and the list',
      'act.focusExit': 'Exit focus mode (Esc)',
      'focus.label': 'Focus mode',

      'layer.globalInstr': 'Global instructions',
      'layer.globalInstr.desc': 'Sent to the agent every turn, in every project',
      'layer.projInstr': 'Project instructions',
      'layer.projInstr.desc': 'Sent to the agent every turn, in this project only',
      'layer.team': 'Project instructions · team',
      'layer.team.short': 'Team',
      'layer.team.desc': 'Committed to git; everyone working in this repo follows it',
      'layer.local': 'Project instructions · just you',
      'layer.local.short': 'Just you',
      'layer.local.desc': 'Not committed; applies only to you',
      'layer.globalMem': 'Shared memory',
      'layer.globalMem.desc': 'Looked up when needed, from any project',
      'layer.projMem': 'Project memory',
      'layer.projMem.desc': 'Looked up when needed, in this project only',
      'layer.skill': 'skill',
      'layer.none': 'Not kept',

      'axis.always': 'Every turn',
      'axis.ondemand': 'When needed',
      'axis.all': 'All projects',
      'axis.project': 'This project',
      'axis.always.sub': 'sent in full',
      'axis.ondemand.sub': 'one-line summary until used',

      'type.user': 'About you',
      'type.user.tip': 'Who you are: language, role, expertise, lasting preferences. Only what you said yourself.',
      'type.feedback': 'How to work',
      'type.feedback.tip': 'You corrected how the agent works or communicates, or approved a non-obvious approach.',
      'type.project': 'Project decision',
      'type.project.tip': 'Goals, decisions, constraints and deadlines you stated that the code does not show.',
      'type.reference': 'Where things are',
      'type.reference.tip': 'Where something outside the repo lives (URL, dashboard, account, doc) and what it is for.',
      'type.pitfall': 'Pitfall',
      'type.pitfall.tip': 'A trap the agent hit and verified, with the fix, what triggers it and when it stops applying.',

      'src.verified': 'Your words · verified',
      'src.verified.tip': 'When the agent saved this, it found these exact words in the conversation.',
      'src.mismatch': 'Said to be your words · not found',
      'src.mismatch.tip': 'The agent says you said this, but the words are not in the conversation; it may be a paraphrase. Accepting does not mark it verified.',
      'src.legacy': 'Your words · older entry, not checked',
      'src.legacy.tip': 'Saved by an older version, before quotes were checked.',
      'src.agent': 'Agent summary',
      'src.agent.tip': 'Summarized by the agent from the conversation or its work; no words of yours.',
      'src.confidence': 'Model self-rating {n}',
      'src.confidence.tip': 'A self-rating left by an older version. Read-only, for reference.',
      'src.none': 'No source recorded',
      'src.noQuote': 'No quote to check',

      'time.justNow': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
      'time.yesterday': 'yesterday',
      'time.days': '{n} d ago',
      'time.months': '{n} mo ago',
      'time.date': '{m}/{d} {hm}',
      'time.dateYear': '{y}/{m}/{d} {hm}',
      'time.updated': 'updated {when}',
      'time.none': '—',

      'unit.kb': '{n} KB',
      'unit.tokens': '≈ {n} tokens',
      'unit.chapters': 'chapters',
      'unit.items': 'items',
      'unit.listSep': ', ',

      'ov.title': 'What the agent remembers',
      'ov.workspace.tip': 'Workspace: {path}',
      'ov.workspace.unknown': 'Current workspace',
      'ov.banner': '{n} new items waiting for you',
      'ov.banner.sub': 'You approve before anything is written: agent summaries and anything bound for the global instructions land here first.',
      'ov.banner.go': 'Review',
      'ov.map': 'Memory map',
      'ov.map.sub': 'Where something lives depends on two things: where it applies, and when it is read.',
      'ov.cell.open': 'Open {name}',
      'ov.cell.missing': 'This file does not exist yet',
      'ov.cell.unknown': 'Unavailable right now',
      'ov.cell.emptyMem': 'No memories yet',
      'ov.cell.budget': '{used} / {max} KB',
      'ov.cell.budget.tip': '{used} of {max} bytes used. At the limit the plugin refuses to let it grow.',
      'ov.cell.bytes': '{used} KB',
      'ov.cell.bytes.tip': '{used} bytes used; no limit set.',
      'ov.cell.count': '/ {max}',
      'ov.cell.count.tip': 'This library holds at most {max}. When full, merge or delete before adding more.',
      'ov.cell.none': 'none',
      'ov.cell.noTime': 'No updates yet',
      'ov.cost': 'Fixed cost per turn',
      'ov.cost.sub': 'What is sent to the model every single turn. Shorter keeps the agent focused.',
      'ov.cost.global': 'Global instructions',
      'ov.cost.team': 'Project instructions · team',
      'ov.cost.local': 'Project instructions · just you',
      'ov.cost.index': 'Memory index · {n} lines',
      'ov.cost.index.tip': 'Each memory takes one summary line in the index; the body is read only when needed',
      'ov.cost.seg.tip': '{name}\n{bytes} bytes · ≈ {tokens} tokens',
      'ov.cost.estimate': 'Rough estimate: bytes ÷ 3.5',
      'ov.cost.tip': 'Memory bodies are not included: the agent reads them only when needed.',
      'ov.cost.empty': 'Nothing is sent on every turn right now.',
      'ov.cost.bytes': '{n} bytes',
      'ov.cost.total': '≈ {n}',
      'ov.cost.unit': 'tokens',
      'ov.recent': 'Recent changes',
      'ov.recent.empty': 'No memories yet.',
      'ov.recent.all': 'All memories',
      'ov.stale': 'Possibly stale',
      'ov.stale.sub': 'Memories the agent has not used in a long time. Still worth keeping?',
      'ov.stale.unused': 'unused for {n} days',
      'ov.stale.never': 'created {n} days ago, never used',
      'ov.stale.look': 'Look',
      'ov.stale.empty': 'Nothing looks stale.',
      'ov.flow': 'How the agent decides where things go',
      'ov.flow.q1': 'A procedure you can follow step by step?',
      'ov.flow.q2': 'Something everyone on the team must follow?',
      'ov.flow.q3': 'True only for you, and only in this project?',
      'ov.flow.q4': 'About you, or how you want work done?',
      'ov.flow.q4.note': 'reviewed by you first',
      'ov.flow.rest': 'Everything else',
      'ov.flow.restNote': 'depending on whether it holds across projects',
      'ov.flow.or': 'or',
      'ov.flow.once': 'Only about this one time',
      'ov.flow.yes': 'yes',

      'pd.title': 'Waiting for you',
      'pd.sub': 'Drafts that need your OK before they are written. Accept to apply; discard to delete.',
      'pd.count': '{n}',
      'pd.dest.label': 'Destination',
      'pd.dest.append': 'new chapter (chapter {n})',
      'pd.dest.overwrite': 'overwrites chapter {n} “{title}”',
      'pd.dest.overwriteNoNum': 'overwrites the chapter “{title}”',
      'pd.dest.position': 'position when queued',
      'pd.dest.position.tip': 'The number is where this chapter was when the draft was queued. Accepting finds the chapter by its title “{title}”, so chapters added or removed before it do not matter.',
      'pd.dest.replace': 'replaces “{title}”',
      'pd.dest.replaceGone': 'the entry it replaces is gone',
      'pd.dest.new': 'new entry',
      'pd.dest.blocked': "belongs in the project's own AGENTS.md",
      'pd.why.global': 'Anything written to the global instructions needs your OK: it is sent to the agent every turn.',
      'pd.why.agent': 'The agent summarized this itself; there are no words of yours to compare.',
      'pd.why.unverified': 'Said to be your words, but they were not found in the conversation.',
      'pd.why.review': 'Your settings ask the agent to show you writes first.',
      'pd.onlyTitleBody': 'Only the title and body go into the global instructions',
      'pd.onlyTitleBody.tip': 'Summary, tags and type are not written to the global instructions',
      'pd.summary': 'Summary',
      'pd.summary.tip': 'This line appears in the memory index every turn',
      'pd.slug.tip': 'Expected file name after accepting (the host appends -2 on a clash)',
      'pd.content': 'Content',
      'pd.view.label': 'View',
      'pd.view.diff': 'Diff',
      'pd.view.after': 'After',
      'pd.compare.chapter': 'Compared with chapter {n} now',
      'pd.compare.memory': 'Compared with the old entry',
      'pd.compare.title': 'Title',
      'pd.compare.body': 'Body',
      'pd.note.overwrite': 'Accepting overwrites the whole chapter; the global instructions are backed up first (last {n} kept).',
      'pd.note.overwriteNoNum': 'Accepting overwrites the whole chapter; the global instructions are backed up first.',
      'pd.note.replace': 'Accepting deletes the old entry (a history copy is kept).',
      'pd.alsoRemove': 'Also deletes',
      'pd.alsoRemove.note': ' (a history copy is kept first).',
      'pd.alsoRemove.target': '{lib} “{title}”',
      'pd.viewOld': 'View old entry',
      'pd.evidence': 'Source',
      'pd.evidence.at': 'conversation on {when}',
      'pd.queued': 'queued {when}',
      'pd.accept': 'Accept',
      'pd.acceptReplace': 'Accept and replace',
      'pd.accepting': 'Writing…',
      'pd.discard': 'Discard',
      'pd.keys.move': 'move',
      'pd.keys.accept': 'accept',
      'pd.keys.discard': 'discard',
      'pd.empty.title': 'Nothing waiting for you',
      'pd.empty.body': 'Agent summaries and anything bound for the global instructions show up here first.',
      'pd.empty.extract': 'To look for something worth keeping in this conversation now, use /memory_extract.',
      'pd.discard.title': 'Discard this draft?',
      'pd.discard.msg': '“{title}” will be deleted. This cannot be undone.',
      'pd.discard.ok': 'Discard',
      'pd.err.sectionMoved': 'The chapter “{title}” is no longer in the global instructions (deleted or renamed). Nothing was written; the draft is still queued.',
      'pd.err.blocked': "The plugin does not write the project's own AGENTS.md. To accept this, it would have to be “when needed” or “all projects”.",
      'pd.err.full': 'The global instructions would reach {after} KB, over the {max} KB limit. Nothing was written; the draft is still queued.',
      'pd.err.libFull': '{lib} already has {n} entries, the limit. Merge or delete one, then accept (the draft is still queued).',
      'pd.diff.same': '{n} unchanged lines',
      'pd.diff.del': 'Removed: ',
      'pd.diff.add': 'Added: ',
      'pd.region': 'Drafts waiting for review',

      'in.seg.label': 'Instruction scope',
      'in.seg.global': 'Global',
      'in.seg.project': 'This project',
      'in.global.title': 'Global instructions',
      'in.global.sub': 'Sent to the agent every turn, in every project.',
      'in.budget': 'Used',
      'in.budget.v': '{used} / {max} KB',
      'in.budget.tip': '{used} of {max} bytes. At the limit the plugin refuses to let it grow; changes that shrink it are always allowed.',
      'in.budget.only': '{used} KB',
      'in.budget.only.tip': '{used} bytes; no limit set.',
      'in.open': 'Open in editor',
      'in.open.with': 'Open with {app}',
      'in.open.choose': 'Choose editor',
      'in.editor.auto': 'Automatic',
      'in.editor.auto.desc': 'Use the first editor found',
      'in.editor.system': 'System default',
      'in.editor.system.desc': 'Use the app the system associates',
      'in.toc': 'Contents',
      'in.toc.label': 'Chapters',
      'in.toc.current': 'Chapter {n} · {title}',
      'in.preamble': 'Preamble',
      'in.preamble.note': 'Text before the first chapter · read-only',
      'in.chapter.n': 'Chapter {n}',
      'in.edit': 'Edit',
      'in.more': 'More actions for chapter {n}',
      'in.delete': 'Delete this chapter',
      'in.title.ph': 'Chapter title',
      'in.title.label': 'Title of chapter {n}',
      'in.body.label': 'Body of chapter {n}',
      'in.body.ph': 'What this chapter says. Markdown works.',
      'in.save': 'Save',
      'in.save.tip': 'Save (Ctrl+S)',
      'in.saving': 'Saving…',
      'in.discard': 'Discard',
      'in.hint.save': 'save',
      'in.hint.cancel': 'discard',
      'in.delta': '{sign}{n} bytes',
      'in.add': 'Add a chapter',
      'in.add.create': 'Add chapter',
      'in.err.emptyTitle': 'The chapter title cannot be empty',
      'in.err.dup': 'There is already a chapter called “{title}”',
      'in.err.full': 'After saving, the global instructions would be {after} KB, over the {max} KB limit. Trim something first.',
      'in.err.moved': 'This chapter changed in the file (renamed or deleted). Your edits are kept; you can save them as a new chapter.',
      'in.conflict.note': 'While you were editing, this chapter also changed in the file (maybe a draft that overwrites it was accepted, or it was edited elsewhere). Saving overwrites the whole chapter with your version.',
      'in.conflict.title': 'Overwrite the newer content in the file?',
      'in.conflict.msg': 'Chapter {n} changed while you were editing. Saving overwrites it with your version; or drop your edits and use what is in the file.',
      'in.conflict.useFile': 'Use the file version',
      'in.conflict.overwrite': 'Save anyway',
      'in.del.title': 'Delete chapter {n}?',
      'in.del.msg': '“{title}” and its subsections are removed from the global instructions; later chapters move up.',
      'in.del.backup': 'The global instructions are backed up first (last {k} kept).',
      'in.del.backupNoNum': 'The global instructions are backed up first.',
      'in.del.ok': 'Delete chapter',
      'in.discard.title': 'Discard changes?',
      'in.discard.msg': 'Your changes to chapter {n} will be lost.',
      'in.discard.msgNew': 'The new chapter has not been saved and will be lost.',
      'in.discard.ok': 'Discard changes',
      'in.keep': 'Keep editing',
      'in.missing.title': 'No global instructions yet',
      'in.missing.body': 'Global instructions live in the file below. They are sent to the agent every turn, in every project: who you are, how you want the agent to communicate, rules for all projects.',
      'in.missing.hint': 'Until this file exists, nothing bound for the global instructions can even be queued for review. Create an empty file to get started.',
      'in.missing.create': 'Create the global instructions file',
      'in.error.title': 'Cannot read the global instructions',
      'in.empty.chapters': 'The global instructions have no chapters yet.',
      'in.proj.note': 'Project instructions are maintained by you and your team. The plugin only reads them.',
      'in.proj.open': 'Open in editor',
      'in.proj.git': 'in git',
      'in.proj.nogit': 'not in git',
      'in.proj.missing': 'This repo has no {file} yet',
      'in.proj.missing.team': 'Create AGENTS.md in the repo root with the conventions the whole team follows. It is committed, so everyone who opens this repo, and their agent, reads it.',
      'in.proj.missing.local': 'Create AGENTS.local.md in the repo root for requirements that hold only for you, only in this repo. It is not committed (add it to .gitignore).',
      'in.proj.expand': 'Show all',
      'in.proj.collapse': 'Collapse',
      'in.proj.size': '{kb} KB · {when}',
      'in.proj.truncated': 'This file is {kb} KB; only the first 64 KB are shown here. Open it in an editor to see everything.',
      'in.proj.readError': 'This file exists but cannot be read: {error}',
      'in.proj.unavailable': 'The project instruction files are not available. This happens when the plugin host is older than the panel; update the plugin and try again.',

      'mm.search.ph': 'Search titles, bodies, tags',
      'mm.search.label': 'Search memories',
      'mm.search.clear': 'Clear search',
      'mm.search.kbd': 'Press / to search',
      'mm.scope.label': 'Applies to',
      'mm.scope.all': 'All',
      'mm.scope.project': 'This project',
      'mm.scope.global': 'All projects',
      'mm.type.label': 'Type',
      'mm.type.all': 'All',
      'mm.lib.tip': '{name}: {n} of at most {max}',
      'mm.lib.tipNoMax': '{name}: {n}',
      'mm.list.label': 'Memories',
      'mm.count': '{n} memories',
      'mm.empty.title': 'No memories yet',
      'mm.empty.body': 'When something in a conversation is worth keeping, the agent saves it here. You can also just say “remember …”.',
      'mm.nomatch.q': 'Nothing matches “{q}”',
      'mm.nomatch.filter': 'Nothing matches the filters',
      'mm.nomatch.body': 'Try another word, or clear the filters.',
      'mm.clearFilters': 'Clear filters',
      'mm.pick': 'Pick a memory',
      'mm.pick.sub': 'Choose one on the left to view and edit it here.',
      'mm.back': 'List',
      'mm.unsaved': 'Unsaved',
      'mm.more': 'More actions',
      'mm.title.ph': 'Title',
      'mm.title.label': 'Title',
      'mm.desc.ph': 'Add a one-line summary',
      'mm.desc.label': 'Summary',
      'mm.prop.type': 'Type',
      'mm.prop.scope': 'Applies to',
      'mm.prop.tags': 'Tags',
      'mm.prop.source': 'Source',
      'mm.prop.usage': 'Usage',
      'mm.prop.paths': 'Related files',
      'mm.prop.updated': 'Updated',
      'mm.prop.file': 'File name',
      'mm.scope.opt.project': 'This project',
      'mm.scope.opt.project.desc': 'Only this project can find it · kept in project memory',
      'mm.scope.opt.global': 'All projects',
      'mm.scope.opt.global.desc': 'Other projects can find it too · kept in shared memory',
      'mm.scope.toGlobal': 'With “all projects”, other projects can find it too; saving moves it to shared memory.',
      'mm.scope.toProject': 'With “this project”, only this project can find it; saving moves it to project memory.',
      'mm.scope.shouldPromote': '“{type}” content that holds in every project belongs in the global instructions, so the agent carries it every turn.',
      'mm.scope.promoteBtn': 'Promote to global instructions instead',
      'mm.tags.add': 'Add',
      'mm.tags.ph': 'New tag',
      'mm.tags.remove': 'Remove tag {tag}',
      'mm.usage': 'Used {n} times · last {when}',
      'mm.usage.noTime': 'Used {n} times',
      'mm.usage.never': 'Never used yet',
      'mm.usage.stale': 'Possibly stale',
      'mm.paths.none': 'None',
      'mm.paths.tip': 'The agent is reminded of this memory when it reads or writes these files',
      'mm.updated': '{abs} · {rel}',
      'mm.updated.tip': 'Created {created}',
      'mm.file.tip': 'Renaming the file also changes this memory’s id',
      'mm.body': 'Body',
      'mm.body.edit': 'Edit',
      'mm.body.preview': 'Preview',
      'mm.body.count': '{n} / {max} chars',
      'mm.body.countNoMax': '{n} chars',
      'mm.body.empty': 'The body is empty',
      'mm.save': 'Save',
      'mm.save.tip': 'Save (Ctrl+S)',
      'mm.saving': 'Saving…',
      'mm.discard': 'Discard',
      'mm.dirty': 'Unsaved changes',
      'mm.menu.promote': 'Promote to global instructions',
      'mm.menu.promote.desc': 'The agent carries it every turn; it leaves memory',
      'mm.menu.delete': 'Delete this memory',
      'mm.del.title': 'Delete this memory?',
      'mm.del.msg': '“{title}” will be removed from {lib}.',
      'mm.del.history': 'A history copy is kept first, in:',
      'mm.del.ok': 'Delete',
      'mm.promote.title': 'Promote to global instructions?',
      'mm.promote.msg': '“{title}” is appended as chapter {n} of the global instructions and removed from {lib}. The global instructions are sent to the agent every turn.',
      'mm.promote.fromProject': 'This is in project memory now; one step moves it out and writes it to the global instructions.',
      'mm.promote.create': 'The global instructions file does not exist yet; it will be created first.',
      'mm.promote.budget': 'The global instructions go from {before} KB to about {after} KB (limit {max} KB)',
      'mm.promote.budgetNoMax': 'The global instructions go from {before} KB to about {after} KB',
      'mm.promote.full': 'This would exceed the {max} KB limit (about {after} KB), so the host will likely refuse. Trim the global instructions or this memory first.',
      'mm.promote.history': 'A history copy is kept before it leaves memory.',
      'mm.promote.ok': 'Promote',
      'mm.discard.title': 'Discard changes?',
      'mm.discard.msg': 'Your changes to “{title}” will be lost.',
      'mm.discard.ok': 'Discard changes',

      'guard.title': 'You have unsaved changes',
      'guard.msg.mem': 'Changes to “{title}” are not saved yet.',
      'guard.msg.chap': 'Changes to chapter {n} are not saved yet.',
      'guard.msg.new': 'The new chapter is not saved yet.',
      'guard.keep': 'Keep editing',
      'guard.discard': 'Discard changes',
      'guard.save': 'Save and continue',
      'guard.promote.title': 'Handle unsaved changes before promoting',
      'guard.promote.discard': 'Discard and promote',
      'guard.promote.save': 'Save and promote',

      'err.title.empty': 'The title cannot be empty',
      'err.title.long': 'The title can be at most {n} characters',
      'err.title.line': 'The title must be a single line',
      'err.desc.long': 'The summary can be at most {n} characters',
      'err.desc.line': 'The summary must be a single line',
      'err.body.empty': 'The body cannot be empty',
      'err.body.long': 'The body can be at most {n} characters',
      'err.type': 'Invalid type',
      'err.scope': 'Invalid scope',
      'err.slug': 'Use lowercase letters, digits and hyphens only, at least 2 characters',
      'err.slug.taken': '{lib} already has a file named {id}',
      'err.tag.empty': 'A tag cannot be empty',
      'err.tag.chars': 'Tags cannot contain commas, ] or line breaks',
      'err.tag.long': 'A tag can be at most {n} characters',
      'err.tag.dup': 'That tag is already there',
      'err.tag.many': 'At most {n} tags',
      'err.target.exists': '{lib} already has “{id}”. Nothing was moved or saved.',
      'err.library.full': '{lib} already has {n} entries, the limit. Merge or delete one before moving this there.',
      'err.fix': 'Fix the marked fields first',
      'err.save': 'Saving did not work',
      'err.generic': 'That did not work',
      'err.network': 'Cannot reach the plugin',
      'err.networkDetail': 'Cannot reach the plugin: {msg}',

      'toast.wroteChapter': 'Written to the global instructions · chapter {n}',
      'toast.wroteChapterNoNum': 'Written to the global instructions',
      'toast.wroteMem': 'Written to {lib}',
      'toast.wroteReplace': 'Written to {lib}, replacing “{title}”',
      'toast.discarded': 'Draft discarded',
      'toast.replaceFailed': 'Written to the global instructions · chapter {n}, but the old memory “{title}” could not be deleted. Please delete it yourself.',
      'toast.replaceFailedNoNum': 'Written to the global instructions, but the old memory “{title}” could not be deleted. Please delete it yourself.',
      'toast.replaceFailed.go': 'Delete it',
      'toast.saved': 'Saved',
      'toast.savedMoved': 'Saved and moved to {lib}',
      'toast.deleted': 'Deleted “{title}”',
      'toast.deleteFailed': 'Could not delete “{title}”: {reason}',
      'toast.promoted': 'Promoted to the global instructions · chapter {n}',
      'toast.promotedNoNum': 'Promoted to the global instructions',
      'toast.promotedKept': 'Written to the global instructions · chapter {n}, but “{title}” could not be removed from {lib}; it now exists in both places. Please delete it yourself.',
      'toast.promotedKeptNoNum': 'Written to the global instructions, but “{title}” could not be removed from {lib}; it now exists in both places. Please delete it yourself.',
      'toast.busy': 'Saving… switch once it finishes',
      'toast.saveFailedFor': '“{title}” was not saved: {reason}',
      'toast.chapterSaveFailed': 'The chapter was not saved: {reason}',
      'toast.promoteFailed': 'Could not promote: {reason}',
      'toast.view': 'View',
      'toast.chapterSaved': 'Chapter {n} saved',
      'toast.chapterDeleted': 'Deleted chapter {n} “{title}”',
      'toast.chapterDeleteFailed': 'Could not delete chapter {n}: {reason}',
      'toast.chapterAdded': 'Added chapter {n} “{title}”',
      'toast.opened': 'Opened with {app}',
      'toast.openedSystem': 'Opened with the system default app',
      'toast.openFailed': 'Could not open it: {reason}',
      'toast.created': 'Created the global instructions file',
      'toast.createFailed': 'Could not create the global instructions file: {reason}',
      'toast.refreshed': 'Refreshed',
      'toast.refreshFailed': 'Refresh did not work: {reason}',
      'toast.close': 'Dismiss',

      'st.loading': 'Reading memories…',
      'st.error.title': 'Cannot read memories',
      'st.error.body': 'The panel could not get data from the plugin. Try again; if it keeps failing, reopen this conversation.',
      'st.error.retry': 'Try again',
      'st.noSession': 'No conversation is available. Open one to see its memories.',
      'dlg.close': 'Close',
      'dlg.cancel': 'Cancel',

      'reason.invalid-id': 'Invalid memory id',
      'reason.invalid-index': 'Invalid chapter position',
      'reason.not-found': 'Not found (it may have been deleted)',
      'reason.section-not-found': 'Chapter not found',
      'reason.section-moved': 'This chapter changed in the file; reloaded',
      'reason.only-chapter': 'Only whole chapters can be deleted here',
      'reason.scope-not-global': 'This is in project memory and the current plugin host cannot promote it directly. Change “applies to” to all projects, save, then promote.',
      'reason.agents-missing': 'The global instructions file (AGENTS.md) does not exist yet',
      'reason.agents-full': 'The global instructions are at their size limit. Merge or delete a chapter first.',
      'reason.agents-full.bytes': 'The global instructions would reach {bytes} bytes, over the {limit}-byte limit. Merge or delete a chapter first.',
      'reason.already-present': 'The global instructions already have a chapter with this title; nothing was appended',
      'reason.empty-title': 'The title cannot be empty',
      'reason.empty-body': 'The body cannot be empty',
      'reason.library-full': 'This library is full. Merge or delete some first.',
      'reason.read-failed': 'Could not read the global instructions file',
      'reason.write-failed': 'Could not write the global instructions file',
      'reason.launch-failed': 'Could not start the editor',
      'reason.invalid-scope': 'Invalid scope',
      'reason.scope-ambiguous': 'Both project memory and shared memory have this id',
      'reason.target-exists': 'The target library already has an entry with this name',
      'reason.belongs-in-project-agents': "A rule read every turn in one project belongs in that project's AGENTS.md",
      'reason.same-library': 'Already in this library',
      'reason.partially-saved': 'Moved to the other library, but the other changes were not saved',
      'reason.move-failed': 'The move did not complete and was rolled back',
      'reason.move-partial': 'The move did not complete; both libraries now hold a copy',
      'reason.file-missing': 'This file does not exist yet',
      'reason.already-exists': 'This file already exists',
      'reason.invalid-target': 'Invalid file to open',
      'reason.chapter-not-found': 'The chapter to update is not in the global instructions',
      'reason.needs-confirmation': 'It was not clear whether this updates a chapter or adds one, so nothing was written',
      'reason.no-session': 'No conversation is available',
      'reason.unsupported-media-type': 'Unsupported request format (JSON only)',
      'reason.body-too-large': 'The request is too large for the plugin',
      'reason.invalid-json': 'The request is not valid JSON',
    }

    let dict = ZH
    const NS = 'workspace-memory'

    function inlineT(key, vars) {
      let out = dict[key] ?? ZH[key] ?? key
      if (vars) out = out.replace(/\{(\w+)\}/g, (all, name) => (vars[name] == null ? '' : String(vars[name])))
      return out
    }

    let t = inlineT
    const STYLESHEET = `
.wsm-panel {
  --wsm-mono: 'SF Mono', 'Cascadia Mono', Consolas, 'Liberation Mono', Menlo, 'PingFang SC', 'Microsoft YaHei', monospace;
  --wsm-ease: cubic-bezier(.2, 0, 0, 1);
  --wsm-gutter: 16px;
  --wsm-tint-1: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);
  --wsm-tint-2: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
  --wsm-tint-3: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  position: relative;
  display: flex; flex-direction: column;
  height: 100%; min-height: 0; min-width: 0; overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 20px;
}
.wsm-panel:not([data-size="narrow"]) { --wsm-gutter: 24px; }
.wsm-panel *, .wsm-panel *::before, .wsm-panel *::after { box-sizing: border-box; }
:where(.wsm-panel) button { font: inherit; color: inherit; }
:where(.wsm-panel) :focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
:where(.wsm-panel) :where(h1, h2, h3, h4, p, ul, ol, figure, blockquote) { margin: 0; }
.wsm-panel .wsm-input input::-webkit-search-cancel-button, .wsm-panel .wsm-input input::-webkit-search-decoration { -webkit-appearance: none; display: none; }
.wsm-panel .wsm-ic { flex: none; display: block; }
.wsm-panel .wsm-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
.wsm-panel .wsm-num { font-variant-numeric: tabular-nums; }
.wsm-panel .wsm-mono { font-family: var(--wsm-mono); }

.wsm-panel .wsm-head {
  flex: none; position: relative; z-index: 3;
  display: flex; align-items: stretch; gap: 4px;
  height: 38px; padding: 0 6px 0 8px;
  border-bottom: .5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-base);
}
.wsm-panel .wsm-nav { position: relative; display: flex; align-items: stretch; gap: 2px; min-width: 0; flex: 1; overflow-x: auto; overflow-y: hidden; }
.wsm-panel .wsm-nav::-webkit-scrollbar { display: none; }
.wsm-panel .wsm-tab {
  position: relative; flex: none;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 0 9px; border: 0; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-weight: 500; white-space: nowrap;
  transition: color .12s ease;
}
.wsm-panel .wsm-tab::before {
  content: ''; position: absolute; inset: 5px 1px; border-radius: 8px;
  background: transparent; transition: background-color .12s ease;
}
@media (hover: hover) { .wsm-panel .wsm-tab:hover { color: var(--dsw-alias-label-primary); } .wsm-panel .wsm-tab:hover::before { background: var(--dsw-alias-interactive-bg-hover); } }
.wsm-panel .wsm-tab:active::before { background: var(--dsw-alias-interactive-bg-active); }
.wsm-panel .wsm-tab > * { position: relative; }
.wsm-panel .wsm-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary); }
.wsm-panel .wsm-tab:focus-visible { outline: none; }
.wsm-panel .wsm-tab:focus-visible::before { box-shadow: inset 0 0 0 2px var(--dsw-alias-state-business-primary); }
.wsm-panel .wsm-tab-count {
  min-width: 17px; height: 17px; padding: 0 5px; border-radius: 999px;
  display: inline-grid; place-items: center;
  font-size: 11px; line-height: 17px; font-weight: 500; font-variant-numeric: tabular-nums;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  color: var(--dsw-alias-state-business-primary);
}
.wsm-panel .wsm-tab-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--dsw-alias-state-warn-primary); }
.wsm-panel .wsm-nav-ink {
  position: absolute; left: 0; bottom: 0; height: 2px; width: 0;
  border-radius: 2px 2px 0 0; background: var(--dsw-alias-label-primary);
  pointer-events: none; opacity: 0;
}
.wsm-panel .wsm-nav-ink[data-ready] { opacity: 1; transition: transform .2s var(--wsm-ease), width .2s var(--wsm-ease); }
.wsm-panel .wsm-head-focus { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; padding-left: 4px; color: var(--dsw-alias-label-secondary); font-weight: 500; }
.wsm-panel .wsm-head-focus b { color: var(--dsw-alias-label-primary); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsm-panel .wsm-head-actions { display: flex; align-items: center; gap: 2px; flex: none; }

.wsm-panel .wsm-iconbtn {
  flex: none; display: inline-grid; place-items: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-caption); cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
@media (hover: hover) { .wsm-panel .wsm-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); } }
.wsm-panel .wsm-iconbtn:active { background: var(--dsw-alias-interactive-bg-active); }
.wsm-panel .wsm-iconbtn[aria-pressed="true"], .wsm-panel .wsm-iconbtn[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
.wsm-panel .wsm-iconbtn:disabled { opacity: .4; cursor: default; }
.wsm-panel .wsm-iconbtn[data-spin] .wsm-ic { animation: wsm-spin .7s linear infinite; }

.wsm-panel .wsm-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none;
  height: 36px; padding: 0 14px; border: 0; border-radius: 12px;
  font-size: 14px; line-height: 22px; white-space: nowrap; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-primary);
  transition: background-color .12s ease, box-shadow .12s ease, opacity .12s ease;
}
.wsm-panel .wsm-btn[data-size="sm"] { height: 28px; padding: 0 10px; font-size: 12px; line-height: 18px; border-radius: 8px; gap: 4px; }
.wsm-panel .wsm-btn[data-size="tb"] { height: 32px; padding: 0 12px; font-size: 13px; line-height: 20px; border-radius: 12px; }
.wsm-panel .wsm-btn[data-variant="primary"] { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
@media (hover: hover) { .wsm-panel .wsm-btn[data-variant="primary"]:not(:disabled):hover { background: var(--dsw-alias-button-primary-hover); } }
.wsm-panel .wsm-btn[data-variant="outline"] { box-shadow: inset 0 0 0 var(--dsh-hairline-width, .5px) var(--dsw-alias-border-l4); }
@media (hover: hover) { .wsm-panel .wsm-btn:is([data-variant="outline"], [data-variant="ghost"]):not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); } }
.wsm-panel .wsm-btn:is([data-variant="outline"], [data-variant="ghost"]):not(:disabled):active { background: var(--dsw-alias-interactive-bg-active); }
.wsm-panel .wsm-btn[data-variant="danger"] { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-on-color); }
@media (hover: hover) { .wsm-panel .wsm-btn[data-variant="danger"]:not(:disabled):hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 86%, var(--dsw-alias-label-primary)); } }
.wsm-panel .wsm-btn[data-variant="danger-outline"] { color: var(--dsw-alias-state-error-primary); box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent); }
@media (hover: hover) { .wsm-panel .wsm-btn[data-variant="danger-outline"]:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover-danger); } }
.wsm-panel .wsm-btn:disabled { opacity: .4; cursor: not-allowed; }
.wsm-panel .wsm-btn[data-busy] { cursor: progress; }
.wsm-panel .wsm-btn .wsm-spinner { width: 12px; height: 12px; }
.wsm-panel .wsm-linkbtn {
  display: inline-flex; align-items: center; gap: 2px; padding: 0; border: 0; background: none; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-size: inherit; text-decoration: underline; text-decoration-color: var(--dsw-alias-border-l4); text-underline-offset: 3px;
}
@media (hover: hover) { .wsm-panel .wsm-linkbtn:hover { color: var(--dsw-alias-label-primary); text-decoration-color: currentColor; } }
.wsm-panel .wsm-spinner { display: inline-block; width: 14px; height: 14px; border-radius: 999px; border: 1.5px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor; animation: wsm-spin .8s linear infinite; }

.wsm-panel .wsm-tag {
  display: inline-flex; align-items: center; gap: 3px; flex: none;
  max-width: 100%; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap;
  box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l4); color: var(--dsw-alias-label-tertiary);
}
.wsm-panel .wsm-tag > span { overflow: hidden; text-overflow: ellipsis; }
.wsm-panel .wsm-tag[data-tone="neutral"] { box-shadow: none; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-tag[data-tone="quiet"] { box-shadow: none; padding: 0; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-tag[data-tone="success"] { box-shadow: none; background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 72%, var(--dsw-alias-label-primary)); }
.wsm-panel .wsm-tag[data-tone="warning"] { box-shadow: none; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); color: var(--dsw-alias-state-warn-label); }
.wsm-panel .wsm-tag[data-tone="info"] { box-shadow: none; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); color: var(--dsw-alias-state-business-primary); }
.wsm-panel .wsm-tag[data-tone="danger"] { box-shadow: none; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color: var(--dsw-alias-state-error-primary); }
.wsm-panel .wsm-kbd {
  display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 5px;
  font: 500 11px/16px var(--wsm-mono); color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1); box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l4), 0 1px 0 var(--dsw-alias-border-l2);
}
.wsm-panel .wsm-dot { flex: none; width: 8px; height: 8px; border-radius: 999px; }
.wsm-panel .wsm-dot[data-k="verified"] { background: var(--dsw-alias-state-success-primary); }
.wsm-panel .wsm-dot[data-k="mismatch"] { background: var(--dsw-alias-state-warn-primary); }
.wsm-panel .wsm-dot[data-k="legacy"], .wsm-panel .wsm-dot[data-k="confidence"] { background: var(--dsw-alias-state-idle-primary); }
.wsm-panel .wsm-dot[data-k="agent"] { box-shadow: inset 0 0 0 1.5px var(--dsw-alias-label-caption); }
.wsm-panel .wsm-dot[data-k="none"] { display: none; }

.wsm-panel .wsm-seg {
  position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px;
  padding: 3px; border-radius: 11px; background: var(--dsw-alias-interactive-bg-hover); flex: none; max-width: 100%;
}
.wsm-panel .wsm-seg-ink {
  position: absolute; top: 3px; bottom: 3px; left: 3px;
  width: calc((100% - 6px - (var(--n) - 1) * 2px) / var(--n));
  transform: translateX(calc(var(--i) * (100% + 2px)));
  border-radius: 8px; background: var(--dsw-alias-bg-layer-1);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l3);
  box-shadow: var(--dsw-elevation-soft);
  transition: transform .18s var(--wsm-ease);
}
.wsm-panel .wsm-seg > button {
  position: relative; z-index: 1; min-width: 0;
  height: 26px; padding: 0 12px; border: 0; border-radius: 8px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-weight: 500; white-space: nowrap; transition: color .16s ease;
}
.wsm-panel .wsm-seg > button[aria-checked="true"] { color: var(--dsw-alias-label-primary); }
@media (hover: hover) { .wsm-panel .wsm-seg > button:hover { color: var(--dsw-alias-label-primary); } }
.wsm-panel .wsm-seg > button:focus-visible { outline-offset: -2px; }
.wsm-panel .wsm-seg[data-size="sm"] { padding: 2px; border-radius: 9px; }
.wsm-panel .wsm-seg[data-size="sm"] .wsm-seg-ink { top: 2px; bottom: 2px; left: 2px; width: calc((100% - 4px - (var(--n) - 1) * 2px) / var(--n)); border-radius: 7px; }
.wsm-panel .wsm-seg[data-size="sm"] > button { height: 22px; padding: 0 9px; font-size: 12px; line-height: 18px; border-radius: 7px; }
.wsm-panel .wsm-seg[data-stretch] { display: grid; width: 100%; }

.wsm-panel .wsm-input {
  display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 6px 0 8px; min-width: 0;
  border-radius: 12px; background: var(--dsw-alias-bg-layer-1);
  box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l4);
  color: var(--dsw-alias-label-tertiary); transition: box-shadow .12s ease;
}
.wsm-panel .wsm-input:focus-within { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary); }
.wsm-panel .wsm-input input {
  flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0; background: transparent;
  font-size: 13px; color: var(--dsw-alias-label-primary);
}
.wsm-panel .wsm-input input::placeholder { color: var(--dsw-alias-label-caption); }
.wsm-panel .wsm-input input:focus-visible { outline: none; }
.wsm-panel .wsm-input .wsm-kbd { opacity: .9; }
.wsm-panel .wsm-input .wsm-iconbtn { width: 22px; height: 22px; border-radius: 6px; }
.wsm-panel .wsm-field {
  width: 100%; min-width: 0; border: 0; outline: 0; resize: none;
  border-radius: 12px; background: var(--dsw-alias-bg-layer-1);
  box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l4);
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 22px; padding: 10px 12px;
  transition: box-shadow .12s ease;
}
.wsm-panel .wsm-field:focus { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary); }
.wsm-panel .wsm-field:focus-visible { outline: none; }
.wsm-panel .wsm-field[aria-invalid="true"] { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-error-primary); }
.wsm-panel .wsm-field::placeholder { color: var(--dsw-alias-label-caption); }
.wsm-panel .wsm-err { display: flex; align-items: flex-start; gap: 6px; margin-top: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.wsm-panel .wsm-err .wsm-ic { margin-top: 2px; }

.wsm-panel .wsm-select {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  height: 28px; padding: 0 6px 0 8px; margin-left: -8px; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap;
  transition: background-color .12s ease;
}
.wsm-panel .wsm-select > span { overflow: hidden; text-overflow: ellipsis; }
.wsm-panel .wsm-select .wsm-ic { color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-select .wsm-select-chev { color: var(--dsw-alias-label-caption); transition: transform .12s ease; }
.wsm-panel .wsm-select[aria-expanded="true"] .wsm-select-chev { transform: rotate(180deg); }
@media (hover: hover) { .wsm-panel .wsm-select:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.wsm-panel .wsm-select[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-active); }
.wsm-panel .wsm-select[data-changed] { box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 60%, transparent); }

.wsm-panel .wsm-main { flex: 1; min-height: 0; display: flex; position: relative; }
.wsm-panel .wsm-scroll { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; overscroll-behavior: contain; }
.wsm-panel .wsm-view { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; animation: wsm-fade .16s var(--wsm-ease); }
.wsm-panel .wsm-page { width: 100%; max-width: 960px; margin: 0 auto; padding: 20px var(--wsm-gutter) 40px; }
.wsm-panel .wsm-pagehead { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 8px 16px; }
.wsm-panel .wsm-pagehead-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wsm-panel .wsm-h1 { font-size: 16px; line-height: 24px; font-weight: 500; letter-spacing: .005em; }
.wsm-panel:not([data-size="narrow"]) .wsm-h1 { font-size: 20px; line-height: 28px; }
.wsm-panel .wsm-pagesub { color: var(--dsw-alias-label-secondary); text-wrap: pretty; }
.wsm-panel .wsm-ws {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  color: var(--dsw-alias-label-secondary); font-size: 13px;
}
.wsm-panel .wsm-ws .wsm-ic { color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-ws span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsm-panel .wsm-section { margin-top: 28px; min-width: 0; }
.wsm-panel .wsm-section-head { display: flex; align-items: baseline; gap: 8px; min-height: 22px; }
.wsm-panel .wsm-h2 { font-size: 14px; line-height: 22px; font-weight: 500; }
.wsm-panel .wsm-count { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.wsm-panel .wsm-section-aside { margin-left: auto; display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.wsm-panel .wsm-section-sub { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); text-wrap: pretty; }
.wsm-panel .wsm-section-body { margin-top: 12px; }

.wsm-panel .wsm-banner {
  display: flex; align-items: center; gap: 12px; margin-top: 16px; padding: 12px 12px 12px 14px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, var(--dsw-alias-bg-layer-1));
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent);
}
.wsm-panel .wsm-banner-ic { flex: none; width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }
.wsm-panel .wsm-banner-main { flex: 1; min-width: 0; }
.wsm-panel .wsm-banner-title { font-weight: 500; font-size: 14px; line-height: 20px; }
.wsm-panel .wsm-banner-sub { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); text-wrap: pretty; }
.wsm-panel[data-size="narrow"] .wsm-banner { flex-wrap: wrap; align-items: flex-start; }
.wsm-panel[data-size="narrow"] .wsm-banner-main { flex: 1 1 calc(100% - 44px); }
.wsm-panel[data-size="narrow"] .wsm-banner .wsm-btn { margin-left: 44px; }

.wsm-panel .wsm-map { display: grid; grid-template-columns: 22px minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.wsm-panel .wsm-map-corner { grid-column: 1; }
.wsm-panel .wsm-map-colhead { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0 4px 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; font-weight: 500; }
.wsm-panel .wsm-map-colhead .wsm-ic { color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-map-colhead small { font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsm-panel .wsm-map-rowhead {
  writing-mode: vertical-rl; display: flex; align-items: center; justify-content: center; gap: 6px;
  border-radius: 11px; background: var(--wsm-tint-1);
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 22px; font-weight: 500; letter-spacing: .14em;
}
.wsm-panel .wsm-map-rowhead .wsm-ic { color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-cell {
  position: relative; display: flex; flex-direction: column; align-items: stretch; gap: 0;
  min-width: 0; min-height: 156px; padding: 14px 16px 12px; border: 0; border-radius: 16px; text-align: left; cursor: pointer;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l2);
  transition: box-shadow .16s ease, background-color .16s ease, transform .16s var(--wsm-ease);
  overflow: hidden; isolation: isolate;
}
.wsm-panel .wsm-cell[data-load="always"] { background: color-mix(in srgb, var(--dsw-alias-label-primary) 2.5%, var(--dsw-alias-bg-layer-1)); }

.wsm-panel .wsm-cell[data-load="always"]::after {
  content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background-image: repeating-linear-gradient(135deg, var(--wsm-tint-1) 0 1px, transparent 1px 9px);
  -webkit-mask-image: radial-gradient(120% 90% at 100% 0%, var(--dsw-alias-label-primary) 0%, transparent 62%);
          mask-image: radial-gradient(120% 90% at 100% 0%, var(--dsw-alias-label-primary) 0%, transparent 62%);
}
@media (hover: hover) {
  .wsm-panel .wsm-cell:hover { box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l4), var(--dsw-elevation-panel); --dsw-elevation-stroke-color: transparent; }
  .wsm-panel .wsm-cell:hover .wsm-cell-go { opacity: 1; transform: none; }
}
.wsm-panel .wsm-cell:active { transform: scale(.995); }
.wsm-panel .wsm-cell:focus-visible { outline-offset: 2px; }
.wsm-panel .wsm-cell-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
.wsm-panel .wsm-cell-glyph { flex: none; width: 30px; height: 30px; border-radius: 10px; display: grid; place-items: center; color: var(--dsw-alias-label-secondary); background: var(--wsm-tint-2); }
.wsm-panel .wsm-cell[data-load="always"] .wsm-cell-glyph { color: var(--dsw-alias-label-primary); background: var(--wsm-tint-3); }
.wsm-panel .wsm-cell-name { flex: 1; min-width: 0; font-size: 14px; line-height: 20px; font-weight: 500; }
.wsm-panel .wsm-cell-go { flex: none; color: var(--dsw-alias-label-caption); opacity: 0; transform: translateX(-3px); transition: opacity .16s ease, transform .16s var(--wsm-ease); }
.wsm-panel .wsm-cell-axes { display: none; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
.wsm-panel .wsm-cell-desc { margin-top: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); text-wrap: pretty; }
.wsm-panel .wsm-cell-metric { margin-top: auto; padding-top: 14px; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.wsm-panel .wsm-cell-big { font-size: 22px; line-height: 28px; font-weight: 500; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.wsm-panel .wsm-cell-unit { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-cell-right { margin-left: auto; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.wsm-panel .wsm-cell-right[data-warn] { color: var(--dsw-alias-state-warn-label); }
.wsm-panel .wsm-cell-sub { margin-top: auto; padding-top: 14px; display: flex; flex-direction: column; gap: 4px; }
.wsm-panel .wsm-cell-subrow { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-cell-subrow b { font-weight: 500; color: var(--dsw-alias-label-primary); min-width: 2.6em; }
.wsm-panel .wsm-cell-subrow i { font-style: normal; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-cell-subrow .wsm-num { margin-left: auto; }
.wsm-panel .wsm-cell-foot { margin-top: 8px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.wsm-panel .wsm-cell-empty { margin-top: auto; padding-top: 14px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.wsm-panel[data-size="narrow"] .wsm-map { grid-template-columns: minmax(0, 1fr); }
.wsm-panel[data-size="narrow"] :is(.wsm-map-corner, .wsm-map-colhead, .wsm-map-rowhead) { display: none; }
.wsm-panel[data-size="narrow"] .wsm-cell { min-height: 0; }
.wsm-panel[data-size="narrow"] .wsm-cell-axes { display: flex; }
.wsm-panel[data-size="narrow"] .wsm-cell-go { opacity: 1; transform: none; }

.wsm-panel .wsm-meter { position: relative; height: 4px; margin-top: 8px; border-radius: 999px; background: var(--wsm-tint-2); overflow: hidden; }
.wsm-panel .wsm-meter > span { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: color-mix(in srgb, var(--dsw-alias-label-primary) 72%, transparent); transition: width .3s var(--wsm-ease); }
.wsm-panel .wsm-meter[data-level="warn"] > span { background: var(--dsw-alias-state-warn-primary); }
.wsm-panel .wsm-meter[data-level="over"] > span { background: var(--dsw-alias-state-error-primary); }
.wsm-panel .wsm-meter[data-thin] { height: 3px; }

.wsm-panel .wsm-cost { padding: 14px 16px; border-radius: 16px; box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.wsm-panel .wsm-cost-total { display: flex; align-items: baseline; gap: 6px; }
.wsm-panel .wsm-cost-total b { font-size: 22px; line-height: 28px; font-weight: 500; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.wsm-panel .wsm-cost-total span { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.wsm-panel .wsm-cost-total em { margin-left: auto; font-style: normal; font-size: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.wsm-panel .wsm-stack { display: flex; gap: 2px; height: 12px; margin-top: 10px; }
.wsm-panel .wsm-stack > span { min-width: 6px; border-radius: 3px; background: color-mix(in srgb, var(--dsw-alias-label-primary) var(--p), transparent); transition: flex-grow .3s var(--wsm-ease); }
.wsm-panel .wsm-stack > span:first-child { border-top-left-radius: 999px; border-bottom-left-radius: 999px; }
.wsm-panel .wsm-stack > span:last-child { border-top-right-radius: 999px; border-bottom-right-radius: 999px; }
.wsm-panel .wsm-stack > span[data-hatch] { background-image: repeating-linear-gradient(135deg, color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent) 0 2px, transparent 2px 4px); background-color: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); }
.wsm-panel .wsm-legend { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; column-gap: 10px; row-gap: 6px; margin-top: 12px; align-items: center; font-size: 12px; line-height: 18px; }
.wsm-panel .wsm-legend-sw { width: 10px; height: 10px; border-radius: 3px; background: color-mix(in srgb, var(--dsw-alias-label-primary) var(--p), transparent); }
.wsm-panel .wsm-legend-sw[data-hatch] { background-image: repeating-linear-gradient(135deg, color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent) 0 2px, transparent 2px 4px); background-color: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); }
.wsm-panel .wsm-legend-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-legend-v { text-align: right; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.wsm-panel .wsm-legend-t { text-align: right; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; min-width: 6.5em; }
.wsm-panel .wsm-cost-tip { display: flex; align-items: center; gap: 6px; margin-top: 12px; padding-top: 10px; border-top: .5px solid var(--dsw-alias-border-l2); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

.wsm-panel .wsm-rows { display: flex; flex-direction: column; gap: 2px; margin: 0 -8px; padding: 0; list-style: none; }
.wsm-panel .wsm-row {
  position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0;
  padding: 8px; border: 0; border-radius: 20px; background: transparent; text-align: left; cursor: pointer;
  transition: background-color .12s ease;
}
@media (hover: hover) { .wsm-panel .wsm-row:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.wsm-panel .wsm-row:active { background: var(--dsw-alias-interactive-bg-active); }
.wsm-panel .wsm-row[aria-selected="true"] { background: var(--dsw-alias-interactive-bg-active); }
.wsm-panel .wsm-row:focus-visible { outline-offset: -2px; }
.wsm-panel .wsm-row-ic { flex: none; width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; color: var(--dsw-alias-label-secondary); box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); }
.wsm-panel .wsm-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wsm-panel .wsm-row-title { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 14px; line-height: 20px; font-weight: 500; }
.wsm-panel .wsm-row-title > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsm-panel .wsm-rows[data-wrap] .wsm-row { align-items: flex-start; }
.wsm-panel .wsm-rows[data-wrap] .wsm-row-title > span { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.wsm-panel .wsm-rows[data-wrap] .wsm-row-end { padding-top: 1px; }
.wsm-panel .wsm-scopetag { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 999px; font-size: 10px; line-height: 1; font-weight: 500; white-space: nowrap; color: var(--dsw-alias-label-tertiary); box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l4); }
.wsm-panel .wsm-scopetag[data-scope="global"] { color: var(--dsw-alias-label-secondary); background: var(--wsm-tint-1); }
.wsm-panel .wsm-row-desc { font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsm-panel .wsm-row-end { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.wsm-panel .wsm-row-time { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; white-space: nowrap; }
.wsm-panel .wsm-row-meta { display: flex; align-items: center; gap: 5px; }
.wsm-panel .wsm-row-meta .wsm-dot { width: 7px; height: 7px; }
.wsm-panel:not([data-size="wide"]) .wsm-mlist .wsm-row { gap: 10px; }
.wsm-panel:not([data-size="wide"]) .wsm-mlist .wsm-row-ic { width: 32px; height: 32px; border-radius: 11px; }
.wsm-panel .wsm-row-unsaved { flex: none; width: 6px; height: 6px; border-radius: 999px; background: var(--dsw-alias-state-warn-primary); }
.wsm-panel .wsm-rows[data-compact] .wsm-row { border-radius: 12px; padding: 6px 8px; gap: 10px; }
.wsm-panel .wsm-rows[data-compact] .wsm-row-ic { width: 28px; height: 28px; border-radius: 9px; }
.wsm-panel .wsm-rows[data-compact] .wsm-row-title { font-size: 13px; }
.wsm-panel .wsm-rows[data-compact] .wsm-row-desc { font-size: 12px; }
.wsm-panel .wsm-sub-glyph { display: inline-flex; align-items: center; gap: 4px; }
.wsm-panel .wsm-sub-glyph .wsm-ic { color: var(--dsw-alias-label-caption); }

.wsm-panel .wsm-ov-grid { display: grid; grid-template-columns: minmax(0, 1fr); column-gap: 32px; }
.wsm-panel[data-size="wide"] .wsm-ov-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.wsm-panel .wsm-disclose {
  display: flex; align-items: center; gap: 8px; width: calc(100% + 16px); margin: 0 -8px; padding: 8px;
  border: 0; border-radius: 12px; background: transparent; cursor: pointer; text-align: left;
}
@media (hover: hover) { .wsm-panel .wsm-disclose:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.wsm-panel .wsm-disclose .wsm-h2 { flex: 1; }
.wsm-panel .wsm-disclose .wsm-ic { color: var(--dsw-alias-label-caption); transition: transform .16s var(--wsm-ease); }
.wsm-panel .wsm-disclose[aria-expanded="true"] .wsm-ic:last-child { transform: rotate(180deg); }
.wsm-panel .wsm-flow { margin-top: 8px; padding: 4px 0 0; animation: wsm-fade .16s var(--wsm-ease); }
.wsm-panel .wsm-flow-row { display: grid; grid-template-columns: 20px minmax(0, 1fr); column-gap: 10px; }
.wsm-panel .wsm-flow-rail { position: relative; display: flex; justify-content: center; }
.wsm-panel .wsm-flow-rail svg { position: relative; z-index: 1; margin-top: 4px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-base); }
.wsm-panel .wsm-flow-row:not(:last-child) .wsm-flow-rail::before { content: ''; position: absolute; top: 18px; bottom: -4px; left: 50%; width: 0; border-left: 1px dashed var(--dsw-alias-border-l4); }
.wsm-panel .wsm-flow-body { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding-bottom: 14px; min-width: 0; }
.wsm-panel .wsm-flow-q { color: var(--dsw-alias-label-primary); text-wrap: pretty; }
.wsm-panel .wsm-flow-yes { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.wsm-panel .wsm-flow-yes svg { color: var(--dsw-alias-label-caption); }
.wsm-panel .wsm-flow-dest {
  display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px 0 7px; border-radius: 999px;
  background: var(--wsm-tint-2); color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 500; white-space: nowrap;
}
.wsm-panel .wsm-flow-dest .wsm-ic { color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-flow-note { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-flow-aside { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 2px; padding: 10px 12px; border-radius: 12px; background: var(--wsm-tint-1); color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-flow-aside .wsm-flow-dest { background: transparent; box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l4); }

.wsm-panel .wsm-pending .wsm-page { max-width: 760px; padding-bottom: 24px; }
.wsm-panel .wsm-drafts { margin-top: 16px; }
.wsm-panel .wsm-draft-slot { padding-bottom: 14px; }
.wsm-panel .wsm-draft {
  position: relative; border-radius: 20px; background: var(--dsw-alias-bg-layer-1);
  box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l2);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  transition: box-shadow .16s ease;
  overflow: hidden;
}
.wsm-panel .wsm-draft:focus-visible { outline-offset: 2px; }
.wsm-panel .wsm-draft[data-current] { box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l4), var(--dsw-elevation-panel); --dsw-elevation-stroke-color: transparent; }
.wsm-panel .wsm-dest {
  display: flex; align-items: flex-start; gap: 10px; padding: 12px 16px 11px;
  background: var(--wsm-tint-1); border-bottom: .5px solid var(--dsw-alias-border-l2);
}
.wsm-panel .wsm-dest-glyph { flex: none; width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; background: var(--wsm-tint-2); color: var(--dsw-alias-label-primary); margin-top: 1px; }
.wsm-panel .wsm-dest-main { flex: 1; min-width: 0; }
.wsm-panel .wsm-dest-line { display: flex; flex-wrap: wrap; align-items: center; column-gap: 6px; row-gap: 2px; font-size: 13px; line-height: 20px; }
.wsm-panel .wsm-dest-arrow { color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-dest-name { font-weight: 600; }
.wsm-panel .wsm-dest-what { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.wsm-panel[data-size="narrow"] .wsm-dest-sep { display: none; }
.wsm-panel[data-size="narrow"] .wsm-dest-what { flex-basis: 100%; }
.wsm-panel .wsm-dest-pos { margin-left: 6px; display: inline-flex; align-items: center; gap: 3px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); cursor: help; border-bottom: 1px dotted var(--dsw-alias-border-l4); }
.wsm-panel .wsm-why { display: flex; align-items: flex-start; gap: 6px; margin-top: 3px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); text-wrap: pretty; }
.wsm-panel .wsm-why .wsm-ic { margin-top: 2px; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-why[data-tone="warn"] .wsm-ic { color: var(--dsw-alias-state-warn-primary); }
.wsm-panel .wsm-draft-body { padding: 14px 16px 4px; }
.wsm-panel .wsm-draft-title { font-size: 16px; line-height: 24px; font-weight: 500; text-wrap: pretty; }
.wsm-panel .wsm-draft-desc { margin-top: 2px; color: var(--dsw-alias-label-secondary); text-wrap: pretty; }
.wsm-panel .wsm-draft-desc small { color: var(--dsw-alias-label-caption); font-size: 11px; margin-right: 6px; }
.wsm-panel .wsm-block { margin-top: 14px; }
.wsm-panel .wsm-draft-note { display: inline-flex; align-items: center; gap: 5px; margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); cursor: help; }
.wsm-panel .wsm-block-head { display: flex; align-items: center; gap: 8px; min-height: 26px; margin-bottom: 8px; }
.wsm-panel .wsm-block-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-block-head .wsm-seg { margin-left: auto; }
.wsm-panel .wsm-block-note { display: flex; align-items: flex-start; gap: 6px; margin-top: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); text-wrap: pretty; }
.wsm-panel .wsm-block-note .wsm-ic { margin-top: 2px; }
.wsm-panel .wsm-meta-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 12px; }
.wsm-panel .wsm-content-box { padding: 12px 14px; border-radius: 14px; background: var(--dsw-alias-bg-base); box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l2); }
.wsm-panel .wsm-also {
  display: flex; align-items: flex-start; gap: 8px; margin-top: 10px; padding: 8px 10px; border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 5%, transparent); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.wsm-panel .wsm-also b { font-weight: 500; color: var(--dsw-alias-label-primary); }
.wsm-panel .wsm-also > .wsm-ic { margin-top: 2px; color: var(--dsw-alias-state-error-primary); }
.wsm-panel .wsm-also p { min-width: 0; text-wrap: pretty; }
.wsm-panel .wsm-also .wsm-glyph { display: inline-block; vertical-align: -1px; margin: 0 3px 0 4px; color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-also .wsm-linkbtn { margin-left: 4px; }
.wsm-panel .wsm-draft-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px 14px; margin-top: 10px; border-top: .5px solid var(--dsw-alias-border-l2); }
.wsm-panel .wsm-draft-when { flex: 1; min-width: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.wsm-panel[data-size="narrow"] .wsm-draft-foot { flex-wrap: wrap; }
.wsm-panel[data-size="narrow"] .wsm-draft-when { flex-basis: 100%; }
.wsm-panel[data-size="narrow"] .wsm-draft-foot .wsm-btn { flex: 1; }
.wsm-panel .wsm-draft-err { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 10px 12px; border-radius: 12px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; animation: wsm-fade .16s ease; }
.wsm-panel .wsm-draft-err .wsm-ic { margin-top: 2px; }
.wsm-panel .wsm-keyhints {
  flex: none; display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 4px 14px;
  min-height: 34px; padding: 6px 12px; border-top: .5px solid var(--dsw-alias-border-l2);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-base);
}
.wsm-panel .wsm-keyhints span { display: inline-flex; align-items: center; gap: 4px; }

.wsm-panel .wsm-quote { position: relative; padding: 12px 14px 10px 36px; border-radius: 14px; background: var(--dsw-alias-bg-module-platform); }
.wsm-panel .wsm-quote::before { content: '\\201C'; position: absolute; left: 12px; top: 4px; font: 500 30px/36px Georgia, 'Times New Roman', serif; color: var(--dsw-alias-label-caption); }
.wsm-panel .wsm-quote-text { color: var(--dsw-alias-label-primary); line-height: 21px; text-wrap: pretty; overflow-wrap: anywhere; }
.wsm-panel .wsm-quote-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-quote[data-k="mismatch"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, var(--dsw-alias-bg-layer-1)); box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent); }
.wsm-panel .wsm-src { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); cursor: help; white-space: nowrap; }
.wsm-panel .wsm-src[data-k="verified"] .wsm-ic { color: var(--dsw-alias-state-success-primary); }
.wsm-panel .wsm-src[data-k="mismatch"] { color: var(--dsw-alias-state-warn-label); }
.wsm-panel .wsm-src[data-k="mismatch"] .wsm-ic { color: var(--dsw-alias-state-warn-primary); }
.wsm-panel .wsm-src[data-k="legacy"] .wsm-ic, .wsm-panel .wsm-src[data-k="agent"] .wsm-ic { color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-src[data-k="confidence"] { color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.wsm-panel .wsm-src-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 10px 12px; border-radius: 12px; background: var(--wsm-tint-1); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

.wsm-panel .wsm-diff { border-radius: 14px; overflow: hidden; box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); font-size: 13px; line-height: 21px; }
.wsm-panel .wsm-diff-row { display: grid; grid-template-columns: 22px minmax(0, 1fr); min-height: 21px; }
.wsm-panel .wsm-diff-row > i { font-style: normal; text-align: center; font: 12px/21px var(--wsm-mono); color: var(--dsw-alias-label-caption); user-select: none; }
.wsm-panel .wsm-diff-row > span { padding: 0 12px 0 2px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-diff-row:first-child { padding-top: 4px; } .wsm-panel .wsm-diff-row:last-child { padding-bottom: 4px; }
.wsm-panel .wsm-diff-row[data-t="-"] { background: var(--dsw-alias-file-diff-deleted-bg); }
.wsm-panel .wsm-diff-row[data-t="-"] > i { color: var(--dsw-alias-file-diff-deleted-marker); }
.wsm-panel .wsm-diff-row[data-t="-"] > span { color: var(--dsw-alias-label-primary); }
.wsm-panel .wsm-diff-row[data-t="+"] { background: var(--dsw-alias-file-diff-added-bg); }
.wsm-panel .wsm-diff-row[data-t="+"] > i { color: var(--dsw-alias-file-diff-added-marker); }
.wsm-panel .wsm-diff-row[data-t="+"] > span { color: var(--dsw-alias-label-primary); }
.wsm-panel .wsm-diff del { text-decoration: line-through; text-decoration-color: var(--dsw-alias-file-diff-deleted-marker); background: color-mix(in srgb, var(--dsw-alias-file-diff-deleted-marker) 18%, transparent); border-radius: 3px; }
.wsm-panel .wsm-diff ins { text-decoration: none; background: color-mix(in srgb, var(--dsw-alias-file-diff-added-marker) 22%, transparent); border-radius: 3px; }
.wsm-panel .wsm-diff-row[data-t="-"]:not([data-inline]) > span { text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--dsw-alias-file-diff-deleted-marker) 70%, transparent); }
.wsm-panel .wsm-diff-row[data-t="gap"] > span { color: var(--dsw-alias-label-caption); font-size: 12px; }
.wsm-panel .wsm-diff-row[data-blank] { min-height: 10px; } .wsm-panel .wsm-diff-row[data-blank] > * { line-height: 10px; }
.wsm-panel .wsm-diff-title { display: flex; align-items: baseline; gap: 8px; padding: 6px 12px 6px 10px; border-bottom: .5px solid var(--dsw-alias-border-l2); font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-diff-title > span { flex: 1; min-width: 0; font-size: 13px; color: var(--dsw-alias-label-primary); }
.wsm-panel .wsm-diff-legend { display: inline-flex; align-items: center; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-diff-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: -0px; }
.wsm-panel .wsm-diff-legend i[data-t="-"] { background: var(--dsw-alias-file-diff-deleted-marker); }
.wsm-panel .wsm-diff-legend i[data-t="+"] { background: var(--dsw-alias-file-diff-added-marker); }

.wsm-panel .wsm-md { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 22px; overflow-wrap: anywhere; }
.wsm-panel .wsm-md > * + * { margin-top: 8px; }
.wsm-panel .wsm-md :is(h1, h2, h3, h4, h5, h6) { font-weight: 500; margin-top: 14px; }
.wsm-panel .wsm-md > :first-child { margin-top: 0; }
.wsm-panel .wsm-md h1 { font-size: 15px; line-height: 24px; } .wsm-panel .wsm-md h2 { font-size: 14px; line-height: 22px; } .wsm-panel .wsm-md :is(h3, h4, h5, h6) { font-size: 13px; line-height: 22px; color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-md :is(ul, ol) { padding-left: 20px; }
.wsm-panel .wsm-md li + li { margin-top: 3px; }
.wsm-panel .wsm-md li::marker { color: var(--dsw-alias-label-caption); }
.wsm-panel .wsm-md code { font-family: var(--wsm-mono); font-size: 12px; padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-markdown-inline-code); box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l2); }
.wsm-panel .wsm-md pre { padding: 10px 12px; border-radius: 12px; background: var(--dsw-alias-markdown-code-block); overflow-x: auto; font: 12px/19px var(--wsm-mono); }
.wsm-panel .wsm-md pre code { padding: 0; background: none; box-shadow: none; }
.wsm-panel .wsm-md a { color: var(--dsw-alias-link); text-decoration: none; }
.wsm-panel .wsm-md a:hover { text-decoration: underline; text-underline-offset: 3px; }
.wsm-panel .wsm-md blockquote { padding-left: 10px; border-left: 2px solid var(--dsw-alias-markdown-citation); color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-md hr { border: 0; border-top: .5px solid var(--dsw-alias-border-l2); }
.wsm-panel .wsm-md[data-muted] { color: var(--dsw-alias-label-secondary); }

.wsm-panel .wsm-instr .wsm-page { max-width: 1040px; }
.wsm-panel .wsm-filehead { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px 16px; margin-top: 18px; }
.wsm-panel .wsm-filehead-main { flex: 1 1 260px; min-width: 0; }
.wsm-panel .wsm-filehead-title { display: flex; align-items: center; gap: 8px; font-size: 15px; line-height: 22px; font-weight: 500; }
.wsm-panel .wsm-filehead-sub { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; text-wrap: pretty; }
.wsm-panel .wsm-pathchip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; height: 20px; padding: 0 6px; border-radius: 6px; background: var(--dsw-alias-bg-module-platform); font: 11.5px/20px var(--wsm-mono); color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: default; }
.wsm-panel .wsm-budget { flex: 0 1 240px; min-width: 180px; }
.wsm-panel[data-size="narrow"] .wsm-budget { flex-basis: 100%; }
.wsm-panel .wsm-budget-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-budget-top b { font-weight: 500; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.wsm-panel .wsm-split { display: inline-flex; flex: none; }
.wsm-panel .wsm-split > .wsm-btn:first-child { border-top-right-radius: 0; border-bottom-right-radius: 0; padding-right: 10px; }
.wsm-panel .wsm-split > .wsm-btn:last-child { border-top-left-radius: 0; border-bottom-left-radius: 0; padding: 0 8px; margin-left: -.5px; }
.wsm-panel .wsm-instr-layout { display: grid; grid-template-columns: minmax(0, 1fr); column-gap: 28px; margin-top: 18px; }
.wsm-panel:not([data-size="narrow"]) .wsm-instr-layout { grid-template-columns: 184px minmax(0, 1fr); }
.wsm-panel[data-size="wide"] .wsm-instr-layout { grid-template-columns: 208px minmax(0, 1fr); }
.wsm-panel[data-focus] .wsm-instr-layout { grid-template-columns: minmax(0, 1fr); }
.wsm-panel[data-focus] .wsm-toc { display: none; }
.wsm-panel .wsm-toc { position: sticky; top: 12px; align-self: start; max-height: calc(100vh - 180px); overflow-y: auto; }
.wsm-panel .wsm-toc-label { padding: 0 8px 6px; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-toc ol { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 1px; }
.wsm-panel .wsm-toc button {
  position: relative; display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 5px 8px; border: 0; border-radius: 10px;
  background: transparent; text-align: left; cursor: pointer; color: var(--dsw-alias-label-secondary); transition: background-color .12s ease, color .12s ease;
}
.wsm-panel .wsm-toc button i { font-style: normal; min-width: 1.2em; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; font-size: 12px; }
.wsm-panel .wsm-toc button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (hover: hover) { .wsm-panel .wsm-toc button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.wsm-panel .wsm-toc button[aria-current="true"] { color: var(--dsw-alias-label-primary); font-weight: 500; background: var(--dsw-alias-interactive-bg-active); }
.wsm-panel .wsm-toc button[aria-current="true"] i { color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-toc-drop { position: sticky; top: 0; z-index: 2; margin: 0 calc(-1 * var(--wsm-gutter)); padding: 8px var(--wsm-gutter); background: var(--dsw-alias-bg-base); border-bottom: .5px solid var(--dsw-alias-border-l2); }
.wsm-panel .wsm-toc-drop .wsm-select { margin-left: -8px; max-width: calc(100% + 8px); font-weight: 500; }
.wsm-panel .wsm-preamble { margin-bottom: 8px; border-radius: 14px; background: var(--wsm-tint-1); }
.wsm-panel .wsm-preamble > button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 12px; border: 0; background: transparent; cursor: pointer; text-align: left; border-radius: 14px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.wsm-panel .wsm-preamble > button b { font-weight: 500; color: var(--dsw-alias-label-primary); font-size: 13px; }
.wsm-panel .wsm-preamble > button .wsm-ic:last-child { margin-left: auto; color: var(--dsw-alias-label-caption); transition: transform .16s var(--wsm-ease); }
.wsm-panel .wsm-preamble > button[aria-expanded="true"] .wsm-ic:last-child { transform: rotate(180deg); }
.wsm-panel .wsm-preamble .wsm-md { padding: 0 12px 12px; }
.wsm-panel .wsm-chap { position: relative; padding: 16px 0 18px; border-top: .5px solid var(--dsw-alias-border-l2); scroll-margin-top: 12px; }
.wsm-panel .wsm-chap:first-of-type { border-top: 0; }
.wsm-panel .wsm-chap-head { display: flex; align-items: center; gap: 10px; min-height: 28px; margin-bottom: 6px; }
.wsm-panel .wsm-chap-num { flex: none; display: inline-grid; place-items: center; min-width: 24px; height: 22px; padding: 0 6px; border-radius: 7px; background: var(--wsm-tint-2); color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.wsm-panel .wsm-chap-title { flex: 1; min-width: 0; font-size: 15px; line-height: 22px; font-weight: 500; overflow-wrap: anywhere; }
.wsm-panel .wsm-chap-bytes { flex: none; font-size: 11px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.wsm-panel .wsm-chap-actions { flex: none; display: flex; align-items: center; gap: 2px; opacity: 0; transition: opacity .12s ease; }
.wsm-panel .wsm-chap:is(:hover, :focus-within) .wsm-chap-actions, .wsm-panel[data-size="narrow"] .wsm-chap-actions { opacity: 1; }
.wsm-panel .wsm-chap-actions .wsm-btn[data-size="sm"] { color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-chap .wsm-md { padding-left: 34px; }
.wsm-panel[data-size="narrow"] .wsm-chap .wsm-md { padding-left: 0; }
.wsm-panel .wsm-chap[data-flash] { animation: wsm-flash 1.8s ease; }
.wsm-panel .wsm-chap-edit { margin: 10px -12px 4px; padding: 12px; border-radius: 16px; background: var(--dsw-alias-bg-layer-1); box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l3), var(--dsw-elevation-panel); --dsw-elevation-stroke-color: transparent; animation: wsm-fade .14s ease; }
.wsm-panel .wsm-chap-edit-head { display: flex; align-items: center; gap: 10px; }
.wsm-panel .wsm-chap-input { flex: 1; min-width: 0; height: 34px; padding: 0 10px; border: 0; outline: 0; border-radius: 10px; background: var(--dsw-alias-bg-base); box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l4); font-size: 15px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.wsm-panel .wsm-chap-input:focus { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary); }
.wsm-panel .wsm-chap-input[aria-invalid="true"] { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-error-primary); }
.wsm-panel .wsm-chap-input:focus-visible { outline: none; }
.wsm-panel .wsm-chap-edit .wsm-field { margin-top: 10px; background: var(--dsw-alias-bg-base); min-height: 120px; font-family: var(--wsm-mono); font-size: 12.5px; line-height: 21px; }
.wsm-panel .wsm-chap-edit-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.wsm-panel .wsm-chap-edit-foot .wsm-hint { flex: 1; min-width: 0; }
.wsm-panel .wsm-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.wsm-panel .wsm-hint b { font-weight: 500; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.wsm-panel .wsm-hint b[data-up] { color: var(--dsw-alias-state-warn-label); }
.wsm-panel .wsm-addchap { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; height: 40px; margin-top: 6px; border: 0; border-radius: 14px; background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary); box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l3); transition: background-color .12s ease, color .12s ease; }
@media (hover: hover) { .wsm-panel .wsm-addchap:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.wsm-panel .wsm-projcards { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; margin-top: 16px; }
.wsm-panel[data-size="wide"] .wsm-projcards { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
.wsm-panel .wsm-projcard { border-radius: 20px; background: var(--dsw-alias-bg-layer-1); box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l2); overflow: hidden; }
.wsm-panel .wsm-projcard-head { display: flex; align-items: flex-start; gap: 12px; padding: 14px 14px 12px 16px; }
.wsm-panel .wsm-projcard-ic { flex: none; width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; color: var(--dsw-alias-label-secondary); background: var(--wsm-tint-2); }
.wsm-panel .wsm-projcard-main { flex: 1; min-width: 0; }
.wsm-panel .wsm-projcard-title { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 14px; line-height: 20px; font-weight: 500; }
.wsm-panel .wsm-projcard-sub { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-projcard-body { position: relative; padding: 4px 16px 16px; border-top: .5px solid var(--dsw-alias-border-l2); padding-top: 14px; }
.wsm-panel .wsm-projcard-body[data-clamp] { max-height: 300px; overflow: hidden; -webkit-mask-image: linear-gradient(var(--dsw-alias-label-primary) 70%, transparent); mask-image: linear-gradient(var(--dsw-alias-label-primary) 70%, transparent); }
.wsm-panel .wsm-projcard-more { display: flex; justify-content: center; padding: 0 16px 12px; }
.wsm-panel .wsm-projcard-missing { padding: 14px 16px 16px; border-top: .5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); text-wrap: pretty; }
.wsm-panel .wsm-projcard-missing p + p { margin-top: 10px; }
.wsm-panel .wsm-note { display: flex; align-items: flex-start; gap: 8px; margin-top: 14px; padding: 10px 12px; border-radius: 12px; background: var(--wsm-tint-1); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.wsm-panel .wsm-note .wsm-ic { margin-top: 2px; color: var(--dsw-alias-label-tertiary); }

.wsm-panel .wsm-mem { flex: 1; min-width: 0; min-height: 0; display: flex; }
.wsm-panel .wsm-mlist { flex: none; width: clamp(264px, 44%, 300px); min-width: 0; min-height: 0; display: flex; flex-direction: column; border-right: .5px solid var(--dsw-alias-border-l3); }
.wsm-panel[data-size="wide"] .wsm-mlist { width: 320px; }
.wsm-panel[data-size="narrow"] .wsm-mlist { width: auto; flex: 1; border-right: 0; }
.wsm-panel[data-focus] .wsm-mlist { display: none; }
.wsm-panel .wsm-mtools { flex: none; display: flex; flex-direction: column; gap: 10px; padding: 12px 16px 10px; }
.wsm-panel .wsm-mtools .wsm-seg { width: 100%; display: grid; }
.wsm-panel .wsm-libs { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-libs span { display: inline-flex; align-items: center; gap: 5px; cursor: default; }
.wsm-panel .wsm-libs b { font-weight: 500; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.wsm-panel .wsm-chips { display: flex; flex-wrap: wrap; gap: 6px 5px; }
.wsm-panel .wsm-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px; border: 0; border-radius: 999px; cursor: pointer;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: transparent;
  box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l3); transition: background-color .12s ease, color .12s ease, box-shadow .12s ease;
}
.wsm-panel .wsm-chip .wsm-ic { color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-chip i { font-style: normal; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
@media (hover: hover) { .wsm-panel .wsm-chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.wsm-panel .wsm-chip[aria-pressed="true"] { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-primary); box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border); }
.wsm-panel .wsm-chip[aria-pressed="true"] :is(.wsm-ic, i) { color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-chip:disabled { opacity: .45; cursor: default; }
.wsm-panel .wsm-mlist .wsm-scroll { padding: 2px 16px 20px; }
.wsm-panel .wsm-mlist .wsm-rows { margin: 0 -8px; }
.wsm-panel .wsm-detail { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
.wsm-panel[data-size="narrow"] .wsm-detail { animation: wsm-push .2s var(--wsm-ease); }
.wsm-panel .wsm-dbar { flex: none; display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 8px 0 12px; }
.wsm-panel[data-size="narrow"] .wsm-dbar { padding-left: 6px; }
.wsm-panel .wsm-crumb { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1; font-size: 12.5px; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-crumb span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsm-panel .wsm-crumb b { font-weight: 500; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.wsm-panel .wsm-back { display: inline-flex; align-items: center; gap: 2px; height: 28px; padding: 0 8px 0 4px; border: 0; border-radius: 8px; background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
@media (hover: hover) { .wsm-panel .wsm-back:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.wsm-panel .wsm-doc { width: 100%; max-width: 760px; margin: 0 auto; padding: 6px var(--wsm-gutter) 112px; }
.wsm-panel[data-focus][data-size="wide"] .wsm-doc { max-width: 1180px; }
.wsm-panel .wsm-doc-title, .wsm-panel .wsm-doc-desc {
  display: block; width: calc(100% + 16px); margin: 0 -8px; padding: 2px 8px; border: 0; outline: 0; resize: none; overflow: hidden;
  border-radius: 10px; background: transparent; color: var(--dsw-alias-label-primary);
  transition: background-color .12s ease, box-shadow .12s ease;
}
.wsm-panel .wsm-doc-title { font-size: 20px; line-height: 28px; font-weight: 500; }
.wsm-panel[data-size="narrow"] .wsm-doc-title { font-size: 18px; line-height: 26px; }
.wsm-panel .wsm-doc-desc { margin-top: 2px; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-doc-title::placeholder, .wsm-panel .wsm-doc-desc::placeholder { color: var(--dsw-alias-label-caption); }
@media (hover: hover) { .wsm-panel :is(.wsm-doc-title, .wsm-doc-desc):hover { background: var(--dsw-alias-interactive-bg-hover); } }
.wsm-panel :is(.wsm-doc-title, .wsm-doc-desc):focus { background: transparent; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 70%, transparent); }
.wsm-panel :is(.wsm-doc-title, .wsm-doc-desc):focus-visible { outline: none; }
.wsm-panel :is(.wsm-doc-title, .wsm-doc-desc)[aria-invalid="true"] { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-error-primary); }
.wsm-panel .wsm-props { display: grid; grid-template-columns: 96px minmax(0, 1fr); align-items: start; column-gap: 12px; margin-top: 16px; padding-top: 10px; border-top: .5px solid var(--dsw-alias-border-l2); }
.wsm-panel[data-size="narrow"] .wsm-props { grid-template-columns: 84px minmax(0, 1fr); column-gap: 8px; }
.wsm-panel .wsm-prop-k { display: flex; align-items: center; gap: 6px; min-height: 34px; color: var(--dsw-alias-label-tertiary); font-size: 13px; white-space: nowrap; }
.wsm-panel .wsm-prop-k .wsm-ic { color: var(--dsw-alias-label-caption); }
.wsm-panel .wsm-prop-v { display: flex; flex-wrap: wrap; align-items: center; align-content: flex-start; gap: 6px; min-width: 0; min-height: 34px; padding: 3px 0; color: var(--dsw-alias-label-primary); }
.wsm-panel .wsm-prop-v[data-col] { flex-direction: column; align-items: stretch; }
.wsm-panel .wsm-prop-wide { grid-column: 1 / -1; padding-bottom: 6px; }
.wsm-panel .wsm-prop-muted { color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-callout { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: var(--wsm-tint-1); animation: wsm-fade .16s ease; text-wrap: pretty; }
.wsm-panel .wsm-callout .wsm-ic { margin-top: 2px; color: var(--dsw-alias-label-tertiary); }
.wsm-panel .wsm-callout[data-tone="warn"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent); color: var(--dsw-alias-label-primary); }
.wsm-panel .wsm-callout[data-tone="warn"] .wsm-ic { color: var(--dsw-alias-state-warn-primary); }
.wsm-panel .wsm-callout-main { flex: 1; min-width: 0; }
.wsm-panel .wsm-callout .wsm-btn { margin-top: 8px; }
.wsm-panel .wsm-tagchip { display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 0 3px 0 8px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.wsm-panel .wsm-tagchip button { display: grid; place-items: center; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-caption); cursor: pointer; }
@media (hover: hover) { .wsm-panel .wsm-tagchip button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.wsm-panel .wsm-taginput { width: 112px; height: 22px; padding: 0 8px; border: 0; outline: 0; border-radius: 999px; background: var(--dsw-alias-bg-layer-1); box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary); font-size: 12px; color: var(--dsw-alias-label-primary); }
.wsm-panel .wsm-taginput[aria-invalid="true"] { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-error-primary); }
.wsm-panel .wsm-taginput:focus-visible { outline: none; }
.wsm-panel .wsm-addtag { display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 0 8px 0 5px; border: 0; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font-size: 12px; }
@media (hover: hover) { .wsm-panel .wsm-addtag:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.wsm-panel .wsm-pathlist { display: flex; flex-wrap: wrap; gap: 4px; }
.wsm-panel .wsm-pathlist code { font: 11.5px/20px var(--wsm-mono); padding: 0 6px; border-radius: 6px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-slug { display: inline-flex; align-items: center; height: 28px; max-width: 100%; min-width: 0; margin-left: -8px; padding: 0 8px; border-radius: 8px; font: 12.5px/20px var(--wsm-mono); color: var(--dsw-alias-label-secondary); transition: background-color .12s ease, box-shadow .12s ease; }
.wsm-panel .wsm-slug input { flex: 0 1 auto; width: auto; max-width: 100%; min-width: 0; border: 0; outline: 0; padding: 0; background: transparent; font: inherit; color: var(--dsw-alias-label-primary); }
.wsm-panel .wsm-slug input:focus-visible { outline: none; }
@media (hover: hover) { .wsm-panel .wsm-slug:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.wsm-panel .wsm-slug:focus-within { background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary); }
.wsm-panel .wsm-slug[data-invalid] { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-error-primary); }
.wsm-panel .wsm-slug > span { flex: none; }
.wsm-panel[data-size="narrow"] .wsm-slug { font-size: 12px; }
.wsm-panel .wsm-editor { margin-top: 18px; }
.wsm-panel .wsm-editor-head { display: flex; align-items: center; gap: 8px; min-height: 28px; margin-bottom: 8px; }
.wsm-panel .wsm-editor-head .wsm-h2 { font-size: 13px; }
.wsm-panel .wsm-editor-head .wsm-count { margin-left: auto; }
.wsm-panel .wsm-editor-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.wsm-panel .wsm-editor-grid[data-split] { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.wsm-panel .wsm-editor .wsm-field { min-height: 220px; font-size: 13px; line-height: 22px; padding: 12px 14px; }
.wsm-panel .wsm-preview-box { min-height: 220px; padding: 12px 14px; border-radius: 12px; box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); }
.wsm-panel .wsm-preview-box[data-plain] { box-shadow: none; padding: 4px 0; }
.wsm-panel .wsm-savebar {
  position: absolute; z-index: 6; left: 50%; bottom: 16px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 6px; max-width: calc(100% - 24px); padding: 6px 6px 6px 14px; border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2); box-shadow: var(--dsw-elevation-prominent);
  animation: wsm-rise .2s var(--wsm-ease);
}
.wsm-panel .wsm-savebar-msg { display: inline-flex; align-items: center; gap: 8px; min-width: 0; margin-right: 6px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.wsm-panel .wsm-savebar-msg::before { content: ''; flex: none; width: 7px; height: 7px; border-radius: 999px; background: var(--dsw-alias-state-warn-primary); }
.wsm-panel .wsm-savebar-msg[data-err]::before { background: var(--dsw-alias-state-error-primary); }
.wsm-panel .wsm-savebar-msg span { overflow: hidden; text-overflow: ellipsis; }
.wsm-panel[data-size="narrow"] .wsm-savebar { left: 12px; right: 12px; transform: none; max-width: none; }
.wsm-panel[data-size="narrow"] .wsm-savebar-msg { flex: 1; }
.wsm-panel .wsm-saveerr { margin: -4px 0 12px; }

.wsm-panel .wsm-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 44px 20px 32px; max-width: 420px; margin: 0 auto; }
.wsm-panel .wsm-empty svg.wsm-ill { margin-bottom: 10px; }
.wsm-panel .wsm-empty-title { font-size: 14px; line-height: 22px; font-weight: 500; }
.wsm-panel .wsm-empty-body { color: var(--dsw-alias-label-tertiary); text-wrap: pretty; }
.wsm-panel .wsm-empty .wsm-btn { margin-top: 10px; }
.wsm-panel .wsm-empty[data-inline] { padding: 20px 8px; }
.wsm-panel .wsm-empty[data-error] .wsm-empty-body { color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-errcode { margin-top: 4px; padding: 6px 10px; border-radius: 10px; background: var(--dsw-alias-bg-module-platform); font: 12px/18px var(--wsm-mono); color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-ill .i-bg { fill: var(--dsw-alias-illustration-background); }
.wsm-panel .wsm-ill .i-back { fill: var(--dsw-alias-illustration-backing); }
.wsm-panel .wsm-ill .i-surf { fill: var(--dsw-alias-bg-layer-1); stroke: var(--dsw-alias-illustration-backing); stroke-width: 1.5; }
.wsm-panel .wsm-ill .i-inset { fill: var(--dsw-alias-illustration-inset); }
.wsm-panel .wsm-ill .i-line { fill: none; stroke: var(--dsw-alias-illustration-detail); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.wsm-panel .wsm-ill .i-accent { fill: none; stroke: var(--dsw-alias-label-tertiary); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.wsm-panel .wsm-skel { display: block; border-radius: 4px; background: var(--dsw-alias-bg-skeleton); animation: wsm-breathe 2s ease-in-out infinite; }
.wsm-panel .wsm-skel-cell { height: 156px; border-radius: 16px; }
.wsm-panel .wsm-skel-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; }

.wsm-panel .wsm-menu {
  position: fixed; z-index: 60; min-width: 176px; max-width: min(340px, calc(100vw - 24px)); max-height: min(420px, calc(100vh - 24px)); overflow-y: auto;
  display: flex; flex-direction: column; padding: 4px; border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2); box-shadow: var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  animation: wsm-menu-in .1s ease-out; visibility: hidden;
}
.wsm-panel .wsm-menu[data-placed] { visibility: visible; }
.wsm-panel .wsm-menu-item {
  display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 6px 8px; border: 0; border-radius: 12px; background: transparent;
  text-align: left; cursor: pointer; color: var(--dsw-alias-label-primary);
}
.wsm-panel .wsm-menu-item:focus-visible { outline: none; background: var(--dsw-alias-interactive-bg-hover); }
@media (hover: hover) { .wsm-panel .wsm-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.wsm-panel .wsm-menu-item[data-danger] { color: var(--dsw-alias-state-error-primary); }
.wsm-panel .wsm-menu-item[data-danger]:is(:hover, :focus-visible) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.wsm-panel .wsm-menu-item:disabled { opacity: .4; cursor: default; }
.wsm-panel .wsm-menu-ic { flex: none; display: grid; place-items: center; width: 16px; color: var(--dsw-alias-menu-icon); align-self: flex-start; margin-top: 2px; }
.wsm-panel .wsm-menu-item[data-danger] .wsm-menu-ic { color: inherit; }
.wsm-panel .wsm-menu-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.wsm-panel .wsm-menu-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsm-panel .wsm-menu-desc { font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary); text-wrap: pretty; }
.wsm-panel .wsm-menu-check { flex: none; color: var(--dsw-alias-label-primary); align-self: center; }
.wsm-panel .wsm-menu-sep { height: 0; margin: 3px 8px; border-top: .5px solid var(--dsw-alias-border-l2); }
.wsm-panel .wsm-menu-group { padding: 6px 8px 2px; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }

.wsm-panel .wsm-dialog {
  width: min(440px, calc(100vw - 48px)); max-height: calc(100vh - 48px); padding: 0; border: 0; border-radius: 28px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l2); box-shadow: var(--dsw-elevation-prominent);
  font-size: 14px; line-height: 22px; overflow: auto;
}
.wsm-panel .wsm-dialog[open] { animation: wsm-dialog-in .2s var(--wsm-ease); }
.wsm-panel .wsm-dialog::backdrop { background: var(--dsw-alias-bg-mask-1); animation: wsm-fade .2s ease; }
.wsm-panel .wsm-dialog-head { display: flex; align-items: center; gap: 8px; padding: 22px 14px 12px 24px; }
.wsm-panel .wsm-dialog-head .wsm-dialog-ic { color: var(--dsw-alias-state-warn-primary); }
.wsm-panel .wsm-dialog-title { flex: 1; min-width: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.wsm-panel .wsm-dialog-head .wsm-iconbtn { color: var(--dsw-alias-label-secondary); }
.wsm-panel .wsm-dialog-desc { padding: 0 24px; color: var(--dsw-alias-label-secondary); text-wrap: pretty; }
.wsm-panel .wsm-dialog-desc > * + * { margin-top: 10px; }
.wsm-panel .wsm-dialog-desc b { color: var(--dsw-alias-label-primary); font-weight: 500; }
.wsm-panel .wsm-dialog-path { display: block; padding: 8px 10px; border-radius: 10px; background: var(--dsw-alias-bg-module-platform); font: 12px/18px var(--wsm-mono); color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.wsm-panel .wsm-dialog-impact { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 12px; background: var(--wsm-tint-1); font-size: 13px; line-height: 20px; }
.wsm-panel .wsm-dialog-impact[data-tone="over"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); color: var(--dsw-alias-state-error-primary); }
.wsm-panel .wsm-dialog-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 22px 24px 24px; }
.wsm-panel .wsm-dialog-foot .wsm-btn { min-width: 84px; }

.wsm-panel .wsm-toasts { position: absolute; z-index: 50; left: 0; right: 0; bottom: 16px; display: flex; flex-direction: column-reverse; align-items: center; gap: 8px; padding: 0 12px; pointer-events: none; transition: bottom .2s var(--wsm-ease); }
.wsm-panel .wsm-toasts[data-lift] { bottom: 68px; }
.wsm-panel .wsm-toast {
  pointer-events: auto; display: flex; align-items: center; gap: 10px; max-width: min(520px, 100%);
  padding: 10px 10px 10px 16px; border-radius: 16px; background: var(--dsw-alias-toast-bg); color: var(--dsw-alias-toast-label);
  font-size: 13px; line-height: 20px; box-shadow: var(--dsw-shadow-lv3); animation: wsm-toast-in .18s var(--wsm-ease);
}
.wsm-panel .wsm-toast[data-leaving] { animation: wsm-toast-out .18s ease forwards; }
.wsm-panel .wsm-toast:not([data-persistent]) { padding-right: 16px; }
.wsm-panel .wsm-toast-text { min-width: 0; text-wrap: pretty; }
.wsm-panel .wsm-toast-ic { flex: none; color: var(--dsw-alias-state-warn-primary); }
.wsm-panel .wsm-toast-action { flex: none; padding: 0 4px; border: 0; background: none; color: var(--dsw-alias-toast-action); font-weight: 500; cursor: pointer; white-space: nowrap; }
.wsm-panel .wsm-toast .wsm-iconbtn { color: color-mix(in srgb, var(--dsw-alias-toast-label) 60%, transparent); width: 24px; height: 24px; }
@media (hover: hover) { .wsm-panel .wsm-toast .wsm-iconbtn:hover { background: color-mix(in srgb, var(--dsw-alias-toast-label) 12%, transparent); color: var(--dsw-alias-toast-label); } }

.wsm-panel .wsm-tooltip {
  position: fixed; z-index: 2000; left: 0; top: 0; max-width: min(300px, calc(100vw - 24px)); padding: 4px 8px; border-radius: 8px;
  background: var(--dsw-alias-tooltip-bg); color: var(--dsw-alias-tooltip-label); font-size: 12.5px; line-height: 19px; white-space: pre-line;
  pointer-events: none; opacity: 0; transition: opacity .15s ease; font-family: var(--dsw-font-family);
}
.wsm-panel .wsm-tooltip[data-show] { opacity: 1; }

@keyframes wsm-spin { to { transform: rotate(360deg); } }
@keyframes wsm-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes wsm-rise { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
.wsm-panel[data-size="narrow"] .wsm-savebar { animation-name: wsm-rise-n; }
@keyframes wsm-rise-n { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes wsm-push { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
@keyframes wsm-menu-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
@keyframes wsm-dialog-in { from { opacity: 0; transform: translateY(6px) scale(.985); } to { opacity: 1; transform: none; } }
@keyframes wsm-toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes wsm-toast-out { to { opacity: 0; transform: translateY(4px); } }
@keyframes wsm-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .6; } }
@keyframes wsm-flash { 0%, 30% { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent); } 100% { background: transparent; } }
@media (prefers-reduced-motion: reduce) {
  .wsm-panel *, .wsm-panel *::before, .wsm-panel *::after, .wsm-panel .wsm-tooltip { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
}
@media (forced-colors: active) {
  .wsm-panel .wsm-cell, .wsm-panel .wsm-draft, .wsm-panel .wsm-row[aria-selected="true"], .wsm-panel .wsm-seg-ink, .wsm-panel .wsm-chip[aria-pressed="true"] { outline: 1px solid CanvasText; }
}

.wsm-panel:focus { outline: none; }
.wsm-panel .wsm-count[data-warn] { color: var(--dsw-alias-state-warn-label); }
.wsm-panel .wsm-empty .wsm-pathchip { max-width: 100%; }
.wsm-panel .wsm-projcard-note { display: flex; align-items: flex-start; gap: 6px; padding: 0 16px 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); text-wrap: pretty; }
.wsm-panel .wsm-projcard-note .wsm-ic { margin-top: 2px; }
.wsm-panel .wsm-projcard-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
`

    /* ------------------------------------------------------ 纯函数（可测） */

    const DAY = 864e5
    const enc = typeof TextEncoder === 'function' ? new TextEncoder() : null
    /** UTF-8 字节数：宿主的字节上限、AGENTS.md 章的大小都按它算。 */
    const bytesOf = (s) => {
      const text = String(s == null ? '' : s)
      if (enc) return enc.encode(text).length
      let n = 0
      for (const ch of text) {
        const c = ch.codePointAt(0)
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
      }
      return n
    }
    const nf = (n) => Number(n).toLocaleString('en-US')
    /** 字节 → KB 文字（1000 进制，与宿主「字节上限」口径一致；10 KB 以下保留一位小数）。 */
    const kb = (b) => {
      if (!b) return '0'
      const v = b / 1000
      return v >= 10 ? String(Math.round(v * 10) / 10) : v.toFixed(1)
    }
    /** 粗估 tokens：字节 ÷ 3.5。界面上一律写「约」。 */
    const tokensOf = (b) => Math.round((Number(b) || 0) / 3.5)
    const pad2 = (n) => String(n).padStart(2, '0')
    const timeOf = (iso) => {
      const ms = Date.parse(iso)
      return Number.isFinite(ms) ? ms : null
    }

    function relTime(iso, now = Date.now()) {
      const ms = timeOf(iso)
      if (ms == null) return ''
      const d = Math.max(0, (now - ms) / 1000)
      if (d < 60) return t('time.justNow')
      if (d < 3600) return t('time.minutes', { n: Math.floor(d / 60) })
      if (d < DAY / 1000) return t('time.hours', { n: Math.floor(d / 3600) })
      const days = Math.floor(d / (DAY / 1000))
      if (days === 1) return t('time.yesterday')
      if (days < 31) return t('time.days', { n: days })
      return t('time.months', { n: Math.floor(days / 30) })
    }
    function absTime(iso, now = Date.now()) {
      const ms = timeOf(iso)
      if (ms == null) return ''
      const d = new Date(ms)
      const vars = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hm: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) }
      return d.getFullYear() === new Date(now).getFullYear() ? t('time.date', vars) : t('time.dateYear', vars)
    }
    const daysSince = (iso, now = Date.now()) => {
      const ms = timeOf(iso)
      return ms == null ? null : Math.floor((now - ms) / DAY)
    }
    /** 家目录缩写成 ~（Windows `C:\Users\x`、macOS `/Users/x`、Linux `/home/x`）。只用于展示，完整路径放 tooltip。 */
    const homeShort = (p) =>
      String(p || '')
        .replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')
        .replace(/^\/(?:Users|home)\/[^/]+/, '~')
    /** 路径最后一段（工作区友好名的兜底）。 */
    const lastSegment = (p) => {
      const parts = String(p || '').split(/[\\/]+/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : ''
    }

    /* ---- Markdown：先转义，再按白名单重建（绝不插入原文 HTML） ---- */

    /** HTML 转义：所有用户内容进 DOM 前都要过这里。 */
    function escapeHTML(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    /**
     * 链接协议白名单：只放行 http/https/mailto 和页内锚点；`javascript:`、`data:`、`file:` 一律丢弃。
     * 同时拒绝含控制字符或空白的值——那种串常用来绕过前缀检查。
     */
    function safeLink(raw) {
      const value = String(raw ?? '').trim()
      if (!value) return ''
      if (/[\u0000-\u0020\u007f]/.test(value)) return ''
      if (/^https?:\/\//i.test(value)) {
        try {
          const url = new URL(value)
          return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
        } catch {
          return ''
        }
      }
      if (/^mailto:[^<>]+$/i.test(value) || /^#[\w-]+$/.test(value)) return value
      return ''
    }

    /**
     * 原文里的裸网址做成链接，返回 HTML。必须在**原文**上识别、再分别转义：在已转义的文本上识别会把
     * `&gt;` `&quot;` `&#39;` 吞进网址（`<https://x>` 的 href 变成 `https://x&gt;`）。
     * 结尾的 `. , ; : ! ?` 不算网址；`)` 只在网址里有配对的 `(` 时保留（维基式链接）。href 照样过白名单再转义。
     */
    function autoLink(raw) {
      const text = String(raw ?? '')
      const re = /https?:\/\/[^\s<>"'`，。；、：！？）】」』]+/g
      let out = ''
      let cursor = 0
      let m
      while ((m = re.exec(text))) {
        let url = m[0]
        for (;;) {
          const last = url[url.length - 1]
          if (/[.,;:!?]/.test(last)) url = url.slice(0, -1)
          else if (last === ')' && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) url = url.slice(0, -1)
          else break
        }
        const href = /^https?:\/\/[^/?#]/i.test(url) ? safeLink(url) : ''
        if (!href) continue
        out += escapeHTML(text.slice(cursor, m.index)) + `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${escapeHTML(url)}</a>`
        cursor = m.index + url.length
        re.lastIndex = cursor
      }
      return out + escapeHTML(text.slice(cursor))
    }

    /** 行内 Markdown：先转义，再按白名单语法重建标签。`noAuto`：链接文字里不再自动识别网址（避免 <a> 套 <a>）。 */
    function inlineMarkdown(text, depth = 0, noAuto = false) {
      if (depth > 3) return escapeHTML(text)
      const plain = (s) => (noAuto ? escapeHTML(s) : autoLink(s))
      const token = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\[([^\]\n]{1,300})\]\(([^\s)]{1,1000})\)|\*([^*\n]+)\*|~~([^~\n]+)~~/g
      let out = ''
      let cursor = 0
      let m
      while ((m = token.exec(text))) {
        out += plain(text.slice(cursor, m.index))
        if (m[1] != null) out += `<code>${escapeHTML(m[1])}</code>`
        else if (m[2] != null || m[3] != null) out += `<strong>${inlineMarkdown(m[2] || m[3], depth + 1, noAuto)}</strong>`
        else if (m[4] != null) {
          const href = safeLink(m[5])
          out += href
            ? `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${inlineMarkdown(m[4], depth + 1, true)}</a>`
            : escapeHTML(m[0])
        } else if (m[6] != null) out += `<em>${inlineMarkdown(m[6], depth + 1, noAuto)}</em>`
        else out += `<del>${escapeHTML(m[7])}</del>`
        cursor = token.lastIndex
      }
      return out + plain(text.slice(cursor))
    }

    /**
     * 块级 Markdown → HTML。输出只由本函数生成（全部来自转义后的文本 + 固定标签），
     * 因此可以安全地交给 React 渲染；**绝不**把原文当 HTML 插入。
     */
    function renderMarkdown(markdown, depth = 0) {
      if (depth > 3) return `<p>${escapeHTML(markdown)}</p>`
      const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
      if (lines.every((line) => line.trim() === '')) return ''
      const blocks = []
      let para = []
      const flush = () => {
        if (para.length) blocks.push(`<p>${inlineMarkdown(para.join('\n')).replace(/\n/g, '<br>')}</p>`)
        para = []
      }
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        // 空行是段落分隔符
        if (line.trim() === '') {
          flush()
          continue
        }
        const fence = line.match(/^\s*(`{3,}|~{3,})([\w+-]*)\s*$/)
        if (fence) {
          flush()
          const code = []
          const closing = new RegExp('^\\s*' + fence[1][0] + '{' + fence[1].length + ',}\\s*$')
          while (i + 1 < lines.length && !closing.test(lines[i + 1])) {
            i += 1
            code.push(lines[i])
          }
          i += 1
          blocks.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`)
          continue
        }
        const heading = line.match(/^(#{1,6})\s+(.*)$/)
        if (heading) {
          flush()
          const lv = heading[1].length
          blocks.push(`<h${lv}>${inlineMarkdown(heading[2])}</h${lv}>`)
          continue
        }
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          flush()
          blocks.push('<hr>')
          continue
        }
        if (/^\s*>/.test(line)) {
          flush()
          const quoted = []
          while (i < lines.length && /^\s*>/.test(lines[i])) {
            quoted.push(lines[i].replace(/^\s*> ?/, ''))
            i += 1
          }
          i -= 1
          blocks.push(`<blockquote>${renderMarkdown(quoted.join('\n'), depth + 1)}</blockquote>`)
          continue
        }
        const li = line.match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/)
        if (li) {
          flush()
          const ordered = Boolean(li[2])
          const items = []
          while (i < lines.length) {
            const it = lines[i].match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/)
            if (!it || Boolean(it[2]) !== ordered) break
            let content = it[3]
            i += 1
            while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-+*]|\d+[.)])\s/.test(lines[i])) {
              content += '\n' + lines[i].trim()
              i += 1
            }
            items.push(`<li>${inlineMarkdown(content).replace(/\n/g, '<br>')}</li>`)
          }
          i -= 1
          const tag = ordered ? 'ol' : 'ul'
          const start = ordered && Number(li[2]) !== 1 ? ` start="${Number(li[2])}"` : ''
          blocks.push(`<${tag}${start}>${items.join('')}</${tag}>`)
          continue
        }
        para.push(line)
      }
      flush()
      return blocks.join('\n')
    }

    const mdCache = new Map()
    function md(text) {
      const key = String(text == null ? '' : text)
      let value = mdCache.get(key)
      if (value == null) {
        value = renderMarkdown(key)
        if (mdCache.size > 300) mdCache.clear()
        mdCache.set(key, value)
      }
      return value
    }

    /* ---- 新旧对比：行级 LCS + 行内字符级 LCS（中文无空格，按字比） ---- */

    function lcsOps(a, b) {
      const n = a.length
      const m = b.length
      const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
      const ops = []
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          ops.push(['=', a[i]])
          i += 1
          j += 1
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          ops.push(['-', a[i]])
          i += 1
        } else {
          ops.push(['+', b[j]])
          j += 1
        }
      }
      while (i < n) ops.push(['-', a[i++]])
      while (j < m) ops.push(['+', b[j++]])
      return ops
    }
    /** 夹在两段改动之间、只有 1–2 个字的「相同」片段并进改动，读起来不那么碎。 */
    function mergeSegs(segs) {
      const out = []
      segs.forEach((s, k) => {
        const prev = out[out.length - 1]
        const tiny = !s.ch && Array.from(s.s).length <= 2 && k > 0 && k < segs.length - 1 && segs[k - 1].ch && segs[k + 1].ch
        const seg = tiny ? { s: s.s, ch: true } : s
        if (prev && prev.ch === seg.ch) prev.s += seg.s
        else out.push({ s: seg.s, ch: seg.ch })
      })
      return out
    }
    /** 一对改动行的字符级对比；改动太碎或几乎全变时返回 null（整行显示删 / 增）。 */
    function inlineDiff(a, b) {
      const A = Array.from(a)
      const B = Array.from(b)
      if (A.length * B.length > 160000) return null
      const ops = lcsOps(A, B)
      const common = ops.filter((o) => o[0] === '=').length
      if (common < Math.max(4, 0.5 * Math.max(A.length, B.length))) return null
      const del = []
      const add = []
      const push = (arr, s, ch) => {
        const last = arr[arr.length - 1]
        if (last && last.ch === ch) last.s += s
        else arr.push({ s, ch })
      }
      for (const [op, x] of ops) {
        if (op === '=') {
          push(del, x, false)
          push(add, x, false)
        } else if (op === '-') push(del, x, true)
        else push(add, x, true)
      }
      const d = mergeSegs(del)
      const a2 = mergeSegs(add)
      const pieces = (arr) => arr.filter((x) => x.ch).length
      if (pieces(d) > 4 || pieces(a2) > 4) return null
      return { del: d, add: a2 }
    }
    /**
     * 新旧文本 → 对比行：`{t:'='|'-'|'+', segs:[{s, ch?}], inline?}`；超过 3 行没变的连续行折叠成 `{t:'gap', n}`。
     * 行数太多（> 600 × 600）时不做 LCS，直接整段删 + 整段增，避免卡住界面。
     */
    function diffRows(oldText, newText) {
      const A = String(oldText ?? '').replace(/\r\n?/g, '\n').split('\n')
      const B = String(newText ?? '').replace(/\r\n?/g, '\n').split('\n')
      const ops = A.length * B.length > 360000 ? [...A.map((s) => ['-', s]), ...B.map((s) => ['+', s])] : lcsOps(A, B)
      const rows = []
      let k = 0
      while (k < ops.length) {
        if (ops[k][0] === '=') {
          rows.push({ t: '=', segs: [{ s: ops[k][1] }] })
          k += 1
          continue
        }
        const dels = []
        const adds = []
        while (k < ops.length && ops[k][0] !== '=') {
          ;(ops[k][0] === '-' ? dels : adds).push(ops[k][1])
          k += 1
        }
        const delRows = dels.map((s) => ({ t: '-', segs: [{ s }] }))
        const addRows = adds.map((s) => ({ t: '+', segs: [{ s }] }))
        for (let p = 0; p < Math.min(dels.length, adds.length); p += 1) {
          const r = inlineDiff(dels[p], adds[p])
          if (r) {
            delRows[p] = { t: '-', segs: r.del, inline: true }
            addRows[p] = { t: '+', segs: r.add, inline: true }
          }
        }
        rows.push(...delRows, ...addRows)
      }
      const out = []
      let run = []
      const flushRun = (edge) => {
        if (run.length > 3) {
          const keepHead = edge === 'start' ? 0 : 1
          const keepTail = edge === 'end' ? 0 : 1
          out.push(...run.slice(0, keepHead))
          out.push({ t: 'gap', n: run.length - keepHead - keepTail })
          out.push(...run.slice(run.length - keepTail))
        } else out.push(...run)
        run = []
      }
      rows.forEach((r) => {
        if (r.t === '=') run.push(r)
        else {
          flushRun(out.length ? 'mid' : 'start')
          out.push(r)
        }
      })
      flushRun('end')
      return out
    }

    /* ---- 记忆与草稿的派生 ---- */

    const memKey = (m) => (m ? `${m.scope}:${m.id}` : '')
    const normType = (type) => (TYPES.includes(type) ? type : 'project')
    const libName = (scope) => (scope === 'global' ? t('layer.globalMem') : t('layer.projMem'))
    const cellOfScope = (scope) => (scope === 'global' ? 'globalMem' : 'projMem')
    const byModified = (a, b) => (timeOf(b.modified) || 0) - (timeOf(a.modified) || 0)

    /** 输入法组字中？React 的合成键盘事件不带 isComposing（只有原生事件有），所以同时看 nativeEvent；229 是组字中按键。 */
    function isImeEvent(event) {
      return Boolean(event?.isComposing || event?.nativeEvent?.isComposing || event?.keyCode === 229)
    }
    /** 标题 / 摘要是 frontmatter 里的单行字段：换行会让宿主写出损坏的文件。 */
    function singleLine(value) {
      return String(value ?? '').replace(/[\r\n]+/g, ' ')
    }
    /** AGENTS.md 章标题去掉编号（`3. 标题` → `标题`），与宿主 expectedTitle 的口径一致。 */
    function bareTitle(title) {
      return String(title ?? '').trim().replace(/^\d+(?:\.\d+)?\.\s*/, '')
    }
    /** 重新读取后按「用户看到的标题」找回一章现在的位置：优先原位置，找不到返回 -1。 */
    function locateSection(sections, title, hintIndex) {
      if (!Array.isArray(sections)) return -1
      const want = bareTitle(title)
      const nameOf = (s) => (s && s.name != null ? s.name : bareTitle(s?.title))
      if (sections[hintIndex] && nameOf(sections[hintIndex]) === want) return hintIndex
      return sections.findIndex((section) => nameOf(section) === want)
    }

    /**
     * 来源分类（U7）：
     *  - verified：`source: user` 且宿主核对到原话（evidenceVerified === true，只认布尔 true）
     *  - mismatch：`source: user` 但核对失败（=== false）
     *  - legacy：`source: user` 但没有这个键（旧数据，从没核对过）
     *  - agent：Agent 总结；confidence：只有旧版的模型自评；none：都没有
     */
    function sourceKind(m) {
      if (m?.source === 'user' && m.evidenceVerified === true) return 'verified'
      if (m?.source === 'user' && m.evidenceVerified === false) return 'mismatch'
      if (m?.source === 'user') return 'legacy'
      if (m?.source === 'agent') return 'agent'
      if (m?.source == null && Number.isFinite(m?.confidence)) return 'confidence'
      return 'none'
    }

    /**
     * 可能过时（U17）：有 lastHit 时超过 60 天没被用过；从没被用过（hits 为 0、没有 lastHit）且建了超过 30 天。
     * 返回 `{kind:'unused'|'never', days}` 或 null。
     */
    function staleInfo(m, now = Date.now()) {
      if (!m) return null
      if (m.lastHit) {
        const d = daysSince(m.lastHit, now)
        return d != null && d > 60 ? { kind: 'unused', days: d } : null
      }
      if (!m.hits) {
        const d = daysSince(m.created || m.modified, now)
        return d != null && d > 30 ? { kind: 'never', days: d } : null
      }
      return null
    }

    /**
     * 草稿去向（inventory §3.2 的表）：由 scope + load + newChapter + chapterTitle/chapter + supersedes 推出。
     *  - always + project → blocked（插件不写项目 AGENTS.md，宿主会拒收）
     *  - always + global：带 chapterTitle（或章号）且不是 newChapter → overwrite（按 chapterTitle 找那一章，找不到 section=null）；
     *    否则 append（新增第 N+1 章）
     *  - on-demand：带 supersedes → replace（旧条在草稿的库里找，找不到再全局找）；否则 add
     * `ctx = {sections:[{name, body, ...}], memories:[...]}`。
     */
    function destOf(d, ctx) {
      const sections = ctx?.sections ?? []
      const memories = ctx?.memories ?? []
      if (d.load === 'always') {
        if (d.scope === 'project') return { cell: 'projInstr', kind: 'blocked' }
        if (!d.newChapter && (d.chapterTitle || d.chapter)) {
          const hits = d.chapterTitle ? sections.filter((s) => s.name === d.chapterTitle) : []
          const section = hits.length === 1 ? hits[0] : null
          const old = d.supersedes ? memories.find((m) => m.id === d.supersedes && m.scope === (d.supersedesScope || 'project')) ?? null : null
          return {
            cell: 'globalInstr',
            kind: 'overwrite',
            chapter: Number.isFinite(d.chapter) ? d.chapter : null,
            chapterTitle: d.chapterTitle || '',
            section,
            sectionNum: section ? sections.indexOf(section) + 1 : 0,
            alsoRemove: old,
          }
        }
        return { cell: 'globalInstr', kind: 'append', next: sections.length + 1 }
      }
      const cell = cellOfScope(d.scope)
      if (d.supersedes) {
        const old = memories.find((m) => m.id === d.supersedes && m.scope === d.scope) ?? memories.find((m) => m.id === d.supersedes) ?? null
        return { cell, kind: 'replace', old }
      }
      return { cell, kind: 'add' }
    }

    /** 为什么要你确认（一条或几条）：写进全局指令的一律要确认；Agent 总结；说是原话但没核对上；其余是 agentWrites=review。 */
    function whyOf(d) {
      const reasons = []
      if (d.load === 'always') reasons.push(['global', ''])
      if (d.source === 'agent') reasons.push(['agent', ''])
      else if (d.source === 'user' && d.evidenceVerified === false) reasons.push(['unverified', 'warn'])
      if (!reasons.length) reasons.push(['review', ''])
      return reasons
    }

    /** 列表行 → 编辑草稿。文件名取文件名（id），不是 frontmatter 的 name。 */
    function toDraft(m) {
      return {
        slug: String(m?.slug ?? m?.id ?? m?.name ?? ''),
        title: String(m?.title ?? ''),
        description: String(m?.description ?? ''),
        type: normType(m?.type),
        scope: m?.scope === 'global' ? 'global' : 'project',
        tags: Array.isArray(m?.tags) ? m.tags.slice() : [],
        body: String(m?.body ?? ''),
      }
    }
    const sameDraft = (a, b) =>
      !!a &&
      !!b &&
      a.slug === b.slug &&
      a.title === b.title &&
      a.description === b.description &&
      a.type === b.type &&
      a.scope === b.scope &&
      a.body === b.body &&
      a.tags.length === b.tags.length &&
      a.tags.every((tag, i) => tag === b.tags[i])

    /** 上限：正数才算有上限；0 / 缺失 / 坏值都当「不限」（旧宿主没有 limits 时就不显示上限，也不在客户端拦长度）。 */
    const limitOf = (v) => (Number.isFinite(v) && v > 0 ? v : null)
    function normalizeLimits(raw) {
      const src = raw && typeof raw === 'object' ? raw : {}
      return {
        maxMemoryCount: limitOf(src.maxMemoryCount),
        maxTitleChars: limitOf(src.maxTitleChars),
        maxDescriptionChars: limitOf(src.maxDescriptionChars),
        maxBodyChars: limitOf(src.maxBodyChars),
        maxTags: limitOf(src.maxTags),
        maxTagChars: limitOf(src.maxTagChars),
      }
    }

    /**
     * 客户端逐字段校验，只用于即时反馈；宿主的 validateMemoryPatch 才是最终闸门。
     * 长度上限来自宿主 /list 的 limits（没有就不拦）；长度按 UTF-16 码元算，与宿主 `.length` 一致。
     * 文件名只在**改过**时才校验（U16：旧条目的 id 可能是中文或带大写，不改它就别拦住其余字段的保存）。
     */
    function validateDraft(draft, limits, baseline) {
      const L = limits || {}
      const errors = {}
      const title = String(draft.title ?? '')
      if (!title.trim()) errors.title = t('err.title.empty')
      else if (/[\r\n]/.test(title)) errors.title = t('err.title.line')
      else if (L.maxTitleChars && title.trim().length > L.maxTitleChars) errors.title = t('err.title.long', { n: L.maxTitleChars })
      const description = String(draft.description ?? '')
      if (/[\r\n]/.test(description)) errors.description = t('err.desc.line')
      else if (L.maxDescriptionChars && description.trim().length > L.maxDescriptionChars) errors.description = t('err.desc.long', { n: L.maxDescriptionChars })
      const body = String(draft.body ?? '')
      if (!body.trim()) errors.body = t('err.body.empty')
      else if (L.maxBodyChars && body.trim().length > L.maxBodyChars) errors.body = t('err.body.long', { n: L.maxBodyChars })
      if (!TYPES.includes(draft.type)) errors.type = t('err.type')
      if (draft.scope !== 'global' && draft.scope !== 'project') errors.scope = t('err.scope')
      const slug = String(draft.slug ?? '')
      const slugChanged = !baseline || slug !== baseline.slug
      if (slugChanged && (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug.length < 2)) errors.slug = t('err.slug')
      const tags = Array.isArray(draft.tags) ? draft.tags : []
      if (L.maxTags && tags.length > L.maxTags) errors.tags = t('err.tag.many', { n: L.maxTags })
      else if (tags.some((tag) => /[,\]\r\n]/.test(tag))) errors.tags = t('err.tag.chars')
      else if (L.maxTagChars && tags.some((tag) => tag.length > L.maxTagChars)) errors.tags = t('err.tag.long', { n: L.maxTagChars })
      return errors
    }

    /** 新标签的校验，规则与宿主一致（去空白、不含 , ] 换行、长度、去重、个数）；返回错误文案或空串。 */
    function validateTag(raw, tags, limits) {
      const L = limits || {}
      const value = String(raw ?? '').trim()
      const list = Array.isArray(tags) ? tags : []
      if (!value) return t('err.tag.empty')
      if (/[,\]\r\n]/.test(value)) return t('err.tag.chars')
      if (L.maxTagChars && value.length > L.maxTagChars) return t('err.tag.long', { n: L.maxTagChars })
      if (list.includes(value)) return t('err.tag.dup')
      if (L.maxTags && list.length >= L.maxTags) return t('err.tag.many', { n: L.maxTags })
      return ''
    }

    /**
     * 章标题校验（新增 / 保存前）：压平空白、去掉开头的编号（宿主写入时也会剥掉 `2. ` 再统一重排）后不能为空、
     * 不能与别的章同名。返回 `{title, error}`，title 是去编号后的标题（保存后按它找回那一章）。
     */
    function checkChapterTitle(raw, sections, selfUid) {
      const title = bareTitle(String(raw ?? '').replace(/\s+/g, ' ').trim())
      if (!title) return { title, error: t('in.err.emptyTitle') }
      const clash = (sections || []).some((s) => s.uid !== selfUid && s.name === title)
      if (clash) return { title, error: t('in.err.dup', { title }) }
      return { title, error: '' }
    }

    /** 一章写回文件后的字节数估算（`## N. 标题` + 空行 + 正文 + 换行）。只用来显示「+n 字节」。 */
    function chapterBytes(n, name, body) {
      return bytesOf(`## ${n}. ${name}\n\n${String(body ?? '')}`.trimEnd() + '\n')
    }
    /** 正文里的 #/## 标题压到 ###（与宿主追加新章时「标题整体下沉」大致相同，只用于估算）。 */
    function demoteHeadings(body) {
      return String(body ?? '').split('\n').map((line) => line.replace(/^(#{1,6})(\s+)/, (all, hashes, sp) => '#'.repeat(Math.min(6, Math.max(3, hashes.length + 1))) + sp)).join('\n')
    }
    /**
     * 升为全局指令后文件大小的估算：现有字节 + 分隔空行 + 新章（标题下沉后的正文）+ 宿主追加的来源注释。
     * 只是预估，宿主按真实写入判上限（超了返回 agents-full 与准确字节数）。
     */
    function estimatePromotedBytes(currentBytes, n, title, body, id) {
      const stamp = '2026-01-01'
      const note = `\n\n<!-- 来自记忆 ${id}，写入于 ${stamp} -->`
      return (Number(currentBytes) || 0) + (currentBytes ? 1 : 0) + chapterBytes(n, title, demoteHeadings(body) + note)
    }

    /** MEMORY.md 索引一行的近似（每轮注入的就是这些行）。 */
    function indexLine(m) {
      const link = String(m.id).replace(/[-_]+/g, ' ')
      return m.description ? `- [${link}](${m.id}.md) — ${m.description}` : `- [${link}](${m.id}.md)`
    }
    /** 两个库的索引字节估算（每个库一份 MEMORY.md）。 */
    function indexBytes(memories) {
      let total = 0
      for (const scope of ['project', 'global']) {
        const items = (memories || []).filter((m) => m.scope === scope)
        if (items.length) total += bytesOf('# Memory Index\n\n' + items.map(indexLine).join('\n') + '\n')
      }
      return total
    }

    /**
     * 每轮固定开销的组成：全局指令、项目指令（团队 / 仅你）、两个库的索引。只列字节数大于 0 的部分。
     * `D = {agents, project, memories}`；project 读不到时那两段不计。
     */
    function costParts(D) {
      const team = D.project?.team
      const local = D.project?.local
      const parts = [
        { k: 'global', bytes: D.agents?.exists ? Number(D.agents.bytes) || 0 : 0, p: '76%' },
        { k: 'team', bytes: team?.exists ? Number(team.bytes) || 0 : 0, p: '48%' },
        { k: 'local', bytes: local?.exists ? Number(local.bytes) || 0 : 0, p: '34%' },
        { k: 'index', bytes: indexBytes(D.memories), p: '20%', hatch: true, lines: (D.memories || []).length },
      ]
      return parts.filter((x) => x.bytes > 0)
    }

    /** 章节列表 → 带稳定 uid 的形状（uid = 去编号标题 + 同名序号；重读后标题没变 uid 就不变）。 */
    function withUids(sections) {
      const seen = new Map()
      return (Array.isArray(sections) ? sections : []).map((s, i) => {
        const name = bareTitle(s?.title)
        const k = (seen.get(name) || 0) + 1
        seen.set(name, k)
        return {
          uid: `c:${name}#${k}`,
          index: Number.isInteger(s?.index) ? s.index : i,
          title: String(s?.title ?? ''),
          name,
          body: String(s?.body ?? ''),
          bytes: Number.isFinite(s?.bytes) ? s.bytes : chapterBytes(i + 1, name, s?.body),
        }
      })
    }

    /**
     * /agents/sections 与 /agents 两个响应 → 面板的全局指令模型。
     * `sec`/`stat` 都是 `{ok, status, payload}`（api() 的返回）。文件不存在时 sections 回的是 HTTP 200 + ok:false + agents-missing。
     * 新字段（limit / mtime / historyLimit / historyDir）缺失时为 null，界面据此不显示上限、备份份数。
     */
    function normalizeAgents(sec, stat) {
      const sp = sec?.payload && typeof sec.payload === 'object' ? sec.payload : {}
      const ap = stat?.payload?.agents && typeof stat.payload.agents === 'object' ? stat.payload.agents : null
      const pick = (key) => (sp[key] != null ? sp[key] : ap && ap[key] != null ? ap[key] : null)
      const facts = {
        limit: limitOf(pick('limit')),
        mtime: typeof pick('mtime') === 'string' ? pick('mtime') : null,
        historyLimit: limitOf(pick('historyLimit')),
        historyDir: typeof pick('historyDir') === 'string' ? pick('historyDir') : '',
      }
      const path = String(sp.path || ap?.path || '')
      if (sp.ok === true) {
        return { status: 'ok', exists: true, path, bytes: Number(sp.bytes) || 0, preamble: String(sp.preamble ?? ''), sections: withUids(sp.sections), error: '', ...facts }
      }
      if (sp.reason === 'agents-missing' || (ap && ap.exists === false && stat?.payload?.ok)) {
        return { status: 'missing', exists: false, path, bytes: 0, preamble: '', sections: [], error: '', ...facts }
      }
      return {
        status: 'error',
        exists: Boolean(ap?.exists),
        path,
        bytes: Number(ap?.bytes) || 0,
        preamble: '',
        sections: [],
        error: reasonText(sp, sec?.status ? `HTTP ${sec.status}` : t('err.network')),
        ...facts,
      }
    }

    function normalizeFile(raw) {
      const f = raw && typeof raw === 'object' ? raw : {}
      return {
        path: String(f.path ?? ''),
        exists: f.exists === true,
        bytes: Number.isFinite(f.bytes) ? f.bytes : bytesOf(f.body),
        mtime: typeof f.mtime === 'string' ? f.mtime : null,
        body: String(f.body ?? ''),
        truncated: f.truncated === true,
        error: typeof f.error === 'string' ? f.error : '',
      }
    }
    /**
     * /project-agents → `{status:'ok', team, local, workspace, root}`；旧宿主没有这个路由（404 / 非 JSON）→ `{status:'unavailable'}`；
     * 其余失败 → `{status:'error', error}`。
     */
    function normalizeProject(res) {
      const p = res?.payload && typeof res.payload === 'object' ? res.payload : {}
      if (res?.ok && p.ok === true) {
        const workspace = normalizeWorkspace(p.workspace)
        // root：两份项目指令文件实际所在的目录（可能是 git 子仓库根，不一定等于工作区）；旧宿主没有就回落工作区
        return { status: 'ok', team: normalizeFile(p.team), local: normalizeFile(p.local), workspace, root: normalizeWorkspace(p.root) ?? workspace }
      }
      if (!res || res.status === 0 || res.status === 404 || (p.ok === undefined && !p.reason)) return { status: 'unavailable' }
      return { status: 'error', error: reasonText(p, `HTTP ${res.status}`) }
    }
    function normalizeWorkspace(raw) {
      if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || !raw.path) return null
      return { path: raw.path, name: typeof raw.name === 'string' && raw.name ? raw.name : lastSegment(raw.path) }
    }

    /**
     * 历史版本目录（删除 / 替换前留档的地方）：宿主 /list 给了 historyDir 就用它；
     * 旧宿主按存储布局推：`<库>/memory` 的同级 `.memory-state/history`。
     */
    function historyDirOf(scope, D) {
      const given = D?.historyDir && typeof D.historyDir === 'object' ? D.historyDir[scope] : null
      if (typeof given === 'string' && given) return given
      const root = scope === 'global' ? D?.globalRoot : D?.root
      if (!root) return ''
      const sep = String(root).includes('\\') ? '\\' : '/'
      return String(root).replace(/[\\/]memory[\\/]?$/, '') + sep + '.memory-state' + sep + 'history'
    }

    /** 宿主可能返回的失败原因码；每个都必须在 ZH / EN 里有 `reason.<码>`。 */
    const KNOWN_REASONS = [
      'invalid-id',
      'invalid-index',
      'not-found',
      'section-not-found',
      'section-moved',
      'only-chapter',
      // 宿主已不再对项目记忆返回它（项目记忆可一步升为全局指令），保留以兼容旧宿主
      'scope-not-global',
      'agents-missing',
      'agents-full',
      'already-present',
      'empty-title',
      'empty-body',
      'library-full',
      'read-failed',
      'write-failed',
      'launch-failed',
      'invalid-scope',
      'scope-ambiguous',
      'target-exists',
      'belongs-in-project-agents',
      'same-library',
      'partially-saved',
      'move-failed',
      'move-partial',
      // 2026-11-15 面板重设计：打开不存在的项目指令文件 / 新建已存在的全局指令文件
      'file-missing',
      'already-exists',
      // /open-agents 收到不认识的 target（正常客户端不会发）
      'invalid-target',
      // 收下常驻草稿时章节协议没对上（宿主 upsert / plan 的结果原样带回）
      'chapter-not-found',
      'needs-confirmation',
      // 路由公共闸门（缺 session、非 JSON、体积超限、坏 JSON）
      'no-session',
      'unsupported-media-type',
      'body-too-large',
      'invalid-json',
    ]

    /**
     * 把宿主的失败响应翻成一句人话。原因码只认 KNOWN_REASONS（原码绝不外露），
     * 其次取宿主给的 errors[0] / error 文本，最后落到调用方给的兜底文案。
     */
    function reasonText(payload, fallback) {
      if (!payload || typeof payload !== 'object') return fallback
      for (const code of [payload.reason, payload.error]) {
        if (typeof code !== 'string' || !KNOWN_REASONS.includes(code)) continue
        if (code === 'agents-full' && Number.isFinite(payload.bytes) && Number.isFinite(payload.limit)) {
          return t('reason.agents-full.bytes', { bytes: payload.bytes, limit: payload.limit })
        }
        return t(`reason.${code}`)
      }
      const first = Array.isArray(payload.errors) ? payload.errors.find((item) => typeof item === 'string' && item) : undefined
      if (first) return first
      if (typeof payload.error === 'string' && payload.error) return payload.error
      return fallback
    }

    /**
     * 收下草稿失败 → 卡片上的一句话。几种常见失败有专门的说法（带章名 / 字节数 / 库名），其余走 reasonText。
     */
    function acceptErrorText(d, payload) {
      const p = payload || {}
      if (p.reason === 'section-moved') return t('pd.err.sectionMoved', { title: d.chapterTitle || d.title })
      if (p.reason === 'belongs-in-project-agents') return t('pd.err.blocked')
      if (p.reason === 'agents-full' && Number.isFinite(p.bytes) && Number.isFinite(p.limit)) return t('pd.err.full', { after: kb(p.bytes), max: kb(p.limit) })
      if (p.reason === 'library-full' && Number.isFinite(p.count)) return t('pd.err.libFull', { lib: libName(p.scope || d.scope), n: p.count })
      return reasonText(p, t('err.generic'))
    }

    /**
     * 收下成功 → 提示（纯函数，便于测试）。`after = {sections, memories}` 是收下后重读的数据（可能为空）。
     * 返回 `{text, persistent?, tone?, goto?: {kind:'chapter', index} | {kind:'memory', key}}`。
     *  - 常驻：按宿主给的 chapter（更新）或标题（新增）在重读后的章节里找章号；replaceFailed → 常驻警告，带「去删除」
     *  - 按需：新记忆的 id 取宿主回的 file（去掉 .md），否则草稿的 slug；替换了旧条时点名旧标题
     */
    function acceptOutcome(d, payload, before, after) {
      const p = payload || {}
      const sections = after?.sections ?? before?.sections ?? []
      if (d.load === 'always' || p.load === 'always') {
        const ag = p.agents || {}
        let idx = -1
        if (Number.isInteger(ag.chapter)) idx = ag.chapter - 1
        if (idx < 0 || !sections[idx]) {
          const want = ag.action === 'added' ? bareTitle(ag.title || d.title) : d.chapterTitle || bareTitle(d.title)
          idx = sections.findIndex((s) => s.name === want)
          // 还没重读：新增的章一定追加在末尾
          if (idx < 0 && ag.action === 'added' && !after) idx = before?.sections?.length ?? -1
        }
        const n = idx >= 0 ? idx + 1 : null
        if (typeof p.replaceFailed === 'string' && p.replaceFailed) {
          const scope = p.replacedScope || d.supersedesScope || 'project'
          const old = (before?.memories ?? []).find((m) => m.id === p.replaceFailed && m.scope === scope)
          const title = old ? old.title : p.replaceFailed
          return {
            text: n ? t('toast.replaceFailed', { n, title }) : t('toast.replaceFailedNoNum', { title }),
            persistent: true,
            tone: 'warn',
            goto: { kind: 'memory', key: `${scope}:${p.replaceFailed}`, label: 'toast.replaceFailed.go' },
          }
        }
        return { text: n ? t('toast.wroteChapter', { n }) : t('toast.wroteChapterNoNum'), goto: n ? { kind: 'chapter', index: n - 1 } : null }
      }
      const scope = p.scope === 'global' || p.scope === 'project' ? p.scope : d.scope
      const fromFile = typeof p.file === 'string' && p.file ? lastSegment(p.file).replace(/\.md$/i, '') : ''
      const id = fromFile || d.slug || ''
      const replacedId = typeof p.replaced === 'string' && p.replaced ? p.replaced : d.supersedes || ''
      const old = replacedId ? (before?.memories ?? []).find((m) => m.id === replacedId) : null
      const text = old && p.replaced ? t('toast.wroteReplace', { lib: libName(scope), title: old.title }) : t('toast.wroteMem', { lib: libName(scope) })
      return { text, goto: id ? { kind: 'memory', key: `${scope}:${id}` } : null }
    }

    /* ---------------------------------------------------- 视图层：h() 适配 */

    /**
     * 视图函数沿用预览的写法：`h(type, props, ...children)`，props 里可以有
     *   - `html`：已经过 renderMarkdown / 固定 SVG 的 HTML 串 → dangerouslySetInnerHTML（绝不传用户原文）
     *   - `style`：CSS 文本（含 `--n` 这类自定义属性）→ React 的 style 对象
     *   - `onMount` / `onUpdate`：元素挂上 / 每次重绘后的回调（经 ref 回调实现，排进本次提交之后执行）
     *   - `onInput`（input / textarea）→ React 的 onChange；`onFocusin` / `onFocusout` → onFocus / onBlur（React 里本就冒泡）
     *   - `autofocus` → `data-autofocus`（React 不把 autofocus 写进 DOM；对话框 showModal 之后按它聚焦）
     * 子节点里的数组包成 Fragment：数组位置稳定，数组内部照常按 key 对齐。
     */
    const Fragment = React.Fragment
    const RENAME = { 'stroke-width': 'strokeWidth', spellcheck: 'spellCheck', onFocusin: 'onFocus', onFocusout: 'onBlur' }
    const styleCache = new Map()
    function styleObj(css) {
      let out = styleCache.get(css)
      if (out) return out
      out = {}
      for (const decl of String(css).split(';')) {
        const at = decl.indexOf(':')
        if (at < 0) continue
        const prop = decl.slice(0, at).trim()
        const value = decl.slice(at + 1).trim()
        if (!prop || !value) continue
        out[prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (all, c) => c.toUpperCase())] = value
      }
      if (styleCache.size > 500) styleCache.clear()
      styleCache.set(css, out)
      return out
    }
    /** 当前正在渲染的面板（ref 回调要把 onMount / onUpdate 排进它的提交后队列）。 */
    let renderingPanel = null
    const mountedEls = new WeakSet()
    function lifecycleRef(userRef, onMount, onUpdate) {
      const owner = renderingPanel
      return (el) => {
        if (typeof userRef === 'function') userRef(el)
        else if (userRef && typeof userRef === 'object') userRef.current = el
        if (!el) return
        const first = !mountedEls.has(el)
        if (first) mountedEls.add(el)
        const fn = first ? onMount : onUpdate
        if (fn && owner) owner.after(() => fn(el))
      }
    }
    function normChildren(list) {
      const out = []
      for (const child of list) out.push(Array.isArray(child) ? h0(Fragment, null, ...normChildren(child)) : child)
      return out
    }
    function h(type, props, ...children) {
      let p = null
      if (props) {
        p = {}
        for (const k in props) {
          const v = props[k]
          if (v === undefined || k === 'onMount' || k === 'onUpdate' || k === 'ref') continue
          if (k === 'html') p.dangerouslySetInnerHTML = { __html: v == null ? '' : String(v) }
          else if (k === 'style') {
            if (v) p.style = typeof v === 'string' ? styleObj(v) : v
          } else if (k === 'onInput' && (type === 'input' || type === 'textarea')) p.onChange = v
          else if (k === 'autofocus') {
            if (v) p['data-autofocus'] = 'true'
          } else p[RENAME[k] || k] = v
        }
        if (props.onMount || props.onUpdate) p.ref = lifecycleRef(props.ref, props.onMount, props.onUpdate)
        else if (props.ref) p.ref = props.ref
      }
      return h0(type, p, ...normChildren(children))
    }
    const cssEscape = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'))
    const reducedMotion = () => {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches
      } catch {
        return false
      }
    }
    const isTyping = (el) =>
      !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio'].includes(el.type)) || el.isContentEditable)
    const sizeFor = (w) => (w < 560 ? 'narrow' : w < 900 ? 'compact' : 'wide')

    /* ---- 图标：自绘线性 SVG，viewBox 16，描边 1 / 1.15（与宿主图标同规格） ---- */
    const ICONS = {
      refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M12 1.5v2.6H9.4"/>',
      focus: '<path d="M2.5 6V2.5H6"/><path d="M10 2.5h3.5V6"/><path d="M13.5 10v3.5H10"/><path d="M6 13.5H2.5V10"/>',
      unfocus: '<path d="M6 2.5V6H2.5"/><path d="M13.5 6H10V2.5"/><path d="M10 13.5V10h3.5"/><path d="M2.5 10H6v3.5"/>',
      search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.1 3.1"/>',
      close: '<path d="m4 4 8 8M12 4l-8 8"/>',
      chevD: '<path d="m4 6 4 4 4-4"/>',
      chevR: '<path d="m6 4 4 4-4 4"/>',
      chevL: '<path d="M10 4 6 8l4 4"/>',
      chevU: '<path d="m4 10 4-4 4 4"/>',
      check: '<path d="m3.5 8.5 3 3 6-7"/>',
      checkCircle: '<circle cx="8" cy="8" r="6"/><path d="m5.5 8.2 1.8 1.8 3.3-3.8"/>',
      edit: '<path d="M10.6 2.4a1.2 1.2 0 0 1 1.7 0l1.3 1.3a1.2 1.2 0 0 1 0 1.7L5.5 13.5h-3v-3z"/><path d="m9.5 3.5 3 3"/>',
      trash: '<path d="M2.5 4.5h11"/><path d="M6 4.5v-2h4v2"/><path d="m4 4.5.7 8.3a.8.8 0 0 0 .8.7h5a.8.8 0 0 0 .8-.7L12 4.5"/><path d="M6.8 7v4.2M9.2 7v4.2"/>',
      more: '<circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none"/>',
      plus: '<path d="M8 3v10M3 8h10"/>',
      info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4"/><circle cx="8" cy="5" r=".75" fill="currentColor" stroke="none"/>',
      warn: '<path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.5 9.6a1 1 0 0 1-.87 1.5H2.5a1 1 0 0 1-.87-1.5z" stroke-linejoin="round"/><path d="M8 6.2v3.3"/><circle cx="8" cy="11.4" r=".75" fill="currentColor" stroke="none"/>',
      external: '<path d="M12.5 9.5v3a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3"/><path d="M9.5 2.5h4v4"/><path d="m13.5 2.5-6 6"/>',
      folder: '<path d="M2 4.5a1 1 0 0 1 1-1h3.1l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
      globe: '<circle cx="8" cy="8" r="5.5"/><ellipse cx="8" cy="8" rx="2.4" ry="5.5"/><path d="M2.5 8h11"/>',
      repeat: '<path d="M2.5 7.5v-1a2 2 0 0 1 2-2h8"/><path d="m10.5 2.5 2 2-2 2"/><path d="M13.5 8.5v1a2 2 0 0 1-2 2h-8"/><path d="m5.5 13.5-2-2 2-2"/>',
      doc: '<path d="M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z"/><path d="M8.5 1.5v4h4"/><path d="M5.5 8.5h5M5.5 11h3.5"/>',
      branch: '<circle cx="5" cy="3.8" r="1.4"/><circle cx="5" cy="12.2" r="1.4"/><circle cx="11" cy="5.2" r="1.4"/><path d="M5 5.2v5.6"/><path d="M11 6.6v.6a2.4 2.4 0 0 1-2.4 2.4H7A2 2 0 0 0 5 11.6"/>',
      user: '<circle cx="8" cy="5.5" r="2.6"/><path d="M2.8 13.5c.6-2.5 2.6-3.9 5.2-3.9s4.6 1.4 5.2 3.9"/>',
      bubble: '<path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2V9a2 2 0 0 1-2 2H7.6l-3.1 2.4V11a2 2 0 0 1-2-2z" stroke-linejoin="round"/>',
      flag: '<path d="M3.5 14.5V2"/><path d="M3.5 2.5h8.2L9.8 5.3l1.9 2.7H3.5" stroke-linejoin="round"/>',
      bookmark: '<path d="M4.5 2.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v11L8 11l-3.5 2.5z" stroke-linejoin="round"/>',
      cone: '<path d="M6.75 2.5h2.5L12 12.5H4z" stroke-linejoin="round"/><path d="M5.8 6h4.4M5 9h6"/><path d="M2.5 13.5h11"/>',
      sparkle: '<path d="M7 2c.35 2.45 1.55 3.65 4 4-2.45.35-3.65 1.55-4 4-.35-2.45-1.55-3.65-4-4 2.45-.35 3.65-1.55 4-4z" stroke-linejoin="round"/><path d="M12 10.5v3M10.5 12h3"/>',
      inbox: '<path d="M2.5 9.5 4.1 4.2a1 1 0 0 1 1-.7h5.8a1 1 0 0 1 1 .7l1.6 5.3V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" stroke-linejoin="round"/><path d="M2.5 9.5h3l.8 1.5h3.4l.8-1.5h3"/>',
      arrowR: '<path d="M2.5 8h11M9.5 4l4 4-4 4"/>',
      arrowUp: '<path d="M8 13.5v-11M4 6.5l4-4 4 4"/>',
      clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.3l2.2 1.4"/>',
      history: '<path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8"/><path d="M2.5 2.4v2.6h2.6"/><path d="M8 5.2v3l2 1.3"/>',
      wand: '<path d="m2.5 13.5 7-7"/><path d="m8.5 5.5 2 2"/><path d="M12 1.5v3M10.5 3h3"/><path d="M13.5 7v2M12.5 8h2"/>',
      nope: '<circle cx="8" cy="8" r="5.5"/><path d="m4.1 11.9 7.8-7.8"/>',
      tag: '<path d="M2.5 3.5a1 1 0 0 1 1-1h4l6 6-5 5-6-6z" stroke-linejoin="round"/><circle cx="5.5" cy="5.5" r=".9" fill="currentColor" stroke="none"/>',
      file: '<path d="M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z"/><path d="M8.5 1.5v4h4"/>',
      pulse: '<path d="M1.5 8.5h2.8l1.6-4 2.6 7 1.8-4.5h4.2" stroke-linejoin="round"/>',
      layers: '<path d="m8 2 6 3-6 3-6-3z" stroke-linejoin="round"/><path d="m2 8 6 3 6-3"/><path d="m2 11 6 3 6-3"/>',
      question: '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.3-.8.6-.8 1.2v.4"/><circle cx="8" cy="11.4" r=".75" fill="currentColor" stroke="none"/>',
    }
    const TYPE_ICON = { user: 'user', feedback: 'bubble', project: 'flag', reference: 'bookmark', pitfall: 'cone' }
    function Icon(name, size, cls) {
      const s = size || 16
      return h('svg', { className: 'wsm-ic' + (cls ? ' ' + cls : ''), width: s, height: s, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': s <= 14 ? '1.15' : '1', 'aria-hidden': 'true', focusable: 'false', html: ICONS[name] || '' })
    }
    /** 位置格子图标：2×2 小地图，实心那一格就是它在记忆地图上的位置。 */
    const CELL_POS = { globalInstr: 0, globalMem: 1, projInstr: 2, projMem: 3 }
    function Glyph(cell, size) {
      const i = CELL_POS[cell]
      const rects = [[2.5, 2.5], [9, 2.5], [2.5, 9], [9, 9]]
        .map(([x, y], k) => (k === i ? `<rect x="${x}" y="${y}" width="4.5" height="4.5" rx="1.3" fill="currentColor"/>` : `<rect x="${x}" y="${y}" width="4.5" height="4.5" rx="1.3" opacity=".38"/>`))
        .join('')
      const s = size || 16
      return h('svg', { className: 'wsm-ic wsm-glyph', width: s, height: s, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1', 'aria-hidden': 'true', focusable: 'false', html: rects })
    }
    function Illustration(kind) {
      const A = {
        inbox: '<ellipse class="i-bg" cx="60" cy="50" rx="54" ry="36"/><rect class="i-surf" x="40" y="12" width="40" height="30" rx="7"/><path class="i-accent" d="m51 27 6 6 11-12"/><path class="i-back" d="M22 54 31 38h58l9 16v15a5 5 0 0 1-5 5H27a5 5 0 0 1-5-5z"/><path class="i-surf" d="M26 56h20l4 7h20l4-7h20v12a3 3 0 0 1-3 3H29a3 3 0 0 1-3-3z"/>',
        cards: '<ellipse class="i-bg" cx="60" cy="50" rx="54" ry="36"/><rect class="i-back" x="34" y="22" width="56" height="40" rx="8" transform="rotate(-6 62 42)"/><rect class="i-surf" x="28" y="26" width="58" height="42" rx="8"/><path class="i-line" d="M38 38h26M38 47h38M38 56h18"/>',
        doc: '<ellipse class="i-bg" cx="60" cy="50" rx="54" ry="36"/><path class="i-surf" d="M38 12h30l16 16v44a4 4 0 0 1-4 4H38a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4z"/><path class="i-line" d="M44 40h28M44 49h28M44 58h16"/><path class="i-back" d="M68 12v12a4 4 0 0 0 4 4h12z"/>',
        broken: '<ellipse class="i-bg" cx="60" cy="50" rx="54" ry="36"/><rect class="i-surf" x="22" y="34" width="34" height="22" rx="11"/><rect class="i-surf" x="64" y="34" width="34" height="22" rx="11"/><path class="i-accent" d="M56 30l-4-6M64 30l4-6M60 28v-8M56 60l-4 6M64 60l4 6"/>',
      }
      return h('svg', { className: 'wsm-ill', width: 120, height: 88, viewBox: '0 0 120 88', 'aria-hidden': 'true', html: A[kind] })
    }
    function Btn(p) {
      const attrs = Object.assign(
        {
          type: 'button',
          className: 'wsm-btn' + (p.className ? ' ' + p.className : ''),
          'data-variant': p.variant || 'ghost',
          'data-size': p.size || 'md',
          onClick: p.onClick,
          disabled: !!p.disabled || !!p.busy,
          'data-busy': p.busy ? 'true' : null,
          'data-tip': p.tip || null,
          key: p.key,
        },
        p.attrs || {},
      )
      return h('button', attrs, p.busy ? h('span', { className: 'wsm-spinner', 'aria-hidden': 'true' }) : p.icon ? Icon(p.icon, p.size === 'sm' ? 14 : 16) : null, p.label != null ? h('span', null, p.label) : null)
    }
    function IconBtn(p) {
      return h('button', Object.assign({ type: 'button', className: 'wsm-iconbtn', 'aria-label': p.label, 'data-tip': p.tip === false ? null : p.tip || p.label, onClick: p.onClick, disabled: !!p.disabled, key: p.key }, p.attrs || {}), Icon(p.icon, p.size || 16))
    }
    function Tag(text, tone, icon, tip, key) {
      return h('span', { className: 'wsm-tag', 'data-tone': tone || null, 'data-tip': tip || null, key }, icon || null, h('span', null, text))
    }
    function Kbd(k) {
      return h('kbd', { className: 'wsm-kbd' }, k)
    }
    function TypeTag(type) {
      const ty = normType(type)
      return Tag(t('type.' + ty), 'neutral', Icon(TYPE_ICON[ty], 12), t('type.' + ty + '.tip'), 'type')
    }
    function Meter(used, max, thin) {
      const r = max ? used / max : 0
      const level = r > 1 ? 'over' : r >= 0.8 ? 'warn' : null
      return h(
        'div',
        { className: 'wsm-meter', 'data-level': level, 'data-thin': thin ? 'true' : null, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(used) },
        h('span', { style: `width:${Math.min(100, Math.max(r > 0 ? 2 : 0, r * 100)).toFixed(1)}%` }),
      )
    }
    function Markdown(text, attrs) {
      return h('div', Object.assign({ className: 'wsm-md', html: md(text) }, attrs || {}))
    }
    function Empty(p) {
      return h(
        'div',
        { className: 'wsm-empty', 'data-inline': p.inline ? 'true' : null, 'data-error': p.error ? 'true' : null, role: p.error ? 'alert' : null, key: p.key },
        p.ill ? Illustration(p.ill) : null,
        h('div', { className: 'wsm-empty-title' }, p.title),
        p.body ? h('p', { className: 'wsm-empty-body' }, p.body) : null,
        p.extra || null,
        p.action || null,
      )
    }
    function autosize(el) {
      if (!el) return
      const sc = el.closest('.wsm-scroll')
      const st = sc ? sc.scrollTop : 0
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
      if (sc) sc.scrollTop = st
    }
    const autosizeHooks = {
      onMount: autosize,
      onUpdate: (el) => {
        if (el.__wsmLast !== el.value) {
          el.__wsmLast = el.value
          autosize(el)
        }
      },
    }

    /* ------------------------------------------------- 面板控制器（每个实例一份） */

    let panelSeq = 0

    /**
     * 一个面板实例的全部状态与动作。视图函数（下面的 MemoryPanel(s) 等）只读 store、调用动作；
     * 动作改 store 后调 up() 触发 React 重绘。换会话时整个实例作废重建（MemoryPanelRoot 以 sessionId 为 key）。
     */
    function createPanel(sessionId) {
      const idp = `wsm${++panelSeq}-`
      const ID = (s) => idp + s
      const S = {
        status: 'loading',
        error: '',
        D: null,
        size: 'compact',
        pw: 640,
        view: 'overview',
        focus: false,
        refreshing: false,
        ov: { flowOpen: false },
        pd: { busy: {}, leaving: {}, errors: {}, mode: {}, current: -1 },
        // ins.source：基线对应的文件内容（判断「文件里这一章变了没」）；ins.busy：正在删除的章 uid
        ins: { tab: 'global', editing: null, draft: null, baseline: null, source: null, conflict: false, error: '', errorField: '', saving: false, busy: null, current: 0, preambleOpen: false, expanded: {}, editor: '', flash: null },
        // mm.docId：编辑区身份（见 setSelection）；mm.busy：{kind:'promote'|'delete', key} 在途时锁住那一条的编辑
        mm: { query: '', scope: 'all', type: 'all', sel: null, docId: 0, view: 'list', bodyView: 'edit', draft: null, baseline: null, errors: {}, saving: false, busy: null, saveError: '', tagInput: null, tagError: '' },
        menu: null,
        modal: null,
        toasts: [],
      }
      try {
        S.ins.editor = window.localStorage?.getItem(EDITOR_KEY) || ''
      } catch {
        S.ins.editor = ''
      }

      const P = {
        S,
        root: null,
        tipEl: null,
        rerender: null,
        disposed: false,
        started: false,
        afterQ: [],
        focusQ: [],
        timers: new Set(),
        seq: { list: 0, agents: 0, project: 0 },
        scrollMem: {},
        after(fn) {
          this.afterQ.push(fn)
        },
      }
      const up = () => {
        if (!P.disposed && P.rerender) P.rerender()
      }
      const later = (fn, ms) => {
        const id = setTimeout(() => {
          P.timers.delete(id)
          if (!P.disposed) fn()
        }, ms)
        P.timers.add(id)
        return id
      }
      const q = (selector) => (P.root ? P.root.querySelector(selector) : null)
      const qa = (selector) => (P.root ? Array.from(P.root.querySelectorAll(selector)) : [])
      const attrSel = (attr, value) => `[${attr}="${cssEscape(value)}"]`
      function focusLater(target) {
        P.focusQ.push(() => {
          const el = typeof target === 'string' ? q(target) : typeof target === 'function' ? target() : target
          if (el && el.isConnected) el.focus({ preventScroll: false })
        })
        up()
      }

      /* ---- 宿主接口 ---- */

      /**
       * 统一的请求：记忆库路由带 `?session=`；POST 一律 application/json（否则宿主 415）。
       * 返回 `{ok, status, payload}`：ok = HTTP 2xx 且 payload.ok === true。网络错误 status 为 0。
       */
      async function api(path, options = {}) {
        const { method = 'GET', body, session = true } = options
        const url = API + path + (session ? `${path.includes('?') ? '&' : '?'}session=${encodeURIComponent(sessionId || '')}` : '')
        const init = method === 'GET' ? { headers: { accept: 'application/json' } } : { method, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body || {}) }
        let response
        try {
          response = await fetch(url, init)
        } catch (error) {
          return { ok: false, status: 0, payload: { ok: false, error: t('err.networkDetail', { msg: String(error?.message ?? error) }) } }
        }
        let payload = {}
        try {
          payload = (await response.json()) || {}
        } catch {
          payload = {}
        }
        if (!payload || typeof payload !== 'object') payload = {}
        return { ok: response.ok && payload.ok === true, status: response.status, payload }
      }

      function applyList(payload) {
        const prev = S.D
        const memories = Array.isArray(payload.memories) ? payload.memories : []
        const pending = Array.isArray(payload.pending) ? payload.pending : []
        S.D = {
          root: String(payload.root ?? ''),
          globalRoot: String(payload.globalRoot ?? ''),
          agentWrites: payload.agentWrites ?? null,
          pendingEnabled: Boolean(payload.pendingEnabled),
          workspace: normalizeWorkspace(payload.workspace) ?? prev?.workspace ?? null,
          limits: normalizeLimits(payload.limits),
          historyDir: payload.historyDir && typeof payload.historyDir === 'object' ? payload.historyDir : null,
          memories,
          pending,
          agents: prev?.agents ?? { status: 'loading', exists: false, path: '', bytes: 0, preamble: '', sections: [], limit: null, mtime: null, historyLimit: null, historyDir: '', error: '' },
          editors: prev?.editors ?? [],
          project: prev?.project ?? { status: 'loading' },
        }
      }
      async function reloadList() {
        const seq = ++P.seq.list
        const r = await api('/list')
        if (P.disposed || seq !== P.seq.list) return null
        if (!r.ok) return r
        applyList(r.payload)
        up()
        return r
      }
      async function reloadAgents() {
        const seq = ++P.seq.agents
        const [sec, stat] = await Promise.all([api('/agents/sections', { session: false }), api('/agents', { session: false })])
        if (P.disposed || seq !== P.seq.agents || !S.D) return
        S.D.agents = normalizeAgents(sec, stat)
        if (Array.isArray(stat.payload?.editors)) S.D.editors = stat.payload.editors
        up()
      }
      async function reloadProject() {
        const seq = ++P.seq.project
        const r = await api('/project-agents')
        if (P.disposed || seq !== P.seq.project || !S.D) return
        S.D.project = normalizeProject(r)
        if (S.D.project.workspace && !S.D.workspace) S.D.workspace = S.D.project.workspace
        up()
      }
      /**
       * 首次读取与「刷新」：四个接口并发，读齐了一次性落到 store（免得总览先闪一下「暂时读不到」）。
       * 列表是必需的（失败就显示出错页）；全局指令、项目指令各自降级。返回 true，或列表失败时的说明文字。
       */
      async function loadAll(options = {}) {
        if (!sessionId) {
          S.status = 'error'
          S.error = t('st.noSession')
          up()
          return false
        }
        if (!options.silent) {
          S.status = 'loading'
          up()
        }
        // 领新序号：在途的单项重读（reloadList / reloadAgents / reloadProject）一律作废，以这一轮为准
        const seq = ++P.seq.list
        const seqA = ++P.seq.agents
        const seqP = ++P.seq.project
        const [r, sec, stat, proj] = await Promise.all([
          api('/list'),
          api('/agents/sections', { session: false }),
          api('/agents', { session: false }),
          api('/project-agents'),
        ])
        if (P.disposed || seq !== P.seq.list) return false
        if (!r.ok) {
          const message = reasonText(r.payload, r.status ? `HTTP ${r.status}` : t('err.network'))
          // 静默刷新失败不把已有的列表换成报错（F77）
          if (!S.D || !options.silent) {
            S.status = 'error'
            S.error = message
          }
          up()
          return message
        }
        applyList(r.payload)
        if (seqA === P.seq.agents) {
          S.D.agents = normalizeAgents(sec, stat)
          if (Array.isArray(stat.payload?.editors)) S.D.editors = stat.payload.editors
        }
        if (seqP === P.seq.project) {
          S.D.project = normalizeProject(proj)
          if (S.D.project.workspace && !S.D.workspace) S.D.workspace = S.D.project.workspace
        }
        S.status = 'ready'
        up()
        return true
      }

      /* ---- 派生 ---- */
      const findMem = (key) => (S.D ? S.D.memories.find((m) => memKey(m) === key) ?? null : null)
      const sections = () => (S.D ? S.D.agents.sections : [])
      const memDirty = () => !!(S.mm.draft && S.mm.baseline && !sameDraft(S.mm.draft, S.mm.baseline))
      const chapDirty = () =>
        !!(S.ins.editing != null && S.ins.draft && S.ins.baseline && (S.ins.draft.title !== S.ins.baseline.title || S.ins.draft.body !== S.ins.baseline.body))
      const chapNumOf = (uid) => sections().findIndex((s) => s.uid === uid) + 1
      const limits = () => (S.D ? S.D.limits : normalizeLimits(null))

      function visibleMems(over) {
        const o = over || {}
        const query = String(o.query != null ? o.query : S.mm.query).trim().toLowerCase()
        const scope = o.scope || S.mm.scope
        const type = o.type || S.mm.type
        return S.D.memories
          .slice()
          .sort(byModified)
          .filter(
            (m) =>
              (scope === 'all' || m.scope === scope) &&
              (type === 'all' || normType(m.type) === type) &&
              (!query || [m.title, m.description, m.id, m.body].concat(m.tags || []).some((x) => String(x || '').toLowerCase().includes(query))),
          )
      }
      function setSelection(m) {
        const key = m ? memKey(m) : null
        // docId 是编辑区的身份：换了一条才变；改名、换库只改 sel，不变 docId，编辑区不重挂、焦点不丢
        if (key !== S.mm.sel) S.mm.docId += 1
        S.mm.sel = key
        S.mm.draft = m ? toDraft(m) : null
        S.mm.baseline = m ? toDraft(m) : null
        S.mm.errors = {}
        S.mm.saveError = ''
        S.mm.tagInput = null
        S.mm.tagError = ''
      }

      /** 渲染前的规整：选中项消失、分栏时自动选第一条（F16）、数据变了且没修改时重建基线（F89）、正在编辑的章不见了。 */
      function normalize() {
        if (!S.D) return
        const M = S.mm
        if (M.sel && !findMem(M.sel) && !M.saving) {
          setSelection(null)
          M.view = 'list'
        }
        if (M.sel && !M.saving && !M.busy && !memDirty()) {
          const m = findMem(M.sel)
          if (m && !sameDraft(toDraft(m), M.baseline)) {
            M.draft = toDraft(m)
            M.baseline = toDraft(m)
          }
        }
        if (S.view === 'memories' && S.size !== 'narrow' && !memDirty() && !M.saving && !M.busy) {
          const vis = visibleMems()
          if (!M.sel || !vis.some((m) => memKey(m) === M.sel)) setSelection(vis[0] || null)
        }
        if (S.size === 'narrow' && M.view === 'detail' && !M.sel) M.view = 'list'
        const I = S.ins
        if (I.editing != null && I.editing !== 'new' && !I.saving) {
          const sec = sections().find((s) => s.uid === I.editing)
          if (!sec) {
            // 正在编辑的章在文件里不见了（被改名或删除）：有修改就把草稿转成「新的一章」，不丢用户写的东西
            if (chapDirty()) {
              I.editing = 'new'
              I.baseline = { title: '', body: '' }
              I.source = null
              I.conflict = false
              I.error = t('in.err.moved')
              I.errorField = ''
            } else {
              I.editing = null
              I.draft = null
            }
          } else if (!chapDirty()) {
            // 没改过：跟着文件走（收下了覆盖这一章的草稿、外部改过、刷新之后），免得下次保存把旧正文写回去
            if (sec.name !== I.baseline.title || sec.body !== I.baseline.body) {
              I.draft = { title: sec.name, body: sec.body }
              I.baseline = { title: sec.name, body: sec.body }
              I.source = { name: sec.name, body: sec.body }
              I.conflict = false
            }
          } else if (I.source && (sec.name !== I.source.name || sec.body !== I.source.body)) {
            // 改过、而文件里的这一章也变了：标冲突，保存前要人确认，不静默覆盖
            I.conflict = true
          }
        }
      }
      const memBusy = () => S.mm.saving || !!S.mm.busy
      const insBusy = () => S.ins.saving || !!S.ins.busy
      /** 保存 / 升级 / 删除在途时不许换编辑对象，提示一句（同样的提示不叠）。 */
      function blockedByBusy() {
        if (!memBusy() && !insBusy()) return false
        toast(t('toast.busy'))
        return true
      }

      /* ---- 浮层：菜单 / 对话框 / 提示 ---- */
      function openMenu(id, anchor, build, align) {
        if (S.menu && S.menu.id === id) {
          closeMenu()
          return
        }
        hideTip()
        S.menu = { id, anchor, build, align: align || 'start', returnFocus: q(attrSel('data-menu-anchor', anchor)) || document.activeElement }
        up()
      }
      function closeMenu(restore) {
        const r = S.menu && S.menu.returnFocus
        S.menu = null
        up()
        if (restore !== false && r && r.isConnected) focusLater(r)
      }
      let modalSeq = 0
      function openModal(m) {
        hideTip()
        S.menu = null
        m.uid = ++modalSeq
        m.returnFocus = document.activeElement
        S.modal = m
        up()
      }
      function closeModal() {
        const r = S.modal && S.modal.returnFocus
        S.modal = null
        up()
        if (r && r.isConnected && P.root && P.root.contains(r)) focusLater(r)
      }
      let toastSeq = 0
      /** 普通提示 3 秒后消失；需要人处理的（persistent）常驻直到关掉（U23）。 */
      function toast(text, opts) {
        const o = opts || {}
        // 同一句还挂着就不再叠一条（例如在途时连点几下）
        if (!o.persistent && S.toasts.some((x) => !x.leaving && !x.persistent && x.text === text)) return
        const id = ++toastSeq
        S.toasts = S.toasts.concat([Object.assign({ id, text }, o)]).slice(-3)
        if (!o.persistent) later(() => dismissToast(id), 3000)
        up()
      }
      function dismissToast(id) {
        const x = S.toasts.find((y) => y.id === id)
        if (!x || x.leaving) return
        x.leaving = true
        up()
        later(() => {
          S.toasts = S.toasts.filter((y) => y.id !== id)
          up()
        }, reducedMotion() ? 0 : 180)
      }
      const failToast = (key, vars) => toast(t(key, vars), { persistent: true, tone: 'warn' })

      /* ---- 未保存守卫：覆盖所有「离开」入口（隐性约束 §6.5） ---- */
      function guard(next, opts) {
        const o = opts || {}
        // 保存 / 升级 / 删除在途：不许换编辑对象（返回时要落到发请求的那一项上）
        if (blockedByBusy()) return
        if (memDirty() && !o.skipMem) return openGuard('mem', next, o)
        if (chapDirty() && !o.skipChap) return openGuard('chap', next, o)
        next()
      }
      function openGuard(kind, next, o) {
        const promote = o.kind === 'promote'
        const msg = kind === 'mem' ? t('guard.msg.mem', { title: S.mm.baseline.title }) : S.ins.editing === 'new' ? t('guard.msg.new') : t('guard.msg.chap', { n: chapNumOf(S.ins.editing) })
        const discard = () => {
          closeModal()
          if (kind === 'mem') {
            S.mm.draft = toDraft(S.mm.baseline)
            S.mm.errors = {}
            S.mm.saveError = ''
          } else closeChapterEditor()
          up()
          guard(next, o)
        }
        // 「保存」失败时停在原地：只有保存成功的回调才会继续
        const save = () => {
          closeModal()
          if (kind === 'mem') saveMemory(() => guard(next, o))
          else saveChapter(() => guard(next, o))
        }
        openModal({
          title: promote ? t('guard.promote.title') : t('guard.title'),
          message: msg,
          buttons: [
            { label: t('guard.keep'), variant: 'outline', onClick: closeModal, autofocus: true },
            { label: promote ? t('guard.promote.discard') : t('guard.discard'), variant: 'outline', onClick: discard },
            { label: promote ? t('guard.promote.save') : t('guard.save'), variant: 'primary', onClick: save },
          ],
        })
      }

      function setView(v) {
        if (S.view === v) return
        guard(() => {
          S.view = v
          S.menu = null
          up()
        })
      }
      function refresh() {
        guard(() => {
          S.refreshing = true
          up()
          loadAll({ silent: true }).then((ok) => {
            S.refreshing = false
            if (ok === true) toast(t('toast.refreshed'))
            else if (typeof ok === 'string' && S.D) failToast('toast.refreshFailed', { reason: ok })
            up()
          })
        })
      }
      function toggleFocus() {
        S.focus = !S.focus
        hideTip()
        up()
      }

      /* ---- 待确认 ---- */
      function scheduleReload(parts) {
        later(() => {
          if (parts.includes('list')) reloadList()
          if (parts.includes('agents')) reloadAgents()
        }, 320)
      }
      async function acceptDraft(id) {
        const P2 = S.pd
        const d = S.D && S.D.pending.find((x) => x.id === id)
        if (!d || P2.busy[id] || P2.leaving[id]) return
        P2.busy[id] = 'accept'
        P2.errors[id] = ''
        up()
        const before = { sections: sections(), memories: S.D.memories }
        const r = await api('/accept', { method: 'POST', body: { id } })
        if (P.disposed) return
        P2.busy[id] = null
        if (!r.ok) {
          P2.errors[id] = acceptErrorText(d, r.payload)
          // 章被挪动 / 删掉了：重读一次，让去向与对比回到文件的真实状态
          if (r.payload.reason === 'section-moved') reloadAgents()
          up()
          return
        }
        const out = acceptOutcome(d, r.payload, before, null)
        P2.leaving[id] = true
        toast(out.text, {
          persistent: !!out.persistent,
          tone: out.tone,
          action: out.goto
            ? { label: t(out.goto.label || 'toast.view'), run: () => (out.goto.kind === 'chapter' ? gotoChapter(out.goto.index) : openMemory(out.goto.key)) }
            : null,
        })
        up()
        scheduleReload(d.load === 'always' || r.payload.load === 'always' ? ['list', 'agents'] : ['list'])
      }
      function discardDraft(id) {
        const d = S.D && S.D.pending.find((x) => x.id === id)
        if (!d || S.pd.busy[id] || S.pd.leaving[id]) return
        openModal({
          title: t('pd.discard.title'),
          tone: 'danger',
          message: t('pd.discard.msg', { title: d.title }),
          buttons: [
            { label: t('dlg.cancel'), variant: 'outline', onClick: closeModal, autofocus: true },
            {
              label: t('pd.discard.ok'),
              variant: 'danger',
              onClick: async () => {
                closeModal()
                S.pd.busy[id] = 'discard'
                S.pd.errors[id] = ''
                up()
                const r = await api('/reject', { method: 'POST', body: { id } })
                if (P.disposed) return
                S.pd.busy[id] = null
                if (!r.ok) {
                  S.pd.errors[id] = reasonText(r.payload, t('err.generic'))
                  up()
                  return
                }
                S.pd.leaving[id] = true
                toast(t('toast.discarded'))
                up()
                scheduleReload(['list'])
              },
            },
          ],
        })
      }
      function finishLeave(id) {
        const list = S.D.pending
        const idx = list.findIndex((x) => x.id === id)
        S.D.pending = list.filter((x) => x.id !== id)
        delete S.pd.leaving[id]
        delete S.pd.errors[id]
        up()
        // 焦点交给下一张卡，键盘流不断
        const nextId = (S.D.pending[idx] || S.D.pending[idx - 1] || {}).id
        if (nextId) focusLater(attrSel('data-draft', nextId))
      }
      function moveDraft(delta) {
        const cards = qa('.wsm-draft')
        if (!cards.length) return
        const cur = cards.indexOf(document.activeElement && document.activeElement.closest('.wsm-draft'))
        const i = Math.max(0, Math.min(cards.length - 1, cur < 0 ? (delta > 0 ? 0 : cards.length - 1) : cur + delta))
        cards[i].focus()
        cards[i].scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' })
      }
      /** A / D 只作用于焦点所在的那张卡；焦点不在任何卡上（页签、面板空白处）时不动，不回落到第一张。 */
      function focusedDraftId() {
        const el = document.activeElement && document.activeElement.closest && document.activeElement.closest('.wsm-draft')
        return el && P.root && P.root.contains(el) ? el.dataset.draft : null
      }

      /* ---- 记忆 ---- */
      function openMemory(key) {
        guard(() => {
          const m = findMem(key)
          if (!m) return
          S.view = 'memories'
          if (!visibleMems().some((x) => memKey(x) === key)) {
            S.mm.query = ''
            S.mm.type = 'all'
            S.mm.scope = 'all'
          }
          if (S.mm.sel !== key) setSelection(m)
          if (S.size === 'narrow') S.mm.view = 'detail'
          up()
        })
      }
      function selectMemory(key) {
        if (S.mm.sel === key) {
          if (S.size === 'narrow') {
            S.mm.view = 'detail'
            up()
          }
          return
        }
        guard(() => {
          const m = findMem(key)
          if (m) {
            setSelection(m)
            if (S.size === 'narrow') S.mm.view = 'detail'
            up()
          }
        })
      }
      function setFilter(patchObj) {
        const willHide = memDirty() && !visibleMems(patchObj).some((m) => memKey(m) === S.mm.sel)
        const apply = () => {
          Object.assign(S.mm, patchObj)
          up()
        }
        if (willHide) guard(apply)
        else apply()
      }
      function gotoMemories(scope) {
        guard(() => {
          S.view = 'memories'
          S.mm.scope = scope
          S.mm.type = 'all'
          S.mm.query = ''
          if (S.size === 'narrow') S.mm.view = 'list'
          up()
        })
      }
      function gotoInstructions(tab) {
        guard(() => {
          S.view = 'instructions'
          S.ins.tab = tab
          up()
        })
      }
      function editDraft(patchObj) {
        Object.assign(S.mm.draft, patchObj)
        S.mm.saveError = ''
        up()
      }

      /**
       * 保存：POST /save，请求带条目**现在所在**的库（基线的 scope），patch.scope 是下拉的值——两者不同宿主就换库。
       * 以宿主回读的 memory 为准（改 slug 会换 id）；文件名没改就不传，旧的中文 / 大写 id 不会挡住其余字段（U16）。
       * `onDone` 只在保存成功后调用：守卫里的「保存并继续」失败时停在原地。
       */
      function saveMemory(onDone) {
        const M = S.mm
        if (!M.draft || M.saving || M.busy || !S.D) return false
        const m = findMem(M.sel)
        if (!m) return false
        const d = M.draft
        const base = M.baseline
        const L = limits()
        const errs = validateDraft(d, L, base)
        const moved = d.scope !== base.scope
        const others = S.D.memories.filter((x) => x.scope === d.scope && memKey(x) !== M.sel)
        if (!errs.slug && (moved || d.slug !== base.slug) && others.some((x) => x.id === d.slug)) {
          if (moved) {
            M.saveError = t('err.target.exists', { lib: libName(d.scope), id: d.slug })
            up()
            return false
          }
          errs.slug = t('err.slug.taken', { lib: libName(d.scope), id: d.slug })
        }
        M.errors = errs
        if (Object.keys(errs).length) {
          M.saveError = t('err.fix')
          up()
          focusLater(() => q('[aria-invalid="true"]') || q('.wsm-slug[data-invalid] input'))
          return false
        }
        if (moved && L.maxMemoryCount && others.length >= L.maxMemoryCount) {
          M.saveError = t('err.library.full', { lib: libName(d.scope), n: others.length })
          up()
          return false
        }
        M.saving = true
        M.saveError = ''
        up()
        const targetKey = M.sel
        // 发出去的那一版：保存在途时用户还能接着改（不锁编辑器），返回时据此判断草稿有没有又变
        const snap = Object.assign({}, d, { tags: d.tags.slice() })
        const patch = { title: snap.title, description: snap.description, type: snap.type, scope: snap.scope, tags: snap.tags.slice(), body: snap.body }
        if (snap.slug !== base.slug) patch.slug = snap.slug
        api('/save', { method: 'POST', body: { id: m.id, scope: base.scope, patch } }).then((r) => {
          if (P.disposed) return
          M.saving = false
          const still = M.sel === targetKey
          if (!r.ok) {
            const p = r.payload
            const errors = Array.isArray(p.errors) ? p.errors.filter((x) => typeof x === 'string' && x) : []
            const known = typeof p.reason === 'string' && KNOWN_REASONS.includes(p.reason)
            const message = known ? [reasonText(p, t('err.save')), ...errors].join('\n') : errors.length ? errors.join('\n') : reasonText(p, t('err.save'))
            // 已经换了库、其余字段没存上（partially-saved）：条目现在在 p.scope 那个库。按发请求时的那一条处理：
            // 列表里的条目改到新库、整表重读；仍选着它就改基线所在库（下次保存才不会发到旧库），否则用常驻提示点名
            if (p.moved === true && (p.scope === 'global' || p.scope === 'project')) {
              const local = findMem(targetKey)
              if (local) local.scope = p.scope
              if (still) {
                M.baseline.scope = p.scope
                M.sel = `${p.scope}:${m.id}`
              }
              reloadList()
            }
            if (still) M.saveError = message
            else failToast('toast.saveFailedFor', { title: m.title, reason: message })
            up()
            return
          }
          const memory = r.payload.memory && typeof r.payload.memory === 'object' ? r.payload.memory : null
          if (memory) {
            if (!memory.scope) memory.scope = r.payload.scope || snap.scope
            S.D.memories = S.D.memories.map((x) => (memKey(x) === targetKey ? memory : x))
            if (still) {
              M.sel = memKey(memory)
              const saved = toDraft(memory)
              // 在途期间又改过：只把基线换成刚存进去的版本，草稿与「未保存」状态保留
              if (sameDraft(M.draft, snap)) M.draft = toDraft(memory)
              M.baseline = saved
              M.errors = {}
            }
          }
          toast(moved ? t('toast.savedMoved', { lib: libName(snap.scope) }) : t('toast.saved'))
          if (!memory || moved || r.payload.renamed || r.payload.moved) reloadList()
          up()
          if (onDone && still && !memDirty()) onDone()
        })
        return true
      }
      function discardMemoryEdits() {
        if (!memDirty()) return
        openModal({
          title: t('mm.discard.title'),
          message: t('mm.discard.msg', { title: S.mm.baseline.title }),
          buttons: [
            { label: t('guard.keep'), variant: 'outline', onClick: closeModal, autofocus: true },
            {
              label: t('mm.discard.ok'),
              variant: 'danger',
              onClick: () => {
                closeModal()
                S.mm.draft = toDraft(S.mm.baseline)
                S.mm.errors = {}
                S.mm.saveError = ''
                S.mm.tagInput = null
                up()
              },
            },
          ],
        })
      }
      function deleteMemory(key) {
        const m = findMem(key)
        if (!m || blockedByBusy()) return
        const dir = historyDirOf(m.scope, S.D)
        openModal({
          title: t('mm.del.title'),
          tone: 'danger',
          message: t('mm.del.msg', { title: m.title, lib: libName(m.scope) }),
          extra: dir ? [h('p', { key: 'h' }, t('mm.del.history')), h('code', { key: 'p', className: 'wsm-dialog-path' }, homeShort(dir))] : null,
          buttons: [
            { label: t('dlg.cancel'), variant: 'outline', onClick: closeModal, autofocus: true },
            {
              label: t('mm.del.ok'),
              variant: 'danger',
              onClick: async () => {
                closeModal()
                if (blockedByBusy()) return
                // 在途时锁住这一条的编辑（删掉之后编辑区会清空，期间敲的字没有去处）
                S.mm.busy = { kind: 'delete', key }
                up()
                const r = await api('/forget', { method: 'POST', body: { id: m.id, scope: m.scope } })
                if (P.disposed) return
                S.mm.busy = null
                if (!r.ok) {
                  failToast('toast.deleteFailed', { title: m.title, reason: reasonText(r.payload, t('err.generic')) })
                  up()
                  return
                }
                S.D.memories = S.D.memories.filter((x) => memKey(x) !== key)
                if (S.mm.sel === key) {
                  setSelection(null)
                  S.mm.view = 'list'
                }
                toast(t('toast.deleted', { title: m.title }))
                up()
                reloadList()
              },
            },
          ],
        })
      }

      /**
       * 升为全局指令（两个库的条目都可以，宿主 D 接口一步完成：追加新章 → 写成功后在来源库归档删除）。
       * 先过守卫（保存后升级 / 放弃后升级），再弹确认；全局指令文件不存在时先新建（F 接口）。
       */
      function promoteMemory(key) {
        const wasSelected = S.mm.sel === key
        const run = () => {
          // 「保存后升级」可能刚改了 slug 或换了库：选中项以 store 里的最新 key 为准
          const m = wasSelected ? findMem(S.mm.sel) : findMem(key)
          if (!m) return
          const ag = S.D.agents
          const n = ag.sections.length + 1
          const before = ag.exists ? ag.bytes : 0
          const after = estimatePromotedBytes(before, n, m.title, m.body, m.id)
          const max = ag.limit
          const full = !!max && after > max
          const extra = []
          if (m.scope === 'project') extra.push(h('p', { key: 'fp' }, t('mm.promote.fromProject')))
          if (ag.status === 'missing') extra.push(h('p', { key: 'cr' }, t('mm.promote.create')))
          extra.push(
            h(
              'div',
              { key: 'im', className: 'wsm-dialog-impact', 'data-tone': full ? 'over' : null },
              Icon(full ? 'warn' : 'arrowUp', 14),
              h(
                'span',
                null,
                full
                  ? t('mm.promote.full', { max: kb(max), after: kb(after) })
                  : max
                    ? t('mm.promote.budget', { before: kb(before), after: kb(after), max: kb(max) })
                    : t('mm.promote.budgetNoMax', { before: kb(before), after: kb(after) }),
              ),
            ),
          )
          extra.push(h('p', { key: 'hi' }, t('mm.promote.history')))
          openModal({
            title: t('mm.promote.title'),
            message: t('mm.promote.msg', { title: m.title, n, lib: libName(m.scope) }),
            extra,
            buttons: [
              { label: t('dlg.cancel'), variant: 'outline', onClick: closeModal, autofocus: true },
              {
                label: t('mm.promote.ok'),
                variant: 'primary',
                onClick: () => {
                  closeModal()
                  doPromote(m)
                },
              },
            ],
          })
        }
        guard(run, { kind: 'promote' })
      }
      async function doPromote(m) {
        if (blockedByBusy()) return
        const key = memKey(m)
        // 在途时锁住这一条的编辑：成功后条目会从记忆里移出、编辑区清空，期间敲的字没有去处
        S.mm.busy = { kind: 'promote', key }
        up()
        const done = () => {
          S.mm.busy = null
          up()
        }
        if (S.D.agents.status === 'missing') {
          const c = await api('/agents/create', { method: 'POST', session: false, body: {} })
          if (P.disposed) return
          if (!c.ok && c.payload.reason !== 'already-exists') {
            done()
            failToast('toast.promoteFailed', { reason: reasonText(c.payload, c.status ? `HTTP ${c.status}` : t('err.generic')) })
            return
          }
        }
        const r = await api('/promote', { method: 'POST', body: { id: m.id, scope: m.scope } })
        if (P.disposed) return
        if (!r.ok) {
          done()
          failToast('toast.promoteFailed', { reason: reasonText(r.payload, t('err.generic')) })
          if (r.payload.reason === 'agents-missing') reloadAgents()
          return
        }
        const p = r.payload
        const removed = p.memoryRemoved !== false
        if (removed) {
          S.D.memories = S.D.memories.filter((x) => memKey(x) !== key)
          if (S.mm.sel === key) {
            setSelection(null)
            S.mm.view = 'list'
          }
        }
        done()
        await reloadAgents()
        if (P.disposed) return
        const title = bareTitle(p.title || m.title)
        const idx = sections().findIndex((s) => s.name === title)
        if (!removed) {
          // 宿主的 removeError 是中文整句，这里用自己的文案（英文界面不露中文）
          failToast(idx >= 0 ? 'toast.promotedKept' : 'toast.promotedKeptNoNum', { n: idx + 1, lib: libName(m.scope), title: m.title })
          const last = S.toasts[S.toasts.length - 1]
          if (last) last.action = { label: t('toast.replaceFailed.go'), run: () => openMemory(key) }
        } else {
          toast(idx >= 0 ? t('toast.promoted', { n: idx + 1 }) : t('toast.promotedNoNum'), idx >= 0 ? { action: { label: t('toast.view'), run: () => gotoChapter(idx) } } : null)
        }
        reloadList()
      }

      /* ---- 指令 ---- */
      function startEditChapter(uid) {
        if (S.ins.editing === uid) return
        guard(
          () => {
            const sec = sections().find((s) => s.uid === uid)
            if (!sec) return
            Object.assign(S.ins, {
              editing: uid,
              draft: { title: sec.name, body: sec.body },
              baseline: { title: sec.name, body: sec.body },
              source: { name: sec.name, body: sec.body },
              conflict: false,
              error: '',
              errorField: '',
            })
            up()
            focusLater(attrSel('data-chap-body', uid))
          },
          { skipMem: true },
        )
      }
      function startNewChapter() {
        guard(
          () => {
            Object.assign(S.ins, { editing: 'new', draft: { title: '', body: '' }, baseline: { title: '', body: '' }, source: null, conflict: false, error: '', errorField: '' })
            up()
            focusLater('[data-chap-input="new"]')
            P.after(() => {
              const el = q('[data-chap="new"]')
              if (el) el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
            })
          },
          { skipMem: true },
        )
      }
      function closeChapterEditor() {
        Object.assign(S.ins, { editing: null, draft: null, baseline: null, source: null, conflict: false, error: '', errorField: '' })
      }
      /** 冲突时「改用文件里的内容」：草稿、基线都换成文件里这一章现在的样子。 */
      function useFileChapter() {
        const sec = sections().find((s) => s.uid === S.ins.editing)
        if (!sec) return
        Object.assign(S.ins, {
          draft: { title: sec.name, body: sec.body },
          baseline: { title: sec.name, body: sec.body },
          source: { name: sec.name, body: sec.body },
          conflict: false,
          error: '',
          errorField: '',
        })
        up()
      }
      function cancelChapter() {
        if (S.ins.saving) return
        const exit = () => {
          closeChapterEditor()
          up()
        }
        if (!chapDirty()) return exit()
        openModal({
          title: t('in.discard.title'),
          message: S.ins.editing === 'new' ? t('in.discard.msgNew') : t('in.discard.msg', { n: chapNumOf(S.ins.editing) }),
          buttons: [
            { label: t('in.keep'), variant: 'outline', onClick: closeModal, autofocus: true },
            {
              label: t('in.discard.ok'),
              variant: 'danger',
              onClick: () => {
                closeModal()
                exit()
              },
            },
          ],
        })
      }
      /** 章节失败 → 编辑器里的一句话；章被挪动时重读（normalize 会按标题找回，找不到就转成新章）。 */
      function chapterError(p, title) {
        if (p.reason === 'agents-full' && Number.isFinite(p.bytes) && Number.isFinite(p.limit)) return t('in.err.full', { after: kb(p.bytes), max: kb(p.limit) })
        if (p.reason === 'already-present') return t('in.err.dup', { title: p.title || title })
        if (p.reason === 'empty-title') return t('in.err.emptyTitle')
        return reasonText(p, t('err.save'))
      }
      /**
       * 保存正在编辑的章（新增走 add-section，已有的走 save-section + expectedTitle）。
       *  - 没改过的已有章不发请求（与禁用的保存按钮一致）
       *  - 文件里这一章在编辑期间变了（conflict）：先问是覆盖、改用文件里的，还是继续编辑；`opts.force` 跳过这一问
       *  - 在途期间不锁输入：返回时草稿若又变了，编辑器留着、基线换成刚存进去的版本；只在仍是发请求的那一章时才动编辑器
       */
      function saveChapter(onDone, opts) {
        const I = S.ins
        if (I.editing == null || I.saving || I.busy || !S.D) return false
        const isNew = I.editing === 'new'
        if (!isNew && !chapDirty()) return false
        const checked = checkChapterTitle(I.draft.title, sections(), isNew ? null : I.editing)
        if (checked.error) {
          I.error = checked.error
          I.errorField = 'title'
          up()
          focusLater(attrSel('data-chap-input', I.editing))
          return false
        }
        if (!isNew && I.conflict && !(opts && opts.force)) {
          openModal({
            title: t('in.conflict.title'),
            message: t('in.conflict.msg', { n: chapNumOf(I.editing) }),
            buttons: [
              { label: t('in.keep'), variant: 'outline', onClick: closeModal, autofocus: true },
              {
                label: t('in.conflict.useFile'),
                variant: 'outline',
                onClick: () => {
                  closeModal()
                  useFileChapter()
                },
              },
              {
                label: t('in.conflict.overwrite'),
                variant: 'primary',
                onClick: () => {
                  closeModal()
                  saveChapter(onDone, { force: true })
                },
              },
            ],
          })
          return false
        }
        const title = checked.title
        const sec = isNew ? null : sections().find((s) => s.uid === I.editing)
        const reqEditing = I.editing
        const snap = { title: I.draft.title, body: I.draft.body }
        I.saving = true
        I.error = ''
        I.errorField = ''
        up()
        const request = isNew
          ? api('/agents/add-section', { method: 'POST', session: false, body: { title, body: snap.body } })
          : api('/agents/save-section', { method: 'POST', session: false, body: { index: sec.index, expectedTitle: sec.name, title, body: snap.body } })
        request.then(async (r) => {
          if (P.disposed) return
          const p = r.payload
          const still = I.editing === reqEditing
          if (!p.ok) {
            I.saving = false
            if (still) {
              I.error = chapterError(p, title)
              I.errorField = p.reason === 'already-present' || p.reason === 'empty-title' ? 'title' : ''
            } else failToast('toast.chapterSaveFailed', { reason: chapterError(p, title) })
            up()
            if (p.reason === 'section-moved' || p.reason === 'section-not-found' || p.reason === 'agents-missing') await reloadAgents()
            return
          }
          await reloadAgents()
          if (P.disposed) return
          const idx = sections().findIndex((s) => s.name === title)
          const saved = idx >= 0 ? sections()[idx] : null
          const uid = saved ? saved.uid : null
          I.saving = false
          if (still) {
            const changed = !!I.draft && (I.draft.title !== snap.title || I.draft.body !== snap.body)
            if (changed && saved) {
              // 在途期间又改过：留在编辑器里，基线换成刚存进去的版本，后来敲的字还在、仍算未保存
              Object.assign(I, {
                editing: uid,
                baseline: { title: saved.name, body: saved.body },
                source: { name: saved.name, body: saved.body },
                conflict: false,
                error: '',
                errorField: '',
              })
            } else {
              closeChapterEditor()
              I.flash = uid
            }
          }
          toast(isNew ? t('toast.chapterAdded', { n: idx + 1, title }) : t('toast.chapterSaved', { n: idx + 1 }))
          up()
          later(() => {
            if (S.ins.flash === uid) {
              S.ins.flash = null
              up()
            }
          }, 1800)
          if (onDone && still && !chapDirty()) onDone()
        })
        return true
      }
      function deleteChapter(uid) {
        const idx = sections().findIndex((s) => s.uid === uid)
        if (idx < 0 || blockedByBusy()) return
        const sec = sections()[idx]
        const k = S.D.agents.historyLimit
        openModal({
          title: t('in.del.title', { n: idx + 1 }),
          tone: 'danger',
          message: t('in.del.msg', { title: sec.name }),
          extra: [h('p', { key: 'b' }, k ? t('in.del.backup', { k }) : t('in.del.backupNoNum'))],
          buttons: [
            { label: t('dlg.cancel'), variant: 'outline', onClick: closeModal, autofocus: true },
            {
              label: t('in.del.ok'),
              variant: 'danger',
              onClick: async () => {
                closeModal()
                if (blockedByBusy()) return
                S.ins.busy = uid
                up()
                const r = await api('/agents/delete-section', { method: 'POST', session: false, body: { index: sec.index, expectedTitle: sec.name } })
                if (P.disposed) return
                if (!r.payload.ok) {
                  S.ins.busy = null
                  failToast('toast.chapterDeleteFailed', { n: idx + 1, reason: reasonText(r.payload, t('err.generic')) })
                  if (r.payload.reason === 'section-moved') reloadAgents()
                  up()
                  return
                }
                if (S.ins.editing === uid) closeChapterEditor()
                toast(t('toast.chapterDeleted', { n: idx + 1, title: sec.name }))
                await reloadAgents()
                S.ins.busy = null
                up()
              },
            },
          ],
        })
      }
      function gotoChapter(i) {
        guard(() => {
          S.view = 'instructions'
          S.ins.tab = 'global'
          S.ins.current = i
          const sec = sections()[i]
          if (sec) S.ins.flash = sec.uid
          up()
          P.after(() => scrollToChapter(i, false))
          later(() => {
            S.ins.flash = null
            up()
          }, 1800)
        })
      }
      function scrollToChapter(i, smooth) {
        const sc = q('[data-scroll="instructions"]')
        const sec = sections()[i]
        const el = sec && q(attrSel('data-chap', sec.uid))
        if (!sc || !el) return
        const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - (S.size === 'narrow' ? 56 : 12)
        sc.scrollTo({ top, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' })
      }
      function setEditor(id) {
        S.ins.editor = id
        try {
          window.localStorage?.setItem(EDITOR_KEY, id)
        } catch {
          // 记不住就每次用自动
        }
      }
      /** 用外部编辑器打开：`target` 为 global（全局指令）/ team / local（项目指令，需要 session）。 */
      async function openInEditor(id, target = 'global') {
        if (id != null) setEditor(id)
        up()
        const editor = id != null ? id : S.ins.editor
        const r = await api('/open-agents', { method: 'POST', session: target !== 'global', body: target === 'global' ? { editor, target } : { editor, target } })
        if (P.disposed) return
        const p = r.payload
        if (!p.ok) {
          failToast('toast.openFailed', { reason: reasonText(p, r.status ? `HTTP ${r.status}` : t('err.generic')) })
          if (p.reason === 'agents-missing') reloadAgents()
          if (p.reason === 'file-missing') reloadProject()
          return
        }
        toast(p.app === 'system-default' || p.editorId === 'system' ? t('toast.openedSystem') : t('toast.opened', { app: p.app || '' }))
      }
      async function createAgentsFile() {
        const r = await api('/agents/create', { method: 'POST', session: false, body: {} })
        if (P.disposed) return
        if (!r.ok && r.payload.reason !== 'already-exists') {
          failToast('toast.createFailed', { reason: reasonText(r.payload, r.status ? `HTTP ${r.status}` : t('err.generic')) })
          return
        }
        if (r.ok) toast(t('toast.created'))
        await reloadAgents()
      }

      /* ---- Tooltip（悬停 450ms / 键盘聚焦 600ms；Esc、滚动、按下时隐藏）：渲染在面板根节点内 ---- */
      let tipTimer = 0
      let tipAnchor = null
      let tipPending = null
      /**
       * position: fixed 的元素若被宿主祖先的 transform 改了包含块，坐标原点就不是视口：量一下偏移再减掉。
       * 元素自己正在播入场动画（菜单 translateY(-2px)）时，量到的位置含这段位移，要扣掉。
       */
      function fixedOrigin(el) {
        el.style.left = '0px'
        el.style.top = '0px'
        const r = el.getBoundingClientRect()
        let tx = 0
        let ty = 0
        try {
          const tr = getComputedStyle(el).transform
          if (tr && tr !== 'none' && typeof DOMMatrixReadOnly === 'function') {
            const m = new DOMMatrixReadOnly(tr)
            tx = m.m41
            ty = m.m42
          }
        } catch {
          // 量不出来就当没有位移
        }
        return { x: r.left - tx, y: r.top - ty }
      }
      function showTipFor(el, delay) {
        if (tipPending === el) return
        clearTimeout(tipTimer)
        tipPending = el
        tipTimer = setTimeout(() => {
          tipPending = null
          const tip = P.tipEl
          if (P.disposed || !tip || !el.isConnected || S.modal) return
          const text = el.getAttribute('data-tip')
          if (!text) return
          tip.textContent = text
          tip.removeAttribute('data-show')
          const o = fixedOrigin(tip)
          const a = el.getBoundingClientRect()
          const w = tip.offsetWidth
          const hh = tip.offsetHeight
          let top = a.bottom + 8
          if (top + hh > window.innerHeight - 8) top = a.top - 8 - hh
          const left = Math.max(8, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - w - 8))
          tip.style.left = Math.round(left - o.x) + 'px'
          tip.style.top = Math.round(top - o.y) + 'px'
          tip.setAttribute('data-show', '')
          tipAnchor = el
          el.setAttribute('aria-describedby', ID('tooltip'))
        }, delay)
      }
      function hideTip() {
        clearTimeout(tipTimer)
        tipPending = null
        if (P.tipEl) P.tipEl.removeAttribute('data-show')
        if (tipAnchor) {
          tipAnchor.removeAttribute('aria-describedby')
          tipAnchor = null
        }
      }
      const tipTarget = (node) => {
        const el = node && node.closest && node.closest('[data-tip]')
        return el && P.root && P.root.contains(el) ? el : null
      }

      /* ---- 全局监听：只在面板可见、焦点在面板内时处理快捷键，不抢宿主的 ---- */
      function onKeyDown(e) {
        // 输入法组字中的按键（含 Esc、回车）一律交给输入法，不当快捷键
        if (isImeEvent(e)) return
        const root = P.root
        if (!root || S.modal || root.getClientRects().length === 0) return
        const ae = document.activeElement
        if (!ae || !root.contains(ae)) return
        if (e.key === 'Escape') hideTip()
        if (S.menu) {
          if (e.key === 'Escape') {
            e.preventDefault()
            closeMenu()
          }
          return
        }
        // 章节编辑器只在「指令 · 全局」里看得见；切到「本项目」后快捷键不能作用于看不见的编辑器
        const chapterEditorShown = S.view === 'instructions' && S.ins.tab === 'global' && S.ins.editing != null
        if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 's') {
          if (S.view === 'memories' && memDirty()) {
            e.preventDefault()
            saveMemory()
          } else if (chapterEditorShown) {
            e.preventDefault()
            // 没改过的章不发请求（saveChapter 自己也会拦）
            if (S.ins.editing === 'new' || chapDirty()) saveChapter()
          }
          return
        }
        if (e.key === 'Escape') {
          if (chapterEditorShown) {
            e.preventDefault()
            cancelChapter()
            return
          }
          if (S.focus) {
            e.preventDefault()
            toggleFocus()
          }
          return
        }
        if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || !S.D) return
        const k = String(e.key).toLowerCase()
        if (S.view === 'memories' && e.key === '/') {
          const inp = q('[data-search]')
          if (inp) {
            e.preventDefault()
            inp.focus()
            inp.select()
          }
          return
        }
        if (S.view === 'pending' && S.D.pending.length) {
          if (k === 'j') {
            e.preventDefault()
            moveDraft(1)
          } else if (k === 'k') {
            e.preventDefault()
            moveDraft(-1)
          } else if (k === 'a' || k === 'd') {
            // 只作用于焦点所在的那张卡；按住不放的自动重复不算（否则会一路收下下去）
            if (e.repeat) {
              e.preventDefault()
              return
            }
            const id = focusedDraftId()
            if (!id) return
            e.preventDefault()
            if (k === 'a') acceptDraft(id)
            else discardDraft(id)
          }
        }
      }
      function onPointerDown(e) {
        hideTip()
        if (!S.menu) return
        const target = e.target
        if (target && target.closest && (target.closest('.wsm-menu') || target.closest(attrSel('data-menu-anchor', S.menu.anchor)))) {
          if (P.root && P.root.contains(target)) return
        }
        closeMenu(false)
      }
      function onPointerOver(e) {
        const el = tipTarget(e.target)
        if (el && el !== tipAnchor) showTipFor(el, 450)
        else if (!el) hideTip()
      }
      function onFocusIn(e) {
        const el = tipTarget(e.target)
        let visible = false
        try {
          visible = e.target.matches(':focus-visible')
        } catch {
          visible = false
        }
        if (el && visible) showTipFor(el, 600)
        else hideTip()
      }
      function onResize() {
        hideTip()
        if (S.menu) up()
      }
      let ro = null
      function measure() {
        if (!P.root) return
        const w = P.root.getBoundingClientRect().width
        if (!w) return
        const size = sizeFor(w)
        if (size !== S.size || Math.abs(w - S.pw) > 0.5) {
          S.size = size
          S.pw = w
          up()
        }
      }

      /** 挂载后（useLayoutEffect）：量宽度、挂监听、首次读取。可重复调用（StrictMode 会先卸再挂）。 */
      P.start = function start() {
        P.disposed = false
        const root = P.root
        if (root) {
          measure()
          if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(measure)
            ro.observe(root)
          }
          root.addEventListener('pointerover', onPointerOver)
          root.addEventListener('focusin', onFocusIn)
          root.addEventListener('focusout', hideTip)
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown, true)
        window.addEventListener('resize', onResize)
        if (!P.started) {
          P.started = true
          loadAll()
        }
      }
      P.dispose = function dispose() {
        P.disposed = true
        for (const id of P.timers) clearTimeout(id)
        P.timers.clear()
        clearTimeout(tipTimer)
        if (ro) ro.disconnect()
        ro = null
        const root = P.root
        if (root) {
          root.removeEventListener('pointerover', onPointerOver)
          root.removeEventListener('focusin', onFocusIn)
          root.removeEventListener('focusout', hideTip)
        }
        document.removeEventListener('keydown', onKeyDown)
        document.removeEventListener('pointerdown', onPointerDown, true)
        window.removeEventListener('resize', onResize)
        // StrictMode 的「卸了再挂」会再次 start：允许重新读取
        P.started = false
      }
      /** 每次提交之后（useLayoutEffect）：先跑 onMount / onUpdate，再处理排队的聚焦。 */
      P.commit = function commit() {
        const a = P.afterQ.splice(0)
        for (const fn of a) {
          try {
            fn()
          } catch (error) {
            console.error('[workspace-memory]', error)
          }
        }
        const f = P.focusQ.splice(0)
        for (const fn of f) {
          try {
            fn()
          } catch (error) {
            console.error('[workspace-memory]', error)
          }
        }
      }

      /* =============================================================== 视图 */

      function Seg(p) {
        const idx = Math.max(0, p.items.findIndex((it) => it.value === p.value))
        const onKey = (e, k) => {
          let n = null
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (k + 1) % p.items.length
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (k - 1 + p.items.length) % p.items.length
          else if (e.key === 'Home') n = 0
          else if (e.key === 'End') n = p.items.length - 1
          if (n == null) return
          e.preventDefault()
          p.onChange(p.items[n].value)
          const group = e.currentTarget.parentElement
          focusLater(() => group.children[n + 1])
        }
        return h(
          'div',
          { className: 'wsm-seg', role: 'radiogroup', 'aria-label': p.label, 'data-size': p.size || null, 'data-stretch': p.stretch ? 'true' : null, style: `--n:${p.items.length};--i:${idx}`, key: p.key },
          h('span', { className: 'wsm-seg-ink', 'aria-hidden': 'true' }),
          p.items.map((it, k) =>
            h(
              'button',
              {
                key: it.value,
                type: 'button',
                role: 'radio',
                'aria-checked': String(k === idx),
                tabIndex: k === idx ? 0 : -1,
                'data-tip': it.tip || null,
                onClick: () => {
                  if (k !== idx) p.onChange(it.value)
                },
                onKeyDown: (e) => onKey(e, k),
              },
              it.label,
            ),
          ),
        )
      }
      function SourceBadge(m, withTip) {
        const k = sourceKind(m)
        if (k === 'none') return h('span', { className: 'wsm-prop-muted', key: 'src' }, t('src.none'))
        const icon = { verified: 'checkCircle', mismatch: 'warn', legacy: 'user', agent: 'sparkle', confidence: 'pulse' }[k]
        const label = k === 'confidence' ? t('src.confidence', { n: Number(m.confidence).toFixed(2) }) : t('src.' + k)
        return h('span', { className: 'wsm-src', 'data-k': k, 'data-tip': withTip === false ? null : t('src.' + k + '.tip'), tabIndex: withTip === false ? null : 0, key: 'src' }, Icon(icon, 14), h('span', null, label))
      }
      function Evidence(m, when) {
        const k = sourceKind(m)
        if (!m.evidence) return h('div', { className: 'wsm-src-line' }, SourceBadge(m), k === 'agent' || k === 'none' || k === 'confidence' ? h('span', null, t('src.noQuote')) : null)
        return h(
          'figure',
          { className: 'wsm-quote', 'data-k': k },
          h('blockquote', { className: 'wsm-quote-text' }, m.evidence),
          h('figcaption', { className: 'wsm-quote-meta' }, SourceBadge(m), when ? h('span', { className: 'wsm-num' }, t('pd.evidence.at', { when: absTime(when) })) : null),
        )
      }
      function Scroll(key, children, extra) {
        return h(
          'div',
          Object.assign(
            {
              key: 'scroll-' + key,
              className: 'wsm-scroll',
              'data-scroll': key,
              onMount: (el) => {
                if (P.scrollMem[key]) el.scrollTop = P.scrollMem[key]
              },
              onScroll: (e) => {
                P.scrollMem[key] = e.currentTarget.scrollTop
                hideTip()
              },
            },
            extra || {},
          ),
          children,
        )
      }

      function MemoryPanel(s) {
        return h(
          'section',
          {
            className: 'wsm-panel',
            'data-size': s.size,
            'data-focus': s.focus ? 'true' : null,
            'aria-label': t('nav.label'),
            tabIndex: -1,
            ref: (el) => {
              if (el) P.root = el
            },
          },
          Header(s),
          h('div', { className: 'wsm-main', key: 'main' }, Body(s)),
          MenuLayer(s),
          ModalLayer(s),
          ToastLayer(s),
          h('div', { className: 'wsm-tooltip', id: ID('tooltip'), role: 'tooltip', key: 'tip', ref: (el) => { if (el) P.tipEl = el } }),
        )
      }

      const NAV = ['overview', 'pending', 'instructions', 'memories']
      function Header(s) {
        const pendingN = s.D ? s.D.pending.length : 0
        const focusTitle = t('nav.' + s.view)
        const navKey = (e, i) => {
          let n = null
          if (e.key === 'ArrowRight') n = (i + 1) % NAV.length
          else if (e.key === 'ArrowLeft') n = (i - 1 + NAV.length) % NAV.length
          else if (e.key === 'Home') n = 0
          else if (e.key === 'End') n = NAV.length - 1
          if (n == null) return
          e.preventDefault()
          setView(NAV[n])
          focusLater(() => q('#' + cssEscape(ID('tab-' + NAV[n]))))
        }
        return h(
          'header',
          { className: 'wsm-head', key: 'head' },
          s.focus
            ? h('div', { className: 'wsm-head-focus', key: 'focushead' }, Icon('focus', 14), h('span', null, t('focus.label')), h('span', { 'aria-hidden': 'true' }, '·'), h('b', null, focusTitle))
            : h(
                'div',
                { className: 'wsm-nav', role: 'tablist', 'aria-label': t('nav.label'), key: 'nav', onMount: placeInk, onUpdate: placeInk },
                NAV.map((v, i) =>
                  h(
                    'button',
                    {
                      key: v,
                      id: ID('tab-' + v),
                      type: 'button',
                      role: 'tab',
                      className: 'wsm-tab',
                      'aria-selected': String(s.view === v),
                      'aria-controls': ID('view'),
                      tabIndex: s.view === v ? 0 : -1,
                      onClick: () => setView(v),
                      onKeyDown: (e) => navKey(e, i),
                    },
                    h('span', null, t('nav.' + v)),
                    v === 'pending' && pendingN ? h('span', { className: 'wsm-tab-count', 'aria-label': t('nav.pendingBadge', { n: pendingN }) }, String(pendingN)) : null,
                    (v === 'memories' && memDirty()) || (v === 'instructions' && chapDirty()) ? h('span', { className: 'wsm-tab-dot', 'aria-label': t('nav.unsaved') }) : null,
                  ),
                ),
                h('span', { className: 'wsm-nav-ink', 'aria-hidden': 'true', key: 'ink' }),
              ),
          h(
            'div',
            { className: 'wsm-head-actions', key: 'actions' },
            IconBtn({ icon: 'refresh', label: t('act.refresh'), onClick: refresh, disabled: s.status !== 'ready' || s.refreshing, attrs: { 'data-spin': s.refreshing ? 'true' : null } }),
            IconBtn({
              icon: s.focus ? 'unfocus' : 'focus',
              label: s.focus ? t('act.focusExit') : t('act.focus'),
              tip: s.focus ? t('act.focusExit') : t('act.focus.tip'),
              onClick: toggleFocus,
              attrs: { 'aria-pressed': String(s.focus) },
            }),
          ),
        )
      }
      function placeInk(nav) {
        const ink = nav.querySelector('.wsm-nav-ink')
        const sel = nav.querySelector('.wsm-tab[aria-selected="true"]')
        if (!ink || !sel) return
        const x = sel.offsetLeft + 9
        const w = sel.offsetWidth - 18
        const key = x + ':' + w
        if (ink.__wsmPos === key) return
        ink.__wsmPos = key
        ink.style.width = w + 'px'
        ink.style.transform = `translateX(${x}px)`
        if (!ink.hasAttribute('data-ready')) requestAnimationFrame(() => ink.setAttribute('data-ready', ''))
      }

      function Body(s) {
        const wrap = (children, extra) =>
          h('div', Object.assign({ className: 'wsm-view wsm-' + s.view, id: ID('view'), role: 'tabpanel', 'aria-labelledby': ID('tab-' + s.view), key: 'view-' + s.view + '-' + s.status }, extra || {}), children)
        if (s.status === 'loading') return wrap(Scroll('loading', LoadingView(s)), { 'aria-busy': 'true' })
        if (s.status === 'error' || !s.D) return wrap(Scroll('error', ErrorView(s)))
        if (s.view === 'overview') return wrap(OverviewView(s))
        if (s.view === 'pending') return wrap(PendingView(s))
        if (s.view === 'instructions') return wrap(InstructionsView(s))
        return wrap(MemoriesView(s))
      }

      /* ---------- 加载 / 出错 ---------- */
      function Skel(w, hgt, extra, key) {
        return h('span', { className: 'wsm-skel', style: `width:${w};height:${hgt}px;${extra || ''}`, key })
      }
      function LoadingView(s) {
        const rows = (n) =>
          Array.from({ length: n }, (_, i) =>
            h(
              'div',
              { key: 'r' + i, className: 'wsm-skel-row' },
              Skel('36px', 36, 'border-radius:12px;flex:none'),
              h('div', { style: 'flex:1;display:flex;flex-direction:column;gap:7px' }, Skel(60 + ((i * 17) % 30) + '%', 12), Skel(40 + ((i * 23) % 40) + '%', 10)),
            ),
          )
        const narrow = s.size === 'narrow'
        let body
        if (s.view === 'overview') {
          body = [
            h(
              'div',
              { key: 'm', className: 'wsm-map', style: 'margin-top:24px' },
              narrow ? null : h('span', { key: 'c' }),
              narrow ? null : Skel('60%', 12, '', 'h1'),
              narrow ? null : Skel('60%', 12, '', 'h2'),
              narrow ? null : Skel('100%', 300, 'grid-row:span 2;border-radius:11px', 'rh'),
              Skel('100%', 156, 'border-radius:16px', 'a'),
              Skel('100%', 156, 'border-radius:16px', 'b'),
              Skel('100%', 156, 'border-radius:16px', 'c2'),
              Skel('100%', 156, 'border-radius:16px', 'd'),
            ),
            h('div', { key: 'rr', style: 'margin-top:28px' }, rows(3)),
          ]
        } else if (s.view === 'pending') body = [1, 2].map((i) => h('div', { key: 'c' + i, style: 'margin-top:16px' }, Skel('100%', 230, 'border-radius:20px')))
        else if (s.view === 'instructions') {
          body = [
            h(
              'div',
              { key: 'b', style: 'margin-top:20px;display:flex;flex-direction:column;gap:10px' },
              Skel('40%', 14, '', 1),
              Skel('92%', 10, '', 2),
              Skel('86%', 10, '', 3),
              Skel('70%', 10, '', 4),
              h('span', { style: 'height:16px', key: 5 }),
              Skel('34%', 14, '', 6),
              Skel('90%', 10, '', 7),
              Skel('62%', 10, '', 8),
            ),
          ]
        } else {
          body = [
            h('div', { key: 's', style: 'margin-top:4px;display:flex;flex-direction:column;gap:10px' }, Skel('100%', 32, 'border-radius:12px', 1), Skel('100%', 32, 'border-radius:11px', 2)),
            h('div', { key: 'r', style: 'margin-top:12px' }, rows(6)),
          ]
        }
        return h('div', { className: 'wsm-page' }, h('span', { className: 'wsm-sr', role: 'status' }, t('st.loading')), Skel('42%', 18, 'margin-top:4px'), Skel('28%', 12, 'margin-top:8px'), body)
      }
      function ErrorView(s) {
        const noSession = !sessionId
        return h(
          'div',
          { className: 'wsm-page' },
          Empty({
            ill: 'broken',
            error: true,
            title: t('st.error.title'),
            body: noSession ? null : t('st.error.body'),
            extra: s.error ? h('code', { className: 'wsm-errcode' }, s.error) : null,
            action: noSession ? null : Btn({ label: t('st.error.retry'), variant: 'outline', icon: 'refresh', onClick: () => loadAll() }),
          }),
        )
      }

      /* ---------- 总览 ---------- */
      function WorkspaceChip(D, extraStyle) {
        const ws = D.workspace
        return h(
          'span',
          { className: 'wsm-ws', 'data-tip': ws ? t('ov.workspace.tip', { path: ws.path }) : D.root ? t('ov.workspace.tip', { path: D.root }) : null, tabIndex: 0, style: extraStyle || null },
          Icon('folder', 14),
          h('span', null, ws ? ws.name : t('ov.workspace.unknown')),
        )
      }
      function OverviewView(s) {
        const D = s.D
        return Scroll(
          'overview',
          h(
            'div',
            { className: 'wsm-page' },
            h('div', { className: 'wsm-pagehead' }, h('div', { className: 'wsm-pagehead-main' }, h('h1', { className: 'wsm-h1' }, t('ov.title')), WorkspaceChip(D))),
            D.pending.length
              ? h(
                  'div',
                  { className: 'wsm-banner', role: 'status' },
                  h('span', { className: 'wsm-banner-ic' }, Icon('inbox')),
                  h('div', { className: 'wsm-banner-main' }, h('div', { className: 'wsm-banner-title' }, t('ov.banner', { n: D.pending.length })), h('div', { className: 'wsm-banner-sub' }, t('ov.banner.sub'))),
                  Btn({ label: t('ov.banner.go'), variant: 'primary', size: 'sm', onClick: () => setView('pending') }),
                )
              : null,
            h(
              'section',
              { className: 'wsm-section', 'aria-labelledby': ID('ov-map') },
              h('div', { className: 'wsm-section-head' }, h('h2', { className: 'wsm-h2', id: ID('ov-map') }, t('ov.map'))),
              h('p', { className: 'wsm-section-sub' }, t('ov.map.sub')),
              h('div', { className: 'wsm-section-body' }, MemoryMap(s)),
            ),
            h('div', { className: 'wsm-ov-grid' }, h('div', null, CostSection(s), RecentSection(s)), h('div', null, StaleSection(s), FlowSection(s))),
          ),
        )
      }
      function MemoryMap(s) {
        const D = s.D
        const L = D.limits
        const lib = (scope) => D.memories.filter((m) => m.scope === scope)
        const latest = (arr) => arr.reduce((a, m) => (m.modified && (!a || (timeOf(m.modified) || 0) > (timeOf(a) || 0)) ? m.modified : a), null)
        const foot = (iso) => h('span', { className: 'wsm-cell-foot', key: 'f' }, iso ? t('time.updated', { when: relTime(iso) }) : t('ov.cell.noTime'))
        const axes = (col, row) =>
          h('span', { className: 'wsm-cell-axes' }, Tag(t('axis.' + col), 'neutral', Icon(col === 'always' ? 'repeat' : 'search', 12), null, 'c'), Tag(t('axis.' + row), 'neutral', Icon(row === 'all' ? 'globe' : 'folder', 12), null, 'r'))
        const cell = (id, load, col, row, onClick, content) =>
          h(
            'button',
            { key: id, type: 'button', className: 'wsm-cell', 'data-load': load, onClick, 'aria-label': t('ov.cell.open', { name: t('layer.' + id) }) },
            h('span', { className: 'wsm-cell-top' }, h('span', { className: 'wsm-cell-glyph' }, Glyph(id, 16)), h('span', { className: 'wsm-cell-name' }, t('layer.' + id)), Icon('chevR', 14, 'wsm-cell-go')),
            axes(col, row),
            h('span', { className: 'wsm-cell-desc' }, t('layer.' + id + '.desc')),
            content,
          )
        const memContent = (scope) => {
          const items = lib(scope)
          if (!items.length) return [h('span', { key: 'e', className: 'wsm-cell-empty' }, t('ov.cell.emptyMem')), foot(null)]
          const max = L.maxMemoryCount
          return [
            h(
              'span',
              { key: 'm', className: 'wsm-cell-metric' },
              h('span', { className: 'wsm-cell-big' }, String(items.length)),
              max ? h('span', { className: 'wsm-cell-unit', 'data-tip': t('ov.cell.count.tip', { max }) }, t('ov.cell.count', { max })) : h('span', { className: 'wsm-cell-unit' }, t('unit.items')),
            ),
            max ? h('span', { key: 'b' }, Meter(items.length, max, true)) : null,
            foot(latest(items)),
          ]
        }
        const globalContent = () => {
          const ag = D.agents
          if (ag.status === 'missing') return [h('span', { key: 'e', className: 'wsm-cell-empty' }, t('ov.cell.missing')), foot(null)]
          if (ag.status !== 'ok') return [h('span', { key: 'e', className: 'wsm-cell-empty' }, t('ov.cell.unknown')), foot(null)]
          const ab = ag.bytes
          const max = ag.limit
          const warn = !!max && ab / max >= 0.8
          return [
            h(
              'span',
              { key: 'm', className: 'wsm-cell-metric' },
              h('span', { className: 'wsm-cell-big' }, String(ag.sections.length)),
              h('span', { className: 'wsm-cell-unit' }, t('unit.chapters')),
              h(
                'span',
                { className: 'wsm-cell-right', 'data-warn': warn ? 'true' : null, 'data-tip': max ? t('ov.cell.budget.tip', { used: nf(ab), max: nf(max) }) : t('ov.cell.bytes.tip', { used: nf(ab) }) },
                max ? t('ov.cell.budget', { used: kb(ab), max: kb(max) }) : t('ov.cell.bytes', { used: kb(ab) }),
              ),
            ),
            max ? h('span', { key: 'b' }, Meter(ab, max)) : null,
            foot(ag.mtime),
          ]
        }
        const projContent = () => {
          const Pj = D.project
          if (!Pj || Pj.status !== 'ok') return [h('span', { key: 'e', className: 'wsm-cell-empty' }, t('ov.cell.unknown')), foot(null)]
          const row = (k, f) =>
            h(
              'span',
              { key: k, className: 'wsm-cell-subrow' },
              Icon(k === 'team' ? 'branch' : 'user', 12),
              h('b', null, t('layer.' + k + '.short')),
              h('i', null, t(k === 'team' ? 'in.proj.git' : 'in.proj.nogit')),
              h('span', { className: 'wsm-num' }, f.exists ? t('unit.kb', { n: kb(f.bytes) }) : t('ov.cell.none')),
            )
          const times = [Pj.team, Pj.local]
            .filter((f) => f.exists && f.mtime)
            .map((f) => f.mtime)
            .sort()
            .reverse()
          return [h('span', { key: 's', className: 'wsm-cell-sub' }, row('team', Pj.team), row('local', Pj.local)), foot(times[0] || null)]
        }
        const narrow = s.size === 'narrow'
        return h(
          'div',
          { className: 'wsm-map', role: narrow ? null : 'group', 'aria-label': t('ov.map') },
          h('span', { className: 'wsm-map-corner', key: 'corner' }),
          h('div', { className: 'wsm-map-colhead', key: 'c1' }, Icon('repeat', 14), h('span', null, t('axis.always')), h('small', null, t('axis.always.sub'))),
          h('div', { className: 'wsm-map-colhead', key: 'c2' }, Icon('search', 14), h('span', null, t('axis.ondemand')), h('small', null, t('axis.ondemand.sub'))),
          h('div', { className: 'wsm-map-rowhead', key: 'r1' }, Icon('globe', 12), h('span', null, t('axis.all'))),
          cell('globalInstr', 'always', 'always', 'all', () => gotoInstructions('global'), globalContent()),
          cell('globalMem', 'ondemand', 'ondemand', 'all', () => gotoMemories('global'), memContent('global')),
          h('div', { className: 'wsm-map-rowhead', key: 'r2' }, Icon('folder', 12), h('span', null, t('axis.project'))),
          cell('projInstr', 'always', 'always', 'project', () => gotoInstructions('project'), projContent()),
          cell('projMem', 'ondemand', 'ondemand', 'project', () => gotoMemories('project'), memContent('project')),
        )
      }
      function CostSection(s) {
        const D = s.D
        const names = { global: t('ov.cost.global'), team: t('ov.cost.team'), local: t('ov.cost.local') }
        const parts = costParts(D).map((x) => Object.assign({}, x, { name: x.k === 'index' ? t('ov.cost.index', { n: x.lines }) : names[x.k], tip: x.k === 'index' ? t('ov.cost.index.tip') : null }))
        const total = parts.reduce((a, x) => a + x.bytes, 0)
        return h(
          'section',
          { className: 'wsm-section', 'aria-labelledby': ID('ov-cost') },
          h('div', { className: 'wsm-section-head' }, h('h2', { className: 'wsm-h2', id: ID('ov-cost') }, t('ov.cost'))),
          h('p', { className: 'wsm-section-sub' }, t('ov.cost.sub')),
          h(
            'div',
            { className: 'wsm-section-body' },
            total
              ? h(
                  'div',
                  { className: 'wsm-cost' },
                  h('div', { className: 'wsm-cost-total' }, h('b', null, t('ov.cost.total', { n: nf(tokensOf(total)) })), h('span', null, t('ov.cost.unit')), h('em', { 'data-tip': t('ov.cost.estimate') }, t('ov.cost.bytes', { n: nf(total) }))),
                  h(
                    'div',
                    { className: 'wsm-stack', role: 'img', 'aria-label': parts.map((x) => x.name + ' ' + t('unit.kb', { n: kb(x.bytes) })).join(t('unit.listSep')) },
                    parts.map((x) =>
                      h('span', {
                        key: x.k,
                        style: `flex-grow:${x.bytes};--p:${x.p}`,
                        'data-hatch': x.hatch ? 'true' : null,
                        'data-tip': t('ov.cost.seg.tip', { name: x.name, bytes: nf(x.bytes), tokens: nf(tokensOf(x.bytes)) }),
                      }),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'wsm-legend' },
                    parts.map((x) => [
                      h('span', { key: x.k + 's', className: 'wsm-legend-sw', style: `--p:${x.p}`, 'data-hatch': x.hatch ? 'true' : null }),
                      h('span', { key: x.k + 'n', className: 'wsm-legend-name', 'data-tip': x.tip || null }, x.name),
                      h('span', { key: x.k + 'v', className: 'wsm-legend-v' }, t('unit.kb', { n: kb(x.bytes) })),
                      h('span', { key: x.k + 't', className: 'wsm-legend-t' }, t('unit.tokens', { n: nf(tokensOf(x.bytes)) })),
                    ]),
                  ),
                  h('div', { className: 'wsm-cost-tip' }, Icon('info', 14), h('span', null, t('ov.cost.tip'))),
                )
              : h('p', { className: 'wsm-empty-body' }, t('ov.cost.empty')),
          ),
        )
      }
      function MemRow(m, opts) {
        const o = opts || {}
        const key = memKey(m)
        const draft = S.mm.sel === key && S.mm.draft ? S.mm.draft : null
        const title = draft ? draft.title || m.title : m.title
        const desc = draft ? draft.description : m.description
        const k = sourceKind(m)
        const ty = normType(m.type)
        return h(
          'li',
          { key, role: 'presentation' },
          h(
            'button',
            {
              type: 'button',
              className: 'wsm-row',
              role: o.option ? 'option' : null,
              'aria-selected': o.option ? String(!!o.selected) : null,
              tabIndex: o.tabIndex,
              'data-key': key,
              onClick: o.onClick,
              onKeyDown: o.onKeyDown,
              onMount: o.selected ? (el) => el.scrollIntoView({ block: 'nearest' }) : null,
            },
            h('span', { className: 'wsm-row-ic', 'data-tip': t('type.' + ty), 'aria-hidden': 'true' }, Icon(TYPE_ICON[ty], o.compact ? 14 : 16)),
            h(
              'span',
              { className: 'wsm-row-main' },
              h('span', { className: 'wsm-row-title' }, h('span', null, title), o.dirty ? h('span', { className: 'wsm-row-unsaved', 'aria-label': t('mm.unsaved') }) : null),
              o.sub ? h('span', { className: 'wsm-row-desc' }, o.sub) : desc ? h('span', { className: 'wsm-row-desc' }, desc) : null,
            ),
            o.end !== false
              ? h(
                  'span',
                  { className: 'wsm-row-end' },
                  h(
                    'span',
                    { className: 'wsm-row-meta' },
                    h('span', { className: 'wsm-row-time' }, relTime(m.modified)),
                    h('span', { className: 'wsm-dot', 'data-k': k, 'data-tip': k === 'none' ? null : k === 'confidence' ? t('src.confidence', { n: Number(m.confidence).toFixed(2) }) : t('src.' + k) }),
                  ),
                  o.showScope === false ? null : h('span', { className: 'wsm-scopetag', 'data-scope': m.scope, 'data-tip': libName(m.scope) }, m.scope === 'global' ? t('axis.all') : t('axis.project')),
                )
              : o.endNode || null,
          ),
        )
      }
      function RecentSection(s) {
        const items = s.D.memories.slice().sort(byModified).slice(0, 5)
        return h(
          'section',
          { className: 'wsm-section', 'aria-labelledby': ID('ov-recent') },
          h(
            'div',
            { className: 'wsm-section-head' },
            h('h2', { className: 'wsm-h2', id: ID('ov-recent') }, t('ov.recent')),
            items.length ? h('div', { className: 'wsm-section-aside' }, h('button', { type: 'button', className: 'wsm-linkbtn', onClick: () => gotoMemories('all') }, t('ov.recent.all'), Icon('chevR', 12))) : null,
          ),
          h(
            'div',
            { className: 'wsm-section-body' },
            items.length
              ? h(
                  'ul',
                  { className: 'wsm-rows', 'data-compact': 'true' },
                  items.map((m) =>
                    MemRow(m, {
                      compact: true,
                      onClick: () => openMemory(memKey(m)),
                      end: false,
                      sub: h('span', { className: 'wsm-sub-glyph' }, Glyph(cellOfScope(m.scope), 11), libName(m.scope), ' · ', relTime(m.modified)),
                    }),
                  ),
                )
              : h('p', { className: 'wsm-empty-body' }, t('ov.recent.empty')),
          ),
        )
      }
      function StaleSection(s) {
        if (!s.D.memories.length) return null
        const now = Date.now()
        const items = s.D.memories
          .map((m) => ({ m, st: staleInfo(m, now) }))
          .filter((x) => x.st)
          .sort((a, b) => b.st.days - a.st.days)
        return h(
          'section',
          { className: 'wsm-section', 'aria-labelledby': ID('ov-stale') },
          h('div', { className: 'wsm-section-head' }, h('h2', { className: 'wsm-h2', id: ID('ov-stale') }, t('ov.stale')), items.length ? h('span', { className: 'wsm-count' }, String(items.length)) : null),
          h('p', { className: 'wsm-section-sub' }, t('ov.stale.sub')),
          h(
            'div',
            { className: 'wsm-section-body' },
            items.length
              ? h(
                  'ul',
                  { className: 'wsm-rows', 'data-compact': 'true' },
                  items.map(({ m, st }) =>
                    MemRow(m, {
                      compact: true,
                      onClick: () => openMemory(memKey(m)),
                      end: false,
                      sub: h('span', { className: 'wsm-sub-glyph' }, Icon('clock', 11), st.kind === 'unused' ? t('ov.stale.unused', { n: st.days }) : t('ov.stale.never', { n: st.days }), ' · ', libName(m.scope)),
                      endNode: h('span', { className: 'wsm-btn', 'data-variant': 'outline', 'data-size': 'sm', 'aria-hidden': 'true' }, t('ov.stale.look')),
                    }),
                  ),
                )
              : h('p', { className: 'wsm-empty-body' }, t('ov.stale.empty')),
          ),
        )
      }
      function FlowSection(s) {
        const open = s.ov.flowOpen
        const arrow = '<path d="M1 5h15M12 1.5 16 5l-4 3.5" fill="none" stroke="currentColor" stroke-width="1.1"/>'
        const dest = (cell, label, key) => h('span', { className: 'wsm-flow-dest', key }, cell === 'skill' ? Icon('wand', 12) : cell === 'none' ? Icon('nope', 12) : Glyph(cell, 12), label || t('layer.' + cell))
        const node = (last) => h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true', html: last ? '<circle cx="6" cy="6" r="4" fill="currentColor"/>' : '<circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.2"/>' })
        const yes = () => h('span', { className: 'wsm-flow-yes' }, t('ov.flow.yes'), h('svg', { width: 18, height: 10, viewBox: '0 0 18 10', 'aria-hidden': 'true', html: arrow }))
        const row = (k, qText, d, last) => h('div', { key: k, className: 'wsm-flow-row' }, h('div', { className: 'wsm-flow-rail' }, node(last)), h('div', { className: 'wsm-flow-body' }, h('span', { className: 'wsm-flow-q' }, qText), yes(), d))
        return h(
          'section',
          { className: 'wsm-section' },
          h(
            'button',
            {
              type: 'button',
              className: 'wsm-disclose',
              'aria-expanded': String(open),
              'aria-controls': ID('flow'),
              onClick: () => {
                S.ov.flowOpen = !open
                up()
              },
            },
            Icon('layers', 16),
            h('span', { className: 'wsm-h2' }, t('ov.flow')),
            Icon('chevD', 14),
          ),
          open
            ? h(
                'div',
                { className: 'wsm-flow', id: ID('flow') },
                row('1', t('ov.flow.q1'), dest('skill')),
                row('2', t('ov.flow.q2'), dest('team', t('layer.team'))),
                row('3', t('ov.flow.q3'), dest('local', t('layer.local'))),
                row('4', t('ov.flow.q4'), [dest('globalInstr', null, 'd'), h('span', { key: 'n', className: 'wsm-flow-note' }, t('ov.flow.q4.note'))]),
                h(
                  'div',
                  { key: '5', className: 'wsm-flow-row' },
                  h('div', { className: 'wsm-flow-rail' }, node(true)),
                  h(
                    'div',
                    { className: 'wsm-flow-body' },
                    h('span', { className: 'wsm-flow-q' }, t('ov.flow.rest')),
                    h('span', { className: 'wsm-flow-yes' }, h('svg', { width: 18, height: 10, viewBox: '0 0 18 10', 'aria-hidden': 'true', html: arrow })),
                    dest('projMem'),
                    h('span', { className: 'wsm-flow-note' }, t('ov.flow.or')),
                    dest('globalMem'),
                    h('span', { className: 'wsm-flow-note' }, t('ov.flow.restNote')),
                  ),
                ),
                h('div', { className: 'wsm-flow-aside', key: 'once' }, Icon('info', 14), h('span', null, t('ov.flow.once')), h('svg', { width: 18, height: 10, viewBox: '0 0 18 10', 'aria-hidden': 'true', html: arrow }), dest('none')),
              )
            : null,
        )
      }

      /* ---------- 待确认 ---------- */
      function PendingView(s) {
        const list = s.D.pending
        return [
          Scroll(
            'pending',
            h(
              'div',
              { className: 'wsm-page', key: 'page' },
              h(
                'div',
                { className: 'wsm-pagehead' },
                h(
                  'div',
                  { className: 'wsm-pagehead-main' },
                  h('h1', { className: 'wsm-h1' }, t('pd.title'), list.length ? h('span', { className: 'wsm-count', style: 'margin-left:8px' }, t('pd.count', { n: list.length })) : null),
                  h('p', { className: 'wsm-pagesub' }, t('pd.sub')),
                ),
              ),
              list.length
                ? h('div', { className: 'wsm-drafts', role: 'feed', 'aria-label': t('pd.region') }, list.map((d, i) => DraftCard(s, d, i, list.length)))
                : Empty({ ill: 'inbox', title: t('pd.empty.title'), body: t('pd.empty.body'), extra: h('p', { className: 'wsm-empty-body' }, t('pd.empty.extract')) }),
            ),
          ),
          list.length
            ? h(
                'div',
                { className: 'wsm-keyhints', key: 'keys', 'aria-hidden': 'true' },
                h('span', null, Kbd('J'), Kbd('K'), t('pd.keys.move')),
                h('span', null, Kbd('A'), t('pd.keys.accept')),
                h('span', null, Kbd('D'), t('pd.keys.discard')),
              )
            : null,
        ]
      }
      function DiffBlock(rows, title) {
        return h(
          'div',
          { className: 'wsm-diff' },
          title || null,
          rows.map((r, i) => {
            if (r.t === 'gap') return h('div', { key: i, className: 'wsm-diff-row', 'data-t': 'gap' }, h('i', null, '⋯'), h('span', null, t('pd.diff.same', { n: r.n })))
            const blank = r.segs.length === 1 && !r.segs[0].s
            return h(
              'div',
              { key: i, className: 'wsm-diff-row', 'data-t': r.t, 'data-inline': r.inline ? 'true' : null, 'data-blank': blank && r.t === '=' ? 'true' : null },
              h('i', { 'aria-hidden': 'true' }, r.t === '=' ? '' : r.t === '-' ? '−' : '+'),
              h(
                'span',
                null,
                r.t === '-' ? h('span', { className: 'wsm-sr' }, t('pd.diff.del')) : r.t === '+' ? h('span', { className: 'wsm-sr' }, t('pd.diff.add')) : null,
                r.segs.map((sg, k) => (sg.ch ? h(r.t === '-' ? 'del' : 'ins', { key: k }, sg.s) : h('span', { key: k }, sg.s))),
                blank && r.t !== '=' ? ' ' : null,
              ),
            )
          }),
        )
      }
      function DraftCard(s, d, i, total) {
        const P2 = s.pd
        const dest = destOf(d, { sections: s.D.agents.sections, memories: s.D.memories })
        const why = whyOf(d)
        const busy = P2.busy[d.id]
        const err = P2.errors[d.id]
        const always = d.load === 'always'
        let what
        if (dest.kind === 'append') what = t('pd.dest.append', { n: dest.next })
        else if (dest.kind === 'overwrite') what = dest.chapter ? t('pd.dest.overwrite', { n: dest.chapter, title: dest.chapterTitle }) : t('pd.dest.overwriteNoNum', { title: dest.chapterTitle })
        else if (dest.kind === 'replace') what = dest.old ? t('pd.dest.replace', { title: dest.old.title }) : t('pd.dest.replaceGone')
        else if (dest.kind === 'blocked') what = t('pd.dest.blocked')
        else what = t('pd.dest.new')
        let compare = null
        if (dest.kind === 'overwrite' && dest.section) compare = { kind: 'chapter', rows: diffRows(dest.section.body, d.body) }
        if (dest.kind === 'replace' && dest.old) compare = { kind: 'memory', rows: diffRows(dest.old.body, d.body), titleRows: dest.old.title !== d.title ? diffRows(dest.old.title, d.title) : null }
        const mode = P2.mode[d.id] || (compare ? 'diff' : 'after')
        const content =
          compare && mode === 'diff'
            ? [
                compare.titleRows ? h('div', { key: 'tt', style: 'margin-bottom:8px' }, DiffBlock(compare.titleRows, h('div', { className: 'wsm-diff-title' }, t('pd.compare.title')))) : null,
                h('div', { key: 'bd' }, DiffBlock(compare.rows, compare.titleRows ? h('div', { className: 'wsm-diff-title' }, t('pd.compare.body')) : null)),
              ]
            : h('div', { className: 'wsm-content-box', key: 'md' }, Markdown(d.body))
        const keep = s.D.agents.historyLimit
        const replaceNote =
          dest.kind === 'replace' && dest.old
            ? h('p', { className: 'wsm-block-note' }, Icon('history', 14), h('span', null, t('pd.note.replace'), ' ', h('button', { type: 'button', className: 'wsm-linkbtn', onClick: () => openMemory(memKey(dest.old)) }, t('pd.viewOld'))))
            : dest.kind === 'overwrite' && dest.section
              ? h('p', { className: 'wsm-block-note' }, Icon('history', 14), h('span', null, keep ? t('pd.note.overwrite', { n: keep }) : t('pd.note.overwriteNoNum')))
              : null
        const leaving = !!P2.leaving[d.id]
        const collapse = (el) => {
          if (el.__wsmLeaving) return
          el.__wsmLeaving = true
          const hgt = el.offsetHeight
          el.style.overflow = 'hidden'
          const done = () => finishLeave(d.id)
          if (typeof el.animate !== 'function') return done()
          const anim = el.animate([{ height: hgt + 'px', paddingBottom: '14px', opacity: 1 }, { height: '0px', paddingBottom: '0px', opacity: 0 }], {
            duration: reducedMotion() ? 1 : 240,
            easing: 'cubic-bezier(.2,0,0,1)',
            fill: 'forwards',
          })
          anim.onfinish = done
        }
        const tags = Array.isArray(d.tags) ? d.tags : []
        const paths = Array.isArray(d.paths) ? d.paths : []
        return h(
          'div',
          {
            key: d.id,
            className: 'wsm-draft-slot',
            'data-leaving': leaving ? 'true' : null,
            onMount: (el) => {
              if (leaving) collapse(el)
            },
            onUpdate: (el) => {
              if (leaving) collapse(el)
            },
          },
          h(
            'article',
            {
              className: 'wsm-draft',
              tabIndex: 0,
              'data-draft': d.id,
              'aria-labelledby': ID('dt-' + d.id),
              'aria-posinset': String(i + 1),
              'aria-setsize': String(total),
              'aria-busy': busy ? 'true' : null,
              'data-current': P2.current === i ? 'true' : null,
              onFocusin: () => {
                if (P2.current !== i) {
                  P2.current = i
                  up()
                }
              },
              onFocusout: (e) => {
                if (!e.currentTarget.contains(e.relatedTarget) && P2.current === i) {
                  P2.current = -1
                  up()
                }
              },
            },
            h(
              'header',
              { className: 'wsm-dest' },
              h('span', { className: 'wsm-dest-glyph', 'aria-hidden': 'true' }, Glyph(dest.cell, 16)),
              h(
                'div',
                { className: 'wsm-dest-main' },
                h(
                  'div',
                  { className: 'wsm-dest-line' },
                  h('span', { className: 'wsm-sr' }, t('pd.dest.label')),
                  h('span', { className: 'wsm-dest-arrow', 'aria-hidden': 'true' }, '→'),
                  h('span', { className: 'wsm-dest-name' }, t('layer.' + dest.cell)),
                  h('span', { className: 'wsm-dest-arrow wsm-dest-sep', 'aria-hidden': 'true' }, '·'),
                  h(
                    'span',
                    { className: 'wsm-dest-what' },
                    what,
                    dest.kind === 'overwrite' && dest.chapter ? h('span', { className: 'wsm-dest-pos', tabIndex: 0, 'data-tip': t('pd.dest.position.tip', { title: dest.chapterTitle }) }, t('pd.dest.position')) : null,
                  ),
                ),
                why.map(([k, tone]) => h('p', { key: k, className: 'wsm-why', 'data-tone': tone || null }, Icon(tone === 'warn' ? 'warn' : 'question', 14), h('span', null, t('pd.why.' + k)))),
              ),
            ),
            h(
              'div',
              { className: 'wsm-draft-body' },
              h('h3', { className: 'wsm-draft-title', id: ID('dt-' + d.id) }, d.title),
              !always && d.description ? h('p', { className: 'wsm-draft-desc' }, h('small', { 'data-tip': t('pd.summary.tip') }, t('pd.summary')), d.description) : null,
              always ? h('p', { className: 'wsm-draft-note', 'data-tip': t('pd.onlyTitleBody.tip') }, Icon('info', 12), t('pd.onlyTitleBody')) : null,
              h(
                'div',
                { className: 'wsm-block' },
                h(
                  'div',
                  { className: 'wsm-block-head' },
                  h('span', { className: 'wsm-block-label' }, t('pd.content')),
                  compare
                    ? Seg({
                        size: 'sm',
                        label: t('pd.view.label'),
                        value: mode,
                        items: [
                          { value: 'diff', label: t('pd.view.diff') },
                          { value: 'after', label: t('pd.view.after') },
                        ],
                        onChange: (v) => {
                          P2.mode[d.id] = v
                          up()
                        },
                      })
                    : null,
                ),
                content,
                replaceNote,
                dest.kind === 'overwrite' && dest.alsoRemove
                  ? h(
                      'div',
                      { className: 'wsm-also' },
                      Icon('trash', 14),
                      h(
                        'p',
                        null,
                        t('pd.alsoRemove'),
                        Glyph(cellOfScope(dest.alsoRemove.scope), 12),
                        h('b', null, t('pd.alsoRemove.target', { lib: libName(dest.alsoRemove.scope), title: dest.alsoRemove.title })),
                        t('pd.alsoRemove.note'),
                        h('button', { type: 'button', className: 'wsm-linkbtn', onClick: () => openMemory(memKey(dest.alsoRemove)) }, t('pd.viewOld')),
                      ),
                    )
                  : null,
              ),
              !always
                ? h(
                    'div',
                    { className: 'wsm-meta-row' },
                    TypeTag(d.type),
                    tags.map((tg) => h('span', { key: 'tg-' + tg, className: 'wsm-tag' }, h('span', null, '#' + tg))),
                    paths.map((p) => h('span', { key: 'p-' + p, className: 'wsm-tag', 'data-tip': t('mm.paths.tip') }, Icon('file', 11), h('span', null, p))),
                    d.slug ? h('span', { key: 'slug', className: 'wsm-tag', 'data-tip': t('pd.slug.tip') }, Icon('doc', 11), h('span', null, d.slug + '.md')) : null,
                  )
                : null,
              h('div', { className: 'wsm-block' }, h('div', { className: 'wsm-block-head' }, h('span', { className: 'wsm-block-label' }, t('pd.evidence'))), Evidence(d, d.created)),
              err ? h('div', { className: 'wsm-draft-err', role: 'alert' }, Icon('warn', 14), h('span', null, err)) : null,
            ),
            h(
              'footer',
              { className: 'wsm-draft-foot' },
              h('span', { className: 'wsm-draft-when', 'data-tip': absTime(d.created) || null }, d.created ? t('pd.queued', { when: relTime(d.created) }) : ''),
              Btn({ label: t('pd.discard'), variant: 'outline', onClick: () => discardDraft(d.id), disabled: !!busy || leaving }),
              Btn({
                label: busy === 'accept' ? t('pd.accepting') : compare || dest.alsoRemove ? t('pd.acceptReplace') : t('pd.accept'),
                variant: 'primary',
                busy: busy === 'accept',
                disabled: !!busy || leaving,
                onClick: () => acceptDraft(d.id),
                attrs: { 'aria-keyshortcuts': 'A' },
              }),
            ),
          ),
        )
      }

      /* ---------- 指令 ---------- */
      function InstructionsView(s) {
        const I = s.ins
        const D = s.D
        const tab = I.tab
        const tools = tab === 'global' && D.agents.status === 'ok' ? OpenEditorButton(s) : null
        return Scroll(
          'instructions',
          h(
            'div',
            { className: 'wsm-page' },
            h(
              'div',
              { className: 'wsm-pagehead' },
              Seg({
                label: t('in.seg.label'),
                value: tab,
                items: [
                  { value: 'global', label: t('in.seg.global') },
                  { value: 'project', label: t('in.seg.project') },
                ],
                onChange: (v) => {
                  if (v === S.ins.tab) return
                  // 切到「本项目」会把全局的章节编辑器藏起来：有修改先过守卫；没修改直接收起，免得留一个看不见的编辑器
                  const go = () => {
                    if (v === 'project' && S.ins.editing != null && !chapDirty()) closeChapterEditor()
                    S.ins.tab = v
                    up()
                  }
                  if (v === 'project' && chapDirty()) guard(go, { skipMem: true })
                  else go()
                },
              }),
              tools,
            ),
            tab === 'global' ? GlobalInstructions(s) : ProjectInstructions(s),
          ),
          {
            onScroll: (e) => {
              P.scrollMem.instructions = e.currentTarget.scrollTop
              hideTip()
              if (S.ins.tab === 'global') trackChapter(e.currentTarget)
            },
          },
        )
      }
      let tocRaf = 0
      function trackChapter(sc) {
        if (tocRaf) return
        tocRaf = requestAnimationFrame(() => {
          tocRaf = 0
          if (P.disposed) return
          const secs = Array.from(sc.querySelectorAll('.wsm-chap[data-chap]'))
          if (!secs.length) return
          const top = sc.getBoundingClientRect().top + (S.size === 'narrow' ? 72 : 32)
          let cur = 0
          secs.forEach((el, i) => {
            if (el.getBoundingClientRect().top <= top) cur = i
          })
          if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) cur = secs.length - 1
          const idx = Math.min(cur, sections().length - 1)
          if (idx !== S.ins.current && idx >= 0) {
            S.ins.current = idx
            up()
          }
        })
      }
      function editorLabel(e) {
        return e.id === 'system' ? t('in.editor.system') : e.name
      }
      function OpenEditorButton(s) {
        const eds = Array.isArray(s.D.editors) ? s.D.editors : []
        const cur = s.ins.editor
        const curEd = cur && eds.find((e) => e.id === cur)
        const label = curEd ? (curEd.id === 'system' ? t('in.open') : t('in.open.with', { app: curEd.name })) : t('in.open')
        const build = () =>
          [
            {
              key: 'auto',
              label: t('in.editor.auto'),
              desc: t('in.editor.auto.desc'),
              checked: !cur,
              onSelect: () => {
                setEditor('')
                up()
              },
            },
            { sep: true, key: 's1' },
          ].concat(
            eds.map((e) => ({
              key: 'e-' + e.id,
              label: editorLabel(e),
              desc: e.id === 'system' ? t('in.editor.system.desc') : null,
              checked: cur === e.id,
              icon: Icon(e.id === 'system' ? 'external' : 'edit', 14),
              onSelect: () => openInEditor(e.id),
            })),
          )
        return h(
          'div',
          { className: 'wsm-split' },
          Btn({ label, icon: 'external', variant: 'outline', size: 'tb', onClick: () => openInEditor(null), tip: s.D.agents.path }),
          h(
            'button',
            {
              type: 'button',
              className: 'wsm-btn',
              'data-variant': 'outline',
              'data-size': 'tb',
              'aria-label': t('in.open.choose'),
              'data-tip': t('in.open.choose'),
              'aria-haspopup': 'menu',
              'aria-expanded': String(!!(s.menu && s.menu.id === 'editor')),
              'data-menu-anchor': 'editor',
              onClick: () => openMenu('editor', 'editor', build, 'end'),
            },
            Icon('chevD', 14),
          ),
        )
      }
      function GlobalInstructions(s) {
        const D = s.D
        const I = s.ins
        const ag = D.agents
        if (ag.status === 'loading') return h('div', { key: 'ld', style: 'margin-top:20px;display:flex;flex-direction:column;gap:10px' }, Skel('40%', 14, '', 1), Skel('92%', 10, '', 2), Skel('70%', 10, '', 3))
        if (ag.status === 'missing') {
          return Empty({
            key: 'missing',
            ill: 'doc',
            title: t('in.missing.title'),
            body: t('in.missing.body'),
            extra: [
              ag.path ? h('code', { key: 'p', className: 'wsm-pathchip', 'data-tip': ag.path }, homeShort(ag.path)) : null,
              h('p', { key: 'h', className: 'wsm-empty-body', style: 'margin-top:6px' }, t('in.missing.hint')),
            ],
            action: Btn({ label: t('in.missing.create'), icon: 'plus', variant: 'outline', onClick: createAgentsFile }),
          })
        }
        if (ag.status !== 'ok') {
          return Empty({
            key: 'error',
            ill: 'broken',
            error: true,
            title: t('in.error.title'),
            extra: ag.error ? h('code', { className: 'wsm-errcode' }, ag.error) : null,
            action: Btn({ label: t('st.error.retry'), variant: 'outline', icon: 'refresh', onClick: () => reloadAgents() }),
          })
        }
        const ab = ag.bytes
        const max = ag.limit
        const secs = ag.sections
        const narrow = s.size === 'narrow'
        const cur = Math.max(0, Math.min(I.current, secs.length - 1))
        const tocItems = () =>
          secs.map((sec, i) => ({
            key: sec.uid,
            label: i + 1 + '. ' + sec.name,
            checked: i === cur,
            onSelect: () => {
              S.ins.current = i
              up()
              P.after(() => scrollToChapter(i, true))
            },
          }))
        return [
          h(
            'div',
            { className: 'wsm-filehead', key: 'fh' },
            h(
              'div',
              { className: 'wsm-filehead-main' },
              h('div', { className: 'wsm-filehead-title' }, Glyph('globalInstr', 16), t('in.global.title'), h('code', { className: 'wsm-pathchip', 'data-tip': ag.path, tabIndex: 0 }, homeShort(ag.path))),
              h('p', { className: 'wsm-filehead-sub' }, t('in.global.sub')),
            ),
            h(
              'div',
              { className: 'wsm-budget' },
              h(
                'div',
                { className: 'wsm-budget-top', 'data-tip': max ? t('in.budget.tip', { used: nf(ab), max: nf(max) }) : t('in.budget.only.tip', { used: nf(ab) }) },
                h('span', null, t('in.budget')),
                h('b', null, max ? t('in.budget.v', { used: kb(ab), max: kb(max) }) : t('in.budget.only', { used: kb(ab) })),
              ),
              max ? Meter(ab, max) : null,
            ),
          ),
          h(
            'div',
            { className: 'wsm-instr-layout', key: 'lay' },
            !narrow && secs.length
              ? h(
                  'nav',
                  { className: 'wsm-toc', 'aria-label': t('in.toc.label'), key: 'toc' },
                  h('div', { className: 'wsm-toc-label' }, t('in.toc')),
                  h(
                    'ol',
                    null,
                    secs.map((sec, i) =>
                      h(
                        'li',
                        { key: sec.uid },
                        h(
                          'button',
                          {
                            type: 'button',
                            'aria-current': String(i === cur),
                            onClick: () => {
                              S.ins.current = i
                              up()
                              scrollToChapter(i, true)
                            },
                          },
                          h('i', null, String(i + 1)),
                          h('span', null, sec.name),
                        ),
                      ),
                    ),
                  ),
                )
              : null,
            h(
              'div',
              { key: 'chaps', style: 'min-width:0' },
              narrow && secs.length && !s.focus
                ? h(
                    'div',
                    { className: 'wsm-toc-drop', key: 'drop' },
                    h(
                      'button',
                      { type: 'button', className: 'wsm-select', 'data-menu-anchor': 'toc', 'aria-haspopup': 'menu', 'aria-expanded': String(!!(s.menu && s.menu.id === 'toc')), onClick: () => openMenu('toc', 'toc', tocItems) },
                      Icon('layers', 14),
                      h('span', null, t('in.toc.current', { n: cur + 1, title: secs[cur] ? secs[cur].name : '' })),
                      Icon('chevD', 12, 'wsm-select-chev'),
                    ),
                  )
                : null,
              ag.preamble
                ? h(
                    'div',
                    { className: 'wsm-preamble', key: 'pre', style: narrow ? 'margin-top:12px' : null },
                    h(
                      'button',
                      {
                        type: 'button',
                        'aria-expanded': String(I.preambleOpen),
                        onClick: () => {
                          S.ins.preambleOpen = !I.preambleOpen
                          up()
                        },
                      },
                      h('b', null, t('in.preamble')),
                      h('span', null, t('in.preamble.note')),
                      Icon('chevD', 14),
                    ),
                    I.preambleOpen ? Markdown(ag.preamble, { 'data-muted': 'true' }) : null,
                  )
                : null,
              secs.length ? null : h('p', { className: 'wsm-empty-body', key: 'none', style: 'padding:16px 0' }, t('in.empty.chapters')),
              secs.map((sec, i) => Chapter(s, sec, i)),
              I.editing === 'new' ? ChapterEditor(s, 'new', secs.length + 1) : h('button', { key: 'add', type: 'button', className: 'wsm-addchap', onClick: startNewChapter }, Icon('plus', 14), t('in.add')),
            ),
          ),
        ]
      }
      function Chapter(s, sec, i) {
        const I = s.ins
        const editing = I.editing === sec.uid
        const n = i + 1
        return h(
          'section',
          { key: sec.uid, className: 'wsm-chap', 'data-chap': sec.uid, 'data-flash': I.flash === sec.uid ? 'true' : null, 'aria-labelledby': ID('ch-' + n) },
          editing
            ? ChapterEditor(s, sec.uid, n)
            : [
                h(
                  'div',
                  { className: 'wsm-chap-head', key: 'h' },
                  h('span', { className: 'wsm-chap-num', 'aria-hidden': 'true' }, String(n)),
                  h('h3', { className: 'wsm-chap-title', id: ID('ch-' + n) }, h('span', { className: 'wsm-sr' }, t('in.chapter.n', { n }) + ' '), sec.name),
                  h('span', { className: 'wsm-chap-bytes' }, t('unit.kb', { n: kb(sec.bytes) })),
                  h(
                    'div',
                    { className: 'wsm-chap-actions' },
                    Btn({ label: t('in.edit'), icon: 'edit', size: 'sm', onClick: () => startEditChapter(sec.uid), disabled: !!I.busy, busy: I.busy === sec.uid }),
                    IconBtn({
                      icon: 'more',
                      label: t('in.more', { n }),
                      tip: false,
                      disabled: !!I.busy,
                      onClick: () =>
                        openMenu(
                          'chap-' + sec.uid,
                          'chap-' + sec.uid,
                          () => [
                            { key: 'e', label: t('in.edit'), icon: Icon('edit', 14), onSelect: () => startEditChapter(sec.uid) },
                            { sep: true, key: 's' },
                            { key: 'd', label: t('in.delete'), icon: Icon('trash', 14), danger: true, onSelect: () => deleteChapter(sec.uid) },
                          ],
                          'end',
                        ),
                      attrs: { 'data-menu-anchor': 'chap-' + sec.uid, 'aria-haspopup': 'menu', 'aria-expanded': String(!!(s.menu && s.menu.id === 'chap-' + sec.uid)) },
                    }),
                  ),
                ),
                h('div', { key: 'b' }, Markdown(sec.body)),
              ],
        )
      }
      function ChapterEditor(s, uid, n) {
        const I = s.ins
        const d = I.draft
        const isNew = uid === 'new'
        const sec = isNew ? null : sections().find((x) => x.uid === uid)
        const delta = chapterBytes(n, d.title.trim() || '-', d.body) - (sec ? chapterBytes(n, sec.name, sec.body) : 0)
        const dirty = chapDirty()
        const onKey = (e) => {
          // 输入法组字中、或有对话框开着时，不处理编辑器快捷键
          if (isImeEvent(e) || S.modal) return
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            cancelChapter()
          }
          if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
            e.preventDefault()
            e.stopPropagation()
            saveChapter()
          }
        }
        return h(
          'div',
          { key: 'ed-' + uid, className: 'wsm-chap-edit', 'data-chap': isNew ? 'new' : null, onKeyDown: onKey },
          h(
            'div',
            { className: 'wsm-chap-edit-head' },
            h('span', { className: 'wsm-chap-num', 'aria-hidden': 'true' }, String(n)),
            h('input', {
              key: 'ti',
              className: 'wsm-chap-input',
              'data-chap-input': uid,
              value: d.title,
              placeholder: t('in.title.ph'),
              'aria-label': t('in.title.label', { n }),
              'aria-invalid': I.error && I.errorField === 'title' ? 'true' : null,
              onInput: (e) => {
                const v = e.target.value.replace(/[\r\n]+/g, ' ')
                S.ins.draft.title = v
                if (S.ins.error) {
                  S.ins.error = ''
                  S.ins.errorField = ''
                }
                up()
              },
              onKeyDown: (e) => {
                if (e.key === 'Enter' && !isImeEvent(e)) {
                  e.preventDefault()
                  focusLater(attrSel('data-chap-body', uid))
                }
              },
            }),
          ),
          I.error ? h('p', { className: 'wsm-err', role: 'alert' }, Icon('warn', 12), h('span', null, I.error)) : null,
          !isNew && I.conflict
            ? h(
                'div',
                { className: 'wsm-callout', 'data-tone': 'warn', role: 'status', style: 'margin-top:10px' },
                Icon('warn', 14),
                h('div', { className: 'wsm-callout-main' }, h('div', null, t('in.conflict.note')), Btn({ label: t('in.conflict.useFile'), size: 'sm', variant: 'outline', onClick: useFileChapter, disabled: I.saving })),
              )
            : null,
          h(
            'textarea',
            Object.assign(
              {
                key: 'bo',
                className: 'wsm-field',
                'data-chap-body': uid,
                value: d.body,
                placeholder: t('in.body.ph'),
                'aria-label': t('in.body.label', { n }),
                spellcheck: 'false',
                onInput: (e) => {
                  autosize(e.target)
                  S.ins.draft.body = e.target.value
                  up()
                },
              },
              autosizeHooks,
            ),
          ),
          h(
            'div',
            { className: 'wsm-chap-edit-foot' },
            h(
              'span',
              { className: 'wsm-hint' },
              Kbd('Ctrl'),
              Kbd('S'),
              t('in.hint.save'),
              h('span', { style: 'margin:0 4px' }, '·'),
              Kbd('Esc'),
              t('in.hint.cancel'),
              delta
                ? [h('span', { key: 'dot', style: 'margin:0 4px' }, '·'), h('b', { key: 'd', 'data-up': delta > 0 ? 'true' : null }, t('in.delta', { sign: delta > 0 ? '+' : '−', n: nf(Math.abs(delta)) }))]
                : null,
            ),
            Btn({ label: t('in.discard'), variant: 'ghost', onClick: cancelChapter, size: 'sm', disabled: I.saving }),
            Btn({
              label: I.saving ? t('in.saving') : isNew ? t('in.add.create') : t('in.save'),
              variant: 'primary',
              size: 'sm',
              busy: I.saving,
              disabled: (!isNew && !dirty) || !!I.busy,
              onClick: () => saveChapter(),
              tip: t('in.save.tip'),
            }),
          ),
        )
      }
      function ProjectInstructions(s) {
        const Pj = s.D.project
        const root = Pj && Pj.status === 'ok' ? Pj.root || Pj.workspace || s.D.workspace : s.D.workspace
        const head = h(
          'div',
          { className: 'wsm-filehead', key: 'fh' },
          h(
            'div',
            { className: 'wsm-filehead-main' },
            h(
              'div',
              { className: 'wsm-filehead-title' },
              Glyph('projInstr', 16),
              t('layer.projInstr'),
              h('span', { className: 'wsm-ws', 'data-tip': root ? root.path : null, tabIndex: 0, style: 'font-weight:400' }, Icon('folder', 14), h('span', null, root ? root.name : t('ov.workspace.unknown'))),
            ),
            h('p', { className: 'wsm-filehead-sub' }, t('layer.projInstr.desc')),
          ),
        )
        const note = h('p', { className: 'wsm-note', key: 'note' }, Icon('info', 14), h('span', null, t('in.proj.note')))
        if (!Pj || Pj.status === 'loading') return [head, h('div', { key: 'ld', style: 'margin-top:16px' }, Skel('100%', 160, 'border-radius:20px'))]
        if (Pj.status !== 'ok') return [head, h('p', { className: 'wsm-note', key: 'na' }, Icon('warn', 14), h('span', null, Pj.status === 'error' && Pj.error ? Pj.error : t('in.proj.unavailable')))]
        const card = (k, f) => {
          const file = k === 'team' ? 'AGENTS.md' : 'AGENTS.local.md'
          const expanded = !!s.ins.expanded[k]
          const long = f.exists && bytesOf(f.body) > 700
          const readable = f.exists && !f.error
          return h(
            'article',
            { key: k, className: 'wsm-projcard', 'aria-labelledby': ID('pc-' + k) },
            h(
              'div',
              { className: 'wsm-projcard-head' },
              h('span', { className: 'wsm-projcard-ic', 'aria-hidden': 'true' }, Icon(k === 'team' ? 'branch' : 'user')),
              h(
                'div',
                { className: 'wsm-projcard-main' },
                h(
                  'h3',
                  { className: 'wsm-projcard-title', id: ID('pc-' + k) },
                  t('layer.' + k + '.short'),
                  h('code', { className: 'wsm-pathchip', 'data-tip': f.path || null }, file),
                  Tag(t(k === 'team' ? 'in.proj.git' : 'in.proj.nogit'), k === 'team' ? 'neutral' : null),
                ),
                h('p', { className: 'wsm-projcard-sub' }, t('layer.' + k + '.desc'), f.exists ? ' · ' + t('in.proj.size', { kb: kb(f.bytes), when: f.mtime ? t('time.updated', { when: relTime(f.mtime) }) : t('time.none') }) : ''),
              ),
              f.exists
                ? Btn({
                    label: s.size === 'narrow' ? null : t('in.proj.open'),
                    icon: 'external',
                    size: 'sm',
                    variant: 'ghost',
                    onClick: () => openInEditor(null, k),
                    tip: s.size === 'narrow' ? t('in.proj.open') : f.path,
                    attrs: { 'aria-label': t('in.proj.open') },
                  })
                : null,
            ),
            f.exists
              ? [
                  f.error
                    ? h('p', { key: 'err', className: 'wsm-projcard-note', 'data-tone': 'error', style: 'padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2)' }, Icon('warn', 12), h('span', null, t('in.proj.readError', { error: f.error })))
                    : h('div', { key: 'b', className: 'wsm-projcard-body', 'data-clamp': long && !expanded ? 'true' : null }, Markdown(f.body)),
                  readable && long
                    ? h(
                        'div',
                        { key: 'm', className: 'wsm-projcard-more' },
                        Btn({
                          label: expanded ? t('in.proj.collapse') : t('in.proj.expand'),
                          size: 'sm',
                          variant: 'ghost',
                          icon: expanded ? 'chevU' : 'chevD',
                          onClick: () => {
                            S.ins.expanded[k] = !expanded
                            up()
                          },
                        }),
                      )
                    : null,
                  readable && f.truncated && (expanded || !long) ? h('p', { key: 'tr', className: 'wsm-projcard-note' }, Icon('info', 12), h('span', null, t('in.proj.truncated', { kb: kb(f.bytes) }))) : null,
                ]
              : h(
                  'div',
                  { className: 'wsm-projcard-missing' },
                  h('p', { style: 'color:var(--dsw-alias-label-primary);font-weight:500' }, t('in.proj.missing', { file })),
                  h('p', null, t(k === 'team' ? 'in.proj.missing.team' : 'in.proj.missing.local')),
                ),
          )
        }
        return [head, h('div', { className: 'wsm-projcards', key: 'cards' }, card('team', Pj.team), card('local', Pj.local)), note]
      }

      /* ---------- 记忆 ---------- */
      function MemoriesView(s) {
        const M = s.mm
        const D = s.D
        if (!D.memories.length) return Scroll('mem-empty', h('div', { className: 'wsm-page' }, Empty({ ill: 'cards', title: t('mm.empty.title'), body: t('mm.empty.body') })))
        const narrow = s.size === 'narrow'
        const showList = !s.focus && (!narrow || M.view === 'list')
        const showDetail = !narrow || M.view === 'detail' || s.focus
        return h('div', { className: 'wsm-mem' }, showList ? MemoryList(s) : null, showDetail ? MemoryDetailPane(s) : null)
      }
      function MemoryList(s) {
        const M = s.mm
        const D = s.D
        const L = D.limits
        const vis = visibleMems()
        const scoped = visibleMems({ type: 'all' })
        const countType = (ty) => scoped.filter((m) => ty === 'all' || normType(m.type) === ty).length
        const libCount = (scope) => D.memories.filter((m) => m.scope === scope).length
        const selIdx = vis.findIndex((m) => memKey(m) === M.sel)
        const rowKey = (e, i) => {
          let n = null
          if (e.key === 'ArrowDown') n = Math.min(vis.length - 1, i + 1)
          else if (e.key === 'ArrowUp') n = Math.max(0, i - 1)
          else if (e.key === 'Home') n = 0
          else if (e.key === 'End') n = vis.length - 1
          if (n == null || n === i) return
          e.preventDefault()
          const key = memKey(vis[n])
          const sel = '.wsm-row' + attrSel('data-key', key)
          if (s.size === 'narrow') {
            focusLater(sel)
            return
          }
          guard(() => {
            setSelection(vis[n])
            up()
            focusLater(sel)
          })
        }
        const filtered = M.query.trim() || M.type !== 'all' || M.scope !== 'all'
        return h(
          'div',
          { className: 'wsm-mlist', key: 'mlist' },
          h(
            'div',
            { className: 'wsm-mtools' },
            h(
              'label',
              { className: 'wsm-input' },
              Icon('search', 16),
              h('input', {
                key: 'q',
                type: 'search',
                'data-search': 'true',
                value: M.query,
                placeholder: t('mm.search.ph'),
                'aria-label': t('mm.search.label'),
                'aria-keyshortcuts': '/',
                onInput: (e) => {
                  const value = e.target.value
                  const willHide = memDirty() && !visibleMems({ query: value }).some((m) => memKey(m) === M.sel)
                  if (willHide) {
                    up()
                    guard(() => {
                      S.mm.query = value
                      up()
                    })
                  } else {
                    S.mm.query = value
                    up()
                  }
                },
                onKeyDown: (e) => {
                  if (isImeEvent(e)) return
                  if (e.key === 'Escape' && M.query) {
                    e.preventDefault()
                    e.stopPropagation()
                    setFilter({ query: '' })
                  }
                },
              }),
              M.query
                ? IconBtn({
                    icon: 'close',
                    label: t('mm.search.clear'),
                    size: 12,
                    onClick: () => {
                      setFilter({ query: '' })
                      focusLater('[data-search]')
                    },
                  })
                : h('span', { className: 'wsm-kbd', 'data-tip': t('mm.search.kbd') }, '/'),
            ),
            Seg({
              label: t('mm.scope.label'),
              value: M.scope,
              stretch: true,
              items: [
                { value: 'all', label: t('mm.scope.all') },
                { value: 'project', label: t('mm.scope.project') },
                { value: 'global', label: t('mm.scope.global') },
              ],
              onChange: (v) => setFilter({ scope: v }),
            }),
            h(
              'div',
              { className: 'wsm-libs' },
              ['project', 'global'].map((sc) =>
                h(
                  'span',
                  { key: sc, 'data-tip': L.maxMemoryCount ? t('mm.lib.tip', { name: libName(sc), n: libCount(sc), max: L.maxMemoryCount }) : t('mm.lib.tipNoMax', { name: libName(sc), n: libCount(sc) }) },
                  Glyph(cellOfScope(sc), 11),
                  libName(sc),
                  h('b', null, L.maxMemoryCount ? libCount(sc) + '/' + L.maxMemoryCount : String(libCount(sc))),
                ),
              ),
            ),
            h(
              'div',
              { className: 'wsm-chips', role: 'group', 'aria-label': t('mm.type.label') },
              ['all'].concat(TYPES).map((ty) => {
                const n = countType(ty)
                return h(
                  'button',
                  {
                    key: ty,
                    type: 'button',
                    className: 'wsm-chip',
                    'aria-pressed': String(M.type === ty),
                    disabled: n === 0 && M.type !== ty,
                    'data-tip': ty === 'all' ? null : t('type.' + ty + '.tip'),
                    onClick: () => setFilter({ type: ty }),
                  },
                  h('span', null, ty === 'all' ? t('mm.type.all') : t('type.' + ty)),
                  h('i', null, String(n)),
                )
              }),
            ),
          ),
          Scroll(
            'mlist',
            vis.length
              ? [
                  h('span', { key: 'sr', className: 'wsm-sr', role: 'status' }, t('mm.count', { n: vis.length })),
                  h(
                    'ul',
                    { key: 'ul', className: 'wsm-rows', 'data-wrap': 'true', role: 'listbox', 'aria-label': t('mm.list.label') },
                    vis.map((m, i) =>
                      MemRow(m, {
                        option: true,
                        showScope: M.scope === 'all',
                        selected: memKey(m) === M.sel && s.size !== 'narrow',
                        tabIndex: (selIdx < 0 ? i === 0 : i === selIdx) ? 0 : -1,
                        dirty: memKey(m) === M.sel && memDirty(),
                        onClick: () => selectMemory(memKey(m)),
                        onKeyDown: (e) => rowKey(e, i),
                      }),
                    ),
                  ),
                ]
              : Empty({
                  inline: true,
                  title: M.query.trim() ? t('mm.nomatch.q', { q: M.query.trim() }) : t('mm.nomatch.filter'),
                  body: t('mm.nomatch.body'),
                  action: filtered ? Btn({ label: t('mm.clearFilters'), size: 'sm', variant: 'outline', onClick: () => setFilter({ query: '', type: 'all', scope: 'all' }) }) : null,
                }),
          ),
        )
      }
      function MemoryDetailPane(s) {
        const M = s.mm
        const m = M.sel ? findMem(M.sel) : null
        if (!m || !M.draft) return h('div', { className: 'wsm-detail', key: 'detail-empty' }, Scroll('detail-empty', Empty({ ill: 'cards', title: t('mm.pick'), body: t('mm.pick.sub') })))
        return MemoryDetail(s, m)
      }
      function MemoryDetail(s, m) {
        const M = s.mm
        const d = M.draft
        const L = s.D.limits
        const narrow = s.size === 'narrow'
        const dirty = memDirty()
        // 升级 / 删除这一条在途：锁住编辑（成功后编辑区会清空，期间敲的字没有去处）
        const locked = !!(M.busy && M.busy.key === M.sel)
        const E = M.errors
        const moving = d.scope !== M.baseline.scope
        const k = sourceKind(m)
        const st = staleInfo(m, Date.now())
        const onTitleKey = (e) => {
          if (e.key === 'Enter' && !isImeEvent(e)) e.preventDefault()
        }
        const promoteHint = d.scope === 'global' && (d.type === 'user' || d.type === 'feedback')
        const typeMenu = () =>
          TYPES.map((ty) => ({ key: ty, label: t('type.' + ty), desc: t('type.' + ty + '.tip'), icon: Icon(TYPE_ICON[ty], 14), checked: d.type === ty, onSelect: () => editDraft({ type: ty }) }))
        const scopeMenu = () => [
          { key: 'project', label: t('mm.scope.opt.project'), desc: t('mm.scope.opt.project.desc'), icon: Glyph('projMem', 14), checked: d.scope === 'project', onSelect: () => editDraft({ scope: 'project' }) },
          { key: 'global', label: t('mm.scope.opt.global'), desc: t('mm.scope.opt.global.desc'), icon: Glyph('globalMem', 14), checked: d.scope === 'global', onSelect: () => editDraft({ scope: 'global' }) },
        ]
        const moreMenu = () => [
          { key: 'p', label: t('mm.menu.promote'), desc: t('mm.menu.promote.desc'), icon: Icon('arrowUp', 14), onSelect: () => promoteMemory(memKey(m)) },
          { sep: true, key: 's' },
          { key: 'd', label: t('mm.menu.delete'), icon: Icon('trash', 14), danger: true, onSelect: () => deleteMemory(memKey(m)) },
        ]
        const prop = (key, icon, label, value, extra) => [
          h('div', { key: key + 'k', className: 'wsm-prop-k' }, Icon(icon, 14), h('span', null, label)),
          h('div', Object.assign({ key: key + 'v', className: 'wsm-prop-v' }, extra || {}), value),
        ]
        const split = s.focus && s.size === 'wide'
        const bodyLen = d.body.trim().length
        const editor = h(
          'textarea',
          Object.assign(
            {
              key: 'body-' + M.docId,
              className: 'wsm-field',
              value: d.body,
              readOnly: locked,
              'aria-label': t('mm.body'),
              'aria-invalid': E.body ? 'true' : null,
              spellcheck: 'false',
              onInput: (e) => {
                autosize(e.target)
                S.mm.draft.body = e.target.value
                if (S.mm.errors.body) delete S.mm.errors.body
                S.mm.saveError = ''
                up()
              },
            },
            autosizeHooks,
          ),
        )
        const preview = h('div', { key: 'pv', className: 'wsm-preview-box' }, d.body.trim() ? Markdown(d.body) : h('p', { className: 'wsm-prop-muted' }, t('mm.body.empty')))
        const tagAdd = () => {
          if (M.tagInput == null) {
            return h(
              'button',
              {
                type: 'button',
                className: 'wsm-addtag',
                key: 'add',
                disabled: locked,
                onClick: () => {
                  S.mm.tagInput = ''
                  S.mm.tagError = ''
                  up()
                  focusLater('[data-taginput]')
                },
              },
              Icon('plus', 12),
              t('mm.tags.add'),
            )
          }
          const commit = (keepOpen) => {
            const v = S.mm.tagInput || ''
            if (!v.trim()) {
              S.mm.tagInput = keepOpen ? '' : null
              S.mm.tagError = ''
              up()
              return
            }
            const err = validateTag(v, S.mm.draft.tags, L)
            if (err) {
              S.mm.tagError = err
              up()
              return
            }
            S.mm.draft.tags = S.mm.draft.tags.concat([v.trim()])
            S.mm.tagInput = keepOpen ? '' : null
            S.mm.tagError = ''
            up()
            if (keepOpen) focusLater('[data-taginput]')
          }
          return h('input', {
            key: 'tagin',
            className: 'wsm-taginput',
            'data-taginput': 'true',
            value: M.tagInput,
            placeholder: t('mm.tags.ph'),
            'aria-label': t('mm.tags.ph'),
            'aria-invalid': M.tagError ? 'true' : null,
            onInput: (e) => {
              S.mm.tagInput = e.target.value.replace(/[\r\n]/g, '')
              S.mm.tagError = ''
              up()
            },
            onKeyDown: (e) => {
              if (isImeEvent(e)) return
              if (e.key === 'Enter') {
                e.preventDefault()
                commit(true)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                S.mm.tagInput = null
                S.mm.tagError = ''
                up()
              }
            },
            onBlur: () => {
              if (S.mm.tagInput != null && !S.mm.tagError) commit(false)
            },
          })
        }
        const usageText = m.hits ? (m.lastHit ? t('mm.usage', { n: m.hits, when: relTime(m.lastHit) }) : t('mm.usage.noTime', { n: m.hits })) : t('mm.usage.never')
        return h(
          'div',
          { className: 'wsm-detail', key: 'detail' },
          h(
            'div',
            { className: 'wsm-dbar' },
            narrow && !s.focus
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'wsm-back',
                    onClick: () => {
                      S.mm.view = 'list'
                      up()
                      focusLater('.wsm-row' + attrSel('data-key', M.sel))
                    },
                  },
                  Icon('chevL', 16),
                  t('mm.back'),
                )
              : null,
            h('span', { className: 'wsm-crumb' }, Glyph(cellOfScope(m.scope), 12), h('b', null, libName(m.scope)), h('span', null, '/ ' + m.id + '.md')),
            IconBtn({
              icon: 'more',
              label: t('mm.more'),
              onClick: () => openMenu('mem-more', 'mem-more', moreMenu, 'end'),
              disabled: locked,
              attrs: { 'data-menu-anchor': 'mem-more', 'aria-haspopup': 'menu', 'aria-expanded': String(!!(s.menu && s.menu.id === 'mem-more')) },
            }),
          ),
          Scroll(
            'detail-' + M.docId,
            h(
              'div',
              { className: 'wsm-doc' },
              h(
                'textarea',
                Object.assign(
                  {
                    key: 'title-' + M.docId,
                    className: 'wsm-doc-title',
                    readOnly: locked,
                    rows: 1,
                    value: d.title,
                    placeholder: t('mm.title.ph'),
                    'aria-label': t('mm.title.label'),
                    'aria-invalid': E.title ? 'true' : null,
                    onKeyDown: onTitleKey,
                    onInput: (e) => {
                      const v = singleLine(e.target.value)
                      if (v !== e.target.value) e.target.value = v
                      autosize(e.target)
                      S.mm.draft.title = v
                      if (S.mm.errors.title) delete S.mm.errors.title
                      S.mm.saveError = ''
                      up()
                    },
                  },
                  autosizeHooks,
                ),
              ),
              E.title ? h('p', { className: 'wsm-err', role: 'alert' }, Icon('warn', 12), h('span', null, E.title)) : null,
              h(
                'textarea',
                Object.assign(
                  {
                    key: 'desc-' + M.docId,
                    className: 'wsm-doc-desc',
                    readOnly: locked,
                    rows: 1,
                    value: d.description,
                    placeholder: t('mm.desc.ph'),
                    'aria-label': t('mm.desc.label'),
                    'aria-invalid': E.description ? 'true' : null,
                    'data-tip': t('pd.summary.tip'),
                    onKeyDown: onTitleKey,
                    onInput: (e) => {
                      const v = singleLine(e.target.value)
                      if (v !== e.target.value) e.target.value = v
                      autosize(e.target)
                      S.mm.draft.description = v
                      if (S.mm.errors.description) delete S.mm.errors.description
                      S.mm.saveError = ''
                      up()
                    },
                  },
                  autosizeHooks,
                ),
              ),
              E.description ? h('p', { className: 'wsm-err', role: 'alert' }, Icon('warn', 12), h('span', null, E.description)) : null,
              h(
                'div',
                { className: 'wsm-props' },
                prop(
                  'type',
                  'tag',
                  t('mm.prop.type'),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'wsm-select',
                      'data-menu-anchor': 'mm-type',
                      'aria-haspopup': 'menu',
                      'aria-expanded': String(!!(s.menu && s.menu.id === 'type')),
                      'data-tip': t('type.' + d.type + '.tip'),
                      'data-changed': d.type !== M.baseline.type ? 'true' : null,
                      onClick: () => openMenu('type', 'mm-type', typeMenu),
                      disabled: locked,
                    },
                    Icon(TYPE_ICON[d.type], 14),
                    h('span', null, t('type.' + d.type)),
                    Icon('chevD', 12, 'wsm-select-chev'),
                  ),
                ),
                prop(
                  'scope',
                  'globe',
                  t('mm.prop.scope'),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'wsm-select',
                      'data-menu-anchor': 'mm-scope',
                      'aria-haspopup': 'menu',
                      'aria-expanded': String(!!(s.menu && s.menu.id === 'scope')),
                      'data-changed': moving ? 'true' : null,
                      onClick: () => openMenu('scope', 'mm-scope', scopeMenu),
                      disabled: locked,
                    },
                    Glyph(cellOfScope(d.scope), 14),
                    h('span', null, d.scope === 'global' ? t('mm.scope.opt.global') : t('mm.scope.opt.project')),
                    Icon('chevD', 12, 'wsm-select-chev'),
                  ),
                ),
                moving || promoteHint
                  ? h(
                      'div',
                      { key: 'scopenote', className: 'wsm-prop-wide', style: 'display:flex;flex-direction:column;gap:6px' },
                      moving ? h('div', { className: 'wsm-callout', role: 'status' }, Icon('arrowR', 14), h('span', { className: 'wsm-callout-main' }, d.scope === 'global' ? t('mm.scope.toGlobal') : t('mm.scope.toProject'))) : null,
                      promoteHint
                        ? h(
                            'div',
                            { className: 'wsm-callout', 'data-tone': 'warn', role: 'status' },
                            Icon('warn', 14),
                            h(
                              'div',
                              { className: 'wsm-callout-main' },
                              h('div', null, t('mm.scope.shouldPromote', { type: t('type.' + d.type) })),
                              Btn({
                                label: t('mm.scope.promoteBtn'),
                                icon: 'arrowUp',
                                size: 'sm',
                                variant: 'outline',
                                onClick: () => {
                                  S.mm.draft.scope = M.baseline.scope
                                  up()
                                  promoteMemory(memKey(m))
                                },
                              }),
                            ),
                          )
                        : null,
                    )
                  : null,
                prop('tags', 'tag', t('mm.prop.tags'), [
                  d.tags.map((tg) =>
                    h(
                      'span',
                      { key: 'tg-' + tg, className: 'wsm-tagchip' },
                      h('span', null, tg),
                      h(
                        'button',
                        {
                          type: 'button',
                          'aria-label': t('mm.tags.remove', { tag: tg }),
                          disabled: locked,
                          onClick: () => {
                            S.mm.draft.tags = S.mm.draft.tags.filter((x) => x !== tg)
                            up()
                          },
                        },
                        Icon('close', 10),
                      ),
                    ),
                  ),
                  tagAdd(),
                  M.tagError || E.tags ? h('span', { key: 'te', className: 'wsm-err', style: 'margin:0;flex-basis:100%', role: 'alert' }, Icon('warn', 12), h('span', null, M.tagError || E.tags)) : null,
                ]),
                prop('source', 'bubble', t('mm.prop.source'), [
                  SourceBadge(m),
                  m.evidence ? h('div', { key: 'q', style: 'flex-basis:100%;margin-top:2px' }, h('figure', { className: 'wsm-quote', 'data-k': k }, h('blockquote', { className: 'wsm-quote-text' }, m.evidence))) : null,
                ]),
                prop('usage', 'pulse', t('mm.prop.usage'), [
                  h('span', { key: 'u', className: m.hits ? 'wsm-num' : 'wsm-prop-muted' }, usageText),
                  st ? Tag(t('mm.usage.stale'), 'warning', Icon('clock', 11), st.kind === 'unused' ? t('ov.stale.unused', { n: st.days }) : t('ov.stale.never', { n: st.days }), 'st') : null,
                ]),
                prop(
                  'paths',
                  'file',
                  t('mm.prop.paths'),
                  (m.paths || []).length ? h('span', { className: 'wsm-pathlist', 'data-tip': t('mm.paths.tip') }, m.paths.map((p) => h('code', { key: p }, p))) : h('span', { className: 'wsm-prop-muted' }, t('mm.paths.none')),
                ),
                prop(
                  'updated',
                  'clock',
                  t('mm.prop.updated'),
                  h(
                    'span',
                    { className: 'wsm-num', 'data-tip': m.created ? t('mm.updated.tip', { created: absTime(m.created) }) : null, tabIndex: 0 },
                    m.modified ? t('mm.updated', { abs: absTime(m.modified), rel: relTime(m.modified) }) : t('time.none'),
                  ),
                ),
                prop('file', 'doc', t('mm.prop.file'), [
                  h(
                    'label',
                    { key: 'sl', className: 'wsm-slug', 'data-invalid': E.slug ? 'true' : null, 'data-tip': t('mm.file.tip') },
                    h('input', {
                      key: 'slug-' + M.docId,
                      value: d.slug,
                      readOnly: locked,
                      'aria-label': t('mm.prop.file'),
                      'aria-invalid': E.slug ? 'true' : null,
                      spellcheck: 'false',
                      style: `width:calc(${Math.max(4, Array.from(d.slug).length)}ch + 2px)`,
                      onInput: (e) => {
                        S.mm.draft.slug = e.target.value.trim()
                        if (S.mm.errors.slug) delete S.mm.errors.slug
                        up()
                      },
                      onBlur: () => {
                        const er = validateDraft(S.mm.draft, L, S.mm.baseline).slug
                        if (er) {
                          S.mm.errors.slug = er
                          up()
                        }
                      },
                    }),
                    h('span', null, '.md'),
                  ),
                  E.slug ? h('span', { key: 'se', className: 'wsm-err', style: 'margin:0;flex-basis:100%', role: 'alert' }, Icon('warn', 12), h('span', null, E.slug)) : null,
                ]),
              ),
              h(
                'div',
                { className: 'wsm-editor' },
                h(
                  'div',
                  { className: 'wsm-editor-head' },
                  h('h2', { className: 'wsm-h2' }, t('mm.body')),
                  split
                    ? null
                    : Seg({
                        size: 'sm',
                        label: t('mm.body'),
                        value: M.bodyView,
                        items: [
                          { value: 'edit', label: t('mm.body.edit') },
                          { value: 'preview', label: t('mm.body.preview') },
                        ],
                        onChange: (v) => {
                          S.mm.bodyView = v
                          up()
                        },
                      }),
                  h(
                    'span',
                    { className: 'wsm-count', 'data-warn': L.maxBodyChars && bodyLen > L.maxBodyChars ? 'true' : null },
                    L.maxBodyChars ? t('mm.body.count', { n: nf(bodyLen), max: nf(L.maxBodyChars) }) : t('mm.body.countNoMax', { n: nf(bodyLen) }),
                  ),
                ),
                E.body ? h('p', { className: 'wsm-err', role: 'alert', style: 'margin:0 0 8px' }, Icon('warn', 12), h('span', null, E.body)) : null,
                h('div', { className: 'wsm-editor-grid', 'data-split': split ? 'true' : null }, split ? [editor, preview] : M.bodyView === 'edit' ? editor : preview),
              ),
            ),
          ),
          dirty || M.saveError
            ? h(
                'div',
                { className: 'wsm-savebar', role: 'region', 'aria-label': t('mm.dirty'), key: 'savebar' },
                h('span', { className: 'wsm-savebar-msg', 'data-err': M.saveError ? 'true' : null, role: M.saveError ? 'alert' : 'status', 'data-tip': M.saveError && M.saveError.length > 40 ? M.saveError : null }, h('span', null, M.saveError || t('mm.dirty'))),
                dirty ? Btn({ label: t('mm.discard'), size: 'sm', variant: 'ghost', onClick: discardMemoryEdits, disabled: M.saving || locked }) : null,
                dirty ? Btn({ label: M.saving ? t('mm.saving') : t('mm.save'), size: 'sm', variant: 'primary', busy: M.saving, disabled: locked, onClick: () => saveMemory(), tip: t('mm.save.tip'), attrs: { 'aria-keyshortcuts': 'Control+S' } }) : null,
              )
            : null,
        )
      }

      /* ---------- 浮层 ---------- */
      function MenuLayer(s) {
        if (!s.menu) return null
        const items = s.menu.build()
        return h(
          'div',
          { key: 'menu-' + s.menu.id, className: 'wsm-menu', role: 'menu', 'data-menu-material': 'translucent', onMount: placeMenu, onUpdate: placeMenu, onKeyDown: menuKey },
          items.map((it) =>
            it.sep
              ? h('div', { key: it.key, className: 'wsm-menu-sep', role: 'separator' })
              : h(
                  'button',
                  {
                    key: 'i' + it.key,
                    type: 'button',
                    className: 'wsm-menu-item',
                    role: it.checked != null ? 'menuitemradio' : 'menuitem',
                    'aria-checked': it.checked != null ? String(!!it.checked) : null,
                    'data-danger': it.danger ? 'true' : null,
                    disabled: !!it.disabled,
                    tabIndex: -1,
                    onClick: () => {
                      const r = S.menu && S.menu.returnFocus
                      S.menu = null
                      if (r && r.isConnected) r.focus({ preventScroll: true })
                      up()
                      it.onSelect()
                    },
                  },
                  it.icon ? h('span', { className: 'wsm-menu-ic' }, it.icon) : null,
                  h('span', { className: 'wsm-menu-text' }, h('span', { className: 'wsm-menu-label' }, it.label), it.desc ? h('span', { className: 'wsm-menu-desc' }, it.desc) : null),
                  it.checked ? Icon('check', 14, 'wsm-menu-check') : null,
                ),
          ),
        )
      }
      function placeMenu(el) {
        const m = S.menu
        if (!m) return
        const anchor = q(attrSel('data-menu-anchor', m.anchor))
        const panel = P.root
        if (!anchor || !panel) {
          closeMenu(false)
          return
        }
        const o = fixedOrigin(el)
        const a = anchor.getBoundingClientRect()
        const pr = panel.getBoundingClientRect()
        const w = el.offsetWidth
        const hh = el.offsetHeight
        let left = m.align === 'end' ? a.right - w : a.left
        left = Math.max(pr.left + 8, Math.min(left, pr.right - w - 8))
        let top = a.bottom + 4
        if (top + hh > pr.bottom - 8 && a.top - 4 - hh > pr.top + 8) top = a.top - 4 - hh
        el.style.left = Math.round(left - o.x) + 'px'
        el.style.top = Math.round(top - o.y) + 'px'
        if (!el.hasAttribute('data-placed')) {
          el.setAttribute('data-placed', '')
          const first = el.querySelector('.wsm-menu-item[aria-checked="true"]:not(:disabled)') || el.querySelector('.wsm-menu-item:not(:disabled)')
          if (first) first.focus({ preventScroll: true })
        }
      }
      function menuKey(e) {
        const items = Array.from(e.currentTarget.querySelectorAll('.wsm-menu-item:not(:disabled)'))
        if (!items.length) return
        const i = items.indexOf(document.activeElement)
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          items[(i + 1) % items.length].focus()
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          items[(i - 1 + items.length) % items.length].focus()
        } else if (e.key === 'Home') {
          e.preventDefault()
          items[0].focus()
        } else if (e.key === 'End') {
          e.preventDefault()
          items[items.length - 1].focus()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          closeMenu()
        } else if (e.key === 'Tab') closeMenu(false)
      }
      function ModalLayer(s) {
        const m = s.modal
        if (!m) return null
        const close = m.onCancel || closeModal
        return h(
          'dialog',
          {
            key: 'dlg-' + m.uid,
            className: 'wsm-dialog',
            'aria-labelledby': ID('dlg-title'),
            'aria-describedby': ID('dlg-desc'),
            onMount: (el) => {
              try {
                if (!el.open) el.showModal()
              } catch {
                // 已打开或不支持：照样可用（只是没有遮罩）
              }
              const auto = el.querySelector('[data-autofocus]')
              if (auto) auto.focus()
            },
            onCancel: (e) => {
              e.preventDefault()
              close()
            },
            onClick: (e) => {
              if (e.target === e.currentTarget) {
                const r = e.currentTarget.getBoundingClientRect()
                if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close()
              }
            },
          },
          h('div', { className: 'wsm-dialog-head' }, m.tone === 'danger' ? Icon('warn', 18, 'wsm-dialog-ic') : null, h('h2', { className: 'wsm-dialog-title', id: ID('dlg-title') }, m.title), IconBtn({ icon: 'close', label: t('dlg.close'), tip: false, size: 14, onClick: close })),
          h('div', { className: 'wsm-dialog-desc', id: ID('dlg-desc') }, h('p', null, m.message), m.extra || null),
          h('div', { className: 'wsm-dialog-foot' }, m.buttons.map((b, i) => Btn({ key: 'b' + i, label: b.label, variant: b.variant, disabled: b.disabled, onClick: b.onClick, attrs: b.autofocus ? { autofocus: true } : null }))),
        )
      }
      function ToastLayer(s) {
        const lift = s.view === 'memories' && (memDirty() || s.mm.saveError) ? 'true' : null
        return h(
          'div',
          { key: 'toasts', className: 'wsm-toasts', 'data-lift': lift, 'aria-live': 'polite' },
          s.toasts.map((x) =>
            h(
              'div',
              { key: 'tt' + x.id, className: 'wsm-toast', role: x.persistent ? 'alert' : 'status', 'data-leaving': x.leaving ? 'true' : null, 'data-persistent': x.persistent ? 'true' : null },
              x.tone === 'warn' ? Icon('warn', 16, 'wsm-toast-ic') : null,
              h('span', { className: 'wsm-toast-text' }, x.text),
              x.action
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'wsm-toast-action',
                      onClick: () => {
                        dismissToast(x.id)
                        x.action.run()
                      },
                    },
                    x.action.label,
                  )
                : null,
              x.persistent ? IconBtn({ icon: 'close', label: t('toast.close'), tip: false, size: 12, onClick: () => dismissToast(x.id) }) : null,
            ),
          ),
        )
      }

      P.render = function render() {
        renderingPanel = P
        try {
          normalize()
          return MemoryPanel(S)
        } finally {
          renderingPanel = null
        }
      }
      // 测试与排障用：只读地看一眼当前 store（不暴露动作）
      P.peek = () => S
      return P
    }

    /**
     * 面板组件：持有一个控制器实例，store 变化时由控制器调 rerender 重绘。
     * 布局效果里挂监听与首次读取（先于浏览器绘制量好宽度，避免窄屏先按宽屏排一帧）。
     */
    function MemoryPanel({ sessionId }) {
      const [, force] = useReducer((x) => x + 1, 0)
      const ref = useRef(null)
      if (!ref.current) ref.current = createPanel(sessionId)
      const panel = ref.current
      panel.rerender = force
      useLayoutEffect(() => {
        panel.start()
        return () => panel.dispose()
      }, [])
      useLayoutEffect(() => {
        panel.commit()
      })
      return panel.render()
    }

    /**
     * 换会话 = 换一个记忆库：用 sessionId 当 key 让面板整个重挂，
     * 选中项、草稿、页签、视图、在途请求的回写一并作废，不用逐项重置。
     */
    function MemoryPanelRoot(props) {
      return h0(MemoryPanel, { ...props, key: props.sessionId ?? '' })
    }

    /* --------------------------------------------------- 命令卡：/memory */

    const MONO = "'SF Mono', 'Cascadia Mono', Consolas, 'Liberation Mono', Menlo, monospace"
    const COLORS = {
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }
    /** 命令卡按钮（列表卡里的「打开记忆面板」）。命令卡不挂样式表，用内联样式。 */
    const BUTTON = {
      border: `0.5px solid ${COLORS.borderStrong}`,
      borderRadius: '6px',
      background: COLORS.layer2,
      color: COLORS.text,
      fontSize: '12px',
      padding: '5px 12px',
      cursor: 'pointer',
    }
    const REPORT_STYLE = {
      margin: 0,
      padding: '12px 16px',
      border: `0.5px solid ${COLORS.border}`,
      borderRadius: '8px',
      background: COLORS.layer1,
      color: COLORS.text,
      fontFamily: MONO,
      fontSize: '12px',
      lineHeight: '1.5',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    }
    const COMMAND_TITLE = { color: COLORS.text2, fontSize: '12px', margin: '0 0 4px 4px', fontFamily: MONO }

    function MemoryCommandCard({ node }) {
      const outcome = node?.outcome ?? null
      const title = h0('div', { style: COMMAND_TITLE }, `/${node?.name ?? 'memory'}`)
      if (outcome === null) return h0('div', null, title, h0('pre', { style: { ...REPORT_STYLE, color: COLORS.text2 } }, '…'))
      const style = outcome.kind === 'error' ? { ...REPORT_STYLE, color: COLORS.error } : REPORT_STYLE
      return h0('div', null, title, h0('pre', { style }, outcome.text ?? ''))
    }

    /* --------------------------------------------- 命令卡：/memory_list */

    let cardContext = null

    /**
     * 从命令节点里取一个**跨挂载稳定**的身份。卡片在切换会话 / 重进会话时会重新挂载，组件内的 useRef 随之重置，
     * 「这次命令调用只自动打开一次」必须放在组件外面记，并且要能区分「是不是同一次命令调用」。
     */
    const NODE_ID_FIELDS = ['id', 'seq', 'callId', 'commandId', 'messageId', 'key']

    function commandInvocationKey(node, sessionId) {
      for (const field of NODE_ID_FIELDS) {
        const value = node?.[field]
        if (value !== undefined && value !== null && value !== '') return `${sessionId ?? ''}|${field}:${value}`
      }
      // 兜底：用「命令名 + 结果文本」算指纹。同一段历史反复挂载 → 指纹相同 → 不重复打开
      const text = `${node?.name ?? ''}|${node?.outcome?.text ?? ''}`
      let hash = 0
      for (let i = 0; i < text.length; i += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0
      return `${sessionId ?? ''}|hash:${hash}`
    }

    /** sessionStorage 不可用时的进程内兜底，避免退化成「每次挂载都开」。 */
    const openedFallback = new Set()

    function openMemoryPanel(ctx) {
      if (!ctx) return
      try {
        const layout = ctx.get('layout')
        if (layout?.openRightbar) layout.openRightbar(true, false)
        const sidebarRight = ctx.get('sidebarRight')
        if (sidebarRight?.openTab) sidebarRight.openTab(TAB_KIND)
      } catch (error) {
        console.error('[workspace-memory] 打开右侧栏失败', error)
      }
    }

    function MemoryListCommandCard({ node, sessionId }) {
      const outcome = node?.outcome ?? null
      const settled = outcome !== null

      /**
       * 首次挂载时结果是否已经存在——区分「实时完成」与「回放历史」：
       *   · 刚敲完 /memory_list：挂载时 outcome 为 null，随后才出现 → 实时完成 → 自动打开
       *   · 切回会话 / 刷新页面：挂载时 outcome 已经在 → 只是重渲染历史 → 不打开
       */
      const settledAtMount = useRef(outcome !== null)

      useEffect(() => {
        if (!settled) return
        if (settledAtMount.current) return
        const ctx = cardContext
        if (!ctx) return
        // 第二道守卫：同一张卡在命令还在跑的时候被重挂载，也不会开两次
        const key = `dsh-workspace-memory:opened:${commandInvocationKey(node, sessionId)}`
        let alreadyOpened = openedFallback.has(key)
        try {
          if (window.sessionStorage?.getItem(key)) alreadyOpened = true
          else window.sessionStorage?.setItem(key, '1')
        } catch {
          // sessionStorage 用不了就只靠内存里的 Set
        }
        openedFallback.add(key)
        if (alreadyOpened) return
        openMemoryPanel(ctx)
      }, [settled, sessionId])

      const style = outcome?.kind === 'error' ? { ...REPORT_STYLE, color: COLORS.error } : { ...REPORT_STYLE, color: COLORS.text2 }
      return h0(
        'div',
        null,
        h0('div', { style: COMMAND_TITLE }, `/${node?.name ?? 'memory_list'}`),
        h0('pre', { style }, outcome === null ? '…' : outcome.text ?? ''),
        // 兜底：即使自动打开被跳过（比如关掉之后又想看），也能一键打开
        h0('div', { style: { marginTop: '6px' } }, h0('button', { type: 'button', style: BUTTON, onClick: () => openMemoryPanel(cardContext) }, t('action.openPanel'))),
      )
    }

    /**
     * 测试钩子：把纯函数交给外部测试（test/markdown.test.mjs、test/client-logic.test.mjs）。
     * 这些函数在 factory 内部，外部拿不到；没有它们就无法用 Node 验证 Markdown 净化的安全边界与去向推导。
     * 仅在显式注入 globalThis.__wsmCollectPure 时生效，正常运行时是空操作。
     */
    if (typeof globalThis !== 'undefined' && typeof globalThis.__wsmCollectPure === 'function') {
      globalThis.__wsmCollectPure({
        escapeHTML,
        safeLink,
        autoLink,
        inlineMarkdown,
        renderMarkdown,
        lcsOps,
        inlineDiff,
        diffRows,
        bytesOf,
        kb,
        tokensOf,
        relTime,
        absTime,
        homeShort,
        lastSegment,
        isImeEvent,
        singleLine,
        bareTitle,
        locateSection,
        sourceKind,
        staleInfo,
        destOf,
        whyOf,
        toDraft,
        sameDraft,
        normalizeLimits,
        validateDraft,
        validateTag,
        checkChapterTitle,
        chapterBytes,
        demoteHeadings,
        estimatePromotedBytes,
        indexBytes,
        costParts,
        withUids,
        normalizeAgents,
        normalizeProject,
        normalizeWorkspace,
        historyDirOf,
        reasonText,
        acceptErrorText,
        acceptOutcome,
        styleObj,
        KNOWN_REASONS,
        TYPES,
        STYLESHEET,
        dictionaries: { ZH, EN },
      })
    }

    /* ------------------------------------------------------------- apply */

    return {
      inject: ['slots'],

      apply(ctx) {
        cardContext = ctx

        // 重试定时器与卡片用的 ctx 都要跟着插件一起释放，否则禁用后还会往已失效的 ctx 上注册
        let disposed = false
        let retryTimer = 0
        ctx.effect(() => () => {
          disposed = true
          if (retryTimer) clearTimeout(retryTimer)
          if (cardContext === ctx) cardContext = null
        })

        // 面板样式表：选择器全部限定在 .wsm-panel 下，释放时移除
        ctx.effect(() => {
          if (typeof document === 'undefined') return
          const el = document.createElement('style')
          el.setAttribute('data-dsh-workspace-memory', '')
          el.textContent = STYLESHEET
          document.head.appendChild(el)
          return () => el.remove()
        })

        try {
          const locale = ctx.get('locale')
          const snapshot = locale?.getLocale?.()
          // dsh-client-locale 的快照是 { active, locales, revision }：当前语言在 active 里（locale / id 是旧猜测，留作兼容）
          const language = snapshot?.active ?? snapshot?.locale ?? snapshot?.id ?? ''
          if (/^en\b/i.test(String(language))) dict = EN

          if (locale?.register) {
            ctx.effect(() => {
              const disposers = []
              try {
                disposers.push(locale.register(NS, 'en', EN))
              } catch (error) {
                console.error('[workspace-memory] locale.register(en) 失败', error)
              }
              // 内置中文的语言 id 是 `zh`（回落链 zh → en），不是 `zh-CN`：注册在 zh-CN 下中文界面会回落到英文
              try {
                disposers.push(locale.register(NS, 'zh', ZH))
              } catch (error) {
                console.error('[workspace-memory] locale.register(zh) 失败', error)
              }
              return () => {
                for (const dispose of disposers) {
                  try {
                    dispose?.()
                  } catch {
                    // 忽略释放失败
                  }
                }
              }
            })
          }

          const translate = locale?.bind?.(NS)
          if (typeof translate === 'function') {
            t = (key, vars) => {
              try {
                const out = translate(key, vars)
                if (typeof out !== 'string' || out === key) return inlineT(key, vars)
                // 宿主若不做插值，占位符由这里补上
                return vars ? out.replace(/\{(\w+)\}/g, (all, name) => (vars[name] == null ? all : String(vars[name]))) : out
              } catch {
                return inlineT(key, vars)
              }
            }
          }
        } catch {
          // 语言探测失败就用中文
        }

        // 命令结果卡片按「命令名」绑定：memory 与它拆出来的无参子命令共用同一张卡
        for (const key of ['memory', 'memory_extract', 'memory_pending']) {
          try {
            ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({ name: 'conversation.chat.commandview', key }, MemoryCommandCard))
          } catch (error) {
            console.error(`[workspace-memory] 命令卡 ${key} 注册失败`, error)
          }
        }

        try {
          ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({ name: 'conversation.chat.commandview', key: 'memory_list' }, MemoryListCommandCard))
        } catch (error) {
          console.error('[workspace-memory] memory_list 卡片注册失败', error)
        }

        const MAX_ATTEMPTS = 10
        const RETRY_MS = 150
        let attempts = 0

        const tryRegisterTab = () => {
          if (disposed) return
          attempts += 1

          let tabs = null
          try {
            tabs = ctx.get('sidebarRightTabs')
          } catch (error) {
            console.error('[workspace-memory] get(sidebarRightTabs) 失败', error)
          }

          if (!tabs || typeof tabs.register !== 'function') {
            if (attempts >= MAX_ATTEMPTS) console.error(`[workspace-memory] sidebarRightTabs 重试 ${MAX_ATTEMPTS} 次仍不可用，记忆面板未注册`)
            else retryTimer = setTimeout(tryRegisterTab, RETRY_MS)
            return
          }

          try {
            ctx.effect(() => tabs.register({ id: TAB_ID, kind: TAB_KIND, title: () => t('tab.title') }))
          } catch (error) {
            console.error('[workspace-memory] tabs.register 失败', error)
          }

          try {
            ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, MemoryPanelRoot))
          } catch (error) {
            console.error('[workspace-memory] 面板组件注册失败', error)
          }
        }

        tryRegisterTab()
      },
    }
  },
})
