---
description: "蒸馏运行器：加载任务定义，针对一位教师运行相互独立的 attempt，实时捕获每条轨迹，用客观评估器做出判定，并写出带标签的数据集。"
kind: "package-reference"
---

# @deepseek-ai/dsh-distill

[English](README.md) | 中文

## 概述

使用 `dsh-distill` 把任务语料库变成带标签的 agent 数据集：它加载任务定义，为每个 attempt 准备全新工作区，通过调用方提供的 agent 运行该 attempt，在其工作期间记录轨迹，用任务声明的命令判定结果，并把结果连同共享索引写到状态目录下。

任何东西都不信任模型自己的报告。只有当任务的评估器以预期退出码退出、且每一项声明的检查都通过时，该任务才算成功，被篡改的 attempt 绝不会进入成功桶。

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
import { DatasetWriter, loadTasks, runTask } from '@deepseek-ai/dsh-distill'

const { root, defaults, tasks } = await loadTasks('/corpus/tasks/manifest.yml')
const dataset = new DatasetWriter({ root: '/out/dataset' })
for (const task of tasks) {
  if (await dataset.completed(task.task_id) !== undefined) continue
  await runTask({
    task, defaults,
    templatesRoot: '/corpus/templates',
    evaluatorRoot: '/corpus/evaluator',
    runsRoot: '/out/runs',
    dataset,
    expectedTeacherModel: 'deepseek-flash',
    agent,                      // the caller's agent side
  })
}
```

命令行入口位于 `apps/distill`，它接受 `--manifest`、`--out`，以及可选的 `--templates`、`--evaluators`、`--runs` 和可重复的 `--task`。

### 任务定义

任务说明向教师提出什么请求、从哪个工作区开始，以及它的工作如何被判定。

```yaml
version: 1
task_id: T01-csv-to-json
prompt: |
  Implement tools/csv2json.mjs …
initial_context: |
  Conventions the agent should know.
workspace:
  template: node-basic
  exclude: ["node_modules/**"]
  seed_files:
    - path: data/input.csv
      content: "id,name\n1,alice\n"
evaluator:
  kind: hidden_test
  assets: [test/csv2json.test.mjs]
  command: ["node", "--test", "test/csv2json.test.mjs"]
  expect_exit_code: 0
checks:
  - kind: file_exists
    path: tools/csv2json.mjs
