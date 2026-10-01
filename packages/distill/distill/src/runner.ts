/**
 * Attempt lifecycle for one task.
 *
 * A task runs up to `max_attempts` independent attempts. Each attempt starts from
 * a fresh workspace, records its own raw events, is judged by the same objective
 * evaluator, and stops the loop as soon as one succeeds. Attempts are independent:
 * nothing from an earlier attempt enters a later one unless the task asks for
 * failure feedback, which is recorded in the trajectory when it is on.
 *
 * The agent itself is behind {@link AgentRunner}, so the lifecycle is testable
 * with a scripted teacher and usable with a real composition.
 *
 * @module @deepseek-ai/dsh-distill/runner
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createRecorder } from '@deepseek-ai/dsh-distill-trajectory-events'
import type { TrajectoryRecorder } from '@deepseek-ai/dsh-distill-trajectory-events'
import type { RawEvent } from '@deepseek-ai/dsh-distill-trajectory-events/writer'
import { evaluateTask, fingerprintDirectory, integrityFlags, stageAssets } from './evaluator.ts'
import type { EvaluationResult } from './evaluator.ts'
import { buildTrajectory } from './trajectory.ts'
import type { AttemptTrajectory, FileChange } from './trajectory.ts'
import { prepareWorkspace } from './workspace.ts'
import { bucketFor, DatasetWriter } from './dataset.ts'
import type { ErrorClass, IntegrityFlag, Status, TaskDefaults, TaskDefinition } from './types.ts'

/** One attempt's identity and directories. */
export interface AttemptContext {
  /** The task being run. */
  readonly task: TaskDefinition
  /** Zero-based attempt ordinal; the identity is `attempt_<ordinal+1 padded>`. */
  readonly ordinal: number
  /** The attempt's identity, used in every path and event. */
  readonly attemptId: string
  /** The batch the task belongs to. */
  readonly batchId: string
  /** The agent's working directory. */
  readonly workspace: string
  /** The evaluator's directory. */
  readonly evaluatorDir: string
  /** The attempt's recorder. */
  readonly recorder: TrajectoryRecorder
  /** The prompt to submit, including failure feedback when the task asks for it. */
  readonly prompt: string
  /**
   * The attempt's budgets, resolved from the task and the manifest defaults.
   *
   * The agent side owns the turn, so it is the side that can act on a deadline
   * or a step budget; the runner records whatever the turn produced either way.
   */
  readonly limits: AttemptLimits
}

/** The bounds one attempt runs under. */
export interface AttemptLimits {
  /** Milliseconds the attempt may run before it is abandoned. */
  readonly attempt_timeout_ms?: number
  /** Assistant steps the attempt may take. */
  readonly max_steps_per_attempt?: number
  /** Tokens the attempt may spend, counted from the adapter's own usage. */
  readonly max_tokens_per_attempt?: number
  /** Identical consecutive tool calls that mark the attempt as stuck. */
  readonly repeat_action_limit?: number
}

/** What one attempt produced. */
export interface AttemptOutcome {
  /** The attempt's final status. */
  readonly status: Status
  /** The class of the terminal error, when the status is `ERROR`. */
  readonly errorClass?: ErrorClass
  /** A one-line explanation recorded in the trajectory. */
  readonly reason: string
}

/** The agent side of one attempt. */
export interface AgentRunner {
  /**
   * Run one attempt to completion.
   * @param context - the attempt's identity, workspace, recorder, and prompt.
   * @returns the attempt's outcome.
   */
  run(context: AttemptContext): Promise<AttemptOutcome>
}

/** The runner's configuration. */
export interface RunTaskOptions {
  /** The task to run. */
  readonly task: TaskDefinition
  /** Values applied where the task omits them. */
  readonly defaults: TaskDefaults
  /** Directory holding every workspace template. */
  readonly templatesRoot: string
  /** Directory holding each task's hidden evaluator assets. */
  readonly evaluatorRoot: string
  /** Directory this task's attempt directories are created under. */
  readonly runsRoot: string
  /** The dataset writer that receives the assembled trajectory. */
  readonly dataset: DatasetWriter
  /** The agent side. */
  readonly agent: AgentRunner
  /** Literal secrets to redact from every recorded event. */
  readonly secrets?: readonly string[]
  /**
   * The teacher model every attempt must run under. When set, an attempt whose
   * recorded model differs is flagged `model_mismatch` and never enters the
   * success bucket, because a trajectory must be attributable to one teacher.
   */
  readonly expectedTeacherModel?: string
}

