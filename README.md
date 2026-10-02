# DeepSeek-Harness-distiller

English | [中文](README.zh.md)

A **teacher model** works on real tasks, every step it takes is recorded, and the result is a labelled training dataset for a future student model.

What gets recorded is the **process**, not just the final answer: what it saw → what it decided → which tool it called → what the tool returned → how it fixed things → how it finished.

This guide takes you from nothing to your first completed task. About 10 minutes if you follow along.

## What you need

| You need | Notes |
|---|---|
| **Node.js** | Version `^22.19` or `>=24`. Check with `node -v` |
| **pnpm** | The package manager. `pnpm -v` printing a version is enough |
| **A DeepSeek API key** | Get one from [platform.deepseek.com](https://platform.deepseek.com). It looks like `sk-...` |
| **Disk space** | About 3 GB (dependencies come to a little over 2 GB) |

## Run

### Run from source

**Step 1: Get the code and install dependencies**

```bash
git clone https://github.com/ResonantAlive/DeepSeek-Harness-distiller.git
cd DeepSeek-Harness-distiller
pnpm install
```

`pnpm install` takes a few minutes. That is normal.

**Step 2: Build**

```bash
pnpm run build:lib:host
```

⚠️ **Do not skip this.** The application runs the built artifacts in `lib/`, not the sources in `src/`. **Editing source without rebuilding changes nothing at runtime** — this is the easiest trap to fall into.

**Step 3: Configure your key**

Create a `.env` file in the project root:

```bash
DEEPSEEK_API_KEY=sk-your-key-here
```

⚠️ **Do not set `DEEPSEEK_BASE_URL`.** The default is correct (`https://api.deepseek.com/anthropic`). Pointing it at the bare hostname selects the wrong protocol and the error is hard to read.

`.env` is already in `.gitignore`, so it will not be committed.

**Step 4: Write your first task**

A corpus looks like this. Three folders, each with one job:

```
my-corpus/
├── tasks/
│   ├── manifest.yml
│   └── T01.yml
├── templates/
│   └── hello/
│       └── README.md
└── evaluator/
```

- `tasks/manifest.yml` — the task list
- `tasks/T01.yml` — one task: the prompt and how to judge it
- `templates/hello/` — the starting workspace, **copied fresh for every attempt**
- `evaluator/` — hidden files for judging, **invisible to the model** (unused in this example)

`tasks/T01.yml`:

```yaml
version: 1
task_id: T01
prompt: |
  Create a file named hello.txt in the current directory.
  Its contents must be exactly the single word: hello
  Then you are done. Do not explain.
workspace:
  template: hello
evaluator:
  kind: test_command
  command:
    - node
    - -e
    - "process.exit(require('node:fs').readFileSync('../workspace/hello.txt','utf8').trim()==='hello'?0:1)"
```

`tasks/manifest.yml`:

```yaml
version: 1
tasks:
  - file: T01.yml
```

Put any file in `templates/hello/`:

```bash
mkdir -p my-corpus/templates/hello
echo "A scratch workspace." > my-corpus/templates/hello/README.md
```

⚠️ **Notice the `../workspace/` in the evaluator command.** The evaluator's working directory is `evaluator/`, **not** the workspace. To read a file the model produced, go up one level and into `workspace/`. Writing plain `hello.txt` makes every attempt fail.

**Step 5: Run it**

```bash
pnpm run distill --manifest my-corpus/tasks/manifest.yml --out my-corpus/dataset --templates my-corpus/templates
```

The three arguments are the task list, the output directory, and the templates directory. `--evaluators` is only needed when you use hidden judging files.

A run looks like this:

```
host: 8 CPU (os), 24128 MB (os)
T01: SUCCESS attempts=1 -> success/T01
```

The first line reports the machine resources that were detected. The second is the outcome: **the task succeeded, how many attempts it took, and where it was written**.

## Reading the result

After a run, `my-corpus/dataset/` looks like this:

```
dataset/
├── index.jsonl
├── success/
│   └── T01/
│       └── trajectory.json
├── abandoned/
├── invalid/
└── failed/
    └── T01/
        ├── attempt_001/trajectory.json
        └── attempt_002/trajectory.json
```

- `index.jsonl` — one line per task, the whole index
- `success/` — tasks that were judged successful
- `abandoned/` — retries exhausted without success
- `invalid/` — could not be judged (a broken evaluator, say)
- `failed/` — **every failed attempt, archived on its own** (the task itself may be in another bucket)

Open `success/T01/trajectory.json` and you get the full record of one attempt:

- `teacher` — which model did the work, including `served_model`, the model that **actually** served it
- `trajectory[]` — the process step by step: `observations` (what it saw), `decision` (what it decided), `actions` (which tools it called)
- `artifacts` — which files changed, and **what changed inside them** (a unified diff)
- `evaluation` — the judgement and its reason

**Both successes and failures are kept.** Failures are not waste — a student model learns from "this did not work" just as much.

## The task file, line by line

### prompt

Describe in plain language what to do. **Describe a result that can be checked, not a method to follow.**

```yaml
prompt: Refactor this function to use async/await
```

That one is hard to judge. Replace it with something like:

```yaml
prompt: Make load() return a Promise that resolves to the parsed data
```

The reason: a requirement you cannot write a check for is one the model cannot get right either — neither side knows what "done" looks like.

### workspace

```yaml
workspace:
  template: hello
```

`template` names a folder under `templates/`. **Every attempt gets a fresh copy**, so nothing carries over from the previous one.

You can also seed extra files:

```yaml
workspace:
  template: hello
  seed_files:
    - path: data/input.txt
      content: |
        listen
```

### evaluator

**Judging never asks the model whether it finished.** It runs a command and looks at the result.

```yaml
evaluator:
  kind: test_command
  command: [node, -e, "..."]
  timeout_ms: 60000
  expect_exit_code: 0
  assets: [verify.mjs]
```

| Field | Meaning |
|---|---|
| `kind` | `test_command` / `hidden_test` / `artifact_check` |
| `command` | A non-empty array of strings. **Exit code 0 passes, anything else fails** |
| `timeout_ms` | Optional. A timeout is recorded as an infrastructure fault, **not the model's fault** |
| `expect_exit_code` | Optional, 0 by default |
| `assets` | Optional. Hidden files copied in from `evaluator/T01/` |
| `expect_stdout_contains` | Optional. The output must contain this string |

Three common patterns:

| What you want to check | How to write it |
|---|---|
| Whether a file has the right contents | `node -e` reading the file and comparing |
| Whether the code works | run the test suite and read the exit code |
| Whether the result is correct | run a verification script |

**For anything more involved**, put the script at `evaluator/T01/verify.mjs` and pull it in with `assets`. The model **cannot see** that file, so it cannot edit the check to make itself pass.

```yaml
evaluator:
  kind: hidden_test
  command: [node, verify.mjs]
  assets: [verify.mjs]
```

Inside a verification script, reach the workspace through `../workspace/` as well:

```js
const ws = new URL('../workspace/', import.meta.url)
const out = readFileSync(new URL('hello.txt', ws), 'utf8').trim()
if (out !== 'hello') {
  console.error(`hello.txt contains ${JSON.stringify(out)}, expected "hello"`)
  process.exit(1)
}
```

**Whatever you write to `console.error` is stored in the dataset.** Write the reason clearly and you will understand the failure months later without re-running anything.

## Troubleshooting

**Q: I changed the code and nothing happened.**

Rebuild: `pnpm run build:lib:host`. The application runs `lib/`, not `src/`.

**Q: Everything ends up ABANDONED even though the model clearly did the work.**

Almost always a wrong path in the evaluator. Its working directory is `evaluator/`; the workspace is at `../workspace/`.

Look at `evaluation.entries[].stderr` inside `dataset/failed/T01/attempt_001/trajectory.json` — the failure reason is written there.

**Q: I get an error about the key.**

Check three things: the variable in `.env` is named `DEEPSEEK_API_KEY`; `DEEPSEEK_BASE_URL` is **not** set; and the key has not expired.

**Q: How do I run just one task?**

```bash
pnpm run distill --manifest my-corpus/tasks/manifest.yml --out my-corpus/dataset --templates my-corpus/templates --task T01
```

**Q: I want to run many tasks at once. How do I control concurrency?**

```bash
pnpm run distill --manifest my-corpus/tasks/manifest.yml --out my-corpus/dataset --templates my-corpus/templates --max-concurrent-tasks 4
```

The program detects the machine's real resources first (inside a container it reads the cgroup limits, which are smaller than the machine's stated figures). **A concurrency plan the host cannot hold is refused at startup** rather than being killed partway through.

**Q: A run is too slow.**

Tune `--attempt-timeout-ms` (the per-attempt deadline) and `--max-concurrent-tasks`. A task definition can also cap the steps and tokens of a single attempt.

## Next steps

**Writing the checks is the core work, and it is the part that takes the longest.** A few things learned the hard way:

1. **Write the check before the prompt.** If you cannot write a check for a requirement, leave it out of the prompt.
2. **Cover behaviours, not inputs.** An infinite input space usually maps to six or seven behaviours; one representative each is enough.
3. **Boundaries are where bugs hide**: empty arrays, a single element, the first and last page, exact multiples, zero and negatives, Chinese text and emoji.
4. **Keep formatting and style out of the checks.** Otherwise the model fails for reasons unrelated to the task, and the labels get noisy.

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
