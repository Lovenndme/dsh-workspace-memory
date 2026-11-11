---
name: small-verifiable-ui-refactors
description: 界面重构要小步可验证；一次性换样式层会被用户否决并回滚
scope: global
type: feedback
status: confirmed
tags: [decision, 发布, 回滚]
created: 2026-11-01T07:51:07.285Z
modified: 2026-11-02T06:44:58.124Z
confidence: 0.9
title: 界面重构要小步、可验证；大改一次性替换样式层会被回滚
---

**选了什么**：1.5.0 整体换样式层（tasteskill v2 Achromatic ledger）被用户否决并回滚，发布 1.5.1（内容=1.4.3 界面）；重构代码留在分支 design/achromatic-ledger（已推远端）。

**为什么**：用户反馈"bug 太多"。风险点复盘：①一次性整体替换 CSS 字符串（约 5.9KB），无法逐项验证；②同时改了字阶、间距、配色、CELL_PITCH(14→16)、class 结构与动画五个变量；③宿主内无法截图验证渲染结果，只能靠用户肉眼。今后界面类改动应：一次只动一个变量（先字阶、再间距、再配色），每次让用户刷新确认；不改动热力图列距等会引发横向溢出的常量；新样式先做成可选开关或独立分支，不在一个版本里全量替换。

---

迁移自 @yolk_vat-y/dsh-project-memory：id=ins_ef64d214-1999-4737-afee-71079e364421, kind=decision, hitCount=1, createdAt=2026-10-31T09:33:13.930Z
