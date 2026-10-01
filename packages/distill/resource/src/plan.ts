/**
 * Partitioning a host, and refusing a partition it cannot hold.
 *
 * The check runs before anything starts: a plan that over-allocates produces a
 * {@link ResourceAllocationError} naming what was requested and what the host
 * actually allows, rather than a run that dies mid-attempt when the kernel
 * reaches for memory that was never there.
 *
 * {@link TaskAdmissionGate} is the running half. It is a soft gate — it admits
 * fewer tasks than the plan allows and estimates their memory, it does not impose
 * a hard limit on another process. A host that needs a hard limit hands this
 * plan's numbers to a container or a cgroup instead, which is the honest division
 * of labour the design states.
 *
 * @module @deepseek-ai/dsh-distill-resource/plan
 */

import { freemem } from 'node:os'
import type { ResourcePlan, ResourcePlanInput, BatchSpec } from './types.ts'

/** Raised when a partitioning cannot hold. */
export class ResourceAllocationError extends Error {
  /** `over-allocated` or `invalid`. */
  readonly code: string

  /**
   * @param code - `over-allocated` for a plan that exceeds the host, `invalid`
   * for a number that cannot describe one.
   * @param message - the operator-facing explanation.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ResourceAllocationError'
    this.code = code
  }
}

/** A plan's verdict: rejected outright, or accepted with advisories. */
export interface ValidationResult {
  /** Every blocking problem, in the order it was found. */
  readonly errors: readonly string[]
  /** Non-blocking advisories: a plan that exactly fills the host, or an empty one. */
  readonly warnings: readonly string[]
}

/** The number a count or capacity is measured in. */
type Quantity = number

/**
 * Validate one quantity is a usable count.
 * @param value - the number to check.
 * @param field - its name, for the message.
 * @param errors - the list to append to.
 * @returns whether the value may be used.
 */
function isCount(value: Quantity, field: string, errors: string[]): boolean {
  if (!Number.isFinite(value)) {
    errors.push(`${field} must be a finite number, received ${String(value)}`)
    return false
  }
  if (value < 0) {
    errors.push(`${field} must not be negative, received ${String(value)}`)
    return false
  }
  if (!Number.isInteger(value)) {
    errors.push(`${field} must be a whole number, received ${String(value)}`)
    return false
  }
  return true
}

/**
 * Check a partitioning against the host it claims to fit.
 *
 * The two rules the design states are checked directly: every batch plus the
 * reserve must fit inside the host's CPUs, and the same for memory. An empty
 * batch list and a plan that exactly fills the host are both reported as
 * warnings rather than errors, because both are legal states a caller should
 * know about rather than be blocked by.
 *
 * @param input - the batches, the reserve, and the detected host.
 * @returns the errors and warnings; an empty `errors` list means the plan holds.
 */
export function validate(input: ResourcePlanInput): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Each `isCount` appends its own explanation, so the checks only need to run.
  isCount(input.reservedCpu, 'reserved_cpu', errors)
  isCount(input.reservedMemoryMb, 'reserved_ram', errors)
  isCount(input.maxConcurrentTasks, 'max_concurrent_tasks', errors)

