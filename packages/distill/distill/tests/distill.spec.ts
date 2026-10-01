import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_COMMAND_TIMEOUT_MS, diffFingerprints, evaluate, evaluateTask, fingerprintDirectory, integrityFlags, runCommand, stageAssets } from '../src/evaluator.ts'
import { bucketFor, DatasetWriter } from '../src/dataset.ts'
import { matchesGlob, prepareWorkspace, WorkspaceError } from '../src/workspace.ts'
import { attemptIdFor, promptFor } from '../src/runner.ts'
import { TaskDefinitionError, loadTasks, parseTask } from '../src/tasks.ts'
import type { TaskDefinition } from '../src/types.ts'

const roots: string[] = []

async function scratch(prefix = 'dsh-distill-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A minimal valid task document. */
function taskDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    task_id: 'T-1',
    prompt: 'do the thing',
    workspace: { template: 'node-basic' },
    evaluator: { kind: 'test_command', command: ['node', '-e', 'process.exit(0)'] },
    ...overrides,
  }
}

describe('matchesGlob', () => {
  it('matches a single star within one segment', () => {
    expect(matchesGlob('a.txt', '*.txt')).toBe(true)
    expect(matchesGlob('dir/a.txt', '*.txt')).toBe(false)
  })

  it('matches a double star across segments', () => {
    expect(matchesGlob('dir/a.txt', '**/*.txt')).toBe(true)
    expect(matchesGlob('dir/nested/a.txt', '**/*.txt')).toBe(true)
    expect(matchesGlob('dir', 'dir/**')).toBe(true)
    expect(matchesGlob('dir/nested/a.txt', 'dir/**')).toBe(true)
  })

  it('treats a plain name without an extension as a directory to prune', () => {
    expect(matchesGlob('node_modules', 'node_modules')).toBe(true)
    expect(matchesGlob('node_modules/dep/index.js', 'node_modules')).toBe(true)
    expect(matchesGlob('src/node_modules/x.js', 'node_modules')).toBe(false)
  })

  it('matches a literal pattern exactly', () => {
    expect(matchesGlob('package.json', 'package.json')).toBe(true)
    expect(matchesGlob('xpackage.json', 'package.json')).toBe(false)
  })

  it('matches a question mark as one non-separator character', () => {
    expect(matchesGlob('ab', 'a?')).toBe(true)
    expect(matchesGlob('a/b', 'a?b')).toBe(false)
  })

  it('treats regex metacharacters literally', () => {
    expect(matchesGlob('a+b', 'a+b')).toBe(true)
    expect(matchesGlob('aab', 'a+b')).toBe(false)
  })
})

describe('prepareWorkspace', () => {
  it('copies a template and writes seed files', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic', 'tools'), { recursive: true })
    await writeFile(join(templates, 'basic', 'README.md'), 'template\n', 'utf8')
    await writeFile(join(templates, 'basic', 'tools', 'x.mjs'), 'export {}\n', 'utf8')
    const destination = join(root, 'ws')
    await prepareWorkspace({
      template: 'basic',
      seed_files: [{ path: 'data/in.csv', content: 'a\n1\n' }],
    }, templates, destination)
    expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe('template\n')
    expect(await readFile(join(destination, 'tools', 'x.mjs'), 'utf8')).toBe('export {}\n')
    expect(await readFile(join(destination, 'data', 'in.csv'), 'utf8')).toBe('a\n1\n')
  })

  it('honours exclude patterns', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic', 'node_modules'), { recursive: true })
    await writeFile(join(templates, 'basic', 'keep.txt'), 'keep\n', 'utf8')
    await writeFile(join(templates, 'basic', 'node_modules', 'dep.js'), 'dep\n', 'utf8')
    const destination = join(root, 'ws')
    await prepareWorkspace({ template: 'basic', exclude: ['node_modules/**'] }, templates, destination)
    expect(await readFile(join(destination, 'keep.txt'), 'utf8')).toBe('keep\n')
    await expect(readFile(join(destination, 'node_modules', 'dep.js'), 'utf8')).rejects.toThrow()
  })

  it('honours include patterns, dropping everything else', async () => {
    const root = await scratch()
    const templates = join(root, 'templates')
    await mkdir(join(templates, 'basic'), { recursive: true })
    await writeFile(join(templates, 'basic', 'a.txt'), 'a\n', 'utf8')
    await writeFile(join(templates, 'basic', 'b.md'), 'b\n', 'utf8')
    const destination = join(root, 'ws')
    await prepareWorkspace({ template: 'basic', include: ['**/*.txt'] }, templates, destination)
    expect(await readFile(join(destination, 'a.txt'), 'utf8')).toBe('a\n')
    await expect(readFile(join(destination, 'b.md'), 'utf8')).rejects.toThrow()
  })

  it('fails when the template is missing', async () => {
    const root = await scratch()
    await expect(prepareWorkspace({ template: 'absent' }, join(root, 'templates'), join(root, 'ws')))
      .rejects.toThrow(WorkspaceError)
  })
})

