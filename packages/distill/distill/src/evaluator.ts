/**
 * Objective judgment of one attempt.
 *
 * The evaluator runs commands the task declares and reports what happened; it
 * never reads the agent's prose. It also checks the integrity of the assets and
 * scaffold around the run, so a later dataset can exclude an attempt whose tests
 * were tampered with.
 *
 * @module @deepseek-ai/dsh-distill/evaluator
 */

import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { spawn } from 'node:child_process'
import type { EvaluatorSpec, IntegrityFlag, Status, TaskCheck } from './types.ts'

/** The outcome of one command. */
export interface CommandOutcome {
  /** Exit code, or `null` when the process was killed by a signal. */
  readonly exitCode: number | null
  /** Collected standard output. */
  readonly stdout: string
  /** Collected standard error. */
  readonly stderr: string
  /** Whether the deadline was reached. */
  readonly timedOut: boolean
  /** Wall-clock duration in milliseconds. */
  readonly duration_ms: number
}

/**
 * Run one command to completion.
 * @param command - the argv to spawn, without a shell.
 * @param options - working directory, deadline, and environment overlay.
 * @returns the collected outcome; a nonzero exit is an outcome, not a rejection.
 */
export async function runCommand(
  command: readonly string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<CommandOutcome> {
  const started = Date.now()
  return new Promise<CommandOutcome>((settle) => {
    const child = spawn(command[0] as string, command.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      settle({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut, duration_ms: Date.now() - started })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      settle({ exitCode: code, stdout, stderr, timedOut, duration_ms: Date.now() - started })
    })
  })
}

/** The judgment of one attempt. */
export interface EvaluationResult {
  /** The status this evaluator assigned. */
  readonly status: Extract<Status, 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'ERROR'>
  /** A one-line reason recorded in the trajectory. */
  readonly reason: string
  /** Whether the failure came from the agent's work or from the infrastructure. */
  readonly error_class?: 'agent' | 'infrastructure'
  /** One entry per command and check that ran. */
  readonly entries: readonly {
    readonly name: string
    readonly status: 'passed' | 'failed' | 'error'
    readonly exit_code: number | null
    readonly duration_ms: number
    readonly stdout: string
    readonly stderr: string
  }[]
}

/** Where one attempt's directories live. */
export interface AttemptLayout {
  /** The agent's working directory. */
  readonly workspace: string
  /** The evaluator's own directory, containing its assets. */
  readonly evaluator: string
}

/** Default deadline for a command that declares none. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

/**
 * Copy a task's hidden evaluator assets into the attempt's evaluator directory.
 * @param assetRoot - the hidden asset directory for this task.
 * @param evaluatorDir - the attempt's evaluator directory.
 * @param assets - asset paths relative to the hidden directory.
 */
export async function stageAssets(
  assetRoot: string,
  evaluatorDir: string,
  assets: readonly string[],
): Promise<void> {
  await mkdir(evaluatorDir, { recursive: true })
  for (const asset of assets) {
    const from = join(assetRoot, asset)
    const to = join(evaluatorDir, asset)
    await mkdir(join(to, '..'), { recursive: true })
    await cp(from, to, { recursive: true })
  }
}

/** Every file under `root`, as POSIX-relative paths, sorted. */
async function fileList(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      out.push(relative(root, full).split(sep).join('/'))
    }
  }
  await walk(root)
  return out.sort()
}

/**
 * Fingerprint a directory as a path-to-hash map.
 * @param root - the directory to fingerprint.
 * @returns one entry per file, keyed by POSIX-relative path.
 */
export async function fingerprintDirectory(root: string): Promise<Record<string, string>> {
  const fingerprints: Record<string, string> = {}
  for (const file of await fileList(root)) {
    const bytes = await readFile(join(root, file))
    fingerprints[file] = createHash('sha256').update(bytes).digest('hex')
  }
  return fingerprints
}

/**
 * Compare two fingerprints of the same tree.
 * @param before - the fingerprint taken earlier.
 * @param after - the fingerprint taken later.
 * @returns the paths added, changed, and removed, each sorted.
 */
export function diffFingerprints(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): { added: string[]; changed: string[]; removed: string[] } {
  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []
  for (const [path, hash] of Object.entries(after)) {
    const previous = before[path]
    if (previous === undefined) added.push(path)
    else if (previous !== hash) changed.push(path)
  }
  for (const path of Object.keys(before)) {
    if (after[path] === undefined) removed.push(path)
  }
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() }
}

/**
 * Whether a newly created path looks like a test rather than a deliverable.
 *
 * A new file is a normal task output; a new *test* file is what could shadow the
 * hidden suite, so only test-shaped paths are reported.
 *
 * @param path - the POSIX-relative path that appeared.
 * @returns whether the path looks like a test.
 */
export function looksLikeTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(path)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
    || /(^|\/)test[^/]*\.[cm]?[jt]sx?$/.test(path)
}

/**
 * Detect integrity problems from the fingerprints taken around an attempt.
 *
 * Three signals are reported: evaluator assets that changed, scaffold files the
 * task supplied that were modified or deleted, and a new file that shadows the
 * hidden suite. Creating ordinary output files is the task's goal, not tampering,
 * so it is not reported.
 *
 * @param input - the four fingerprints: evaluator assets and scaffold, each
 * taken before and after the attempt.
 * @returns the flags raised, deduplicated and sorted.
 */
