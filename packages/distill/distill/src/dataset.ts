/**
 * Dataset writing.
 *
 * A finished task becomes one directory under the status its evaluator assigned,
 * written through a staging directory so a reader never observes a partial
 * dataset. An index line records where the task landed, which is what makes a
 * `task_id` traceable across the corpus without scanning every directory.
 *
 * @module @deepseek-ai/dsh-distill/dataset
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { IntegrityFlag, Status } from './types.ts'

/** Where one task's data belongs, per the status the evaluator assigned. */
export type DatasetBucket =
  | 'success'
  | 'failed'
  | 'abandoned'
  | 'invalid/unknown'
  | 'invalid/infrastructure-error'

/** One line of the dataset index. */
export interface DatasetIndexEntry {
  /** The task's identity. */
  readonly task_id: string
  /** The task's final status. */
  readonly status: Status
  /** How many attempts ran. */
  readonly attempts: number
  /** The attempt the success bucket selected, when the task succeeded. */
  readonly selected_attempt_id: string | null
  /** Integrity problems raised across the task's attempts. */
  readonly integrity_flags: readonly IntegrityFlag[]
  /** The model that produced the data. */
  readonly teacher: { readonly provider: string; readonly model: string }
  /** Whether the workspace was a git repository. */
  readonly file_capture: { readonly git: boolean; readonly coverage: string }
  /** When the task started. */
  readonly started_at: string
  /** When the task finished. */
  readonly finished_at: string
  /** Directory the task was written under, relative to the dataset root. */
  readonly dataset_dir: string
}

/**
 * Choose the bucket for one finished task.
 *
 * An unknown status means no usable evaluator ran, which is a different fact from
 * a task the infrastructure broke, so the two get separate directories.
 *
 * @param status - the task's final status.
 * @param errorClass - the class of the terminal error, when the status is `ERROR`.
 * @returns the bucket name.
 */
export function bucketFor(status: Status, errorClass?: 'agent' | 'infrastructure'): DatasetBucket {
  if (status === 'SUCCESS') return 'success'
  if (status === 'FAILED' || status === 'TIMEOUT') return 'failed'
  if (status === 'ABANDONED') return 'abandoned'
  if (status === 'UNKNOWN') return 'invalid/unknown'
  return errorClass === 'infrastructure' ? 'invalid/infrastructure-error' : 'failed'
}

/** The dataset writer's configuration. */
export interface DatasetWriterOptions {
  /** Directory holding the status buckets and `index.jsonl`. */
  readonly root: string
}

/** Write tasks, their trajectory documents, and the shared index. */
export class DatasetWriter {
  private readonly root: string

  /**
   * @param options - the dataset root directory.
   */
  constructor(options: DatasetWriterOptions) {
    this.root = options.root
  }

  /** The index path this writer maintains. */
  get indexPath(): string {
    return join(this.root, 'index.jsonl')
  }

  /**
   * Write one task's trajectory into its bucket, staged and committed atomically.
   *
   * The document is rendered to a staging directory beside the destination and
   * renamed into place, so a reader sees either no task or a complete one.
   *
   * @param taskId - the task's identity.
   * @param bucket - the bucket chosen by {@link bucketFor}.
   * @param document - the complete trajectory document.
   * @returns the directory the task was written under, relative to the root.
   */
  async write(taskId: string, bucket: DatasetBucket, document: unknown): Promise<string> {
    const relative = join(bucket, taskId)
    const destination = join(this.root, relative)
    // The document itself is replaced atomically, so a reader sees either the
    // previous document or the new one. Every other bucket's copy of this task is
    // then removed, which is what keeps a task in exactly one status directory
    // without depending on directory-rename semantics that differ per platform.
    await mkdir(dirname(destination), { recursive: true })
    await writeFileAtomic(join(destination, 'trajectory.json'), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 })
    for (const other of ['success', 'failed', 'abandoned', 'invalid/unknown', 'invalid/infrastructure-error']) {
      if (other === bucket) continue
      await rm(join(this.root, other, taskId), { recursive: true, force: true })
    }
    return relative.split('\\').join('/')
  }

  /**
   * Append one line to the shared index under an exclusive writer lock.
   * @param entry - the index entry to record.
   */
  async index(entry: DatasetIndexEntry): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await withFileLock(this.indexPath, async () => {
      const previous = existsSync(this.indexPath) ? await readFile(this.indexPath, 'utf8') : ''
      const next = `${previous}${JSON.stringify(entry)}\n`
      await writeFileAtomic(this.indexPath, next, { mode: 0o644 })
    })
  }

  /**
   * Read the index back.
   * @returns one entry per recorded task, in the order they were written.
   */
  async readIndex(): Promise<DatasetIndexEntry[]> {
    if (!existsSync(this.indexPath)) return []
    const text = await readFile(this.indexPath, 'utf8')
    return text
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as DatasetIndexEntry)
  }

  /**
   * Whether this task already reached a terminal state.
   * @param taskId - the task's identity.
   * @returns the recorded entry, or `undefined` when the task has not finished.
   */
  async completed(taskId: string): Promise<DatasetIndexEntry | undefined> {
    return (await this.readIndex()).find(entry => entry.task_id === taskId)
  }
}