describe('runCommand', () => {
  it('collects stdout, stderr, and the exit code', async () => {
    const cwd = await scratch()
    const outcome = await runCommand([process.execPath, '-e', 'console.log("out"); console.error("err"); process.exit(3)'], {
      cwd, timeoutMs: 30_000,
    })
    expect(outcome.exitCode).toBe(3)
    expect(outcome.stdout.trim()).toBe('out')
    expect(outcome.stderr.trim()).toBe('err')
    expect(outcome.timedOut).toBe(false)
    expect(outcome.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('kills a command that reaches its deadline', async () => {
    const cwd = await scratch()
    const outcome = await runCommand([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], { cwd, timeoutMs: 200 })
    expect(outcome.timedOut).toBe(true)
  })

  it('reports a command that cannot start', async () => {
    const cwd = await scratch()
    const outcome = await runCommand(['definitely-not-a-real-executable-xyz'], { cwd, timeoutMs: 5_000 })
    expect(outcome.exitCode).toBeNull()
    expect(outcome.stderr.length).toBeGreaterThan(0)
  })

  it('merges an environment overlay', async () => {
    const cwd = await scratch()
    const outcome = await runCommand([process.execPath, '-e', 'console.log(process.env.DSH_PROBE ?? "absent")'], {
      cwd, timeoutMs: 30_000, env: { DSH_PROBE: 'overlaid' },
    })
    expect(outcome.stdout.trim()).toBe('overlaid')
  })

  it('documents its default deadline', () => {
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBe(120_000)
  })
})

describe('fingerprints and integrity', () => {
  it('reports added, changed, and removed paths', () => {
    const diff = diffFingerprints({ 'a.txt': '1', 'b.txt': '2' }, { 'a.txt': '9', 'c.txt': '3' })
    expect(diff).toEqual({ added: ['c.txt'], changed: ['a.txt'], removed: ['b.txt'] })
  })

  it('fingerprints a tree and detects a later change', async () => {
    const root = await scratch()
    await writeFile(join(root, 'a.txt'), 'one', 'utf8')
    const before = await fingerprintDirectory(root)
    await writeFile(join(root, 'a.txt'), 'two', 'utf8')
    const after = await fingerprintDirectory(root)
    expect(diffFingerprints(before, after).changed).toEqual(['a.txt'])
  })

  it('raises test_tampering when an evaluator asset changes', () => {
    const flags = integrityFlags({
      assetsBefore: { 't.js': 'a' }, assetsAfter: { 't.js': 'b' },
      scaffoldBefore: {}, scaffoldAfter: {},
    })
    expect(flags).toEqual(['test_tampering'])
  })

  it('raises scaffold_modified when a scaffold file changes or disappears', () => {
    expect(integrityFlags({
      assetsBefore: {}, assetsAfter: {},
      scaffoldBefore: { 'a': '1' }, scaffoldAfter: { 'a': '2' },
    })).toEqual(['scaffold_modified'])
    expect(integrityFlags({
      assetsBefore: {}, assetsAfter: {},
      scaffoldBefore: { 'a': '1' }, scaffoldAfter: {},
    })).toEqual(['scaffold_modified'])
  })

  it('raises test_shadowing when a new test-shaped path appears', () => {
    expect(integrityFlags({
      assetsBefore: {}, assetsAfter: {},
      scaffoldBefore: {}, scaffoldAfter: { 'test/hidden.test.js': 'x' },
    })).toEqual(['test_shadowing'])
    expect(integrityFlags({
      assetsBefore: {}, assetsAfter: {},
      scaffoldBefore: {}, scaffoldAfter: { 'src/thing.test.ts': 'x' },
    })).toEqual(['test_shadowing'])
  })

  it('does not flag a new ordinary output file as shadowing', () => {
    // Creating the deliverable is the task's goal, not tampering.
    expect(integrityFlags({
      assetsBefore: {}, assetsAfter: {},
      scaffoldBefore: {}, scaffoldAfter: { 'out.txt': 'x', 'config/pipeline.json': 'y' },
    })).toEqual([])
  })

  it('raises nothing for an untouched attempt', () => {
    expect(integrityFlags({
      assetsBefore: { a: '1' }, assetsAfter: { a: '1' },
      scaffoldBefore: { b: '2' }, scaffoldAfter: { b: '2' },
    })).toEqual([])
  })
})

describe('stageAssets', () => {
  it('copies declared assets into the evaluator directory', async () => {
    const root = await scratch()
    const assets = join(root, 'hidden')
    await mkdir(join(assets, 'test'), { recursive: true })
    await writeFile(join(assets, 'test', 'suite.mjs'), 'suite\n', 'utf8')
    const evaluatorDir = join(root, 'attempt', 'evaluator')
    await stageAssets(assets, evaluatorDir, ['test/suite.mjs'])
    expect(await readFile(join(evaluatorDir, 'test', 'suite.mjs'), 'utf8')).toBe('suite\n')
  })
})

describe('evaluate', () => {
  const layout = (workspace: string, evaluator: string) => ({ workspace, evaluator })

  it('passes when the command exits with the expected code', async () => {
    const root = await scratch()
    const result = await evaluate({ kind: 'test_command', command: [process.execPath, '-e', 'process.exit(0)'] }, layout(root, root))
    expect(result.status).toBe('SUCCESS')
    expect(result.entries[0]?.exit_code).toBe(0)
  })

  it('fails when the command exits otherwise', async () => {
    const root = await scratch()
    const result = await evaluate({ kind: 'test_command', command: [process.execPath, '-e', 'process.exit(1)'] }, layout(root, root))
    expect(result.status).toBe('FAILED')
    expect(result.reason).toContain('expected 0')
  })

  it('accepts a declared nonzero success code', async () => {
    const root = await scratch()
    const result = await evaluate({
      kind: 'test_command', command: [process.execPath, '-e', 'process.exit(7)'], expect_exit_code: 7,
    }, layout(root, root))
    expect(result.status).toBe('SUCCESS')
  })

  it('treats a deadline as an infrastructure timeout', async () => {
    const root = await scratch()
    const result = await evaluate({
      kind: 'test_command', command: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], timeout_ms: 200,
    }, layout(root, root))
    expect(result.status).toBe('TIMEOUT')
    expect(result.error_class).toBe('infrastructure')
  })

  it('fails when stdout does not contain the expected text', async () => {
    const root = await scratch()
    const result = await evaluate({
      kind: 'test_command',
      command: [process.execPath, '-e', 'console.log("actual")'],
      expect_stdout_contains: 'expected',
    }, layout(root, root))
    expect(result.status).toBe('FAILED')
    expect(result.reason).toContain('expected')
  })

  it('passes when stdout contains the expected text', async () => {
    const root = await scratch()
    const result = await evaluate({
      kind: 'test_command',
      command: [process.execPath, '-e', 'console.log("marker here")'],
      expect_stdout_contains: 'marker',
    }, layout(root, root))
    expect(result.status).toBe('SUCCESS')
  })

  it('runs the command in the evaluator directory, not the workspace', async () => {
    const root = await scratch()
    const workspace = join(root, 'workspace')
    const evaluator = join(root, 'evaluator')
    await mkdir(workspace, { recursive: true })
    await mkdir(evaluator, { recursive: true })
    await writeFile(join(evaluator, 'marker.txt'), 'here', 'utf8')
    const result = await evaluate({
      kind: 'test_command',
      command: [process.execPath, '-e', 'console.log(require("node:fs").existsSync("marker.txt"))'],
    }, layout(workspace, evaluator))
    expect(result.entries[0]?.stdout.trim()).toBe('true')
  })
})

describe('evaluateTask', () => {
  it('runs the extra checks after the evaluator passes', async () => {
    const root = await scratch()
    const workspace = join(root, 'ws')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'present.txt'), 'x', 'utf8')
    const result = await evaluateTask(
      { kind: 'test_command', command: [process.execPath, '-e', 'process.exit(0)'] },
      [
        { kind: 'file_exists', path: 'present.txt' },
        { kind: 'command_succeeds', command: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 30_000 },
      ],
      { workspace, evaluator: root },
    )
    expect(result.status).toBe('SUCCESS')
    expect(result.entries).toHaveLength(3)
  })

  it('fails on a missing file without running later checks', async () => {
    const root = await scratch()
    const workspace = join(root, 'ws')
    await mkdir(workspace, { recursive: true })
    const result = await evaluateTask(
      { kind: 'test_command', command: [process.execPath, '-e', 'process.exit(0)'] },
      [
        { kind: 'file_exists', path: 'absent.txt' },
        { kind: 'command_succeeds', command: [process.execPath, '-e', 'process.exit(0)'] },
      ],
      { workspace, evaluator: root },
    )
    expect(result.status).toBe('FAILED')
    expect(result.reason).toContain('file_exists:absent.txt')
    expect(result.entries).toHaveLength(2)
  })

  it('fails on a nonzero check command', async () => {
    const root = await scratch()
    const workspace = join(root, 'ws')
    await mkdir(workspace, { recursive: true })
    const result = await evaluateTask(
      { kind: 'test_command', command: [process.execPath, '-e', 'process.exit(0)'] },
      [{ kind: 'command_succeeds', command: [process.execPath, '-e', 'console.log("x"); process.exit(4)'], timeout_ms: 30_000 }],
      { workspace, evaluator: root },
    )
    expect(result.status).toBe('FAILED')
    expect(result.entries.at(-1)?.exit_code).toBe(4)
  })

  it('does not run checks when the evaluator failed', async () => {
    const root = await scratch()
    const result = await evaluateTask(
      { kind: 'test_command', command: [process.execPath, '-e', 'process.exit(1)'] },
      [{ kind: 'file_exists', path: 'anything' }],
      { workspace: root, evaluator: root },
    )
    expect(result.status).toBe('FAILED')
    expect(result.entries).toHaveLength(1)
  })

  it('reports an infrastructure error when a check cannot start', async () => {
    const root = await scratch()
    const workspace = join(root, 'ws')
    await mkdir(workspace, { recursive: true })
    const result = await evaluateTask(
      { kind: 'test_command', command: [process.execPath, '-e', 'process.exit(0)'] },
      [{ kind: 'command_succeeds', command: ['not-a-real-command-xyz'] }],
      { workspace, evaluator: root },
    )
    expect(result.status).toBe('ERROR')
    expect(result.error_class).toBe('infrastructure')
  })
})

