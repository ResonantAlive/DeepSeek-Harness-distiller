import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_REDACTION_RULES, createRedactor } from '@deepseek-ai/dsh-distill-redaction'
import { BlobStore } from '../src/blobs.ts'
import { DEFAULT_MAX_INLINE_BYTES, DEFAULT_PREVIEW_BYTES, EventWriter, boundedJson } from '../src/writer.ts'
import type { RawEvent, SpilledField } from '../src/writer.ts'

/** Every built-in rule id, so a plain writer hides nothing. */
const ALL_RULE_IDS = DEFAULT_REDACTION_RULES.map(rule => rule.id)
const SECRET = 'fixture-secret-value-0123456789'
const roots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trajectory-events-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function writerAt(root: string, overrides: Partial<ConstructorParameters<typeof EventWriter>[0]> = {}): EventWriter {
  return new EventWriter({
    root,
    taskId: 'T-1',
    attemptId: 'attempt_001',
    batchId: 'batch_0',
    redactor: createRedactor({ secrets: [SECRET] }),
    blobs: new BlobStore({ root: join(root, 'blobs') }),
    ...overrides,
  })
}

/**
 * A writer whose redactor hides nothing. Budget-boundary assertions need content
 * that passes through untouched; the default redactor treats any eight-character
 * digit string as a possible secret.
 */
function plainWriterAt(root: string, overrides: Partial<ConstructorParameters<typeof EventWriter>[0]> = {}): EventWriter {
  return writerAt(root, { redactor: createRedactor({ disable: ALL_RULE_IDS }), ...overrides })
}

async function readEvents(root: string): Promise<RawEvent[]> {
  const text = await readFile(join(root, 'events.jsonl'), 'utf8')
  return text.trimEnd().split('\n').map(line => JSON.parse(line) as RawEvent)
}

/** Every file under `root`, recursively, with its text content. */
async function allFiles(root: string): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      out.push({ path: full, text: await readFile(full, 'utf8') })
    }
  }
  await walk(root)
  return out
}

describe('BlobStore', () => {
  it('stores content and reports its hash, length, and path', async () => {
    const root = await scratch()
    const store = new BlobStore({ root })
    const body = Buffer.from('hello blob', 'utf8')
    const ref = await store.put(body)
    expect(ref.sha256).toBe(createHash('sha256').update(body).digest('hex'))
    expect(ref.bytes).toBe(body.byteLength)
    expect(ref.path).toBe(`blobs/${ref.sha256.slice(0, 2)}/${ref.sha256}`)
    expect(await store.get(ref.sha256)).toEqual(body)
  })

  it('writes one file for identical content and a second for different content', async () => {
    const root = await scratch()
    const store = new BlobStore({ root })
    const first = await store.put(Buffer.from('same', 'utf8'))
    const again = await store.put(Buffer.from('same', 'utf8'))
    expect(again.sha256).toBe(first.sha256)
    const other = await store.put(Buffer.from('different', 'utf8'))
    expect(other.sha256).not.toBe(first.sha256)
    const bucket = await readdir(join(root, first.sha256.slice(0, 2)))
    expect(bucket).toContain(first.sha256)
  })

  it('counts bytes rather than characters for multi-byte content', async () => {
    const root = await scratch()
    const store = new BlobStore({ root })
    const ref = await store.put(Buffer.from('密钥', 'utf8'))
    expect(ref.bytes).toBe(6)
  })

  it('creates the bucket directory on demand', async () => {
    const root = await scratch()
    const store = new BlobStore({ root: join(root, 'deeply', 'nested', 'blobs') })
    const ref = await store.put(Buffer.from('x', 'utf8'))
    expect((await stat(join(root, 'deeply', 'nested', 'blobs', ref.sha256.slice(0, 2)))).isDirectory()).toBe(true)
  })
})