  const assertHost = (value: number, field: string): void => {
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`${field} must be a non-negative number, received ${String(value)}`)
    }
  }
  assertHost(input.host.cpu, 'host_cpu')
  assertHost(input.host.memoryMb, 'host_ram')

  let totalCpu = 0
  let totalMemoryMb = 0
  input.batches.forEach((batch, index) => {
    const field = `batches[${String(index)}]`
    isCount(batch.cpu, `${field}.cpu`, errors)
    isCount(batch.memoryMb, `${field}.ram`, errors)
    if (batch.maxConcurrentTasks !== undefined) isCount(batch.maxConcurrentTasks, `${field}.max_concurrent_tasks`, errors)
    if (batch.cpu > input.host.cpu) {
      errors.push(`${field} asks for ${String(batch.cpu)} CPU, more than the host's ${String(input.host.cpu)}`)
    }
    if (batch.memoryMb > input.host.memoryMb) {
      errors.push(`${field} asks for ${String(batch.memoryMb)} MB, more than the host's ${String(input.host.memoryMb)} MB`)
    }
    totalCpu += batch.cpu
    totalMemoryMb += batch.memoryMb
  })

  if (errors.length > 0) return { errors, warnings }

  if (totalCpu + input.reservedCpu > input.host.cpu) {
    errors.push(
      `over-allocated CPU: ${String(totalCpu)} across ${String(input.batches.length)} batch(es)`
      + ` + ${String(input.reservedCpu)} reserved = ${String(totalCpu + input.reservedCpu)},`
      + ` but the host allows ${String(input.host.cpu)} (${input.host.cpuSource})`,
    )
  }
  if (totalMemoryMb + input.reservedMemoryMb > input.host.memoryMb) {
    errors.push(
      `over-allocated RAM: ${String(totalMemoryMb)} MB across ${String(input.batches.length)} batch(es)`
      + ` + ${String(input.reservedMemoryMb)} MB reserved = ${String(totalMemoryMb + input.reservedMemoryMb)} MB,`
      + ` but the host allows ${String(input.host.memoryMb)} MB (${input.host.memorySource})`,
    )
  }
  if (totalCpu + input.reservedCpu === input.host.cpu && totalMemoryMb + input.reservedMemoryMb === input.host.memoryMb) {
    warnings.push('the partitioning exactly fills the host: leave headroom if other work shares it')
  } else if (totalCpu + input.reservedCpu === input.host.cpu) {
    warnings.push('the partitioning exactly fills the host CPUs: leave headroom if other work shares them')
  } else if (totalMemoryMb + input.reservedMemoryMb === input.host.memoryMb) {
    warnings.push('the partitioning exactly fills the host RAM: leave headroom if other work shares it')
  }
  if (input.batches.length === 0) {
    warnings.push('no batches are declared, so nothing will be admitted')
  }
  if (input.maxConcurrentTasks === 0) {
    warnings.push('max_concurrent_tasks is 0, so nothing will be admitted')
  }
  return { errors, warnings }
}

/** Raised at startup when a partitioning does not hold. */
export function assertPlanHolds(input: ResourcePlanInput): void {
  const result = validate(input)
  if (result.errors.length === 0) return
  const detail = result.errors.map(error => `  - ${error}`).join('\n')
  throw new ResourceAllocationError(
    'over-allocated',
    `resource partitioning does not fit the host (${String(input.host.cpu)} CPU, `
    + `${String(input.host.memoryMb)} MB, detected from ${input.host.cpuSource}/${input.host.memorySource}):\n${detail}`,
  )
}

/** One running task's resource claim. */
interface Claim {
  /** The batch the task was admitted to. */
  readonly batchIndex: number
  /** Mebibytes the claim estimated at admission. */
  readonly memoryMb: number
}

/** Rejected because the plan or the caller's numbers cannot hold. */
export class AdmissionRefusedError extends Error {
  /**
   * @param message - what was requested and what remains.
   */
  constructor(message: string) {
    super(message)
    this.name = 'AdmissionRefusedError'
  }
}

/**
 * Remove a claim from the list, if it is still there.
 *
 * The guard matters: `splice(-1, 1)` would silently drop the *last* claim if the
 * claim were ever absent, which would release a task that never finished. Callers
 * hold the invariant that the claim is present, and this check keeps a broken
 * invariant from corrupting a different task's accounting.
 *
 * @param claims - the live claim list.
 * @param claim - the claim to remove.
 * @returns nothing; the list is edited in place.
 */
export function removeClaim(claims: Claim[], claim: Claim): void {
  const at = claims.indexOf(claim)
  if (at >= 0) claims.splice(at, 1)
}

