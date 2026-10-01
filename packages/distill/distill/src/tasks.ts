/**
 * Task loading and validation.
 *
 * A malformed task stops the run at load, naming the file and the field, rather
 * than producing a mislabeled trajectory later.
 *
 * @module @deepseek-ai/dsh-distill/tasks
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import type { TaskDefinition, TaskDefaults, TaskManifest } from './types.ts'

/** A task with its defaults resolved and its identity validated. */
export interface LoadedTask {
  /** The resolved definition. */
  readonly definition: Required<Pick<TaskDefinition, 'version' | 'task_id' | 'prompt' | 'workspace' | 'evaluator'>> & TaskDefinition
  /** A stable hash of the definition, recorded in the trajectory. */
  readonly configHash: string
}

/** Raised when a task file or manifest cannot be used. */
export class TaskDefinitionError extends Error {
  /** The file the failure came from. */
  readonly file: string

  /**
   * @param file - the offending file.
   * @param message - what is wrong with it.
   */
  constructor(file: string, message: string) {
    super(`${file}: ${message}`)
    this.name = 'TaskDefinitionError'
    this.file = file
  }
}

/** Task ids must be safe as directory names and unique across the corpus. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Read and parse one YAML document. */
async function readYaml(file: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new TaskDefinitionError(file, `cannot read: ${(error as Error).message}`)
  }
  try {
    return parseYaml(text)
  } catch (error) {
    throw new TaskDefinitionError(file, `is not valid YAML: ${(error as Error).message}`)
  }
}

/** Read a required string field. */
function requiredString(file: string, source: Record<string, unknown>, field: string): string {
  const value = source[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TaskDefinitionError(file, `"${field}" must be a non-empty string`)
  }
  return value
}

/** Read an optional array of strings. */
function optionalStrings(file: string, source: Record<string, unknown>, field: string): string[] | undefined {
  const value = source[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new TaskDefinitionError(file, `"${field}" must be an array of strings`)
  }
  return value as string[]
}

/** Read a positive integer field. */
function optionalPositiveInt(file: string, source: Record<string, unknown>, field: string): number | undefined {
  const value = source[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TaskDefinitionError(file, `"${field}" must be a positive integer`)
  }
  return value
}

/** Validate the workspace section. */
function workspaceOf(file: string, source: Record<string, unknown>): TaskDefinition['workspace'] {
  const workspace = source.workspace
  if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) {
    throw new TaskDefinitionError(file, '"workspace" must be a mapping')
  }
  const record = workspace as Record<string, unknown>
  const template = requiredString(file, record, 'template')
  const seed = record.seed_files
  if (seed !== undefined) {
    if (!Array.isArray(seed)) throw new TaskDefinitionError(file, '"workspace.seed_files" must be an array')
    for (const entry of seed) {
      if (entry === null || typeof entry !== 'object') {
        throw new TaskDefinitionError(file, '"workspace.seed_files[]" entries must be mappings')
      }
      const item = entry as Record<string, unknown>
      requiredString(file, item, 'path')
      requiredString(file, item, 'content')
    }
  }
  return {
    template,
    ...optionalStrings(file, record, 'include') === undefined ? {} : { include: optionalStrings(file, record, 'include') as string[] },
    ...optionalStrings(file, record, 'exclude') === undefined ? {} : { exclude: optionalStrings(file, record, 'exclude') as string[] },
    ...seed === undefined ? {} : { seed_files: seed as { path: string; content: string }[] },
  }
}

