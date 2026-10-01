/**
 * Teacher-model lock for distillation runs.
 *
 * Every trajectory this repository produces must come from one teacher model, and
 * a misconfigured run must fail before it starts rather than record data under the
 * wrong model. {@link resolveTeacherLock} turns the candidate sources into one
 * locked model, and {@link assertTeacherModelLock} refuses a lock whose value or
 * allowlist does not hold up.
 *
 * The allowlist is the interesting part: widening it is the way a misconfiguration
 * could smuggle a second teacher in, so a configured value marked
 * {@link VIOLATION_SENTINEL} is rejected outright instead of being treated as an
 * ordinary unknown model.
 *
 * @module @deepseek-ai/dsh-distill-teacher-lock
 */

/** The API model name every distillation trajectory must use. */
export const REQUIRED_TEACHER_MODEL = 'deepseek-flash'

/**
 * Retired model names the provider still routes to the current teacher. They are
 * accepted so an old configuration keeps working, and reported so the operator can
 * move to {@link REQUIRED_TEACHER_MODEL}.
 */
export const LEGACY_TEACHER_MODELS: readonly string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
]

/** Environment names consulted for the locked model, in precedence order. */
export const TEACHER_MODEL_ENV: readonly string[] = ['DSH_DISTILL_MODEL', 'MODEL_NAME']

/**
 * A configured allowlist entry carrying this value does not name a model at all:
 * it asks the lock to accept whatever the run happens to use. A lock that accepts
 * everything is not a lock, so the entry is a violation.
 */
export const VIOLATION_SENTINEL = '*'

/** Where the locked model came from. */
export type TeacherLockSource = 'env' | 'config'

/** A teacher model the lock accepted. */
export interface LockedTeacherModel {
  /** The exact model id the run must use. */
  readonly model: string
  /** The layer that supplied it. */
  readonly source: TeacherLockSource
  /** The environment variable that supplied it; absent when `source` is `config`. */
  readonly envName?: string
  /** Whether {@link model} is a retired alias rather than {@link REQUIRED_TEACHER_MODEL}. */
  readonly legacy: boolean
}

/** One candidate model proposed to the lock, in the order it was consulted. */
export interface TeacherModelCandidate {
  /** The exact model id. */
  readonly model: string
  /** The layer that proposed it. */
  readonly source: TeacherLockSource
  /** The environment variable that proposed it; absent for the configuration layer. */
  readonly envName?: string
}

/** Everything the lock judges. */
export interface TeacherLockRequest {
  /** Candidate models in precedence order; the first acceptable one wins. */
  readonly candidates: readonly TeacherModelCandidate[]
  /** Model ids the lock accepts; empty uses the built-in teacher set. */
  readonly allow?: readonly string[]
}

/** The model every candidate proposed when they disagree. */
export interface TeacherModelConflict {
  /** The model the environment selected. */
  readonly envModel: string
  /** The model the configuration selected. */
  readonly configModel: string
}

/** The resolved lock. */
export interface TeacherLock {
  /** The model the run must use. */
  readonly model: string
  /** The layer that supplied it. */
  readonly source: TeacherLockSource
  /** The environment variable that supplied it; absent when `source` is `config`. */
  readonly envName?: string
  /** Whether the locked model is a retired alias. */
  readonly legacy: boolean
  /** Every model id this lock accepts. */
  readonly allow: readonly string[]
}

/** Raised when a run cannot be pinned to one teacher model. */
export class TeacherModelLockError extends Error {
  /** `model-not-allowed`, `allowlist-widened`, or `empty-allowlist`. */
  readonly code: string

  /**
   * @param message - the operator-facing explanation.
   * @param code - the stable failure identity.
   */
  constructor(message: string, code: string) {
    super(message)
    this.name = 'TeacherModelLockError'
    this.code = code
  }
}

/**
 * The built-in accepted set: the required model plus the legacy aliases.
 * @returns the default allowlist.
 */
