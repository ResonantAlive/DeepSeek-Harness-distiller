import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatasetWriter } from '../src/dataset.ts'
import { discardAttempt, attemptLimits, budgetBreach, endAttempt, promptFor, readEvents, repeatedAction, runTask, totalTokens } from '../src/runner.ts'
import type { AgentRunner, AttemptContext } from '../src/runner.ts'
import { buildTrajectory, textOf } from '../src/trajectory.ts'
import { parseRunnerArgs, resourcePlanFor } from '../../../../apps/distill/src/bin.ts'
import { validate } from '@deepseek-ai/dsh-distill-resource'
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
    expect(trajectory.teacher).toEqual({ provider: 'p', model: 'm', reasoning_effort: 'max', max_tokens: 9, served_model: null, temperature: null })
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

  it('reports the terminal facts a shell tool recorded', () => {
    // A tool that names only its shell still reports a terminal, with every
    // fact it did not state left explicit rather than guessed.
    const sparse = buildTrajectory([
      event('assistant_message', { step: 0, decision: { text: 'run', reasoning: null, reasoning_available: false, tool_calls: [] } }),
      event('tool_result', { step: 0, tool_call_id: 'c1', is_error: false, content: 'x', meta: { shell: 'pwsh' } }),
    ], {
      attemptId: 'attempt_001',
      status: 'SUCCESS',
      integrityFlags: [],
      evaluation: null,
      fileCapture: { git: false, coverage: 'file-tools-only' },
    })
    expect(sparse.trajectory[0]?.observations[0]?.terminal).toEqual({
      shell: 'pwsh', command: null, cwd: null, exit_code: null, signal: null,
      timed_out: false, aborted: false, stdout: '', stderr: '',
    })
  })

  it('separates the streams and exit code a shell tool recorded', () => {
    const trajectory = buildTrajectory([
      event('assistant_message', { step: 0, decision: { text: 'run', reasoning: null, reasoning_available: false, tool_calls: [] } }),
      event('tool_call', { step: 0, tool_call_id: 'c1', tool: 'bash', arguments: '{"command":"ls"}' }),
      event('tool_result', {
        step: 0,
        tool_call_id: 'c1',
        is_error: false,
        content: 'files\n[stderr]\nwarning',
        meta: {
          shell: 'bash', command: 'ls', workdir: '/work',
          exit_code: 2, signal: 'SIGKILL', timed_out: false, aborted: false, timeout_ms: 1000,
          stdout: 'files\n', stderr: 'warning\n',
        },
      }),
    ], {
      attemptId: 'attempt_001',
      status: 'SUCCESS',
      integrityFlags: [],
      evaluation: null,
      fileCapture: { git: false, coverage: 'file-tools-only' },
    })
    // The streams are separated and the exit code is real, which the merged
    // model-facing content cannot give a dataset consumer.
    expect(trajectory.trajectory[0]?.observations[0]?.terminal).toEqual({
      shell: 'bash', command: 'ls', cwd: '/work', exit_code: 2, signal: 'SIGKILL',
      timed_out: false, aborted: false, stdout: 'files\n', stderr: 'warning\n',
    })
  })

  it('reports no terminal for a result that recorded none', () => {
    const trajectory = buildTrajectory([
      event('assistant_message', { step: 0, decision: { text: 'run', reasoning: null, reasoning_available: false, tool_calls: [] } }),
      event('tool_call', { step: 0, tool_call_id: 'c1', tool: 'bash', arguments: '{"command":"ls"}' }),
      // A tool with no metadata, metadata naming no shell, and metadata that is
      // not a mapping all report nothing rather than guessing from the call.
      event('tool_result', { step: 0, tool_call_id: 'c1', is_error: false, content: 'files' }),
      event('tool_result', { step: 1, tool_call_id: 'c2', is_error: false, content: 'x', meta: { other: 1 } }),
      event('tool_result', { step: 2, tool_call_id: 'c3', is_error: false, content: 'x', meta: 'plain' }),
    ], {
      attemptId: 'attempt_001',
      status: 'SUCCESS',
      integrityFlags: [],
      evaluation: null,
      fileCapture: { git: false, coverage: 'file-tools-only' },
    })
    expect(trajectory.trajectory[0]?.observations.every(observation => observation.terminal === undefined)).toBe(true)
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
    expect(trajectory.teacher).toEqual({ provider: 'unknown', model: 'unknown', reasoning_effort: null, max_tokens: null, served_model: null, temperature: null })
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

  it('refuses a declared partitioning the measured host cannot hold', () => {
    const host = { cpu: 8, memoryMb: 8192, cpuSource: 'os' as const, memorySource: 'os' as const, platform: 'linux' }
    // One batch of the whole host minus the reserve fits.
    expect(validate(resourcePlanFor(parseRunnerArgs(['--manifest', 'm.yml', '--out', 'o']), host)).errors).toEqual([])
    // More batches than the host can seat is refused rather than silently trimmed.
    const over = resourcePlanFor(
      parseRunnerArgs(['--manifest', 'm.yml', '--out', 'o', '--batches', '4', '--batch-cpu', '8']),
      host,
    )
    expect(validate(over).errors.join(' ')).toContain('over-allocated CPU')
  })

  it('parses the partitioning flags and refuses an unusable value', () => {
    const args = parseRunnerArgs([
      '--manifest', 'm.yml', '--out', 'o',
      '--batches', '2', '--batch-cpu', '3', '--batch-ram-mb', '1024',
      '--reserved-cpu', '0', '--reserved-ram-mb', '512',
    ])
    expect([args.batches, args.batchCpu, args.batchRamMb, args.reservedCpu, args.reservedRamMb])
      .toEqual([2, 3, 1024, 0, 512])
    expect(() => parseRunnerArgs(['--manifest', 'm.yml', '--out', 'o', '--batches', '0'])).toThrow(/positive whole number/)
    expect(() => parseRunnerArgs(['--manifest', 'm.yml', '--out', 'o', '--reserved-cpu', '-1'])).toThrow(/zero or more/)
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

describe('attempt budgets', () => {
  const options = {
    attemptId: 'attempt_001',
    status: 'SUCCESS' as const,
    integrityFlags: [],
    evaluation: null,
    fileCapture: { git: false, coverage: 'file-tools-only' as const },
  }
  const step = (text: string, tool = 'read', args = '{"path":"a"}'): { event_type: string; payload: Record<string, unknown> }[] => [
    {
      event_type: 'assistant_message',
      payload: { step: 0, decision: { text, reasoning: null, reasoning_available: false, tool_calls: [{ tool_call_id: 'c1', tool, arguments: args }] } },
    },
    // Actions come from the committed call, not from the decision that announced it.
    { event_type: 'tool_call', payload: { step: 0, tool_call_id: 'c1', tool, arguments: args } },
  ]
  const event = (event_type: string, payload: Record<string, unknown>, monotonic_ms = 0): RawEvent => ({
    event_id: `id-${event_type}-${Math.random()}`,
    seq: 0,
    task_id: 'T',
    attempt_id: 'attempt_001',
    batch_id: 'batch_0',
    event_type,
    timestamp: '2026-01-01T00:00:00.000Z',
    monotonic_ms,
    payload,
  })

  it('treats a step with no actions as a break in a repeated run', () => {
    const trajectory = buildTrajectory([
      step('one'),
      [{ event_type: 'assistant_message', payload: { step: 1, decision: { text: 'thinking', reasoning: null, reasoning_available: false, tool_calls: [] } } }],
      step('two'),
    ].flat().map(entry => event(entry.event_type, entry.payload)), options)
    // The same call either side of a step that issued nothing is not a repeat.
    expect(repeatedAction(trajectory, 2)).toBeUndefined()
  })

  it('reports a repeat through the whole budget check', () => {
    const trajectory = buildTrajectory(
      [step('one'), step('two')].flat().map(entry => event(entry.event_type, entry.payload)),
      options,
    )
    expect(budgetBreach(trajectory, [], { repeat_action_limit: 2 }))
      .toContain('repeated the same tool call 2 times')
  })

  it('reads a missing event log as no events rather than as an error', async () => {
    const root = await scratch()
    await expect(readEvents(join(root, 'absent', 'events.jsonl'))).resolves.toEqual([])
  })

  it('leaves a task UNKNOWN when the evaluator cannot run at all', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const result = await runTask({
      task: task({
        // A command that cannot start judges nothing, so no verdict exists.
        evaluator: { kind: 'test_command', command: ['definitely-not-a-real-command-xyz'] },
      }),
      defaults: { max_attempts: 3 },
      templatesRoot: await templatesAt(root),
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      agent: teacher(async (context) => {
        await succeed(context)
        return { status: 'SUCCESS', reason: 'the model claims it is done' }
      }),
    })
    expect(result.status).toBe('UNKNOWN')
    expect(result.datasetDir).toBe('invalid/unknown/T-X')
  })

  it('reports a file the attempt rewrote as modified', async () => {
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
        // The template supplies README.md, so rewriting it is a modification.
        await writeFile(join(context.workspace, 'README.md'), 'rewritten\n', 'utf8')
        await succeed(context)
        return { status: 'SUCCESS', reason: 'done' }
      }),
    })
    expect(result.attempts[0]?.artifacts.files_modified).toContain('README.md')
  })
  it('assumes five attempts when neither the task nor the manifest states one', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    let runs = 0
    const result = await runTask({
      task: task(),
      defaults: {},
      templatesRoot: await templatesAt(root),
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      agent: teacher(async () => {
        runs += 1
        return { status: 'FAILED', reason: 'not yet' }
      }),
    })
    expect(runs).toBe(5)
    expect(result.status).toBe('ABANDONED')
  })

  it('stages the hidden assets a task declares', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const evaluators = join(root, 'evaluator')
    await mkdir(join(evaluators, 'T-X'), { recursive: true })
    await writeFile(join(evaluators, 'T-X', 'suite.mjs'), 'export default 1\n', 'utf8')
    const result = await runTask({
      task: task({ evaluator: { ...MARKER_EVALUATOR, assets: ['suite.mjs'] } }),
      defaults: { max_attempts: 1 },
      templatesRoot: await templatesAt(root),
      evaluatorRoot: evaluators,
      runsRoot: join(root, 'runs'),
      dataset,
      agent: teacher(async (context) => {
        await succeed(context)
        return { status: 'SUCCESS', reason: 'done' }
      }),
    })
    // The asset was staged into the attempt's own evaluator directory.
    expect(existsSync(join(root, 'runs', 'T-X', 'attempt_001', 'evaluator', 'suite.mjs'))).toBe(true)
    expect(result.status).toBe('SUCCESS')
  })
  it('reads either end of a task attempt list, and refuses an empty one', () => {
    const attempts = buildTrajectory([], { ...options, attemptId: 'attempt_001' })
    const second = buildTrajectory([], { ...options, attemptId: 'attempt_002' })
    expect(endAttempt([attempts, second], 'first').attempt_id).toBe('attempt_001')
    expect(endAttempt([attempts, second], 'last').attempt_id).toBe('attempt_002')
    // A document that recorded no attempt at all cannot be summarised.
    expect(() => endAttempt([], 'first')).toThrow(/needs at least one attempt/)
    expect(() => endAttempt([], 'last')).toThrow(/needs at least one attempt/)
  })
  it('carries every budget a task or its manifest states', () => {
    const limits = attemptLimits({
      attempt_timeout_ms: 1000,
      max_steps_per_attempt: 2,
      max_tokens_per_attempt: 500,
      repeat_action_limit: 3,
    } as TaskDefinition, {})
    expect(limits).toEqual({
      attempt_timeout_ms: 1000,
      max_steps_per_attempt: 2,
      max_tokens_per_attempt: 500,
      repeat_action_limit: 3,
    })
  })

  it('counts usage that omits one of its totals', () => {
    expect(totalTokens([
      event('assistant_message', { phase: 'usage', usage: { inputTokens: 7 } }),
      event('assistant_message', { phase: 'usage', usage: { outputTokens: 3 } }),
    ])).toBe(10)
  })

  it('stays inside its repeat limit when no action repeats', () => {
    const trajectory = buildTrajectory(
      [step('one'), step('two', 'write', '{"path":"b"}')].flat().map(entry => event(entry.event_type, entry.payload)),
      options,
    )
    expect(budgetBreach(trajectory, [], { repeat_action_limit: 2 })).toBeUndefined()
  })

  it('records the environment, the task budget, and an agent error class', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const result = await runTask({
      task: task({ max_attempts: 2, evaluator: { ...MARKER_EVALUATOR, assets: [] } }),
      defaults: {},
      templatesRoot: await templatesAt(root),
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      environment: { available_tools: ['read', 'write'], sandbox_mode: 'workspace-write' },
      agent: teacher(async (context) => {
        await succeed(context)
        return { status: 'ERROR', errorClass: 'agent', reason: 'a tool rejected its arguments' }
      }),
    })
    // The evaluator judged the work, so its verdict stands over the agent's claim.
    expect(result.status).toBe('SUCCESS')
    expect(result.attempts[0]?.environment).toEqual({
      tools: null,
      available_tools: ['read', 'write'],
      sandbox_mode: 'workspace-write',
    })
  })
  it('surfaces the sampling temperature and the last failure', () => {
    const trajectory = buildTrajectory([
      event('task_start', { phase: 'request-header', config: { provider: 'p', model: 'm', temperature: 0.2 } }),
      event('error', { phase: 'agent', message: 'first' }),
      event('error', { phase: 'agent', message: 'last' }),
    ], options)
    expect(trajectory.teacher.temperature).toBe(0.2)
    // The latest failure is the one that ended the attempt.
    expect(trajectory.last_error).toEqual({ phase: 'agent', message: 'last' })
  })

  it('reports the environment the attempt ran with, and null where it states none', () => {
    const stated = buildTrajectory([
      event('task_start', {
        environment: { tools: { allow: ['read'] }, available_tools: ['read', 'write'], sandbox_mode: 'workspace-write' },
      }),
    ], options)
    expect(stated.environment).toEqual({
      tools: { allow: ['read'] },
      available_tools: ['read', 'write'],
      sandbox_mode: 'workspace-write',
    })
    // An attempt that recorded nothing about its environment says so.
    expect(buildTrajectory([], options).environment)
      .toEqual({ tools: null, available_tools: null, sandbox_mode: null })
    expect(buildTrajectory([], options).last_error).toBeNull()
  })
  it('measures how long a tool ran, not how long the turn did', () => {
    const trajectory = buildTrajectory([
      event('assistant_message', { step: 0, decision: { text: 'run', reasoning: null, reasoning_available: false, tool_calls: [] } }),
      event('tool_call', { step: 0, tool_call_id: 'c1', tool: 'bash', arguments: '{"command":"ls"}' }, 1000),
      event('tool_result', { step: 0, tool_call_id: 'c1', is_error: false, content: 'files' }, 1750),
    ], options)
    expect(trajectory.trajectory[0]?.observations[0]?.duration_ms).toBe(750)
  })

  it('reports a result whose call was never recorded as unmeasured', () => {
    const trajectory = buildTrajectory([
      event('assistant_message', { step: 0, decision: { text: 'run', reasoning: null, reasoning_available: false, tool_calls: [] } }),
      event('tool_result', { step: 0, tool_call_id: 'orphan', is_error: false, content: 'files' }, 1750),
    ], options)
    expect(trajectory.trajectory[0]?.observations[0]?.duration_ms).toBeNull()
  })

  it('lets the task override the manifest defaults', () => {
    const defaults = { max_steps_per_attempt: 5, attempt_timeout_ms: 1000 }
    expect(attemptLimits({ max_steps_per_attempt: 2 } as TaskDefinition, defaults))
      .toEqual({ max_steps_per_attempt: 2, attempt_timeout_ms: 1000 })
    expect(attemptLimits({} as TaskDefinition, defaults))
      .toEqual({ max_steps_per_attempt: 5, attempt_timeout_ms: 1000 })
  })

  it('sums the usage the adapter reported', () => {
    expect(totalTokens([
      event('assistant_message', { phase: 'usage', usage: { inputTokens: 10, outputTokens: 4 } }),
      event('assistant_message', { phase: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }),
      event('turn/start', { turn: 1 }),
      event('assistant_message', { phase: 'usage', usage: null }),
    ])).toBe(17)
  })

  it('reports a step budget the attempt overran', () => {
    const trajectory = buildTrajectory(
      [step('one'), step('two'), step('three')].flat().map(entry => event(entry.event_type, entry.payload)),
      options,
    )
    expect(budgetBreach(trajectory, [], { max_steps_per_attempt: 3 })).toBeUndefined()
    expect(budgetBreach(trajectory, [], { max_steps_per_attempt: 2 })).toContain('took 3 steps')
  })

  it('reports a token budget the attempt overran', () => {
    const events = [event('assistant_message', { phase: 'usage', usage: { inputTokens: 700, outputTokens: 400 } })]
    expect(budgetBreach(buildTrajectory([], options), events, { max_tokens_per_attempt: 1100 })).toBeUndefined()
    expect(budgetBreach(buildTrajectory([], options), events, { max_tokens_per_attempt: 1000 }))
      .toContain('spent 1100 tokens')
  })

  it('reports an action the attempt repeated without progress', () => {
    const trajectory = buildTrajectory(
      [step('one'), step('two'), step('three')].flat().map(entry => event(entry.event_type, entry.payload)),
      options,
    )
    expect(repeatedAction(trajectory, 4)).toBeUndefined()
    expect(repeatedAction(trajectory, 3)).toContain('repeated the same tool call 3 times')
    // A different call breaks the run, so a varied attempt is not stuck.
    const varied = buildTrajectory([
      step('one'),
      step('two', 'write', '{"path":"b"}'),
      step('three'),
    ].flat().map(entry => event(entry.event_type, entry.payload)), options)
    expect(repeatedAction(varied, 2)).toBeUndefined()
  })

  it('refuses to call an over-budget attempt a success', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const result = await runTask({
      task: task(),
      // The evaluator would pass; the budget is what rejects the run.
      defaults: { max_attempts: 1, max_steps_per_attempt: 0 },
      templatesRoot: await templatesAt(root),
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      agent: teacher(async (context) => {
        await context.recorder.append('assistant_message', {
          step: 0,
          decision: { text: 'working', reasoning: null, reasoning_available: false, tool_calls: [] },
        })
        await succeed(context)
        return { status: 'SUCCESS', reason: 'done' }
      }),
    })
    expect(result.status).toBe('ABANDONED')
    expect(result.attempts[0]?.status).toBe('FAILED')
    expect(result.datasetDir).toBe('abandoned/T-X')
  })
})