/** Validate the evaluator section. */
function evaluatorOf(file: string, source: Record<string, unknown>): TaskDefinition['evaluator'] {
  const evaluator = source.evaluator
  if (evaluator === null || typeof evaluator !== 'object' || Array.isArray(evaluator)) {
    throw new TaskDefinitionError(file, '"evaluator" must be a mapping')
  }
  const record = evaluator as Record<string, unknown>
  const kind = requiredString(file, record, 'kind')
  if (kind !== 'test_command' && kind !== 'hidden_test' && kind !== 'artifact_check') {
    throw new TaskDefinitionError(file, `"evaluator.kind" must be test_command, hidden_test, or artifact_check; got ${JSON.stringify(kind)}`)
  }
  const command = record.command
  if (!Array.isArray(command) || command.length === 0 || command.some(entry => typeof entry !== 'string')) {
    throw new TaskDefinitionError(file, '"evaluator.command" must be a non-empty array of strings')
  }
  const exitCode = record.expect_exit_code
  if (exitCode !== undefined && (typeof exitCode !== 'number' || !Number.isInteger(exitCode))) {
    throw new TaskDefinitionError(file, '"evaluator.expect_exit_code" must be an integer')
  }
  const contains = record.expect_stdout_contains
  if (contains !== undefined && typeof contains !== 'string') {
    throw new TaskDefinitionError(file, '"evaluator.expect_stdout_contains" must be a string')
  }
  const cwd = record.cwd
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw new TaskDefinitionError(file, '"evaluator.cwd" must be a string')
  }
  return {
    kind,
    command: command as string[],
    ...optionalStrings(file, record, 'assets') === undefined ? {} : { assets: optionalStrings(file, record, 'assets') as string[] },
    ...cwd === undefined ? {} : { cwd },
    ...exitCode === undefined ? {} : { expect_exit_code: exitCode },
    ...contains === undefined ? {} : { expect_stdout_contains: contains },
    ...optionalPositiveInt(file, record, 'timeout_ms') === undefined ? {} : { timeout_ms: optionalPositiveInt(file, record, 'timeout_ms') as number },
  }
}

/** Validate the extra checks. */
function checksOf(file: string, source: Record<string, unknown>): TaskDefinition['checks'] {
  const checks = source.checks
  if (checks === undefined) return undefined
  if (!Array.isArray(checks)) throw new TaskDefinitionError(file, '"checks" must be an array')
  return checks.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TaskDefinitionError(file, `"checks[${String(index)}]" must be a mapping`)
    }
    const record = entry as Record<string, unknown>
    const kind = requiredString(file, record, 'kind')
    if (kind === 'file_exists') {
      return { kind, path: requiredString(file, record, 'path') } as const
    }
    if (kind === 'command_succeeds') {
      const command = record.command
      if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== 'string')) {
        throw new TaskDefinitionError(file, `"checks[${String(index)}].command" must be a non-empty array of strings`)
      }
      const timeout = optionalPositiveInt(file, record, 'timeout_ms')
      return { kind, command: command as string[], ...timeout === undefined ? {} : { timeout_ms: timeout } } as const
    }
    throw new TaskDefinitionError(file, `"checks[${String(index)}].kind" must be file_exists or command_succeeds; got ${JSON.stringify(kind)}`)
  })
}

/** Validate the tool set. */
function toolsOf(file: string, source: Record<string, unknown>): TaskDefinition['tools'] {
  const tools = source.tools
  if (tools === undefined) return undefined
  if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) {
    throw new TaskDefinitionError(file, '"tools" must be a mapping')
  }
  const record = tools as Record<string, unknown>
  const allow = optionalStrings(file, record, 'allow')
  const deny = optionalStrings(file, record, 'deny')
  if (allow === undefined || deny === undefined) {
    throw new TaskDefinitionError(file, '"tools" must declare both "allow" and "deny"')
  }
  return { allow, deny }
}

/** Validate the environment map. */
function envOf(file: string, source: Record<string, unknown>): Readonly<Record<string, string>> | undefined {
  const env = source.env
  if (env === undefined) return undefined
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TaskDefinitionError(file, '"env" must be a mapping')
  }
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new TaskDefinitionError(file, `"env.${key}" must be a string`)
  }
  return env as Record<string, string>
}

/**
 * Validate one parsed task document.
 * @param file - the file the document came from, for failure messages.
 * @param document - the parsed YAML document.
 * @returns the validated definition.
 * @throws TaskDefinitionError when a required field is missing or ill-typed.
 */
