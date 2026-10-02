/**
 * Real-time trajectory capture for one attempt.
 *
 * The recorder subscribes to the session log and the live assistant stream and
 * writes a structured raw event for every activity the agent performs: turn and
 * step boundaries, the model's decisions, every tool call and its result, and the
 * adapters' request configuration. It never reconstructs activity from prose
 * logs after the fact, and it never fabricates reasoning the provider did not
 * return.
 *
 * Capture is live: each `session/event` is queued as it is committed, appends
 * serialize in commit order, and {@link TrajectoryRecorder.flush} drains the queue
 * so an attempt can prove its log is complete before it ends.
 *
 * @module @deepseek-ai/dsh-distill-trajectory-events
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { BlobStore } from './blobs.ts'
import { EventWriter } from './writer.ts'
import type { RawEvent } from './writer.ts'
import {
  LITERAL_RULE_ID,
  collectEnvironmentSecrets,
  createRedactor,
} from '@deepseek-ai/dsh-distill-redaction'
import type { Redactor } from '@deepseek-ai/dsh-distill-redaction'

/** The event kinds a distillation attempt records. */
export type RawEventType =
  | 'task_start'
  | 'assistant_message'
  | 'assistant_attempt'
  | 'reasoning_delta'
  | 'tool_call'
  | 'tool_result'
  | 'file_change'
  | 'evaluator'
  | 'attempt_end'
  | 'error'
  | 'task_end'
  | 'cancellation'

/** One recorded decision, projected from the model's message blocks. */
export interface DecisionRecord {
  /** Concatenated text blocks, verbatim. */
  readonly text: string
  /** Concatenated reasoning blocks, or `null` when the provider returned none. */
  readonly reasoning: string | null
  /** Whether {@link reasoning} came from the provider rather than being absent. */
  readonly reasoning_available: boolean
  /** Tool calls the model requested in this message, in block order. */
  readonly tool_calls: readonly { readonly tool_call_id: string; readonly tool: string; readonly arguments: string }[]
}

/**
 * Project one assistant message's blocks into a decision record.
 *
 * Reasoning is reported only when a reasoning block actually carries text. An
 * absent block and an empty one are the same fact — the provider returned no
 * reasoning — so both report `reasoning_available: false` with `reasoning: null`.
 *
 * @param content - the assistant message's content blocks.
 * @returns the decision text, reasoning, and requested tool calls.
 */
export function decisionOf(content: readonly ContentBlock[]): DecisionRecord {
  const text: string[] = []
  const reasoning: string[] = []
  const toolCalls: { tool_call_id: string; tool: string; arguments: string }[] = []
  for (const block of content) {
    if (block.type === 'text') { text.push(block.text); continue }
    if (block.type === 'reasoning') { reasoning.push(block.text); continue }
    if (block.type === 'tool-call') {
      toolCalls.push({ tool_call_id: String(block.id), tool: block.name, arguments: block.arguments })
    }
  }
  const reasoningText = reasoning.join('')
  return {
    text: text.join(''),
    reasoning: reasoningText.length === 0 ? null : reasoningText,
    reasoning_available: reasoningText.length > 0,
    tool_calls: toolCalls,
  }
}

/** The recorder's configuration. */
export interface TrajectoryRecorderOptions {
  /** Directory holding `events.jsonl` and `blobs/`. */
  readonly root: string
  /** The task identity stamped on every event. */
  readonly taskId: string
  /** The attempt identity stamped on every event. */
  readonly attemptId: string
  /** The batch identity stamped on every event. */
  readonly batchId: string
  /** Literal secrets to hide in addition to the built-in rules. */
  readonly secrets?: readonly string[]
  /** Rule ids to disable. */
  readonly disableRules?: readonly string[]
  /** Largest serialized field kept inline, in UTF-8 bytes. */
  readonly maxInlineBytes?: number
  /**
   * Blob storage for oversized fields. Omission stores under `<root>/blobs`. A
   * caller supplies one to redirect storage, or to exercise a spill failure.
   */
  readonly blobs?: BlobStore
}

/** Live capture for one attempt. */
export class TrajectoryRecorder {
  private readonly writer: EventWriter
  private readonly redactor: Redactor
  private queue: Promise<unknown> = Promise.resolve()
  private lastSequence = -1

