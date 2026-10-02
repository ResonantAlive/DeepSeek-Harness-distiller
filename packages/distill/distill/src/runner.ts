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
import { evaluateTask, fingerprintDirectory, integrityFlags, snapshotContents, stageAssets, unifiedDiff } from './evaluator.ts'
import type { EvaluationResult } from './evaluator.ts'
import { buildTrajectory } from './trajectory.ts'
import type { FileDiff } from './trajectory.ts'
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
  /**
   * What the composition actually offered the attempt.
   *
   * The runner knows the task's declared tool spec, but only the composition
   * knows which tools its registry ended up holding. A caller that can enumerate
   * them states them here so the trajectory records what ran rather than what
   * was asked for.
   */
  readonly environment?: {
    /** Tool names the composition registered for this attempt. */
    readonly available_tools?: readonly string[]
    /** The sandbox mode the attempt ran under, when the composition pinned one. */
    readonly sandbox_mode?: string
  }
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
   * What the composition offered every attempt of this run.
   *
   * Only the caller can enumerate the tools its registry ended up holding, so
   * the runner records what it is told here rather than inferring it.
   */
  readonly environment?: {
    /** Tool names the composition registered. */
    readonly available_tools?: readonly string[]
    /** The sandbox mode the run is confined to. */
    readonly sandbox_mode?: string
  }
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
 * Read the attempt a task document summarises itself from.
 *
 * A task always runs at least one attempt, because the loop starts at the first
 * and stops only after judging one. Keeping that fact in one place is why this
 * exists: an inline `trajectories[0]?.field ?? fallback` at each use would leave
 * an unreachable fallback in the document instead of one guarded read.
 *
 * @param trajectories - the attempts the task recorded.
 * @param end - which end to read: the attempt that started it, or the one that ended it.
 * @returns the attempt at that end.
 * @throws Error when the task recorded no attempt at all.
 */
export function endAttempt(
  trajectories: readonly AttemptTrajectory[],
  end: 'first' | 'last',
): AttemptTrajectory {
  const attempt = end === 'first' ? trajectories[0] : trajectories.at(-1)
  if (attempt === undefined) {
    throw new Error('a task document needs at least one attempt, but none was recorded')
  }
  return attempt
}

/**
 * The inside of every file an attempt changed.
 *
 * A path whose text was not kept on either side is left out rather than
 * described as unchanged, and so is one whose bytes changed while its decoded
 * text did not: a line diff describes text, and there is nothing to report about
 * text that reads the same.
 *
 * @param changes - the paths that changed, as the fingerprints report them.
 * @param before - the text kept before the attempt, by path.
 * @param after - the text kept after it, by path.
 * @returns one entry per changed path that has a difference to show.
 */
