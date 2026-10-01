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
import { DatasetWriter } from '@deepseek-ai/dsh-distill'
import { loadTasks } from '@deepseek-ai/dsh-distill'
import { runTask } from '@deepseek-ai/dsh-distill'
import type { AgentRunner } from '@deepseek-ai/dsh-distill'
import { collectEnvironmentSecrets } from '@deepseek-ai/dsh-distill-redaction'

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
  options: { secrets?: readonly string[] } = {},
): Promise<RunReport[]> {
  const loaded = await loadTasks(args.manifest)
  const templates = args.templates ?? join(loaded.root, '..', 'templates')
  const evaluators = args.evaluators ?? join(loaded.root, '..', 'evaluator')
  const runs = args.runs ?? join(args.out, '..', 'runs')
  await mkdir(args.out, { recursive: true })
  await mkdir(runs, { recursive: true })
  const dataset = new DatasetWriter({ root: args.out })
  const selected = args.only === undefined
    ? loaded.tasks
    : loaded.tasks.filter(task => args.only?.includes(task.task_id))
  const reports: RunReport[] = []
  for (const task of selected) {
    if (await dataset.completed(task.task_id) !== undefined) continue
    const result = await runTask({
      task,
      defaults: loaded.defaults,
      templatesRoot: resolve(templates),
      evaluatorRoot: resolve(evaluators),
      runsRoot: resolve(runs),
      dataset,
      agent,
      ...options.secrets === undefined ? {} : { secrets: options.secrets },
    })
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
 * Run the runner from the command line.
 * @param argv - arguments after the script name.
 * @param agent - the agent side that executes one attempt.
 * @returns one report per task that ran.
 */
export async function main(argv: readonly string[], agent: AgentRunner): Promise<RunReport[]> {
  const reports = await runAll(parseRunnerArgs(argv), agent, {
    secrets: collectEnvironmentSecrets(),
  })
  for (const report of reports) {
    const flags = report.integrityFlags.length === 0 ? '' : ` flags=${report.integrityFlags.join(',')}`
    process.stdout.write(`${report.taskId}: ${report.status} attempts=${String(report.attempts)} -> ${report.datasetDir}${flags}\n`)
  }
  return reports
}
