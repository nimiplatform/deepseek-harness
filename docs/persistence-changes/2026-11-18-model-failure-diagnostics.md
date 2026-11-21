---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-model-failure-diagnostics

English | [中文](2026-11-18-model-failure-diagnostics.zh.md)

## Summary

Preserves optional string diagnostics on model failures.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing V4 failure records remain valid. Current readers retain the optional diagnostics map through LlmError and adapter normalization. Earlier readers accept the extra JSON field and may omit its display. The existing code and message retain their routing meaning. Nimi interrupted steps use their existing code and do not gain an automatic retry policy.

<a id="verification"></a>
## Verification

The model service, failure normalization, Nimi IPC and Nimi Adapter checks passed 114 tests. They cover rethrow, JSON round trip and both interruption and uncertain outcome metadata.

<a id="dev-note"></a>
## Dev Note

None.
