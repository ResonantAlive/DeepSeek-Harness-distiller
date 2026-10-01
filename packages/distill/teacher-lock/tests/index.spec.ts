import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { TeacherModelLockError } from '../src/lock.ts'
import { apply, name } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/**
 * An environment with exactly `values` in its inherited layer; absent names must
 * stay absent so the config fallback is exercised.
 */
function withEnvironment(values: Record<string, string>) {
  return createLaunchEnvironmentSnapshot([{ source: 'process', values }])
}

/** A context carrying the given environment and optional default-model service. */
function contextWith(environment: ReturnType<typeof withEnvironment>, defaultModel?: string): Context {
  const ctx = new Context()
  ctx.provide('launchEnvironment', environment)
  if (defaultModel !== undefined) {
    // The lock reads only `currentSelection().model` through the global service
    // store, so a minimal stand-in is the honest shape for this boundary.
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek-official', model: defaultModel }) })
  }
  return ctx
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('plugin identity', () => {
  it('publishes a stable loader name', () => {
    expect(name).toBe('distill-teacher-lock')
  })
})

describe('apply', () => {
  it('prefers the environment variable and still refuses a composition that disagrees with it', () => {
    // Both layers naming a model is not enough; they must name the SAME model.
    const agreeing = contextWith(withEnvironment({ DSH_DISTILL_MODEL: 'deepseek-flash' }), 'deepseek-flash')
    expect(() => { apply(agreeing, {}) }).not.toThrow()
    const disagreeing = contextWith(withEnvironment({ DSH_DISTILL_MODEL: 'deepseek-flash' }), 'deepseek-v4-flash')
    expect(() => { apply(disagreeing, {}) }).toThrow(/lock conflict/)
  })

  it('reads MODEL_NAME when the distill variable is absent', () => {
    const ctx = contextWith(withEnvironment({ MODEL_NAME: 'deepseek-flash' }))
    expect(() => { apply(ctx, {}) }).not.toThrow()
  })

  it('falls back to the configured default model when no variable is set', () => {
    const ctx = contextWith(withEnvironment({}), 'deepseek-flash')
    expect(() => { apply(ctx, {}) }).not.toThrow()
  })

  it('falls back to the plugin model when no service is mounted', () => {
    const ctx = contextWith(withEnvironment({}))
    expect(() => { apply(ctx, { model: 'deepseek-flash' }) }).not.toThrow()
  })

  it('refuses a composition with no model anywhere', () => {
    const ctx = contextWith(withEnvironment({}))
    expect(() => { apply(ctx, {}) }).toThrow(/found no model/)
  })

  it('refuses an empty environment value instead of treating it as absent', () => {
    const ctx = contextWith(withEnvironment({ DSH_DISTILL_MODEL: '   ' }), 'deepseek-flash')
    expect(() => { apply(ctx, {}) }).toThrow(/set but empty/)
  })

  it('refuses a model outside the allowlist', () => {
    const ctx = contextWith(withEnvironment({ DSH_DISTILL_MODEL: 'deepseek-v4-pro' }))
    expect(() => { apply(ctx, {}) }).toThrow(TeacherModelLockError)
  })

  it('refuses a conflict between the environment and the composition', () => {
    const ctx = contextWith(withEnvironment({ DSH_DISTILL_MODEL: 'deepseek-v4-flash' }), 'deepseek-v4-pro')
    expect(() => { apply(ctx, {}) }).toThrow(/lock conflict/)
  })

  it('accepts a custom allowlist from the plugin config', () => {
    const ctx = contextWith(withEnvironment({ DSH_DISTILL_MODEL: 'deepseek-v4-pro' }))
    expect(() => { apply(ctx, { allow: ['deepseek-v4-pro'] } satisfies Config) }).not.toThrow()
  })

  it('warns about a retired alias without refusing it', () => {
    const ctx = contextWith(withEnvironment({ DSH_DISTILL_MODEL: 'deepseek-v4-flash' }))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})
    apply(ctx, {})
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain('retired alias')
    expect(String(info.mock.calls[0]?.[0])).toContain('pinned to "deepseek-v4-flash"')
    expect(String(info.mock.calls[0]?.[0])).toContain('DSH_DISTILL_MODEL')
  })

  it('does not warn for the required teacher and reports the config source', () => {
    const ctx = contextWith(withEnvironment({}), 'deepseek-flash')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})
    apply(ctx, {})
    expect(warn).not.toHaveBeenCalled()
    expect(String(info.mock.calls[0]?.[0])).toContain('from the config layer')
  })

  it('reports MODEL_NAME when it supplied the lock', () => {
    const ctx = contextWith(withEnvironment({ MODEL_NAME: 'deepseek-flash' }))
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})
    apply(ctx, {})
    expect(String(info.mock.calls[0]?.[0])).toContain('(MODEL_NAME)')
  })

  it('uses the inherited process environment when the launcher provided none', () => {
    vi.stubEnv('DSH_DISTILL_MODEL', 'deepseek-flash')
    const ctx = new Context()
    expect(() => { apply(ctx, {}) }).not.toThrow()
  })
})
