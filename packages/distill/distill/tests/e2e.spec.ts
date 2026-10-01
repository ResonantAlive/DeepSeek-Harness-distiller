import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatasetWriter } from '../src/dataset.ts'
import { runTask } from '../src/runner.ts'
import type { AgentRunner, AttemptContext } from '../src/runner.ts'
import type { TaskDefinition } from '../src/types.ts'

const roots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-distill-e2e-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * The evaluator every case uses: it passes only when the workspace holds
 * `marker.txt`. A scripted teacher that intends to succeed writes that file, so
 * the verdict follows from the workspace rather than from the teacher's report.
 */
const MARKER_EVALUATOR = {
  kind: 'test_command' as const,
  command: [
    process.execPath,
    '-e',
    'process.exit(require("node:fs").existsSync(require("node:path").join("..", "workspace", "marker.txt")) ? 0 : 1)',
  ],
}

/** Teach the attempt to pass by writing the marker the evaluator looks for. */
async function writeMarker(context: AttemptContext): Promise<void> {
  const { writeFile: write } = await import('node:fs/promises')
  await write(join(context.workspace, 'marker.txt'), 'done\n', 'utf8')
}

/**
 * A scripted teacher: one behaviour per attempt, in order, repeating the last
 * one once the script is exhausted. Repeating matters because a thrown error is
 * classified as an infrastructure fault, which by design does not consume an
 * attempt slot.
 */
class ScriptedTeacher implements AgentRunner {
  readonly prompts: string[] = []

  /**
   * @param behaviours - one outcome per attempt, repeating the last when exhausted.
   * @param reportedModel - the model id the scripted provider reports, overridable
   * to exercise a teacher-identity mismatch.
   */
  constructor(
    private readonly behaviours: readonly ((context: AttemptContext) => Promise<{ status: 'SUCCESS' | 'FAILED' | 'ERROR' | 'TIMEOUT'; errorClass?: 'agent' | 'infrastructure'; reason: string }>)[] = [],
    private readonly reportedModel = 'deepseek-flash',
  ) {}

  private behaviourFor(ordinal: number) {
    return this.behaviours[Math.min(ordinal, this.behaviours.length - 1)]
  }

  async run(context: AttemptContext) {
    this.prompts.push(context.prompt)
    const behaviour = this.behaviourFor(context.ordinal)
    if (behaviour === undefined) throw new Error('ScriptedTeacher needs at least one behaviour')
    const recorder = context.recorder
    await recorder.append('task_start', { phase: 'request-header', config: { provider: 'mock', model: this.reportedModel, reasoningEffort: 'high', maxTokens: 8192 } })
    await recorder.append('assistant_message', {
      step: 0,
      decision: {
        text: 'writing the file',
        reasoning: null,
        reasoning_available: false,
        tool_calls: [{ tool_call_id: 'call_1', tool: 'write', arguments: '{"path":"out.txt"}' }],
      },
    })
    await recorder.append('tool_call', {
      step: 0, tool_call_id: 'call_1', tool: 'write', arguments: '{"path":"out.txt"}',
    })
    await recorder.append('tool_result', {
      step: 0, tool_call_id: 'call_1', is_error: false, content: 'wrote out.txt', error: null, exit_code: 0,
    })
    return behaviour(context)
  }
}

