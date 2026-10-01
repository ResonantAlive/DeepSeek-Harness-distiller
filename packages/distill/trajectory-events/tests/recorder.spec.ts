import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { TrajectoryRecorder, apply, createRecorder, decisionOf, recordUsage } from '../src/index.ts'
import type { RawEvent } from '../src/writer.ts'

const SECRET = 'fixture-secret-value-0123456789'
const roots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-traj-recorder-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function recorderAt(root: string): TrajectoryRecorder {
  return new TrajectoryRecorder({
    root,
    taskId: 'T-1',
    attemptId: 'attempt_001',
    batchId: 'batch_0',
    secrets: [SECRET],
  })
}

/**
 * A session stand-in. The recorder reads only `session.id`, so the rest of the
 * production Session surface is irrelevant to what is being tested here.
 */
const session = { id: 'session-1' } as unknown as Session

/** Build a committed session event of the given type. */
function event<T extends SessionEvent['type']>(
  type: T,
  seq: number,
  data: Extract<SessionEvent, { type: T }>['data'],
): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

async function readEvents(root: string): Promise<RawEvent[]> {
  const text = await readFile(join(root, 'events.jsonl'), 'utf8')
  return text.trimEnd().split('\n').map(line => JSON.parse(line) as RawEvent)
}

describe('decisionOf', () => {
  it('reports text with no reasoning as unavailable', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hello' }]
    expect(decisionOf(blocks)).toEqual({
      text: 'hello', reasoning: null, reasoning_available: false, tool_calls: [],
    })
  })

  it('reports reasoning when the provider returned it', () => {
    const blocks: ContentBlock[] = [
      { type: 'reasoning', text: 'thinking hard' },
      { type: 'text', text: 'answer' },
    ]
    expect(decisionOf(blocks)).toEqual({
      text: 'answer', reasoning: 'thinking hard', reasoning_available: true, tool_calls: [],
    })
  })

  it('treats an empty reasoning block as unavailable rather than as empty reasoning', () => {
    const blocks: ContentBlock[] = [{ type: 'reasoning', text: '' }, { type: 'text', text: 'x' }]
    expect(decisionOf(blocks).reasoning).toBeNull()
    expect(decisionOf(blocks).reasoning_available).toBe(false)
  })

  it('concatenates several text and reasoning blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'reasoning', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'reasoning', text: 'c' },
      { type: 'text', text: 'd' },
    ]
    const decision = decisionOf(blocks)
    expect(decision.text).toBe('bd')
    expect(decision.reasoning).toBe('ac')
  })

  it('collects tool calls with their raw argument text', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: ToolCallId('call_1'), name: 'read', arguments: '{"path":"a.txt"}' },
      { type: 'tool-call', id: ToolCallId('call_2'), name: 'glob', arguments: '{}' },
    ]
    expect(decisionOf(blocks).tool_calls).toEqual([
      { tool_call_id: 'call_1', tool: 'read', arguments: '{"path":"a.txt"}' },
      { tool_call_id: 'call_2', tool: 'glob', arguments: '{}' },
    ])
  })

  it('ignores blocks that are not a decision', () => {
    const blocks: ContentBlock[] = [{
      type: 'image',
      attachment: { attachmentId: 'att-1', mediaType: 'image/png' },
    } as ContentBlock]
    expect(decisionOf(blocks)).toEqual({
      text: '', reasoning: null, reasoning_available: false, tool_calls: [],
    })
  })
})

