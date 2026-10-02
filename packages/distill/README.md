---
description: "Package map for teacher-trajectory distillation: secret redaction, the single-teacher lock, live event capture, the attempt runner and dataset writer, and host resource partitioning."
kind: "package-group"
---

# distill/ — teacher-trajectory distillation

English | [中文](README.zh.md)

## Summary

The `distill/` group records what a teacher model does while it solves a task, so the result can train a student. One package redacts secrets, one locks the composition to a single teacher, one captures events while the agent works, one runs attempts and judges them against commands the task declares, and one partitions the host before a run starts. The group produces a dataset on disk, and the `apps/distill` application drives it.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package owns one stage of a run; open a package page for how to use it.

| Package | Role |
|---|---|
| [`redaction/`](redaction/README.md) | Replaces secret values with typed placeholders before any recorded bytes reach disk |
| [`teacher-lock/`](teacher-lock/README.md) | Refuses at load time a composition that could serve a model other than the locked teacher |
| [`trajectory-events/`](trajectory-events/README.md) | Subscribes to session and stream events and writes a redacted event log plus content-addressed blobs |
| [`distill/`](distill/README.md) | Loads task definitions, runs independent attempts, judges them objectively, and writes the labelled dataset |
| [`resource/`](resource/README.md) | Detects the CPU and memory a container actually allows and refuses an over-allocated partitioning |

-----

<a id="related-documentation"></a>
## Related documentation

- [Distillation subsystem reference](../../docs/subsystems/distill.md) — the capture service, what an attempt records, the dataset buckets, and host partitioning.
- [`apps/distill`](../../apps/distill) composes these packages into the application that runs a corpus.

<a id="dev-note"></a>
### Dev Note

None.
