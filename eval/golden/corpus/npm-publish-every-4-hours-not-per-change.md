---
name: npm-publish-every-4-hours-not-per-change
description: 规则（用户 2026-11-02，适用于**所有** npm 发布的插件）
scope: project
type: feedback
status: confirmed
tags: [发布, npm, GitHub Actions, 版本号, BOM]
paths: [.github/workflows/publish-pending.yml, dsh-profile-stats/tools/publish-pending.ps1]
created: 2026-11-02T13:19:52.070Z
modified: 2026-11-02T13:19:52.070Z
confidence: 0.97
title: npm 发布：只走 GitHub Actions 每 4 小时批量发，本地兜底脚本已关闭
---

## 规则（用户 2026-11-02，适用于**所有** npm 发布的插件）

1. **不要每次改动就发 npm**：改成每 4 小时批量发布。
2. **版本号在"发布那一刻"才升**（patch），一次代表这一批改动；日常只做 测试 → commit → push，**不手改 version、不手写 CHANGELOG**。
3. **只用 GitHub Actions 发布，本地兜底脚本已按用户要求关闭**（2026-11-02 21:20）。

## 门禁：用 git tag 判断待发布

`git rev-list --count $(git describe --tags --abbrev=0 --match 'v*')..HEAD` > 0 → 有待发布。

## 发布动作（CI）

patch 升 version → `git log --no-merges --pretty='- %s' <lastTag>..HEAD` 自动生成 CHANGELOG 段 → `release: vX` 提交 → npm publish → 打 tag `vX` → 创建 GitHub Release（成功通知就靠它，一次真实发布一封）。

实现：`.github/workflows/publish-pending.yml`（`cron: '0 */4 * * *'` + `workflow_dispatch` 含 dry_run，`permissions: contents: write`，`concurrency: release-pending`，`NODE_AUTH_TOKEN: secrets.NPM_TOKEN`）。
已接入：`dsh-profile-stats`、`dsh-command-context`。

## 已关闭的本地兜底

`tools/publish-pending.ps1` + Windows 计划任务 `DSH publish pending plugin versions`（现为 **Disabled**）。
关闭原因：它曾用 `ConvertTo-Json | Set-Content -Encoding utf8` 改 `package.json`，**写入 UTF-8 BOM**，而 DSH 启动时 `JSON.parse` 遇到 BOM 直接失败 → 该 bundle 被静默跳过，侧栏「个人主页」入口消失（2026-11-02 的真实故障）。脚本现已改为用 node 写 JSON，但按用户要求不再自动运行。

## 踩过的坑

- **任何改 `package.json` 的脚本都必须用 node（或至少写无 BOM UTF-8）**：BOM 会导致 DSH 静默丢弃整个 bundle，且没有任何报错。
- PS1 文件本身要存 **UTF-8 with BOM**（Windows PowerShell 5.1 否则乱码），但**它写出来的 JSON 不能带 BOM**——两件事不要搞混。
- `$ErrorActionPreference='Stop'` 下 npm 的 stderr `npm notice` 会被当终止错误；调用 npm 的段落要放宽，只认 `npm error`。
- 首次启用 tag 门禁要给最后一个已发布提交补基线 tag，否则全部历史都算待发布。
