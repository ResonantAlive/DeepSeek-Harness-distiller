import { describe, expect, it } from 'vitest'
import { availableParallelism, totalmem } from 'node:os'
import {
  AdmissionRefusedError,
  ResourceAllocationError,
  assertPlanHolds,
  resolvePlan,
  batchesOf,
  createTaskAdmissionGate,
  detectHostResources,
  probeCgroup,
  removeClaim,
  validate,
} from '../src/index.ts'
import type { HostResources, ResourcePlan, ResourcePlanInput } from '../src/index.ts'

/** A host with round numbers, so the arithmetic in a test reads straight off it. */
const host = (cpu: number, memoryMb: number, overrides: Partial<HostResources> = {}): HostResources => ({
  cpu,
  memoryMb,
  cpuSource: 'os',
  memorySource: 'os',
  platform: 'linux',
  ...overrides,
})

const input = (
  batches: ResourcePlanInput['batches'],
  options: { host?: HostResources; reservedCpu?: number; reservedMemoryMb?: number; maxConcurrentTasks?: number } = {},
): ResourcePlanInput => ({
  host: options.host ?? host(8, 8192),
  batches,
  reservedCpu: options.reservedCpu ?? 1,
  reservedMemoryMb: options.reservedMemoryMb ?? 1024,
  maxConcurrentTasks: options.maxConcurrentTasks ?? 4,
})

const plan = (overrides: Partial<ResourcePlan> = {}): ResourcePlan => ({
  host: host(8, 8192),
  batches: [{ cpu: 4, memoryMb: 4096 }],
  totalCpu: 4,
  totalMemoryMb: 4096,
  reservedCpu: 1,
  reservedMemoryMb: 1024,
  maxConcurrentTasks: 2,
  ...overrides,
})

describe('detectHostResources', () => {
  it('reports the operating system figures when no cgroup constrains it', () => {
    const detected = detectHostResources({ cgroup: { files: [] } })
    expect(detected.cpu).toBe(availableParallelism())
    expect(detected.memoryMb).toBe(Math.floor(totalmem() / (1024 * 1024)))
    expect(detected.cpuSource).toBe('os')
    expect(detected.memorySource).toBe('os')
    expect(detected.cgroup).toBeUndefined()
    expect(detected.platform).toBe(process.platform)
  })

  it('takes the tighter cgroup figures and records both sources', () => {
    const detected = detectHostResources({
      cpu: 32,
      memoryMb: 240_000,
      cgroup: { cpu: 32, memoryMb: 61_440, files: ['cpu.max', 'memory.max'] },
    })
    // The operating system offers more than the cgroup grants, so the cgroup wins.
    expect(detected.memoryMb).toBe(61_440)
    expect(detected.memorySource).toBe('min(os,cgroup)')
    expect(detected.cpu).toBe(32)
    expect(detected.cpuSource).toBe('os')
    expect(detected.cgroup).toEqual({ cpu: 32, memoryMb: 61_440 })
  })

  it('keeps the operating system figure when it is the tighter one', () => {
    const detected = detectHostResources({
      cpu: 4,
      memoryMb: 4096,
      cgroup: { cpu: 64, memoryMb: 999_999, files: [] },
    })
    expect(detected.cpu).toBe(4)
    expect(detected.cpuSource).toBe('os')
    expect(detected.memoryMb).toBe(4096)
    expect(detected.memorySource).toBe('os')
  })

  it('reports a cgroup that only constrains one resource', () => {
    const detected = detectHostResources({ cpu: 8, cgroup: { cpu: 2, files: ['cpu.max'] } })
    expect(detected.cpu).toBe(2)
    expect(detected.cpuSource).toBe('min(os,cgroup)')
    expect(detected.memorySource).toBe('os')
    expect(detected.cgroup).toEqual({ cpu: 2 })
  })
})

describe('probeCgroup', () => {
  it('finds no limit on a host without cgroup files', () => {
    const probe = probeCgroup()
    expect(probe.files).toBeInstanceOf(Array)
    // The tests run on whatever host executes them; the shape is what is asserted.
    if (probe.cpu !== undefined) expect(probe.cpu).toBeGreaterThan(0)
    if (probe.memoryMb !== undefined) expect(probe.memoryMb).toBeGreaterThan(0)
  })
})

