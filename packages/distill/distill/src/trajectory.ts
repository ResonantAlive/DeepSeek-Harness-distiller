/**
 * Trajectory assembly.
 *
 * Raw events are the append-only record; a trajectory is the training-facing
 * projection of one attempt, grouping every event into the steps a reader learns
 * from. Nothing here is captured from prose: each step's decision comes from the
 * model's own message, its actions from the tool calls, and its observations from
 * the tool results, all keyed by `tool_call_id`.
 *
 * A step may issue several tool calls at once, so a step carries `actions[]` and
 * `observations[]` rather than a single pair.
 *
 * @module @deepseek-ai/dsh-distill/trajectory
 */

import type { IntegrityFlag, Status } from './types.ts'
import type { RawEvent, SpilledField } from '@deepseek-ai/dsh-distill-trajectory-events/writer'

/** One model decision. */
export interface StepDecision {
  /** Concatenated assistant text. */
  readonly assistant_message: string
  /** Provider-returned reasoning, or `null` when none was returned. */
  readonly reasoning: string | null
  /** Whether the provider returned reasoning for this step. */
  readonly reasoning_available: boolean
  /** The reasoning effort in force for this step, when the header recorded one. */
  readonly reasoning_effort?: string
}

/** One tool invocation inside a step. */
export interface StepAction {
  /** Always `tool_call`; a terminal invocation is also a tool call. */
  readonly type: 'tool_call'
  /** Joins this action to its observation. */
  readonly tool_call_id: string
  /** The tool's registered name. */
  readonly tool: string
  /** The raw argument JSON exactly as the model produced it. */
  readonly arguments: string
}

/** One tool result inside a step. */
export interface StepObservation {
  /** Always `tool_result`. */
  readonly type: 'tool_result'
  /** The action this answers. */
  readonly tool_call_id: string
  /** Whether the tool reported a failure. */
  readonly is_error: boolean
  /** The model-facing content, with oversized fields replaced by blob references. */
  readonly content: unknown
  /** Structured failure identity, when the tool reported one. */
  readonly error: unknown
  /**
   * Milliseconds between the committed call and its committed result.
   *
   * `null` when the attempt recorded a result whose call it never recorded, so a
   * missing measurement is never reported as a fast tool.
   */
  readonly duration_ms: number | null
  /**
   * Terminal shape, present when the tool ran a shell command and recorded what
   * happened. `cwd` is the directory the call named, which is what a pure
   * projection of the call can see; a call that named none reports `null`.
   */
  readonly terminal?: {
    readonly shell: string
    readonly command: string | null
    readonly cwd: string | null
    readonly exit_code: number | null
    readonly signal: string | null
    readonly timed_out: boolean
    readonly aborted: boolean
    readonly stdout: string
    readonly stderr: string
  }
}

/** One file's change, attributed to the action that caused it. */
export interface FileChange {
  /** POSIX-relative path inside the workspace. */
  readonly path: string
  /** What happened to the path. */
  readonly change: 'created' | 'modified' | 'deleted'
  /** The action that caused it, when the change was attributed. */
  readonly tool_call_id?: string
}

/** One step of an attempt. */
export interface TrajectoryStep {
  /** Zero-based position within the attempt. */
  readonly step: number
  /** When the step's decision was recorded. */
  readonly timestamp: string
  /** What the model saw and decided. */
  readonly decision: StepDecision
  /** Every tool call the decision requested. */
  readonly actions: readonly StepAction[]
  /** Every result, in the same order as {@link actions}. */
  readonly observations: readonly StepObservation[]
  /** Files this step changed. */
  readonly file_changes: readonly FileChange[]
}

/** One attempt's assembled trajectory. */
export interface AttemptTrajectory {
  /** The attempt's identity. */
  readonly attempt_id: string
  /** The model configuration in force. */
  readonly teacher: {
    readonly provider: string
    readonly model: string
    readonly reasoning_effort: string | null
    readonly max_tokens: number | null
    /**
     * The sampling temperature the requests ran under, when the composition
     * stated one. A dataset consumer reproducing a trajectory needs it, and a
     * null says the composition left it to the provider rather than naming zero.
     */
    readonly temperature: number | null
    /**
     * The model the provider reported serving the request, when it named one.
     *
     * `model` is what the request asked for; this is what answered. They differ
     * behind an alias or a routed deployment, so an integrity check that must
     * attribute the trajectory to one teacher reads this.
     */
    readonly served_model: string | null
  }
  /** The attempt's final status. */
  readonly status: Status
  /**
   * What the attempt ran with: the declared tool spec, the tools the composition
   * actually registered, and the sandbox mode.
   *
   * `null` on a field means the attempt's record does not state it, which is a
   * different fact from an empty list.
   */
  readonly environment: {
    readonly tools: unknown
    readonly available_tools: readonly string[] | null
    readonly sandbox_mode: string | null
  }
  /**
   * The last failure the attempt recorded, in the form the recorder kept it.
   *
   * `null` when the attempt recorded no error event, so a reader can tell an
   * attempt that failed quietly from one that never failed at all.
   */
  readonly last_error: unknown
  /** When the attempt started, as recorded by its first event. */
  readonly started_at: string
  /** When the attempt ended, as recorded by its last event. */
  readonly finished_at: string
  /** Wall-clock duration in milliseconds. */
  readonly duration_ms: number
  /** The assembled steps. */
  readonly trajectory: readonly TrajectoryStep[]
  /** Files the attempt created, modified, and deleted. */
  readonly artifacts: {
    readonly files_created: readonly string[]
    readonly files_modified: readonly string[]
    readonly files_deleted: readonly string[]
  }
  /** Integrity problems detected after the attempt ran. */
  readonly integrity_flags: readonly IntegrityFlag[]
  /** How completely files were captured. */
  readonly file_capture: { readonly git: boolean; readonly coverage: string }
  /** The evaluator's judgment, when one ran. */
  readonly evaluation: unknown
  /** The attempt's final assistant text. */
  readonly final: string
}