/** One task's result. */
export interface TaskResult {
  /** The task's identity. */
  readonly taskId: string
  /** The task's final status. */
  readonly status: Status
  /** The class of the terminal error, when the status is `ERROR`. */
  readonly errorClass?: ErrorClass
  /** Every attempt, in order. */
  readonly attempts: readonly AttemptTrajectory[]
  /** The attempt that succeeded, when one did. */
  readonly selectedAttemptId: string | null
  /** Integrity problems raised across the attempts. */
  readonly integrityFlags: readonly IntegrityFlag[]
  /** The directory the task was written under, relative to the dataset root. */
  readonly datasetDir: string
  /** Why the task was abandoned, when it was. */
  readonly abandonReason?: string
}

/**
 * Zero-padded attempt identity.
 * @param ordinal - the zero-based attempt index.
 * @returns the identity, as `attempt_001` for the first attempt.
 */
export function attemptIdFor(ordinal: number): string {
  return `attempt_${String(ordinal + 1).padStart(3, '0')}`
}

/**
 * Resolve one attempt's budgets, letting the task override the manifest.
 * @param task - the task, whose own fields win.
 * @param defaults - the manifest's shared values.
 * @returns only the limits that are stated somewhere.
 */
export function attemptLimits(task: TaskDefinition, defaults: TaskDefaults): AttemptLimits {
  const timeout = task.attempt_timeout_ms ?? defaults.attempt_timeout_ms
  const steps = task.max_steps_per_attempt ?? defaults.max_steps_per_attempt
  const tokens = task.max_tokens_per_attempt ?? defaults.max_tokens_per_attempt
  const repeats = task.repeat_action_limit ?? defaults.repeat_action_limit
  return {
    ...timeout === undefined ? {} : { attempt_timeout_ms: timeout },
    ...steps === undefined ? {} : { max_steps_per_attempt: steps },
    ...tokens === undefined ? {} : { max_tokens_per_attempt: tokens },
    ...repeats === undefined ? {} : { repeat_action_limit: repeats },
  }
}

/**
 * Compose the prompt for one attempt.
 * @param task - the task.
 * @param options - whether failure feedback is requested and what the last failure was.
 * @returns the prompt to submit.
 */
export function promptFor(
  task: TaskDefinition,
  options: { carryFailureFeedback: boolean; lastFailure?: string },
): string {
  const parts = [task.prompt]
  if (task.initial_context !== undefined && task.initial_context.length > 0) {
    parts.push(task.initial_context)
  }
  if (options.carryFailureFeedback && options.lastFailure !== undefined) {
    parts.push(`A previous attempt failed: ${options.lastFailure}`)
  }
  return parts.join('\n\n')
}

/** Read the `<task>/<attempt>` raw events back from disk. */
async function readEvents(path: string): Promise<RawEvent[]> {
  const { readFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  if (!existsSync(path)) return []
  const text = await readFile(path, 'utf8')
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as RawEvent)
}

/**
 * Run one task through its attempt loop and write its dataset entry.
 *
 * Attempts stop as soon as one succeeds. A failed attempt consumes its slot; an
 * infrastructure error consumes one only when the defaults say so, and the
 * separate infrastructure budget stops a broken environment from looping forever.
 *
 * @param options - the task, its paths, the agent side, and the dataset writer.
 * @returns the task's result, including every attempt trajectory.
 */
