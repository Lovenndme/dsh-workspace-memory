/**
 * dsh-workspace-memory — Client half.
 *
 * 三件事：
 *  1. `/memory` 的命令结果卡片默认铺开（内置卡的折叠是组件内部 state，无配置项）。
 *  2. `/memory_list` 的卡片挂载时打开右侧栏并切到记忆面板。
 *  3. 右侧栏面板：左侧记忆列表 + 右侧详情编辑，窄宽度时退化为单栏切换。
 *
 * 数据通道是宿主 HTTP 路由（/api/dsh-workspace-memory/*），
 * 和工作区里 dsh-profile-stats 走同一条路。
 *
 * 关于 source / evidence：来源（用户原话 / 助手总结）与证据原话由宿主写入时记下，这里只读展示，不提供编辑。
 * 旧文件里的 confidence 是**模型自评**，不是用户判断，同样只读展示（只在没有 source 的旧条目上出现）。
 *
 * 列表里是两个库（项目库 / 全局按需库）的条目，每条的 scope = 它所在的库；
 * 保存 / 删除 / 写入 AGENTS.md 的请求都带上它，宿主据此定位，不用两个库都找。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-memory',

  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const LIST_URL = '/api/dsh-workspace-memory/list'
    const SAVE_URL = '/api/dsh-workspace-memory/save'
    const ACCEPT_URL = '/api/dsh-workspace-memory/accept'
    const REJECT_URL = '/api/dsh-workspace-memory/reject'
    const FORGET_URL = '/api/dsh-workspace-memory/forget'
    const AGENTS_SECTIONS_URL = '/api/dsh-workspace-memory/agents/sections'
    const AGENTS_SAVE_SECTION_URL = '/api/dsh-workspace-memory/agents/save-section'
    const AGENTS_DELETE_SECTION_URL = '/api/dsh-workspace-memory/agents/delete-section'
    const AGENTS_ADD_SECTION_URL = '/api/dsh-workspace-memory/agents/add-section'
    const AGENTS_URL = '/api/dsh-workspace-memory/agents'
    const PROMOTE_URL = '/api/dsh-workspace-memory/promote'
    const OPEN_AGENTS_URL = '/api/dsh-workspace-memory/open-agents'
    const TAB_KIND = 'memory-list'
    const TAB_ID = 'dsh-workspace-memory/list'

    /** 分栏切换的宽度阈值：低于它退化成「列表 → 详情」。 */
    const SPLIT_MIN_WIDTH = 640

    const TYPES = ['user', 'feedback', 'project', 'reference', 'pitfall']

    /* ---------------------------------------------------------------- 文案 */

    const ZH = {
      'tab.title': '记忆',
      'panel.heading': '记忆管理',

      'action.refresh': '刷新',
      'action.back': '返回列表',
      'action.close': '关闭',
      'action.open': '打开',
      'action.openPanel': '打开记忆面板',
      'action.fullscreen': '全屏',
      'action.exitFullscreen': '退出全屏',
      'action.promote': '写入 AGENTS.md',
      'action.cancel': '取消',
      'action.save': '保存更改',
      'action.saveHint': '保存更改 · Ctrl / ⌘ S',
      'action.reject': '丢弃',
      'action.delete': '删除',
      'action.confirm': '确认',
      'action.accept': '收下',
      'action.gotIt': '知道了',
      'action.removeTag': '移除标签 {tag}',

      'tab.confirmed': '已确认',
      'tab.pending': '待确认',

      'search.placeholder': '搜索记忆…',
      'search.empty': '没有匹配的记忆',
      'count.items': '{count} 条记忆',

      'field.title': '记忆标题',
      'field.description': '摘要',
      'field.descriptionPlaceholder': '添加摘要',
      'field.type': '记忆分类',
      'field.scope': '适用范围',
      'field.load': '加载方式',
      'field.tags': '记忆标签',
      'field.tagAdd': '添加',
      'field.tagPlaceholder': '标签，Enter 添加',
      'field.slug': '文件名（英文 slug）',
      'field.content': '正文',

      'confidence.label': '模型自评',
      'confidence.readonly': '由模型在写入时给出的自评，不是正确率',
      'confidence.readonlyShort': '只读',
      'confidence.high': '较高',
      'confidence.mid': '中等',
      'confidence.low': '偏低',

      'source.user': '用户原话',
      'source.unverified': '未核实',
      'source.agent': '助手总结',

      'scope.project': '仅本项目',
      'scope.global': '跨项目',
      'scope.short': '跨项目',
      'scope.local': '记忆库',
      'scope.agents': 'AGENTS.md',

      'load.always': '常驻',
      'load.on-demand': '按需',

      'agents.chapters': '{count} 章',
      'agents.empty': 'AGENTS.md 里还没有章节',
      'agents.add': '新增章节',
      'agents.newTitle': '新章节标题',
      'agents.sizeNote': '文件 {kb} KB；DSH 有字节预算，过大会被截断',
      'agents.save': '保存章节',
      'agents.confirmDeleteTitle': '删除这一章？',
      'agents.confirmDelete': '会从 AGENTS.md 移除「{title}」及其子节，并重排后面的编号。写前会自动留一份备份。',
      'agents.saved': '已保存章节',
      'agents.deleted': '已删除章节',
      'agents.added': '已新增章节',
      'agents.full': 'AGENTS.md 已达上限（{bytes}/{limit} 字节），请先合并或删除一章',
      'agents.guardDescription': '当前章节有未保存的修改。',

      'editor.edit': '编辑',
      'editor.preview': '预览',

      'meta.updated': '更新于',
      'meta.unsaved': '未保存的修改',
      'meta.unsavedShort': '未保存',

      'state.loading': '正在读取记忆…',
      'state.empty': '还没有记忆',
      'state.saved': '已保存',
      'state.saving': '保存中…',
      'state.saveFailed': '保存失败',
      'state.refreshed': '列表已刷新',
      'state.accepted': '已收下',
      'state.acceptedReplaceFailed': '已收下，但旧记忆 {id} 未能删除',
      'state.rejected': '已丢弃',
      'state.promoted': '已写入 AGENTS.md，并从记忆库移出',
      'state.deleted': '已删除',
      'state.opened': '已用 {app} 打开',

      'error.titleRequired': '标题不能为空',
      'error.singleLine': '不能包含换行',
      'error.noSession': '没有可用的会话',
      'error.titleTooLong': '标题不能超过 200 字符',
      'error.bodyRequired': '正文不能为空',
      'error.bodyTooLong': '正文不能超过 20000 字符',
      'error.typeInvalid': '分类不合法',
      'error.scopeInvalid': '适用范围不合法',
      'error.slugInvalid': '只能是小写英文、数字与连字符',
      'error.descriptionTooLong': '摘要不能超过 120 字符',
      'error.tooManyTags': '标签最多 20 个',
      'error.tagInvalid': '标签不能含英文逗号或右方括号',
      'error.tagComma': '标签不能含英文逗号（会破坏 frontmatter）',
      'error.tagBracket': '标签不能含右方括号 `]`',
      'error.tagTooLong': '单个标签不能超过 40 字符',
      'error.tagDuplicate': '这个标签已经有了',
      'error.load': '读取记忆失败',
      'error.save': '保存被拒绝',

      'pending.on': '暂无待确认记忆。助手自己总结的记忆会进到这里，也可以手动 /memory extract。',
      'pending.off': '暂无待确认记忆。助手自己总结的记忆会进到这里；自动抽取未开启时也可手动 /memory extract。',
      'pending.replaceChapter': '替换第 {chapter} 章',
      'pending.newChapter': '新章',
      'pending.sectionMoved': '要替换的章节已变动，未写入',
      'pending.replacesMemory': '替换记忆 {id}',

      'detail.breadcrumb': '记忆详情',
      'detail.choose': '选择一条记忆',

      'file.title': '文件信息',
      'file.location': '本项目',
      'file.storage': '存放位置',
      'file.storageValue': '本项目记忆库',

      'agents.sections': '节',
      'agents.openWith': 'AGENTS.md 打开方式',
      'agents.auto': '打开方式：自动',

      'guard.title': '保存当前修改？',
      'guard.promoteTitle': '写入前先处理未保存的修改',
      'guard.description': '当前记忆有未保存的修改。',
      'guard.continue': '继续编辑',
      'guard.discard': '放弃修改',
      'guard.save': '保存并继续',
      'guard.discardPromote': '放弃修改后写入',
      'guard.savePromote': '保存后写入',

      'confirm.promoteTitle': '写入全局 AGENTS.md？',
      'confirm.promote': '会把这一条追加到 ~/.dsh/AGENTS.md，并从记忆库中移除（历史里保留一份可回退）。AGENTS.md 每个会话都会加载。',
      'confirm.promoteOk': '确认写入',
      'confirm.deleteTitle': '删除这条记忆？',
      'confirm.delete': '会从记忆库里移除这条记忆。历史里会保留一份副本，可回退。',
      'confirm.deleteOk': '删除',

      'promote.hint': '写入全局 AGENTS.md，并从记忆库移出',
      'promote.failed': '操作失败',

      // 宿主返回的失败原因码 → 人话（reasonText 只认这里列出的码，未知码不外露）
      'reason.invalid-id': '记忆 id 不合法',
      'reason.invalid-index': '章节位置不合法',
      'reason.not-found': '找不到这条记忆',
      'reason.section-not-found': '找不到这一章',
      'reason.section-moved': '这一章在文件里已经变化，已重新读取',
      'reason.only-chapter': '这里只能删除整章',
      'reason.scope-not-global': '这条记忆不是「跨项目」，不能写入',
      'reason.agents-missing': '找不到 AGENTS.md',
      'reason.agents-full': 'AGENTS.md 已达字节上限，请先合并或删除一章',
      'reason.already-present': 'AGENTS.md 里已有同名小节，未重复追加',
      'reason.empty-title': '标题不能为空',
      'reason.empty-body': '正文不能为空',
      'reason.library-full': '记忆库已达条数上限，请先删除一些',
      'reason.read-failed': '读取 AGENTS.md 失败',
      'reason.write-failed': '写入 AGENTS.md 失败',
      'reason.launch-failed': '无法启动编辑器',
      'reason.invalid-scope': '适用范围不合法',
      'reason.scope-ambiguous': '两个记忆库里都有这个 id 的记忆',
      'reason.target-exists': '目标记忆库里已有同名记忆',
      'reason.belongs-in-project-agents': '只在本项目常驻的规则应写进项目自己的 AGENTS.md',
      'reason.same-library': '已经在这个记忆库里',
      'reason.partially-saved': '已移库，但其余修改未保存',
      'reason.move-failed': '移库未完成，已恢复原状',
      'reason.move-partial': '移库未完成，两个库里各有一份',

      'type.user': '用户偏好',
      'type.feedback': '纠正反馈',
      'type.project': '项目决策',
      'type.reference': '参考索引',
      'type.pitfall': '踩坑经验',
    }

    const EN = {
      'tab.title': 'Memory',
      'panel.heading': 'Memory',

      'action.refresh': 'Refresh',
      'action.back': 'Back to list',
      'action.close': 'Close',
      'action.open': 'Open',
      'action.openPanel': 'Open memory panel',
      'action.fullscreen': 'Fullscreen',
      'action.exitFullscreen': 'Exit fullscreen',
      'action.promote': 'Write to AGENTS.md',
      'action.cancel': 'Cancel',
      'action.save': 'Save changes',
      'action.saveHint': 'Save changes · Ctrl / ⌘ S',
      'action.reject': 'Discard',
      'action.delete': 'Delete',
      'action.confirm': 'Confirm',
      'action.accept': 'Accept',
      'action.gotIt': 'Got it',
      'action.removeTag': 'Remove tag {tag}',

      'tab.confirmed': 'Confirmed',
      'tab.pending': 'Pending',

      'search.placeholder': 'Search memories…',
      'search.empty': 'No matching memories',
      'count.items': '{count} memories',

      'field.title': 'Memory title',
      'field.description': 'Summary',
      'field.descriptionPlaceholder': 'Add a summary',
      'field.type': 'Category',
      'field.scope': 'Scope',
      'field.load': 'Load',
      'field.tags': 'Tags',
      'field.tagAdd': 'Add',
      'field.tagPlaceholder': 'Tag, Enter to add',
      'field.slug': 'File name (English slug)',
      'field.content': 'Content',

      'confidence.label': 'Model self-assessment',
      'confidence.readonly': 'Written by the model; not an accuracy figure',
      'confidence.readonlyShort': 'read-only',
      'confidence.high': 'high',
      'confidence.mid': 'medium',
      'confidence.low': 'low',

      'source.user': "User's words",
      'source.unverified': 'Unverified',
      'source.agent': 'Assistant summary',

      'scope.project': 'This project',
      'scope.global': 'Cross-project',
      'scope.short': 'Cross-project',
      'scope.local': 'Library',
      'scope.agents': 'AGENTS.md',

      'load.always': 'Always on',
      'load.on-demand': 'On demand',

      'agents.chapters': '{count} chapters',
      'agents.empty': 'AGENTS.md has no chapters yet',
      'agents.add': 'Add chapter',
      'agents.newTitle': 'New chapter title',
      'agents.sizeNote': 'File is {kb} KB; DSH applies a byte budget and may truncate',
      'agents.save': 'Save chapter',
      'agents.confirmDeleteTitle': 'Delete this chapter?',
      'agents.confirmDelete': 'This removes "{title}" and its subsections from AGENTS.md and renumbers the rest. A backup is written first.',
      'agents.saved': 'Chapter saved',
      'agents.deleted': 'Chapter deleted',
      'agents.added': 'Chapter added',
      'agents.full': 'AGENTS.md is at its limit ({bytes}/{limit} bytes). Merge or delete a chapter first.',
      'agents.guardDescription': 'This chapter has unsaved changes.',

      'editor.edit': 'Edit',
      'editor.preview': 'Preview',

      'meta.updated': 'updated',
      'meta.unsaved': 'Unsaved changes',
      'meta.unsavedShort': 'unsaved',

      'state.loading': 'Loading memories…',
      'state.empty': 'No memories yet',
      'state.saved': 'Saved',
      'state.saving': 'Saving…',
      'state.saveFailed': 'Save failed',
      'state.refreshed': 'List refreshed',
      'state.accepted': 'Accepted',
      'state.acceptedReplaceFailed': 'Accepted, but the old memory {id} could not be deleted',
      'state.rejected': 'Discarded',
      'state.promoted': 'Written to AGENTS.md and removed from the memory library',
      'state.deleted': 'Deleted',
      'state.opened': 'Opened with {app}',

      'error.titleRequired': 'Title is required',
      'error.singleLine': 'Must be a single line',
      'error.noSession': 'No active session',
      'error.titleTooLong': 'Title must be at most 200 characters',
      'error.bodyRequired': 'Body is required',
      'error.bodyTooLong': 'Body must be at most 20000 characters',
      'error.typeInvalid': 'Invalid category',
      'error.scopeInvalid': 'Invalid scope',
      'error.slugInvalid': 'Only lowercase letters, digits and hyphens',
      'error.descriptionTooLong': 'Summary must be at most 120 characters',
      'error.tooManyTags': 'At most 20 tags',
      'error.tagInvalid': 'Tags cannot contain a comma or a closing bracket',
      'error.tagComma': 'Tags cannot contain a comma (it breaks frontmatter)',
      'error.tagBracket': 'Tags cannot contain `]`',
      'error.tagTooLong': 'A tag must be at most 40 characters',
      'error.tagDuplicate': 'That tag already exists',
      'error.load': 'Could not load memories',
      'error.save': 'Save rejected',

      'pending.on': 'No pending memories. Memories the assistant worked out itself land here, and /memory extract adds more.',
      'pending.off': 'No pending memories. Memories the assistant worked out itself land here; you can also run /memory extract manually.',
      'pending.replaceChapter': 'Replaces chapter {chapter}',
      'pending.newChapter': 'New chapter',
      'pending.sectionMoved': 'The chapter to replace has changed; nothing was written',
      'pending.replacesMemory': 'Replaces memory {id}',

      'detail.breadcrumb': 'Memory detail',
      'detail.choose': 'Select a memory',

      'file.title': 'File info',
      'file.location': 'project',
      'file.storage': 'Stored at',
      'file.storageValue': 'This project library',

      'agents.sections': 'sections',
      'agents.openWith': 'Open AGENTS.md with',
      'agents.auto': 'Open with: auto',

      'guard.title': 'Save your changes?',
      'guard.promoteTitle': 'Handle unsaved changes first',
      'guard.description': 'This memory has unsaved changes.',
      'guard.continue': 'Keep editing',
      'guard.discard': 'Discard changes',
      'guard.save': 'Save and continue',
      'guard.discardPromote': 'Discard and write',
      'guard.savePromote': 'Save and write',

      'confirm.promoteTitle': 'Write to the global AGENTS.md?',
      'confirm.promote': 'This appends the memory to ~/.dsh/AGENTS.md and removes it from the memory library (a history copy stays and can be restored). AGENTS.md is loaded in every session.',
      'confirm.promoteOk': 'Write it',
      'confirm.deleteTitle': 'Delete this memory?',
      'confirm.delete': 'This removes the memory from the memory library. A history copy is kept and can be restored.',
      'confirm.deleteOk': 'Delete',

      'promote.hint': 'Write to the global AGENTS.md and remove it from the memory library',
      'promote.failed': 'Operation failed',

      'reason.invalid-id': 'Invalid memory id',
      'reason.invalid-index': 'Invalid chapter position',
      'reason.not-found': 'Memory not found',
      'reason.section-not-found': 'Chapter not found',
      'reason.section-moved': 'This chapter changed in the file; reloaded',
      'reason.only-chapter': 'Only whole chapters can be deleted',
      'reason.scope-not-global': 'This memory is not cross-project, so it cannot be written',
      'reason.agents-missing': 'AGENTS.md not found',
      'reason.agents-full': 'AGENTS.md is at its size limit. Merge or delete a chapter first.',
      'reason.already-present': 'AGENTS.md already has a section with this title; nothing appended',
      'reason.empty-title': 'Title is required',
      'reason.empty-body': 'Body is required',
      'reason.library-full': 'The memory library is full. Delete some first.',
      'reason.read-failed': 'Could not read AGENTS.md',
      'reason.write-failed': 'Could not write AGENTS.md',
      'reason.launch-failed': 'Could not launch the editor',
      'reason.invalid-scope': 'Invalid scope',
      'reason.scope-ambiguous': 'Both libraries have a memory with this id',
      'reason.target-exists': 'The target library already has a memory with this name',
      'reason.belongs-in-project-agents': "An always-on rule for one project belongs in that project's AGENTS.md",
      'reason.same-library': 'Already in this library',
      'reason.partially-saved': 'Moved to the other library, but the other changes were not saved',
      'reason.move-failed': 'The move did not complete and was rolled back',
      'reason.move-partial': 'The move did not complete; both libraries now hold a copy',

      'type.user': 'User preference',
      'type.feedback': 'Feedback',
      'type.project': 'Project decision',
      'type.reference': 'Reference',
      'type.pitfall': 'Pitfall',
    }


    let dict = ZH
    const NS = 'workspace-memory'

    function inlineT(key, vars) {
      let out = dict[key] ?? ZH[key] ?? key
      if (vars) {
        for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, String(value))
      }
      return out
    }

    let t = inlineT

    /* ---------------------------------------------------------------- 样式 */

    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

    const COLORS = {
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    /** 命令卡按钮用（列表卡里的「打开记忆面板」）。面板本身已改用样式表类名。 */
    const BUTTON = {
      border: `0.5px solid ${COLORS.borderStrong}`,
      borderRadius: '6px',
      background: COLORS.layer2,
      color: COLORS.text,
      fontSize: '12px',
      padding: '5px 12px',
      cursor: 'pointer',
    }

    /**
     * 面板样式：从 preview/panel.html 的已确认设计 1:1 搬过来。
     *
     * 两条硬约束：
     *  1. **全部 scope 在 `.wsm-panel` 下**。预览是独立页面，可以用 `button{}`、
     *     `::selection`、`[hidden]` 这类裸选择器；搬进 DSH 后会污染整个应用界面，
     *     所以每条都加了 `.wsm-panel` 前缀。
     *  2. 插件的 `:root` 变量放到 `.wsm-panel` 上（`--wsm-*`），避免泄漏到宿主。
     *
     * 颜色一律走 `--dsw-alias-*`，不写死色值，跟随 DSH 主题。
     */
    const STYLESHEET = `
.wsm-panel {
  --wsm-selection: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, var(--dsw-alias-bg-layer-1));
  --wsm-button-bg: color-mix(in srgb, var(--dsw-alias-brand-primary) 72%, var(--dsw-alias-bg-base));
  --wsm-canvas: var(--dsw-alias-bg-canvas, var(--dsw-alias-bg-base));
  --wsm-mono: Consolas, "SFMono-Regular", "Liberation Mono", "Microsoft YaHei", monospace;
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: 14px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
}
.wsm-panel *, .wsm-panel *::before, .wsm-panel *::after { box-sizing: border-box; }
.wsm-panel [hidden] { display: none !important; }
.wsm-panel button, .wsm-panel input, .wsm-panel textarea, .wsm-panel select { font: inherit; }
.wsm-panel button, .wsm-panel select { cursor: pointer; }
.wsm-panel button { color: inherit; }
.wsm-panel button, .wsm-panel input, .wsm-panel textarea, .wsm-panel select { -webkit-tap-highlight-color: transparent; }
.wsm-panel button:focus-visible, .wsm-panel input:focus-visible, .wsm-panel textarea:focus-visible,
.wsm-panel select:focus-visible, .wsm-panel [tabindex="0"]:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px;
}
.wsm-panel button:disabled, .wsm-panel input:disabled, .wsm-panel textarea:disabled, .wsm-panel select:disabled { cursor: default; }
.wsm-panel button:disabled { opacity: .42; }
.wsm-panel ::selection { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, transparent); }
.wsm-panel * { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l2) transparent; }
.wsm-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

/* header */
.wsm-header { display: flex; flex: 0 0 64px; min-width: 0; align-items: center; justify-content: space-between; gap: 20px; padding: 0 22px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.wsm-header-top, .wsm-header-tools { display: flex; align-items: center; min-width: 0; gap: 22px; }
.wsm-brand { font-size: 19px; font-weight: 650; letter-spacing: -.4px; white-space: nowrap; }
.wsm-title { font-size: 17px; color: var(--dsw-alias-label-secondary); padding-left: 22px; border-left: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; }
.wsm-workspace { color: var(--dsw-alias-label-secondary); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 230px; }
.wsm-btn { display: inline-flex; justify-content: center; align-items: center; min-height: 34px; padding: 5px 16px; background: transparent; color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; white-space: nowrap; font-size: 13px; line-height: 1.4; transition: background-color .12s, border-color .12s, color .12s; }
.wsm-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-secondary); }
.wsm-btn:active:not(:disabled) { background: var(--dsw-alias-bg-layer-1); }
.wsm-btn.primary { background: var(--wsm-button-bg); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.wsm-btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 73%, var(--dsw-alias-bg-base)); }
/* 破坏性操作：只染边框与文字，不抢主按钮的视觉重量 */
.wsm-btn.danger { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-error-primary); }
.wsm-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); border-color: var(--dsw-alias-state-error-primary); }
.wsm-btn-small { min-height: 28px; padding: 3px 12px; font-size: 12px; }
.wsm-text-btn { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); padding: 5px 0; font-size: 13px; }
.wsm-text-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.wsm-select { min-height: 32px; padding: 4px 28px 4px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; max-width: 100%; }
.wsm-panel option { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }

/* body */
.wsm-panel-body { display: grid; grid-template-columns: clamp(260px, 27%, 400px) minmax(0, 1fr); flex: 1 1 auto; min-height: 0; }
.wsm-list-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--dsw-alias-bg-layer-1); border-right: 1px solid var(--dsw-alias-border-l1); }
.wsm-list-tools { flex: 0 0 auto; padding: 0 16px 16px; }
.wsm-tabs { display: flex; gap: 23px; height: 54px; border-bottom: 1px solid var(--dsw-alias-border-l1); margin-bottom: 16px; }
.wsm-tabs button { position: relative; padding: 0 10px; font-size: 14px; color: var(--dsw-alias-label-secondary); background: transparent; border: 0; white-space: nowrap; }
.wsm-tabs button:first-child { margin-left: -9px; }
.wsm-tabs button[aria-selected="true"], .wsm-editor-tabs button[aria-selected="true"] { color: var(--dsw-alias-brand-primary); }
.wsm-tabs button[aria-selected="true"]::after, .wsm-editor-tabs button[aria-selected="true"]::after { position: absolute; content: ""; height: 2px; bottom: -1px; left: 0; right: 0; background: var(--dsw-alias-brand-primary); border-radius: 1px; }
.wsm-search { display: block; width: 100%; height: 37px; padding: 7px 12px; color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; font-size: 13px; }
.wsm-panel input::placeholder, .wsm-panel textarea::placeholder { color: var(--dsw-alias-label-secondary); opacity: .8; }
.wsm-list-region { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.wsm-list-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 0 16px; }
.wsm-item { position: relative; display: block; width: 100%; padding: 16px 20px 13px; text-align: left; font: inherit; color: var(--dsw-alias-label-primary); background: transparent; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); border-left: 3px solid transparent; cursor: pointer; }
.wsm-item:hover { background: var(--dsw-alias-bg-layer-2); }
.wsm-item[aria-selected="true"] { background: var(--wsm-selection); border-left-color: var(--dsw-alias-brand-primary); }
.wsm-item:focus-visible { outline-offset: -3px; }
.wsm-item-title { margin-bottom: 5px; font-weight: 550; font-size: 14px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.wsm-item-desc { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.wsm-badges { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-top: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.wsm-badge { padding: 0 5px; line-height: 19px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; }
.wsm-badge.t-global { margin-left: auto; padding: 0; border: 0; }
.wsm-item-dirty { color: var(--dsw-alias-state-warn-primary); font-size: 10px; }
.wsm-empty { padding: 28px 20px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.wsm-agents-row { flex: 0 0 auto; padding: 15px 20px 20px; border-top: 1px solid var(--dsw-alias-border-l1); }
.wsm-agents-summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.wsm-agents-name { color: var(--dsw-alias-label-primary); font-size: 14px; }
.wsm-agents-actions { display: flex; gap: 12px; }
.wsm-agents-actions .wsm-select { flex: 1; min-width: 0; }
.wsm-agents-actions .wsm-btn { flex: 0 0 78px; }

/* detail: a document, not a column of form cards */
.wsm-detail-pane, .wsm-detail-document { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.wsm-detail-document { flex: 1 1 auto; }
.wsm-detail-empty { display: flex; align-items: center; justify-content: center; flex: 1; color: var(--dsw-alias-label-secondary); }
.wsm-detail-main { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.wsm-doc-head { flex: 0 0 auto; padding: 23px 36px 17px; }
.wsm-crumbs { display: none; margin: -7px 0 10px; }
.wsm-field { min-width: 0; }
.wsm-input { width: 100%; background: transparent; color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; padding: 7px 10px; }
.wsm-panel textarea.wsm-input { display: block; resize: none; }
.wsm-input.wsm-detail-title, .wsm-input.wsm-description { box-sizing: border-box; border: 0; border-radius: 3px; padding: 2px 0; width: 100%; overflow-y: auto; overflow-x: hidden; }
.wsm-detail-title { margin: 0; font-size: 26px; line-height: 1.42; letter-spacing: -.35px; font-weight: 650; min-height: 41px; max-height: 151px; }
.wsm-description { margin: 10px 0 0; font-size: 14px; line-height: 1.7; font-weight: 400; color: var(--dsw-alias-label-secondary); min-height: 28px; max-height: 76px; }
.wsm-input.wsm-description { color: var(--dsw-alias-label-secondary); }
.wsm-detail-title:hover, .wsm-description:hover { background: var(--dsw-alias-bg-layer-1); }
.wsm-property-row { display: flex; align-items: center; flex-wrap: wrap; gap: 9px 12px; margin-top: 17px; }
.wsm-property-row .wsm-select { background: var(--dsw-alias-bg-layer-1); }
/* 详情里的「替换记忆」标签：字号与颜色照抄列表卡片的 .wsm-badges；id 可能很长，允许折行 */
.wsm-property-row .wsm-badge { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.wsm-confidence { margin: 0 0 0 auto; color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap; }
/* 来源行带着用户原话时可能很长（宿主不截断）：允许折行，否则会被详情区的 overflow-x: hidden 截掉；
   高度上限沿用 .wsm-description 的 76px，免得把编辑区推下去 */
.wsm-confidence.wsm-evidence { white-space: normal; overflow-wrap: anywhere; max-height: 76px; overflow-y: auto; }
.wsm-tags-field { margin-top: 12px; }
.wsm-tags, .wsm-tag-chips { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.wsm-tag-chips:empty { display: none; }
.wsm-tag { display: inline-flex; align-items: center; gap: 7px; min-height: 29px; max-width: 100%; padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; }
.wsm-tag > span { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsm-tag button { display: inline-flex; justify-content: center; align-items: center; min-width: 20px; height: 23px; margin: -3px -5px -3px 0; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 15px; }
.wsm-tag button:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-border-l2); }
.wsm-tag-add { min-height: 29px; padding: 4px 9px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.wsm-tag-input { min-width: 0; width: 160px; height: 29px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 4px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 4px 8px; font-size: 12px; }
.wsm-error { margin: 5px 0 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.wsm-panel [aria-invalid="true"] { outline: 1px solid var(--dsw-alias-state-error-primary); outline-offset: 2px; }

/* editor */
.wsm-editor-shell { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 260px; margin: 0 36px; border-top: 1px solid var(--dsw-alias-border-l1); }
.wsm-editor-head { display: flex; align-items: center; flex: 0 0 50px; gap: 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.wsm-editor-tabs { display: flex; align-self: stretch; gap: 24px; }
.wsm-editor-tabs button { position: relative; min-width: 45px; font-size: 14px; }
.wsm-editor-format { margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.wsm-body-error { padding-bottom: 5px; }
.wsm-editor { display: grid; grid-template-columns: 37px minmax(0, 1fr); flex: 1 1 auto; min-height: 200px; overflow: hidden; }
.wsm-gutter { overflow: hidden; user-select: none; text-align: right; color: var(--dsw-alias-label-secondary); border-right: 1px solid var(--dsw-alias-border-l1); font-family: var(--wsm-mono); font-size: 13px; line-height: 23px; }
.wsm-gutter > div { padding: 14px 10px 24px 0; will-change: transform; }
.wsm-gutter-line { min-height: 23px; }
.wsm-code-area { position: relative; min-width: 0; min-height: 0; }
.wsm-code-highlight, .wsm-body-editor { tab-size: 2; font: 14px/23px var(--wsm-mono); font-variant-ligatures: none; letter-spacing: 0; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; padding: 14px 16px 24px; border: 0; margin: 0; }
.wsm-code-highlight { position: absolute; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; color: var(--dsw-alias-label-primary); }
.wsm-code-line { display: block; min-height: 23px; }
.wsm-syntax-heading, .wsm-syntax-mark { color: color-mix(in srgb, var(--dsw-alias-brand-primary) 72%, var(--dsw-alias-label-primary)); }
.wsm-syntax-code { color: color-mix(in srgb, var(--dsw-alias-brand-primary) 66%, var(--dsw-alias-label-primary)); }
.wsm-body-editor { position: relative; z-index: 1; display: block; height: 100%; width: 100%; min-height: 200px; resize: none; background: transparent; color: var(--dsw-alias-label-primary); caret-color: var(--dsw-alias-brand-primary); overflow: auto; outline-offset: -2px; }
.wsm-panel[data-highlighted="true"] .wsm-body-editor { color: transparent; -webkit-text-fill-color: transparent; }
.wsm-panel[data-highlighted="true"] .wsm-body-editor::selection { color: transparent; -webkit-text-fill-color: transparent; }
.wsm-preview { flex: 1 1 auto; min-height: 200px; overflow: auto; padding: 21px 4px 40px; font-size: 14px; line-height: 1.85; overflow-wrap: anywhere; }
.wsm-preview article { max-width: 76ch; }
.wsm-preview h1, .wsm-preview h2, .wsm-preview h3, .wsm-preview h4 { line-height: 1.5; margin: 1.6em 0 .6em; }
.wsm-preview h1:first-child, .wsm-preview h2:first-child, .wsm-preview h3:first-child { margin-top: 0; }
.wsm-preview h1 { font-size: 25px; } .wsm-preview h2 { font-size: 20px; } .wsm-preview h3 { font-size: 17px; }
.wsm-preview p { margin: 0 0 1em; }
.wsm-preview ul, .wsm-preview ol { padding-left: 1.6em; margin: 0 0 1em; }
.wsm-preview li { margin: .3em 0; }
.wsm-preview a { color: color-mix(in srgb, var(--dsw-alias-brand-primary) 72%, var(--dsw-alias-label-primary)); text-underline-offset: 3px; }
.wsm-preview code { font: .92em/1.65 var(--wsm-mono); background: var(--dsw-alias-bg-layer-2); padding: 2px 4px; border-radius: 3px; }
.wsm-preview pre { margin: 0 0 1.3em; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; overflow-x: auto; white-space: pre; }
.wsm-preview pre code { background: transparent; padding: 0; }
.wsm-preview blockquote { margin: 0 0 1em; padding: 2px 16px; border-left: 2px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.wsm-preview blockquote p:last-child { margin-bottom: 0; }
.wsm-preview hr { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); margin: 24px 0; }

/* footer: persistent save bar */
.wsm-footer { position: relative; display: flex; flex: 0 0 auto; align-items: center; flex-wrap: wrap; gap: 8px 20px; min-height: 90px; padding: 16px 36px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.wsm-footer-meta { flex: 1 1 160px; min-width: 0; }
.wsm-file-trigger { display: flex; align-items: center; gap: 9px; max-width: 100%; min-height: 26px; padding: 1px 0; background: transparent; border: 0; color: var(--dsw-alias-label-primary); font-size: 12px; text-align: left; }
.wsm-file-trigger:hover { color: var(--dsw-alias-brand-primary); }
.wsm-file-location { padding: 2px 7px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; white-space: nowrap; }
.wsm-file-slash { color: var(--dsw-alias-label-secondary); }
.wsm-file-trigger .file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsm-modified { display: block; margin-top: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.wsm-footer-actions { display: flex; align-items: center; flex: 0 0 auto; gap: 10px; flex-wrap: nowrap; margin-left: auto; }
.wsm-footer-actions .wsm-btn { min-height: 36px; min-width: 78px; }
.wsm-footer-actions .primary { min-width: 106px; }
.wsm-unsaved { white-space: nowrap; margin-right: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wsm-unsaved[data-state="dirty"] { color: var(--dsw-alias-state-warn-primary); }
.wsm-unsaved[data-state="error"] { color: var(--dsw-alias-state-error-primary); }
.wsm-unsaved[data-state="success"] { color: var(--dsw-alias-state-success-primary); }
.wsm-save-error { flex: 0 0 100%; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.wsm-footer-actions .wsm-promote { min-width: 0; }

/* file popover */
.wsm-file-popover { position: absolute; bottom: calc(100% + 8px); left: 30px; width: min(390px, calc(100% - 40px)); max-height: min(410px, max(120px, calc(100dvh - 210px))); overflow-y: auto; z-index: 5; padding: 18px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; box-shadow: 0 10px 30px color-mix(in srgb, var(--wsm-canvas) 70%, transparent); }
.wsm-popover-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.wsm-popover-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
.wsm-file-popover label { display: block; margin-bottom: 7px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wsm-slug-field { display: flex; gap: 7px; align-items: center; font-family: var(--wsm-mono); font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wsm-slug-field .mono { min-width: 0; font-family: var(--wsm-mono); font-size: 12px; }
.wsm-file-facts { display: grid; grid-template-columns: 72px minmax(0,1fr); gap: 9px 8px; margin: 18px 0; font-size: 12px; }
.wsm-file-facts dt { color: var(--dsw-alias-label-secondary); } .wsm-file-facts dd { margin: 0; overflow-wrap: anywhere; }

/* dialogs + toast */
.wsm-dialog { max-width: min(460px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 20px 70px var(--wsm-canvas); }
.wsm-dialog::backdrop { background: color-mix(in srgb, var(--wsm-canvas) 70%, transparent); }
.wsm-dialog h2 { margin: 0 0 10px; font-size: 18px; font-weight: 600; }
.wsm-dialog p { margin: 0 0 24px; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 1.7; }
.wsm-dialog-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.wsm-toast { position: absolute; z-index: 10; bottom: 20px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 32px); padding: 8px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); font-size: 12px; pointer-events: none; }

/* container-driven reflow */
.wsm-panel[data-layout="single"] .wsm-panel-body { grid-template-columns: minmax(0,1fr); }
.wsm-panel[data-layout="single"] .wsm-list-pane { border-right: 0; }
.wsm-panel[data-layout="single"][data-view="detail"] .wsm-list-pane { display: none; }
.wsm-panel[data-layout="single"][data-view="list"] .wsm-detail-pane { display: none; }
.wsm-panel[data-layout="single"] .wsm-brand { display: none; }
.wsm-panel[data-layout="single"] .wsm-title { border: 0; padding: 0; color: var(--dsw-alias-label-primary); font-size: 16px; }
.wsm-panel[data-layout="single"] .wsm-header { flex-basis: 55px; padding: 0 18px; gap: 12px; }
.wsm-panel[data-layout="single"] .wsm-header-tools { gap: 12px; }
.wsm-panel[data-layout="single"] .wsm-workspace { font-size: 11px; max-width: 135px; }
.wsm-panel[data-layout="single"] .wsm-header .wsm-btn { min-height: 29px; padding: 4px 9px; font-size: 12px; }
.wsm-panel[data-layout="single"] .wsm-crumbs { display: flex; }
.wsm-panel[data-layout="single"] .wsm-doc-head { padding: 18px 20px 16px; }
.wsm-panel[data-layout="single"] .wsm-detail-title { font-size: 22px; line-height: 1.45; min-height: 36px; max-height: 132px; }
.wsm-panel[data-layout="single"] .wsm-description { font-size: 13px; }
.wsm-panel[data-layout="single"] .wsm-property-row { gap: 10px; margin-top: 13px; }
.wsm-panel[data-layout="single"] .wsm-confidence { flex: 1 0 100%; margin-left: 0; font-size: 11px; }
.wsm-panel[data-layout="single"] .wsm-editor-shell { margin: 0 20px; }
.wsm-panel[data-layout="single"] .wsm-editor-head { flex-basis: 44px; gap: 10px; }
.wsm-panel[data-layout="single"] .wsm-editor-tabs { gap: 16px; }
.wsm-panel[data-layout="single"] .wsm-editor-format { font-size: 11px; }
.wsm-panel[data-layout="single"] .wsm-editor { grid-template-columns: 30px minmax(0,1fr); }
.wsm-panel[data-layout="single"] .wsm-code-highlight, .wsm-panel[data-layout="single"] .wsm-body-editor { font-size: 13px; padding-left: 10px; padding-right: 8px; }
.wsm-panel[data-layout="single"] .wsm-footer { padding: 12px 20px; gap: 9px; }
.wsm-panel[data-layout="single"] .wsm-footer-meta { flex: 0 0 100%; }
.wsm-panel[data-layout="single"] .wsm-footer-actions { display: grid; grid-template-columns: minmax(0,1fr) auto auto auto; gap: 8px; width: 100%; }
.wsm-panel[data-layout="single"] .wsm-unsaved { grid-column: 1 / -1; margin: 0; }
.wsm-panel[data-layout="single"] .wsm-footer-actions .wsm-btn { min-width: 64px; padding-left: 13px; padding-right: 13px; }
.wsm-panel[data-layout="single"] .wsm-footer-actions .primary { min-width: 100px; }
.wsm-panel[data-layout="single"] .wsm-footer-actions .wsm-promote { min-width: 0; padding-left: 6px; padding-right: 6px; font-size: 12px; }
.wsm-panel[data-layout="single"] .wsm-file-popover { left: 20px; }

/* 全局 AGENTS.md 页：与记忆库同样的「宽分栏 / 窄单栏」行为 */
.wsm-agents-pane { display: flex; min-height: 0; grid-column: 1 / -1; }
.wsm-agents-list { display: flex; flex-direction: column; min-width: 0; flex: 0 0 42%; background: var(--dsw-alias-bg-layer-1); border-right: 1px solid var(--dsw-alias-border-l1); }
.wsm-agents-detail { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.wsm-panel[data-layout="single"] .wsm-agents-list { flex: 1 1 auto; border-right: 0; }
.wsm-panel[data-layout="single"] .wsm-agents-pane[data-view="list"] .wsm-agents-detail { display: none; }
.wsm-panel[data-layout="single"] .wsm-agents-pane[data-view="detail"] .wsm-agents-list { display: none; }
/* 全局模式：项目侧两栏让位给 AGENTS.md 面板 */
.wsm-panel-body[data-scope="global"] > .wsm-list-pane,
.wsm-panel-body[data-scope="global"] > .wsm-detail-pane { display: none; }
.wsm-panel[data-mode="wide"] .wsm-doc-head { padding-left: 24px; padding-right: 24px; }
.wsm-panel[data-mode="wide"] .wsm-editor-shell { margin-left: 24px; margin-right: 24px; }
.wsm-panel[data-mode="wide"] .wsm-footer { padding-left: 24px; padding-right: 24px; }
.wsm-panel[data-mode="wide"] .wsm-detail-title { font-size: 23px; }
.wsm-panel[data-mode="wide"] .wsm-confidence { margin-left: 0; flex: 1 0 100%; }
.wsm-panel[data-mode="wide"] .wsm-footer-meta { flex-basis: 100%; }
.wsm-panel[data-mode="wide"] .wsm-footer-actions { width: 100%; }
.wsm-panel[data-mode="wide"] .wsm-unsaved { flex: 1; }
.wsm-panel[data-fullscreen="true"] .wsm-list-pane,
.wsm-panel[data-fullscreen="true"] .wsm-doc-head { display: none; }
.wsm-panel[data-fullscreen="true"] .wsm-detail-pane { display: flex; grid-column: 1 / -1; }
.wsm-panel[data-fullscreen="true"] .wsm-editor-shell { margin-top: 12px; border-top: 0; }
@media (prefers-reduced-motion: reduce) {
  .wsm-panel *, .wsm-panel *::before, .wsm-panel *::after { transition: none !important; scroll-behavior: auto !important; }
}
@media (forced-colors: active) {
  .wsm-code-highlight { display: none; }
  .wsm-panel[data-highlighted="true"] .wsm-body-editor { color: CanvasText; -webkit-text-fill-color: CanvasText; }
  .wsm-item[aria-selected="true"] { border-left: 3px solid Highlight; }
}
`

    /* ------------------------------------------------------ 纯函数（可测） */

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
     * 链接协议白名单。
     *
     * 只放行 http/https/mailto 和页内锚点；`javascript:`、`data:`、`file:` 一律丢弃。
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

    /** 行内 Markdown：先转义，再按白名单语法重建标签。 */
    function inlineMarkdown(text, depth = 0) {
      if (depth > 3) return escapeHTML(text)
      const token = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\[([^\]\n]{1,300})\]\(([^\s)]{1,1000})\)|\*([^*\n]+)\*|~~([^~\n]+)~~/g
      let result = ''
      let cursor = 0
      let match
      while ((match = token.exec(text))) {
        result += escapeHTML(text.slice(cursor, match.index))
        if (match[1] != null) result += `<code>${escapeHTML(match[1])}</code>`
        else if (match[2] != null || match[3] != null) result += `<strong>${inlineMarkdown(match[2] || match[3], depth + 1)}</strong>`
        else if (match[4] != null) {
          const href = safeLink(match[5])
          result += href
            ? `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${inlineMarkdown(match[4], depth + 1)}</a>`
            : escapeHTML(match[0])
        } else if (match[6] != null) result += `<em>${inlineMarkdown(match[6], depth + 1)}</em>`
        else result += `<del>${escapeHTML(match[7])}</del>`
        cursor = token.lastIndex
      }
      return result + escapeHTML(text.slice(cursor))
    }

    /**
     * 块级 Markdown → HTML。
     *
     * 输出只由本函数生成（全部来自转义后的文本 + 固定标签），
     * 因此可以安全地交给 React 渲染；**绝不**把原文当 HTML 插入。
     */
    function renderMarkdown(markdown, depth = 0) {
      if (depth > 3) return `<p>${escapeHTML(markdown)}</p>`
      const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
      // 空正文不该渲染出一个空段落（正文虽然校验为非空，预览会先于校验触发）
      if (lines.every((line) => line.trim() === '')) return ''
      const blocks = []
      let paragraph = []
      const flush = () => {
        if (paragraph.length) blocks.push(`<p>${inlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`)
        paragraph = []
      }
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        // 空行是段落分隔符；以前它被当成段落内容，「a 空行 b」会渲染成 <p>a<br><br>b</p>
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
          const level = heading[1].length
          blocks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
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
        const listItem = line.match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/)
        if (listItem) {
          flush()
          const ordered = Boolean(listItem[2])
          const items = []
          while (i < lines.length) {
            const item = lines[i].match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/)
            if (!item || Boolean(item[2]) !== ordered) break
            let content = item[3]
            i += 1
            while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-+*]|\d+[.)])\s/.test(lines[i])) {
              content += '\n' + lines[i].trim()
              i += 1
            }
            items.push(`<li>${inlineMarkdown(content).replace(/\n/g, '<br>')}</li>`)
          }
          i -= 1
          const tag = ordered ? 'ol' : 'ul'
          const start = ordered && Number(listItem[2]) !== 1 ? ` start="${Number(listItem[2])}"` : ''
          blocks.push(`<${tag}${start}>${items.join('')}</${tag}>`)
          continue
        }
        paragraph.push(line)
      }
      flush()
      return blocks.join('\n')
    }

    /** 编辑器高亮层：单行语法着色，输出同样来自转义后的文本。 */
    function highlightLine(line) {
      if (/^#{1,6}\s/.test(line)) return `<span class="wsm-syntax-heading">${escapeHTML(line)}</span>`
      const token = /`[^`]*`|\*\*[^*]+\*\*/g
      let output = ''
      let cursor = 0
      let match
      while ((match = token.exec(line))) {
        output += escapeHTML(line.slice(cursor, match.index))
        const kind = match[0][0] === '`' ? 'code' : 'mark'
        output += `<span class="wsm-syntax-${kind}">${escapeHTML(match[0])}</span>`
        cursor = token.lastIndex
      }
      return output + escapeHTML(line.slice(cursor))
    }

    /**
     * 标签规范化，与服务端 `validateMemoryPatch` 的规则保持一致：
     * 去空白、去重、拒绝含英文逗号或右方括号（会破坏 frontmatter 内联数组）。
     * 返回 `{ ok, tag }` 或 `{ ok: false, reason }`。
     */
    function normalizeTag(raw) {
      const tag = String(raw ?? '').trim()
      if (!tag) return { ok: false, reason: 'empty' }
      if (/[,]/.test(tag)) return { ok: false, reason: 'comma' }
      if (/\]/.test(tag)) return { ok: false, reason: 'bracket' }
      if (tag.length > 40) return { ok: false, reason: 'too-long' }
      return { ok: true, tag }
    }

    /**
     * 客户端逐字段校验，规则与服务端一致；只用于即时反馈，
     * 服务端仍然是最终闸门（这里放过的，服务端仍可能拒绝）。
     */
    function validateDraft(draft) {
      const errors = {}
      if (!draft.title || !draft.title.trim()) errors.title = t('error.titleRequired')
      else if (/[\r\n]/.test(draft.title)) errors.title = t('error.singleLine')
      else if (draft.title.length > 200) errors.title = t('error.titleTooLong')
      if (!draft.body || !draft.body.trim()) errors.body = t('error.bodyRequired')
      else if (draft.body.length > 20000) errors.body = t('error.bodyTooLong')
      if (!TYPES.includes(draft.type)) errors.type = t('error.typeInvalid')
      if (draft.scope !== 'global' && draft.scope !== 'project') errors.scope = t('error.scopeInvalid')
      if (!/^[a-z0-9][a-z0-9-]*$/.test(String(draft.slug ?? '').trim())) errors.slug = t('error.slugInvalid')
      if (/[\r\n]/.test(draft.description)) errors.description = t('error.singleLine')
      else if (draft.description.length > 120) errors.description = t('error.descriptionTooLong')
      const tags = draft.tags ?? []
      if (tags.length > 20) errors.tags = t('error.tooManyTags')
      else if (tags.some((tag) => tag.length > 40 || /[,]/.test(tag) || /\]/.test(tag))) errors.tags = t('error.tagInvalid')
      return errors
    }

    /** 标题/摘要是 frontmatter 里的单行字段：换行会让宿主写出损坏的文件。 */
    function singleLine(value) {
      return String(value ?? '').replace(/[\r\n]+/g, ' ')
    }

    /**
     * 输入法组字中？React 的合成键盘事件不带 isComposing（只有原生事件有），
     * 所以必须同时看 nativeEvent；keyCode 229 是各浏览器对「组字中按键」的统一标记。
     */
    function isImeEvent(event) {
      return Boolean(event?.isComposing || event?.nativeEvent?.isComposing || event?.keyCode === 229)
    }

    /** AGENTS.md 章标题去掉编号（`3. 标题` → `标题`），与宿主 expectedTitle 的口径一致。 */
    function bareTitle(title) {
      return String(title ?? '').trim().replace(/^\d+(?:\.\d+)?\.\s*/, '')
    }

    /** 重新读取后按「用户看到的标题」找回这一章现在的位置：优先原位置，找不到返回 -1。 */
    function locateSection(sections, title, hintIndex) {
      if (!Array.isArray(sections)) return -1
      const want = bareTitle(title)
      if (sections[hintIndex] && bareTitle(sections[hintIndex].title) === want) return hintIndex
      return sections.findIndex((section) => bareTitle(section.title) === want)
    }

    /** 保存成功后用宿主返回的记忆替换列表里的旧条目（改 slug 会换 id，fromId 是旧 id）。 */
    function replaceMemory(data, fromId, memory) {
      return { ...data, memories: data.memories.map((item) => (item.id === fromId ? memory : item)) }
    }

    function removeMemory(data, id) {
      return {
        ...data,
        memories: data.memories.filter((item) => item.id !== id),
        pending: data.pending.filter((item) => item.id !== id),
      }
    }

    /** 宿主可能返回的失败原因码；每个都必须在 ZH / EN 里有 `reason.<码>`。 */
    const KNOWN_REASONS = [
      'invalid-id',
      'invalid-index',
      'not-found',
      'section-not-found',
      'section-moved',
      'only-chapter',
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
      // 两个库之后新增：save / forget / promote 的 scope 参数、换库、收下「本项目常驻」草稿
      'invalid-scope',
      'scope-ambiguous',
      'target-exists',
      'belongs-in-project-agents',
      'same-library',
      // 面板保存换库：换库成功而其余字段没写成 / 换库本身失败并已回滚 / 回滚也失败、两个库各留一份
      'partially-saved',
      'move-failed',
      'move-partial',
    ]

    /**
     * 把宿主的失败响应翻成一句人话。原因码只认 KNOWN_REASONS（原码绝不外露），
     * 其次取宿主给的 errors[0] / error 文本，最后落到调用方给的兜底文案。
     */
    function reasonText(payload, fallback) {
      for (const code of [payload?.reason, payload?.error]) {
        if (typeof code !== 'string' || !KNOWN_REASONS.includes(code)) continue
        if (code === 'agents-full' && Number.isFinite(payload.bytes) && Number.isFinite(payload.limit)) {
          return t('agents.full', { bytes: payload.bytes, limit: payload.limit })
        }
        return t(`reason.${code}`)
      }
      const first = Array.isArray(payload?.errors) ? payload.errors.find((item) => typeof item === 'string' && item) : undefined
      if (first) return first
      if (typeof payload?.error === 'string' && payload.error) return payload.error
      return fallback
    }

    /**
     * 来源标签的文案键。模型声称 `source: user` 不等于真是用户说的：只有宿主核对到证据（evidenceVerified === true）
     * 才显示「用户原话」，否则（false 或旧数据没有这个键）显示「未核实」——审常驻草稿时不能把模型编的「原话」当真。
     * 已确认条目与草稿同一套规则。没有来源返回 null。
     */
    function sourceKey(memory) {
      if (memory?.source === 'agent') return 'source.agent'
      if (memory?.source === 'user') return memory.evidenceVerified === true ? 'source.user' : 'source.unverified'
      return null
    }

    /**
     * 待确认草稿「替换记忆 {id}」标签的文字；没有 supersedes 返回空串。
     * 常驻草稿收下时宿主会把这条旧记忆归档删除，所以点「收下」之前就得看得到。
     * 旧记忆在另一个库（supersedesScope ≠ 草稿的 scope）时，后面补上那个库，复用页脚已有的「跨项目 / 本项目」词条。
     */
    function supersedesText(memory) {
      const id = typeof memory?.supersedes === 'string' ? memory.supersedes.trim() : ''
      if (!id) return ''
      const label = t('pending.replacesMemory', { id })
      const where = memory.supersedesScope === 'global' || memory.supersedesScope === 'project' ? memory.supersedesScope : ''
      if (!where || where === memory.scope) return label
      return `${label} · ${where === 'global' ? t('scope.global') : t('file.location')}`
    }

    /* --------------------------------------------------- 命令卡：/memory */

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
      const title = h('div', { style: COMMAND_TITLE }, `/${node?.name ?? 'memory'}`)
      if (outcome === null) {
        return h('div', null, title, h('pre', { style: { ...REPORT_STYLE, color: COLORS.text2 } }, '\u2026'))
      }
      const style = outcome.kind === 'error' ? { ...REPORT_STYLE, color: COLORS.error } : REPORT_STYLE
      return h('div', null, title, h('pre', { style }, outcome.text ?? ''))
    }

    /* --------------------------------------------- 命令卡：/memory_list */

    let cardContext = null

    /**
     * 从命令节点里取一个**跨挂载稳定**的身份。
     *
     * 为什么需要：卡片在切换会话 / 重进会话时会重新挂载，组件内的 useRef 随之重置，
     * 于是「这次命令调用只自动打开一次」的意图会失效 —— 变成每次挂载都打开，
     * 表现就是「关掉侧边栏、切个会话回来又自己开了」。
     * 所以身份必须放在组件外面记，并且要能区分「是不是同一次命令调用」。
     */
    const NODE_ID_FIELDS = ['id', 'seq', 'callId', 'commandId', 'messageId', 'key']

    function commandInvocationKey(node, sessionId) {
      for (const field of NODE_ID_FIELDS) {
        const value = node?.[field]
        if (value !== undefined && value !== null && value !== '') return `${sessionId ?? ''}|${field}:${value}`
      }
      // 兜底：用「命令名 + 结果文本」算指纹。同一段历史反复挂载 → 指纹相同 → 不重复打开；
      // 真的又敲了一次 → 结果文本通常会变（计数变了），仍能打开。
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
       * 首次挂载时结果是否已经存在。
       *
       * 这是区分「实时完成」与「回放历史」的关键：
       *   · 刚敲完 /memory_list：挂载时 outcome 为 null，随后才出现 → 实时完成 → 该自动打开
       *   · 切回会话 / 刷新页面：挂载时 outcome 已经在 → 只是重渲染历史 → 不该打开
       *
       * 之前用组件内 useRef 做「只开一次」的守卫，但它随挂载重置，
       * 所以切会话回来就会再开一次——那正是「关掉之后又自己弹开」的原因。
       */
      const settledAtMount = useRef(outcome !== null)

      useEffect(() => {
        if (!settled) return
        if (settledAtMount.current) return // 挂载时已是历史，说明不是这次敲的
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

      const style =
        outcome?.kind === 'error' ? { ...REPORT_STYLE, color: COLORS.error } : { ...REPORT_STYLE, color: COLORS.text2 }

      return h(
        'div',
        null,
        h('div', { style: COMMAND_TITLE }, `/${node?.name ?? 'memory_list'}`),
        h('pre', { style }, outcome === null ? '\u2026' : (outcome.text ?? '')),
        // 兜底：即使自动打开被跳过（比如你关掉之后又想看），也能一键打开
        h(
          'div',
          { style: { marginTop: '6px' } },
          h('button', { type: 'button', style: BUTTON, onClick: () => openMemoryPanel(cardContext) }, t('action.openPanel')),
        ),
      )
    }

    /**
     * 测试钩子：把纯函数交给外部测试（见 test/markdown.test.mjs）。
     *
     * 这些函数在 factory 内部，外部拿不到；没有它们就无法用 Node 验证
     * Markdown 净化的安全边界——XSS 这类问题不能只靠肉眼看截图。
     * 仅在显式注入 globalThis.__wsmCollectPure 时生效，正常运行时是空操作。
     */
    if (typeof globalThis !== 'undefined' && typeof globalThis.__wsmCollectPure === 'function') {
      globalThis.__wsmCollectPure({
        escapeHTML,
        safeLink,
        inlineMarkdown,
        renderMarkdown,
        highlightLine,
        normalizeTag,
        validateDraft,
        singleLine,
        isImeEvent,
        bareTitle,
        locateSection,
        replaceMemory,
        removeMemory,
        reasonText,
        sourceKey,
        supersedesText,
        toDraft,
        KNOWN_REASONS,
        dictionaries: { ZH, EN },
      })
    }

    /* ---------------------------------------------------- 显示层辅助函数 */

    function formatTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    const typeLabel = (type) => t(`type.${type}`)

    function confidenceTone(value) {
      if (value >= 0.8) return t('confidence.high')
      if (value >= 0.5) return t('confidence.mid')
      return t('confidence.low')
    }

    function basename(target) {
      const text = String(target ?? '').replace(/[\\/]+$/, '')
      const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      return index >= 0 ? text.slice(index + 1) : text
    }

    function matchesQuery(memory, query) {
      if (!query) return true
      const needle = query.toLowerCase()
      const hay = [memory.title, memory.description, memory.slug ?? memory.id, memory.body, (memory.tags ?? []).join(' ')]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
      return hay.includes(needle)
    }

    /** 服务端返回的 memory → 可编辑草稿。字段与应用补丁一致（不含 confidence）。 */
    function toDraft(memory) {
      return {
        slug: memory.slug ?? memory.id ?? memory.name ?? '',
        title: memory.title ?? '',
        description: memory.description ?? '',
        type: memory.type ?? 'project',
        scope: memory.scope === 'global' ? 'global' : 'project',
        tags: Array.isArray(memory.tags) ? [...memory.tags] : [],
        body: memory.body ?? '',
      }
    }

    const sameDraft = (a, b) =>
      Boolean(a && b) &&
      a.slug === b.slug &&
      a.title === b.title &&
      a.description === b.description &&
      a.type === b.type &&
      a.scope === b.scope &&
      a.body === b.body &&
      a.tags.join('\u0000') === b.tags.join('\u0000')

    /* ------------------------------------------------------------ 对话框 */

    /**
     * 原生 <dialog>：需要 showModal() 才有背景遮罩与焦点环路，
     * 而样式表里的 `::backdrop` 也只对原生 dialog 生效。
     */
    let dialogSeq = 0

    function Dialog({ open, title, description, children, onCancel }) {
      const ref = useRef(null)
      // 同一页面有多个对话框，id 必须各不相同，aria-labelledby 才指得对
      const idRef = useRef(null)
      if (idRef.current === null) {
        dialogSeq += 1
        idRef.current = `wsm-dialog-title-${dialogSeq}`
      }

      useEffect(() => {
        const element = ref.current
        if (!element) return
        if (open && !element.open) {
          if (typeof element.showModal === 'function') element.showModal()
          else element.setAttribute('open', '')
        } else if (!open && element.open) {
          if (typeof element.close === 'function') element.close()
          else element.removeAttribute('open')
        }
      }, [open])

      return h(
        'dialog',
        {
          ref,
          className: 'wsm-dialog',
          'aria-labelledby': idRef.current,
          onCancel: (event) => {
            event.preventDefault()
            onCancel?.()
          },
        },
        h('h2', { id: idRef.current }, title),
        description ? h('p', null, description) : null,
        h('div', { className: 'wsm-dialog-actions' }, children),
      )
    }

    /* ------------------------------------------------------------ 标签区 */

    function TagEditor({ tags, disabled, error, onChange, onError }) {
      const [adding, setAdding] = useState(false)
      const [value, setValue] = useState('')
      const inputRef = useRef(null)

      useEffect(() => {
        if (adding) inputRef.current?.focus()
      }, [adding])

      const commit = (raw) => {
        const text = String(raw ?? '').trim()
        if (!text) {
          setAdding(false)
          return true
        }
        const normalized = normalizeTag(text)
        if (!normalized.ok) {
          onError(
            normalized.reason === 'comma'
              ? t('error.tagComma')
              : normalized.reason === 'bracket'
                ? t('error.tagBracket')
                : normalized.reason === 'too-long'
                  ? t('error.tagTooLong')
                  : '',
          )
          return false
        }
        if (tags.includes(normalized.tag)) {
          onError(t('error.tagDuplicate'))
          return false
        }
        if (tags.length >= 20) {
          onError(t('error.tooManyTags'))
          return false
        }
        onError('')
        onChange([...tags, normalized.tag])
        setValue('')
        setAdding(false)
        return true
      }

      return h(
        'div',
        { className: 'wsm-field wsm-tags-field' },
        h(
          'div',
          { className: 'wsm-tags', 'aria-label': t('field.tags') },
          h(
            'div',
            { className: 'wsm-tag-chips' },
            ...tags.map((tag) =>
              h(
                'span',
                { className: 'wsm-tag', key: tag },
                h('span', { title: tag }, tag),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled,
                    'aria-label': t('action.removeTag', { tag }),
                    onClick: () => onChange(tags.filter((item) => item !== tag)),
                  },
                  '×',
                ),
              ),
            ),
          ),
          adding
            ? h('input', {
                ref: inputRef,
                className: 'wsm-tag-input',
                value,
                placeholder: t('field.tagPlaceholder'),
                'aria-label': t('field.tagPlaceholder'),
                onChange: (event) => setValue(event.target.value),
                onKeyDown: (event) => {
                  if (isImeEvent(event)) return
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commit(value)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    setValue('')
                    setAdding(false)
                    onError('')
                  }
                },
                onBlur: () => {
                  if (!commit(value)) {
                    setAdding(false)
                    setValue('')
                  }
                },
              })
            : h(
                'button',
                {
                  type: 'button',
                  className: 'wsm-btn wsm-tag-add',
                  disabled,
                  onClick: () => setAdding(true),
                },
                `+ ${t('field.tagAdd')}`,
              ),
        ),
        error ? h('p', { className: 'wsm-error' }, error) : null,
      )
    }

    /* ---------------------------------------------------------- 正文编辑器 */

    /**
     * 行号 + 高亮层 + textarea 三件套。
     *
     * 为什么这么做：textarea 不能给局部文本上色，所以把同内容的 <pre> 垫在
     * 下面负责显示颜色，textarea 文字变透明只留光标——两边必须**像素对齐**，
     * 于是字体、行高、内边距、换行规则都写死在 CSS 同一个规则里。
     *
     * 换行后的物理行占多行高度，行号要按实际高度对齐，否则长段落会错位。
     */
    function CodeEditor({ value, disabled, onChange }) {
      const gutterRef = useRef(null)
      const highlightRef = useRef(null)
      const areaRef = useRef(null)
      const frameRef = useRef(0)

      const lines = useMemo(() => String(value ?? '').split('\n'), [value])

      const syncScroll = useCallback(() => {
        const area = areaRef.current
        if (!area) return
        if (highlightRef.current) {
          highlightRef.current.scrollTop = area.scrollTop
          highlightRef.current.scrollLeft = area.scrollLeft
        }
        if (gutterRef.current) {
          gutterRef.current.style.transform = `translateY(${-area.scrollTop}px)`
        }
      }, [])

      // 只在下一帧对齐行高，避免每次按键都强制同步布局
      useEffect(() => {
        if (frameRef.current) cancelAnimationFrame(frameRef.current)
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = 0
          const highlight = highlightRef.current
          const gutter = gutterRef.current
          const area = areaRef.current
          if (!highlight || !gutter || !area) return
          highlight.style.width = area.clientWidth ? `${area.clientWidth}px` : ''
          const rows = highlight.children
          const gutterRows = gutter.children
          const heights = Array.from(rows, (row) => row.getBoundingClientRect().height || 23)
          for (let i = 0; i < heights.length; i += 1) {
            if (gutterRows[i]) gutterRows[i].style.height = `${heights[i]}px`
          }
          syncScroll()
        })
        return () => {
          if (frameRef.current) {
            cancelAnimationFrame(frameRef.current)
            frameRef.current = 0
          }
        }
      }, [lines, syncScroll])

      return h(
        'div',
        { className: 'wsm-editor' },
        h(
          'div',
          { className: 'wsm-gutter', 'aria-hidden': 'true' },
          h(
            'div',
            { ref: gutterRef },
            ...lines.map((_, index) => h('div', { className: 'wsm-gutter-line', key: index }, index + 1)),
          ),
        ),
        h(
          'div',
          { className: 'wsm-code-area' },
          h('pre', {
            ref: highlightRef,
            className: 'wsm-code-highlight',
            'aria-hidden': 'true',
            dangerouslySetInnerHTML: {
              __html: lines
                .map((line) => `<span class="wsm-code-line">${line ? highlightLine(line) : '\u200b'}</span>`)
                .join(''),
            },
          }),
          h('textarea', {
            ref: areaRef,
            id: 'wsm-body-editor',
            className: 'wsm-body-editor',
            value,
            disabled,
            spellCheck: false,
            wrap: 'soft',
            'aria-label': t('field.content'),
            onScroll: syncScroll,
            onChange: (event) => onChange(event.target.value),
          }),
        ),
      )
    }

    /* -------------------------------------------------------------- 列表项 */

    function MemoryListItem({ memory, selected, dirty, tabIndex, disabled, onSelect }) {
      const description = selected && memory.draftDescription != null ? memory.draftDescription : memory.description
      const title = selected && memory.draftTitle != null ? memory.draftTitle : memory.title
      return h(
        'button',
        {
          type: 'button',
          className: 'wsm-item',
          role: 'option',
          'aria-selected': selected,
          tabIndex,
          disabled,
          'data-id': memory.id,
          onClick: () => onSelect(memory.id),
        },
        h('div', { className: 'wsm-item-title' }, title),
        h('div', { className: 'wsm-item-desc' }, description || ''),
        h(
          'div',
          { className: 'wsm-badges' },
          h('span', { className: `wsm-badge t-${memory.type}` }, typeLabel(memory.type)),
          // 收下后会进每轮常驻的 AGENTS.md：列表上就标出来。已确认条目都在按需库里（load 恒为 on-demand），不会出现
          memory.load === 'always' ? h('span', { className: 'wsm-badge' }, t('load.always')) : null,
          // 收下后动 AGENTS.md 的哪一章：带章号（且不是 newChapter）就是覆盖那一章，否则追加新章（与宿主 acceptPending 同口径）；
          // 悬停显示入队时那一章的标题
          memory.load === 'always'
            ? Number.isInteger(memory.chapter) && memory.chapter > 0 && memory.newChapter !== true
              ? h('span', { className: 'wsm-badge', title: memory.chapterTitle || undefined }, t('pending.replaceChapter', { chapter: memory.chapter }))
              : h('span', { className: 'wsm-badge' }, t('pending.newChapter'))
            : null,
          // 收下时会归档删除的旧记忆（只有草稿带 supersedes）
          supersedesText(memory) ? h('span', { className: 'wsm-badge' }, supersedesText(memory)) : null,
          selected && dirty ? h('span', { className: 'wsm-item-dirty' }, t('meta.unsavedShort')) : null,
          memory.scope === 'global' ? h('span', { className: 'wsm-badge t-global' }, t('scope.short')) : null,
        ),
      )
    }

    /* -------------------------------------------------------------- 详情区 */

    function MemoryDetail({
      memory,
      doc,
      isPending,
      layout,
      fullscreen,
      bodyView,
      fileOpen,
      onBodyView,
      onField,
      onBlurField,
      onToggleFullscreen,
      onToggleFile,
      onSlugInput,
      onSave,
      onCancel,
      onReject,
      onAccept,
      onPromote,
      onDelete,
      onBack,
      onTagError,
      tagError,
    }) {
      const draft = doc.draft
      const errors = doc.errors
      const titleRef = useRef(null)
      const descriptionRef = useRef(null)
      // 预览只在正文变化时重算；每次面板重渲染都重跑 Markdown 解析没有意义
      const previewHtml = useMemo(() => (bodyView === 'preview' ? renderMarkdown(draft.body) : ''), [bodyView, draft.body])

      // 标题/摘要用多行 textarea 自适应高度，长标题不截断
      const autoSize = useCallback((element) => {
        if (!element) return
        element.style.height = 'auto'
        element.style.height = `${element.scrollHeight || 28}px`
      }, [])

      useEffect(() => {
        autoSize(titleRef.current)
        autoSize(descriptionRef.current)
      }, [draft.title, draft.description, layout, fullscreen, autoSize])

      const fieldError = (key) =>
        errors[key] ? h('p', { className: 'wsm-error', id: `wsm-${key}-error` }, errors[key]) : null

      const errorProp = (key) => (errors[key] ? { 'aria-invalid': 'true', 'aria-describedby': `wsm-${key}-error` } : {})

      // 待确认草稿只能收下或丢弃：宿主没有「改草稿」的接口，编辑了也存不下来
      const editable = !doc.saving && !isPending
      // 按条目已保存的位置判断（不看下拉里未保存的值）：全局库里的，或宿主标了 promotable 的旧条目
      const canPromote = !isPending && (memory.scope === 'global' || memory.promotable === true)
      // 已确认条目所在的库；待确认草稿实际放在本项目的队列里，仍按本项目显示
      const inGlobal = !isPending && memory.scope === 'global'
      // 标题/摘要是 frontmatter 单行字段：拦住回车（输入法组字中的回车除外），粘贴的换行也压平
      const blockEnter = (event) => {
        if (event.key === 'Enter' && !isImeEvent(event)) event.preventDefault()
      }

      return h(
        'section',
        { className: 'wsm-detail-document', 'aria-label': t('detail.breadcrumb') },
        h(
          'div',
          { className: 'wsm-detail-main' },
          h(
            'div',
            { className: 'wsm-doc-head' },
            h(
              'div',
              { className: 'wsm-crumbs' },
              h('button', { type: 'button', className: 'wsm-text-btn', onClick: onBack }, `‹ ${t('action.back')}`),
            ),
            h(
              'div',
              { className: 'wsm-field wsm-title-field' },
              h('label', { className: 'wsm-sr-only', htmlFor: 'wsm-title' }, t('field.title')),
              h('textarea', {
                ref: titleRef,
                id: 'wsm-title',
                className: 'wsm-input wsm-detail-title',
                value: draft.title,
                rows: 1,
                placeholder: t('field.title'),
                spellCheck: false,
                disabled: !editable,
                ...errorProp('title'),
                onChange: (event) => onField('title', singleLine(event.target.value)),
                onKeyDown: blockEnter,
                onBlur: () => onBlurField('title'),
              }),
              fieldError('title'),
            ),
            h(
              'div',
              { className: 'wsm-field wsm-description-field' },
              h('label', { className: 'wsm-sr-only', htmlFor: 'wsm-description' }, t('field.description')),
              h('textarea', {
                ref: descriptionRef,
                id: 'wsm-description',
                className: 'wsm-input wsm-description',
                value: draft.description,
                rows: 1,
                placeholder: t('field.descriptionPlaceholder'),
                spellCheck: false,
                disabled: !editable,
                ...errorProp('description'),
                onChange: (event) => onField('description', singleLine(event.target.value)),
                onKeyDown: blockEnter,
                onBlur: () => onBlurField('description'),
              }),
              fieldError('description'),
            ),
            h(
              'div',
              { className: 'wsm-property-row' },
              h(
                'div',
                { className: 'wsm-field' },
                h('label', { className: 'wsm-sr-only', htmlFor: 'wsm-type' }, t('field.type')),
                h(
                  'select',
                  {
                    id: 'wsm-type',
                    className: 'wsm-select',
                    value: draft.type,
                    disabled: !editable,
                    ...errorProp('type'),
                    onChange: (event) => onField('type', event.target.value),
                  },
                  ...TYPES.map((type) => h('option', { key: type, value: type }, typeLabel(type))),
                ),
                fieldError('type'),
              ),
              h(
                'div',
                { className: 'wsm-field' },
                h('label', { className: 'wsm-sr-only', htmlFor: 'wsm-scope' }, t('field.scope')),
                h(
                  'select',
                  {
                    id: 'wsm-scope',
                    className: 'wsm-select',
                    value: draft.scope,
                    disabled: !editable,
                    ...errorProp('scope'),
                    onChange: (event) => onField('scope', event.target.value),
                  },
                  h('option', { value: 'project' }, t('scope.project')),
                  h('option', { value: 'global' }, t('scope.global')),
                ),
                fieldError('scope'),
              ),
              // 草稿收下后的加载方式；与上面两个下拉一样在待确认页只读。已确认条目都在按需库里，不显示
              isPending
                ? h(
                    'div',
                    { className: 'wsm-field' },
                    h('label', { className: 'wsm-sr-only', htmlFor: 'wsm-load' }, t('field.load')),
                    h(
                      'select',
                      { id: 'wsm-load', className: 'wsm-select', value: memory.load === 'always' ? 'always' : 'on-demand', disabled: true },
                      h('option', { value: 'on-demand' }, t('load.on-demand')),
                      h('option', { value: 'always' }, t('load.always')),
                    ),
                  )
                : null,
              // 去向旁边：收下时会归档删除的旧记忆（与列表卡片同一个标签）
              isPending && supersedesText(memory) ? h('span', { className: 'wsm-badge' }, supersedesText(memory)) : null,
              // 有来源就显示来源（及证据原文）；没有来源但有旧 confidence 的才显示原来那一行
              sourceKey(memory)
                ? h(
                    'p',
                    { className: memory.evidence ? 'wsm-confidence wsm-evidence' : 'wsm-confidence' },
                    memory.evidence ? `${t(sourceKey(memory))} · “${memory.evidence}”` : t(sourceKey(memory)),
                  )
                : Number.isFinite(memory.confidence)
                  ? h(
                      'p',
                      { className: 'wsm-confidence', title: t('confidence.readonly') },
                      `${t('confidence.label')} ${memory.confidence.toFixed(2)} · ${confidenceTone(
                        memory.confidence,
                      )} · ${t('confidence.readonlyShort')}`,
                    )
                  : null,
            ),
            h(TagEditor, {
              tags: draft.tags,
              disabled: !editable,
              error: errors.tags ?? tagError,
              onChange: (tags) => onField('tags', tags),
              onError: onTagError,
            }),
          ),

          h(
            'div',
            { className: 'wsm-editor-shell' },
            h(
              'div',
              { className: 'wsm-editor-head' },
              h(
                'div',
                { className: 'wsm-editor-tabs', role: 'tablist', 'aria-label': t('field.content') },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'wsm-text-btn',
                    role: 'tab',
                    'aria-selected': bodyView === 'edit',
                    tabIndex: bodyView === 'edit' ? 0 : -1,
                    onClick: () => onBodyView('edit'),
                  },
                  t('editor.edit'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'wsm-text-btn',
                    role: 'tab',
                    'aria-selected': bodyView === 'preview',
                    tabIndex: bodyView === 'preview' ? 0 : -1,
                    onClick: () => onBodyView('preview'),
                  },
                  t('editor.preview'),
                ),
              ),
              h('span', { className: 'wsm-editor-format' }, 'Markdown'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wsm-btn wsm-btn-small',
                  'aria-pressed': fullscreen,
                  onClick: onToggleFullscreen,
                },
                fullscreen ? t('action.exitFullscreen') : t('action.fullscreen'),
              ),
            ),
            errors.body ? h('p', { className: 'wsm-error wsm-body-error' }, errors.body) : null,
            bodyView === 'edit'
              ? h(CodeEditor, { value: draft.body, disabled: !editable, onChange: (body) => onField('body', body) })
              : h(
                  'div',
                  { className: 'wsm-preview', tabIndex: 0 },
                  h('article', { dangerouslySetInnerHTML: { __html: previewHtml } }),
                ),
          ),
        ),

        h(
          'footer',
          { className: 'wsm-footer' },
          h(
            'div',
            { className: 'wsm-footer-meta' },
            h(
              'button',
              {
                type: 'button',
                className: 'wsm-file-trigger',
                'aria-haspopup': 'dialog',
                'aria-expanded': fileOpen,
                onClick: onToggleFile,
              },
              h('span', { className: 'wsm-file-location' }, inGlobal ? t('scope.global') : t('file.location')),
              h('span', { className: 'wsm-file-slash', 'aria-hidden': 'true' }, '/'),
              h('span', { className: 'file' }, `${draft.slug}.md`),
            ),
            h('time', { className: 'wsm-modified' }, `${t('meta.updated')} ${formatTime(memory.modified)}`),
          ),
          h(
            'div',
            { className: 'wsm-footer-actions' },
            h(
              'span',
              {
                className: 'wsm-unsaved',
                'data-state': doc.status || undefined,
                role: 'status',
                'aria-live': 'polite',
              },
              doc.saving ? t('state.saving') : doc.status === 'dirty' ? t('meta.unsaved') : doc.status === 'error' ? t('state.saveFailed') : doc.status === 'success' ? t('state.saved') : '',
            ),
            // 「写入 AGENTS.md」常驻底部，与取消/保存并列——用户明确要求过，不能藏进菜单
            canPromote
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'wsm-btn wsm-promote',
                    disabled: doc.saving,
                    title: t('promote.hint'),
                    onClick: onPromote,
                  },
                  t('action.promote'),
                )
              : null,
            isPending
              ? h(
                  'button',
                  { type: 'button', className: 'wsm-btn', disabled: doc.saving, onClick: onReject },
                  t('action.reject'),
                )
              : h(
                  'button',
                  { type: 'button', className: 'wsm-btn danger', disabled: doc.saving, onClick: onDelete },
                  t('action.delete'),
                ),
            // 待确认项用「收下/丢弃」两个按钮就够了，不需要「取消」；
            // 已确认项才需要「取消」来丢弃未保存的编辑。
            isPending
              ? null
              : h(
                  'button',
                  { type: 'button', className: 'wsm-btn', disabled: doc.saving, onClick: onCancel },
                  t('action.cancel'),
                ),
            isPending
              ? h(
                  'button',
                  { type: 'button', className: 'wsm-btn primary', disabled: doc.saving, onClick: onAccept },
                  t('action.accept'),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'wsm-btn primary',
                    disabled: doc.saving,
                    title: t('action.saveHint'),
                    onClick: onSave,
                  },
                  t('action.save'),
                ),
          ),
          doc.saveError ? h('div', { className: 'wsm-save-error', role: 'alert' }, doc.saveError) : null,

          h(
            'section',
            {
              className: 'wsm-file-popover',
              role: 'dialog',
              'aria-label': t('file.title'),
              hidden: !fileOpen,
            },
            h(
              'div',
              { className: 'wsm-popover-head' },
              h('h2', null, t('file.title')),
              h('button', { type: 'button', className: 'wsm-text-btn', onClick: onToggleFile }, t('action.close')),
            ),
            h(
              'div',
              { className: 'wsm-field' },
              h('label', { htmlFor: 'wsm-slug' }, t('field.slug')),
              h(
                'div',
                { className: 'wsm-slug-field' },
                h('input', {
                  id: 'wsm-slug',
                  className: 'wsm-input mono',
                  value: draft.slug,
                  spellCheck: false,
                  autoComplete: 'off',
                  disabled: !editable,
                  ...errorProp('slug'),
                  onChange: (event) => onSlugInput(event.target.value),
                  onBlur: () => onBlurField('slug'),
                }),
                h('span', null, '.md'),
              ),
              fieldError('slug'),
            ),
            h(
              'dl',
              { className: 'wsm-file-facts' },
              h('dt', null, t('file.storage')),
              h('dd', null, inGlobal ? t('scope.global') : t('file.storageValue')),
              h('dt', null, t('meta.updated')),
              h('dd', null, formatTime(memory.modified)),
            ),
          ),
        ),
      )
    }



    /* ------------------------------------------------- 全局 AGENTS.md 面板 */

    /**
     * 「全局」页：直接读写 ~/.dsh/AGENTS.md 的章。
     *
     * 与记忆库不同——这里没有 frontmatter、标签、向量：AGENTS.md 是每轮注入的纯
     * Markdown 指令文件。所以只做三件事：看、改、增删章。
     * 每章 = `## N. 标题` + 其下的 `### N.M` 子节整体，删章不会留下孤儿子节。
     */
    function AgentsPane({ layout, onToast, onChanged, reloadToken, leaveRef }) {
      const [doc, setDoc] = useState({ loading: true, error: '', path: '', bytes: 0, sections: [] })
      const [selected, setSelected] = useState(null)
      const [draft, setDraft] = useState(null)
      const [baseline, setBaseline] = useState(null)
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const [view, setView] = useState('list')
      const [bodyView, setBodyView] = useState('edit')
      const [pendingDelete, setPendingDelete] = useState(null)
      const [guard, setGuard] = useState(null)
      const [addOpen, setAddOpen] = useState(false)
      const [addError, setAddError] = useState('')
      const [newTitle, setNewTitle] = useState('')

      const dirty = Boolean(draft && baseline && (draft.title !== baseline.title || draft.body !== baseline.body))
      // 异步回调里要读「现在」的选中与基线，不能用发起请求时的闭包
      const live = useRef(null)
      live.current = { selected, baseline, dirty }
      const loadSeq = useRef(0)
      const previewHtml = useMemo(
        () => (bodyView === 'preview' && draft ? renderMarkdown(draft.body) : ''),
        [bodyView, draft?.body],
      )

      const beginEdit = useCallback((section, index, keepList) => {
        setSelected(index)
        setDraft({ title: section.title, body: section.body })
        setBaseline({ title: section.title, body: section.body })
        setError('')
        setBodyView('edit')
        if (!keepList) setView('detail')
      }, [])

      /**
       * 读取章节。章是靠「位置」寻址的，文件被外部改动后位置会变：
       * options.remap 时按用户看到的标题找回正在编辑的那一章，找不到就放弃选中并提示。
       */
      const load = useCallback(
        async (options = {}) => {
          loadSeq.current += 1
          const seq = loadSeq.current
          try {
            const response = await fetch(AGENTS_SECTIONS_URL)
            const payload = await response.json().catch(() => ({}))
            if (!payload.ok) throw new Error(reasonText(payload, t('error.load')))
            const next = {
              loading: false,
              error: '',
              path: payload.path,
              bytes: payload.bytes,
              sections: Array.isArray(payload.sections) ? payload.sections : [],
            }
            // 已被更新的读取取代：数据还给调用方，但不写进状态
            if (seq !== loadSeq.current) return next
            setDoc(next)
            const { selected: at, baseline: base, dirty: edited } = live.current
            if (options.remap && base) {
              const index = locateSection(next.sections, base.title, at)
              if (index < 0) {
                setSelected(null)
                setError(t('reason.section-moved'))
              } else if (!edited) beginEdit(next.sections[index], index, true)
              else if (index !== at) setSelected(index)
            }
            return next
          } catch (err) {
            if (seq === loadSeq.current) setDoc((prev) => ({ ...prev, loading: false, error: err?.message ?? String(err) }))
            return null
          }
        },
        [beginEdit],
      )

      // 首次挂载读一次；顶部「刷新」递增 reloadToken 时再读一次（并保住正在编辑的章）
      useEffect(() => {
        void load({ remap: reloadToken > 0 }).then((next) => {
          if (next && reloadToken > 0) onToast(t('state.refreshed'))
        })
      }, [load, reloadToken])

      // 首次载入自动选第一章；单栏时停在列表，不强行跳转
      useEffect(() => {
        if (doc.loading || draft || doc.sections.length === 0) return
        beginEdit(doc.sections[0], 0, layout === 'single')
      }, [doc, draft, layout, beginEdit])

      const post = async (url, body) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        return response.json().catch(() => ({}))
      }

      /** 失败响应 → 提示。章被挪动时顺手重读，让界面回到文件的真实状态。 */
      const failText = (payload) => {
        if (payload?.reason === 'section-moved') void load({ remap: true })
        return reasonText(payload, t('error.save'))
      }

      const save = async () => {
        if (!draft || selected === null || saving) return false
        if (!draft.title.trim()) {
          setError(t('error.titleRequired'))
          return false
        }
        const at = selected
        setSaving(true)
        setError('')
        try {
          const payload = await post(AGENTS_SAVE_SECTION_URL, {
            index: at,
            expectedTitle: bareTitle(baseline?.title ?? draft.title),
            title: draft.title,
            body: draft.body,
          })
          if (!payload.ok) {
            setError(failText(payload))
            return false
          }
          const next = await load()
          void onChanged?.()
          onToast(t('agents.saved'))
          const current = next?.sections?.[at]
          if (current) beginEdit(current, at, true)
          return true
        } catch (err) {
          setError(err?.message ?? String(err))
          return false
        } finally {
          setSaving(false)
        }
      }

      const remove = async (target) => {
        setSaving(true)
        setError('')
        try {
          const payload = await post(AGENTS_DELETE_SECTION_URL, {
            index: target.index,
            expectedTitle: bareTitle(target.title),
          })
          if (!payload.ok) {
            setError(failText(payload))
            return
          }
          await load()
          void onChanged?.()
          setDraft(null)
          setBaseline(null)
          setSelected(null)
          setView('list')
          onToast(t('agents.deleted'))
        } catch (err) {
          setError(err?.message ?? String(err))
        } finally {
          setSaving(false)
        }
      }

      const add = async () => {
        const title = newTitle.trim()
        if (!title || saving) return
        setSaving(true)
        setAddError('')
        try {
          const payload = await post(AGENTS_ADD_SECTION_URL, { title, body: '' })
          if (!payload.ok) {
            setAddError(failText(payload))
            return
          }
          const next = await load()
          void onChanged?.()
          setAddOpen(false)
          setNewTitle('')
          onToast(t('agents.added'))
          const last = next ? next.sections.length - 1 : -1
          if (next && last >= 0) beginEdit(next.sections[last], last, layout === 'single')
        } catch (err) {
          setAddError(err?.message ?? String(err))
        } finally {
          setSaving(false)
        }
      }

      // 离开当前章（换章 / 新增章 / 切回记忆库）之前的未保存守卫
      const requestLeave = (action) => {
        if (!dirty) action()
        else setGuard({ action })
      }

      // 把守卫入口交给面板：切到「记忆库」页签时也要过这一关
      useEffect(() => {
        if (!leaveRef) return undefined
        leaveRef.current = requestLeave
        return () => {
          if (leaveRef.current === requestLeave) leaveRef.current = null
        }
      })

      const onPaneKeyDown = (event) => {
        if (!(event.ctrlKey || event.metaKey) || String(event.key).toLowerCase() !== 's') return
        if (isImeEvent(event) || !dirty || saving || selected === null || guard || addOpen || pendingDelete) return
        event.preventDefault()
        void save()
      }

      const listPane = h(
        'div',
        { className: 'wsm-agents-list' },
        h(
          'div',
          { className: 'wsm-list-tools' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 0 8px' } },
            h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, t('agents.chapters', { count: doc.sections.length })),
            h('div', { style: { flex: '1 1 auto' } }),
            h(
              'button',
              {
                type: 'button',
                className: 'wsm-btn wsm-btn-small',
                disabled: saving,
                onClick: () =>
                  requestLeave(() => {
                    setAddError('')
                    setAddOpen(true)
                  }),
              },
              t('agents.add'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'wsm-list-scroll' },
          doc.loading
            ? h('div', { className: 'wsm-empty' }, t('state.loading'))
            : doc.error
              ? h('div', { className: 'wsm-empty', role: 'alert' }, `${t('error.load')}: ${doc.error}`)
              : doc.sections.length === 0
                ? h('div', { className: 'wsm-empty' }, t('agents.empty'))
                : doc.sections.map((section, index) =>
                    h(
                      'button',
                      {
                        key: `${section.title}-${index}`,
                        type: 'button',
                        className: 'wsm-item',
                        'aria-selected': index === selected,
                        disabled: saving,
                        onClick: () => {
                          if (index === selected && draft) {
                            setView('detail')
                            return
                          }
                          requestLeave(() => beginEdit(section, index, false))
                        },
                      },
                      h('div', { className: 'wsm-item-title' }, section.title),
                      h(
                        'div',
                        { className: 'wsm-badges' },
                        h('span', { className: 'wsm-badge' }, `${(section.bytes / 1024).toFixed(1)} KB`),
                      ),
                    ),
                  ),
        ),
      )

      const detailPane = h(
        'div',
        { className: 'wsm-agents-detail' },
        draft
          ? h(
              'div',
              { className: 'wsm-detail-main' },
              h(
                'div',
                { className: 'wsm-doc-head' },
                h(
                  'div',
                  { className: 'wsm-crumbs' },
                  h('button', { type: 'button', className: 'wsm-text-btn', onClick: () => setView('list') }, `‹ ${t('action.back')}`),
                ),
                h(
                  'div',
                  { className: 'wsm-field' },
                  h('label', { className: 'wsm-sr-only', htmlFor: 'wsm-chapter-title' }, t('field.title')),
                  h('input', {
                    id: 'wsm-chapter-title',
                    className: 'wsm-input',
                    style: { fontSize: '17px' },
                    value: draft.title,
                    disabled: saving,
                    onChange: (event) => setDraft({ ...draft, title: singleLine(event.target.value) }),
                  }),
                ),
              ),
              h(
                'div',
                { className: 'wsm-editor-shell' },
                h(
                  'div',
                  { className: 'wsm-editor-head' },
                  h(
                    'div',
                    { className: 'wsm-editor-tabs', role: 'tablist' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wsm-text-btn',
                        'aria-selected': bodyView === 'edit',
                        onClick: () => setBodyView('edit'),
                      },
                      t('editor.edit'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wsm-text-btn',
                        'aria-selected': bodyView === 'preview',
                        onClick: () => setBodyView('preview'),
                      },
                      t('editor.preview'),
                    ),
                  ),
                  h('span', { className: 'wsm-editor-format' }, 'Markdown'),
                ),
                bodyView === 'edit'
                  ? h(CodeEditor, { value: draft.body, disabled: saving, onChange: (body) => setDraft({ ...draft, body }) })
                  : h(
                      'div',
                      { className: 'wsm-preview', tabIndex: 0 },
                      h('article', { dangerouslySetInnerHTML: { __html: previewHtml } }),
                    ),
              ),
            )
          : h('div', { className: 'wsm-detail-empty' }, t('detail.choose')),

        h(
          'footer',
          { className: 'wsm-footer' },
          h(
            'div',
            { className: 'wsm-footer-meta' },
            h('span', { className: 'file', style: { fontFamily: MONO, fontSize: '11px' } }, doc.path || 'AGENTS.md'),
            h('span', { style: { display: 'block', marginTop: '4px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, t('agents.sizeNote', { kb: (doc.bytes / 1024).toFixed(1) })),
          ),
          h(
            'div',
            { className: 'wsm-footer-actions' },
            h('span', { className: 'wsm-unsaved', style: { marginRight: 'auto' } }, error ? error : dirty ? t('meta.unsaved') : ''),
            draft
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'wsm-btn danger',
                    disabled: saving || selected === null,
                    // 确认框和请求都用「用户看到的」标题（基线），而不是编辑到一半的草稿
                    onClick: () => setPendingDelete({ index: selected, title: baseline?.title ?? draft.title }),
                  },
                  t('action.delete'),
                )
              : null,
            h(
              'button',
              { type: 'button', className: 'wsm-btn primary', disabled: saving || !dirty || selected === null, onClick: save },
              saving ? t('state.saving') : t('agents.save'),
            ),
          ),
        ),
      )

      return h(
        'div',
        { className: 'wsm-agents-pane', 'data-view': view, onKeyDown: onPaneKeyDown },
        listPane,
        detailPane,

        h(
          Dialog,
          {
            open: Boolean(guard),
            title: t('guard.title'),
            description: t('agents.guardDescription'),
            onCancel: () => setGuard(null),
          },
          h('button', { type: 'button', className: 'wsm-btn', onClick: () => setGuard(null) }, t('guard.continue')),
          h(
            'button',
            {
              type: 'button',
              className: 'wsm-btn',
              onClick: () => {
                const action = guard?.action
                setGuard(null)
                if (baseline) setDraft({ ...baseline })
                action?.()
              },
            },
            t('guard.discard'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wsm-btn primary',
              disabled: saving,
              onClick: async () => {
                const action = guard?.action
                const saved = await save()
                setGuard(null)
                // 保存失败就停在原地（错误显示在底栏）：既不换章，也不离开
                if (saved) action?.()
              },
            },
            t('guard.save'),
          ),
        ),

        h(
          Dialog,
          {
            open: Boolean(pendingDelete),
            title: t('agents.confirmDeleteTitle'),
            description: t('agents.confirmDelete', { title: pendingDelete?.title ?? '' }),
            onCancel: () => setPendingDelete(null),
          },
          h('button', { type: 'button', className: 'wsm-btn', onClick: () => setPendingDelete(null) }, t('action.cancel')),
          h(
            'button',
            {
              type: 'button',
              className: 'wsm-btn primary',
              onClick: () => {
                const target = pendingDelete
                setPendingDelete(null)
                if (target) void remove(target)
              },
            },
            t('confirm.deleteOk'),
          ),
        ),

        h(
          Dialog,
          {
            open: addOpen,
            title: t('agents.add'),
            description: '',
            onCancel: () => setAddOpen(false),
          },
          h('input', {
            className: 'wsm-input',
            placeholder: t('agents.newTitle'),
            value: newTitle,
            autoFocus: true,
            onChange: (event) => setNewTitle(singleLine(event.target.value)),
            onKeyDown: (event) => {
              // 输入法组字时的回车是在确认候选词，不是提交
              if (event.key === 'Enter' && !isImeEvent(event)) void add()
            },
            style: { marginBottom: '16px' },
          }),
          // 失败原因要显示在对话框里：底栏被遮罩盖住，窄屏下详情栏还是隐藏的
          addError ? h('p', { className: 'wsm-error', role: 'alert', style: { flex: '0 0 100%', margin: '0 0 12px' } }, addError) : null,
          h('button', { type: 'button', className: 'wsm-btn', onClick: () => setAddOpen(false) }, t('action.cancel')),
          h('button', { type: 'button', className: 'wsm-btn primary', disabled: saving, onClick: add }, t('action.confirm')),
        ),
      )
    }

    /* ---------------------------------------------------------------- 面板 */

    /** 单栏/双栏切换阈值：低于它一次只显示一栏（详情替换列表）。 */
    const SINGLE_MAX_WIDTH = 780

    // id：这份草稿属于哪条记忆。异步响应回来时靠它判断「用户是不是已经切走了」
    const EMPTY_DOC = { id: null, draft: null, baseline: null, errors: {}, saving: false, status: '', saveError: '' }

    function MemoryPanel({ sessionId }) {
      const [data, setData] = useState({ loading: true, error: null, root: '', memories: [], pending: [], pendingEnabled: false })
      // 作用域：project = 本项目记忆库；global = 全局 AGENTS.md
      const [scope, setScope] = useState('project')
      const [tab, setTab] = useState('confirmed')
      const [query, setQuery] = useState('')
      const [selectedId, setSelectedId] = useState(null)
      const [doc, setDoc] = useState(EMPTY_DOC)
      const [view, setView] = useState('list')
      const [fullscreen, setFullscreen] = useState(false)
      const [bodyView, setBodyView] = useState('edit')
      const [fileOpen, setFileOpen] = useState(false)
      const [tagError, setTagError] = useState('')
      const [toast, setToast] = useState('')
      const [guard, setGuard] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const [notice, setNotice] = useState(null)
      const [agents, setAgents] = useState(null)
      const [editors, setEditors] = useState([])
      const [agentsReload, setAgentsReload] = useState(0)
      const [editorId, setEditorId] = useState(() => {
        try {
          return window.localStorage?.getItem('dsh-workspace-memory:editor') ?? ''
        } catch {
          return ''
        }
      })

      const rootRef = useRef(null)
      const [width, setWidth] = useState(0)
      const docRef = useRef(EMPTY_DOC)
      const toastTimer = useRef(0)
      const loadSeq = useRef(0)
      const selectedIdRef = useRef(null)
      const agentsLeaveRef = useRef(null)

      docRef.current = doc
      selectedIdRef.current = selectedId

      // 渲染期算出的「脏」，给 effect 当依赖；异步回调里读最新状态用下面的 isDirty()
      const dirty = Boolean(doc.draft && doc.baseline && !sameDraft(doc.draft, doc.baseline))

      // 没有草稿时不算「脏」——否则面板打开后永远不会自动选中第一条
      const isDirty = useCallback(() => {
        const current = docRef.current
        if (!current.draft || !current.baseline) return false
        return !sameDraft(current.draft, current.baseline)
      }, [])

      const showToast = useCallback((message) => {
        setToast(message)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => {
          toastTimer.current = 0
          setToast('')
        }, 2200)
      }, [])

      useEffect(
        () => () => {
          if (toastTimer.current) clearTimeout(toastTimer.current)
        },
        [],
      )

      /* ---- 容器宽度 → 单栏/双栏 ---- */
      useEffect(() => {
        const element = rootRef.current
        if (!element) return
        const measure = () => setWidth(element.getBoundingClientRect().width || 0)
        measure()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      const layout = width && width < SINGLE_MAX_WIDTH ? 'single' : 'split'

      const confirmed = data.memories
      const pending = data.pending
      const source = tab === 'pending' ? pending : confirmed
      const visible = useMemo(() => source.filter((memory) => matchesQuery(memory, query)), [source, query])
      const selected = visible.find((memory) => memory.id === selectedId) ?? null

      /* ---- 打开一条记忆作为编辑基线 ---- */
      const beginEdit = useCallback((memory) => {
        if (!memory) {
          setDoc(EMPTY_DOC)
          return
        }
        const draft = toDraft(memory)
        setDoc({ id: memory.id, draft, baseline: { ...draft, tags: [...draft.tags] }, errors: {}, saving: false, status: '', saveError: '' })
        setTagError('')
        setBodyView('edit')
        setFileOpen(false)
      }, [])

      /* ---- 列表加载：有未保存修改时绝不重建草稿 ---- */
      const load = useCallback(
        async (options = {}) => {
          const { silent = false } = options
          // 每次读取领一个序号：先发后到的旧响应不能盖掉新响应
          loadSeq.current += 1
          const seq = loadSeq.current
          if (!sessionId) {
            setData((prev) => ({ ...prev, loading: false, error: t('error.noSession') }))
            return null
          }
          if (!silent) setData((prev) => ({ ...prev, loading: true, error: null }))
          try {
            const response = await fetch(`${LIST_URL}?session=${encodeURIComponent(sessionId)}`, {
              headers: { accept: 'application/json' },
            })
            const payload = await response.json().catch(() => ({}))
            if (!response.ok || !payload.ok) throw new Error(reasonText(payload, `HTTP ${response.status}`))
            const next = {
              loading: false,
              error: null,
              root: payload.root ?? '',
              memories: Array.isArray(payload.memories) ? payload.memories : [],
              pending: Array.isArray(payload.pending) ? payload.pending : [],
              pendingEnabled: Boolean(payload.pendingEnabled),
            }
            if (seq === loadSeq.current) setData(next)
            return next
          } catch (error) {
            // 静默刷新失败不该把已有的列表换成报错（保存其实已经成功了）
            if (seq === loadSeq.current && !silent) {
              setData((prev) => ({ ...prev, loading: false, error: error?.message ?? String(error) }))
            }
            return null
          }
        },
        [sessionId],
      )

      useEffect(() => {
        void load()
      }, [load])

      // 选中项失效时回落到第一条；未保存时不自动跳走（守卫在交互处处理）。
      // 选中项消失后窄屏的详情页没有东西可看，也没有返回键，必须回到列表。
      useEffect(() => {
        if (selectedId !== null && !visible.some((memory) => memory.id === selectedId)) setView('list')
        if (dirty) return
        if (visible.length === 0) {
          setSelectedId(null)
          setDoc(EMPTY_DOC)
          return
        }
        if (!visible.some((memory) => memory.id === selectedId)) setSelectedId(visible[0].id)
      }, [visible, selectedId, dirty])

      // 选中的记录变了（或草稿属于别的记忆）且没有未保存修改 → 用最新数据重建基线
      useEffect(() => {
        if (!selected || dirty) return
        if (doc.id !== selected.id || !doc.baseline || !sameDraft(toDraft(selected), doc.baseline)) {
          beginEdit(selected)
        }
      }, [selected, dirty, doc.id, doc.baseline, beginEdit])

      /* ---- 编辑器字段 ---- */
      const setField = useCallback((field, value) => {
        setDoc((prev) => {
          if (!prev.draft) return prev
          const draft = { ...prev.draft, [field]: value }
          if (field === 'tags') draft.tags = value
          return { ...prev, draft, status: 'dirty', saveError: '' }
        })
        if (field !== 'tags') setTagError('')
      }, [])

      const blurField = useCallback((field) => {
        setDoc((prev) => {
          if (!prev.draft) return prev
          const fieldErrors = validateDraft(prev.draft)
          const errors = { ...prev.errors }
          if (fieldErrors[field]) errors[field] = fieldErrors[field]
          else delete errors[field]
          return { ...prev, errors }
        })
      }, [])

      /* ---- 保存：真实接口，禁止乐观成功 ---- */
      const save = useCallback(async () => {
        const current = docRef.current
        // 待确认草稿没有保存接口（宿主只认已入库的 id），只能收下或丢弃
        if (!current.draft || !current.id || current.saving || tab === 'pending') return false
        // 保存目标是这份草稿所属的记忆，不能用草稿里的 slug 反查——改 slug 会换 id
        const targetId = current.id

        const fieldErrors = validateDraft(current.draft)
        if (Object.keys(fieldErrors).length > 0) {
          setDoc((prev) => ({ ...prev, errors: fieldErrors, status: 'dirty' }))
          // 文件名只在「文件信息」弹层里改，它的错误必须让用户看得见
          if (fieldErrors.slug) setFileOpen(true)
          return false
        }

        setDoc((prev) => ({ ...prev, saving: true, status: '', saveError: '', errors: {} }))
        let landedId = targetId
        try {
          const response = await fetch(`${SAVE_URL}?session=${encodeURIComponent(sessionId)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: targetId,
              // 条目现在所在的库（基线 = 最近一次保存后的状态）；patch.scope 与它不同时宿主会把条目移到另一个库
              scope: current.baseline?.scope,
              patch: {
                slug: current.draft.slug,
                title: current.draft.title,
                description: current.draft.description,
                type: current.draft.type,
                scope: current.draft.scope,
                tags: current.draft.tags,
                body: current.draft.body,
              },
            }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || !payload.ok) {
            const errors = Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === 'string' && item) : []
            // 认得的原因码先翻成人话、宿主的细节附在后面；否则 partially-saved 这类同时带 errors 的失败只会露出宿主原文
            const known = typeof payload.reason === 'string' && KNOWN_REASONS.includes(payload.reason)
            const message = known
              ? [reasonText(payload, t('error.save')), ...errors].join('\n')
              : errors.length
                ? errors.join('\n')
                : reasonText(payload, t('error.save'))
            // 失败但已经换了库（partially-saved）：条目现在在 payload.scope 那个库。基线的所在库跟着改，
            // 下次保存才不会发到旧库；其余字段没存上，草稿保持未保存状态，用户可以直接再存一次
            const movedTo = payload.moved === true && (payload.scope === 'global' || payload.scope === 'project') ? payload.scope : null
            setDoc((prev) =>
              prev.id === targetId
                ? {
                    ...prev,
                    status: 'error',
                    saveError: message,
                    ...(movedTo && prev.baseline ? { baseline: { ...prev.baseline, scope: movedTo } } : {}),
                  }
                : prev,
            )
            if (movedTo) void load({ silent: true })
            return false
          }

          // 宿主回读后的记忆就是真值：改 slug 时它带着新 id，不用再按标题去列表里找
          const memory = payload.memory ?? null
          landedId = memory?.id ?? targetId
          if (memory) setData((prev) => replaceMemory(prev, payload.previousId ?? targetId, memory))
          // 保存期间用户若已切到别的记忆，响应只更新列表，不碰当前文档
          setDoc((prev) => {
            if (prev.id !== targetId) return prev
            const saved = memory ? toDraft(memory) : prev.draft
            return {
              ...prev,
              id: landedId,
              draft: saved,
              baseline: { ...saved, tags: [...saved.tags] },
              errors: {},
              saving: false,
              status: 'success',
              saveError: '',
            }
          })
          if (landedId !== targetId && selectedIdRef.current === targetId) setSelectedId(landedId)
          // 排序可能因改名或换库而变；回读不到记忆时也要靠整表刷新对齐
          if (landedId !== targetId || !memory || payload.moved) void load({ silent: true })
          showToast(t('state.saved'))
          return true
        } catch (error) {
          setDoc((prev) =>
            prev.id === targetId ? { ...prev, status: 'error', saveError: error?.message ?? String(error) } : prev,
          )
          return false
        } finally {
          // 无论成败都要解除「保存中」，否则整个面板会被锁死
          setDoc((prev) => (prev.saving && (prev.id === targetId || prev.id === landedId) ? { ...prev, saving: false } : prev))
        }
      }, [tab, sessionId, load, showToast])

      /* ---- 未保存守卫：所有「离开当前编辑」的入口都走这里 ---- */
      const requestTransition = useCallback(
        (action, kind = 'nav') => {
          if (!isDirty()) {
            action()
            return
          }
          setGuard({ action, kind })
        },
        [isDirty],
      )

      const selectMemory = useCallback(
        (id) => {
          if (id === selectedId && !isDirty()) {
            if (layout === 'single') setView('detail')
            return
          }
          // 点的若是当前选中的那条（有未保存修改才会走到这里），文档本身就是最新的
          // （保存后是回读值，放弃后是基线），绝不能再用点击时的列表快照去重建它
          const target = id === selectedId ? null : visible.find((item) => item.id === id)
          requestTransition(() => {
            setSelectedId(id)
            if (target) beginEdit(target)
            if (layout === 'single') setView('detail')
          })
        },
        [selectedId, isDirty, layout, requestTransition, visible, beginEdit],
      )

      const changeTab = useCallback(
        (nextTab) => {
          if (nextTab === tab) return
          requestTransition(() => {
            setTab(nextTab)
            setView('list')
          })
        },
        [tab, requestTransition],
      )

      const applySearch = useCallback((value) => {
        setQuery(value)
      }, [])

      const onSearchChange = useCallback(
        (event) => {
          const nextQuery = event.target.value
          const nextVisible = (tab === 'pending' ? data.pending : data.memories).filter((memory) =>
            matchesQuery(memory, nextQuery),
          )
          // 搜索会让选中项消失 → 与切换记忆同样需要守卫；
          // 守卫期间不回填输入框，避免用户看到自己刚打的字被吃掉
          if (isDirty() && !nextVisible.some((memory) => memory.id === selectedId)) {
            requestTransition(() => applySearch(nextQuery))
            return
          }
          applySearch(nextQuery)
        },
        [tab, data.memories, data.pending, isDirty, selectedId, requestTransition, applySearch],
      )

      /* ---- AGENTS.md 概况（列表底部那一行） ---- */
      const loadAgents = useCallback(async () => {
        try {
          const response = await fetch(AGENTS_URL)
          const payload = await response.json().catch(() => ({}))
          if (payload?.ok) {
            setAgents(payload.agents ?? null)
            setEditors(Array.isArray(payload.editors) ? payload.editors : [])
          }
        } catch {
          // 拿不到就不显示这一块
        }
      }, [])

      useEffect(() => {
        void loadAgents()
      }, [loadAgents])

      const refresh = useCallback(() => {
        // 全局页签下「刷新」刷的是 AGENTS.md 的章节（并保住正在编辑的章）
        if (scope === 'global') {
          setAgentsReload((value) => value + 1)
          void loadAgents()
          return
        }
        // 列表重载后，选中项的草稿由「重建基线」effect 负责对齐（有未保存修改时它不会动）
        requestTransition(async () => {
          const next = await load()
          if (next) showToast(t('state.refreshed'))
        })
      }, [scope, requestTransition, load, loadAgents, showToast])

      const cancel = useCallback(() => {
        if (!isDirty()) {
          beginEdit(selected)
          return
        }
        setDoc((prev) => ({
          ...prev,
          draft: prev.baseline ? { ...prev.baseline, tags: [...prev.baseline.tags] } : prev.draft,
          errors: {},
          status: '',
          saveError: '',
        }))
        setTagError('')
      }, [isDirty, beginEdit, selected])

      /* ---- 待确认：收下 / 丢弃 ---- */
      const actPending = useCallback(
        async (endpoint) => {
          if (!selected) return
          const targetId = selected.id
          setDoc((prev) => ({ ...prev, saving: true, saveError: '' }))
          try {
            const response = await fetch(`${endpoint}?session=${encodeURIComponent(sessionId)}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: targetId }),
            })
            const payload = await response.json().catch(() => ({}))
            if (!response.ok || !payload.ok) {
              setDoc((prev) => ({
                ...prev,
                saving: false,
                status: 'error',
                // reason.section-moved 是给 AGENTS.md 章节编辑器的（「已重新读取」）；收下草稿时它的意思是
                // 要覆盖的那一章编号漂移了、什么都没写，单独一句
                saveError:
                  endpoint === ACCEPT_URL && payload.reason === 'section-moved'
                    ? t('pending.sectionMoved')
                    : reasonText(payload, t('promote.failed')),
              }))
              return
            }
            // 先在本地摘掉这一条（重读失败也不会让它「诈尸」），再静默重读把收下的那条拉进来
            setData((prev) => removeMemory(prev, targetId))
            setDoc((prev) => (prev.id === targetId ? EMPTY_DOC : prev))
            setView('list')
            void load({ silent: true })
            if (endpoint === ACCEPT_URL) void loadAgents()
            // 收下本身成功、但被取代的旧记忆没删掉（replaceFailed）：在同一个底部提示里点名它，留给人手动处理。
            // replaced / replacedMissing 不另提示：上面的刷新之后列表里自然可见
            const replaceFailed = endpoint === ACCEPT_URL && typeof payload.replaceFailed === 'string' && payload.replaceFailed ? payload.replaceFailed : ''
            showToast(
              endpoint === ACCEPT_URL
                ? replaceFailed
                  ? t('state.acceptedReplaceFailed', { id: replaceFailed })
                  : t('state.accepted')
                : t('state.rejected'),
            )
          } catch (error) {
            setDoc((prev) => ({ ...prev, saving: false, status: 'error', saveError: error?.message ?? String(error) }))
          }
        },
        [selected, sessionId, load, loadAgents, showToast],
      )

      /* ---- 全局 AGENTS.md ---- */
      const rememberEditor = useCallback((id) => {
        setEditorId(id)
        try {
          window.localStorage?.setItem('dsh-workspace-memory:editor', id)
        } catch {
          // 记不住就每次用自动
        }
      }, [])

      const openAgents = useCallback(async () => {
        try {
          const response = await fetch(OPEN_AGENTS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ editor: editorId }),
          })
          const payload = await response.json().catch(() => ({}))
          if (payload?.ok) {
            if (payload.editorId && payload.editorId !== editorId) rememberEditor(payload.editorId)
            showToast(t('state.opened', { app: payload.app }))
            return
          }
          setNotice({ title: t('promote.failed'), message: reasonText(payload, t('promote.failed')) })
        } catch (error) {
          setNotice({ title: t('promote.failed'), message: error?.message ?? String(error) })
        }
      }, [editorId, rememberEditor, showToast])

      /** 真正执行写入：确认之后才调用。 */
      const doPromote = useCallback(async () => {
        if (!selected) return
        const targetId = selected.id
        // 「保存后写入」可能刚换过库：selected 是点击时的快照，以文档基线（最近一次保存后的位置）为准
        const current = docRef.current
        const library = current.id === targetId && current.baseline ? current.baseline.scope : selected.scope
        setDoc((prev) => ({ ...prev, saving: true, saveError: '', status: '' }))
        try {
          const response = await fetch(`${PROMOTE_URL}?session=${encodeURIComponent(sessionId)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: targetId, scope: library }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || !payload.ok) {
            setDoc((prev) => ({
              ...prev,
              saving: false,
              status: 'error',
              saveError: reasonText(payload, t('promote.failed')),
            }))
            return
          }
          setData((prev) => removeMemory(prev, targetId))
          setDoc((prev) => (prev.id === targetId ? EMPTY_DOC : prev))
          setView('list')
          void load({ silent: true })
          void loadAgents()
          showToast(t('state.promoted'))
        } catch (error) {
          setDoc((prev) => ({ ...prev, saving: false, status: 'error', saveError: error?.message ?? String(error) }))
        }
      }, [selected, sessionId, load, loadAgents, showToast])

      /**
       * 写入 AGENTS.md 的入口。
       *
       * 顺序：先过未保存守卫（可保存后写入），再弹确认（说明会移出项目库）。
       * 保存失败时停留在当前草稿，不进入确认，也不写入。
       */
      const promote = useCallback(() => {
        requestTransition(
          () =>
            setConfirm({
              action: () => void doPromote(),
              title: t('confirm.promoteTitle'),
              message: t('confirm.promote'),
              okLabel: t('confirm.promoteOk'),
            }),
          'promote',
        )
      }, [requestTransition, doPromote])

      /**
       * 删除已确认的记忆。
       *
       * 高置信度记忆是直接入库的，所以人必须能自己删掉记错的东西。
       * 服务端走 deleteMemory（先留历史可回退），这里只负责确认与刷新。
       */
      const doForget = useCallback(async () => {
        if (!selected) return
        const targetId = selected.id
        setDoc((prev) => ({ ...prev, saving: true, saveError: '', status: '' }))
        try {
          const response = await fetch(`${FORGET_URL}?session=${encodeURIComponent(sessionId)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: targetId, scope: selected.scope }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || !payload.ok) {
            setDoc((prev) => ({
              ...prev,
              saving: false,
              status: 'error',
              saveError: reasonText(payload, t('promote.failed')),
            }))
            return
          }
          setData((prev) => removeMemory(prev, targetId))
          setDoc((prev) => (prev.id === targetId ? EMPTY_DOC : prev))
          setView('list')
          void load({ silent: true })
          showToast(t('state.deleted'))
        } catch (error) {
          setDoc((prev) => ({ ...prev, saving: false, status: 'error', saveError: error?.message ?? String(error) }))
        }
      }, [selected, sessionId, load, showToast])

      const forget = useCallback(() => {
        if (!selected) return
        setConfirm({
          action: () => void doForget(),
          title: t('confirm.deleteTitle'),
          message: t('confirm.delete'),
          okLabel: t('confirm.deleteOk'),
        })
      }, [selected, doForget])

      /* ---- 快捷键 ---- */
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.isComposing) return
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            // 只在「面板可见、焦点在面板里、当前是记忆库页签、确实有未保存修改」时接管；
            // 否则不拦截，让宿主里别处的 Ctrl+S 照常工作
            const root = rootRef.current
            if (!root || !root.contains(event.target) || root.getClientRects().length === 0) return
            if (scope !== 'project' || tab !== 'confirmed' || !isDirty() || docRef.current.saving) return
            event.preventDefault()
            void save()
            return
          }
          if (event.key === 'Escape') {
            if (fileOpen) {
              setFileOpen(false)
              return
            }
            if (fullscreen) setFullscreen(false)
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [save, fileOpen, fullscreen, scope, tab, isDirty])

      /* ---- 弹层外部点击关闭 ---- */
      useEffect(() => {
        if (!fileOpen) return
        const onPointerDown = (event) => {
          if (!rootRef.current) return
          const popover = rootRef.current.querySelector('.wsm-file-popover')
          const trigger = rootRef.current.querySelector('.wsm-file-trigger')
          if (popover?.contains(event.target) || trigger?.contains(event.target)) return
          setFileOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        return () => document.removeEventListener('mousedown', onPointerDown)
      }, [fileOpen])

      /* ---- 列表键盘导航 ---- */
      const onListKeyDown = useCallback(
        (event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          if (!visible.length) return
          event.preventDefault()
          const index = Math.max(0, visible.findIndex((memory) => memory.id === selectedId))
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? visible.length - 1
                : Math.min(visible.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
          selectMemory(visible[next].id)
        },
        [visible, selectedId, selectMemory],
      )

      const workspace = basename(data.root.replace(/[\\/]memory[\\/]?$/, ''))

      return h(
        'div',
        {
          ref: rootRef,
          className: 'wsm-panel',
          'data-layout': layout,
          'data-view': view,
          'data-mode': width >= 1100 ? 'wide' : 'auto',
          'data-fullscreen': fullscreen ? 'true' : 'false',
          'data-highlighted': bodyView === 'edit' ? 'true' : 'false',
        },

        h(
          'header',
          { className: 'wsm-header' },
          h(
            'div',
            { className: 'wsm-header-top' },
            h('span', { className: 'wsm-brand' }, 'DeepSeek Harness'),
            h('span', { className: 'wsm-title' }, t('panel.heading')),
            // 作用域切换：项目记忆库 ↔ 全局 AGENTS.md（同一个面板里管两处）
            h(
              'div',
              { className: 'wsm-tabs', role: 'tablist', style: { height: 'auto', gap: '4px', margin: '0 0 0 12px', border: '0' } },
              ...[
                ['project', t('scope.local')],
                ['global', t('scope.agents')],
              ].map(([key, label]) =>
                h(
                  'button',
                  {
                    key,
                    type: 'button',
                    className: 'wsm-text-btn',
                    role: 'tab',
                    'aria-selected': scope === key,
                    style: { padding: '2px 8px', fontSize: '12px', color: scope === key ? 'var(--dsw-alias-brand-primary)' : undefined },
                    onClick: () => {
                      if (scope === key) return
                      if (key === 'global') {
                        // 项目侧有未保存改动时先过守卫，避免静默丢弃
                        requestTransition(() => setScope('global'))
                        return
                      }
                      // 回到记忆库：AGENTS.md 章节有未保存改动时同样先过它自己的守卫
                      const leave = agentsLeaveRef.current
                      if (leave) leave(() => setScope('project'))
                      else setScope('project')
                    },
                  },
                  label,
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'wsm-header-tools' },
            h('span', { className: 'wsm-workspace', title: data.root }, workspace || '—'),
            h('button', { type: 'button', className: 'wsm-btn', onClick: refresh }, t('action.refresh')),
          ),
        ),

        h(
          'div',
          { className: 'wsm-panel-body', 'data-scope': scope },
          h(
            'aside',
            { className: 'wsm-list-pane', 'aria-label': t('panel.heading') },
            h(
              'div',
              { className: 'wsm-list-tools' },
              h(
                'div',
                { className: 'wsm-tabs', role: 'tablist', 'aria-label': t('tab.confirmed') },
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'tab',
                    'aria-selected': tab === 'confirmed',
                    tabIndex: tab === 'confirmed' ? 0 : -1,
                    onClick: () => changeTab('confirmed'),
                  },
                  `${t('tab.confirmed')} `,
                  h('span', null, confirmed.length),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'tab',
                    'aria-selected': tab === 'pending',
                    tabIndex: tab === 'pending' ? 0 : -1,
                    onClick: () => changeTab('pending'),
                  },
                  `${t('tab.pending')} `,
                  h('span', null, pending.length),
                ),
              ),
              h('input', {
                className: 'wsm-search',
                type: 'search',
                placeholder: t('search.placeholder'),
                'aria-label': t('search.placeholder'),
                autoComplete: 'off',
                value: query,
                onChange: onSearchChange,
                onKeyDown: (event) => {
                  if (event.key === 'Escape' && query) {
                    event.preventDefault()
                    applySearch('')
                  }
                },
              }),
            ),
            h(
              'div',
              { className: 'wsm-list-region' },
              h(
                'div',
                { className: 'wsm-sr-only', role: 'status' },
                t('count.items', { count: visible.length }),
              ),
              h(
                'div',
                {
                  className: 'wsm-list-scroll',
                  role: 'listbox',
                  'aria-label': tab === 'pending' ? t('tab.pending') : t('tab.confirmed'),
                  tabIndex: -1,
                  onKeyDown: onListKeyDown,
                },
                data.loading && visible.length === 0
                  ? h('div', { className: 'wsm-empty' }, t('state.loading'))
                  : data.error
                    ? h('div', { className: 'wsm-empty', role: 'alert' }, `${t('error.load')}: ${data.error}`)
                    : visible.length === 0
                      ? h(
                          'div',
                          { className: 'wsm-empty', role: 'status' },
                          query
                            ? t('search.empty')
                            : tab === 'pending'
                              ? t(data.pendingEnabled ? 'pending.on' : 'pending.off')
                              : t('state.empty'),
                        )
                      : visible.map((memory, index) =>
                          h(MemoryListItem, {
                            // 两个库可能各有一条同 id 的记忆：key 带上所在的库，避免 React 键冲突
                            key: `${memory.scope}:${memory.id}`,
                            memory: {
                              ...memory,
                              draftTitle: memory.id === selectedId ? doc.draft?.title : undefined,
                              draftDescription: memory.id === selectedId ? doc.draft?.description : undefined,
                            },
                            selected: memory.id === selectedId,
                            dirty: memory.id === selectedId && isDirty(),
                            tabIndex: memory.id === selectedId || (!selectedId && index === 0) ? 0 : -1,
                            disabled: doc.saving,
                            onSelect: selectMemory,
                          }),
                        ),
              ),
            ),
            h(
              'div',
              { className: 'wsm-agents-row' },
              h(
                'div',
                { className: 'wsm-agents-summary' },
                h('span', { className: 'wsm-agents-name' }, 'AGENTS.md'),
                h(
                  'span',
                  null,
                  agents ? `${(agents.bytes / 1024).toFixed(1)} KB · ${agents.sections} ${t('agents.sections')}` : '—',
                ),
              ),
              h(
                'div',
                { className: 'wsm-agents-actions' },
                h(
                  'select',
                  {
                    className: 'wsm-select',
                    'aria-label': t('agents.openWith'),
                    value: editorId,
                    onChange: (event) => rememberEditor(event.target.value),
                  },
                  h('option', { value: '' }, t('agents.auto')),
                  ...editors.map((editor) => h('option', { key: editor.id, value: editor.id }, editor.name)),
                ),
                h('button', { type: 'button', className: 'wsm-btn', onClick: openAgents }, t('action.open')),
              ),
            ),
          ),

          h(
            'section',
            { className: 'wsm-detail-pane', 'aria-label': t('detail.breadcrumb') },
            selected && doc.draft && doc.id === selected.id
              ? h(MemoryDetail, {
                  memory: selected,
                  doc,
                  isPending: tab === 'pending',
                  layout,
                  fullscreen,
                  bodyView,
                  fileOpen,
                  tagError,
                  onTagError: setTagError,
                  onBodyView: setBodyView,
                  onField: setField,
                  onBlurField: blurField,
                  onToggleFullscreen: () => setFullscreen((value) => !value),
                  onToggleFile: () => setFileOpen((value) => !value),
                  onSlugInput: (value) => setField('slug', value),
                  onSave: () => void save(),
                  onCancel: cancel,
                  onReject: () => void actPending(REJECT_URL),
                  onAccept: () => void actPending(ACCEPT_URL),
                  onPromote: promote,
                  onDelete: forget,
                  onBack: () => setView('list'),
                })
              : h('div', { className: 'wsm-detail-empty' }, t('detail.choose')),
          ),

          // 全局模式：项目两栏由 CSS 隐藏，这里换成 AGENTS.md 面板
          scope === 'global'
            ? h(AgentsPane, { layout, onToast: showToast, onChanged: loadAgents, reloadToken: agentsReload, leaveRef: agentsLeaveRef })
            : null,
        ),

        toast ? h('div', { className: 'wsm-toast', role: 'status', 'aria-live': 'polite' }, toast) : null,

        h(
          Dialog,
          {
            open: Boolean(guard),
            title: t(guard?.kind === 'promote' ? 'guard.promoteTitle' : 'guard.title'),
            description: t('guard.description'),
            onCancel: () => setGuard(null),
          },
          h('button', { type: 'button', className: 'wsm-btn', onClick: () => setGuard(null) }, t('guard.continue')),
          h(
            'button',
            {
              type: 'button',
              className: 'wsm-btn',
              onClick: () => {
                const action = guard?.action
                setGuard(null)
                setDoc((prev) => ({
                  ...prev,
                  draft: prev.baseline ? { ...prev.baseline, tags: [...prev.baseline.tags] } : prev.draft,
                  errors: {},
                  status: '',
                  saveError: '',
                }))
                setTagError('')
                action?.()
              },
            },
            t(guard?.kind === 'promote' ? 'guard.discardPromote' : 'guard.discard'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wsm-btn primary',
              onClick: async () => {
                const action = guard?.action
                const saved = await save()
                setGuard(null)
                // 保存失败就停在原地：既不动导航，也不继续 promote
                if (saved) action?.()
                else setDoc((prev) => ({ ...prev, status: 'error' }))
              },
            },
            t(guard?.kind === 'promote' ? 'guard.savePromote' : 'guard.save'),
          ),
        ),

        h(
          Dialog,
          {
            // 同一个确认框同时服务「写入 AGENTS.md」和「删除」，文案由 confirm 携带
            open: Boolean(confirm),
            title: confirm?.title ?? '',
            description: confirm?.message ?? '',
            onCancel: () => setConfirm(null),
          },
          h('button', { type: 'button', className: 'wsm-btn', onClick: () => setConfirm(null) }, t('action.cancel')),
          h(
            'button',
            {
              type: 'button',
              className: 'wsm-btn primary',
              onClick: () => {
                const action = confirm?.action
                setConfirm(null)
                action?.()
              },
            },
            confirm?.okLabel ?? t('action.confirm'),
          ),
        ),

        h(
          Dialog,
          {
            open: Boolean(notice),
            title: notice?.title ?? '',
            description: notice?.message ?? '',
            onCancel: () => setNotice(null),
          },
          h('button', { type: 'button', className: 'wsm-btn primary', onClick: () => setNotice(null) }, t('action.gotIt')),
        ),
      )
    }


    /**
     * 换会话 = 换一个记忆库：用 sessionId 当 key 让面板整个重挂，
     * 选中项、草稿、页签、视图、在途请求的回写一并作废，不用逐项重置。
     */
    function MemoryPanelRoot(props) {
      return h(MemoryPanel, { ...props, key: props.sessionId ?? '' })
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

        // 交互反馈样式表：内联样式写不了 :hover / :active，只能挂一份真实 CSS
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
              // 内置中文的语言 id 是 `zh`（回落链 zh → en），不是 `zh-CN`：`zh-CN` 只出现在 <html lang> 上。
              // 以前注册在 zh-CN 下，中文界面查 NS 时 zh 落空、回落到 en，于是中文用户看到英文。
              // 以 zh 注册后，回落链经过 zh 的 zh-* 语言包也能取到中文。
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
                return typeof out === 'string' && out !== key ? out : inlineT(key, vars)
              } catch {
                return inlineT(key, vars)
              }
            }
          }
        } catch {
          // 语言探测失败就用中文
        }

        // 命令结果卡片按「命令名」绑定：memory 与它拆出来的无参子命令共用同一张卡，
        // 否则新命令的输出会走默认折叠渲染，读起来别扭。
        for (const key of ['memory', 'memory_extract', 'memory_pending']) {
          try {
            ctx.slots.inject('conversation.chat.commandview', () =>
              ctx.slots.register({ name: 'conversation.chat.commandview', key }, MemoryCommandCard),
            )
          } catch (error) {
            console.error(`[workspace-memory] 命令卡 ${key} 注册失败`, error)
          }
        }

        try {
          ctx.slots.inject('conversation.chat.commandview', () =>
            ctx.slots.register({ name: 'conversation.chat.commandview', key: 'memory_list' }, MemoryListCommandCard),
          )
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
            if (attempts >= MAX_ATTEMPTS) {
              console.error(`[workspace-memory] sidebarRightTabs 重试 ${MAX_ATTEMPTS} 次仍不可用，记忆面板未注册`)
            } else {
              retryTimer = setTimeout(tryRegisterTab, RETRY_MS)
            }
            return
          }

          try {
            ctx.effect(() =>
              tabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                title: () => t('tab.title'),
              }),
            )
          } catch (error) {
            console.error('[workspace-memory] tabs.register 失败', error)
          }

          try {
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, MemoryPanelRoot),
            )
          } catch (error) {
            console.error('[workspace-memory] 面板组件注册失败', error)
          }
        }

        tryRegisterTab()
      },
    }
  },
})