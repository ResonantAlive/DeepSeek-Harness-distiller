import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatasetWriter } from '../src/dataset.ts'
import { discardAttempt, promptFor, runTask } from '../src/runner.ts'
import type { AgentRunner, AttemptContext } from '../src/runner.ts'
import { buildTrajectory, textOf } from '../src/trajectory.ts'
import { parseRunnerArgs } from '../../../../apps/distill/src/bin.ts'
import type { RawEvent } from '@deepseek-ai/dsh-distill-trajectory-events/writer'
import type { TaskDefinition } from '../src/types.ts'

const roots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-distill-extra-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** The evaluator used by these cases: passes only when the workspace holds the marker. */
const MARKER_EVALUATOR = {
  kind: 'test_command' as const,
  command: [
    process.execPath,
    '-e',
    'const fs=require("node:fs");process.exit(fs.existsSync(require("node:path").join("..","workspace","marker.txt"))?0:1)',
  ],
}

/** A teacher that runs the supplied behaviour for every attempt. */
function teacher(run: (context: AttemptContext) => Promise<{ status: 'SUCCESS' | 'FAILED' | 'ERROR' | 'UNKNOWN'; errorClass?: 'agent' | 'infrastructure'; reason: string }>): AgentRunner {
  return { run }
}

/** Build a task over the `basic` template. */
function task(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    version: 1,
    task_id: 'T-X',
    prompt: 'make the marker',
    workspace: { template: 'basic' },
    evaluator: MARKER_EVALUATOR,
    ...overrides,
  }
}

/** Create the template directory these cases use. */
async function templatesAt(root: string): Promise<string> {
  const templates = join(root, 'templates')
  await mkdir(join(templates, 'basic'), { recursive: true })
  await writeFile(join(templates, 'basic', 'README.md'), 'template\n', 'utf8')
  return templates
}

/** Write the marker the evaluator looks for. */
async function succeed(context: AttemptContext): Promise<void> {
  await writeFile(join(context.workspace, 'marker.txt'), 'done\n', 'utf8')
}

describe('runTask failure paths', () => {
  it('records an agent that throws as an infrastructure error and retries', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    let calls = 0
    const result = await runTask({
      task: task(),
      defaults: { max_attempts: 2, infra_error_consumes_attempt: true },
      templatesRoot: await templatesAt(root),
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      agent: teacher(async (context) => {
        calls += 1
        if (calls === 1) throw new Error('the harness fell over')
        await succeed(context)
        return { status: 'SUCCESS', reason: 'recovered' }
      }),
    })
    expect(result.status).toBe('SUCCESS')
    expect(result.attempts).toHaveLength(2)
    expect(result.attempts[0]?.status).toBe('ERROR')
    expect(result.attempts[0]?.evaluation).toBeNull()
  })

  it('gives up when the infrastructure ceiling is reached', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const result = await runTask({
      task: task(),
      defaults: { max_attempts: 1, infra_error_consumes_attempt: false, infra_error_max: 2 },
      templatesRoot: await templatesAt(root),
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      agent: teacher(async () => ({ status: 'ERROR', errorClass: 'infrastructure', reason: 'api down' })),
    })
    expect(result.status).toBe('ERROR')
    expect(result.errorClass).toBe('infrastructure')
    expect(result.attempts).toHaveLength(2)
  })

  it('keeps the evaluator verdict even when the agent declares UNKNOWN', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const result = await runTask({
      task: task(),
      defaults: { max_attempts: 3 },
      templatesRoot: await templatesAt(root),
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      agent: teacher(async (context) => {
        // The work is real; only the agent's own label is wrong.
        await succeed(context)
        return { status: 'UNKNOWN', reason: 'the model refused to claim a result' }
      }),
    })
    // The evaluator passed, so the verdict is SUCCESS; a model's own status claim
    // never overrides an objective judgment.
    expect(result.status).toBe('SUCCESS')
    expect(result.attempts).toHaveLength(1)
  })

  it('keeps an objective success even when the agent labels itself ERROR', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const result = await runTask({
      task: task(),
      defaults: { max_attempts: 2 },
      templatesRoot: await templatesAt(root),
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      agent: teacher(async (context) => {
        // The work is real; only the agent's own label is wrong.
        await succeed(context)
        return { status: 'ERROR', errorClass: 'agent', reason: 'the model reported a failure' }
      }),
    })
    expect(result.status).toBe('SUCCESS')
    expect(result.attempts).toHaveLength(1)
  })

  it('flags a teacher whose reported model differs from the expected one', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const result = await runTask({
      task: task(),
      defaults: { max_attempts: 1 },
      templatesRoot: await templatesAt(root),
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      expectedTeacherModel: 'deepseek-flash',
      agent: teacher(async (context) => {
        // Record a different model than the lock expects.
        await context.recorder.append('task_start', {
          phase: 'request-header',
          config: { provider: 'mock', model: 'deepseek-v4-pro' },
        })
        await succeed(context)
        return { status: 'SUCCESS', reason: 'done' }
      }),
    })
    expect(result.integrityFlags).toContain('model_mismatch')
    expect(result.status).toBe('FAILED')
    expect(result.datasetDir).toBe('failed/T-X')
  })

  it('flags a deleted scaffold file and a new test-shaped file', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const result = await runTask({
      task: task(),
      defaults: { max_attempts: 1 },
      templatesRoot: await templatesAt(root),
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      agent: teacher(async (context) => {
        const { rm: remove } = await import('node:fs/promises')
        await remove(join(context.workspace, 'README.md'))
        await writeFile(join(context.workspace, 'thing.test.mjs'), 'x\n', 'utf8')
        await succeed(context)
        return { status: 'SUCCESS', reason: 'done' }
      }),
    })
    expect(result.integrityFlags).toContain('scaffold_modified')
    expect(result.integrityFlags).toContain('test_shadowing')
    expect(result.attempts[0]?.artifacts.files_deleted).toContain('README.md')
    expect(result.attempts[0]?.artifacts.files_created).toContain('thing.test.mjs')
  })

  it('records a failed task with no selector after the budget is spent', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const result = await runTask({
      task: task(),
      defaults: { max_attempts: 1 },
      templatesRoot: await templatesAt(root),
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      agent: teacher(async () => ({ status: 'FAILED', reason: 'no marker' })),
    })
    expect(result.status).toBe('ABANDONED')
    expect(result.selectedAttemptId).toBeNull()
    expect(result.attempts[0]?.evaluation).toMatchObject({ status: 'FAILED' })
  })
})

