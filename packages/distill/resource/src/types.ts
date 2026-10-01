/**
 * The resource vocabulary a distillation run partitions a host with.
 *
 * Every quantity is stated in the same units the enforcement layer uses, so a
 * plan can be validated without translating anywhere: `cpu` is whole CPUs and
 * `memoryMb` is mebibytes. {@link HostResources} records where each number came
 * from, because a number that cannot be attributed cannot be trusted when a
 * partition is challenged.
 *
 * @module @deepseek-ai/dsh-distill-resource/types
 */

/** What a host actually has, after every constraint was applied. */
export interface HostResources {
  /** Whole CPUs the run may use, after cgroup and affinity limits. */
  readonly cpu: number
  /** Mebibytes the run may use, after cgroup limits. */
  readonly memoryMb: number
  /** Which CPU figure the smaller limit won for. */
  readonly cpuSource: ResourceSource
  /** Which memory figure the smaller limit won for. */
  readonly memorySource: ResourceSource
  /** The cgroup limit that was found, when the host is constrained. */
  readonly cgroup?: { readonly cpu?: number; readonly memoryMb?: number }
  /** Platform the limits were read on. */
  readonly platform: string
}

/** Where a host figure came from. */
export type ResourceSource =
  /** The operating system's own view. */
  | 'os'
  /** A cgroup controller limit, which is tighter than the operating system's. */
  | 'cgroup'
  /** The tighter of two sources when they disagree. */
  | 'min(os,cgroup)'

/** One partition of the host. */
export interface BatchSpec {
  /** Whole CPUs this batch owns. */
  readonly cpu: number
  /** Mebibytes this batch owns. */
  readonly memoryMb: number
  /** Tasks this batch may run at once; omission follows the plan's concurrency. */
  readonly maxConcurrentTasks?: number
}

/** The whole partitioning a run is configured with. */
export interface ResourcePlanInput {
  /** The detected host, or the numbers to validate a plan against. */
  readonly host: HostResources
  /** The batches, in assignment order. */
  readonly batches: readonly BatchSpec[]
  /** Whole CPUs held back for the operating system and the runner itself. */
  readonly reservedCpu: number
  /** Mebibytes held back for the operating system and the runner itself. */
  readonly reservedMemoryMb: number
  /** Tasks this plan may run at once, across every batch. */
  readonly maxConcurrentTasks: number
}

/** A validated partitioning. */
export interface ResourcePlan {
  /** The host the plan was validated against. */
  readonly host: HostResources
  /** The batches, in assignment order. */
  readonly batches: readonly BatchSpec[]
  /** Sum of every batch's CPUs. */
  readonly totalCpu: number
  /** Sum of every batch's memory. */
  readonly totalMemoryMb: number
  /** Whole CPUs held back. */
  readonly reservedCpu: number
  /** Mebibytes held back. */
  readonly reservedMemoryMb: number
  /** Tasks this plan may run at once, across every batch. */
  readonly maxConcurrentTasks: number
}
