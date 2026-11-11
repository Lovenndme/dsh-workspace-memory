---
name: db-migration-rules
description: 生产库结构变更的硬性流程
scope: project
type: project
status: confirmed
tags: ["数据库","迁移"]
paths: []
created: 2026-11-03T02:18:23.574Z
modified: 2026-11-03T02:18:23.574Z
confidence: 0.9
title: 数据库迁移必须可回滚且先备份
---

规则：

1. 任何 schema 变更都必须配一份可执行的**回滚脚本**，没有回滚脚本的迁移不允许上线。
2. 上线前对目标库做一次全量备份，并在迁移记录里写明备份位置。
3. 禁止在生产库手工执行 DDL——所有变更走迁移文件，能进 git、能 review。
4. 大表加索引要评估锁表时间，超过 5 秒就改用在线 DDL 工具。

为什么：手工改结构没有留痕，出事时无法判断当时改了什么、也无法照着回滚。