export async function runTask(options: RunTaskOptions): Promise<TaskResult> {
  const { task, defaults, dataset } = options
  const carryFeedback = task.carry_failure_feedback ?? defaults.carry_failure_feedback ?? false
  const maxAttempts = task.max_attempts ?? defaults.max_attempts ?? 5
  const infraConsumes = defaults.infra_error_consumes_attempt ?? false
  const infraMax = defaults.infra_error_max ?? 15
  const batch = task.batch ?? defaults.batch ?? 0
  const batchId = `batch_${String(batch)}`
  const taskRoot = join(options.runsRoot, task.task_id)
  const assetRoot = join(options.evaluatorRoot, task.task_id)

  const trajectories: AttemptTrajectory[] = []
  const allFlags = new Set<IntegrityFlag>()
  let status: Status = 'ABANDONED'
  let errorClass: ErrorClass | undefined
  let selectedAttemptId: string | null = null
  let lastFailure: string | undefined
  let infraErrors = 0
  let consumed = 0

  // `ordinal` counts attempts run; `consumed` counts the attempts charged against
  // the budget. An infrastructure error that is not charged still runs another
  // attempt, so the two counters advance independently — and an absolute ceiling
  // keeps a permanently broken environment from looping forever.
  const attemptCeiling = maxAttempts * 4 + 10
  for (let ordinal = 0; ; ordinal++) {
    if (ordinal >= attemptCeiling) {
      status = 'ERROR'
      errorClass = 'infrastructure'
      break
    }
    const attemptId = attemptIdFor(ordinal)
    const attemptRoot = join(taskRoot, attemptId)
    const workspace = join(attemptRoot, 'workspace')
    const evaluatorDir = join(attemptRoot, 'evaluator')
    await mkdir(attemptRoot, { recursive: true })
    await prepareWorkspace(task.workspace, options.templatesRoot, workspace)
    if ((task.evaluator.assets ?? []).length > 0) {
      await stageAssets(assetRoot, evaluatorDir, task.evaluator.assets ?? [])
    } else {
      await mkdir(evaluatorDir, { recursive: true })
    }

    // Fingerprints taken before the agent runs are what make tampering detectable
    // afterwards: the evaluator's own assets and the scaffold it was given.
    const assetsBefore = await fingerprintDirectory(evaluatorDir)
    const scaffoldBefore = await fingerprintDirectory(workspace)

    const recorder = createRecorder({
      root: attemptRoot,
      taskId: task.task_id,
      attemptId,
      batchId,
      ...options.secrets === undefined ? {} : { secrets: options.secrets },
    })
    const context: AttemptContext = {
      task,
      ordinal,
      attemptId,
      batchId,
      workspace,
      evaluatorDir,
      recorder,
      prompt: promptFor(task, {
        carryFailureFeedback: carryFeedback,
        ...lastFailure === undefined ? {} : { lastFailure },
      }),
      limits: attemptLimits(task, defaults),
    }
    await recorder.append('task_start', {
      task_id: task.task_id,
      attempt: ordinal,
      prompt: context.prompt,
      workspace,
      evaluator_kind: task.evaluator.kind,
      tools: task.tools ?? defaults.tools ?? null,
    })

    let outcome: AttemptOutcome
    try {
      outcome = await options.agent.run(context)
    } catch (error) {
      outcome = {
        status: 'ERROR',
        errorClass: 'infrastructure',
        reason: `agent execution threw: ${(error as Error).message}`,
      }
    }
    await recorder.flush()

    const assetsAfter = await fingerprintDirectory(evaluatorDir)
    const scaffoldAfter = await fingerprintDirectory(workspace)
    const flags = integrityFlags({ assetsBefore, assetsAfter, scaffoldBefore, scaffoldAfter })
    // The events are read once and used for both the identity check and the
    // assembled trajectory.
    const events = await readEvents(join(attemptRoot, 'events.jsonl'))
    const inspected = buildTrajectory(events, {
      attemptId,
      status: 'UNKNOWN',
      integrityFlags: [],
      evaluation: null,
      fileCapture: { git: false, coverage: 'file-tools-only' },
    })
    // The teacher's identity is verified against what the attempt recorded. The
    // provider's own answer outranks the request, because a request can name an
    // alias while a different deployment actually answered.
    const attributed = inspected.teacher.served_model ?? inspected.teacher.model
    if (options.expectedTeacherModel !== undefined && attributed !== options.expectedTeacherModel) {
      flags.push('model_mismatch')
      allFlags.add('model_mismatch')
    }
    for (const flag of flags) allFlags.add(flag)
    // A changed scaffold is the agent's own doing; it is reported but does not
    // change the verdict, which the evaluator still owns.
    const changes: FileChange[] = []
    for (const path of Object.keys(scaffoldAfter)) {
      const previous = scaffoldBefore[path]
      const change = previous === undefined ? 'created' : previous === scaffoldAfter[path] ? undefined : 'modified'
      if (change !== undefined) changes.push({ path, change })
    }
    for (const path of Object.keys(scaffoldBefore)) {
      if (scaffoldAfter[path] === undefined) changes.push({ path, change: 'deleted' })
    }

    let evaluation: EvaluationResult | undefined
    if (outcome.status === 'ERROR' && outcome.errorClass === 'infrastructure') {
      // The agent never finished, so judging its work would measure the broken
      // environment rather than the model.
      await recorder.append('evaluator', {
        skipped: true,
        reason: outcome.reason,
        error_class: 'infrastructure',
      })
    } else {
      evaluation = await evaluateTask(task.evaluator, task.checks ?? [], { workspace, evaluator: evaluatorDir })
      await recorder.append('evaluator', {
        status: evaluation.status,
        reason: evaluation.reason,
        error_class: evaluation.error_class ?? null,
        entries: evaluation.entries,
      })
    }
    await recorder.flush()

    const attemptStatus: Status = evaluation?.status ?? outcome.status
    await recorder.append('attempt_end', {
      status: attemptStatus,
      reason: evaluation?.reason ?? outcome.reason,
      integrity_flags: flags,
    })
    await recorder.flush()

    trajectories.push(buildTrajectory(events, {
      attemptId,
      status: attemptStatus,
      integrityFlags: flags,
      evaluation: evaluation ?? null,
      fileCapture: { git: false, coverage: 'file-tools-only' },
      fileChanges: changes,
    }))

    if (attemptStatus === 'SUCCESS' && flags.length === 0) {
      status = 'SUCCESS'
      selectedAttemptId = attemptId
      break
    }
    if (attemptStatus === 'SUCCESS' && flags.length > 0) {
      // A tampered attempt never enters the success bucket even though its
      // evaluator passed, so the task keeps its slot and tries again.
      lastFailure = `attempt ${attemptId} passed but raised ${flags.join(', ')}`
      consumed += 1
      if (consumed >= maxAttempts) {
        status = 'FAILED'
        break
      }
      continue
    }
    if (attemptStatus === 'UNKNOWN') {
      // Without a usable evaluator nothing objective was measured, so retrying
      // would not produce a judgment either.
      status = 'UNKNOWN'
      break
    }
    const isInfrastructure = evaluation?.error_class === 'infrastructure'
      || (outcome.status === 'ERROR' && outcome.errorClass === 'infrastructure')
    if (isInfrastructure) {
      infraErrors += 1
      if (infraErrors >= infraMax) {
        status = 'ERROR'
        errorClass = 'infrastructure'
        break
      }
      if (!infraConsumes) {
        lastFailure = evaluation?.reason ?? outcome.reason
        continue
      }
    }
    consumed += 1
    lastFailure = evaluation?.reason ?? outcome.reason
    if (consumed >= maxAttempts) {
      // The budget is spent. An agent-side error keeps its identity; anything else
      // that never succeeded is abandoned.
      status = attemptStatus === 'ERROR' ? 'ERROR' : 'ABANDONED'
      errorClass = attemptStatus === 'ERROR' ? (outcome.errorClass ?? 'agent') : undefined
      break
    }
  }

  const finishedAt = new Date().toISOString()
  const document = {
    schema_version: '1.1',
    task_id: task.task_id,
    task: task.prompt,
    initial_context: task.initial_context ?? '',
    harness: { git_commit: null, version: '0.2.0-rc.2' },
    status,
    attempt_summary: { total: trajectories.length, selected_attempt_id: selectedAttemptId },
    attempts: trajectories,
    failure: status === 'SUCCESS' ? null : {
      type: status,
      reason: trajectories.at(-1)?.trajectory.length === 0 ? 'no steps recorded' : 'see the attempt evaluation',
    },
    metadata: {
      started_at: trajectories[0]?.started_at ?? finishedAt,
      finished_at: finishedAt,
      tags: task.tags ?? [],
    },
  }
  const bucket = bucketFor(status, errorClass)
  const datasetDir = await dataset.write(task.task_id, bucket, document)
  // Every attempt that did not become the selected success is archived in its
  // own directory, so a task that succeeded on a later attempt keeps the record
  // of what its earlier attempts did instead of dropping them.
  for (const attempt of trajectories) {
    if (attempt.attempt_id === selectedAttemptId) continue
    await dataset.writeAttempt(task.task_id, attempt.attempt_id, attempt)
  }
  await dataset.index({
    task_id: task.task_id,
    status,
    attempts: trajectories.length,
    selected_attempt_id: selectedAttemptId,
    integrity_flags: [...allFlags].sort(),
    teacher: {
      provider: trajectories.at(-1)?.teacher.provider ?? 'unknown',
      model: trajectories.at(-1)?.teacher.model ?? 'unknown',
    },
    file_capture: { git: false, coverage: 'file-tools-only' },
    started_at: trajectories[0]?.started_at ?? finishedAt,
    finished_at: finishedAt,
    dataset_dir: datasetDir,
  })

  return {
    taskId: task.task_id,
    status,
    ...errorClass === undefined ? {} : { errorClass },
    attempts: trajectories,
    selectedAttemptId,
    integrityFlags: [...allFlags].sort(),
    datasetDir,
    ...status === 'ABANDONED' ? { abandonReason: `all ${String(maxAttempts)} attempts failed` } : {},
  }
}

/**
 * Remove one attempt's directory tree.
 * @param runsRoot - the runs root.
 * @param taskId - the task identity.
 * @param attemptId - the attempt identity.
 */
export async function discardAttempt(runsRoot: string, taskId: string, attemptId: string): Promise<void> {
  await rm(join(runsRoot, taskId, attemptId), { recursive: true, force: true })
}
