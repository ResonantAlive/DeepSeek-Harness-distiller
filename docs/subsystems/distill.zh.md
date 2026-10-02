# 蒸馏

[English](distill.md) | 中文

教师模型轨迹蒸馏：一个离线应用记录教师 agent 在语料任务上的所作所为，供学生模型训练。本子系统拥有轨迹捕获服务、单次尝试写入的原始事件日志、由该日志组装出的轨迹文档、这些文档落盘的数据集布局，以及决定一台主机同时跑多少任务的资源切分。任务定义、尝试循环与评估器见[包 README](../../packages/distill/distill/README.zh.md)；组装它们的应用是 pps/distill。

源码：[`packages/distill/trajectory-events/src/index.ts`](../../packages/distill/trajectory-events/src/index.ts)

## 轨迹捕获服务

`ctx.distillCapture` 是一个进程内蒸馏工作的读取侧。trajectory-events 插件贡献它，组合读取它一次，为每次尝试绑定一个 recorder。

捕获观察的是会话日志而不是循环：它订阅已提交的事件并写入该次尝试的原始日志，因此新增会话事件的插件**无需知道本子系统存在**就会被捕获。绑定以尝试为单位 —— 之后绑定的 recorder 取代先前的，而释放一个已被取代的 recorder 不会影响当前绑定的那个。

```ts
import { Context } from '@deepseek-ai/cordis'
import { apply, captureOf } from '@deepseek-ai/dsh-distill-trajectory-events'

const ctx = new Context()
apply(ctx)
// The composition reads the capture once and hands it to each attempt.
const capture = captureOf(ctx)
```

## 一次尝试记录了什么

原始日志按事件逐行记录，流式文本与超大取值溢出到旁边的 blob。轨迹文档在事后由该日志组装，包含教师身份、观察/决策/动作步骤、产物以及评估器的判定。从进程环境收集的密钥在落盘途中被脱敏，因此到达工具调用或命令行的凭据不会进入数据集。

## 文档落在哪里

任务文档落在其结果所命名的桶 —— `success/`、`abandoned/`，或 `invalid/` 下带原因的目录 —— 而**每一次未被选为成功的尝试都单独归档在 `failed/` 下**。因此在后续尝试才成功的任务，仍保留早先尝试做过什么的记录。

## 资源切分

运行**测量**主机而不是假设它，因为容器通常被授予比机器报告的更少资源。测得的数字决定主机切分成几个 batch、同时运行多少任务，而主机装不下的方案在**任何东西启动之前**就被拒绝。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [AssistantStreamFrame](core.zh.md) · [Session](session.zh.md) · [SessionEvent](session.zh.md)

Source: [`packages/distill/trajectory-events/src/index.ts`](../../packages/distill/trajectory-events/src/index.ts)
<!-- END GENERATED cordis-surface -->
