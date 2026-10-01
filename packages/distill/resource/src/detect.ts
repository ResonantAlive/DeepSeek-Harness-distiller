/**
 * What the host actually allows.
 *
 * A container usually grants less than the machine reports, and the difference
 * is the difference between a plan that boots and a plan the kernel kills
 * mid-run. The operating system's view and the cgroup controller are therefore
 * both read, and the tighter one wins.
 *
 * Every probe degrades to what Node reports when a file cannot be read, so an
 * unconstrained host is reported as unconstrained rather than as an error.
 *
 * @module @deepseek-ai/dsh-distill-resource/detect
 */

import { availableParallelism, platform, totalmem } from 'node:os'
import { readFileSync } from 'node:fs'
import type { HostResources, ResourceSource } from './types.ts'

/** One cgroup figure, and the raw text it was parsed from. */
export interface CgroupProbe {
  /** Whole CPUs the cgroup allows, when the controller names a quota. */
  readonly cpu?: number
  /** Mebibytes the cgroup allows, when the controller names a limit. */
  readonly memoryMb?: number
  /** Which file each figure came from, for a failure explanation. */
  readonly files: readonly string[]
}

/** A memory limit that is not a limit at all, per the cgroup convention. */
const UNLIMITED = 9_223_372_036_854_771_712

/** Read a file, or `undefined` when it is missing or unreadable. */
const realRead: FileRead = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // A probe that cannot read its file is a probe that found nothing.
    return undefined
  }
}

/**
 * Parse a whole, non-negative number.
 * @param text - the file contents.
 * @returns the parsed value, or `undefined` when it is not one.
 */
function parseNumber(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const value = Number(text.trim())
  if (!Number.isFinite(value) || value < 0) return undefined
  return value
}

/** A file reader: the raw contents of `path`, or `undefined` when unreadable. */
export type FileRead = (path: string) => string | undefined

/**
 * Read the cgroup CPU quota.
 * @param read - where file contents come from.
 * @returns the CPU allowance, and the file it came from.
 */
function probeCpu(read: FileRead): { cpu?: number; file?: string } {
  const v2 = parseNumber(read('/sys/fs/cgroup/cpu.max')?.split(/\s+/)[0])
  if (v2 !== undefined && Number.isFinite(v2)) {
    if (v2 === 0) return { cpu: 0, file: '/sys/fs/cgroup/cpu.max' }
    const period = parseNumber(read('/sys/fs/cgroup/cpu.max')?.split(/\s+/)[1])
    if (period !== undefined && period > 0) return { cpu: v2 / period, file: '/sys/fs/cgroup/cpu.max' }
  }
  const quota = parseNumber(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'))
  const period = parseNumber(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'))
  if (quota !== undefined && period !== undefined && quota > 0 && period > 0) {
    return { cpu: quota / period, file: '/sys/fs/cgroup/cpu/cpu.cfs_quota_us' }
  }
  // A quota that reads as "unlimited" or is absent means no CPU constraint.
  return {}
}

/**
 * Read the cgroup memory limit.
 * @param read - where file contents come from.
 * @returns the memory allowance, and the file it came from.
 */
function probeMemory(read: FileRead): { memoryMb?: number; file?: string } {
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    const raw = read(path)
    const value = parseNumber(raw)
    if (value === undefined || value >= UNLIMITED) continue
    return { memoryMb: value / (1024 * 1024), file: path }
  }
  return {}
}

/**
 * Read the cgroup limits, if the host is governed by any.
 * @param read - where file contents come from; the default reads the real files.
 * @returns the limits and the files they came from; both figures may be absent.
 */
export function probeCgroup(read: FileRead = realRead): CgroupProbe {
  const cpu = probeCpu(read)
  const memory = probeMemory(read)
  const files: string[] = []
  if (cpu.cpu !== undefined && cpu.file !== undefined) files.push(cpu.file)
  if (memory.memoryMb !== undefined && memory.file !== undefined) files.push(memory.file)
  return {
    ...cpu.cpu === undefined ? {} : { cpu: cpu.cpu },
    ...memory.memoryMb === undefined ? {} : { memoryMb: memory.memoryMb },
    files,
  }
}

/**
 * Detect what this host actually allows.
 *
 * Node's own figures are the floor and the cgroup figures are the ceiling; the
 * smaller of the two is what a run may use. On a host with no cgroup limits the
 * operating system wins, and the record says so.
 *
 * @param options - overrides for the operating-system figures, for tests.
 * @returns the usable CPU and memory, with the source of each figure.
 */
export function detectHostResources(
  options: { cpu?: number; memoryMb?: number; cgroup?: CgroupProbe; read?: FileRead } = {},
): HostResources {
  const osCpu = options.cpu ?? availableParallelism()
  const osMemoryMb = options.memoryMb ?? Math.floor(totalmem() / (1024 * 1024))
  const cgroup = options.cgroup ?? probeCgroup(options.read)

  let cpu = osCpu
  let cpuSource: ResourceSource = 'os'
  if (cgroup.cpu !== undefined && cgroup.cpu < cpu) {
    cpu = cgroup.cpu
    cpuSource = 'min(os,cgroup)'
  }

  let memoryMb = osMemoryMb
  let memorySource: ResourceSource = 'os'
  if (cgroup.memoryMb !== undefined && cgroup.memoryMb < memoryMb) {
    memoryMb = cgroup.memoryMb
    memorySource = 'min(os,cgroup)'
  }

  let cgroupEntry: { cpu?: number; memoryMb?: number } | undefined
  if (cgroup.cpu !== undefined || cgroup.memoryMb !== undefined) {
    cgroupEntry = {}
    if (cgroup.cpu !== undefined) cgroupEntry.cpu = cgroup.cpu
    if (cgroup.memoryMb !== undefined) cgroupEntry.memoryMb = cgroup.memoryMb
  }

  return {
    cpu,
    memoryMb,
    cpuSource,
    memorySource,
    platform: platform(),
    ...cgroupEntry === undefined ? {} : { cgroup: cgroupEntry },
  }
}
