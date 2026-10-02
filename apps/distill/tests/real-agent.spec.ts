import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { availableToolsOf, bootDistillComposition, pinnedTeacher } from '../src/composition.ts'
import type { DistillComposition } from '../src/composition.ts'
import { createAgentRunner } from '../src/agent-runner.ts'
import { runAll } from '../src/bin.ts'

/**
 * These cases boot the real composition and reach the real provider, so they run
 * only when a key is present. Everything else about the application is covered
 * without a key by the distill package's suites.
 */
const apiKey: string | undefined = process.env['DEEPSEEK_API_KEY']
const describeReal = apiKey === undefined || apiKey.length === 0 ? describe.skip : describe

const roots: string[] = []
const booted: DistillComposition[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-distill-real-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(booted.splice(0).map(async (composition) => { await composition.shutdown() }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * Build the smallest corpus that still exercises the whole path: one task whose
 * evaluator decides from the workspace alone.
 * @returns the manifest path and the dataset directory.
 */
async function corpus(): Promise<{ manifest: string; out: string }> {
  const root = await scratch()
  const templates = join(root, 'templates', 'basic')
  await mkdir(templates, { recursive: true })
  await writeFile(join(templates, 'README.md'), 'A scratch workspace.\n', 'utf8')
  // The input exists only on disk, so the task cannot be solved without reading
  // it, and the answer must be written, so the trajectory must contain tools.
  await mkdir(join(templates, 'data'), { recursive: true })
  await writeFile(join(templates, 'data', 'input.txt'), 'listen\n', 'utf8')
  await mkdir(join(root, 'evaluator'), { recursive: true })
  await mkdir(join(root, 'tasks'), { recursive: true })
  await writeFile(join(root, 'tasks', 'T-REAL.yml'), [
    'version: 1',
    'task_id: T-REAL',
    'prompt: |',
    '  Run the shell command `cat data/input.txt` to read the input file.',
    '  Then write its output reversed into a file named hello.txt in the',
    '  current directory.',
    '  Use the shell for the reading step; that is part of the task.',
    '  The result must be exactly the reversed text with no trailing newline.',
    'workspace:',
    '  template: basic',
    'evaluator:',
    '  kind: test_command',
    '  command:',
    '    - node',
    '    - -e',
    // The evaluator decides from the workspace alone, so a judged success means
    // the model actually produced the file rather than claimed it had.
    `    - ${JSON.stringify("process.exit(require('node:fs').readFileSync(require('node:path').join('..','workspace','hello.txt'),'utf8').trim()==='netsil'?0:1)")}`,
    '',
  ].join('\n'), 'utf8')
  const manifest = join(root, 'tasks', 'manifest.yml')
  await writeFile(manifest, ['version: 1', 'tasks:', '  - file: T-REAL.yml', ''].join('\n'), 'utf8')
  return { manifest, out: join(root, 'dataset') }
}

/**
 * Two tasks that must not succeed, each for a different reason: one whose
 * evaluator can never pass, and one that spends its step budget before it can
 * finish. Both belong in the same failed bucket, and both must keep every
 * attempt they made rather than only the last.
 *
 * @returns the manifest and the dataset root they write to.
 */
async function failingCorpus(): Promise<{ manifest: string; out: string }> {
  const root = await scratch()
  const templates = join(root, 'templates', 'basic')
  await mkdir(templates, { recursive: true })
  await writeFile(join(templates, 'README.md'), 'A scratch workspace.\n', 'utf8')
  await mkdir(join(root, 'evaluator'), { recursive: true })
  await mkdir(join(root, 'tasks'), { recursive: true })
  await writeFile(join(root, 'tasks', 'T-FAIL.yml'), [
    'version: 1',
    'task_id: T-FAIL',
    'prompt: |',
    '  Say the single word: ready',
    '  Then you are done. Do not explain.',
    'workspace:',
    '  template: basic',
    'max_attempts: 2',
    'evaluator:',
    '  kind: test_command',
    '  command:',
    '    - node',
    '    - -e',
    // The check demands a file no prompt asked for, so the judgment can never
    // pass and the task must exhaust both attempts.
    `    - ${JSON.stringify("process.exit(require('node:fs').existsSync(require('node:path').join('..','workspace','never.txt'))?0:1)")}`,
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(root, 'tasks', 'T-BREACH.yml'), [
    'version: 1',
    'task_id: T-BREACH',
    'prompt: |',
    '  Say the single word: ready',
    '  Then you are done. Do not explain.',
    'workspace:',
    '  template: basic',
    // One token is less than any answer costs, so the budget ends the attempt
    // whatever the model chooses to do; a step limit would only bind a model
    // that happened to take more than that many steps.
    'max_tokens_per_attempt: 1',
    'evaluator:',
    '  kind: test_command',
    '  command:',
    '    - node',
    '    - -e',
    `    - ${JSON.stringify('process.exit(0)')}`,
    '',
  ].join('\n'), 'utf8')
  const manifest = join(root, 'tasks', 'manifest.yml')
  await writeFile(manifest, [
    'version: 1',
    'defaults:',
    '  max_attempts: 2',
    'tasks:',
    '  - file: T-FAIL.yml',
    '  - file: T-BREACH.yml',
    '',
  ].join('\n'), 'utf8')
  return { manifest, out: join(root, 'dataset') }
}

describeReal('a real attempt through the composed application', () => {
  it('boots the distill profile through the Loader and pins one teacher', async () => {
    const composition = await bootDistillComposition()
    booted.push(composition)
    // The teacher lock refuses the load unless every layer agreed, so a booted
    // composition proves the lock ran and accepted the pinned model.
    const teacher = pinnedTeacher(composition.ctx)
    expect(teacher.model).toBe('deepseek-flash')
    expect(teacher.provider.length).toBeGreaterThan(0)
    expect(composition.capture).toBeDefined()
  }, 180_000)

  it('runs one task to a judged success and records the serving model', async () => {
    const composition = await bootDistillComposition()
    booted.push(composition)
    const { manifest, out } = await corpus()
    const reports = await runAll(
      { manifest, out },
      createAgentRunner(composition.ctx, {
        ...pinnedTeacher(composition.ctx),
        capture: composition.capture,
        attemptTimeoutMs: 240_000,
      }),
      { secrets: [], environment: { available_tools: availableToolsOf(composition.ctx) } },
    )
    expect(reports).toHaveLength(1)
    expect(reports[0]?.status).toBe('SUCCESS')
    expect(reports[0]?.integrityFlags).toEqual([])

    // The attempt was judged from the workspace, and its trajectory was written.
    const trajectoryPath = join(out, 'success', 'T-REAL', 'trajectory.json')
    expect(existsSync(trajectoryPath)).toBe(true)
    const trajectory = JSON.parse(await readFile(trajectoryPath, 'utf8')) as {
      status: string
      attempt_summary: { total: number; selected_attempt_id: string | null }
      attempts: readonly {
        teacher: {
          provider: string
          model: string
          served_model: string | null
          temperature: number | null
          config_hash: string | null
        }
        last_error: unknown
        environment: { available_tools: readonly string[] | null }
        trajectory: readonly {
          decision: { assistant_message: string }
          actions: readonly { tool: string; arguments: string }[]
          observations: readonly {
            tool_call_id: string
            content: unknown
            duration_ms: number | null
            terminal?: {
              shell: string
              command: string | null
              exit_code: number | null
              timed_out: boolean
              stdout: string
              stderr: string
            }
          }[]
          file_changes: readonly { path: string }[]
        }[]
        artifacts: {
          files_created: readonly string[]
          diffs: readonly { path: string; change: string; diff: string }[]
        }
      }[]
    }
    expect(trajectory.attempt_summary.total).toBeGreaterThan(0)
    const attempt = trajectory.attempts[0]
    expect(attempt).toBeDefined()
    // The provider names the model that answered, which is the fact a dataset
    // consumer needs; the requested id is only what was asked for.
    expect(attempt?.teacher.served_model).not.toBeNull()
    expect(attempt?.trajectory.length).toBeGreaterThan(0)
    expect(attempt?.last_error).toBeNull()
    // The composition enumerated the tools it actually offered.
    expect(attempt?.environment.available_tools).not.toBeNull()
    expect(attempt?.environment.available_tools?.length).toBeGreaterThan(0)

    // The task cannot be solved without touching the workspace, so a judged
    // success has to have left real actions behind, each answered by a result
    // that carries how long its tool took.
    const actions = attempt?.trajectory.flatMap(step => step.actions) ?? []
    const observations = attempt?.trajectory.flatMap(step => step.observations) ?? []
    expect(actions.length).toBeGreaterThan(0)
    expect(observations.length).toBeGreaterThan(0)
    expect(actions.every(action => action.tool.length > 0)).toBe(true)
    // Every observation answers an action that was recorded, by the same id.
    const calledIds = new Set(actions.map(action => (action as unknown as { tool_call_id: string }).tool_call_id))
    expect(observations.every(observation => calledIds.has(observation.tool_call_id))).toBe(true)
    expect(observations.some(observation => observation.duration_ms !== null)).toBe(true)

    // The task asked for the reading step to run in the shell, so the attempt
    // has to carry the terminal facts the tool projected: an exit code and the
    // two streams apart, none of which the model-facing text gives a consumer.
    const terminals = observations.flatMap(observation => observation.terminal === undefined ? [] : [observation.terminal])
    expect(terminals.length, `tools used: ${actions.map(action => action.tool).join(', ')}`).toBeGreaterThan(0)
    // Whichever shell the host composes, the facts have to survive the same way.
    expect(terminals.every(entry => entry.shell === 'bash' || entry.shell === 'pwsh')).toBe(true)
    // A command that ran reports what it exited with; a merged text cannot.
    expect(terminals.every(entry => entry.exit_code !== null || entry.timed_out)).toBe(true)
    // The reading step is the one whose output held the input file.
    expect(terminals.some(entry => entry.stdout.includes('listen'))).toBe(true)

    // The deliverable is attributed to the attempt that produced it, and the
    // trajectory says what went into it rather than only that it appeared.
    expect(attempt?.artifacts.files_created).toContain('hello.txt')
    const deliverable = attempt?.artifacts.diffs.find(entry => entry.path === 'hello.txt')
    expect(deliverable?.change).toBe('created')
    expect(deliverable?.diff).toContain('+netsil')

    // Every setting the request ran under is digestible, so two attempts can be
    // told apart by configuration alone.
    expect(attempt?.teacher.config_hash).toMatch(/^[0-9a-f]{64}$/)
  }, 600_000)

  it('keeps a failed task and an over-budget task with every attempt they made', async () => {
    const composition = await bootDistillComposition()
    booted.push(composition)
    const { manifest, out } = await failingCorpus()
    const reports = await runAll(
      { manifest, out },
      createAgentRunner(composition.ctx, {
        ...pinnedTeacher(composition.ctx),
        capture: composition.capture,
        attemptTimeoutMs: 240_000,
      }),
      { secrets: [], environment: { available_tools: availableToolsOf(composition.ctx) } },
    )
    const byId = new Map(reports.map(report => [report.taskId, report]))
    // A judgment that can never pass and a budget that ends the attempt are two
    // different failures, and neither is a success. Both exhaust their attempts,
    // which is the abandoned outcome rather than the failed one: failed is
    // reserved for an attempt that passed while raising an integrity flag.
    expect(byId.get('T-FAIL')?.status).toBe('ABANDONED')
    expect(byId.get('T-BREACH')?.status).toBe('ABANDONED')
    expect(byId.get('T-FAIL')?.datasetDir).toBe('abandoned/T-FAIL')
    expect(byId.get('T-BREACH')?.datasetDir).toBe('abandoned/T-BREACH')
    // Neither may be mistaken for work that was never measured.
    expect(byId.get('T-FAIL')?.integrityFlags).toEqual([])
    expect(existsSync(join(out, 'success', 'T-FAIL'))).toBe(false)
    expect(existsSync(join(out, 'success', 'T-BREACH'))).toBe(false)

    // The failure did not cost the trajectory: each task kept its attempts, and
    // each attempt carries the model that answered it.
    for (const taskId of ['T-FAIL', 'T-BREACH']) {
      const document = JSON.parse(
        await readFile(join(out, 'abandoned', taskId, 'trajectory.json'), 'utf8'),
      ) as {
        attempt_summary: { total: number }
        attempts: readonly { teacher: { served_model: string | null }; trajectory: readonly unknown[] }[]
      }
      expect(document.attempt_summary.total).toBe(2)
      expect(document.attempts).toHaveLength(2)
      expect(document.attempts.every(attempt => attempt.teacher.served_model !== null)).toBe(true)
      // Every attempt is archived on its own under the failed bucket, whatever
      // bucket the task itself landed in, so a task that failed twice keeps both
      // records rather than only the last.
      for (const attempt of ['attempt_001', 'attempt_002']) {
        expect(existsSync(join(out, 'failed', taskId, attempt, 'trajectory.json'))).toBe(true)
      }
    }
  }, 900_000)
})
