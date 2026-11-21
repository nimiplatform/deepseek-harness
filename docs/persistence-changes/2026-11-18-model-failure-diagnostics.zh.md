---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-model-failure-diagnostics

[English](2026-11-18-model-failure-diagnostics.md) | 中文

## 概述

保留模型失败上的可选字符串诊断字段。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-model-failure-diagnostics
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "6d765d8c5ed0e27f34b8418d69be2ba8d266c85320b5f87a95decab2c3118a58"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "bfad0e508ce2bf0fb633a21f66d97a2be312b55571d31f747419b7e3ab9a1c80"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "04fc05aad6803f531003d5eee5aeb847f27221616e63166cd33163c62067aa11"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "9bcce7a49320b26b0c8acc46d88fdbdceceab7f5c419ff0c93921d990ad56ae3"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有 V4 失败记录继续有效。当前读取方通过 LlmError 和 Adapter 归一化保留可选诊断映射。较早读取方接受新增 JSON 字段并可能省略其展示。已有 code 和 message 保持原有路由含义。Nimi 中断步骤使用原有错误码，不增加自动重试策略。

<a id="verification"></a>
## 验证

模型服务、错误归一化、Nimi IPC 和 Nimi Adapter 共 114 项检查通过，覆盖重新抛出、JSON 往返以及中断和结果不确定的信息。

<a id="dev-note"></a>
## 开发备注

无。
