import { describe, expect, it } from 'vitest'
import {
  LEGACY_TEACHER_MODELS,
  REQUIRED_TEACHER_MODEL,
  TEACHER_MODEL_ENV,
  TeacherModelLockError,
  VIOLATION_SENTINEL,
  defaultTeacherAllowlist,
  resolveTeacherLock,
  teacherModelConflict,
  validateTeacherAllowlist,
} from '../src/lock.ts'
import type { TeacherModelCandidate } from '../src/lock.ts'

const DEFAULT_ENV_NAME: string = TEACHER_MODEL_ENV[0] ?? 'DSH_DISTILL_MODEL'
const env = (model: string, envName: string = DEFAULT_ENV_NAME): TeacherModelCandidate =>
  ({ model, source: 'env', envName })
const config = (model: string): TeacherModelCandidate => ({ model, source: 'config' })

/** Run a lock resolution expected to fail, returning the thrown error. */
function lockError(request: Parameters<typeof resolveTeacherLock>[0]): TeacherModelLockError {
  try {
    resolveTeacherLock(request)
  } catch (error) {
    if (error instanceof TeacherModelLockError) return error
    throw error
  }
  throw new Error('expected resolveTeacherLock to throw')
}

describe('module constants', () => {
  it('names the required teacher and its retired aliases', () => {
    expect(REQUIRED_TEACHER_MODEL).toBe('deepseek-flash')
    expect(LEGACY_TEACHER_MODELS).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])
    expect(TEACHER_MODEL_ENV[0]).toBe('DSH_DISTILL_MODEL')
    expect(TEACHER_MODEL_ENV).toContain('MODEL_NAME')
    expect(defaultTeacherAllowlist()).toEqual([
      'deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
    ])
  })
})

describe('validateTeacherAllowlist', () => {
  it('passes a non-empty allowlist through in order', () => {
    expect(validateTeacherAllowlist(['b-model', 'a-model'])).toEqual(['b-model', 'a-model'])
  })

  it('drops a duplicate while keeping the first occurrence', () => {
    expect(validateTeacherAllowlist(['a-model', 'b-model', 'a-model'])).toEqual(['a-model', 'b-model'])
  })

  it('refuses an empty allowlist', () => {
    const error = (() => {
      try { validateTeacherAllowlist([]) } catch (thrown) { return thrown as TeacherModelLockError }
      throw new Error('expected a throw')
    })()
    expect(error.code).toBe('empty-allowlist')
    expect(error.message).toContain('at least one allowed model')
  })

  it('refuses the widening sentinel with its own code', () => {
    const error = (() => {
      try { validateTeacherAllowlist([REQUIRED_TEACHER_MODEL, VIOLATION_SENTINEL]) } catch (thrown) {
        return thrown as TeacherModelLockError
      }
      throw new Error('expected a throw')
    })()
    expect(error.code).toBe('allowlist-widened')
    expect(error.message).toContain('not a lock')
  })

  it('refuses an empty or padded entry', () => {
    for (const entry of ['', ' deepseek-flash', 'deepseek-flash ']) {
      const error = (() => {
        try { validateTeacherAllowlist([entry]) } catch (thrown) { return thrown as TeacherModelLockError }
        throw new Error('expected a throw')
      })()
      expect(error.code, JSON.stringify(entry)).toBe('model-not-allowed')
      expect(error.message).toContain('without surrounding whitespace')
    }
  })

  it('names the offending entry in the failure', () => {
    expect(() => validateTeacherAllowlist([' deepseek-flash'])).toThrow(/" deepseek-flash"/)
  })

  it('rejects a widened allowlist that also carries a valid model', () => {
    expect(() => validateTeacherAllowlist([REQUIRED_TEACHER_MODEL, 'deepseek-v4-pro', VIOLATION_SENTINEL]))
      .toThrow(/not a lock/)
  })
})

