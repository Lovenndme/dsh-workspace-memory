---
name: logging-rules
description: 日志脱敏与结构化要求
scope: project
type: project
status: confirmed
tags: ["日志","安全"]
paths: []
created: 2026-11-03T02:18:23.584Z
modified: 2026-11-03T02:18:23.584Z
confidence: 0.9
title: 日志里不得出现密钥与个人身份信息
---

规则：

1. **绝对不打印**：API key、访问令牌、密码、完整身份证号、完整手机号（中间四位打码）。
2. 日志用结构化格式（JSON 或 key=value），不要拼接大段自然语言。
3. 每条日志带 trace id，便于把一次请求的上下游日志串起来。
4. 错误日志必须包含错误类型与堆栈，不能只写"出错了"。

为什么：日志会被转发、归档、给别人看。一旦把密钥打进日志，等于把凭证撒在多个地方，且很难彻底清除。