export function diffsFor(
  changes: readonly FileChange[],
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): FileDiff[] {
  const diffs: FileDiff[] = []
  for (const change of changes) {
    const earlier = before[change.path]
    const later = after[change.path]
    if (earlier === undefined && later === undefined) continue
    const diff = unifiedDiff(earlier, later)
    if (diff.length > 0) diffs.push({ path: change.path, change: change.change, diff })
  }
  return diffs
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
 * Sum the tokens the adapter reported for one attempt.
 * @param events - the attempt's raw events.
 * @returns the total of every usage payload the attempt recorded.
 */
export function totalTokens(events: readonly RawEvent[]): number {
  let total = 0
  for (const event of events) {
    if (event.event_type !== 'assistant_message') continue
    const usage = event.payload.usage
    if (usage === null || typeof usage !== 'object') continue
    const counts = usage as { inputTokens?: number; outputTokens?: number }
    total += (counts.inputTokens ?? 0) + (counts.outputTokens ?? 0)
  }
  return total
}

/**
 * Find one action the attempt repeated without making progress.
 * @param trajectory - the assembled attempt.
 * @param limit - how many identical consecutive calls count as stuck.
 * @returns the reason, or `undefined` when no run reached the limit.
 */
export function repeatedAction(trajectory: AttemptTrajectory, limit: number): string | undefined {
  let previous: string | undefined
  let run = 0
  for (const step of trajectory.trajectory) {
    const signature = step.actions.map(action => `${action.tool}(${action.arguments})`).join('|')
    if (signature.length === 0) {
      previous = undefined
      run = 0
      continue
    }
    run = signature === previous ? run + 1 : 1
    previous = signature
    if (run >= limit) {
      return `repeated the same tool call ${String(run)} times without progress`
    }
  }
  return undefined
}

/**
 * Report the budget an attempt's own record shows it exceeded.
 *
 * The bounds are checked against what the attempt recorded rather than what the
 * model claimed, so a turn that overran its steps, its tokens, or repeated one
 * action is rejected as over budget instead of being judged on its result.
 *
 * @param trajectory - the assembled attempt.
 * @param events - the attempt's raw events, which carry the adapter's usage.
 * @param limits - the attempt's budgets.
 * @returns the first breach, or `undefined` when the attempt stayed inside them.
 */
export function budgetBreach(
  trajectory: AttemptTrajectory,
  events: readonly RawEvent[],
  limits: AttemptLimits,
): string | undefined {
  const steps = trajectory.trajectory.length
  if (limits.max_steps_per_attempt !== undefined && steps > limits.max_steps_per_attempt) {
    return `took ${String(steps)} steps, over its budget of ${String(limits.max_steps_per_attempt)}`
  }
  if (limits.max_tokens_per_attempt !== undefined) {
    const tokens = totalTokens(events)
    if (tokens > limits.max_tokens_per_attempt) {
      return `spent ${String(tokens)} tokens, over its budget of ${String(limits.max_tokens_per_attempt)}`
    }
  }
  if (limits.repeat_action_limit !== undefined) {
    const repeated = repeatedAction(trajectory, limits.repeat_action_limit)
    if (repeated !== undefined) return repeated
  }
  return undefined
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

/**
 * Read the `<task>/<attempt>` raw events back from disk.
 *
 * A missing log reads as no events rather than as an error: an attempt that
 * never wrote one recorded nothing, which is a fact about the attempt.
 *
 * @param path - the attempt's `events.jsonl`.
 * @returns the events in commit order, or an empty list when there is no log.
 */
export async function readEvents(path: string): Promise<RawEvent[]> {
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
    // Read the asset list once: repeating `?? []` at the guard and the call left
    // a second fallback that the guard had already ruled out.
    const assets = task.evaluator.assets ?? []
    if (assets.length > 0) {
      await stageAssets(assetRoot, evaluatorDir, assets)
    } else {
      await mkdir(evaluatorDir, { recursive: true })
    }

    // Fingerprints taken before the agent runs are what make tampering detectable
    // afterwards: the evaluator's own assets and the scaffold it was given.
    const assetsBefore = await fingerprintDirectory(evaluatorDir)
    const scaffoldBefore = await fingerprintDirectory(workspace)
    const contentsBefore = await snapshotContents(workspace)

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
      ...options.environment === undefined ? {} : { environment: options.environment },
    }
    await recorder.append('task_start', {
      task_id: task.task_id,
      attempt: ordinal,
      prompt: context.prompt,
      workspace,
      evaluator_kind: task.evaluator.kind,
      tools: task.tools ?? defaults.tools ?? null,
      environment: {
        tools: task.tools ?? defaults.tools ?? null,
        available_tools: context.environment?.available_tools ?? null,
        sandbox_mode: context.environment?.sandbox_mode ?? null,
      },
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
    // A fingerprint says a file differs without saying how. The content read
    // before the attempt is what turns that into something a student model can
    // learn from, and a file that was not kept is left out rather than described
    // as unchanged.
    const contentsAfter = await snapshotContents(workspace)
    const diffs = diffsFor(changes, contentsBefore, contentsAfter)

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

    // A budget the attempt exceeded outranks its evaluator: however the work
    // turned out, this is not the run the corpus asked the teacher to produce.
    const breach = budgetBreach(inspected, events, context.limits)
    const attemptStatus: Status = breach !== undefined
      ? 'FAILED'
      // An evaluator that could not run measured nothing about the attempt, so
      // the attempt is unknown rather than failed: the model is not answerable
      // for a judgment that never happened.
      : evaluation?.error_class === 'infrastructure'
        ? 'UNKNOWN'
        : evaluation?.status ?? outcome.status
    await recorder.append('attempt_end', {
      status: attemptStatus,
      reason: breach ?? evaluation?.reason ?? outcome.reason,
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
      fileDiffs: diffs,
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
      // Nothing objective was measured, so retrying would not produce a
      // judgment either.
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
      // An attempt is ERROR only when no evaluator ran, which happens only for a
      // fault the agent itself classified, so the class is already known here.
      errorClass = attemptStatus === 'ERROR' ? outcome.errorClass : undefined
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
      reason: endAttempt(trajectories, 'last').trajectory.length === 0 ? 'no steps recorded' : 'see the attempt evaluation',
    },
    metadata: {
      started_at: endAttempt(trajectories, 'first').started_at,
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
      provider: endAttempt(trajectories, 'last').teacher.provider,
      model: endAttempt(trajectories, 'last').teacher.model,
    },
    file_capture: { git: false, coverage: 'file-tools-only' },
    started_at: endAttempt(trajectories, 'first').started_at,
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