export function parseTask(file: string, document: unknown): TaskDefinition {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new TaskDefinitionError(file, 'must be a mapping')
  }
  const source = document as Record<string, unknown>
  const version = source.version
  if (version !== 1) {
    throw new TaskDefinitionError(file, `"version" must be 1; got ${JSON.stringify(version)}`)
  }
  const taskId = requiredString(file, source, 'task_id')
  if (!TASK_ID.test(taskId)) {
    throw new TaskDefinitionError(
      file,
      `"task_id" must match ${TASK_ID.source} so it is safe as a directory name; got ${JSON.stringify(taskId)}`,
    )
  }
  const initialContext = source.initial_context
  if (initialContext !== undefined && typeof initialContext !== 'string') {
    throw new TaskDefinitionError(file, '"initial_context" must be a string')
  }
  const carry = source.carry_failure_feedback
  if (carry !== undefined && typeof carry !== 'boolean') {
    throw new TaskDefinitionError(file, '"carry_failure_feedback" must a boolean')
  }
  return {
    version: 1,
    task_id: taskId,
    prompt: requiredString(file, source, 'prompt'),
    ...initialContext === undefined ? {} : { initial_context: initialContext },
    workspace: workspaceOf(file, source),
    evaluator: evaluatorOf(file, source),
    ...checksOf(file, source) === undefined ? {} : { checks: checksOf(file, source) as NonNullable<TaskDefinition['checks']> },
    ...optionalPositiveInt(file, source, 'max_attempts') === undefined ? {} : { max_attempts: optionalPositiveInt(file, source, 'max_attempts') as number },
    ...optionalPositiveInt(file, source, 'batch') === undefined ? {} : { batch: optionalPositiveInt(file, source, 'batch') as number },
    ...envOf(file, source) === undefined ? {} : { env: envOf(file, source) as Record<string, string> },
    ...toolsOf(file, source) === undefined ? {} : { tools: toolsOf(file, source) as NonNullable<TaskDefinition['tools']> },
    ...optionalStrings(file, source, 'tags') === undefined ? {} : { tags: optionalStrings(file, source, 'tags') as string[] },
    ...carry === undefined ? {} : { carry_failure_feedback: carry },
  }
}

/**
 * Load a manifest and every task it names.
 * @param manifestPath - absolute path of the manifest file.
 * @returns the resolved defaults and the tasks, in manifest order.
 * @throws TaskDefinitionError when the manifest or any task is unusable.
 */
export async function loadTasks(manifestPath: string): Promise<{
  root: string
  defaults: TaskDefaults
  tasks: TaskDefinition[]
}> {
  const root = dirname(resolve(manifestPath))
  const document = await readYaml(manifestPath)
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new TaskDefinitionError(manifestPath, 'must be a mapping')
  }
  const manifest = document as Record<string, unknown>
  if (manifest.version !== 1) {
    throw new TaskDefinitionError(manifestPath, `"version" must be 1; got ${JSON.stringify(manifest.version)}`)
  }
  const entries = manifest.tasks
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TaskDefinitionError(manifestPath, '"tasks" must be a non-empty array')
  }
  const files = entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new TaskDefinitionError(manifestPath, `"tasks[${String(index)}]" must be a mapping`)
    }
    return requiredString(manifestPath, entry as Record<string, unknown>, 'file')
  })
  const tasks: TaskDefinition[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const absolute = join(root, file)
    const task = parseTask(absolute, await readYaml(absolute))
    if (seen.has(task.task_id)) {
      throw new TaskDefinitionError(absolute, `duplicate task_id ${JSON.stringify(task.task_id)}; ids are the dataset directory names and must be unique`)
    }
    seen.add(task.task_id)
    tasks.push(task)
  }
  const defaults = (manifest.defaults ?? {}) as TaskDefaults
  return { root, defaults, tasks }
}

/** The manifest shape a caller may hand to {@link loadTasks} directly. */
export type { TaskManifest }