/** A gate that admits at most the plan's tasks at once, and watches memory. */
export interface AdmissionGate {
  /**
   * Wait for a place, then release it when the task finishes.
   * @param request - the batch the task belongs to and its memory claim.
   * @param options - an optional abort signal and a deadline.
   * @returns a function that must be called exactly once when the task settles.
   * @throws AdmissionRefusedError when the plan cannot admit the claim.
   */
  acquire(
    request: { batchIndex: number; memoryMb?: number },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<() => void>
  /** Claims currently held. */
  readonly active: number
  /** Mebibytes currently claimed. */
  readonly claimedMemoryMb: number
}

/** Where a gate can admit memory from. */
type FreeMemory = () => number

/** The gate's configuration. */
export interface TaskAdmissionGateOptions {
  /** The plan whose concurrency and batches govern admission. */
  readonly plan: ResourcePlan
  /** Mebibytes each task costs when the caller states none. */
  readonly perTaskMemoryMb: number
  /** Free-memory reader; defaults to the operating system's. */
  readonly freeMemoryMb?: FreeMemory
}

/**
 * Admit tasks up to the plan's concurrency, and refuse a claim whose memory
 * would eat the reserve.
 *
 * Waiting happens outside the gate's own lock, so a waiting caller cannot block
 * a task finishing and releasing its claim. The memory check is an estimate over
 * free system memory: it keeps a plan from admitting tasks it can see would
 * exhaust the host, and it is not a hard limit on any process.
 *
 * @param options - the plan, the per-task cost, and where free memory comes from.
 * @returns the gate.
 */
export function createTaskAdmissionGate(options: TaskAdmissionGateOptions): AdmissionGate {
  const { plan } = options
  // Both paths report mebibytes: the option is already MB, the OS default is
  // bytes and is converted once here, so `freeMemoryMb()` is always MB.
  const freeMemoryMb = (): number =>
    options.freeMemoryMb === undefined
      ? Math.floor(freemem() / (1024 * 1024))
      : options.freeMemoryMb()
  const claims: Claim[] = []
  const waiters: (() => void)[] = []

  const batchConcurrency = (index: number): number =>
    plan.batches[index]?.maxConcurrentTasks ?? plan.maxConcurrentTasks

  const batchActive = (index: number): number =>
    claims.filter(claim => claim.batchIndex === index).length

  const release = (claim: Claim): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      removeClaim(claims, claim)
      // Wake one waiter; it re-checks its own condition, so a spurious wake is
      // harmless and a wake that loses the race simply queues again.
      waiters.shift()?.()
    }
  }

  return {
    get active() { return claims.length },
    get claimedMemoryMb() { return claims.reduce((sum, claim) => sum + claim.memoryMb, 0) },
    async acquire(request, acquireOptions = {}) {
      const { batchIndex, memoryMb } = request
      const claimCost = memoryMb ?? options.perTaskMemoryMb
      if (!Number.isFinite(claimCost) || claimCost < 0) {
        throw new AdmissionRefusedError(
          `task claim must be a non-negative number of MB, received ${String(memoryMb)}`,
        )
      }
      if (batchIndex < 0 || batchIndex >= plan.batches.length) {
        throw new AdmissionRefusedError(
          `batch ${String(batchIndex)} is not one of the ${String(plan.batches.length)} declared batch(es)`,
        )
      }
      if (claimCost + plan.reservedMemoryMb > plan.host.memoryMb) {
        throw new AdmissionRefusedError(
          `a claim of ${String(claimCost)} MB plus the ${String(plan.reservedMemoryMb)} MB reserve`
          + ` exceeds the host's ${String(plan.host.memoryMb)} MB; a task may not claim the reserve`,
        )
      }

      const signal = acquireOptions.signal
      const deadline = acquireOptions.timeoutMs === undefined ? undefined : Date.now() + acquireOptions.timeoutMs

      const fits = (): boolean => {
        if (claims.length >= plan.maxConcurrentTasks) return false
        if (batchActive(batchIndex) >= batchConcurrency(batchIndex)) return false
        const remaining = freeMemoryMb() - plan.reservedMemoryMb
        const projected = claims.reduce((sum, claim) => sum + claim.memoryMb, 0) + claimCost
        if (projected > remaining) return false
        return true
      }

      for (;;) {
        if (signal?.aborted === true) {
          throw new AdmissionRefusedError('admission wait was aborted before a place opened')
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new AdmissionRefusedError(`no place opened within ${String(acquireOptions.timeoutMs)} ms`)
        }
        if (fits()) {
          const claim: Claim = { batchIndex, memoryMb: claimCost }
          claims.push(claim)
          return release(claim)
        }
        await new Promise<void>((resolve, reject) => {
          const timer = deadline === undefined ? undefined : setTimeout(resolve, Math.max(0, deadline - Date.now()))
          const wake = (): void => {
            if (timer !== undefined) clearTimeout(timer)
            resolve()
          }
          waiters.push(wake)
          if (signal !== undefined) {
            signal.addEventListener('abort', () => {
              const at = waiters.indexOf(wake)
              if (at >= 0) waiters.splice(at, 1)
              if (timer !== undefined) clearTimeout(timer)
              reject(new AdmissionRefusedError('admission wait was aborted before a place opened'))
            }, { once: true })
          }
        })
      }
    },
  }
}

/** Every batch a plan declares, for a caller that needs the raw list. */
export function batchesOf(plan: ResourcePlan): readonly BatchSpec[] {
  return plan.batches
}
