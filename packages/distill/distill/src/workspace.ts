/**
 * Attempt workspace preparation.
 *
 * Every attempt starts from the same template so attempts stay independent: the
 * template is copied fresh, the task's seed files are written, and nothing from an
 * earlier attempt is carried in.
 *
 * @module @deepseek-ai/dsh-distill/workspace
 */

import { cp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { WorkspaceSpec } from './types.ts'

/** Raised when a workspace cannot be prepared. */
export class WorkspaceError extends Error {
  /**
   * @param message - what could not be prepared.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

/**
 * Whether a POSIX-relative path matches one glob pattern.
 *
 * Supported forms, which are the ones task files use:
 * - `*` spans one path segment and `?` one character within a segment;
 * - `**` spans any number of segments, and `**\/` may match zero of them, so
 *   `**​/*.txt` also matches a file at the root;
 * - a pattern with no glob character and no extension names a **directory**, and
 *   matches that directory and everything beneath it. `node_modules` therefore
 *   excludes the whole tree, which is what a task means by it.
 *
 * @param path - the POSIX-relative path to test.
 * @param pattern - the glob pattern.
 * @returns whether the path matches.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const hasGlob = /[*?]/.test(pattern)
  const lastSegment = pattern.slice(pattern.lastIndexOf('/') + 1)
  // A directory pattern prunes its subtree; a file pattern matches itself.
  const directory = !hasGlob && !lastSegment.includes('.')
  // Literal escaping and every glob translation happen before any regex
  // metacharacter is introduced, so a `?` glob cannot corrupt a group added
  // later and a `.` in a directory name stays literal.
  const body = pattern
    .replace(/\?/g, '\u0003')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\/\*\*/g, '\u0002')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0003/g, '[^/]')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '(?:/.*)?')
    .replace(/\u0000/g, '.*')
  const suffix = directory ? '(?:/.*)?' : ''
  return new RegExp(`^${body}${suffix}$`).test(path)
}

/**
 * Whether a path is kept by the spec's include and exclude lists.
 * @param path - the POSIX-relative path to test.
 * @param spec - the workspace specification.
 * @returns whether the path is kept.
 */
export function isKept(path: string, spec: WorkspaceSpec): boolean {
  if (spec.include !== undefined && !spec.include.some(pattern => matchesGlob(path, pattern))) return false
  if (spec.exclude !== undefined && spec.exclude.some(pattern => matchesGlob(path, pattern))) return false
  return true
}

/**
 * Prepare one attempt's workspace from its template.
 *
 * The copy is deliberately whole rather than per-file: the filter is applied by
 * copying the template and then removing what the spec excludes, so a template
 * with directories the filter does not mention still lands intact.
 *
 * @param spec - the workspace specification.
 * @param templateRoot - the directory holding every template.
 * @param destination - the attempt's workspace directory.
 * @returns after the workspace, including seed files, is complete.
 * @throws WorkspaceError when the template is missing.
 */
export async function prepareWorkspace(
  spec: WorkspaceSpec,
  templateRoot: string,
  destination: string,
): Promise<void> {
  const source = join(templateRoot, spec.template)
  if (!existsSync(source)) {
    throw new WorkspaceError(`workspace template ${JSON.stringify(spec.template)} does not exist at ${source}`)
  }
  await mkdir(destination, { recursive: true })
  await cp(source, destination, {
    recursive: true,
    // A filter keeps traversal cheap for excluded trees; the explicit include list
    // is honoured on the relative path the copy reports.
    filter: (from) => {
      const rel = relative(source, from)
      if (rel.length === 0) return true
      return isKept(rel.split(sep).join('/'), spec)
    },
  })
  for (const file of spec.seed_files ?? []) {
    const target = join(destination, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, 'utf8')
  }
}