export function integrityFlags(input: {
  assetsBefore: Readonly<Record<string, string>>
  assetsAfter: Readonly<Record<string, string>>
  scaffoldBefore: Readonly<Record<string, string>>
  scaffoldAfter: Readonly<Record<string, string>>
}): IntegrityFlag[] {
  const flags = new Set<IntegrityFlag>()
  const assets = diffFingerprints(input.assetsBefore, input.assetsAfter)
  if (assets.added.length > 0 || assets.changed.length > 0 || assets.removed.length > 0) {
    flags.add('test_tampering')
  }
  const scaffold = diffFingerprints(input.scaffoldBefore, input.scaffoldAfter)
  if (scaffold.changed.length > 0 || scaffold.removed.length > 0) flags.add('scaffold_modified')
  if (scaffold.added.some(looksLikeTestPath)) flags.add('test_shadowing')
  return [...flags].sort()
}

/** One check's outcome, before it is folded into the result. */
interface CheckOutcome {
  name: string
  status: 'passed' | 'failed' | 'error'
  exit_code: number | null
  duration_ms: number
  stdout: string
  stderr: string
}

/** Run the declared extra checks. */
async function runChecks(
  checks: readonly TaskCheck[],
  layout: AttemptLayout,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = []
  for (const [index, check] of checks.entries()) {
    if (check.kind === 'file_exists') {
      const target = join(layout.workspace, check.path as string)
      const present = existsSync(target)
        && (await stat(target)).isFile()
      outcomes.push({
        name: `file_exists:${check.path as string}`,
        status: present ? 'passed' : 'failed',
        exit_code: null,
        duration_ms: 0,
        stdout: '',
        stderr: present ? '' : `${target} does not exist`,
      })
      // A failed assertion stops the run: later checks describe the same attempt
      // and would only add noise to the verdict.
      if (outcomes[index]?.status !== 'passed') return outcomes
      continue
    }
    const outcome = await runCommand(check.command as readonly string[], {
      cwd: layout.workspace,
      timeoutMs: check.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS,
    })
    const started = outcome.exitCode !== null
    outcomes.push({
      name: `command_succeeds:${(check.command as readonly string[]).join(' ')}`,
      // A command that never started measured nothing, so it is an infrastructure
      // failure rather than a failed check.
      status: outcome.timedOut || !started ? 'error' : outcome.exitCode === 0 ? 'passed' : 'failed',
      exit_code: outcome.exitCode,
      duration_ms: outcome.duration_ms,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    })
    if (outcomes[index]?.status !== 'passed') return outcomes
  }
  return outcomes
}

/**
 * Judge one attempt.
 *
 * The primary evaluator runs first; only when it passes do the extra checks run.
 * A command that could not be started, or that reached its deadline, is reported
 * as an infrastructure error rather than as a failed task, because the agent's
 * work was never measured.
 *
 * @param spec - the task's evaluator specification.
 * @param layout - where the attempt's workspace and evaluator directories are.
 * @returns the judgment, with every command's outcome recorded.
 */
export async function evaluate(spec: EvaluatorSpec, layout: AttemptLayout): Promise<EvaluationResult> {
  const expected = spec.expect_exit_code ?? 0
  const outcome = await runCommand(spec.command, {
    cwd: join(layout.evaluator, spec.cwd ?? '.'),
    timeoutMs: spec.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS,
  })
  const entries: CheckOutcome[] = [{
    name: `evaluator:${spec.command.join(' ')}`,
    status: outcome.timedOut ? 'error' : outcome.exitCode === expected ? 'passed' : 'failed',
    exit_code: outcome.exitCode,
    duration_ms: outcome.duration_ms,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  }]
  const primary = entries[0] as CheckOutcome
  if (primary.status === 'error') {
    return {
      status: 'TIMEOUT',
      reason: `evaluator did not complete: ${primary.stderr.trim() || `exit ${String(outcome.exitCode)}`}`,
      error_class: 'infrastructure',
      entries,
    }
  }
  if (primary.status === 'failed') {
    return {
      status: 'FAILED',
      reason: `evaluator exited ${String(outcome.exitCode)}, expected ${String(expected)}`,
      entries,
    }
  }
  if (spec.expect_stdout_contains !== undefined && !outcome.stdout.includes(spec.expect_stdout_contains)) {
    entries[0] = { ...primary, status: 'failed' }
    return {
      status: 'FAILED',
      reason: `evaluator stdout did not contain ${JSON.stringify(spec.expect_stdout_contains)}`,
      entries,
    }
  }
  return { status: 'SUCCESS', reason: 'evaluator passed', entries }
}

/**
 * Judge one attempt, including the task's extra checks.
 * @param spec - the task's evaluator specification.
 * @param checks - the task's extra checks.
 * @param layout - where the attempt's workspace and evaluator directories are.
 * @returns the judgment.
 */
export async function evaluateTask(
  spec: EvaluatorSpec,
  checks: readonly TaskCheck[],
  layout: AttemptLayout,
): Promise<EvaluationResult> {
  const primary = await evaluate(spec, layout)
  if (primary.status !== 'SUCCESS' || checks.length === 0) return primary
  const extra = await runChecks(checks, layout)
  const entries = [...primary.entries, ...extra]
  const firstFailure = extra.find(check => check.status !== 'passed')
  if (firstFailure === undefined) {
    return { status: 'SUCCESS', reason: `evaluator and ${String(checks.length)} check(s) passed`, entries }
  }
  return {
    status: firstFailure.status === 'error' ? 'ERROR' : 'FAILED',
    reason: `${firstFailure.name} ${firstFailure.status}`,
    ...firstFailure.status === 'error' ? { error_class: 'infrastructure' as const } : {},
    entries,
  }
}