describe('teacherModelConflict', () => {
  it('reports nothing when both layers agree', () => {
    expect(teacherModelConflict([env(REQUIRED_TEACHER_MODEL), config(REQUIRED_TEACHER_MODEL)])).toBeUndefined()
  })

  it('reports both models when the layers disagree', () => {
    expect(teacherModelConflict([env('deepseek-v4-flash'), config('deepseek-flash')]))
      .toEqual({ envModel: 'deepseek-v4-flash', configModel: 'deepseek-flash' })
  })

  it('reports nothing when only one layer speaks', () => {
    expect(teacherModelConflict([config('deepseek-flash')])).toBeUndefined()
    expect(teacherModelConflict([env('deepseek-flash')])).toBeUndefined()
    expect(teacherModelConflict([])).toBeUndefined()
  })
})

describe('resolveTeacherLock', () => {
  it('locks the environment model and records its variable', () => {
    const lock = resolveTeacherLock({ candidates: [env(REQUIRED_TEACHER_MODEL)] })
    expect(lock).toEqual({
      model: 'deepseek-flash', source: 'env', envName: 'DSH_DISTILL_MODEL',
      legacy: false, allow: defaultTeacherAllowlist(),
    })
  })

  it('falls back to the composition model when the environment is silent', () => {
    const lock = resolveTeacherLock({ candidates: [config(REQUIRED_TEACHER_MODEL)] })
    expect(lock.source).toBe('config')
    expect(lock.envName).toBeUndefined()
    expect(lock.model).toBe('deepseek-flash')
  })

  it('prefers the environment layer when both name the same model', () => {
    const lock = resolveTeacherLock({
      candidates: [env(REQUIRED_TEACHER_MODEL, 'MODEL_NAME'), config(REQUIRED_TEACHER_MODEL)],
    })
    expect(lock.source).toBe('env')
    expect(lock.envName).toBe('MODEL_NAME')
  })

  it('flags a retired alias instead of failing it', () => {
    const lock = resolveTeacherLock({ candidates: [config('deepseek-v4-flash')] })
    expect(lock.legacy).toBe(true)
    expect(lock.model).toBe('deepseek-v4-flash')
  })

  it('accepts a custom allowlist that names another teacher', () => {
    const lock = resolveTeacherLock({
      candidates: [config('deepseek-v4-pro')],
      allow: ['deepseek-v4-pro'],
    })
    expect(lock.model).toBe('deepseek-v4-pro')
    expect(lock.legacy).toBe(true)
    expect(lock.allow).toEqual(['deepseek-v4-pro'])
  })

  it('refuses a model outside the allowlist, naming the layer and the allowed set', () => {
    const error = lockError({ candidates: [config('deepseek-v4-pro')] })
    expect(error.code).toBe('model-not-allowed')
    expect(error.message).toContain('"deepseek-v4-pro"')
    expect(error.message).toContain('config layer')
    expect(error.message).toContain('deepseek-flash, deepseek-v4-flash')
  })

  it('refuses when the two layers disagree', () => {
    const error = lockError({
      candidates: [env('deepseek-v4-flash'), config('deepseek-v4-pro')],
    })
    expect(error.code).toBe('model-not-allowed')
    expect(error.message).toContain('lock conflict')
    expect(error.message).toContain('"deepseek-v4-flash"')
    expect(error.message).toContain('"deepseek-v4-pro"')
    expect(error.message).toContain('pinned to one teacher')
  })

  it('refuses when no layer names a model', () => {
    const error = lockError({ candidates: [] })
    expect(error.code).toBe('model-not-allowed')
    expect(error.message).toContain('found no model')
    expect(error.message).toContain(TEACHER_MODEL_ENV[0])
  })

  it('uses the built-in allowlist when the configured one is empty', () => {
    const lock = resolveTeacherLock({ candidates: [config(REQUIRED_TEACHER_MODEL)], allow: [] })
    expect(lock.allow).toEqual(defaultTeacherAllowlist())
  })

  it('returns a detached allowlist the caller cannot mutate into the lock', () => {
    const allow = ['deepseek-flash']
    const lock = resolveTeacherLock({ candidates: [config('deepseek-flash')], allow })
    allow.push('deepseek-v4-pro')
    expect(lock.allow).toEqual(['deepseek-flash'])
  })

  it('exposes a stable error identity for a failed lock', () => {
    const error = lockError({ candidates: [] })
    expect(error.name).toBe('TeacherModelLockError')
    expect(error).toBeInstanceOf(Error)
  })
})