describe('boundedJson', () => {
  it('renders a value that fits the budget verbatim', () => {
    const value = { a: 1, b: [true, null, 'text'] }
    const result = boundedJson(value, 10_000)
    expect(result.truncated).toBe(false)
    expect(JSON.parse(result.text)).toEqual(value)
  })

  it('stops before exceeding the budget and says so', () => {
    const value = { keep: 'x'.repeat(50), drop: 'y'.repeat(500) }
    const result = boundedJson(value, 120)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(120)
  })

  it('emits nothing when even the opening container cannot fit', () => {
    const result = boundedJson({ a: 'b' }, 1)
    expect(result.text).toBe('')
    expect(result.truncated).toBe(true)
  })

  it('gives up on an empty object when its braces do not fit', () => {
    const result = boundedJson({}, 1)
    expect(result).toEqual({ text: '', truncated: true })
  })

  it('trims a huge string by stepping over its characters', () => {
    const result = boundedJson('z'.repeat(1000), 40)
    expect(result.truncated).toBe(true)
    // The prefix ends inside the string, so the walk stopped mid-way and closed it.
    expect(result.text.endsWith('"')).toBe(true)
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(40)
    expect(JSON.parse(result.text)).toBe('z'.repeat(result.text.length - 2))
  })

  it('keeps a prefix of one huge string instead of nothing', () => {
    const result = boundedJson('z'.repeat(1000), 40)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(40)
  })

  it('abandons the container when a nested string does not fit', () => {
    // The parent cannot close a partial child, so the object is abandoned. The
    // field is large enough that the writer spills it whole to a blob instead.
    const result = boundedJson({ note: 'q'.repeat(500) }, 30)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('')
  })

  it('abandons the container when the key alone consumes the budget', () => {
    const result = boundedJson({ note: 'q'.repeat(500) }, 12)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('')
  })

  it('gives up on a nested string when no room remains for a partial prefix', () => {
    // The key consumes the budget, so the string has no room for even one character.
    const result = boundedJson({ a: 'text' }, 5)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('')
  })

  it('handles a top-level primitive, array, and object', () => {
    expect(boundedJson(7, 100)).toEqual({ text: '7', truncated: false })
    expect(boundedJson(null, 100)).toEqual({ text: 'null', truncated: false })
    expect(boundedJson([1, 2], 100)).toEqual({ text: '[1,2]', truncated: false })
  })

  it('emits only balanced JSON at every budget', () => {
    const value = { a: [1, 2, { b: 'c'.repeat(40) }], d: true }
    for (let budget = 0; budget <= 80; budget++) {
      const { text, truncated } = boundedJson(value, budget)
      expect(Buffer.byteLength(text, 'utf8'), `budget ${String(budget)}`).toBeLessThanOrEqual(budget)
      if (text.length > 0) JSON.parse(text)
      if (!truncated) expect(JSON.parse(text)).toEqual(value)
    }
  })

  it('counts bytes for multi-byte strings', () => {
    const result = boundedJson('密钥密钥', 9)
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(8)
  })
})

