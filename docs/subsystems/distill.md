# Distillation

English | [中文](distill.zh.md)

Teacher-model trajectory distillation: an offline application records what a teacher agent did on a corpus task, so a student model can be trained on it. The subsystem owns the trajectory capture service, the raw event log an attempt writes, the trajectory document assembled from it, the dataset layout those documents land in, and the resource partitioning that decides how many tasks a host runs at once. Task definitions, the attempt loop, and the evaluator are on the [package README](../../packages/distill/distill/README.md); the application that composes them is pps/distill.

Source: [`packages/distill/trajectory-events/src/index.ts`](../../packages/distill/trajectory-events/src/index.ts)

## The trajectory capture service

`ctx.distillCapture` is the read side of one process's distillation work. The trajectory-events plugin contributes it, and a composition reads it once to bind a recorder per attempt.

The capture observes the session log rather than the loop: it subscribes to committed events and writes the attempt's raw log, so a plugin that adds a session event is captured without knowing this subsystem exists. Binding is per attempt — a recorder bound later supersedes an earlier one, and releasing a superseded recorder leaves the current one bound.

```ts
import { Context } from '@deepseek-ai/cordis'
import { apply, captureOf } from '@deepseek-ai/dsh-distill-trajectory-events'

const ctx = new Context()
apply(ctx)
// The composition reads the capture once and hands it to each attempt.
const capture = captureOf(ctx)
```

## What an attempt records

The raw log holds one line per observed event, with streamed text and oversized values spilled to blobs beside it. The trajectory document is assembled from that log afterwards, and carries the teacher identity, the observation/decision/action steps, the artifacts, and the evaluator's judgment. Secrets collected from the process environment are redacted on the way to disk, so a credential reaching a tool call or a command line does not reach the dataset.

## Where documents land

A task's document lands in the bucket its outcome names — `success/`, `abandoned/`, or `invalid/` with a reason below it — and every attempt that was not the selected success is archived under `failed/` on its own. A task that succeeded on a later attempt therefore keeps the record of what its earlier attempts did.

## Resource partitioning

A run measures the host rather than assuming it, because a container is usually granted less than the machine reports. The measured figures decide how many batches the host is partitioned into and how many tasks run at once, and a plan the host cannot hold is refused before anything starts.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdistillcapture--trajectorycapture"></a>

### `ctx.distillCapture` — `TrajectoryCapture`

Routes the live session and stream events of one run to the attempt that is currently bound.

The plugin subscribes once, at mount, because a subscription per attempt would accumulate for the life of the process. An attempt binds its own recorder for exactly its own lifetime, so events never cross between attempts. The plugin needs no configuration: an attempt's recorder already owns its destination and its redaction rules.

```ts cordis-catalog
/**
 * Route this run's events to one attempt's recorder until released.
 * @param recorder - the attempt's recorder.
 * @returns a function that unbinds; a second call is a no-op.
 */
bind(recorder: TrajectoryRecorder): () => void

/**
 * Record one committed session event against the bound attempt.
 * @param session - the session that committed it.
 * @param event - the committed event.
 */
record(session: Session, event: SessionEvent): void

/**
 * Record one live assistant stream frame against the bound attempt.
 * @param frame - the stream frame the adapter produced.
 */
recordStreamFrame(frame: AssistantStreamFrame): void
```

Types: [AssistantStreamFrame](core.md) · [Session](session.md) · [SessionEvent](session.md)

Source: [`packages/distill/trajectory-events/src/index.ts`](../../packages/distill/trajectory-events/src/index.ts)
<!-- END GENERATED cordis-surface -->
