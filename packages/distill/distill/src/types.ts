/**
 * The task definition a distillation run executes.
 *
 * A task states what the teacher is asked, what workspace it starts from, and how
 * its work is judged objectively. Nothing here trusts the model's own report:
 * {@link TaskDefinition.evaluator} and {@link TaskDefinition.checks} are commands
 * and file assertions that either pass or do not.
 *
 * @module @deepseek-ai/dsh-distill/types
 */

/** Status shared by attempts and tasks. */
export type Status = 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'ERROR' | 'ABANDONED' | 'UNKNOWN'

/** Whether an error came from the agent's work or from the infrastructure under it. */
export type ErrorClass = 'agent' | 'infrastructure'

/** Integrity problems detected after an attempt ran. */
export type IntegrityFlag = 'test_tampering' | 'scaffold_modified' | 'test_shadowing' | 'model_mismatch'

/** How a workspace is seeded. */
export interface WorkspaceSpec {
  /** Template directory copied into the attempt workspace. */
  readonly template: string
  /** Glob patterns to keep; omission keeps everything. */
  readonly include?: readonly string[]
  /** Glob patterns to drop. */
  readonly exclude?: readonly string[]
  /** Files written into the workspace after the template is copied. */
  readonly seed_files?: readonly { readonly path: string; readonly content: string }[]
}

/** The three objective judgment shapes a task may declare. */
export type EvaluatorKind = 'test_command' | 'hidden_test' | 'artifact_check'

/** One objective check appended to the primary evaluator. */
export interface TaskCheck {
  /** `file_exists` asserts a path; `command_succeeds` asserts a zero exit. */
  readonly kind: 'file_exists' | 'command_succeeds'
  /** Path for `file_exists`, relative to the workspace. */
  readonly path?: string
  /** Command for `command_succeeds`. */
  readonly command?: readonly string[]
  /** Milliseconds the command may run. */
  readonly timeout_ms?: number
}

/** The objective judgment for one task. */
export interface EvaluatorSpec {
  /** Which judgment shape this is. */
  readonly kind: EvaluatorKind
  /** Files copied from the hidden asset directory into the evaluator directory. */
  readonly assets?: readonly string[]
  /** The command to run. */
  readonly command: readonly string[]
  /** Working directory for the command, relative to the evaluator directory. */
  readonly cwd?: string
  /** Exit code that means success; defaults to 0. */
  readonly expect_exit_code?: number
  /** Substring the command's stdout must contain. */
  readonly expect_stdout_contains?: string
  /** Milliseconds the command may run. */
  readonly timeout_ms?: number
}

/** The tool set a task runs with. */
export interface ToolSpec {
  /** Tool names the composition enables. */
  readonly allow: readonly string[]
  /** Tool names the composition disables. */
  readonly deny: readonly string[]
}

/** One task. */
export interface TaskDefinition {
  /** Schema version of the task file. */
  readonly version: number
  /** Globally unique identity, also the dataset directory name. */
  readonly task_id: string
  /** What the teacher is asked to do. */
  readonly prompt: string
  /** Context delivered with {@link prompt} in the first user message. */
  readonly initial_context?: string
  /** How the workspace is seeded. */
  readonly workspace: WorkspaceSpec
  /** The objective judgment. */
  readonly evaluator: EvaluatorSpec
  /** Extra objective checks, all of which must pass. */
  readonly checks?: readonly TaskCheck[]
  /** Maximum independent attempts. */
  readonly max_attempts?: number
  /** Resource batch this task belongs to. */
  readonly batch?: number
  /** Environment entries layered onto the attempt's process. */
  readonly env?: Readonly<Record<string, string>>
  /** The tool set for this task. */
  readonly tools?: ToolSpec
  /** Free-form labels carried into the trajectory metadata. */
  readonly tags?: readonly string[]
  /** Whether a later attempt is told why the previous one failed. Defaults to false. */
  readonly carry_failure_feedback?: boolean
}

/** Defaults applied to every task that omits a field. */
export interface TaskDefaults {
  /** Maximum independent attempts; defaults to 5. */
  readonly max_attempts?: number
  /** Resource batch; defaults to 0. */
  readonly batch?: number
  /** Environment entries. */
  readonly env?: Readonly<Record<string, string>>
  /** The tool set. */
  readonly tools?: ToolSpec
  /** Whether infrastructure errors consume an attempt; defaults to false. */
  readonly infra_error_consumes_attempt?: boolean
  /** Infrastructure errors allowed before giving up; defaults to 15. */
  readonly infra_error_max?: number
  /** Whether a later attempt is told why the previous one failed; defaults to false. */
  readonly carry_failure_feedback?: boolean
}

/** The task manifest. */
export interface TaskManifest {
  /** Schema version of the manifest. */
  readonly version: number
  /** Values applied to tasks that omit them. */
  readonly defaults?: TaskDefaults
  /** The task files to load, relative to the manifest. */
  readonly tasks: readonly { readonly file: string }[]
}
