---
description: "The distillation runner: load task definitions, run independent attempts against one teacher, capture each trajectory in real time, judge it with an objective evaluator, and write the labelled dataset."
kind: "package-reference"
---

# @deepseek-ai/dsh-distill

English | [中文](README.zh.md)

## Summary

Use `dsh-distill` to turn a corpus of tasks into a labelled agent dataset: it loads task definitions, prepares a fresh workspace per attempt, runs the attempt through a caller-supplied agent, records the trajectory while it works, judges the result with commands the task declares, and writes the outcome under a status directory with a shared index.

Nothing trusts the model's own report. A task succeeds only when its evaluator exits with the expected code and every declared check passes, and a tampered attempt never enters the success bucket.

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

The command-line entry point lives in `apps/distill` and takes `--manifest`, `--out`, and optional `--templates`, `--evaluators`, `--runs`, and repeated `--task`.

### Task definition

A task states what the teacher is asked, what workspace it starts from, and how its work is judged.

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

| Evaluator kind | Meaning |
|---|---|
| `test_command` | Runs a command and compares its exit code; the same test is also visible to the agent |
| `hidden_test` | The same, but the test exists only in the hidden asset directory |
| `artifact_check` | Runs a checker over a file the agent produced |

### Attempts and statuses

A task runs up to `max_attempts` independent attempts, each from a fresh copy of the template, and stops at the first success.

| Outcome | Consumes an attempt | Dataset bucket |
|---|---|---|
| `FAILED` / `TIMEOUT` | yes | `failed/<task_id>` |
| `ERROR` with `error_class: agent` | yes | `failed/<task_id>` |
| `ERROR` with `error_class: infrastructure` | only when `infra_error_consumes_attempt` is true | `invalid/infrastructure-error/<task_id>` |
| `UNKNOWN` (no evaluator ran) | no retry | `invalid/unknown/<task_id>` |
| all attempts spent | — | `abandoned/<task_id>` |
| `SUCCESS` with no integrity flags | — | `success/<task_id>` |

A separate `infra_error_max` budget, plus an absolute attempt ceiling, keep a permanently broken environment from looping.

### Integrity flags

| Flag | Raised when |
|---|---|
| `test_tampering` | An evaluator asset was added, changed, or removed |
| `scaffold_modified` | A template file the agent was given was changed or deleted |
| `test_shadowing` | A new **test-shaped** path appeared (`tests/`, `*.test.ts`, …) |
| `model_mismatch` | The attempt's recorded model differs from `expectedTeacherModel` |

Creating an ordinary output file is the task's goal, so it raises no flag. Any flag keeps the attempt out of `success/`; the trajectory is still written in full under `failed/`.

### Dataset layout

```text
<out>/
├── index.jsonl                       one line per finished task
├── success/<task_id>/trajectory.json
├── failed/<task_id>/trajectory.json
├── abandoned/<task_id>/trajectory.json
└── invalid/{unknown,infrastructure-error}/<task_id>/trajectory.json
```

`index.jsonl` is appended under an exclusive lock and holds the task's status, attempt count, selected attempt, integrity flags, teacher, and directory — so a `task_id` is traceable without scanning the tree.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Why the agent side is an interface

`AgentRunner` is the whole agent contract: given an attempt, run it and report an outcome. The lifecycle — workspace preparation, fingerprinting, recording, judgment, retry, and dataset writing — is independent of how the agent is built, so the whole loop is testable with a scripted teacher and usable with a real composition.

### Order of operations in one attempt

1. Prepare a fresh workspace from the template and stage the hidden assets.
2. Fingerprint the workspace and the evaluator directory — this is what makes tampering detectable later.
3. Create the attempt's recorder and append `task_start`.
4. Run the agent.
5. Re-fingerprint, compute integrity flags, and check the recorded model.
6. Judge with the evaluator, unless the agent faulted for infrastructure reasons, in which case judgment is skipped and recorded as skipped.
7. Append `attempt_end`, read the events back, and assemble the trajectory.

### Fingerprints and attribution

Fingerprints are `path → sha256` maps, so a diff names exactly which paths were added, changed, or removed. The same diff produces the file-change list, which is what attributes a change to the attempt — the runner records paths against the attempt that produced them rather than only a final diff.

### Source map

| File | Role |
|---|---|
| [`src/tasks.ts`](src/tasks.ts) | Manifest and task validation, including the directory-safe `task_id` rule |
| [`src/workspace.ts`](src/workspace.ts) | Template copying, seeding, and the glob rules |
| [`src/evaluator.ts`](src/evaluator.ts) | Command execution, fingerprints, integrity flags, and judgment |
| [`src/trajectory.ts`](src/trajectory.ts) | Raw events to steps, actions, observations, and artifacts |
| [`src/dataset.ts`](src/dataset.ts) | Atomic document writes, bucket choice, and the locked index |
| [`src/runner.ts`](src/runner.ts) | The attempt loop and the agent interface |
| — | No runtime invariant companion is published. The runner owns its attempt directories and its dataset; no independent observation can diverge from them. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Raw event capture and redaction live in `@deepseek-ai/dsh-distill-trajectory-events` and `@deepseek-ai/dsh-distill-redaction`; the teacher lock lives in `@deepseek-ai/dsh-distill-teacher-lock`.

-----

## Model Experience

### Task prompt

#### What the model sees

The runner supplies the text each task declares: the task's `prompt`, its `initial_context` when present, and the previous attempt's failure reason only when the task sets `carry_failure_feedback`. It registers no system prompt, tool, tool schema, or session event of its own.

#### Token effect

One prompt per attempt. Attempts are independent, so a retry is charged the declared prompt again rather than a growing transcript.

#### KV Cache effect

Attempts are independent, so each starts a new request series with no shared prefix across attempts; the agent loop owns cache behavior within an attempt.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **File capture is tool-visible only.** The runner records what it can fingerprint around the attempt. It does not snapshot the workspace before every action, so `file_capture.coverage` reports `file-tools-only` and `git` is `false` until a repository-backed capture is wired in.
- **The infrastructure budget is per task.** `infra_error_max` bounds one task's retries; a scheduler-wide API budget is not part of this package.
- **Batch admission lives in a companion package.** This package runs one task at a time. Concurrency, CPU and memory partitioning, and the over-allocation refusal live in `@deepseek-ai/dsh-distill-resource`; a caller that ignores it runs unpartitioned.
- **A crash leaves an attempt incomplete.** Resuming marks an unfinished attempt only if the caller inspects the run directory; the runner does not repair a previous process's attempt on its own.
- **`expectedTeacherModel` is optional.** Without it, no teacher-identity check runs and a trajectory's model is only as trustworthy as the adapter that recorded it.

<a id="dev-note"></a>
### Dev Note

None.
