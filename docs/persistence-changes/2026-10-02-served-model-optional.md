---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-02-served-model-optional

English | [中文](2026-10-02-served-model-optional.zh.md)

## Summary

Adds an optional servedModel to the usage chunk inside a persisted assistant stream, recording which model the provider reported serving the response.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-served-model-optional
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "7e460ceb73d9611a0be7475f036e22915ecf95f9d421f5676455989cc0e0b3ce"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "3690108acc65338f2fe1ee2f54d1fadf957697d85dec38c37d8d3411ae9c6717"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid: the property is optional and its absence means the provider named no model, never that a writer dropped it. A request asks for a model and a response says which one served it, so a reader that attributes an output to one model now has the response's own answer instead of the request's. Readers that ignore the field replay exactly as before, and assembly, replay, and the terminal finish are unaffected. No writer version changes, because both old and new records stay readable by either side.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm packages/llm/llm-deepseek: 52 files, 1251 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
