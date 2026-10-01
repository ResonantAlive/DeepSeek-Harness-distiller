---
description: "蒸馏 attempt 的实时轨迹捕获：每次 agent 活动写出一行已刷新的 JSON，每个负载在落盘前都已脱敏，超长字段溢出为内容寻址的 blob。"
kind: "package-reference"
---

# @deepseek-ai/dsh-distill-trajectory-events

[English](README.md) | 中文

## 概述

使用 `dsh-distill-trajectory-events` 记录 agent 工作期间的所作所为，而不是事后从散文式描述中重建它。`TrajectoryRecorder` 订阅会话日志与实时助手流，为每次活动写出结构化的原始事件：轮次与步骤边界、每次带有工具调用的模型决策、每个工具结果、请求配置，以及流式推理与文本增量。

负载在落盘前已脱敏，超长字段会变成内容寻址的 blob 引用加上有界预览。追加按提交顺序串行化，`flush()` 会排空队列，因此 attempt 可以证明其日志是完整的。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

每个 attempt 构建一个记录器，挂载它，并在 attempt 结束前排空它。

```ts
import { createRecorder, apply } from '@deepseek-ai/dsh-distill-trajectory-events'

const recorder = createRecorder({
  root: 'runs/T-1/attempt_001',
  taskId: 'T-1',
  attemptId: 'attempt_001',
  batchId: 'batch_0',
  secrets: collectEnvironmentSecrets(),
})
apply(ctx, { recorder })
// … the agent runs …
await recorder.flush()
```

每个 attempt 写出：

```text
runs/<task_id>/<attempt_id>/
├── events.jsonl        one JSON object per line
└── blobs/<ab>/<sha256> oversized field content, redacted
```

### 记录的事件类型

| `event_type` | 记录内容 |
|---|---|
| `task_start` | `turn/start`、`step/start`、被接纳的用户消息，以及每个请求头或上下文 |
| `assistant_message` | 模型组装出的消息、其决策、其工具调用，以及其 token 用量 |
| `assistant_attempt` | 一次已结算且未提交任何模型可见消息的 attempt |
| `reasoning_delta` | 每个流式推理增量，以及每个标记为 `stream: 'text'` 的文本增量 |
| `tool_call` / `tool_result` | 一次工具调用及其面向模型的结果，按 `tool_call_id` 配对 |
| `task_end` / `attempt_end` | `step/end` 与 `turn/end`，包括该轮次的结束原因 |
| `evaluator` / `error` / `cancellation` | 由调用方通过 `append()` 写出 |

### 事件信封

| 字段 | 含义 |
|---|---|
| `event_id` | 该事件的随机 UUID |
| `seq` | 在该 attempt 日志中的位置，从 0 开始 |
| `task_id`、`attempt_id`、`batch_id` | 该 attempt 的身份，盖在每个事件上 |
| `event_type` | 活动的类型 |
| `timestamp` | 带毫秒的 UTC ISO-8601 |
| `monotonic_ms` | 自模块加载以来的毫秒数，用于可跨越时钟跳变的间隔 |
| `payload` | 已脱敏的负载，其中超长字段已被替换 |

### 推理只被报告，绝不臆造

`decisionOf(blocks)` 仅当某个推理块携带文本时才报告 `reasoning_available: true`。推理块缺失与推理块为空是同一个事实——提供方没有返回任何内容——因此两者都报告 `reasoning: null`。

### blob 引用

序列化形式超过 `maxInlineBytes`（默认 64 KiB）的字段会变成：

```json
{
  "blob": { "sha256": "…", "bytes": 123456, "path": "blobs/ab/ab…" },
  "original_bytes": 123456,
  "preview": "…",
  "truncated": true
}
```

`boundedJson(value, budget)` 生成该预览，并导出给需要同样有界渲染的调用方。对 JSON 输入它总是返回合法 JSON：容器只有在其闭合定界符也能容纳时才会被提交，因此对容器而言过小的预算会什么都不输出，而不是输出无法解析的片段。

## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 为何采用 plan/append 两阶段拆分

`plan()` 负责脱敏与溢出，`append()` 负责盖上身份并写入。把两者拆开意味着昂贵的那部分（哈希、写 blob）在序号被消耗之前完成，因此一次失败的溢出不会在序列中留下空洞。

### 顺序与失败

`append()` 把每次写入串接到同一个 promise 上，因此即使同一 tick 内排入多个事件，它们也会按调用顺序落地。失败的追加会拒绝它自己的调用方；串接链本身继续，下一个事件仍会被记录。`flush()` 等待该链。

### 事件覆盖

`record()` 依据已提交会话事件的类型分支。本包未建模的事件类型会以 `phase: 'session-event'` 连同其类型与数据被通用记录，因此插件拥有的活动是被捕获的，而不是被丢弃的。

请求头只作为配置记录：工具 schema 列表在每个请求头上重复出现，描述的是环境而非本次运行，因此它留给环境记录。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 记录器、决策投影与 Cordis 插件 |
| [`src/writer.ts`](src/writer.ts) | 仅追加日志、先脱敏再溢出的规划，以及有界 JSON 渲染 |
| [`src/blobs.ts`](src/blobs.ts) | 内容寻址的 blob 存储 |
| — | 不发布运行时不变式伴生入口。记录器只拥有自己的写入器与队列，没有独立观察能与之产生分歧。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

训练流水线所消费的轨迹由蒸馏运行器从该日志组装。脱敏规则与密钥环位于 `@deepseek-ai/dsh-distill-redaction`。

-----

## 模型体验

无：记录器观察并持久化事件，而它所观察的插件拥有每一项模型可见的贡献。

#### KV Cache 影响

此处没有任何内容进入请求前缀，因此提供方缓存复用不受影响。
## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **嵌套的超长字符串不会产生预览。** 局部字符串无法由其父容器闭合，因此该容器被放弃，`boundedJson` 对该值返回空前缀。当写入器把它溢出为 blob 时，该字段本身仍会被完整捕获；只有内联预览是空的。
- **实时流是尽力而为的。** `agent/assistant-stream` 帧是进程本地的、瞬时的。流中途丢失进程会丢失增量，而已结算的 `assistant/message` 或 `assistant/attempt` 仍持久存在于会话日志中。
- **一个记录器会捕获进程内的每个会话。** 订阅注册在挂载它的上下文上，因此通过一个记录器运行多个并发会话的组合会把它们混在一起。一次蒸馏 attempt 只运行一个会话。
- **文件变更由调用方记录。** `file_change` 事件通过 `append()` 写出；观察文件系统是另一件事。
- **没有轮转或压缩。** `events.jsonl` 在整个 attempt 期间持续增长，blob 也从不被清理。

<a id="dev-note"></a>
### 开发备注

有一条代码路径未被测试套件覆盖：`TrajectoryRecorder.append` 中用于队列恢复的 `catch`。要触发它需要一次失败的追加，而仓库的测试套件即便在调用方观察到该拒绝时，也会把由此产生的 rejected promise 视为未处理，因此该分支保持未覆盖，而不是用一个无法干净通过的测试去断言它。
