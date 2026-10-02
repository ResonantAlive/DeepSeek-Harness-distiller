---
description: "Secret redaction for distillation artifacts: one pass over a string or a JSON value with a literal keyring and pattern rules, so no recorded stdout, trajectory, or archived session log reaches disk unredacted."
kind: "package-reference"
---

# @deepseek-ai/dsh-distill-redaction

English | [中文](README.zh.md)

## Summary

Use `dsh-distill-redaction` to remove secrets from anything a distillation run is about to persist. A redactor hides the caller's own values (the *keyring*) and the well-known credential shapes — PEM private keys, `Bearer` and `Authorization` values, `sk-` keys, and `api_key` assignments — replacing each hit with a typed placeholder such as `[REDACTED:API_KEY]`. `redactValue` redacts every string nested in a JSON value, the form trajectories and archived logs take before disk.

Redaction is one pass per string and never rescans a replacement, so repeated application is idempotent. It is a zero-dependency library: no plugin, no I/O.

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

Build one redactor per run and route every value through it before writing.

### Redacting a string

```ts
import { collectEnvironmentSecrets, createRedactor } from '@deepseek-ai/dsh-distill-redaction'

const redactor = createRedactor({ secrets: collectEnvironmentSecrets() })
const { value, counts } = redactor.redact(`DEEPSEEK_API_KEY=sk-live-abcdefghijklmnop`)
// value  === 'DEEPSEEK_API_KEY=[REDACTED:API_KEY]'
// counts === { byRule: { 'sk-key': 1 }, total: 1 }
```

### Redacting a JSON value

```ts
import { createRedactor } from '@deepseek-ai/dsh-distill-redaction'
import type { RedactableValue } from '@deepseek-ai/dsh-distill-redaction'

declare const event: RedactableValue
const redactor = createRedactor({ secrets: ['a-configured-value'] })
const { value } = redactor.redactValue(event)
```

`redactValue` returns a new structure; the input is never mutated.

### Choosing what to hide

| Option | Meaning |
|---|---|
| `secrets` | Literal values matched before any pattern rule. Values shorter than `MIN_SECRET_LENGTH` are ignored, and duplicates collapse. |
| `disable` | Rule ids to drop from `DEFAULT_REDACTION_RULES`. An unknown id is a no-op. |

`collectEnvironmentSecrets(env?)` builds a keyring from an environment: a name must match `SECRET_NAME_PATTERN`, must not end in a non-secret suffix (`_PATH`, `_FILE`, `_NAME`, `_LENGTH`, …), and its value must reach `MIN_SECRET_LENGTH`. It returns the values; it writes nothing.

### The default rules

| Id | Placeholder | Matches |
|---|---|---|
| `private-key` | `[REDACTED:PRIVATE_KEY]` | A complete `-----BEGIN … PRIVATE KEY-----` block, newlines included |
| `bearer` | `[REDACTED:BEARER]` | `Bearer <credential>` |
| `authorization-header` | `[REDACTED:AUTHORIZATION]` | The value after `Authorization:`, case-insensitively |
| `sk-key` | `[REDACTED:API_KEY]` | `sk-` followed by at least eight credential characters |
| `secret-assignment` | `[REDACTED:SECRET]` | The value of an `api_key` / `apikey` / `api-key` assignment |

Literal hits report under `LITERAL_RULE_ID` (`'literal'`) and use `[REDACTED:SECRET]`.

### Failures to plan for

`redactValue` throws a `TypeError` when the input contains a cycle. A cyclic value is not JSON, and the artifacts this feeds are JSON, so the walk refuses rather than letting one runaway structure exhaust the process.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Redaction runs in two phases so that no matcher is ever evaluated at every input position, which is what makes a hostile 200 000-character input finish in milliseconds rather than minutes.

### Phase one: locate candidates

Each matcher scans forward from its own cursor. A literal matcher uses `indexOf` in a loop; a rule matcher uses its global `RegExp` through `exec`. A zero-width match is dropped and the regex cursor is advanced one position, so the scan cannot spin. Every located span becomes a `Hit` carrying its start, end, rule id, placeholder, and `rank`.

`rank` is the matcher's position in the list, which encodes precedence: the literal secrets come first, longest first, then the rules in table order.

### Phase two: apply winners

Hits are sorted by start, then by rank. One left-to-right sweep applies each hit whose start is at or past the applied end, and skips the rest, so an inner hit inside an outer one never reaches the output. Sorting by `(start, rank)` is a total order for real hits — one matcher never produces two hits at the same index, and the literal matchers are position-ordered — so the sweep is deterministic and no tie-breaking key is needed.

Because a match is discovered by its own matcher rather than by trying every matcher at every offset, cost is linear in the input plus the number of hits. Because replacements are written into an output list and the input is never rewritten, a placeholder cannot be matched again: redacting output that already contains `[REDACTED:API_KEY]` changes nothing.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The whole surface: matcher preparation, the two-phase scan, and the JSON walk |
| — | No runtime invariant companion is published. This package owns no event stream or mutable runtime state, and its replacement contract is enforced by unit tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

This package is the redaction boundary of the distillation pipeline. The recorder that decides *what* is written, and the runner that decides *where*, are separate packages.

-----

## Model Experience

None, as redaction runs between a recorded value and the file that stores it.

#### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.
## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Patterns trade recall against collateral damage.** A pattern broad enough to catch every credential format would redact ordinary prose. The defaults favor precision: an unknown secret shape that the keyring does not already contain is not redacted. Pass the exact values a run is authorized to see as `secrets`.
- **The keyring is only as good as its source.** `collectEnvironmentSecrets` sees the environment it is given. A secret reaching a process by another route (a file read, a credential store) must be supplied through `secrets` explicitly.
- **Redaction is not detection.** `counts` reports what was replaced; it does not assert that nothing sensitive remains.
- **No streaming form.** The API takes a string or a JSON value, so a caller reading an arbitrarily large stream must chunk it and accept that a secret spanning a chunk boundary is missed.

<a id="dev-note"></a>
### Dev Note

None.
