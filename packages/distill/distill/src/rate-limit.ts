/**
 * The one place that bounds how hard a distillation run pushes a provider.
 *
 * A corpus is many independent attempts, and the provider counts requests per
 * account rather than per attempt. Without a gate, a run that discovers the
 * limit discovers it as a wall of failures that the attempt loop then reads as
 * agent errors. The gate keeps a configured number of attempts in flight and,
 * once a provider says it is being asked too often, holds every later attempt
 * back for as long as the provider asked.
 *
 * @module @deepseek-ai/dsh-distill/rate-limit
 */

/** How the gate is configured and where its clock comes from. */
export interface RateLimitGateOptions {
  /** Attempts that may be in flight at once; defaults to 1. */
  readonly maxConcurrent?: number
  /** Milliseconds to hold back when a rate limit states no wait; defaults to 60_000. */
  readonly defaultBackoffMs?: number
  /** The clock; defaults to the system one. */
  readonly now?: () => number
  /** How to wait; defaults to a timer. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** What a provider said when it refused a request for being too frequent. */
export interface RateLimitNotice {
  /** Milliseconds the provider asked the caller to wait, when it said. */
  readonly retryAfterMs?: number
}

/** The statuses and phrases providers use for "you are asking too often". */
const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /\btoo many requests\b/i,
  /\brate[\s_-]?limit(?:ed|s)?\b/i,
]

/**
 * Read the wait a `Retry-After` value asks for.
 *
 * The header has two legal forms: a whole number of seconds, and an HTTP date.
 * Both appear in the wild, so both are read rather than only the newer one.
 *
 * @param value - the header value, or `null` when absent.
 * @param now - milliseconds since the epoch, for the date form.
 * @returns the wait in milliseconds, or `undefined` when the value states none.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  const seconds = Number(text)
  // A numeric value is the seconds form whether or not it is usable, so a
  // negative one is refused here rather than reinterpreted as a date.
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined
  const at = Date.parse(text)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

/**
 * Read the wait a failure's own message asks for.
 *
 * A rate limit reaches the attempt loop as text rather than as a response, so
 * the wait is recovered from the message when the provider put one there.
 *
 * @param message - the failure's message.
 * @param now - milliseconds since the epoch, for the date form.
 * @returns the wait in milliseconds, or `undefined` when the message states none.
 */
export function retryAfterOf(message: string, now: number = Date.now()): number | undefined {
  const header = /retry[-_ ]?after["'\s:=]+([^"',;)\s]+)/i.exec(message)
  if (header?.[1] !== undefined) {
    const parsed = parseRetryAfter(header[1], now)
    if (parsed !== undefined) return parsed
  }
  const plain = /retry[-_ ]?after["'\s:=]+([0-9]+)/i.exec(message)
  return plain?.[1] === undefined ? undefined : Number(plain[1]) * 1000
}

/**
 * Decide whether a failure was the provider refusing for being asked too often.
 *
 * @param message - the failure's message.
 * @param now - milliseconds since the epoch, for the date form.
 * @returns the notice, or `undefined` when the failure was something else.
 */
export function rateLimitOf(message: string, now: number = Date.now()): RateLimitNotice | undefined {
  if (!RATE_LIMIT_PATTERNS.some(pattern => pattern.test(message))) return undefined
  const retryAfterMs = retryAfterOf(message, now)
  return retryAfterMs === undefined ? {} : { retryAfterMs }
}

/** Bounds concurrency and holds work back after a provider refuses. */
export class RateLimitGate {
  private readonly maxConcurrent: number
  private readonly defaultBackoffMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private inFlight = 0
  /** The earliest moment the next attempt may start. */
  private resumeAt = 0
  private readonly waiting: (() => void)[] = []

  /**
   * @param options - concurrency, default backoff, and the clock.
   */
  constructor(options: RateLimitGateOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 1
    this.defaultBackoffMs = options.defaultBackoffMs ?? 60_000
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? (async (ms) => { await new Promise(resolve => setTimeout(resolve, ms)) })
  }

  /** Attempts currently in flight. */
  get active(): number {
    return this.inFlight
  }

  /** Whether the gate is holding work back. */
  get held(): boolean {
    return this.now() < this.resumeAt
  }

  /**
   * Hold every later attempt back, because a provider refused one.
   * @param notice - what the provider said, when it said anything.
   */
  noteRefused(notice: RateLimitNotice = {}): void {
    const until = this.now() + (notice.retryAfterMs ?? this.defaultBackoffMs)
    if (until > this.resumeAt) this.resumeAt = until
  }

  /**
   * Run one attempt once the gate lets it start.
   * @param work - the attempt, which must settle before its slot is released.
   * @returns the attempt's own result.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await work()
    } finally {
      this.release()
    }
  }

  /**
   * Wait for a slot and for any refusal to expire.
   *
   * Waiting happens before the slot is taken, so a held attempt does not occupy
   * concurrency that another could use.
   */
  private async acquire(): Promise<void> {
    for (;;) {
      const wait = this.resumeAt - this.now()
      if (wait > 0) {
        await this.sleep(wait)
        continue
      }
      if (this.inFlight < this.maxConcurrent) {
        this.inFlight += 1
        return
      }
      await new Promise<void>((resolve) => { this.waiting.push(resolve) })
    }
  }

  /** Release one slot and hand it to the next waiter, if any. */
  private release(): void {
    this.inFlight -= 1
    this.waiting.shift()?.()
  }
}
