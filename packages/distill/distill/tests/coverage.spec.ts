import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// Importing the barrel is deliberate: it is the package's public entry, so this
// suite also proves the entry re-exports what callers use.
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DatasetWriter,
  attemptIdFor,
  bucketFor,
  buildTrajectory,
  diffFingerprints,
  evaluate,
  evaluateTask,
  fingerprintDirectory,
  integrityFlags,
  loadTasks,
  looksLikeTestPath,
  matchesGlob,
  parseTask,
  prepareWorkspace,
  promptFor,
  runCommand,
  runTask,
  stageAssets,
  textOf,
} from '@deepseek-ai/dsh-distill'
import type { AgentRunner, AttemptContext } from '@deepseek-ai/dsh-distill'
import type { RawEvent } from '@deepseek-ai/dsh-distill-trajectory-events/writer'
import type { TaskDefinition } from '../src/types.ts'

const roots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-distill-cover-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('the package entry point re-exports its surface', () => {
  it('exposes every documented symbol', () => {
    expect(typeof runTask).toBe('function')
    expect(typeof loadTasks).toBe('function')
    expect(typeof DatasetWriter).toBe('function')
    expect(typeof buildTrajectory).toBe('function')
    expect(typeof parseTask).toBe('function')
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBe(120_000)
    expect(bucketFor('SUCCESS')).toBe('success')
    expect(attemptIdFor(0)).toBe('attempt_001')
    expect(matchesGlob('a.txt', '*.txt')).toBe(true)
    expect(textOf('x')).toBe('x')
    expect(looksLikeTestPath('a.test.ts')).toBe(true)
    expect(diffFingerprints({}, {})).toEqual({ added: [], changed: [], removed: [] })
    expect(promptFor({ prompt: 'p' } as TaskDefinition, { carryFailureFeedback: false })).toBe('p')
    expect(typeof prepareWorkspace).toBe('function')
    expect(typeof stageAssets).toBe('function')
    expect(typeof evaluate).toBe('function')
    expect(typeof evaluateTask).toBe('function')
    expect(typeof fingerprintDirectory).toBe('function')
    expect(typeof integrityFlags).toBe('function')
    expect(typeof runCommand).toBe('function')
  })
})

describe('task validation refusals', () => {
  const base = () => ({
    version: 1,
    task_id: 'T-1',
    prompt: 'p',
    workspace: { template: 't' },
    evaluator: { kind: 'test_command', command: ['true'] },
  })

  const rejects = (mutate: (document: Record<string, unknown>) => void, pattern: RegExp): void => {
    const document = base() as Record<string, unknown>
    mutate(document)
    expect(() => parseTask('t.yml', document)).toThrow(pattern)
  }

  it('refuses a workspace whose template is missing or whose lists are ill-typed', () => {
    rejects((d) => { (d.workspace as Record<string, unknown>).template = '' }, /template/)
    rejects((d) => { (d.workspace as Record<string, unknown>).include = 'x' }, /include/)
    rejects((d) => { (d.workspace as Record<string, unknown>).exclude = [1] }, /exclude/)
  })

  it('refuses malformed seed files', () => {
    rejects((d) => { (d.workspace as Record<string, unknown>).seed_files = 'x' }, /seed_files/)
    rejects((d) => { (d.workspace as Record<string, unknown>).seed_files = ['x'] }, /seed_files\[\]/)
  })

  it('refuses evaluator settings that cannot judge', () => {
    rejects((d) => { (d.evaluator as Record<string, unknown>).command = 'true' }, /evaluator.command/)
    rejects((d) => { (d.evaluator as Record<string, unknown>).expect_stdout_contains = 1 }, /expect_stdout_contains/)
    rejects((d) => { (d.evaluator as Record<string, unknown>).cwd = 1 }, /cwd/)
    rejects((d) => { (d.evaluator as Record<string, unknown>).timeout_ms = 0 }, /timeout_ms/)
    rejects((d) => { (d.evaluator as Record<string, unknown>).assets = [1] }, /assets/)
  })

  it('refuses a checks list that is not a list of valid checks', () => {
    rejects((d) => { d.checks = 'x' }, /checks/)
    rejects((d) => { d.checks = ['x'] }, /checks\[0\]/)
    rejects((d) => { d.checks = [{ kind: 'file_exists', path: 1 }] }, /path/)
    rejects((d) => { d.checks = [{ kind: 'command_succeeds', command: [1] }] }, /command/)
  })

  it('refuses ill-typed optional scalars', () => {
    rejects((d) => { d.initial_context = 1 }, /initial_context/)
    rejects((d) => { d.max_attempts = 0 }, /max_attempts/)
    rejects((d) => { d.batch = 0 }, /batch/)
    rejects((d) => { d.tags = [1] }, /tags/)
    rejects((d) => { d.env = 'x' }, /env/)
  })

  it('accepts every optional field when it is well formed', () => {
    const earlier = resolve(process.cwd(), 'x')
    expect(earlier.length).toBeGreaterThan(0)
    const task = parseTask('t.yml', {
      ...base(),
      initial_context: 'context',
      carry_failure_feedback: true,
      max_attempts: 2,
      batch: 1,
      tags: ['a'],
      env: { A: 'b' },
      tools: { allow: ['read'], deny: ['write'] },
      checks: [{ kind: 'command_succeeds', command: ['true'], timeout_ms: 1000 }],
      workspace: { template: 't', include: ['**'], exclude: ['x/**'], seed_files: [{ path: 'a', content: 'b' }] },
      evaluator: {
        kind: 'artifact_check',
        command: ['true'],
        cwd: '.',
        expect_exit_code: 0,
        expect_stdout_contains: 'ok',
        timeout_ms: 1000,
        assets: ['a'],
      },
    })
    expect(task.checks).toHaveLength(1)
    expect(task.tools).toEqual({ allow: ['read'], deny: ['write'] })
    expect(task.evaluator.expect_stdout_contains).toBe('ok')
    expect(task.workspace.seed_files).toHaveLength(1)
  })
})

