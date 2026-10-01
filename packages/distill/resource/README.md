---
description: "Host partitioning for distillation runs: detect the CPU and memory a container actually allows, refuse a partition that over-allocates before anything starts, and admit tasks under the plan's concurrency and memory estimate."
kind: "package-reference"
---

# @deepseek-ai/dsh-distill-resource

English | [中文](README.zh.md)

## Summary

Use `dsh-distill-resource` to decide how many tasks a distillation run may execute at once and how much of the host each may claim. It reads the CPU and memory the host actually allows — the cgroup limit when a container imposes one, the operating system's figure otherwise — validates a batch partitioning against that budget before the run starts, and admits tasks through a gate that keeps a claim from eating the reserve.

A plan that over-allocates is rejected with the arithmetic that failed, at startup, instead of dying mid-attempt when the kernel reaches for memory that was never there.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

```ts
import {
  assertPlanHolds,
  createTaskAdmissionGate,
  detectHostResources,
} from '@deepseek-ai/dsh-distill-resource'

// What the host actually allows. In a container this reads the cgroup limits,
// which are tighter than what `os.totalmem()` reports for the physical machine.
const host = detectHostResources()

assertPlanHolds({
  host,
  batches: [{ cpu: 16, memoryMb: 30_720 }, { cpu: 16, memoryMb: 30_720 }],
  reservedCpu: 1,
  reservedMemoryMb: 2048,
  maxConcurrentTasks: 8,
})

const gate = createTaskAdmissionGate({ plan, perTaskMemoryMb: 2048 })
const release = await gate.acquire({ batchIndex: 0 })
try {
  await runOneTask()
} finally {
  release()
}
```

`assertPlanHolds` throws a `ResourceAllocationError` naming the host and every shortfall; `validate` returns the same findings as data when a caller wants to report them rather than fail.

### Detected figures and their sources

`detectHostResources` records where each number came from, because a figure that cannot be attributed cannot be defended when a partition is questioned.

| Field | Meaning |
|---|---|
| `cpu` / `memoryMb` | What the run may use, after every constraint |
| `cpuSource` / `memorySource` | `os`, `cgroup`, or `min(os,cgroup)` |
| `cgroup` | The controller limit that was found, when one applies |
| `platform` | The platform the limits were read on |

### Reading a container's real budget

```ts
// cgroup v2
// /sys/fs/cgroup/cpu.max          "3200000 100000"  → 32 CPUs
// /sys/fs/cgroup/memory.max       "64424509440"     → 61 440 MB
// cgroup v1
// /sys/fs/cgroup/cpu/cpu.cfs_quota_us   "800000"
// /sys/fs/cgroup/cpu/cpu.cfs_period_us  "100000"    → 8 CPUs
```

A v1 quota of `-1` and a v2 quota of `max` both mean "no limit", and the v1 memory marker `9223372036854771712` is the same. All three are read as no constraint rather than as an enormous budget.

### The admission gate

`createTaskAdmissionGate` admits at most `maxConcurrentTasks` tasks, at most each batch's own `maxConcurrentTasks`, and never a claim whose memory would leave less than `reservedMemoryMb` free. `acquire` resolves to a release function that must be called exactly once; a second call is a no-op.

```ts
const release = await gate.acquire(
  { batchIndex: 0, memoryMb: 4096 },
  { signal: controller.signal, timeoutMs: 30_000 },
)
```

It rejects with `AdmissionRefusedError` when the batch index is not declared, when a claim would consume the reserve, when the caller's signal aborts, or when no place opens before the deadline.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Why both figures are read

A container is usually granted less than the machine reports. On a 251 GB host partitioned to 60 GiB, trusting `os.totalmem()` produces a plan that over-allocates by a factor of four and turns into an out-of-memory kill partway through a run. `detectHostResources` therefore takes the smaller of the operating system's figure and the cgroup controller's, and names which one won.

### Probing is injectable

`probeCgroup(read?)` and `detectHostResources({ read })` accept a file reader, so the probe logic is tested against synthetic cgroup contents rather than whatever host runs the suite. The default reads the real files; a probe that cannot read its file reports that it found nothing rather than failing.

### Why validation runs before anything starts

The two rules the design states are checked directly:

```
sum(batch.cpu)        + reservedCpu        <= host.cpu
sum(batch.memoryMb)   + reservedMemoryMb   <= host.memoryMb
```

A partitioning that exactly fills the host is accepted with a warning rather than refused, because it is legal — the warning exists so a caller sharing the host with anything else can reconsider. An empty batch list and a zero concurrency are likewise warnings, since a run that admits nothing is a configuration the caller should hear about.

### Why the gate is soft

The gate refuses to *admit* work it can see would exhaust the host. It does not impose a hard limit on any process: Node cannot cap another process's resident memory, and restricting CPU shares requires the operating system. A host that needs a hard limit hands the plan's numbers to a container or a cgroup, which is why this package reports what it detected rather than assuming enforcement it cannot provide.

Waiting happens outside the gate's own accounting, so a caller waiting for a place cannot block a finishing task from releasing one.

### Source map

| File | Role |
|---|---|
| [`src/detect.ts`](src/detect.ts) | cgroup v1/v2 probing, and the tighter-of-two choice |
| [`src/plan.ts`](src/plan.ts) | Validation, the typed refusal, and the admission gate |
| [`src/types.ts`](src/types.ts) | Types only; no runtime code |
| — | No runtime invariant companion is published. The package owns no mutable state that an independent observation could diverge from; the gate's claim list is private to the gate. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The attempt loop that consumes a plan lives in `@deepseek-ai/dsh-distill`; the command-line entry point is `apps/distill`.

-----

## Model Experience

None, as the package partitions host CPU and memory and registers no prompt, tool, or session event.

#### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.
## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The memory check is an estimate.** It compares a task's configured cost against free system memory. It does not measure a task's actual resident set, so a task that uses far more than its claim is not stopped by this package.
- **No hard enforcement.** CPU shares and memory ceilings are held by a container or cgroup, not by this package. Running without one means the plan is advisory.
- **Free memory is read from the operating system, not the cgroup.** `os.freemem()` reports the machine's free memory, which in a container is larger than the memory the cgroup still allows. On a constrained host, pass `freeMemoryMb` to supply the cgroup's own remaining budget.
- **Admission does not reserve CPU.** A batch's CPU figure is validated and reported but not enforced per task; concurrency is what bounds CPU use in practice.
- **A crash leaves claims held.** Another process's claims are not visible after a crash, so the gate is not a cross-process lock.

<a id="dev-note"></a>
### Dev Note

None.