describe('bucketFor', () => {
  it('maps each terminal status to its bucket', () => {
    expect(bucketFor('SUCCESS')).toBe('success')
    expect(bucketFor('FAILED')).toBe('failed')
    expect(bucketFor('TIMEOUT')).toBe('failed')
    expect(bucketFor('ABANDONED')).toBe('abandoned')
    expect(bucketFor('UNKNOWN')).toBe('invalid/unknown')
    expect(bucketFor('ERROR', 'infrastructure')).toBe('invalid/infrastructure-error')
    expect(bucketFor('ERROR', 'agent')).toBe('failed')
    expect(bucketFor('ERROR')).toBe('failed')
  })
})

describe('DatasetWriter', () => {
  it('writes a trajectory document and returns its relative directory', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root })
    const dir = await dataset.write('T-1', 'success', { task_id: 'T-1' })
    expect(dir).toBe('success/T-1')
    expect(JSON.parse(await readFile(join(root, 'success', 'T-1', 'trajectory.json'), 'utf8')))
      .toEqual({ task_id: 'T-1' })
  })

  it('replaces a previous document for the same task atomically', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root })
    await dataset.write('T-1', 'failed', { generation: 1 })
    await dataset.write('T-1', 'success', { generation: 2 })
    expect(JSON.parse(await readFile(join(root, 'success', 'T-1', 'trajectory.json'), 'utf8')))
      .toEqual({ generation: 2 })
    await expect(readFile(join(root, 'failed', 'T-1', 'trajectory.json'), 'utf8')).rejects.toThrow()
  })

  it('appends index lines and reads them back', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root })
    await dataset.index({
      task_id: 'T-1', status: 'SUCCESS', attempts: 1, selected_attempt_id: 'attempt_001',
      integrity_flags: [], teacher: { provider: 'p', model: 'm' },
      file_capture: { git: false, coverage: 'file-tools-only' },
      started_at: 'a', finished_at: 'b', dataset_dir: 'success/T-1',
    })
    await dataset.index({
      task_id: 'T-2', status: 'FAILED', attempts: 5, selected_attempt_id: null,
      integrity_flags: ['test_tampering'], teacher: { provider: 'p', model: 'm' },
      file_capture: { git: false, coverage: 'file-tools-only' },
      started_at: 'c', finished_at: 'd', dataset_dir: 'failed/T-2',
    })
    const entries = await dataset.readIndex()
    expect(entries.map(entry => entry.task_id)).toEqual(['T-1', 'T-2'])
    expect(dataset.indexPath.endsWith('index.jsonl')).toBe(true)
  })

  it('reports an empty index for a fresh dataset', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root })
    expect(await dataset.readIndex()).toEqual([])
    expect(await dataset.completed('T-1')).toBeUndefined()
  })

  it('finds a completed task in the index', async () => {
    const root = await scratch()
    const dataset = new DatasetWriter({ root })
    await dataset.index({
      task_id: 'T-9', status: 'SUCCESS', attempts: 1, selected_attempt_id: 'attempt_001',
      integrity_flags: [], teacher: { provider: 'p', model: 'm' },
      file_capture: { git: false, coverage: 'file-tools-only' },
      started_at: 'a', finished_at: 'b', dataset_dir: 'success/T-9',
    })
    expect((await dataset.completed('T-9'))?.status).toBe('SUCCESS')
  })
})

