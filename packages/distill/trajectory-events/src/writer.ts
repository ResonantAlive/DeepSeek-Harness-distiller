/**
 * Append-only raw event log with redaction and blob spill.
 *
 * The writer is the boundary between a running agent and disk. Every payload is
 * redacted first, then any field whose stored form would exceed the inline budget
 * is written to a content-addressed blob and replaced by a reference plus a
 * bounded preview. Redaction runs before the spill, so a blob can never contain a
 * secret that the inline form would have hidden.
 *
 * Each event is one JSON line, flushed before the append resolves, so a crash
 * loses nothing that was already recorded.
 *
 * @module @deepseek-ai/dsh-distill-trajectory-events/writer
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import type { BlobStore, BlobRef } from './blobs.ts'
import { type Redactor } from '@deepseek-ai/dsh-distill-redaction'

/** One field replaced by a blob reference. */
export interface SpilledField {
  /** Where the full content is stored. */
  readonly blob: BlobRef
  /** The field's original serialized byte length, before any truncation. */
  readonly original_bytes: number
  /** A bounded, byte-accurate preview of the redacted content. */
  readonly preview: string
  /** Always `true`: the inline value is a preview, never the whole field. */
  readonly truncated: true
}

/** A recorded event as it appears on disk. */
export interface RawEvent {
  /** Stable identity for this event. */
  readonly event_id: string
  /** Monotonic position within the attempt's own log, starting at 0. */
  readonly seq: number
  /** The task this event belongs to. */
  readonly task_id: string
  /** The attempt this event belongs to. */
  readonly attempt_id: string
  /** The batch this attempt ran in. */
  readonly batch_id: string
  /** The kind of activity recorded. */
  readonly event_type: string
  /** UTC ISO-8601 timestamp with millisecond precision. */
  readonly timestamp: string
  /** Milliseconds since process start, for interval measurement that survives a wall-clock jump. */
  readonly monotonic_ms: number
  /** The redacted payload, with oversized fields replaced by {@link SpilledField}s. */
  readonly payload: Readonly<Record<string, unknown>>
}

/** One event handed to the writer, before identity and spill are applied. */
export interface RawEventInput {
  /** The kind of activity recorded. */
  readonly event_type: string
  /** The payload to redact and store. */
  readonly payload: Readonly<Record<string, unknown>>
}

/** The writer's configuration. */
export interface EventWriterOptions {
  /** Directory holding `events.jsonl` and `blobs/`. */
  readonly root: string
  /** The task identity stamped on every event. */
  readonly taskId: string
  /** The attempt identity stamped on every event. */
  readonly attemptId: string
  /** The batch identity stamped on every event. */
  readonly batchId: string
  /** The redactor applied to every payload before it reaches disk. */
  readonly redactor: Redactor
  /** Blob storage for oversized fields. */
  readonly blobs: BlobStore
  /**
   * Largest serialized field kept inline, in UTF-8 bytes. A larger field spills to
   * a blob. Defaults to {@link DEFAULT_MAX_INLINE_BYTES}.
   */
  readonly maxInlineBytes?: number
}

/** Default inline field budget: 64 KiB of UTF-8. */
export const DEFAULT_MAX_INLINE_BYTES = 64 * 1024

/** Preview budget for a spilled field, in bytes. */
export const DEFAULT_PREVIEW_BYTES = 512

/** Monotonic process clock used for `monotonic_ms`. */
const started = process.hrtime.bigint()

/** Current monotonic milliseconds since this module loaded. */
function monotonicMs(): number {
  return Number((process.hrtime.bigint() - started) / 1_000_000n)
}

/**
 * Longest prefix of encoded JSON text whose UTF-8 length fits `budget`.
 *
 * Slicing by character would overshoot on multi-byte content, so the walk steps
 * by code point and stops before the next one would not fit.
 *
 * @param text - the encoded JSON text.
 * @param budget - the byte budget.
 * @returns the fitting prefix.
 */
function prefixWithinBytes(text: string, budget: number): string {
  let used = 0
  let end = 0
  for (const character of text) {
    const cost = Buffer.byteLength(character, 'utf8')
    if (used + cost > budget) break
    used += cost
    end += character.length
  }
  return text.slice(0, end)
}

/**
 * Serialize the longest prefix of `value` that fits `budget` UTF-8 bytes.
 *
 * The emitted text is always valid JSON for a JSON input. The walk opens a
 * container only once it knows every closing bracket still fits: it renders the
 * container's children into the shared buffer first and commits the opening
 * delimiter only if the closing one was written too. A container that cannot be
 * closed therefore contributes nothing rather than an unparseable fragment.
 *
 * @param value - the redacted value to render.
 * @param budget - the byte budget.
 * @returns the prefix text and whether anything was left out.
 */