describe('TrajectoryRecorder session events', () => {
  it('records turn, step, message, tool, and header activity with the full envelope', async () => {
    const root = await scratch()
    const recorder = recorderAt(root)
    recorder.record(session, event('turn/start', 0, { turn: 1 }))
    recorder.record(session, event('step/start', 1, { turn: 1, step: 1 }))
    recorder.record(session, event('request/header', 2, {
      reason: 'initial',
      header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } },
    }))
    recorder.record(session, event('assistant/message', 3, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model' } } as never,
      stream: [],
      usage: { inputTokens: 3, outputTokens: 4 },
    }))
    recorder.record(session, event('tool/call', 4, {
      turn: 1, step: 1, callId: ToolCallId('call_9'), name: 'read', arguments: '{"path":"a"}',
    }))
    recorder.record(session, event('tool/result', 5, {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: ToolCallId('call_9'),
        content: [{ type: 'text', text: 'file body' }],
        source: { kind: 'tool' },
        isError: false,
      } as never,
    }))
    recorder.record(session, event('step/end', 6, { turn: 1, step: 1 }))
    recorder.record(session, event('turn/end', 7, { turn: 1, reason: { kind: 'completed' } }))
    await recorder.flush()

    const events = await readEvents(root)
    expect(events.map(entry => entry.event_type)).toEqual([
      'task_start', 'task_start', 'task_start', 'assistant_message',
      'tool_call', 'tool_result', 'task_end', 'attempt_end',
    ])
    expect(recorder.length).toBe(8)
    expect(recorder.lastSessionSequence).toBe(7)

    for (const entry of events) {
      expect(Object.keys(entry).sort()).toEqual([
        'attempt_id', 'batch_id', 'event_id', 'event_type', 'monotonic_ms', 'payload', 'seq', 'task_id', 'timestamp',
      ])
      expect(entry.attempt_id).toBe('attempt_001')
    }

    const header = events[2] as RawEvent
    expect(header.payload).toMatchObject({
      phase: 'request-header',
      reason: 'initial',
      config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      adapter_defaults: null,
    })

    const assistant = events[3] as RawEvent
    expect(assistant.payload).toMatchObject({
      turn: 1,
      step: 1,
      usage: { inputTokens: 3, outputTokens: 4 },
      interrupted: false,
      decision: { text: 'done', reasoning: null, reasoning_available: false, tool_calls: [] },
    })

    const call = events[4] as RawEvent
    expect(call.payload).toMatchObject({
      tool_call_id: 'call_9', tool: 'read', arguments: '{"path":"a"}', turn: 1, step: 1,
    })

    const result = events[5] as RawEvent
    expect(result.payload).toMatchObject({
      tool_call_id: 'call_9', is_error: false, error: null, meta: null,
    })

    expect((events[7] as RawEvent).payload).toMatchObject({
      turn: 1, reason: { kind: 'completed' },
    })
  })

  it('records the user message and its source', async () => {
    const root = await scratch()
    const recorder = recorderAt(root)
    recorder.record(session, event('user/message', 0, {
      role: 'user',
      content: [{ type: 'text', text: 'do the thing' }],
      source: { kind: 'user' },
    } as never))
    await recorder.flush()
    const recorded = (await readEvents(root))[0] as RawEvent
    expect(recorded.payload.phase).toBe('user-message')
    expect(recorded.payload.content).toEqual([{ type: 'text', text: 'do the thing' }])
  })

  it('records a failed attempt and interrupted assistant message', async () => {
    const root = await scratch()
    const recorder = recorderAt(root)
    recorder.record(session, event('assistant/attempt', 0, {
      turn: 1, step: 1, stream: [{ type: 'text', text: 'partial' }] as never,
    }))
    recorder.record(session, event('assistant/message', 1, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], source: { kind: 'model' } } as never,
      stream: [],
      interrupted: true,
    }))
    recorder.record(session, event('tool/result', 2, {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: ToolCallId('call_1'),
        content: [],
        source: { kind: 'tool' },
        isError: true,
      } as never,
      error: { name: 'ToolError', code: 'BOOM', reason: 'exploded' },
      meta: { presentation: 'card' },
    }))
    await recorder.flush()
    const events = await readEvents(root)
    expect((events[0] as RawEvent).event_type).toBe('assistant_attempt')
    expect((events[1] as RawEvent).payload.interrupted).toBe(true)
    expect((events[2] as RawEvent).payload).toMatchObject({
      is_error: true,
      error: { name: 'ToolError', code: 'BOOM', reason: 'exploded' },
      meta: { presentation: 'card' },
    })
  })

  it('records request context and an unknown plugin event generically', async () => {
    const root = await scratch()
    const recorder = recorderAt(root)
    recorder.record(session, event('request/context', 0, {
      provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1_000_000,
    }))
    recorder.record(session, event('todo/write', 1, { items: [] } as never))
    await recorder.flush()
    const events = await readEvents(root)
    expect((events[0] as RawEvent).payload.phase).toBe('request-context')
    expect((events[1] as RawEvent).payload).toMatchObject({
      phase: 'session-event', type: 'todo/write', data: { items: [] },
    })
  })

  it('redacts secrets reaching an event payload', async () => {
    const root = await scratch()
    const recorder = recorderAt(root)
    recorder.record(session, event('tool/result', 0, {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: ToolCallId('call_1'),
        content: [{ type: 'text', text: `API_KEY=${SECRET}` }],
        source: { kind: 'tool' },
      } as never,
    }))
    await recorder.flush()
    const raw = await readFile(join(root, 'events.jsonl'), 'utf8')
    expect(raw).not.toContain(SECRET)
    expect(raw).toContain('[REDACTED:SECRET]')
  })
})

describe('TrajectoryRecorder stream frames', () => {
  const frame = (chunk: unknown): AssistantStreamFrame => ({ type: 'chunk', chunk } as AssistantStreamFrame)

  it('records reasoning and text deltas with their stream label', async () => {
    const root = await scratch()
    const recorder = recorderAt(root)
    recorder.recordStreamFrame(frame({ type: 'reasoning-delta', index: 0, text: 'think' }))
    recorder.recordStreamFrame(frame({ type: 'text-delta', index: 1, text: 'say' }))
    await recorder.flush()
    const events = await readEvents(root)
    expect(events[0]?.payload).toMatchObject({ index: 0, text: 'think' })
    expect(events[0]?.payload.stream).toBeUndefined()
    expect(events[1]?.payload).toMatchObject({ index: 1, text: 'say', stream: 'text' })
    expect(events.every(entry => entry.event_type === 'reasoning_delta')).toBe(true)
  })

  it('ignores empty deltas and non-chunk frames', async () => {
    const root = await scratch()
    const recorder = recorderAt(root)
    recorder.recordStreamFrame(frame({ type: 'reasoning-delta', index: 0, text: '' }))
    recorder.recordStreamFrame(frame({ type: 'text-delta', index: 0, text: '' }))
    recorder.recordStreamFrame(frame({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }))
    recorder.recordStreamFrame({ type: 'start', attempt: 'a' } as AssistantStreamFrame)
    recorder.recordStreamFrame({ type: 'end', attempt: 'a', settled: 'message' } as unknown as AssistantStreamFrame)
    await recorder.flush()
    expect(recorder.length).toBe(0)
  })
})