describe('parseTask and loadTasks', () => {
  it('accepts a minimal task and applies its defaults', () => {
    const task = parseTask('t.yml', taskDocument())
    expect(task.task_id).toBe('T-1')
    expect(task.evaluator.kind).toBe('test_command')
    expect(task.checks).toBeUndefined()
  })

  it('rejects a wrong version', () => {
    expect(() => parseTask('t.yml', taskDocument({ version: 2 }))).toThrow(/version/)
  })

  it('rejects a non-mapping document', () => {
    expect(() => parseTask('t.yml', ['nope'])).toThrow(/must be a mapping/)
  })

  it('rejects an unsafe task_id', () => {
    expect(() => parseTask('t.yml', taskDocument({ task_id: '../escape' }))).toThrow(/safe as a directory name/)
    expect(() => parseTask('t.yml', taskDocument({ task_id: '' }))).toThrow(/non-empty string/)
  })

  it('rejects a missing prompt', () => {
    expect(() => parseTask('t.yml', taskDocument({ prompt: '' }))).toThrow(/"prompt"/)
  })

  it('rejects an unknown evaluator kind', () => {
    expect(() => parseTask('t.yml', taskDocument({
      evaluator: { kind: 'vibes', command: ['x'] },
    }))).toThrow(/evaluator.kind/)
  })

  it('rejects an empty evaluator command', () => {
    expect(() => parseTask('t.yml', taskDocument({
      evaluator: { kind: 'test_command', command: [] },
    }))).toThrow(/evaluator.command/)
  })

  it('rejects a non-integer expected exit code', () => {
    expect(() => parseTask('t.yml', taskDocument({
      evaluator: { kind: 'test_command', command: ['x'], expect_exit_code: 1.5 },
    }))).toThrow(/expect_exit_code/)
  })

  it('rejects a malformed workspace and seed file', () => {
    expect(() => parseTask('t.yml', taskDocument({ workspace: 'nope' }))).toThrow(/workspace/)
    expect(() => parseTask('t.yml', taskDocument({
      workspace: { template: 't', seed_files: [{ path: 'a' }] },
    }))).toThrow(/content/)
  })

  it('rejects a malformed check', () => {
    expect(() => parseTask('t.yml', taskDocument({ checks: [{ kind: 'vibes' }] }))).toThrow(/checks\[0\].kind/)
    expect(() => parseTask('t.yml', taskDocument({ checks: [{ kind: 'file_exists' }] }))).toThrow(/path/)
    expect(() => parseTask('t.yml', taskDocument({ checks: [{ kind: 'command_succeeds', command: [] }] }))).toThrow(/command/)
  })

  it('rejects a half-declared tool set', () => {
    expect(() => parseTask('t.yml', taskDocument({ tools: { allow: ['read'] } }))).toThrow(/allow.*deny|both/)
  })

  it('rejects a non-string environment value', () => {
    expect(() => parseTask('t.yml', taskDocument({ env: { A: 1 } }))).toThrow(/env.A/)
  })

  it('rejects a non-boolean carry flag', () => {
    expect(() => parseTask('t.yml', taskDocument({ carry_failure_feedback: 'yes' }))).toThrow(/carry_failure_feedback/)
  })

  it('loads a manifest and every task it names', async () => {
    const root = await scratch()
    await writeFile(join(root, 'a.yml'), 'version: 1\ntask_id: T-A\nprompt: a\nworkspace: { template: t }\nevaluator: { kind: test_command, command: ["true"] }\n', 'utf8')
    await writeFile(join(root, 'b.yml'), 'version: 1\ntask_id: T-B\nprompt: b\nworkspace: { template: t }\nevaluator: { kind: hidden_test, command: ["true"], assets: [x] }\n', 'utf8')
    await writeFile(join(root, 'manifest.yml'), 'version: 1\ndefaults:\n  max_attempts: 3\ntasks:\n  - file: a.yml\n  - file: b.yml\n', 'utf8')
    const loaded = await loadTasks(join(root, 'manifest.yml'))
    expect(loaded.tasks.map(task => task.task_id)).toEqual(['T-A', 'T-B'])
    expect(loaded.defaults.max_attempts).toBe(3)
    expect(loaded.root).toBe(root)
  })

  it('rejects a duplicate task_id across the manifest', async () => {
    const root = await scratch()
    const body = 'version: 1\ntask_id: SAME\nprompt: p\nworkspace: { template: t }\nevaluator: { kind: test_command, command: ["true"] }\n'
    await writeFile(join(root, 'a.yml'), body, 'utf8')
    await writeFile(join(root, 'b.yml'), body, 'utf8')
    await writeFile(join(root, 'manifest.yml'), 'version: 1\ntasks:\n  - file: a.yml\n  - file: b.yml\n', 'utf8')
    await expect(loadTasks(join(root, 'manifest.yml'))).rejects.toThrow(/duplicate task_id/)
  })

  it('rejects a manifest with no tasks or a wrong version', async () => {
    const root = await scratch()
    await writeFile(join(root, 'empty.yml'), 'version: 1\ntasks: []\n', 'utf8')
    await expect(loadTasks(join(root, 'empty.yml'))).rejects.toThrow(/non-empty array/)
    await writeFile(join(root, 'v2.yml'), 'version: 2\ntasks:\n  - file: a.yml\n', 'utf8')
    await expect(loadTasks(join(root, 'v2.yml'))).rejects.toThrow(/version/)
  })

  it('reports an unreadable or invalid YAML file', async () => {
    const root = await scratch()
    await expect(loadTasks(join(root, 'absent.yml'))).rejects.toThrow(/cannot read/)
    await writeFile(join(root, 'bad.yml'), 'version: 1\ntasks: [ {\n', 'utf8')
    await expect(loadTasks(join(root, 'bad.yml'))).rejects.toThrow(/not valid YAML/)
  })

  it('carries the offending file in the error', () => {
    const error = (() => {
      try { parseTask('some/task.yml', { version: 1 }) } catch (thrown) { return thrown as TaskDefinitionError }
      throw new Error('expected a throw')
    })()
    expect(error.file).toBe('some/task.yml')
    expect(error.message).toContain('some/task.yml')
    expect(error.name).toBe('TaskDefinitionError')
  })
})

describe('runner helpers', () => {
  it('zero-pads attempt identities', () => {
    expect(attemptIdFor(0)).toBe('attempt_001')
    expect(attemptIdFor(9)).toBe('attempt_010')
    expect(attemptIdFor(99)).toBe('attempt_100')
  })

  it('composes the prompt with context and optional failure feedback', () => {
    const task = { prompt: 'P', initial_context: 'C' } as TaskDefinition
    expect(promptFor(task, { carryFailureFeedback: false })).toBe('P\n\nC')
    expect(promptFor(task, { carryFailureFeedback: true, lastFailure: 'boom' })).toBe('P\n\nC\n\nA previous attempt failed: boom')
  })

  it('omits failure feedback when only one attempt has run', () => {
    const task = { prompt: 'P' } as TaskDefinition
    expect(promptFor(task, { carryFailureFeedback: true, lastFailure: 'boom' })).toBe('P\n\nA previous attempt failed: boom')
    expect(promptFor(task, { carryFailureFeedback: false, lastFailure: 'boom' })).toBe('P')
  })
})