  /**
   * @param options - destinations, identities, and redaction settings.
   */
  constructor(options: TrajectoryRecorderOptions) {
    this.redactor = createRedactor({
      ...options.secrets === undefined ? {} : { secrets: options.secrets },
      ...options.disableRules === undefined ? {} : { disable: options.disableRules },
    })
    this.writer = new EventWriter({
      root: options.root,
      taskId: options.taskId,
      attemptId: options.attemptId,
      batchId: options.batchId,
      redactor: this.redactor,
      blobs: options.blobs ?? new BlobStore({ root: `${options.root}/blobs` }),
      ...options.maxInlineBytes === undefined ? {} : { maxInlineBytes: options.maxInlineBytes },
    })
  }

  /** The `events.jsonl` path this recorder writes. */
  get path(): string {
    return this.writer.path
  }

  /** Number of events appended so far. */
  get length(): number {
    return this.writer.length
  }

  /** The sequence of the most recently recorded session event, or `-1`. */
  get lastSessionSequence(): number {
    return this.lastSequence
  }

  /** The redactor applied to every payload, exposed for archived artifacts. */
  get redaction(): Redactor {
    return this.redactor
  }

  /**
   * Queue one event. Appends run in call order, and the returned promise resolves
   * when this event has been flushed to disk.
   * @param eventType - the kind of activity recorded.
   * @param payload - the unredacted payload.
   * @returns the event as written.
   */
  append(eventType: RawEventType, payload: Readonly<Record<string, unknown>>): Promise<RawEvent> {
    const next = this.queue.then(() => this.writer.append({ event_type: eventType, payload }))
    // Keep the chain alive after a failed append so one write error cannot wedge
    // every later event; the caller still observes the rejection through `next`.
    this.queue = next.catch(() => undefined)
    return next
  }

  /**
   * Wait for every queued append to settle.
   * @returns after the last queued event has been written.
   */
  async flush(): Promise<void> {
    await this.queue
  }

  /**
   * Record one committed session event.
   * @param session - the session that committed it.
   * @param event - the committed event.
   */
  record(session: Session, event: SessionEvent): void {
    this.lastSequence = Math.max(this.lastSequence, event.seq)
    const base = { session_id: String(session.id), seq: event.seq, at: event.time }
    switch (event.type) {
      case 'turn/start':
        void this.append('task_start', { ...base, turn: event.data.turn })
        return
      case 'turn/end':
        void this.append('attempt_end', { ...base, turn: event.data.turn, reason: event.data.reason })
        return
      case 'step/start':
        void this.append('task_start', { ...base, phase: 'step-start', turn: event.data.turn, step: event.data.step })
        return
      case 'step/end':
        void this.append('task_end', { ...base, phase: 'step-end', turn: event.data.turn, step: event.data.step })
        return
      case 'user/message':
        void this.append('task_start', {
          ...base, phase: 'user-message', source: event.data.source, content: event.data.content,
        })
        return
      case 'assistant/message': {
        const decision = decisionOf(event.data.message.content)
        void this.append('assistant_message', {
          ...base,
          turn: event.data.turn,
          step: event.data.step,
          decision,
          usage: event.data.usage ?? null,
          interrupted: event.data.interrupted === true,
        })
        return
      }
      case 'assistant/attempt':
        void this.append('assistant_attempt', {
          ...base, turn: event.data.turn, step: event.data.step, stream: event.data.stream,
        })
        return
      case 'tool/call':
        void this.append('tool_call', {
          ...base,
          turn: event.data.turn,
          step: event.data.step,
          tool_call_id: String(event.data.callId),
          tool: event.data.name,
          arguments: event.data.arguments,
        })
        return
      case 'tool/result':
        void this.append('tool_result', {
          ...base,
          turn: event.data.turn,
          step: event.data.step,
          tool_call_id: String(event.data.message.toolCallId),
          is_error: event.data.message.isError === true,
          content: event.data.message.content,
          error: event.data.error ?? null,
          meta: event.data.meta ?? null,
        })
        return
      case 'request/header':
        // The tool schema list repeats on every header and is recorded once by the
        // environment instead; the call configuration is the durable fact here.
        void this.append('task_start', {
          ...base,
          phase: 'request-header',
          reason: event.data.reason,
          config: event.data.header.config,
          adapter_defaults: event.data.header.adapterDefaults ?? null,
        })
        return
      case 'request/context':
        void this.append('task_start', { ...base, phase: 'request-context', context: event.data })
        return
      default:
        // Plugin-owned event types are recorded generically rather than dropped;
        // an unknown type is still activity that happened.
        void this.append('task_start', { ...base, phase: 'session-event', type: event.type, data: event.data })
    }
  }

