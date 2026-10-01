/**
 * Cordis plugin that pins a distillation composition to one teacher model at load
 * time. The lock judgment lives in `./lock.ts`; this module only reads the two
 * candidate layers and refuses to mount when they cannot be pinned to a single
 * allowed model.
 *
 * @module @deepseek-ai/dsh-distill-teacher-lock
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
// Empty type import carries the Context merge for the optional
// `ctx.agentDefaultModel` read below.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import {
  REQUIRED_TEACHER_MODEL,
  TEACHER_MODEL_ENV,
  TeacherModelLockError,
  defaultTeacherAllowlist,
  resolveTeacherLock,
} from './lock.ts'
import type { TeacherLock, TeacherModelCandidate } from './lock.ts'

/** Stable Cordis plugin name used by loader diagnostics. */
export const name = 'distill-teacher-lock'

/**
 * The services this plugin must see before it judges the composition.
 *
 * The default-model service is the composition's own statement of which model it
 * will request, so the lock waits for it rather than racing it; judging before
 * that row mounts would read an empty model list and refuse every composition.
 */
export const inject = ['agentDefaultModel']

/** Plugin configuration. */
export interface Config {
  /**
   * Model ids this composition accepts. Omission uses the built-in teacher set
   * ({@link REQUIRED_TEACHER_MODEL} plus the retired aliases). A composition that
   * needs a different teacher overrides this deliberately.
   */
  allow?: string[]
  /**
   * The composition's own model, consulted only when the launch environment names
   * none. The running adapter's selection remains the authority; this field is the
   * lock's record of what the composition intends to load.
   */
  model?: string
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  allow: z.array(z.string()),
  model: z.string(),
})

/**
 * Read the model the launch environment names, most trusted variable first.
 * @param environment - the launch environment snapshot.
 * @returns the candidate, or `undefined` when no consulted variable carries a value.
 */
function environmentCandidate(environment: LaunchEnvironmentSnapshot): TeacherModelCandidate | undefined {
  for (const envName of TEACHER_MODEL_ENV) {
    const entry = environment.get(envName)
    if (entry === undefined) continue
    const model = entry.value.trim()
    // An empty or whitespace-only value is a present-but-unusable setting. It is
    // not the same as an absent one, so it is reported rather than skipped.
    if (model.length === 0) {
      throw new TeacherModelLockError(
        `teacher model lock: ${envName} is set but empty; unset it or name a model`,
        'model-not-allowed',
      )
    }
    return { model, source: 'env', envName }
  }
  return undefined
}

/**
 * Resolve the lock for one composition.
 * @param ctx - plugin context carrying the launch environment.
 * @param config - validated plugin configuration.
 * @returns the resolved lock.
 */
function resolveFromContext(ctx: Context, config: Config): TeacherLock {
  const candidates: TeacherModelCandidate[] = []
  const fromEnvironment = environmentCandidate(launchEnvironmentOf(ctx))
  if (fromEnvironment !== undefined) candidates.push(fromEnvironment)
  // The adapter's own default selection is the composition layer. It is read
  // through the global service store: a composition that mounts the lock without
  // the default-model row still gets a usable answer from its own config.
  const configured = ctx.get('agentDefaultModel')?.currentSelection().model ?? config.model
  if (configured !== undefined && configured.trim().length > 0) {
    candidates.push({ model: configured.trim(), source: 'config' })
  }
  return resolveTeacherLock({
    candidates,
    ...config.allow === undefined ? {} : { allow: config.allow },
  })
}

/**
 * Mount the lock, refusing to load when the composition cannot be pinned.
 * @param ctx - plugin context carrying the launch environment.
 * @param config - validated plugin configuration.
 * @throws TeacherModelLockError when no candidate is usable, when layers disagree, or when the chosen model is not allowed.
 */
export function apply(ctx: Context, config: Config): void {
  const lock = resolveFromContext(ctx, config)
  if (lock.legacy) {
    ctx.logger.warn(
      `distill-teacher-lock: model "${lock.model}" is a retired alias for "${REQUIRED_TEACHER_MODEL}"; `
      + 'requests route to the current teacher, but the recorded model id should be updated',
    )
  }
  const origin = lock.envName === undefined ? '' : ` (${lock.envName})`
  ctx.logger.info(
    `distill-teacher-lock: pinned to "${lock.model}" from the ${lock.source} layer`
    + origin
    + `; allowed: ${lock.allow.join(', ')}`,
  )
}

/** Re-exported so a composition can state the default allowlist without importing `./lock.ts`. */
export { defaultTeacherAllowlist }
