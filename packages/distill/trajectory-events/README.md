---
description: "Real-time trajectory capture for distillation attempts: one flushed JSON line per agent activity, every payload redacted before disk, and oversized fields spilled to content-addressed blobs."
kind: "package-reference"
---

# @deepseek-ai/dsh-distill-trajectory-events

## Summary

Use `dsh-distill-trajectory-events` to record what an agent did while it worked, rather than reconstructing it from prose afterwards. A `TrajectoryRecorder` subscribes to the session log and the live assistant stream and writes a structured raw event for every activity: turn and step boundaries, each model decision with its tool calls, every tool result, the request configuration, and streamed reasoning and text deltas.

Payloads are redacted before disk, and an oversized field becomes a content-addressed blob reference plus a bounded preview. Appends serialize in commit order and `flush()` drains the queue, so an attempt can prove its log is complete.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Build one recorder per attempt, mount it, and drain it before the attempt ends.

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

Each attempt writes:

```text
runs/<task_id>/<attempt_id>/
├── events.jsonl        one JSON object per line
└── blobs/<ab>/<sha256> oversized field content, redacted
```

### Recorded event kinds

| `event_type` | Recorded for |
|---|---|
| `task_start` | `turn/start`, `step/start`, the admitted user message, and each request header or context |
| `assistant_message` | The model's assembled message, its decision, its tool calls, and its token usage |
| `assistant_attempt` | A settled attempt that committed no model-visible message |
| `reasoning_delta` | Each streamed reasoning delta, and each text delta labelled `stream: 'text'` |
| `tool_call` / `tool_result` | One tool invocation and its model-facing outcome, paired by `tool_call_id` |
| `task_end` / `attempt_end` | `step/end` and `turn/end`, including the turn's end reason |
| `evaluator` / `error` / `cancellation` | Written by the caller through `append()` |

### The event envelope

| Field | Meaning |
|---|---|
| `event_id` | Random UUID for this event |
| `seq` | Position in this attempt's log, from 0 |
| `task_id`, `attempt_id`, `batch_id` | The attempt's identity, stamped on every event |
| `event_type` | The kind of activity |
| `timestamp` | UTC ISO-8601 with milliseconds |
| `monotonic_ms` | Milliseconds since the module loaded, for intervals that survive a clock jump |
| `payload` | The redacted payload, with oversized fields replaced |

### Reasoning is reported, never invented

`decisionOf(blocks)` reports `reasoning_available: true` only when a reasoning block carried text. An absent block and an empty one are the same fact — the provider returned nothing — so both report `reasoning: null`.

### Blob references

A field whose serialized form exceeds `maxInlineBytes` (64 KiB by default) becomes:

```json
{
  "blob": { "sha256": "…", "bytes": 123456, "path": "blobs/ab/ab…" },
  "original_bytes": 123456,
  "preview": "…",
  "truncated": true
}
```

`boundedJson(value, budget)` produces the preview and is exported for callers that need the same bounded rendering. It always returns valid JSON for a JSON input: a container is committed only once its closing delimiter also fits, so a budget too small for a container emits nothing rather than an unparseable fragment.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Why the two-phase plan/append split

`plan()` redacts and spills, `append()` stamps identity and writes. Splitting them means the expensive part (hashing, writing blobs) runs before the sequence number is consumed, so a failed spill cannot leave a gap in the sequence.

### Ordering and failure

`append()` chains every write onto one promise, so events land in call order even when several are queued in the same tick. A failed append rejects its own caller; the chain itself continues, and the next event is still recorded. `flush()` awaits the chain.

### Event coverage

`record()` switches on the committed session event's type. Event types this package does not model are recorded generically as `phase: 'session-event'` with their type and data, so plugin-owned activity is captured rather than dropped.

The request header is recorded as configuration only: the tool schema list repeats on every header and describes the environment rather than the run, so it is left to the environment record.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The recorder, the decision projection, and the Cordis plugin |
| [`src/writer.ts`](src/writer.ts) | The append-only log, redaction-then-spill planning, and bounded JSON rendering |
| [`src/blobs.ts`](src/blobs.ts) | Content-addressed blob storage |
| — | No runtime invariant companion is published. The recorder owns only its own writer and queue, and no independent observation can diverge from them. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The trajectory a training pipeline consumes is assembled from this log by the distillation runner. Redaction rules and the secret keyring live in `@deepseek-ai/dsh-distill-redaction`.

-----

## Model Experience

None, as the recorder observes and persists events while the plugins it observes own every model-visible contribution.

#### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.
## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A nested oversized string yields no preview.** A partial string cannot be closed by its parent container, so the container is abandoned and `boundedJson` returns an empty prefix for that value. The field itself is still captured in full when the writer spills it to a blob; only the inline preview is empty.
- **The live stream is best-effort.** `agent/assistant-stream` frames are process-local and transient. A process loss mid-stream loses the deltas, while the settled `assistant/message` or `assistant/attempt` remains durable in the session log.
- **One recorder captures every session in the process.** The subscriptions are registered at the context they are mounted on, so a composition running several concurrent sessions through one recorder mixes them. A distillation attempt runs one session.
- **File changes are recorded by the caller.** `file_change` events are written through `append()`; observing the filesystem is a separate concern.
- **No rotation or compaction.** `events.jsonl` grows for the life of an attempt and blobs are never pruned.

<a id="dev-note"></a>
### Dev Note

One code path is not covered by the suite: the queue-recovery `catch` in `TrajectoryRecorder.append`. Exercising it requires a failing append, and the repository's suite treats the resulting rejected promise as unhandled even when the caller observes it, so the branch is left uncovered rather than asserted through a test that cannot pass cleanly.
