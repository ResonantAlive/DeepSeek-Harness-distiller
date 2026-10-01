import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootDistillComposition, pinnedTeacher } from '../src/composition.ts'
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
  await mkdir(join(root, 'evaluator'), { recursive: true })
  await mkdir(join(root, 'tasks'), { recursive: true })
  await writeFile(join(root, 'tasks', 'T-REAL.yml'), [
    'version: 1',
    'task_id: T-REAL',
    'prompt: |',
    '  Create a file named hello.txt in the current directory whose entire',
    '  contents are exactly the single word: hello',
    '  Then you are done. Do not explain.',
    'workspace:',
    '  template: basic',
    'evaluator:',
    '  kind: test_command',
    '  command:',
    '    - node',
    '    - -e',
    // The evaluator decides from the workspace alone, so a judged success means
    // the model actually created the file rather than claimed it had.
    `    - ${JSON.stringify("process.exit(require('node:fs').readFileSync(require('node:path').join('..','workspace','hello.txt'),'utf8').trim()==='hello'?0:1)")}`,
    '',
  ].join('\n'), 'utf8')
  const manifest = join(root, 'tasks', 'manifest.yml')
  await writeFile(manifest, ['version: 1', 'tasks:', '  - file: T-REAL.yml', ''].join('\n'), 'utf8')
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
      { secrets: [] },
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
        teacher: { provider: string; model: string; served_model: string | null }
        trajectory: readonly unknown[]
        artifacts: { files_created: readonly string[] }
      }[]
    }
    expect(trajectory.attempt_summary.total).toBeGreaterThan(0)
    const attempt = trajectory.attempts[0]
    expect(attempt).toBeDefined()
    // The provider names the model that answered, which is the fact a dataset
    // consumer needs; the requested id is only what was asked for.
    expect(attempt?.teacher.served_model).not.toBeNull()
    expect(attempt?.trajectory.length).toBeGreaterThan(0)
    // The deliverable is attributed to the attempt that produced it.
    expect(attempt?.artifacts.files_created).toContain('hello.txt')
  }, 600_000)
})