describe('manifest validation refusals', () => {
  it('refuses a task entry that is not a mapping or lacks a file', async () => {
    const root = await scratch()
    await writeFile(join(root, 'a.yml'), 'version: 1\ntasks: ["x"]\n', 'utf8')
    await expect(loadTasks(join(root, 'a.yml'))).rejects.toThrow(/tasks\[0\]/)
    await writeFile(join(root, 'b.yml'), 'version: 1\ntasks: [{}]\n', 'utf8')
    await expect(loadTasks(join(root, 'b.yml'))).rejects.toThrow(/file/)
  })

  it('accepts a manifest that states no defaults', async () => {
    const root = await scratch()
    await writeFile(join(root, 'task.yml'), [
      'version: 1',
      'task_id: T-1',
      'prompt: p',
      'workspace: { template: t }',
      'evaluator: { kind: test_command, command: ["true"] }',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(root, 'm.yml'), 'version: 1\ntasks:\n  - file: task.yml\n', 'utf8')
    const loaded = await loadTasks(join(root, 'm.yml'))
    expect(loaded.defaults).toEqual({})
  })

  it('refuses defaults that are not a mapping', async () => {
    const root = await scratch()
    await writeFile(join(root, 'm.yml'), 'version: 1\ndefaults: nope\ntasks: []\n', 'utf8')
    await expect(loadTasks(join(root, 'm.yml'))).rejects.toThrow(/"defaults" must be a mapping/)
  })
  it('refuses a manifest that is a scalar', async () => {
    const root = await scratch()
    await writeFile(join(root, 'c.yml'), 'just a string\n', 'utf8')
    await expect(loadTasks(join(root, 'c.yml'))).rejects.toThrow(/must be a mapping/)
  })
})

describe('trajectory edge cases', () => {
  const event = (event_type: string, payload: Record<string, unknown>): RawEvent => ({
    event_id: 'id',
    seq: 0,
    task_id: 'T',
    attempt_id: 'attempt_001',
    batch_id: 'batch_0',
    event_type,
    timestamp: '2026-01-01T00:00:00.000Z',
    monotonic_ms: 0,
    payload,
  })
  const options = {
    attemptId: 'attempt_001',
    status: 'SUCCESS' as const,
    integrityFlags: [],
    evaluation: null,
    fileCapture: { git: false, coverage: 'file-tools-only' },
  }

  it('accepts the schema field name for a decision', () => {
    const trajectory = buildTrajectory([
      event('assistant_message', {
        step: 0,
        decision: { assistant_message: 'schema-shaped', reasoning: 'r', reasoning_available: true, tool_calls: [] },
      }),
    ], options)
    expect(trajectory.trajectory[0]?.decision.assistant_message).toBe('schema-shaped')
    expect(trajectory.final).toBe('schema-shaped')
  })

  it('treats an empty reasoning string as unavailable', () => {
    const trajectory = buildTrajectory([
      event('assistant_message', { step: 0, decision: { text: 'x', reasoning: '', reasoning_available: true, tool_calls: [] } }),
    ], options)
    expect(trajectory.trajectory[0]?.decision.reasoning).toBeNull()
    expect(trajectory.trajectory[0]?.decision.reasoning_available).toBe(false)
  })

  it('ignores an assistant message with no decision', () => {
    expect(buildTrajectory([event('assistant_message', { step: 0 })], options).trajectory).toEqual([])
  })

  it('keeps a spilled observation preview', () => {
    const trajectory = buildTrajectory([
      event('assistant_message', { step: 0, decision: { text: 'x', reasoning: null, reasoning_available: false, tool_calls: [] } }),
      event('tool_result', {
        step: 0,
        tool_call_id: 'c1',
        is_error: true,
        content: { truncated: true, preview: 'head…' },
        error: { code: 'E' },
      }),
    ], options)
    expect(trajectory.trajectory[0]?.observations[0]?.content).toBe('head…')
    expect(trajectory.trajectory[0]?.observations[0]?.is_error).toBe(true)
  })

  it('keeps a plain string observation and a missing action', () => {
    const trajectory = buildTrajectory([
      event('assistant_message', { step: 0, decision: { text: 'x', reasoning: null, reasoning_available: false, tool_calls: [] } }),
      event('tool_result', { step: 0, tool_call_id: 'unmatched', is_error: false, content: 'plain' }),
    ], options)
    // No action matched, so no terminal shape is attached.
    expect(trajectory.trajectory[0]?.observations[0]?.terminal).toBeUndefined()
  })

  it('reads the model the provider reported serving the request', () => {
    const trajectory = buildTrajectory([
      event('task_start', { phase: 'response-header', model: 'deepseek-flash-2026' }),
    ], options)
    expect(trajectory.teacher.served_model).toBe('deepseek-flash-2026')
    // An empty or absent name states nothing rather than naming an empty model.
    expect(buildTrajectory([event('task_start', { phase: 'response-header', model: '' })], options)
      .teacher.served_model).toBeNull()
  })

  it('lists a modified file apart from the ones created and deleted', () => {
    const trajectory = buildTrajectory([], {
      ...options,
      fileChanges: [
        { path: 'kept.txt', change: 'modified' },
        { path: 'new.txt', change: 'created' },
        { path: 'gone.txt', change: 'deleted' },
      ],
    })
    expect(trajectory.artifacts.files_modified).toEqual(['kept.txt'])
    expect(trajectory.artifacts.files_created).toEqual(['new.txt'])
    expect(trajectory.artifacts.files_deleted).toEqual(['gone.txt'])
  })
  it('ignores a request header without a config', () => {
    const trajectory = buildTrajectory([event('task_start', { phase: 'request-header' })], options)
    expect(trajectory.teacher.model).toBe('unknown')
  })
})

describe('runner safety valves', () => {
  const MARKER = {
    kind: 'test_command' as const,
    command: [
      process.execPath,
      '-e',
      'const fs=require("node:fs");process.exit(fs.existsSync(require("node:path").join("..","workspace","marker.txt"))?0:1)',
    ],
  }

  async function run(behaviour: (context: AttemptContext) => Promise<{ status: 'SUCCESS' | 'FAILED' | 'ERROR' | 'UNKNOWN'; errorClass?: 'agent' | 'infrastructure'; reason: string }>, defaults: Record<string, unknown>): Promise<{ status: string; attempts: number; errorClass?: string }> {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    const agent: AgentRunner = { run: behaviour }
    const result = await runTask({
      task: { version: 1, task_id: 'T', prompt: 'p', workspace: { template: 'basic' }, evaluator: MARKER },
      defaults,
      templatesRoot: templates,
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset: new DatasetWriter({ root: join(root, 'dataset') }),
      agent,
    })
    return {
      status: result.status,
      attempts: result.attempts.length,
      ...result.errorClass === undefined ? {} : { errorClass: result.errorClass },
    }
  }

  it('stops at the absolute attempt ceiling when every attempt faults', async () => {
    const outcome = await run(
      async () => ({ status: 'ERROR', errorClass: 'infrastructure', reason: 'always broken' }),
      { max_attempts: 1, infra_error_consumes_attempt: false, infra_error_max: 999 },
    )
    // max_attempts * 4 + 10
    expect(outcome.attempts).toBe(14)
    expect(outcome.status).toBe('ERROR')
    expect(outcome.errorClass).toBe('infrastructure')
  })

  it('records an infrastructure attempt when the budget is consumed by it', async () => {
    const outcome = await run(
      async () => ({ status: 'ERROR', errorClass: 'infrastructure', reason: 'api 500' }),
      { max_attempts: 1, infra_error_consumes_attempt: true },
    )
    expect(outcome.attempts).toBe(1)
    expect(outcome.status).toBe('ERROR')
  })
})
