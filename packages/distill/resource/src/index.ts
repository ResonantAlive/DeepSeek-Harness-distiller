/**
 * Host partitioning for distillation runs: detect what the host actually
 * allows, refuse a partition that over-allocates before anything starts, and
 * admit tasks under the plan's concurrency and memory estimate.
 *
 * @module @deepseek-ai/dsh-distill-resource
 */

export * from './types.ts'
export * from './detect.ts'
export * from './plan.ts'
