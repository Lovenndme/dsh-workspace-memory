---
name: pnpm-remove-link-deletes-target
description: pnpm 删 link 依赖会顺着 junction 删穿源目录，换源前必须先 rmdir 断链
scope: global
type: project
status: confirmed
tags: [lesson, 提交, 删除, 依赖]
created: 2026-11-01T07:51:07.282Z
modified: 2026-11-02T06:44:58.128Z
confidence: 0.95
title: pnpm 删除 link(junction) 依赖会顺链接删穿工作区，含 .git 内部文件
---

**错误模式**：对 link/软链接(junction)安装的 bundle 执行 remove_bundle 或换源重装后，工作区源码目录 .git 里的 HEAD/config/index 被删除，git 报 not a git repository（工作区普通文件仍在）

**修正做法**：要换安装源/升级前，先断链接再装：① 停用插件；② `cmd /c rmdir <profile>\\node_modules\\<pkg>` 只断链接（不递归、不跟随目标）；③ 再 install_bundle。或者干脆在独立副本里演练升级，不要对正在开发的工作区做 link 安装的 remove/install 往返。仓库受损后的恢复：`git init -b main`（保留 objects/refs）→ `git remote add origin …` → `git reset --mixed HEAD` → 重新提交未推的改动。

**关联文件**：

- dsh-profile-stats/tools/release.ps1

---

迁移自 @yolk_vat-y/dsh-project-memory：id=ins_7f5038a8-ea45-44f4-90b7-f3373c841c92, kind=lesson, hitCount=4, createdAt=2026-10-31T07:25:52.945Z
