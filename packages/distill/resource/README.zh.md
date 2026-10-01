---
description: "蒸馏运行的宿主资源划分：探测容器实际允许的 CPU 与内存，在任何东西启动之前拒绝超额分配的划分，并按计划的并发与内存估算接纳任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-distill-resource

[English](README.md) | 中文

## 概述

使用 `dsh-distill-resource` 决定一次蒸馏运行可同时执行多少任务，以及每个任务可占用宿主的多少资源。它读取宿主实际允许的 CPU 与内存——容器施加限制时取 cgroup 限额，否则取操作系统的数字——在运行开始前依据该预算校验批次划分，并通过一个不让占用吃掉预留量的闸门接纳任务。

超额分配的计划会在启动时连同失败的那笔算术一起被拒绝，而不是在 attempt 进行到一半、内核去申请从未存在过的内存时才崩溃。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

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

`assertPlanHolds` 抛出 `ResourceAllocationError`，其中写明宿主与每一项缺口；当调用方想要报告而不是失败时，`validate` 会以数据形式返回同样的结论。

### 探测到的数字及其来源

`detectHostResources` 记录每个数字来自哪里，因为当一个划分受到质疑时，无法归因的数字也无法辩护。

| 字段 | 含义 |
|---|---|
| `cpu` / `memoryMb` | 在满足所有约束之后，本次运行可使用的量 |
| `cpuSource` / `memorySource` | `os`、`cgroup` 或 `min(os,cgroup)` |
| `cgroup` | 所找到的控制器限额，若适用的话 |
| `platform` | 读取这些限额所在的平台 |

### 读取容器真实的预算

```ts
// cgroup v2
// /sys/fs/cgroup/cpu.max          "3200000 100000"  → 32 CPUs
// /sys/fs/cgroup/memory.max       "64424509440"     → 61 440 MB
// cgroup v1
// /sys/fs/cgroup/cpu/cpu.cfs_quota_us   "800000"
// /sys/fs/cgroup/cpu/cpu.cfs_period_us  "100000"    → 8 CPUs
```

v1 配额 `-1` 与 v2 配额 `max` 都表示「无限制」，v1 内存标记 `9223372036854771712` 同理。三者都被读作无约束，而不是读作天文数字般的预算。

### 接纳闸门

`createTaskAdmissionGate` 最多接纳 `maxConcurrentTasks` 个任务，每个批次自身最多 `maxConcurrentTasks` 个，并且绝不接纳会让空闲内存低于 `reservedMemoryMb` 的占用。`acquire` 解析出一个必须恰好调用一次的释放函数；第二次调用为空操作。

```ts
const release = await gate.acquire(
  { batchIndex: 0, memoryMb: 4096 },
  { signal: controller.signal, timeoutMs: 30_000 },
)
```

当批次索引未被声明、当某项占用会吃掉预留量、当调用方的信号被中止，或在期限之前没有空位出现时，它会以 `AdmissionRefusedError` 拒绝。

## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 为何两个数字都要读取

容器通常被授予少于机器所报告的资源。在一台被划分为 60 GiB 的 251 GB 宿主机上，信任 `os.totalmem()` 会产生一个超额分配四倍的计划，并在运行中途变成一次内存不足终止。因此 `detectHostResources` 取操作系统数字与 cgroup 控制器数字中的较小者，并写明哪个胜出。

### 探测是可注入的

`probeCgroup(read?)` 与 `detectHostResources({ read })` 接受一个文件读取器，因此探测逻辑是针对合成的 cgroup 内容测试的，而不是针对恰好在运行测试套件的宿主机。默认实现读取真实文件；无法读取其文件的探测会报告它什么都没找到，而不是失败。

### 为何校验在任何东西启动之前运行

设计所陈述的两条规则被直接检查：

```
sum(batch.cpu)        + reservedCpu        <= host.cpu
sum(batch.memoryMb)   + reservedMemoryMb   <= host.memoryMb
```

恰好填满宿主的划分会被接受并给出警告，而不是被拒绝，因为它是合法的——该警告的存在是为了让与其他东西共享宿主的调用方能够重新考虑。空批次列表与零并发同样是警告，因为一次什么都不接纳的运行是调用方应当听说的配置。

### 为何闸门是软性的

闸门拒绝*接纳*它能看出会耗尽宿主的任务。它不对任何进程施加硬限制：Node 无法限制另一个进程的常驻内存，而限制 CPU 份额需要操作系统。需要硬限制的宿主会把计划中的数字交给容器或 cgroup，这正是本包报告自己探测到的内容、而不假设自己无法提供的强制执行的原因。

等待发生在闸门自身记账之外，因此等待空位的调用方无法阻止一个正在收尾的任务释放空位。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/detect.ts`](src/detect.ts) | cgroup v1/v2 探测，以及取两者中较紧者的选择 |
| [`src/plan.ts`](src/plan.ts) | 校验、带类型的拒绝与接纳闸门 |
| [`src/types.ts`](src/types.ts) | 仅类型；无运行时代码 |
| — | 不发布运行时不变式伴生入口。本包不拥有任何可被独立观察发现分歧的可变状态；闸门的占用列表是闸门私有的。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

消费计划的 attempt 循环位于 `@deepseek-ai/dsh-distill`；命令行入口是 `apps/distill`。

-----

## 模型体验

无：本包划分宿主 CPU 与内存，不注册任何提示词、工具或会话事件。

#### KV Cache 影响

此处没有任何内容进入请求前缀，因此提供方缓存复用不受影响。
## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **内存检查是估算。** 它把任务配置的开销与系统空闲内存相比较。它不测量任务实际的常驻集，因此用量远超其占用的任务不会被本包拦下。
- **没有硬性强制执行。** CPU 份额与内存上限由容器或 cgroup 持有，而不是由本包持有。在没有它们的情况下运行意味着计划只是建议性的。
- **空闲内存读取自操作系统，而不是 cgroup。** `os.freemem()` 报告机器的空闲内存，在容器中这大于 cgroup 仍然允许的内存。在受限宿主机上，请传入 `freeMemoryMb` 以提供 cgroup 自身的剩余预算。
- **接纳不预留 CPU。** 批次的 CPU 数字会被校验并报告，但不按任务强制执行；在实践中限定 CPU 用量的是并发度。
- **崩溃会让占用仍被持有。** 崩溃后另一个进程的占用不可见，因此闸门不是跨进程锁。

<a id="dev-note"></a>
### 开发备注

无。
