---
name: no-explanatory-text-in-ui
description: 界面只呈现数据与控件，不加解释性文案；需要的解释写进 README
scope: global
type: feedback
status: confirmed
tags: [lesson, README]
created: 2026-11-01T07:51:07.279Z
modified: 2026-11-02T06:44:58.121Z
confidence: 0.95
title: 界面里不要自行添加解释性说明文字
---

**错误模式**：在面板里加"口径说明/小字解释/提示性文案"，以为能帮用户理解

**修正做法**：用户明确要求：UI 只呈现数据与控件，不要加解释性文案（例如"输入只算未命中的 prompt…"这类）。需要的解释写进 README/文档，而不是界面。改版时若想加提示语，先问。

**关联文件**：

- dsh-profile-stats/client.js

---

迁移自 @yolk_vat-y/dsh-project-memory：id=ins_70559ce9-ce8c-4b94-884e-4dc0d98dfc36, kind=lesson, hitCount=6, createdAt=2026-10-31T06:02:01.404Z