/** Accumulator used while folding events into steps. */
interface Pending {
  decision: StepDecision
  timestamp: string
  actions: StepAction[]
  observations: StepObservation[]
}

/** The event `phase` values that are bookkeeping rather than a decision. */
const NON_DECISION_PHASES = new Set([
  'usage', 'request-header', 'request-context', 'session-event', 'user-message',
])

/**
 * Read the spill-aware text of a value that may have been replaced by a blob.
 * @param value - the stored value.
 * @returns the inline text, or the blob preview when the field spilled.
 */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  const spilled = value as Partial<SpilledField>
  if (spilled.truncated === true && typeof spilled.preview === 'string') return spilled.preview
  // A JSON value always serializes, so no fallback is reachable here.
  return JSON.stringify(value)
}

/**
 * The terminal facts of one tool result.
 *
 * A tool that ran a command records them in its result metadata, which is the
 * only place an exit code and the separated streams survive: the model-facing
 * content merges those streams into prose written for a reader. A result that
 * recorded no such metadata reports no terminal at all rather than rebuilding
 * one from the call's arguments, which would describe what was asked for instead
 * of what actually ran.
 *
 * @param payload - the recorded tool result.
 * @returns the terminal shape, or an empty object when no command ran.
 */
export function terminalOf(
  payload: Readonly<Record<string, unknown>>,
): Pick<StepObservation, 'terminal'> | Record<string, never> {
  const meta = payload.meta
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return {}
  const record = meta as Record<string, unknown>
  if (typeof record.shell !== 'string') return {}
  return {
    terminal: {
      shell: record.shell,
      command: typeof record.command === 'string' ? record.command : null,
      cwd: typeof record.workdir === 'string' ? record.workdir : null,
      exit_code: typeof record.exit_code === 'number' ? record.exit_code : null,
      signal: typeof record.signal === 'string' ? record.signal : null,
      timed_out: record.timed_out === true,
      aborted: record.aborted === true,
      stdout: typeof record.stdout === 'string' ? record.stdout : '',
      stderr: typeof record.stderr === 'string' ? record.stderr : '',
    },
  }
}

/** Extract the concatenated text of a tool-result content block list. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return textOf(content)
  return content
    .map((block) => {
      const typed = block as { type?: string; text?: string }
      return typed.type === 'text' ? typed.text ?? '' : ''
    })
    .join('')
}

/** The decision field names this builder accepts, normalized to the schema's. */
interface RawDecision {
  /** The recorder's field name. */
  readonly text?: string
  /** The schema's field name; either is accepted. */
  readonly assistant_message?: string
  readonly reasoning?: string | null
  readonly reasoning_available?: boolean
}

/**
 * Normalize a decision as recorded into the trajectory schema's field names.
 * @param raw - the decision as stored in an assistant-message event.
 * @returns the schema-shaped decision, defaulting an absent reasoning to `null`.
 */
function normalizeDecision(raw: RawDecision): StepDecision {
  const text = raw.assistant_message ?? raw.text ?? ''
  const reasoning = typeof raw.reasoning === 'string' && raw.reasoning.length > 0 ? raw.reasoning : null
  return {
    assistant_message: text,
    reasoning,
    // The provider's own report is authoritative: reasoning is available exactly
    // when it returned text, never because a flag said so.
    reasoning_available: reasoning !== null,
  }
}

/**
 * Assemble one attempt's trajectory from its raw events.
 * @param events - the attempt's events, in sequence order.
 * @param options - the attempt identity and integrity facts to carry into the result.
 * @returns the assembled trajectory.
 */