/** A task over the `basic` template; `overrides` supplies the varying parts. */
function taskFor( overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    version: 1,
    task_id: 'T-E2E',
    prompt: 'create marker.txt',
    workspace: { template: 'basic' },
    evaluator: MARKER_EVALUATOR,
    ...overrides,
  }
}
describe('runTask end to end', () => {
  it('records a success, writes the dataset, and indexes it', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    await writeFile(join(templates, 'basic', 'README.md'), 'template\n', 'utf8')
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    // The evaluator runs in the evaluator directory; give it the marker there so
    // the judgment is deterministic without depending on the agent.
    const teacher = new ScriptedTeacher([
      async (context: AttemptContext) => { await writeMarker(context); return { status: 'SUCCESS' as const, reason: 'done' } },
    ])
    const task = taskFor({
      evaluator: MARKER_EVALUATOR,
    })
    const result = await runTask({
      task,
      defaults: { max_attempts: 5 },
      templatesRoot: templates,
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      expectedTeacherModel: 'deepseek-flash',
      agent: teacher,
    })
    expect(result.status).toBe('SUCCESS')
    expect(result.selectedAttemptId).toBe('attempt_001')
    expect(result.attempts).toHaveLength(1)
    expect(result.datasetDir).toBe('success/T-E2E')

    const attempt = result.attempts[0]
    expect(attempt?.teacher.model).toBe('deepseek-flash')
    expect(attempt?.teacher.reasoning_effort).toBe('high')
    expect(attempt?.trajectory).toHaveLength(1)
    const step = attempt?.trajectory[0]
    expect(step?.decision.assistant_message).toBe('writing the file')
    expect(step?.decision.reasoning_available).toBe(false)
    expect(step?.actions).toHaveLength(1)
    expect(step?.observations).toHaveLength(1)
    // The action and the observation are joined by the same tool call id.
    expect(step?.observations[0]?.tool_call_id).toBe(step?.actions[0]?.tool_call_id)

    const written = JSON.parse(await readFile(join(root, 'dataset', 'success', 'T-E2E', 'trajectory.json'), 'utf8')) as {
      status: string
      attempts: unknown[]
    }
    expect(written.status).toBe('SUCCESS')
    expect(written.attempts).toHaveLength(1)
    expect((await dataset.completed('T-E2E'))?.selected_attempt_id).toBe('attempt_001')
  })

  it('retries a failed attempt and stops at the first success', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const teacher = new ScriptedTeacher([
      async () => ({ status: 'FAILED', reason: 'boom' }),
      async () => ({ status: 'FAILED', reason: 'boom again' }),
      async (context: AttemptContext) => { await writeMarker(context); return { status: 'SUCCESS' as const, reason: 'done' } },
      async () => { throw new Error('a fourth attempt must not run') },
    ])
    const result = await runTask({
      task: taskFor({
        evaluator: MARKER_EVALUATOR,
      }),
      defaults: { max_attempts: 5 },
      templatesRoot: templates,
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      expectedTeacherModel: 'deepseek-flash',
      agent: teacher,
    })
    expect(result.attempts).toHaveLength(3)
    expect(result.selectedAttemptId).toBe('attempt_003')
    expect(result.status).toBe('SUCCESS')
  })

  it('marks the task ABANDONED after max_attempts failures and archives every attempt', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const teacher = new ScriptedTeacher(Array.from({ length: 5 }, () => async () => ({ status: 'FAILED' as const, reason: 'nope' })))
    const result = await runTask({
      task: taskFor({
        evaluator: { kind: 'test_command', command: [process.execPath, '-e', 'process.exit(1)'] },
      }),
      defaults: { max_attempts: 5 },
      templatesRoot: templates,
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      expectedTeacherModel: 'deepseek-flash',
      agent: teacher,
    })
    expect(result.status).toBe('ABANDONED')
    expect(result.attempts).toHaveLength(5)
    expect(result.selectedAttemptId).toBeNull()
    expect(result.abandonReason).toContain('5')
    expect(result.datasetDir).toBe('abandoned/T-E2E')
    expect((await dataset.completed('T-E2E'))?.status).toBe('ABANDONED')
    // Nothing was selected, so every attempt is archived, and the task's own
    // document stays the only one that is not.
    for (const attempt of result.attempts) {
      const archived = JSON.parse(await readFile(
        join(root, 'dataset', 'failed', 'T-E2E', attempt.attempt_id, 'trajectory.json'), 'utf8',
      )) as { attempt_id: string; status: string }
      expect(archived.attempt_id).toBe(attempt.attempt_id)
      expect(archived.status).toBe('FAILED')
    }
    await expect(readFile(join(root, 'dataset', 'failed', 'T-E2E', 'trajectory.json'), 'utf8')).rejects.toThrow()
    expect(JSON.parse(await readFile(join(root, 'dataset', 'abandoned', 'T-E2E', 'trajectory.json'), 'utf8')))
      .toMatchObject({ status: 'ABANDONED', attempt_summary: { total: 5, selected_attempt_id: null } })
  })

  it('archives the failed attempt of a task that succeeds on a later attempt', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const teacher = new ScriptedTeacher([
      async () => ({ status: 'FAILED', reason: 'no marker' }),
      async (context: AttemptContext) => { await writeMarker(context); return { status: 'SUCCESS' as const, reason: 'done' } },
    ])
    const result = await runTask({
      task: taskFor({
        evaluator: MARKER_EVALUATOR,
      }),
      defaults: { max_attempts: 5 },
      templatesRoot: templates,
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      expectedTeacherModel: 'deepseek-flash',
      agent: teacher,
    })
    expect(result.status).toBe('SUCCESS')
    expect(result.selectedAttemptId).toBe('attempt_002')
    expect(result.datasetDir).toBe('success/T-E2E')
    expect(JSON.parse(await readFile(join(root, 'dataset', 'success', 'T-E2E', 'trajectory.json'), 'utf8')))
      .toMatchObject({ status: 'SUCCESS', attempt_summary: { total: 2, selected_attempt_id: 'attempt_002' } })
    expect(JSON.parse(await readFile(
      join(root, 'dataset', 'failed', 'T-E2E', 'attempt_001', 'trajectory.json'), 'utf8',
    ))).toMatchObject({ attempt_id: 'attempt_001', status: 'FAILED' })
    // The selected attempt is the task document's own record, so it is not archived twice.
    await expect(readFile(join(root, 'dataset', 'failed', 'T-E2E', 'attempt_002', 'trajectory.json'), 'utf8'))
      .rejects.toThrow()
    // The task document lives in exactly one bucket.
    await expect(readFile(join(root, 'dataset', 'failed', 'T-E2E', 'trajectory.json'), 'utf8')).rejects.toThrow()
  })

  it('does not call a model-declared success a success when the evaluator fails', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    // The teacher reports success; the evaluator disagrees.
    const teacher = new ScriptedTeacher([async () => ({ status: 'SUCCESS', reason: 'I finished it' })])
    const result = await runTask({
      task: taskFor({
        evaluator: { kind: 'test_command', command: [process.execPath, '-e', 'process.exit(1)'] },
      }),
      defaults: { max_attempts: 1 },
      templatesRoot: templates,
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      expectedTeacherModel: 'deepseek-flash',
      agent: teacher,
    })
    expect(result.status).toBe('ABANDONED')
    expect(result.attempts[0]?.status).toBe('FAILED')
    expect(result.attempts[0]?.evaluation).toMatchObject({ status: 'FAILED' })
  })

  it('skips judgment and does not consume a slot for an infrastructure error by default', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const teacher = new ScriptedTeacher([
      async () => ({ status: 'ERROR', errorClass: 'infrastructure', reason: 'api 503' }),
      async (context: AttemptContext) => { await writeMarker(context); return { status: 'SUCCESS' as const, reason: 'recovered' } },
    ])
    const result = await runTask({
      task: taskFor({
        evaluator: MARKER_EVALUATOR,
      }),
      defaults: { max_attempts: 5, infra_error_consumes_attempt: false },
      templatesRoot: templates,
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      expectedTeacherModel: 'deepseek-flash',
      agent: teacher,
    })
    expect(result.status).toBe('SUCCESS')
    expect(result.selectedAttemptId).toBe('attempt_002')
  })

  it('consumes a slot for an infrastructure error when the default says so', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const teacher = new ScriptedTeacher([
      async () => ({ status: 'ERROR', errorClass: 'infrastructure', reason: 'api 503' }),
      async (context: AttemptContext) => { await writeMarker(context); return { status: 'SUCCESS' as const, reason: 'recovered' } },
    ])
    const result = await runTask({
      task: taskFor({
        evaluator: MARKER_EVALUATOR,
      }),
      defaults: { max_attempts: 1, infra_error_consumes_attempt: true },
      templatesRoot: templates,
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      expectedTeacherModel: 'deepseek-flash',
      agent: teacher,
    })
    // The single slot was consumed by the infrastructure error, so the task ends.
    expect(result.attempts).toHaveLength(1)
    expect(result.status).toBe('ERROR')
    expect(result.errorClass).toBe('infrastructure')
    expect(result.datasetDir).toBe('invalid/infrastructure-error/T-E2E')
  })

  it('flags an attempt whose evaluator asset was modified and keeps it out of success', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    const assets = join(root, 'evaluator', 'T-E2E')
    await mkdir(join(assets, 'test'), { recursive: true })
    await writeFile(join(assets, 'test', 'suite.mjs'), 'original\n', 'utf8')
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const teacher = new ScriptedTeacher([
      // The "agent" rewrites the hidden test it was never supposed to touch.
      async (context) => {
        await writeFile(join(context.evaluatorDir, 'test', 'suite.mjs'), 'tampered\n', 'utf8')
        return { status: 'SUCCESS', reason: 'done' }
      },
      async (context: AttemptContext) => { await writeMarker(context); return { status: 'SUCCESS' as const, reason: 'clean' } },
    ])
    const result = await runTask({
      task: taskFor({
        evaluator: {
          kind: 'hidden_test',
          assets: ['test/suite.mjs'],
          command: [process.execPath, '-e', 'process.exit(0)'],
        },
      }),
      defaults: { max_attempts: 5 },
      templatesRoot: templates,
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      expectedTeacherModel: 'deepseek-flash',
      agent: teacher,
    })
    expect(result.integrityFlags).toContain('test_tampering')
    // The first attempt passed but was flagged; the second is clean, so the task
    // still succeeds and the selected attempt is the clean one.
    expect(result.status).toBe('SUCCESS')
    expect(result.selectedAttemptId).toBe('attempt_002')
    expect(result.datasetDir).toBe('success/T-E2E')
  })

  it('carries failure feedback into the next prompt only when the task asks for it', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const teacher = new ScriptedTeacher([
      async () => ({ status: 'FAILED', reason: 'first attempt broke' }),
      async (context: AttemptContext) => { await writeMarker(context); return { status: 'SUCCESS' as const, reason: 'fixed' } },
    ])
    await runTask({
      task: taskFor({
        carry_failure_feedback: true,
        evaluator: MARKER_EVALUATOR,
      }),
      defaults: { max_attempts: 5 },
      templatesRoot: templates,
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      expectedTeacherModel: 'deepseek-flash',
      agent: teacher,
    })
    expect(teacher.prompts[0]).not.toContain('previous attempt failed')
    expect(teacher.prompts[1]).toContain('previous attempt failed')
  })

  it('keeps each attempt in its own directory', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    await writeFile(join(templates, 'basic', 'README.md'), 'template\n', 'utf8')
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const teacher = new ScriptedTeacher([
      async (context) => {
        // The attempt may edit its own workspace.
        await writeFile(join(context.workspace, 'scratch.txt'), 'mine\n', 'utf8')
        return { status: 'FAILED', reason: 'nope' }
      },
      async (context) => {
        // A fresh attempt must not see the previous attempt's file.
        const { existsSync } = await import('node:fs')
        expect(existsSync(join(context.workspace, 'scratch.txt'))).toBe(false)
        await writeMarker(context)
        return { status: 'SUCCESS', reason: 'clean' }
      },
    ])
    const result = await runTask({
      task: taskFor({
        evaluator: MARKER_EVALUATOR,
      }),
      defaults: { max_attempts: 5 },
      templatesRoot: templates,
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      expectedTeacherModel: 'deepseek-flash',
      agent: teacher,
    })
    expect(result.attempts).toHaveLength(2)
    // Both attempt directories survive, with their own event logs.
    const first = await readFile(join(root, 'runs', 'T-E2E', 'attempt_001', 'events.jsonl'), 'utf8')
    const second = await readFile(join(root, 'runs', 'T-E2E', 'attempt_002', 'events.jsonl'), 'utf8')
    expect(first).toContain('"attempt_id":"attempt_001"')
    expect(second).toContain('"attempt_id":"attempt_002"')
  })

  it('redacts a secret the teacher echoes', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    const dataset = new DatasetWriter({ root: join(root, 'dataset') })
    const secret = 'fixture-secret-value-0123456789'
    const teacher = new ScriptedTeacher([
      async (context) => {
        await context.recorder.append('tool_result', { stdout: `DEEPSEEK_API_KEY=${secret}` })
        await writeMarker(context)
        return { status: 'SUCCESS', reason: 'done' }
      },
    ])
    const result = await runTask({
      task: taskFor({
        evaluator: MARKER_EVALUATOR,
      }),
      defaults: { max_attempts: 1 },
      templatesRoot: templates,
      evaluatorRoot: join(root, 'evaluator'),
      runsRoot: join(root, 'runs'),
      dataset,
      secrets: [secret],
      expectedTeacherModel: 'deepseek-flash',
      agent: teacher,
    })
    expect(result.status).toBe('SUCCESS')
    const events = await readFile(join(root, 'runs', 'T-E2E', 'attempt_001', 'events.jsonl'), 'utf8')
    const document = await readFile(join(root, 'dataset', 'success', 'T-E2E', 'trajectory.json'), 'utf8')
    expect(events).not.toContain(secret)
    expect(document).not.toContain(secret)
    expect(events).toContain('[REDACTED:SECRET]')
  })
})
