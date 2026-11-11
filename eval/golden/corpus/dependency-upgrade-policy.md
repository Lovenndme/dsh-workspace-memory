---
name: dependency-upgrade-policy
description: 第三方依赖的升级节奏
scope: project
type: project
status: confirmed
tags: ["依赖","升级"]
paths: []
created: 2026-11-03T02:18:23.587Z
modified: 2026-11-03T02:18:23.587Z
confidence: 0.9
title: 依赖升级策略：minor 自动、major 手动验证
---

规则：

1. **patch / minor** 可以自动升级，但要在 CI 里跑全量测试通过后才合并。
2. **major** 必须手动升级，并记录破坏性变更点、验证过哪些路径。
3. 升级前先看 CHANGELOG 里的 breaking change，别只看版本号。
4. 锁定文件（lockfile）必须提交，禁止用浮动版本号直接上线。

为什么：major 版本经常改默认行为，自动升级会把"某天突然不对了"变成难以回溯的偶发故障。