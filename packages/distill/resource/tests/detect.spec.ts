import { describe, expect, it } from 'vitest'
import { detectHostResources, probeCgroup } from '../src/index.ts'
import type { FileRead } from '../src/detect.ts'

/** A reader over a fixed map: any other path reads as missing. */
const reader = (files: Record<string, string>): FileRead =>
  path => files[path]

describe('probeCgroup with an injected reader', () => {
  it('finds a cgroup v2 CPU quota and a memory limit', () => {
    const probe = probeCgroup(reader({
      '/sys/fs/cgroup/cpu.max': '3200000 100000',
      '/sys/fs/cgroup/memory.max': '64424509440',
    }))
    expect(probe.cpu).toBeCloseTo(32)
    expect(probe.memoryMb).toBe(61_440)
    expect(probe.files).toEqual([
      '/sys/fs/cgroup/cpu.max',
      '/sys/fs/cgroup/memory.max',
    ])
  })

  it('reads an unlimited v2 CPU quota as no constraint', () => {
    const probe = probeCgroup(reader({ '/sys/fs/cgroup/cpu.max': 'max 100000' }))
    expect(probe.cpu).toBeUndefined()
    expect(probe.files).toEqual([])
  })

  it('reads a zero v2 quota as a blocked host', () => {
    const probe = probeCgroup(reader({ '/sys/fs/cgroup/cpu.max': '0 100000' }))
    expect(probe.cpu).toBe(0)
    expect(probe.files).toEqual(['/sys/fs/cgroup/cpu.max'])
  })

  it('falls back to the v1 CPU controller when v2 is absent', () => {
    const probe = probeCgroup(reader({
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '800000',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
    }))
    expect(probe.cpu).toBe(8)
    expect(probe.files).toEqual(['/sys/fs/cgroup/cpu/cpu.cfs_quota_us'])
  })

  it('ignores a v1 quota that is absent or a negative marker', () => {
    // A negative quota is how v1 spells "unlimited".
    expect(probeCgroup(reader({
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
    })).cpu).toBeUndefined()
    expect(probeCgroup(reader({})).cpu).toBeUndefined()
  })

  it('falls back from the v2 memory limit to the v1 one', () => {
    const probe = probeCgroup(reader({
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '8589934592',
    }))
    expect(probe.memoryMb).toBe(8192)
    expect(probe.files).toEqual(['/sys/fs/cgroup/memory/memory.limit_in_bytes'])
  })

  it('treats the v1 unlimited marker as no limit', () => {
    const probe = probeCgroup(reader({
      '/sys/fs/cgroup/memory.max': 'max',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
    }))
    expect(probe.memoryMb).toBeUndefined()
    expect(probe.files).toEqual([])
  })

  it('reports nothing when no file can be read', () => {
    const probe = probeCgroup(reader({}))
    expect(probe.cpu).toBeUndefined()
    expect(probe.memoryMb).toBeUndefined()
    expect(probe.files).toEqual([])
  })

  it('ignores a file whose contents are not a number', () => {
    expect(probeCgroup(reader({ '/sys/fs/cgroup/cpu.max': 'not a number' })).cpu).toBeUndefined()
    expect(probeCgroup(reader({ '/sys/fs/cgroup/cpu.max': '-5 100000' })).cpu).toBeUndefined()
    expect(probeCgroup(reader({ '/sys/fs/cgroup/memory.max': 'unlimited' })).memoryMb).toBeUndefined()
  })
})

describe('detectHostResources with an injected reader', () => {
  it('applies the read limits as a cgroup ceiling', () => {
    const detected = detectHostResources({
      cpu: 32,
      memoryMb: 240_000,
      read: reader({
        '/sys/fs/cgroup/cpu.max': '1600000 100000',
        '/sys/fs/cgroup/memory.max': '34359738368',
      }),
    })
    expect(detected.cpu).toBe(16)
    expect(detected.cpuSource).toBe('min(os,cgroup)')
    expect(detected.memoryMb).toBe(32_768)
    expect(detected.memorySource).toBe('min(os,cgroup)')
    expect(detected.cgroup).toEqual({ cpu: 16, memoryMb: 32_768 })
  })

  it('reports a cgroup that constrains only CPU', () => {
    const detected = detectHostResources({
      cpu: 32,
      memoryMb: 240_000,
      read: reader({ '/sys/fs/cgroup/cpu.max': '1600000 100000' }),
    })
    expect(detected.cgroup).toEqual({ cpu: 16 })
  })

  it('reports a cgroup that constrains only memory', () => {
    const detected = detectHostResources({
      cpu: 32,
      memoryMb: 240_000,
      read: reader({ '/sys/fs/cgroup/memory.max': '34359738368' }),
    })
    expect(detected.cgroup).toEqual({ memoryMb: 32_768 })
    expect(detected.memorySource).toBe('min(os,cgroup)')
    expect(detected.cpuSource).toBe('os')
  })

  it('reports the OS figures when the read limits are absent', () => {
    const detected = detectHostResources({ cpu: 8, memoryMb: 8192, read: reader({}) })
    expect(detected.cpu).toBe(8)
    expect(detected.memorySource).toBe('os')
    expect(detected.cgroup).toBeUndefined()
  })
})