describe('discardAttempt', () => {
  it('removes one attempt directory and leaves the others', async () => {
    const root = await scratch()
    const runs = join(root, 'runs')
    await mkdir(join(runs, 'T-X', 'attempt_001'), { recursive: true })
    await mkdir(join(runs, 'T-X', 'attempt_002'), { recursive: true })
    await discardAttempt(runs, 'T-X', 'attempt_001')
    expect(existsSync(join(runs, 'T-X', 'attempt_001'))).toBe(false)
    expect(existsSync(join(runs, 'T-X', 'attempt_002'))).toBe(true)
  })

  it('is a no-op for a directory that does not exist', async () => {
    const root = await scratch()
    await expect(discardAttempt(join(root, 'runs'), 'absent', 'attempt_001')).resolves.toBeUndefined()
  })
})

describe('buildTrajectory details', () => {
  const event = (event_type: string, payload: Record<string, unknown>, timestamp = '2026-01-01T00:00:00.000Z'): RawEvent => ({
    event_id: `id-${event_type}`,
    seq: 0,
    task_id: 'T',
    attempt_id: 'attempt_001',
    batch_id: 'batch_0',
    event_type,
    timestamp,
    monotonic_ms: 0,
    payload,
  })

  it('reports a spilled field by its preview', () => {
    expect(textOf({ truncated: true, preview: 'head…' })).toBe('head…')
    expect(textOf(null)).toBe('')
    expect(textOf(undefined)).toBe('')
    expect(textOf(7)).toBe('7')
  })

  it('concatenates the text blocks of a result and ignores other blocks', () => {
    const trajectory = buildTrajectory([
      event('assistant_message', {
        step: 0,
        decision: { text: 'run it', reasoning: 'because', reasoning_available: true, tool_calls: [] },
      }),
      event('tool_result', {
        step: 0,
        tool_call_id: 'call_1',
        is_error: false,
        content: [{ type: 'text', text: 'first' }, { type: 'image', source: {} }, { type: 'text', text: 'second' }],
      }),
    ], {
      attemptId: 'attempt_001',
      status: 'SUCCESS',
      integrityFlags: [],
      evaluation: null,
      fileCapture: { git: false, coverage: 'file-tools-only' },
    })
    expect(trajectory.trajectory[0]?.observations[0]?.content).toBe('firstsecond')
    expect(trajectory.final).toBe('firstsecond')
    expect(trajectory.trajectory[0]?.decision.reasoning).toBe('because')
    expect(trajectory.trajectory[0]?.decision.reasoning_available).toBe(true)
  })

  it('attaches the reasoning effort recorded by the header', () => {
    const trajectory = buildTrajectory([
      event('task_start', { phase: 'request-header', config: { provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 9 } }),
      event('assistant_message', { step: 0, decision: { text: 'hi', reasoning: null, reasoning_available: false, tool_calls: [] } }),
    ], {
      attemptId: 'attempt_001',
      status: 'SUCCESS',
      integrityFlags: [],
      evaluation: null,
      fileCapture: { git: false, coverage: 'file-tools-only' },
    })
    expect(trajectory.trajectory[0]?.decision.reasoning_effort).toBe('max')
    expect(trajectory.teacher).toEqual({ provider: 'p', model: 'm', reasoning_effort: 'max', max_tokens: 9 })
  })

  it('ignores bookkeeping assistant messages and unknown phases', () => {
    const trajectory = buildTrajectory([
      event('assistant_message', { phase: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }),
      event('task_start', { phase: 'user-message', content: [] }),
      event('task_start', { phase: 'session-event', type: 'todo/write', data: {} }),
      event('task_end', { phase: 'step-end', turn: 1, step: 1 }),
      event('attempt_end', { turn: 1, reason: { kind: 'completed' } }),
      event('reasoning_delta', { index: 0, text: 'thinking' }),
    ], {
      attemptId: 'attempt_001',
      status: 'SUCCESS',
      integrityFlags: [],
      evaluation: null,
      fileCapture: { git: false, coverage: 'file-tools-only' },
    })
    expect(trajectory.trajectory).toHaveLength(0)
  })

  it('attributes a file change to the action that caused it', () => {
    const trajectory = buildTrajectory([
      event('assistant_message', { step: 0, decision: { text: 'write', reasoning: null, reasoning_available: false, tool_calls: [] } }),
      event('tool_call', { step: 0, tool_call_id: 'call_7', tool: 'write', arguments: '{}' }),
    ], {
      attemptId: 'attempt_001',
      status: 'SUCCESS',
      integrityFlags: [],
      evaluation: null,
      fileCapture: { git: false, coverage: 'file-tools-only' },
      fileChanges: [
        { path: 'out.txt', change: 'created', tool_call_id: 'call_7' },
        { path: 'stray.txt', change: 'created' },
      ],
    })
    expect(trajectory.trajectory[0]?.file_changes).toEqual([{ path: 'out.txt', change: 'created', tool_call_id: 'call_7' }])
    // Artifacts still list every change, attributed or not.
    expect(trajectory.artifacts.files_created).toEqual(['out.txt', 'stray.txt'])
  })

  it('reports a terminal shape for a shell tool result', () => {
    const trajectory = buildTrajectory([
      event('assistant_message', { step: 0, decision: { text: 'run', reasoning: null, reasoning_available: false, tool_calls: [] } }),
      event('tool_call', { step: 0, tool_call_id: 'c1', tool: 'bash', arguments: '{"command":"ls"}' }),
      event('tool_result', { step: 0, tool_call_id: 'c1', is_error: false, content: 'files', exit_code: 0, timed_out: false }),
    ], {
      attemptId: 'attempt_001',
      status: 'SUCCESS',
      integrityFlags: [],
      evaluation: null,
      fileCapture: { git: false, coverage: 'file-tools-only' },
    })
    expect(trajectory.trajectory[0]?.observations[0]?.terminal).toEqual({
      shell: 'bash', command: '{"command":"ls"}', exit_code: 0, timed_out: false,
    })
  })

  it('uses an empty step list when no event was recorded', () => {
    const trajectory = buildTrajectory([], {
      attemptId: 'attempt_001',
      status: 'ABANDONED',
      integrityFlags: [],
      evaluation: null,
      fileCapture: { git: false, coverage: 'file-tools-only' },
    })
    expect(trajectory.trajectory).toEqual([])
    expect(trajectory.teacher).toEqual({ provider: 'unknown', model: 'unknown', reasoning_effort: null, max_tokens: null })
    expect(trajectory.duration_ms).toBe(0)
  })
})

