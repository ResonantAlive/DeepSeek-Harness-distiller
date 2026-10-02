/**
 * Distillation runner entry point.
 *
 * Usage:
 *   node --import tsx/esm apps/distill/src/bin.ts --manifest <path> --out <dir> \
 *     [--templates <dir>] [--evaluators <dir>] [--runs <dir>] [--task <task_id>]...
 *
 * The runner owns the paths and the dataset; the agent side is supplied by a
 * caller-provided `AgentRunner`, so this entry point is also usable with a
 * scripted teacher in tests.
 *
 * @module @deepseek-ai/dsh-distill/bin
 */

import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatasetWriter, rateLimitOf, RateLimitGate } from '@deepseek-ai/dsh-distill'
import { loadTasks } from '@deepseek-ai/dsh-distill'
import { runTask } from '@deepseek-ai/dsh-distill'
import type { AgentRunner } from '@deepseek-ai/dsh-distill'
import { collectEnvironmentSecrets } from '@deepseek-ai/dsh-distill-redaction'
import { availableToolsOf, bootDistillComposition, pinnedTeacher } from './composition.ts'
import type {} from '@deepseek-ai/dsh-tools'
import { createAgentRunner } from './agent-runner.ts'

/** Parsed command line. */
export interface RunnerArgs {
  /** The task manifest to load. */
  readonly manifest: string
  /** Directory the dataset is written to. */
  readonly out: string
  /** Directory holding workspace templates; defaults to `<manifest dir>/../templates`. */
  readonly templates?: string
  /** Directory holding hidden evaluator assets; defaults to `<manifest dir>/../evaluator`. */
  readonly evaluators?: string
  /** Directory holding per-attempt run directories; defaults to `<out dir>/../runs`. */
  readonly runs?: string
  /** Task ids to run; omission runs every task. */
  readonly only?: readonly string[]
  /** Milliseconds one attempt may run before it is abandoned. */
  readonly attemptTimeoutMs?: number
  /** Attempts the run may have in flight against the provider. */
  readonly maxConcurrentTasks?: number
  /** Milliseconds to hold back when a rate limit states no wait. */
  readonly rateLimitBackoffMs?: number
}

/**
 * Parse the runner's arguments.
 * @param argv - arguments after the script name.
 * @returns the parsed arguments.
 * @throws Error when a required argument is missing or unknown.
 */
export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  let manifest: string | undefined
  let out: string | undefined
  let templates: string | undefined
  let evaluators: string | undefined
  let runs: string | undefined
  let attemptTimeoutMs: number | undefined
  let maxConcurrentTasks: number | undefined
  let rateLimitBackoffMs: number | undefined
  const only: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = argv[index + 1]
    const take = (): string => {
      if (value === undefined || value.startsWith('--')) throw new Error(`${String(flag)} needs a value`)
      index += 1
      return value
    }
    switch (flag) {
      case '--manifest': manifest = take(); break
      case '--out': out = take(); break
      case '--templates': templates = take(); break
      case '--evaluators': evaluators = take(); break
      case '--runs': runs = take(); break
      case '--task': only.push(take()); break
      case '--attempt-timeout-ms': {
        const raw = take()
        const parsed = Number(raw)
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`--attempt-timeout-ms must be a positive number, received ${raw}`)
        }
        attemptTimeoutMs = parsed
        break
      }
      case '--max-concurrent-tasks': {
        const raw = take()
        const parsed = Number(raw)
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`--max-concurrent-tasks must be a positive whole number, received ${raw}`)
        }
        maxConcurrentTasks = parsed
        break
      }
      case '--rate-limit-backoff-ms': {
        const raw = take()
        const parsed = Number(raw)
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`--rate-limit-backoff-ms must be a non-negative number, received ${raw}`)
        }
        rateLimitBackoffMs = parsed
        break
      }
      default: throw new Error(`unknown argument ${JSON.stringify(String(flag))}`)
    }
  }
  if (manifest === undefined) throw new Error('--manifest is required')
  if (out === undefined) throw new Error('--out is required')
  return {
    manifest: resolve(manifest),
    out: resolve(out),
    ...templates === undefined ? {} : { templates: resolve(templates) },
    ...evaluators === undefined ? {} : { evaluators: resolve(evaluators) },
    ...runs === undefined ? {} : { runs: resolve(runs) },
    ...only.length === 0 ? {} : { only },
    ...attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs },
    ...maxConcurrentTasks === undefined ? {} : { maxConcurrentTasks },
    ...rateLimitBackoffMs === undefined ? {} : { rateLimitBackoffMs },
  }
}

