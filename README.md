# DeepSeek-Harness-distiller

English | [中文](README.zh.md)

This project builds on DeepSeek Harness (dsh `0.2.0-rc.2`) and adds a teacher-model trajectory distillation layer: a strong model works on real tasks, the whole process is recorded, and the result is a labelled training dataset.

This document covers one thing only: what we changed compared with the original.

Every number below comes from git and can be checked directly. The baseline is the commit that imports the upstream release tree, so it is found by its message rather than named here:

```bash
BASE=$(git log --format=%H --grep='pristine dsh' --max-count=1)
git log --oneline "$BASE..HEAD"
git diff --shortstat "$BASE..HEAD"
git diff --name-status "$BASE..HEAD"
```

## Summary

We touched 6 files of the original hand-written source, about 120 lines, all additions. Nothing was deleted and no existing behavior changed. Everything else is new packages, a new application, and tests.

That baseline is the `0.2.0-rc.2` release tree, 14,104 files. Since then there are 33 commits changing 104 files, 73 of them new (including 13 test files). Two more files are generated artifacts that a generator run refreshes, so nobody edits them by hand.

## Files changed in the original source

Changing core code carries risk, so each file is described below.

### 1. `packages/llm/llm/src/types.ts`

The `usage` chunk of the streaming protocol gained one optional field, `servedModel`:

```diff
- | { type: 'usage'; usage: TokenUsage }
+ | {
+   type: 'usage'
+   usage: TokenUsage
+   servedModel?: string
+ }
```

The model named in a request is not always the model that answered; an alias or a routed deployment can differ. A dataset that has to say which model produced a trajectory needs this recorded.

### 2. `packages/llm/llm-deepseek/src/translate.ts`

The original discarded `message.model` while parsing a response. We read it and pass it up through the field above:

```diff
+ let servedModel: string | undefined
- updateUsage(usage, object(event.message).usage)
+ const message = object(event.message)
+ updateUsage(usage, message.usage)
+ if (typeof message.model === 'string' && message.model.length > 0) servedModel = message.model
- yield { type: 'usage', usage }
+ yield { type: 'usage', usage, ...servedModel === undefined ? {} : { servedModel } }
```

Only the adapter layer can see this, so it has to change here.

### 3. `packages/shell/tool-bash/src/index.ts`

The bash tool gained a `presentationMeta` projection that writes the command's structured result into the tool result's metadata, which the model never sees:

```
shell, command, workdir, exit_code, signal,
timed_out, aborted, timeout_ms, stdout, stderr
```

What the model reads is one merged text block: stdout and stderr mixed together, the exit code only a marker inside the text. That form is written for a reader. A dataset needs what a machine can use directly: the exit code, the two streams apart, and whether a signal ended the command.

`ToolResult.meta` is a field the framework already has. Its documentation states it is persisted verbatim on `tool/result` and that it is not part of the model-visible content. So this change does not affect model input and does not move snapshot tests.

### 4. `packages/shell/tool-pwsh/src/index.ts`

The same change as above. A real-API test is what showed that both tools need it: on Windows the model runs `pwsh`, not `bash`. Changing only `tool-bash` would leave this information empty on every Windows machine.

### 5. `packages/boot/app-boot/src/index.ts`

`distill-teacher-lock` joined the list of entries that must start successfully:

```diff
+ // A composition that mounts the teacher lock must not start when the lock
+ // refuses it, or a run would record trajectories attributed to the wrong model.
+ 'distill-teacher-lock',
```

Without this line the application keeps running after the teacher lock refuses, and the run records an entire trajectory attributed to the wrong model. We want a misconfiguration to stop with an error rather than pass silently.

### 6. `packages/boot/app-boot/src/profile.ts`

A new profile is registered so that `dsh --profile distill` can start:

```diff
+ distill: { bundles: ['@deepseek-ai/dsh-base'] },
```

### Generated files

- `packages/extensions/tool-cordis/src/api-catalog.ts`: the Cordis service catalog, which the new `ctx.distillCapture` is generated into
- `packages/preset/agent-preset/skills/cordis-composition-reference/references/packages.md`: the plugin package list, for the same reason

Beyond those, the root `package.json` gained one script that starts the distillation application:

```diff
+ "distill": "node --import tsx/esm apps/distill/src/bin.ts",
```

