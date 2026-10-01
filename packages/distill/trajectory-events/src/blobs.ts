/**
 * Content-addressed blob storage for values too large to inline in an event.
 *
 * Every blob is keyed by the SHA-256 of its exact bytes, so identical content is
 * stored once and a reference is verifiable after the fact. A reference always
 * carries the original byte length as well as the hash, which lets a reader tell a
 * genuinely small value from a truncated one without re-reading the file.
 *
 * @module @deepseek-ai/dsh-distill-trajectory-events/blobs
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A stored blob's identity and size. */
export interface BlobRef {
  /** SHA-256 of the stored bytes, lowercase hex. */
  readonly sha256: string
  /** Byte length of the stored content. */
  readonly bytes: number
  /** Path of the blob relative to the blob root, using forward slashes. */
  readonly path: string
}

/** The blob writer's configuration. */
export interface BlobStoreOptions {
  /** Directory that holds `blobs/<sha256>`. */
  readonly root: string
}

/** Write-once content-addressed storage under one directory. */
export class BlobStore {
  private readonly root: string

  /**
   * @param options - the directory that becomes the blob root.
   */
  constructor(options: BlobStoreOptions) {
    this.root = options.root
  }

  /**
   * Store content and return its reference.
   *
   * The write is content-addressed, so storing the same bytes twice leaves one
   * file. The first two hex characters become a subdirectory, which keeps a large
   * corpus from putting every blob in one directory.
   *
   * @param content - the exact bytes to store.
   * @returns the stored blob's hash, length, and relative path.
   */
  async put(content: Buffer): Promise<BlobRef> {
    const sha256 = createHash('sha256').update(content).digest('hex')
    const relative = `${sha256.slice(0, 2)}/${sha256}`
    const absolute = join(this.root, relative)
    await mkdir(join(this.root, sha256.slice(0, 2)), { recursive: true })
    // Rewriting identical content is harmless and keeps the writer free of a
    // read-before-write race; the path is a pure function of the bytes.
    await writeFile(absolute, content)
    return { sha256, bytes: content.byteLength, path: `blobs/${relative}` }
  }

  /**
   * Read a stored blob back.
   * @param sha256 - the hash returned by {@link put}.
   * @returns the stored bytes.
   */
  async get(sha256: string): Promise<Buffer> {
    return readFile(join(this.root, sha256.slice(0, 2), sha256))
  }
}