/** One task's reported result, as the caller sees it. */
export interface RunReport {
  readonly taskId: string
  readonly status: string
  readonly attempts: number
  readonly datasetDir: string
  readonly integrityFlags: readonly string[]
}

/**
 * Run every selected task.
 *
 * Tasks already recorded in the dataset index are skipped, which is what makes a
 * restarted run resume rather than redo work.
 *
 * @param args - the parsed arguments.
 * @param agent - the agent side that executes one attempt.
 * @param options - optional overrides for the derived paths.
 * @returns one report per task that ran.
 */
export async function runAll(
  args: RunnerArgs,
  agent: AgentRunner,
  options: {
    secrets?: readonly string[]
    /** What the composition offered this run, recorded on every attempt. */
    environment?: { available_tools?: readonly string[]; sandbox_mode?: string }
  } = {},
): Promise<RunReport[]> {
  const loaded = await loadTasks(args.manifest)
  const templates = args.templates ?? join(loaded.root, '..', 'templates')
  const evaluators = args.evaluators ?? join(loaded.root, '..', 'evaluator')
  const runs = args.runs ?? join(args.out, '..', 'runs')
  await mkdir(args.out, { recursive: true })
  await mkdir(runs, { recursive: true })
  const dataset = new DatasetWriter({ root: args.out })
  // One gate for the whole run: the provider counts requests per account, not
  // per task, so the bound has to outlive any single task.
  const gate = new RateLimitGate({
    ...args.maxConcurrentTasks === undefined ? {} : { maxConcurrent: args.maxConcurrentTasks },
    ...args.rateLimitBackoffMs === undefined ? {} : { defaultBackoffMs: args.rateLimitBackoffMs },
  })
  const selected = args.only === undefined
    ? loaded.tasks
    : loaded.tasks.filter(task => args.only?.includes(task.task_id))
  const reports: RunReport[] = []
  for (const task of selected) {
    if (await dataset.completed(task.task_id) !== undefined) continue
    const result = await gate.run(async () => runTask({
      task,
      defaults: loaded.defaults,
      templatesRoot: resolve(templates),
      evaluatorRoot: resolve(evaluators),
      runsRoot: resolve(runs),
      dataset,
      agent,
      ...options.secrets === undefined ? {} : { secrets: options.secrets },
      ...options.environment === undefined ? {} : { environment: options.environment },
    }))
    // A refusal the attempt loop recorded as an infrastructure failure is how a
    // rate limit reaches this layer, so the gate learns the wait from the text
    // the attempt kept rather than from a status code it no longer has.
    for (const attempt of result.attempts) {
      const notice = rateLimitOf(`${JSON.stringify(attempt.evaluation ?? null)} ${attempt.final}`)
      if (notice !== undefined) gate.noteRefused(notice)
    }
    reports.push({
      taskId: result.taskId,
      status: result.status,
      attempts: result.attempts.length,
      datasetDir: result.datasetDir,
      integrityFlags: result.integrityFlags,
    })
  }
  return reports
}

/**
 * Print one line per finished task.
 * @param reports - the reports to print.
 * @returns the same reports.
 */
function report(reports: RunReport[]): RunReport[] {
  for (const entry of reports) {
    const flags = entry.integrityFlags.length === 0 ? '' : ` flags=${entry.integrityFlags.join(',')}`
    process.stdout.write(
      `${entry.taskId}: ${entry.status} attempts=${String(entry.attempts)} -> ${entry.datasetDir}${flags}\n`,
    )
  }
  return reports
}

/**
 * Run the runner from the command line.
 *
 * Without an injected agent this boots the `distill` composition through the
 * Loader and drives the real agent loop, which is how the application runs. An
 * injected agent is a test seam: it lets a suite exercise the dataset and
 * judgment paths without reaching a provider.
 *
 * @param argv - arguments after the script name.
 * @param options - an optional agent to use in place of the composed one.
 * @returns one report per task that ran.
 */
export async function main(
  argv: readonly string[],
  options: { agent?: AgentRunner } = {},
): Promise<RunReport[]> {
  const args = parseRunnerArgs(argv)
  const secrets = collectEnvironmentSecrets()
  if (options.agent !== undefined) {
    return report(await runAll(args, options.agent, { secrets }))
  }
  const composition = await bootDistillComposition()
  try {
    // The registry is the only place that knows which tools the composition
    // actually holds, so the attempt records what ran rather than what was asked.
    const environment = { available_tools: availableToolsOf(composition.ctx) }
    const agent = createAgentRunner(composition.ctx, {
      ...pinnedTeacher(composition.ctx),
      capture: composition.capture,
      ...args.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: args.attemptTimeoutMs },
    })
    return report(await runAll(args, agent, { secrets, environment }))
  } finally {
    await composition.shutdown()
  }
}
