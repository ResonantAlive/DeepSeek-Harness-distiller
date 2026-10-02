---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-02-served-model-optional

[English](2026-10-02-served-model-optional.md) | 中文

## 概述

为持久化的 assistant 流中的 usage 分片新增可选的 servedModel，记录提供方自报实际服务该响应的模型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效：该属性可选，缺失表示提供方未自报模型，而不表示写入方丢弃了它。请求方要一个模型，响应方说明是哪一个真正服务了它，因此需要把输出归因到某个模型的读取方，现在得到的是响应方自己的答复，而不是请求方的主张。忽略该字段的读取方回放行为与之前完全一致，组装、回放与终止 finish 都不受影响。写入方版本不变，因为新旧记录在任一侧都可读。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm packages/llm/llm-deepseek：52 个文件、1251 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