export function boundedJson(value: unknown, budget: number): { text: string; truncated: boolean } {
  const parts: string[] = []
  let used = 0
  const push = (text: string): boolean => {
    const cost = Buffer.byteLength(text, 'utf8')
    if (used + cost > budget) return false
    parts.push(text)
    used += cost
    return true
  }
  let truncated = false

  /**
   * Emit the longest byte-accurate prefix of a string, discarding anything already
   * buffered.
   *
   * This applies to a whole top-level value only. A string nested inside a
   * container cannot be closed by its parent once it is partial, so the parent is
   * abandoned instead; a field that carries such a string is large enough for the
   * writer's blob spill to have captured it whole, which is the mechanism that
   * keeps the full content rather than a fragment.
   *
   * @param encoded - the string already rendered as JSON, quotes included.
   */
  const trimString = (encoded: string): void => {
    // `used` is at most the budget here, so the closing quote may already be one
    // byte over; nothing can be emitted in that case.
    const room = budget - used - 1
    if (room <= 0) return
    const partial = prefixWithinBytes(encoded, room)
    parts.length = 0
    parts.push(`${partial}"`)
    used = budget
  }

  /** Render a container body into its own buffer, then commit it only when closed. */
  const container = (open: string, close: string, body: () => boolean): void => {
    // An earlier sibling already gave up, so this container cannot be closed and
    // must contribute nothing.
    if (truncated) return
    const outer = parts.length
    const outerUsed = used
    const openBytes = Buffer.byteLength(open, 'utf8')
    const closeBytes = Buffer.byteLength(close, 'utf8')
    // Both delimiters are reserved before the body runs and are appended directly,
    // so the emitted text never exceeds the caller's budget.
    if (used + openBytes + closeBytes > budget) { truncated = true; return }
    used += openBytes + closeBytes
    if (!body()) {
      parts.length = outer
      used = outerUsed
      truncated = true
      return
    }
    parts.splice(outer, 0, open)
    parts.push(close)
  }

  const walk = (node: unknown): void => {
    if (node === null || typeof node === 'number' || typeof node === 'boolean') {
      if (!push(JSON.stringify(node))) truncated = true
      return
    }
    if (typeof node === 'string') {
      // Trim the string itself when only part of it fits, so a single huge string
      // still yields a closed, byte-accurate JSON prefix instead of nothing.
      const encoded = JSON.stringify(node)
      if (push(encoded)) return
      truncated = true
      trimString(encoded)
      return
    }
    if (Array.isArray(node)) {
      container('[', ']', () => node.every((entry, index) => {
        if (index > 0 && !push(',')) return false
        walk(entry)
        return !truncated
      }))
      return
    }
    container('{', '}', () => {
      let first = true
      for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
        if (!first && !push(',')) return false
        if (!push(`${JSON.stringify(key)}:`)) return false
        first = false
        walk(entry)
        if (truncated) return false
      }
      return true
    })
  }
  walk(value)
  return { text: parts.join(''), truncated }
}

/** Append-only writer for one attempt's raw events. */
export class EventWriter {
  private seq = 0
  private readonly file: string
  private readonly maxInlineBytes: number
  private readonly redactor: Redactor
  private readonly blobs: BlobStore
  private readonly identity: Pick<RawEvent, 'task_id' | 'attempt_id' | 'batch_id'>

  /**
   * @param options - the destination directory, identities, redactor, and budgets.
   */
  constructor(options: EventWriterOptions) {
    this.file = `${options.root}/events.jsonl`
    this.maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES
    this.redactor = options.redactor
    this.blobs = options.blobs
    this.identity = {
      task_id: options.taskId,
      attempt_id: options.attemptId,
      batch_id: options.batchId,
    }
  }

  /** Number of events appended so far. */
  get length(): number {
    return this.seq
  }

  /** The `events.jsonl` path this writer appends to. */
  get path(): string {
    return this.file
  }

  /**
   * Redact a payload and replace oversized fields with blob references.
   * @param payload - the unredacted payload.
   * @returns the stored payload and how many fields spilled.
   */
  async plan(payload: Readonly<Record<string, unknown>>): Promise<{ payload: Record<string, unknown>; spilled: number }> {
    const redacted = this.redactor.redactValue(payload as never).value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    let spilled = 0
    for (const [key, value] of Object.entries(redacted)) {
      // `redacted` is a JSON value, so every property renders as text; only a
      // top-level `undefined` would not, and a property cannot hold one.
      const encoded = JSON.stringify(value)
      const bytes = Buffer.byteLength(encoded, 'utf8')
      if (bytes <= this.maxInlineBytes) {
        out[key] = value
        continue
      }
      const blob = await this.blobs.put(Buffer.from(encoded, 'utf8'))
      const preview = boundedJson(value, DEFAULT_PREVIEW_BYTES)
      out[key] = {
        blob,
        original_bytes: bytes,
        preview: preview.text,
        truncated: true,
      } satisfies SpilledField
      spilled += 1
    }
    return { payload: out, spilled }
  }

  /**
   * Append one event and flush it.
   * @param input - the event kind and its unredacted payload.
   * @returns the event as written.
   */
  async append(input: RawEventInput): Promise<RawEvent> {
    const planned = await this.plan(input.payload)
    const event: RawEvent = {
      event_id: randomUUID(),
      seq: this.seq,
      ...this.identity,
      event_type: input.event_type,
      timestamp: new Date().toISOString(),
      monotonic_ms: monotonicMs(),
      payload: planned.payload,
    }
    await mkdir(this.file.slice(0, this.file.lastIndexOf('/')), { recursive: true })
    await appendFile(this.file, `${JSON.stringify(event)}\n`, 'utf8')
    this.seq += 1
    return event
  }
}