describe('EventWriter', () => {
  it('appends one flushed JSON line per event with the full envelope', async () => {
    const root = await scratch()
    const writer = writerAt(root)
    await writer.append({ event_type: 'task_start', payload: { turn: 1 } })
    const events = await readEvents(root)
    expect(events).toHaveLength(1)
    const event = events[0] as RawEvent
    expect(Object.keys(event).sort()).toEqual([
      'attempt_id', 'batch_id', 'event_id', 'event_type', 'monotonic_ms', 'payload', 'seq', 'task_id', 'timestamp',
    ])
    expect(event.seq).toBe(0)
    expect(event.task_id).toBe('T-1')
    expect(event.attempt_id).toBe('attempt_001')
    expect(event.batch_id).toBe('batch_0')
    expect(event.event_type).toBe('task_start')
    expect(event.event_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp)
    expect(typeof event.monotonic_ms).toBe('number')
  })

  it('increments seq monotonically across appends', async () => {
    const root = await scratch()
    const writer = writerAt(root)
    await writer.append({ event_type: 'task_start', payload: {} })
    await writer.append({ event_type: 'tool_call', payload: {} })
    await writer.append({ event_type: 'tool_result', payload: {} })
    expect((await readEvents(root)).map(event => event.seq)).toEqual([0, 1, 2])
    expect(writer.length).toBe(3)
    expect(writer.path.endsWith('events.jsonl')).toBe(true)
  })

  it('creates the destination directory on first append', async () => {
    const root = await scratch()
    const writer = writerAt(join(root, 'nested', 'attempt'))
    await writer.append({ event_type: 'task_start', payload: {} })
    expect((await stat(join(root, 'nested', 'attempt', 'events.jsonl'))).isFile()).toBe(true)
  })

  it('redacts secrets in the inline payload', async () => {
    const root = await scratch()
    const writer = writerAt(root)
    await writer.append({
      event_type: 'tool_result',
      payload: { stdout: `DEEPSEEK_API_KEY=${SECRET}`, nested: { list: [SECRET] } },
    })
    const raw = await readFile(join(root, 'events.jsonl'), 'utf8')
    expect(raw).not.toContain(SECRET)
    expect(raw).toContain('[REDACTED:SECRET]')
  })

  it('spills an oversized field to a blob that itself contains no secret', async () => {
    const root = await scratch()
    const writer = writerAt(root, { maxInlineBytes: 200 })
    const big = `${SECRET} ${'payload '.repeat(2000)}`
    await writer.append({ event_type: 'tool_result', payload: { stdout: big, small: 'kept' } })
    const event = (await readEvents(root))[0] as RawEvent
    const spilled = event.payload.stdout as SpilledField
    expect(spilled.truncated).toBe(true)
    expect(spilled.original_bytes).toBeGreaterThan(200)
    expect(spilled.blob.path).toMatch(/^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/)
    expect(Buffer.byteLength(spilled.preview, 'utf8')).toBeLessThanOrEqual(DEFAULT_PREVIEW_BYTES)
    expect(event.payload.small).toBe('kept')
    // The stored blob is the redacted content, so the secret is absent from all of it.
    const blobText = await readFile(join(root, spilled.blob.path), 'utf8')
    expect(blobText).not.toContain(SECRET)
    expect(blobText).toContain('[REDACTED:SECRET]')
    expect(blobText.length).toBe(spilled.original_bytes)
  })

  it('leaves no secret anywhere in the attempt directory', async () => {
    const root = await scratch()
    const writer = writerAt(root, { maxInlineBytes: 100 })
    await writer.append({
      event_type: 'tool_result',
      payload: { stdout: SECRET, blob_candidate: `${SECRET}${'x'.repeat(5000)}` },
    })
    for (const file of await allFiles(root)) {
      expect(file.text, file.path).not.toContain(SECRET)
    }
  })

  it('keeps a field whose stored form is exactly the inline budget inline', async () => {
    const root = await scratch()
    // JSON quoting counts toward the budget: `"12345678"` is ten bytes.
    const writer = plainWriterAt(root, { maxInlineBytes: 10 })
    await writer.append({ event_type: 'tool_result', payload: { exact: '12345678' } })
    const event = (await readEvents(root))[0] as RawEvent
    expect(event.payload.exact).toBe('12345678')
  })

  it('spills one byte past the inline budget', async () => {
    const root = await scratch()
    // Nine characters encode to eleven bytes, one past the ten-byte budget.
    const writer = plainWriterAt(root, { maxInlineBytes: 10 })
    await writer.append({ event_type: 'tool_result', payload: { over: '123456789' } })
    const event = (await readEvents(root))[0] as RawEvent
    expect((event.payload.over as SpilledField).truncated).toBe(true)
  })

  it('uses the documented default inline budget', async () => {
    const root = await scratch()
    const writer = writerAt(root)
    expect(DEFAULT_MAX_INLINE_BYTES).toBe(64 * 1024)
    await writer.append({ event_type: 'tool_result', payload: { text: 'y'.repeat(DEFAULT_MAX_INLINE_BYTES + 1) } })
    const event = (await readEvents(root))[0] as RawEvent
    expect((event.payload.text as SpilledField).truncated).toBe(true)
  })

  it('preserves a top-level null, array, and number payload value', async () => {
    const root = await scratch()
    const writer = writerAt(root)
    await writer.append({ event_type: 'task_start', payload: { nothing: null, list: [1, 2], count: 3 } })
    const event = (await readEvents(root))[0] as RawEvent
    expect(event.payload).toEqual({ nothing: null, list: [1, 2], count: 3 })
  })

  it('surfaces a failed append and keeps serving later events', async () => {
    const root = await scratch()
    // Hold the blob root as a file so the spill cannot create its bucket.
    const blocked = join(root, 'blocked')
    await writeFile(blocked, 'not a directory', 'utf8')
    const writer = writerAt(root, {
      maxInlineBytes: 1,
      blobs: new BlobStore({ root: join(blocked, 'blobs') }),
    })
    await expect(writer.append({ event_type: 'tool_result', payload: { big: 'oversized' } })).rejects.toThrow()
    // A small event needs no bucket, so the writer still works after the failure.
    await writer.append({ event_type: 'task_start', payload: {} })
    expect((await readEvents(root)).at(-1)?.event_type).toBe('task_start')
  })
})