describe('recordUsage', () => {
  it('records the adapter-reported usage as its own event', async () => {
    const root = await scratch()
    const recorder = recorderAt(root)
    const written = await recordUsage(recorder, { inputTokens: 11, outputTokens: 22 })
    expect(written.event_type).toBe('assistant_message')
    expect(written.payload).toMatchObject({ phase: 'usage', usage: { inputTokens: 11, outputTokens: 22 } })
  })
})

describe('TrajectoryRecorder queueing', () => {
  it('keeps append order across many queued events', async () => {
    const root = await scratch()
    const recorder = recorderAt(root)
    for (let turn = 0; turn < 20; turn++) recorder.record(session, event('turn/start', turn, { turn }))
    await recorder.flush()
    const events = await readEvents(root)
    expect(events.map(entry => entry.seq)).toEqual(Array.from({ length: 20 }, (_value, index) => index))
    expect(events.map(entry => (entry.payload as { turn: number }).turn))
      .toEqual(Array.from({ length: 20 }, (_value, index) => index))
  })

  it('exposes its event path and redactor', async () => {
    const root = await scratch()
    const recorder = recorderAt(root)
    // The writer joins with a forward slash by construction, so assert on the
    // segment rather than on a platform-specific absolute path.
    expect(recorder.path.endsWith('events.jsonl')).toBe(true)
    expect(recorder.path.startsWith(root)).toBe(true)
    expect(recorder.redaction.redact(SECRET).value).toBe('[REDACTED:SECRET]')
  })
})

describe('createRecorder and the capture plugin', () => {
  it('builds a recorder through the factory', async () => {
    const root = await scratch()
    const recorder = createRecorder({
      root, taskId: 'T-9', attemptId: 'attempt_007', batchId: 'batch_1', secrets: [SECRET],
    })
    const written = await recorder.append('error', { message: SECRET })
    expect(written.task_id).toBe('T-9')
    expect(written.attempt_id).toBe('attempt_007')
    expect(written.batch_id).toBe('batch_1')
    expect(JSON.stringify(written.payload)).not.toContain(SECRET)
  })

  it('accepts a recorder with no configured secrets at all', async () => {
    const root = await scratch()
    const recorder = createRecorder({ root, taskId: 'T-1', attemptId: 'attempt_001', batchId: 'batch_0' })
    const written = await recorder.append('tool_call', { tool: 'read', arguments: '{}' })
    expect(written.payload).toEqual({ tool: 'read', arguments: '{}' })
  })

  it('accepts a recorder configured with literal secrets replaced by custom rules', async () => {
    const root = await scratch()
    // Both optional settings present: a disabled rule and an inline budget.
    const recorder = createRecorder({
      root,
      taskId: 'T-1',
      attemptId: 'attempt_001',
      batchId: 'batch_0',
      secrets: [SECRET],
      disableRules: ['sk-key', 'secret-assignment'],
      maxInlineBytes: 64,
    })
    const written = await recorder.append('tool_result', {
      literal: SECRET,
      key: 'sk-fixtureABCDEFGHIJKLMNOPQRSTUVWX',
      big: 'y'.repeat(200),
    })
    expect(written.payload.literal).toBe('[REDACTED:SECRET]')
    // Both rules that would match the key-shaped value are disabled, so it survives.
    expect(written.payload.key).toBe('sk-fixtureABCDEFGHIJKLMNOPQRSTUVWX')
    expect(written.payload.big).toMatchObject({ truncated: true })
  })

  it('captures every session event and live stream frame once mounted', async () => {
    const root = await scratch()
    const recorder = recorderAt(root)
    const ctx = new Context()
    apply(ctx, { recorder })
    // A committed session event reaches the recorder through the plugin's own
    // subscription, so this proves the wiring rather than the recorder alone.
    ctx.emit('session/event', session, event('turn/start', 0, { turn: 1 }))
    ctx.emit('agent/assistant-stream', {
      agent: { id: 'session-1' },
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'live' } },
    } as never)
    await recorder.flush()
    const events = await readEvents(root)
    expect(events.map(entry => entry.event_type).sort()).toEqual(['reasoning_delta', 'task_start'])
  })

  it('disposing the mounting context stops capture', async () => {
    const root = await scratch()
    const recorder = recorderAt(root)
    const ctx = new Context()
    const fiber = ctx.plugin({ apply: (inner: Context) => { apply(inner, { recorder }) } })
    await fiber
    await ctx.fiber.dispose()
    ctx.emit('session/event', session, event('turn/start', 0, { turn: 1 }))
    await recorder.flush()
    expect(recorder.length).toBe(0)
  })
})