export function defaultTeacherAllowlist(): string[] {
  return [REQUIRED_TEACHER_MODEL, ...LEGACY_TEACHER_MODELS]
}

/**
 * Report the first pair of candidates that disagree.
 * @param candidates - candidate models in precedence order.
 * @returns the conflict, or `undefined` when every candidate names the same model.
 */
export function teacherModelConflict(
  candidates: readonly TeacherModelCandidate[],
): TeacherModelConflict | undefined {
  const env = candidates.find(candidate => candidate.source === 'env')
  const config = candidates.find(candidate => candidate.source === 'config')
  if (env === undefined || config === undefined) return undefined
  if (env.model === config.model) return undefined
  return { envModel: env.model, configModel: config.model }
}

/**
 * Validate one allowlist.
 *
 * An entry that is empty, padded, or the {@link VIOLATION_SENTINEL} cannot pin a
 * model; the first two are unusable, and the sentinel is a refused widening
 * attempt, which is a different failure and gets a different code.
 *
 * @param allow - the configured allowlist.
 * @returns the deduplicated allowlist in the order given.
 * @throws TeacherModelLockError when an entry cannot pin a model.
 */
export function validateTeacherAllowlist(allow: readonly string[]): string[] {
  if (allow.length === 0) {
    throw new TeacherModelLockError(
      `teacher model lock requires at least one allowed model; set ${TEACHER_MODEL_ENV[0]} or the composition's allowlist`,
      'empty-allowlist',
    )
  }
  const seen = new Set<string>()
  const accepted: string[] = []
  for (const entry of allow) {
    if (entry === VIOLATION_SENTINEL) {
      throw new TeacherModelLockError(
        `teacher model lock refuses the "${VIOLATION_SENTINEL}" allowlist entry: a lock that accepts any model is not a lock`,
        'allowlist-widened',
      )
    }
    if (entry.trim() !== entry || entry.length === 0) {
      throw new TeacherModelLockError(
        `teacher model lock allowlist entry must be a non-empty model id without surrounding whitespace, received ${JSON.stringify(entry)}`,
        'model-not-allowed',
      )
    }
    if (!seen.has(entry)) {
      seen.add(entry)
      accepted.push(entry)
    }
  }
  return accepted
}

/**
 * Resolve the one teacher model a run is pinned to.
 * @param request - candidate models in precedence order and the optional allowlist.
 * @returns the lock, naming the winning layer and whether its model is a legacy alias.
 * @throws TeacherModelLockError when no candidate is usable or the chosen model is not allowed.
 */
export function resolveTeacherLock(request: TeacherLockRequest): TeacherLock {
  const allow = validateTeacherAllowlist(
    request.allow === undefined || request.allow.length === 0 ? defaultTeacherAllowlist() : request.allow,
  )
  const conflict = teacherModelConflict(request.candidates)
  if (conflict !== undefined) {
    throw new TeacherModelLockError(
      `teacher model lock conflict: the environment selected "${conflict.envModel}" while the composition configured "${conflict.configModel}"; a distillation run is pinned to one teacher`,
      'model-not-allowed',
    )
  }
  const chosen = request.candidates[0]
  if (chosen === undefined) {
    throw new TeacherModelLockError(
      `teacher model lock found no model: set ${TEACHER_MODEL_ENV[0]} or configure the composition's model`,
      'model-not-allowed',
    )
  }
  if (!allow.includes(chosen.model)) {
    throw new TeacherModelLockError(
      `teacher model lock refuses "${chosen.model}" from the ${chosen.source} layer; allowed models are ${allow.join(', ')}`,
      'model-not-allowed',
    )
  }
  return {
    model: chosen.model,
    source: chosen.source,
    ...chosen.envName === undefined ? {} : { envName: chosen.envName },
    legacy: chosen.model !== REQUIRED_TEACHER_MODEL,
    allow: [...allow],
  }
}