## Why these could not be avoided

- Only the adapter knows `served_model`; `message.model` is dropped inside `translate.ts` and is unavailable anywhere else.
- Only the shell tool knows how a command ended; from outside, all that survives is merged text.
- The teacher lock needs startup assembly to guarantee "refuse means stop", which is exactly what `requiredStartupEntryIds` is for. A normal plugin cannot do it.

Every other capability is implemented as a new plugin. Nothing else in the original was changed.

## What was added

### Five packages

Five packages were added under `packages/distill/`:

| Package | What it does |
|---|---|
| `redaction` | Replaces secret values with placeholders before anything reaches disk: raw events, blobs, trajectories, and archived sessions |
| `teacher-lock` | Refuses at load time any composition that could serve a model other than the locked teacher |
| `trajectory-events` | Subscribes to session and stream events and writes a redacted raw event log plus content-addressed blobs |
| `distill` | Loads task definitions, runs independent attempts, judges them objectively, and writes the labelled dataset |
| `resource` | Detects the CPU and memory a container actually allows, and refuses a partitioning that does not fit |

### One application

`apps/distill/` is the application that drives the whole pipeline:

- `composition.ts`: assembled through the Cordis Loader (`loadProfile` + `createRuntimeResolution` + `PluginPackages` + `boot`), not hand-written `ctx.plugin(...)` calls
- `agent-runner.ts`: the production `AgentRunner`, creating the session, sending the message, waiting for idle with a deadline, and flushing to disk
- `bin.ts`: the command-line entry point, handling arguments, rate limiting, and resource validation before running tasks one by one

There is also a real-API test (`tests/real-agent.spec.ts`) that skips itself when no key is configured.

### Documentation

- [`docs/subsystems/distill.md`](docs/subsystems/distill.md): the distillation subsystem reference, covering the capture contract, the trajectory document, the dataset buckets, and host partitioning
- [`docs/persistence-changes/2026-10-02-served-model-optional.md`](docs/persistence-changes/2026-10-02-served-model-optional.md): the bilingual acknowledgement record for the persistence-type change

## Verification

| Item | Result |
|---|---|
| `pnpm run doc-sync` documentation gates | 43 / 43 passing |
| Coverage of the five new packages (100% per file) | 5 / 5 passing |
| Unit tests for the new packages and application | 355 passing |
| Real-API end to end | 3 / 3 passing |
| `tsc -b tsconfig.host.json` | exit code 0 |
| `packages/shell/tool-pwsh` own test suite | 100 passing |

The three real-API cases are: a judged success, a judgement that can never pass, and a run that exceeds its budget. All three ran against real credentials; they skip themselves when no key is present.

## Run

The application runs the built artifacts in `lib/`. After editing `src/`, rebuild first or the real path will not see the change:

```bash
pnpm run build:lib:host
```

### Run from source

```bash
pnpm install

node node_modules/vitest/vitest.mjs run packages/distill

node node_modules/vitest/vitest.mjs run packages/distill/distill \
  --coverage --coverage.include='packages/distill/distill/src/**'

pnpm run doc-sync

DEEPSEEK_API_KEY=<key> node node_modules/vitest/vitest.mjs run apps/distill/tests/real-agent.spec.ts
```

## Known limitations

- **`tool-bash`'s own tests do not run on our development machine.** `packages/shell/tool-bash/tests/**` is excluded from vitest there (the machine is Windows and has no bash). That change is currently covered only by its type contract and by its callers' tests; the full suite needs Linux.
- **The evaluator has no separate sandbox.** It runs in the same process as the runner. Tampering is caught by comparing fingerprints taken before and after the attempt, but there is no process isolation.
- **The `thinking` switch is not recorded.** It lives in the adapter's wire format, not in `LlmCallConfig`. The trajectory records `reasoning_available` instead: whether reasoning content actually came back.
- **Not done yet:** redacting and destroying session logs, crash recovery, and a configuration precedence chain.

## Related documents

- [Distillation subsystem reference](docs/subsystems/distill.md): the capture service, what an attempt records, the dataset buckets, and host partitioning
- [Persistence-type change record](docs/persistence-changes/2026-10-02-served-model-optional.md): the compatibility note for the `servedModel` field
- [Safety notice](SAFETY.md): read this before running the project
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
