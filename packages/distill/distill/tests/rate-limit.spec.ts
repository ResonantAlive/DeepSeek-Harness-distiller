import { describe, expect, it } from 'vitest'
import { RateLimitGate, parseRetryAfter, rateLimitOf, retryAfterOf } from '../src/rate-limit.ts'

/** A clock the test advances by hand, so no case depends on real time passing. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void; waited: number[] } {
  let current = 1_000
  const waited: number[] = []
  return {
    now: () => current,
    // Waiting advances the clock instead of blocking, which is what makes the
    // backoff observable without a test that sleeps for a minute.
    sleep: async (ms: number) => { waited.push(ms); current += ms },
    advance: (ms: number) => { current += ms },
    waited,
  }
}

describe('parseRetryAfter', () => {
  it('reads the whole-seconds form', () => {
    expect(parseRetryAfter('5')).toBe(5000)
    expect(parseRetryAfter(' 2 ')).toBe(2000)
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('reads the HTTP-date form relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000)
    // A date already in the past asks for no wait rather than a negative one.
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now + 5000)).toBe(0)
  })

  it('reports no wait for an absent or unreadable value', () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter(undefined)).toBeUndefined()
    expect(parseRetryAfter('')).toBeUndefined()
    expect(parseRetryAfter('   ')).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
    expect(parseRetryAfter('-5')).toBeUndefined()
  })
})

describe('retryAfterOf', () => {
  it('recovers the wait a provider wrote into its message', () => {
    expect(retryAfterOf('HTTP 429 retry-after: 12')).toBe(12_000)
    expect(retryAfterOf('429 "retry_after": 3')).toBe(3000)
    expect(retryAfterOf("rate limited retry-after='7'")).toBe(7000)
  })

  it('reports no wait when the message states none', () => {
    expect(retryAfterOf('HTTP 429')).toBeUndefined()
    expect(retryAfterOf('retry-after: soon')).toBeUndefined()
  })

  it('falls back to the leading digits of an otherwise unreadable wait', () => {
    // The first form reads `12x` and cannot use it; the fallback takes `12`.
    expect(retryAfterOf('retry-after=12x')).toBe(12_000)
  })
})

describe('rateLimitOf', () => {
  it('recognises the ways a provider refuses for frequency', () => {
    expect(rateLimitOf('request failed with status 429')).toBeDefined()
    expect(rateLimitOf('Too Many Requests')).toBeDefined()
    expect(rateLimitOf('rate limit exceeded')).toBeDefined()
    expect(rateLimitOf('rate_limit reached')).toBeDefined()
  })

  it('carries the stated wait through', () => {
    expect(rateLimitOf('429 retry-after: 9')).toEqual({ retryAfterMs: 9000 })
    expect(rateLimitOf('429')).toEqual({})
  })

  it('leaves an unrelated failure alone', () => {
    expect(rateLimitOf('connection reset by peer')).toBeUndefined()
    expect(rateLimitOf('the evaluator failed')).toBeUndefined()
  })
})

describe('RateLimitGate', () => {
  it('bounds how many attempts are in flight', async () => {
    const gate = new RateLimitGate({ maxConcurrent: 2 })
    let peak = 0
    let running = 0
    const work = async (): Promise<void> => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 5))
      running -= 1
    }
    await Promise.all([gate.run(work), gate.run(work), gate.run(work), gate.run(work)])
    expect(peak).toBeLessThanOrEqual(2)
    expect(gate.active).toBe(0)
  })

  it('holds every later attempt back for as long as the provider asked', async () => {
    const c = clock()
    const gate = new RateLimitGate({ now: c.now, sleep: c.sleep })
    await gate.run(async () => 'first')
    gate.noteRefused({ retryAfterMs: 4000 })
    expect(gate.held).toBe(true)
    const result = await gate.run(async () => 'second')
    expect(result).toBe('second')
    expect(c.waited).toEqual([4000])
    expect(gate.held).toBe(false)
  })

  it('uses the default wait when the provider states none', async () => {
    const c = clock()
    const gate = new RateLimitGate({ now: c.now, sleep: c.sleep, defaultBackoffMs: 1500 })
    gate.noteRefused()
    await gate.run(async () => 'work')
    expect(c.waited).toEqual([1500])
  })

  it('keeps the longest wait when several refusals overlap', async () => {
    const c = clock()
    const gate = new RateLimitGate({ now: c.now, sleep: c.sleep, defaultBackoffMs: 1000 })
    gate.noteRefused({ retryAfterMs: 5000 })
    // A shorter later notice must not shorten the wait already imposed.
    gate.noteRefused({ retryAfterMs: 100 })
    await gate.run(async () => 'work')
    expect(c.waited).toEqual([5000])
  })

  it('releases its slot even when the attempt throws', async () => {
    const gate = new RateLimitGate({ maxConcurrent: 1 })
    await expect(gate.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(gate.active).toBe(0)
    await expect(gate.run(async () => 'after')).resolves.toBe('after')
  })

  it('waits on the real clock when the caller supplies none', async () => {
    // The default clock and timer are what a run without injected options uses,
    // so a short real wait proves them rather than leaving them untested.
    const gate = new RateLimitGate()
    gate.noteRefused({ retryAfterMs: 5 })
    await expect(gate.run(async () => 'work')).resolves.toBe('work')
  })
})