export function buildTrajectory(
  events: readonly RawEvent[],
  options: {
    attemptId: string
    status: Status
    integrityFlags: readonly IntegrityFlag[]
    evaluation: unknown
    fileCapture: { git: boolean; coverage: string }
    fileChanges?: readonly FileChange[]
  },
): AttemptTrajectory {
  const steps: TrajectoryStep[] = []
  let pending: Pending | undefined
  // When each call was committed, so a result can report how long its tool ran.
  const calledAt = new Map<string, number>()
  let stepIndex = 0
  let provider = 'unknown'
  let model = 'unknown'
  let reasoningEffort: string | null = null
  let maxTokens: number | null = null
  let servedModel: string | null = null
  let temperature: number | null = null
  let lastError: unknown = null
  let environment: AttemptTrajectory['environment'] = { tools: null, available_tools: null, sandbox_mode: null }
  let final = ''
  let headerReasoningEffort: string | undefined

  const flush = (): void => {
    if (pending === undefined) return
    steps.push({
      step: stepIndex,
      timestamp: pending.timestamp,
      decision: pending.decision,
      actions: pending.actions,
      observations: pending.observations,
      file_changes: (options.fileChanges ?? []).filter(change =>
        change.tool_call_id !== undefined && pending?.actions.some(action => action.tool_call_id === change.tool_call_id)),
    })
    stepIndex += 1
    pending = undefined
  }

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>
    if (event.event_type === 'assistant_message') {
      const phase = payload.phase
      if (typeof phase === 'string' && NON_DECISION_PHASES.has(phase)) continue
      const decision = payload.decision as RawDecision | undefined
      if (decision === undefined) continue
      flush()
      pending = {
        decision: {
          ...normalizeDecision(decision),
          // The header for this request is recorded before the assistant message,
          // so the effort in force is whatever the latest header declared.
          ...headerReasoningEffort === undefined ? {} : { reasoning_effort: headerReasoningEffort },
        },
        timestamp: event.timestamp,
        actions: [],
        observations: [],
      }
      if (typeof decision.assistant_message === 'string') final = decision.assistant_message
      else if (typeof decision.text === 'string') final = decision.text
      continue
    }
    if (event.event_type === 'tool_call') {
      const callId = String(payload.tool_call_id)
      calledAt.set(callId, event.monotonic_ms)
      pending?.actions.push({
        type: 'tool_call',
        tool_call_id: callId,
        tool: String(payload.tool),
        arguments: String(payload.arguments),
      })
      continue
    }
    if (event.event_type === 'tool_result') {
      const callId = String(payload.tool_call_id)
      const content = contentText(payload.content)
      const startedAt = calledAt.get(callId)
      pending?.observations.push({
        type: 'tool_result',
        tool_call_id: callId,
        is_error: payload.is_error === true,
        // A block list becomes its concatenated text; any other value keeps its
        // recorded form, including a blob preview.
        content: Array.isArray(payload.content) ? content : textOf(payload.content),
        error: payload.error ?? null,
        // The gap between the committed call and its committed result, which is
        // how long the tool actually took rather than how long the turn did.
        duration_ms: startedAt === undefined ? null : Math.max(0, event.monotonic_ms - startedAt),
        ...terminalOf(payload),
      })
      if (content.length > 0) final = content
      continue
    }
    if (event.event_type === 'error') {
      // The latest failure is the one that ended the attempt, so each error
      // replaces the last rather than accumulating.
      lastError = payload
      continue
    }
    if (event.event_type === 'task_start' && payload.environment !== undefined) {
      const seen = payload.environment as {
        tools?: unknown
        available_tools?: readonly string[] | null
        sandbox_mode?: string | null
      }
      environment = {
        tools: seen.tools ?? null,
        available_tools: seen.available_tools ?? null,
        sandbox_mode: seen.sandbox_mode ?? null,
      }
      continue
    }
    if (event.event_type === 'task_start' && payload.phase === 'request-header') {
      const config = payload.config as {
        provider?: string
        model?: string
        reasoningEffort?: string
        temperature?: number
        maxTokens?: number
      } | undefined
      if (config !== undefined) {
        provider = config.provider ?? provider
        model = config.model ?? model
        reasoningEffort = config.reasoningEffort ?? reasoningEffort
        maxTokens = config.maxTokens ?? maxTokens
        temperature = config.temperature ?? temperature
        headerReasoningEffort = config.reasoningEffort
      }
      continue
    }
    if (event.event_type === 'task_start' && payload.phase === 'response-header') {
      // The provider's own answer to "which model served this" outranks the
      // request, which can name an alias rather than the deployment behind it.
      if (typeof payload.model === 'string' && payload.model.length > 0) servedModel = payload.model
    }
  }
  flush()

  const first = events[0]
  const last = events.at(-1)
  const startedAt = first?.timestamp ?? new Date(0).toISOString()
  const finishedAt = last?.timestamp ?? startedAt
  return {
    attempt_id: options.attemptId,
    teacher: { provider, model, reasoning_effort: reasoningEffort, max_tokens: maxTokens, served_model: servedModel, temperature },
    last_error: lastError,
    environment,
    status: options.status,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
    trajectory: steps,
    artifacts: {
      files_created: (options.fileChanges ?? []).filter(change => change.change === 'created').map(change => change.path).sort(),
      files_modified: (options.fileChanges ?? []).filter(change => change.change === 'modified').map(change => change.path).sort(),
      files_deleted: (options.fileChanges ?? []).filter(change => change.change === 'deleted').map(change => change.path).sort(),
    },
    integrity_flags: options.integrityFlags,
    file_capture: options.fileCapture,
    evaluation: options.evaluation,
    final,
  }
}
