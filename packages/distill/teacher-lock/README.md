---
description: "The load-time teacher-model lock for distillation compositions: resolve the single model a run may use across the launch environment and the composition, refuse a widened allowlist, and fail before any trajectory is recorded."
kind: "package-reference"
---

# @deepseek-ai/dsh-distill-teacher-lock

## Summary

Every trajectory a distillation run produces must come from one teacher model, and a composition that cannot be pinned to one must fail before it records anything. `dsh-distill-teacher-lock` resolves that one model when the composition loads and refuses the run when it cannot: no candidate model at all, two layers naming different models, or a chosen model outside the allowlist. It also refuses an allowlist that tries to accept any model, because a lock that accepts everything is not a lock.

The judgment is a pure function (`resolveTeacherLock` in `./lock`), so it is testable without a running composition; the plugin only reads the candidate layers and calls it.

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

Mount it in a distillation composition:

```yaml
- id: distill-teacher-lock
  name: '@deepseek-ai/dsh-distill-teacher-lock'
  config:
    allow: [deepseek-flash]
```

The mount throws when the composition cannot be pinned, so a misconfigured run stops at load rather than producing mislabeled data.

| Field | Default | Meaning |
|---|---|---|
| `allow` | `deepseek-flash` plus the retired aliases | Model ids this composition accepts. A different teacher is a deliberate override. |
| `model` | absent | The composition's own model, consulted only when the launch environment names none. The adapter's selection stays the authority. |

### Where the locked model comes from

Candidates are consulted in precedence order, and the first one wins:

| Order | Layer | Source |
|---|---|---|
| 1 | `DSH_DISTILL_MODEL` | launch environment |
| 2 | `MODEL_NAME` | launch environment |
| 3 | `ctx.agentDefaultModel.currentSelection().model` | composition |
| 4 | the plugin's own `model` | composition |

The environment is read through `launchEnvironmentOf`, the same snapshot the model adapters resolve variables through, so the lock and the adapter cannot disagree about which layer supplied a value.

### Failures to plan for

All of these stop the mount:

| Condition | Code | Why it is refused |
|---|---|---|
| No layer names a model | `model-not-allowed` | Nothing to pin |
| The environment and the composition name different models | `model-not-allowed` | A run is pinned to one teacher; picking either silently would mislabel data |
| The chosen model is not in `allow` | `model-not-allowed` | The composition does not accept that teacher |
| An `allow` entry is empty or padded | `model-not-allowed` | The entry cannot pin a model |
| `allow` is empty | `empty-allowlist` | Distinct from "no candidate": the allowlist itself is unusable |
| `allow` carries `*` | `allowlist-widened` | Accepting any model is a refused widening, not an unknown model |
| A consulted variable is set but empty | `model-not-allowed` | Set-but-empty is a misconfiguration, not an absent value |

A retired alias (`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`) is **accepted** and logged at warning level, because the provider still routes it to the current teacher; the lock reports `legacy: true` so the operator can update the recorded id.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`resolveTeacherLock` validates the allowlist first, then the candidate set, then the chosen model. Order matters: an unusable allowlist is reported as such even when no candidate exists, because the allowlist failure is the more specific fact.

The widening sentinel is checked before the emptiness and padding checks so that `*` reports `allowlist-widened` rather than the generic code — the operator needs to know a composition tried to accept any model, not merely that one entry was malformed.

The resolved lock copies its allowlist. A caller that holds the array it passed in cannot widen a live lock afterwards.

### Source map

| File | Role |
|---|---|
| [`src/lock.ts`](src/lock.ts) | The whole judgment: constants, the allowlist validator, conflict detection, and resolution |
| [`src/index.ts`](src/index.ts) | The Cordis plugin: read the two candidate layers, resolve, log, throw on refusal |
| — | No runtime invariant companion is published. The lock holds no mutable state after load and its decision is fully covered by unit tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The runtime half of teacher verification — recording the model the provider actually served and flagging a mismatch — belongs to the trajectory recorder, not here: this package decides what a run *may* use, and the recorder proves what a run *did* use.

-----

## Model Experience

None, as the lock validates composition configuration at load time and registers no prompt, tool, or session event.

#### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.
## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The lock pins configuration, not traffic.** It refuses a composition whose configured teacher is wrong. Proving that a response came from the pinned model requires observing the served model on each response, which this package does not do.
- **A later patch can replace the row.** The lock validates the configuration it loaded. A patch applied afterwards can change the adapter's model without re-running this check; the composition's layer order is what prevents that.
- **The allowlist is a policy, not a guarantee.** `deepseek-v4-pro` is refused by default only because the default allowlist names the teacher; a composition that deliberately allows another model is honoured.
- **Retired aliases are accepted, not rewritten.** The lock reports `legacy: true` and warns; it does not fail the run, because the provider still serves the current teacher for those names.

<a id="dev-note"></a>
### Dev Note

None.