  /**
   * Record one live assistant stream frame. Deltas carry the streamed text, and a
   * usage frame carries the model the provider named; boundaries are already
   * durable as session events.
   * @param frame - the live frame published by the loop.
   */
  recordStreamFrame(frame: AssistantStreamFrame): void {
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) {
      void this.append('reasoning_delta', { index: chunk.index, text: chunk.text })
      return
    }
    if (chunk.type === 'text-delta' && chunk.text.length > 0) {
      void this.append('reasoning_delta', { index: chunk.index, text: chunk.text, stream: 'text' })
      return
    }
    if (chunk.type === 'usage' && chunk.servedModel !== undefined) {
      // Which model answered is a durable fact about the attempt, so it is
      // recorded rather than discarded with the rest of the usage frame.
      void this.append('task_start', { phase: 'response-header', model: chunk.servedModel })
    }
  }
}

/**
 * Record a token-usage payload as the trajectory's own accounting.
 * @param recorder - the attempt's recorder.
 * @param usage - the adapter-reported usage.
 * @returns after the event is flushed.
 */
export async function recordUsage(recorder: TrajectoryRecorder, usage: TokenUsage): Promise<RawEvent> {
  return recorder.append('assistant_message', { phase: 'usage', usage })
}

/** Cordis plugin name for the capture plugin. */
export const name = 'distill-trajectory-events'

/** Re-exported so a composition can build a recorder from the environment. */
export { collectEnvironmentSecrets, createRedactor, LITERAL_RULE_ID }
export type { Redactor }

/**
 * Build a recorder for one attempt.
 * @param options - destinations, identities, and redaction settings.
 * @returns a recorder whose secrets default to the launch environment's.
 */
export function createRecorder(options: TrajectoryRecorderOptions): TrajectoryRecorder {
  return new TrajectoryRecorder(options)
}

/**
 * Routes the live session and stream events of one run to the attempt that is
 * currently bound.
 *
 * The plugin subscribes once, at mount, because a subscription per attempt would
 * accumulate for the life of the process. An attempt binds its own recorder for
 * exactly its own lifetime, so events never cross between attempts. The plugin
 * needs no configuration: an attempt's recorder already owns its destination and
 * its redaction rules.
 */
export class TrajectoryCapture {
  private active: TrajectoryRecorder | undefined

  /** The bound recorder, or `undefined` between attempts. */
  get current(): TrajectoryRecorder | undefined {
    return this.active
  }

  /**
   * Route this run's events to one attempt's recorder until released.
   * @param recorder - the attempt's recorder.
   * @returns a function that unbinds; a second call is a no-op.
   */
  bind(recorder: TrajectoryRecorder): () => void {
    this.active = recorder
    let bound = true
    return () => {
      if (!bound) return
      bound = false
      if (this.active === recorder) this.active = undefined
    }
  }

  /**
   * Record one committed session event against the bound attempt.
   * @param session - the session that committed it.
   * @param event - the committed event.
   */
  record(session: Session, event: SessionEvent): void {
    this.active?.record(session, event)
  }

  /**
   * Record one live assistant stream frame against the bound attempt.
   * @param frame - the stream frame the adapter produced.
   */
  recordStreamFrame(frame: AssistantStreamFrame): void {
    this.active?.recordStreamFrame(frame)
  }
}

/**
 * Mount the capture plugin for one run.
 *
 * The capture is published as the `distillCapture` service, which is how the
 * attempt runner binds each attempt's recorder. A run that mounts this plugin
 * without binding an attempt records nothing, which is the state between
 * attempts rather than an error.
 *
 * @param ctx - the context that owns the subscriptions.
 */
export function apply(ctx: Context): void {
  const capture = new TrajectoryCapture()
  ctx.provide('distillCapture', capture)
  ctx.on('session/event', (session, event) => { capture.record(session, event) })
  ctx.on('agent/assistant-stream', ({ frame }) => { capture.recordStreamFrame(frame) })
}

/**
 * Read the capture a mounted plugin published.
 * @param ctx - the context the plugin was mounted on.
 * @returns the capture, or `undefined` when the plugin is not mounted.
 */
export function captureOf(ctx: Context): TrajectoryCapture | undefined {
  return ctx.get('distillCapture')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The trajectory capture, published by {@link apply}. */
    distillCapture: TrajectoryCapture
  }
}
