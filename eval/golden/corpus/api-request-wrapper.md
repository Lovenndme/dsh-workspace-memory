---
name: api-request-wrapper
description: 禁止在页面里直接裸调 fetch
scope: project
type: project
status: confirmed
tags: ["前端","请求"]
paths: []
created: 2026-11-03T02:18:23.586Z
modified: 2026-11-03T02:18:23.586Z
confidence: 0.9
title: 前端请求层必须统一封装超时与错误码
---

规则：

1. 页面组件里不直接调用 `fetch`，统一走 `request()` 封装。
2. 封装层负责：默认超时 10 秒、非 2xx 抛结构化错误、统一带上 trace id。
3. 业务错误码到用户文案的映射集中在封装层的错误表里，不散落在各页面。

为什么：裸调 fetch 时每个页面各写一套超时和错误处理，行为不一致，排查时也看不到统一的日志字段。