describe('parseRunnerArgs', () => {
  it('parses the required flags and the optional paths', () => {
    const args = parseRunnerArgs([
      '--manifest', 'm.yml', '--out', 'out',
      '--templates', 't', '--evaluators', 'e', '--runs', 'r',
      '--task', 'T-1', '--task', 'T-2',
    ])
    expect(args.manifest.endsWith('m.yml')).toBe(true)
    expect(args.out.endsWith('out')).toBe(true)
    expect(args.templates?.endsWith('t')).toBe(true)
    expect(args.evaluators?.endsWith('e')).toBe(true)
    expect(args.runs?.endsWith('r')).toBe(true)
    expect(args.only).toEqual(['T-1', 'T-2'])
  })

  it('omits the optional paths when they are absent', () => {
    const args = parseRunnerArgs(['--manifest', 'm.yml', '--out', 'out'])
    expect(args.templates).toBeUndefined()
    expect(args.evaluators).toBeUndefined()
    expect(args.runs).toBeUndefined()
    expect(args.only).toBeUndefined()
  })

  it('refuses a missing required flag or an unknown argument', () => {
    expect(() => parseRunnerArgs(['--out', 'out'])).toThrow(/--manifest is required/)
    expect(() => parseRunnerArgs(['--manifest', 'm.yml'])).toThrow(/--out is required/)
    expect(() => parseRunnerArgs(['--manifest', 'm.yml', '--out', 'o', '--nope'])).toThrow(/unknown argument/)
    expect(() => parseRunnerArgs(['--manifest', '--out'])).toThrow(/needs a value/)
  })
})

describe('promptFor with context', () => {
  it('joins the prompt, the context, and the failure note in that order', () => {
    const definition = { prompt: 'P', initial_context: 'C' } as TaskDefinition
    expect(promptFor(definition, { carryFailureFeedback: true, lastFailure: 'L' }))
      .toBe('P\n\nC\n\nA previous attempt failed: L')
  })
})