max_attempts: 5
tags: [coding, node]
```

| 评估器类型 | 含义 |
|---|---|
| `test_command` | 运行一条命令并比较其退出码；同一个测试对 agent 也可见 |
| `hidden_test` | 同上，但该测试只存在于隐藏资产目录中 |
| `artifact_check` | 对 agent 产出的文件运行一个检查器 |

### attempt 与状态

一个任务最多运行 `max_attempts` 个相互独立的 attempt，每个都从模板的全新副本开始，并在首次成功时停止。

| 结果 | 是否消耗 attempt | 数据集归属桶 |
|---|---|---|
| `FAILED` / `TIMEOUT` | 是 | `failed/<task_id>` |
| `ERROR` 且 `error_class: agent` | 是 | `failed/<task_id>` |
| `ERROR` 且 `error_class: infrastructure` | 仅当 `infra_error_consumes_attempt` 为 true 时 | `invalid/infrastructure-error/<task_id>` |
| `UNKNOWN`（没有评估器运行） | 不重试 | `invalid/unknown/<task_id>` |
| 所有 attempt 已用尽 | — | `abandoned/<task_id>` |
| `SUCCESS` 且无完整性标记 | — | `success/<task_id>` |

单独的 `infra_error_max` 预算，加上一个绝对的 attempt 上限，可防止永久损坏的环境陷入循环。

### 完整性标记

| 标记 | 触发条件 |
|---|---|
| `test_tampering` | 某个评估器资产被新增、修改或删除 |
| `scaffold_modified` | 交给 agent 的某个模板文件被修改或删除 |
| `test_shadowing` | 出现新的**测试形态**路径（`tests/`、`*.test.ts` 等） |
| `model_mismatch` | 该 attempt 记录的模型与 `expectedTeacherModel` 不同 |

创建普通的输出文件正是任务的目标，因此它不触发任何标记。任何标记都会让该 attempt 停留在 `success/` 之外；轨迹仍会完整写在 `failed/` 下。

### 数据集布局

```text
<out>/
├── index.jsonl                       one line per finished task
├── success/<task_id>/trajectory.json
├── failed/<task_id>/trajectory.json
├── abandoned/<task_id>/trajectory.json
└── invalid/{unknown,infrastructure-error}/<task_id>/trajectory.json
```

`index.jsonl` 在独占锁下追加，包含任务的状态、attempt 数量、被选中的 attempt、完整性标记、教师与目录——因此无需扫描整棵树就能追踪一个 `task_id`。

## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 为何 agent 侧是一个接口

`AgentRunner` 就是全部的 agent 约定：给定一个 attempt，运行它并报告结果。生命周期——工作区准备、指纹计算、记录、判定、重试与数据集写入——与 agent 如何构建无关，因此整个循环既能用脚本化的教师测试，也能用于真实组合。

### 一次 attempt 中的操作顺序

1. 依据模板准备全新工作区，并暂存隐藏资产。
2. 对工作区与评估器目录计算指纹——这正是之后能发现篡改的原因。
3. 创建该 attempt 的记录器并追加 `task_start`。
4. 运行 agent。
5. 重新计算指纹，得出完整性标记，并检查记录的模型。
6. 用评估器判定，除非 agent 因基础设施原因出错，此时跳过判定并记录为已跳过。
7. 追加 `attempt_end`，读回事件，并组装轨迹。

### 指纹与归因

指纹是 `path → sha256` 映射，因此一次 diff 会准确指出哪些路径被新增、修改或删除。同一次 diff 产出文件变更列表，而正是它把变更归因到该 attempt——运行器把路径记在产生它们的那个 attempt 名下，而不只是记录一份最终 diff。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/tasks.ts`](src/tasks.ts) | manifest 与任务校验，包括目录安全的 `task_id` 规则 |
| [`src/workspace.ts`](src/workspace.ts) | 模板复制、种子文件与 glob 规则 |
| [`src/evaluator.ts`](src/evaluator.ts) | 命令执行、指纹、完整性标记与判定 |
| [`src/trajectory.ts`](src/trajectory.ts) | 从原始事件到步骤、动作、观察与产物 |
| [`src/dataset.ts`](src/dataset.ts) | 原子文档写入、归属桶选择与加锁索引 |
| [`src/runner.ts`](src/runner.ts) | attempt 循环与 agent 接口 |
| — | 不发布运行时不变式伴生入口。运行器拥有自己的 attempt 目录与数据集；没有独立观察能与之产生分歧。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

原始事件捕获与脱敏位于 `@deepseek-ai/dsh-distill-trajectory-events` 和 `@deepseek-ai/dsh-distill-redaction`；教师锁位于 `@deepseek-ai/dsh-distill-teacher-lock`。

-----

## 模型体验

### 任务提示词

#### 模型看到什么

运行器供给每个任务所声明的文本：任务的 `prompt`、存在时的 `initial_context`，以及仅当任务设置 `carry_failure_feedback` 时上一个 attempt 的失败原因。它自身不注册任何系统提示词、工具、工具 schema 或会话事件。

#### token 影响

每个 attempt 一个提示词。attempt 之间相互独立，因此重试会再次计入所声明的提示词，而不是一份不断增长的文本记录。

#### KV Cache 影响

attempt 之间相互独立，因此每个 attempt 都开启一个新的请求序列，attempt 之间没有共享前缀；attempt 内部的缓存行为由 agent loop 负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **文件捕获仅限工具可见的部分。** 运行器记录它能在 attempt 前后计算指纹的内容。它不会在每次动作前对工作区做快照，因此 `file_capture.coverage` 报告 `file-tools-only`，而在接入由仓库支撑的捕获之前 `git` 为 `false`。
- **基础设施预算是按任务的。** `infra_error_max` 限定单个任务的重试；调度器级别的 API 预算不属于本包。
- **批次接纳位于伴生包中。** 本包一次运行一个任务。并发、CPU 与内存划分以及超额分配拒绝位于 `@deepseek-ai/dsh-distill-resource`；忽略它的调用方会以未划分的方式运行。
- **崩溃会让 attempt 处于未完成状态。** 只有在调用方检查运行目录时，恢复才会把某个 attempt 标为未完成；运行器不会自行修复上一个进程的 attempt。
- **`expectedTeacherModel` 是可选的。** 不提供它就不会运行教师身份检查，轨迹的模型只与记录它的适配器同样可信。

<a id="dev-note"></a>
### 开发备注

无。