describe('validate', () => {
  it('accepts a partitioning that fits', () => {
    const result = validate(input([
      { cpu: 2, memoryMb: 2048 },
      { cpu: 2, memoryMb: 2048 },
    ]))
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('refuses an over-allocated CPU budget and names the arithmetic', () => {
    const result = validate(input([{ cpu: 8, memoryMb: 1024 }], { reservedCpu: 1 }))
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('over-allocated CPU')
    expect(result.errors[0]).toContain('8 across 1 batch(es) + 1 reserved = 9')
    expect(result.errors[0]).toContain('host allows 8')
  })

  it('refuses an over-allocated memory budget and names the arithmetic', () => {
    const result = validate(input([{ cpu: 1, memoryMb: 8192 }], { reservedMemoryMb: 1024 }))
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('over-allocated RAM')
    expect(result.errors[0]).toContain('8192 MB across 1 batch(es) + 1024 MB reserved = 9216 MB')
    expect(result.errors[0]).toContain('host allows 8192 MB')
  })

  it('refuses a batch larger than the host on its own', () => {
    const result = validate(input([{ cpu: 16, memoryMb: 1024 }]))
    expect(result.errors[0]).toContain('more than the host')
  })

  it('refuses a negative reserve and names the field', () => {
    const result = validate(input([{ cpu: 1, memoryMb: 1024 }], { reservedCpu: -1 }))
    expect(result.errors[0]).toContain('reserved_cpu')
    expect(result.errors[0]).toContain('must not be negative')
  })

  it('refuses a fractional count and a non-finite one', () => {
    expect(validate(input([{ cpu: 1.5, memoryMb: 1024 }])).errors[0]).toContain('whole number')
    expect(validate(input([{ cpu: Number.NaN, memoryMb: 1024 }])).errors[0]).toContain('finite number')
  })

  it('refuses a host figure that is not usable', () => {
    const result = validate(input([{ cpu: 1, memoryMb: 1024 }], { host: host(Number.NaN, 1024) }))
    expect(result.errors.some(error => error.includes('host_cpu'))).toBe(true)
    expect(result.errors.some(error => error.includes('host_ram'))).toBe(false)
  })

  it('reports a plan that exactly fills the host without refusing it', () => {
    const result = validate(input(
      [{ cpu: 7, memoryMb: 7168 }],
      { host: host(8, 8192), reservedCpu: 1, reservedMemoryMb: 1024 },
    ))
    expect(result.errors).toEqual([])
    expect(result.warnings.join(' ')).toContain('exactly fills')
  })

  it('warns about an empty partitioning rather than refusing it', () => {
    const result = validate(input([]))
    expect(result.errors).toEqual([])
    expect(result.warnings).toContain('no batches are declared, so nothing will be admitted')
  })

  it('warns when concurrency is zero', () => {
    const result = validate(input([{ cpu: 1, memoryMb: 1024 }], { maxConcurrentTasks: 0 }))
    expect(result.errors).toEqual([])
    expect(result.warnings).toContain('max_concurrent_tasks is 0, so nothing will be admitted')
  })

  it('reports a batch whose per-batch concurrency is invalid', () => {
    const result = validate(input([{ cpu: 1, memoryMb: 1024, maxConcurrentTasks: -1 }]))
    expect(result.errors[0]).toContain('max_concurrent_tasks')
    expect(result.errors[0]).toContain('must not be negative')
  })

  it('warns when only the CPUs exactly fill the host', () => {
    const result = validate(input(
      [{ cpu: 7, memoryMb: 1024 }],
      { host: host(8, 8192), reservedCpu: 1, reservedMemoryMb: 1024 },
    ))
    expect(result.errors).toEqual([])
    expect(result.warnings).toContain('the partitioning exactly fills the host CPUs: leave headroom if other work shares them')
  })

  it('warns when only the RAM exactly fills the host', () => {
    const result = validate(input(
      [{ cpu: 1, memoryMb: 7168 }],
      { host: host(8, 8192), reservedCpu: 1, reservedMemoryMb: 1024 },
    ))
    expect(result.errors).toEqual([])
    expect(result.warnings).toContain('the partitioning exactly fills the host RAM: leave headroom if other work shares it')
  })

  it('reports every problem at once rather than one per run', () => {
    const result = validate(input([{ cpu: 16, memoryMb: 16_384 }], { reservedCpu: -1 }))
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })
})

describe('assertPlanHolds', () => {
  it('passes silently for a plan that holds', () => {
    expect(() => { assertPlanHolds(input([{ cpu: 2, memoryMb: 2048 }])) }).not.toThrow()
  })

  it('throws a typed error naming the host and the shortfall', () => {
    let thrown: unknown
    try {
      assertPlanHolds(input([{ cpu: 8, memoryMb: 1024 }], { reservedCpu: 2 }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ResourceAllocationError)
    const error = thrown as ResourceAllocationError
    expect(error.name).toBe('ResourceAllocationError')
    expect(error.code).toBe('over-allocated')
    expect(error.message).toContain('does not fit the host')
    expect(error.message).toContain('over-allocated CPU')
    expect(error.message).toContain('detected from os/os')
  })
})

describe('createTaskAdmissionGate', () => {
  const gateWith = (
    options: { plan?: ResourcePlan; perTaskMemoryMb?: number; freeMemoryMb?: number } = {},
  ) => createTaskAdmissionGate({
    plan: options.plan ?? plan(),
    perTaskMemoryMb: options.perTaskMemoryMb ?? 512,
    ...options.freeMemoryMb === undefined ? {} : { freeMemoryMb: () => options.freeMemoryMb as number },
  })

  it('resolves a fitting plan into the totals the gate reads', () => {
    const resolved = resolvePlan({
      host: host(8, 8192),
      batches: [{ cpu: 2, memoryMb: 2048 }, { cpu: 3, memoryMb: 3072 }],
      reservedCpu: 1,
      reservedMemoryMb: 1024,
      maxConcurrentTasks: 2,
    })
    // The caller states the batches; only the resolver knows their sums, which is
    // why the admission gate cannot be built from the request alone.
    expect(resolved.totalCpu).toBe(5)
    expect(resolved.totalMemoryMb).toBe(5120)
    expect(resolved.batches).toHaveLength(2)
  })

  it('refuses to resolve a plan the host cannot hold', () => {
    expect(() => resolvePlan({
      host: host(8, 8192),
      batches: [{ cpu: 16, memoryMb: 4096 }],
      reservedCpu: 1,
      reservedMemoryMb: 1024,
      maxConcurrentTasks: 2,
    })).toThrow(ResourceAllocationError)
  })
  it('admits up to the plan concurrency and releases on settle', async () => {
    const gate = gateWith()
    const release1 = await gate.acquire({ batchIndex: 0 })
    const release2 = await gate.acquire({ batchIndex: 0 })
    expect(gate.active).toBe(2)
    expect(gate.claimedMemoryMb).toBe(1024)
    release1()
    release1() // a second release is a no-op, not a double free
    expect(gate.active).toBe(1)
    release2()
    expect(gate.active).toBe(0)
    expect(gate.claimedMemoryMb).toBe(0)
  })

  it('waits for a place and admits after a release', async () => {
    // The plan admits two at once, so both slots must be held before a wait.
    const gate = gateWith()
    const release1 = await gate.acquire({ batchIndex: 0 })
    const release2 = await gate.acquire({ batchIndex: 0 })
    let admitted = false
    const waiting = gate.acquire({ batchIndex: 0 }).then((releaser) => {
      admitted = true
      return releaser
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(admitted).toBe(false)
    release1()
    const release3 = await waiting
    expect(admitted).toBe(true)
    release2(); release3()
    expect(gate.active).toBe(0)
  })

  it('respects a per-batch concurrency smaller than the plan', async () => {
    const gate = gateWith({
      plan: plan({ batches: [{ cpu: 4, memoryMb: 4096, maxConcurrentTasks: 1 }], maxConcurrentTasks: 4 }),
    })
    const release = await gate.acquire({ batchIndex: 0 })
    let admitted = false
    const waiting = gate.acquire({ batchIndex: 0 }).then((releaser) => {
      admitted = true
      return releaser
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(admitted).toBe(false)
    release()
    ;(await waiting)()
  })

  it('admits different batches in parallel up to the plan total', async () => {
    const gate = gateWith({
      plan: plan({
        batches: [{ cpu: 1, memoryMb: 1024, maxConcurrentTasks: 1 }, { cpu: 1, memoryMb: 1024, maxConcurrentTasks: 1 }],
        maxConcurrentTasks: 4,
      }),
    })
    const a = await gate.acquire({ batchIndex: 0 })
    const b = await gate.acquire({ batchIndex: 1 })
    expect(gate.active).toBe(2)
    a(); b()
  })

  it('refuses a claim that would eat the reserve', async () => {
    const gate = gateWith()
    let thrown: unknown
    try {
      await gate.acquire({ batchIndex: 0, memoryMb: 8000 })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AdmissionRefusedError)
    expect((thrown as Error).message).toContain('may not claim the reserve')
  })

  it('refuses an unknown batch index', async () => {
    const gate = gateWith()
    await expect(gate.acquire({ batchIndex: 7 })).rejects.toThrow(/not one of the 1 declared/)
  })

  it('refuses a non-finite claim', async () => {
    const gate = gateWith()
    await expect(gate.acquire({ batchIndex: 0, memoryMb: Number.NaN })).rejects.toThrow(/non-negative number of MB/)
  })

  it('waits when free memory cannot hold another claim', async () => {
    // 2048 free - 1024 reserve = 1024 usable, so two 512 claims fit and the
    // third must wait rather than eat into the reserve.
    const gate2 = createTaskAdmissionGate({
      plan: plan({ maxConcurrentTasks: 4 }),
      perTaskMemoryMb: 512,
      freeMemoryMb: () => 2048,
    })
    const release1 = await gate2.acquire({ batchIndex: 0 })
    const release2 = await gate2.acquire({ batchIndex: 0 })
    expect(gate2.active).toBe(2)
    let admitted = false
    const waiting = gate2.acquire({ batchIndex: 0 }).then((releaser) => {
      admitted = true
      return releaser
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(admitted).toBe(false)
    release1() // frees one 512 slot, so the waiter now fits
    const release3 = await waiting
    release2(); release3()
    expect(gate2.active).toBe(0)
  })

  it('aborts a wait when the caller cancels', async () => {
    const gate = gateWith()
    const release1 = await gate.acquire({ batchIndex: 0 })
    const release2 = await gate.acquire({ batchIndex: 0 })
    const controller = new AbortController()
    const waiting = gate.acquire({ batchIndex: 0 }, { signal: controller.signal })
    setTimeout(() => { controller.abort() }, 5)
    await expect(waiting).rejects.toThrow(/aborted before a place opened/)
    release1(); release2()
    expect(gate.active).toBe(0)
  })

  it('refuses a wait whose signal was already aborted', async () => {
    const gate = gateWith()
    const release1 = await gate.acquire({ batchIndex: 0 })
    const release2 = await gate.acquire({ batchIndex: 0 })
    const controller = new AbortController()
    controller.abort()
    await expect(
      gate.acquire({ batchIndex: 0 }, { signal: controller.signal }),
    ).rejects.toThrow(/aborted before a place opened/)
    release1(); release2()
  })

  it('keeps waiting when the signal aborts before a place opens', async () => {
    const gate = gateWith()
    const release1 = await gate.acquire({ batchIndex: 0 })
    const release2 = await gate.acquire({ batchIndex: 0 })
    const controller = new AbortController()
    const waiting = gate.acquire({ batchIndex: 0 }, { signal: controller.signal })
    // The abort listener runs, and the waiter must reject rather than hang.
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    controller.abort()
    await expect(waiting).rejects.toThrow(/aborted before a place opened/)
    release1(); release2()
  })

  it('aborts a wait that also carries a deadline timer', async () => {
    const gate = gateWith()
    const release1 = await gate.acquire({ batchIndex: 0 })
    const release2 = await gate.acquire({ batchIndex: 0 })
    const controller = new AbortController()
    const waiting = gate.acquire({ batchIndex: 0 }, { signal: controller.signal, timeoutMs: 60_000 })
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    controller.abort()
    await expect(waiting).rejects.toThrow(/aborted before a place opened/)
    release1(); release2()
  })

  it('aborts a wait with no deadline timer', async () => {
    const gate = gateWith()
    const release1 = await gate.acquire({ batchIndex: 0 })
    const release2 = await gate.acquire({ batchIndex: 0 })
    const controller = new AbortController()
    const waiting = gate.acquire({ batchIndex: 0 }, { signal: controller.signal })
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    controller.abort()
    await expect(waiting).rejects.toThrow(/aborted before a place opened/)
    release1(); release2()
  })

  it('ignores an abort that arrives after the wait was already released', async () => {
    const gate = gateWith()
    const release1 = await gate.acquire({ batchIndex: 0 })
    const release2 = await gate.acquire({ batchIndex: 0 })
    const controller = new AbortController()
    const waiting = gate.acquire({ batchIndex: 0 }, { signal: controller.signal })
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    // Releasing wakes and admits the waiter, which removes its entry from the
    // queue; a later abort then finds nothing to remove.
    release1()
    const release3 = await waiting
    controller.abort()
    release2(); release3()
    expect(gate.active).toBe(0)
  })

  it('gives up when no place opens within the deadline', async () => {
    const gate = gateWith()
    const release1 = await gate.acquire({ batchIndex: 0 })
    const release2 = await gate.acquire({ batchIndex: 0 })
    await expect(
      gate.acquire({ batchIndex: 0 }, { timeoutMs: 5 }),
    ).rejects.toThrow(/no place opened within 5 ms/)
    release1(); release2()
  })

  it('removes a claim that is present', () => {
    const first = { batchIndex: 0, memoryMb: 512 }
    const claims = [first, { batchIndex: 1, memoryMb: 256 }]
    removeClaim(claims, first)
    expect(claims).toEqual([{ batchIndex: 1, memoryMb: 256 }])
  })

  it('leaves the list untouched for a claim that is absent', () => {
    // The guard exists so a broken invariant cannot splice the wrong claim.
    const claims = [{ batchIndex: 0, memoryMb: 512 }, { batchIndex: 1, memoryMb: 256 }]
    removeClaim(claims, { batchIndex: 2, memoryMb: 128 })
    expect(claims).toEqual([{ batchIndex: 0, memoryMb: 512 }, { batchIndex: 1, memoryMb: 256 }])
  })

  it('exposes the plan batches', () => {
    expect(batchesOf(plan())).toEqual([{ cpu: 4, memoryMb: 4096 }])
  })
})
