---
name: hot-reload-local-bundle-generation
description: 本地 bundle 改完不热更：disable→enable 切一次插件行来换模块代次
scope: global
type: project
status: confirmed
tags: [lesson, 删除]
created: 2026-11-01T07:51:07.291Z
modified: 2026-11-02T06:44:58.132Z
confidence: 0.9
title: 本地 bundle 改完代码不热更，如何不重启换模块代次
---

**错误模式**：改了插件源码、命令行为却没变，反复「重启后再试」仍无效

**修正做法**：改完源码后：plugin_manager set_plugin 对 entryId（如 include:dsh-command-context）先 enabled=false 再 true，application 返回 applied 即完成重新 import，无需重启应用。确认方式：插件在 apply() 里往 ~/.dsh/tmp/<name>.loads.log 追加一行时间戳+rev，末尾时间戳晚于文件改动时间即为新代次。install_bundle 对已安装包直接返回 already-installed，换版本要 remove_bundle，但 remove 会对 junction 做删除、可能带走源码目录，必须先备份。

**选了什么**：用 disable→enable 切一次插件行来换模块代次，并用装载戳确认

**为什么**：dsh-hmr 的 ignored 默认含 **/node_modules，而被安装的本地 bundle 正是以 junction 挂在 profiles/<p>/node_modules 下，所以文件改了也不会热更。桌面版关窗口只是最小化，主进程不重启就不会换模块代次（可用 Get-Process 的 StartTime 佐证）。

**关联文件**：

- dsh-command-context/index.js
- dsh-command-context/README.md

---

迁移自 @yolk_vat-y/dsh-project-memory：id=ins_ddb4b86a-3e57-4776-8b9e-a86b6356f76c, kind=lesson, hitCount=10, createdAt=2026-10-31T10:59:29.601Z
