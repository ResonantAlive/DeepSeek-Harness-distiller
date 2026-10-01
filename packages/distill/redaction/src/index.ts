/**
 * Zero-dependency secret redaction for distillation artifacts.
 *
 * Redaction runs in two phases so no matcher is ever evaluated at every input
 * position. Phase one finds every candidate hit by scanning each matcher
 * forward from its own cursor; phase two sorts those candidates and applies
 * the winners in one left-to-right pass, dropping any hit that overlaps an
 * already-applied one. Literal secrets outrank pattern rules, an earlier start
 * outranks a later one, and a longer hit wins a tie.
 *
 * `redactValue` applies the same redactor to every string reachable in a JSON
 * value, which is the form every artifact (raw events, trajectories, archived
 * session logs) takes before it reaches disk.
 *
 * @module @deepseek-ai/dsh-distill-redaction
 */

/** One pattern rule: what to match, and what replaces a hit. */
export interface RedactionRule {
  /** Stable identifier reported in {@link RedactionResult.counts}. */
  readonly id: string
  /** The replacement written in place of a hit. */
  readonly placeholder: string
  /** A global regular expression; matching at one exact position uses `lastIndex`. */
  readonly pattern: RegExp
}

/** A rule the caller disabled by identifier. */
export interface RedactionOptions {
  /** Rules to drop from {@link DEFAULT_REDACTION_RULES}, by id. */
  readonly disable?: readonly string[]
  /** Literal secrets matched before any pattern rule. */
  readonly secrets?: readonly string[]
}

/** Per-rule replacement counts plus the total. */
export interface RedactionCounts {
  /** Hits per rule id, including `literal` for the caller's own secret values. */
  readonly byRule: Readonly<Record<string, number>>
  /** Sum of {@link byRule}. */
  readonly total: number
}

/** The outcome of redacting one string or one JSON value. */
export interface RedactionResult<T> {
  /** The redacted value; structurally identical to the input. */
  readonly value: T
  /** How many replacements were made, and by which rule. */
  readonly counts: RedactionCounts
}

/** The identifier a caller-supplied literal secret is counted under. */
export const LITERAL_RULE_ID = 'literal'

/**
 * Shortest environment value treated as a secret. Shorter values are ordinary
 * words (`KEY=on`) whose redaction would corrupt unrelated text.
 */
export const MIN_SECRET_LENGTH = 8

/**
 * Environment names whose values are treated as literal secrets. Mirrors the
 * process scrub rule in `@deepseek-ai/dsh-subprocess` so both boundaries agree.
 */
export const SECRET_NAME_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** Suffixes that match {@link SECRET_NAME_PATTERN} without naming a secret. */
const NON_SECRET_NAME_SUFFIXES = [
  'BOOL', 'COUNT', 'ENABLED', 'FILE', 'ID', 'LAYOUT', 'LEN', 'LENGTH',
  'LIMIT', 'LIST', 'NAME', 'PATH', 'ROOT', 'SIZE',
] as const

/** The built-in pattern rules, in scan order. */
export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  {
    id: 'private-key',
    placeholder: '[REDACTED:PRIVATE_KEY]',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'bearer',
    placeholder: '[REDACTED:BEARER]',
    pattern: /Bearer\s+[A-Za-z0-9._~+=-]{8,}/g,
  },
  {
    id: 'authorization-header',
    placeholder: '[REDACTED:AUTHORIZATION]',
    pattern: /(?<=Authorization:\s{0,4})\S{8,}/gi,
  },
  {
    id: 'sk-key',
    placeholder: '[REDACTED:API_KEY]',
    pattern: /sk-[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: 'secret-assignment',
    placeholder: '[REDACTED:SECRET]',
    pattern: /(?<=api[_-]?key\s{0,4}[:=]\s{0,4})[^\s"'`,;]{8,}/gi,
  },
]

/** JSON-shaped values a redactor accepts. */
export type RedactableValue =
  | string
  | number
  | boolean
  | null
  | readonly RedactableValue[]
  | { readonly [key: string]: RedactableValue }

/** One matcher prepared for forward scanning. */
interface Matcher {
  readonly id: string
  readonly placeholder: string
  /** Literal form, for secrets. */
  readonly literal?: string
  /** Global form, for rules. */
  readonly pattern?: RegExp
}

/** One candidate replacement located in the input. */
interface Hit {
  readonly start: number
  readonly end: number
  readonly id: string
  readonly placeholder: string
  /** Lower sorts first: literal secrets outrank rules. */
  readonly rank: number
}

/** Whether `name` matches the secret shape but names a non-secret setting. */
function isNonSecretName(name: string): boolean {
  const upper = name.toUpperCase()
  return NON_SECRET_NAME_SUFFIXES.some(suffix => upper.endsWith(suffix))
}

/**
 * Collect literal secrets from an environment.
 *
 * A name must match {@link SECRET_NAME_PATTERN}, must not end in a non-secret
 * suffix, and its value must reach {@link MIN_SECRET_LENGTH}. Returned values are
 * deduplicated and never written anywhere by this module.
 *
 * @param env - the environment to inspect; defaults to the process environment.
 * @returns the literal secret values, or an empty array when none qualify.
 */
export function collectEnvironmentSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_LENGTH) continue
    if (!SECRET_NAME_PATTERN.test(name)) continue
    if (isNonSecretName(name)) continue
    found.add(value)
  }
  return [...found]
}

/** Longest secrets first, so a secret containing another secret wins. */
function toMatchers(options: RedactionOptions, rules: readonly RedactionRule[]): Matcher[] {
  const disabled = new Set(options.disable ?? [])
  const secrets = [...new Set(options.secrets ?? [])]
    .filter(secret => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  const literal: Matcher[] = secrets.map(secret => ({
    id: LITERAL_RULE_ID,
    placeholder: '[REDACTED:SECRET]',
    literal: secret,
  }))
  const patterns: Matcher[] = rules
    .filter(rule => !disabled.has(rule.id))
    .map(rule => ({
      id: rule.id,
      placeholder: rule.placeholder,
      pattern: new RegExp(rule.pattern.source, rule.pattern.flags),
    }))
  return [...literal, ...patterns]
}

/** A configured redactor plus its accumulated counts. */
export interface Redactor {
  /**
   * Redact one string.
   * @param text - the text to scan.
   * @returns the redacted text and this call's counts.
   */
  redact(text: string): RedactionResult<string>
  /**
   * Redact every string reachable in a JSON value.
   * @param value - the value to scan.
   * @returns a structurally identical value with strings redacted.
   */
  redactValue<T extends RedactableValue>(value: T): RedactionResult<T>
}

/**
 * Build a redactor from a caller-supplied rule set.
 *
 * The exported entry point always uses {@link DEFAULT_REDACTION_RULES}. This
 * variant exists so a test can drive scan behavior no built-in rule reaches �? * a zero-width pattern, or two rules that overlap.
 *
 * @param rules - the pattern rules to compile, in scan order.
 * @param options - literal secrets to hide and rule ids to disable.
 * @returns a redactor over exactly these rules.
 */
export function createRedactorFromRules(
  rules: readonly RedactionRule[],
  options: RedactionOptions = {},
): Redactor {
  return buildRedactor(options, rules)
}

/**
 * Build a redactor from literal secrets and the default pattern rules.
 * @param options - secrets to hide and rule ids to disable.
 * @returns a redactor whose two operations share one matcher list.
 */
export function createRedactor(options: RedactionOptions = {}): Redactor {
  return buildRedactor(options, DEFAULT_REDACTION_RULES)
}

/** Build a redactor over one matcher list. */
function buildRedactor(options: RedactionOptions, rules: readonly RedactionRule[]): Redactor {
  const matchers = toMatchers(options, rules)
  const empty = (): Record<string, number> => ({})

  const scan = (text: string, byRule: Record<string, number>): string => {
    if (matchers.length === 0) return text
    const hits: Hit[] = []
    for (let rank = 0; rank < matchers.length; rank++) {
      const matcher = matchers[rank] as Matcher
      if (matcher.literal !== undefined) {
        const literal = matcher.literal
        let from = text.indexOf(literal)
        while (from !== -1) {
          hits.push({
            start: from, end: from + literal.length, rank,
            id: matcher.id, placeholder: matcher.placeholder,
          })
          from = text.indexOf(literal, from + literal.length)
        }
        continue
      }
      const pattern = matcher.pattern as RegExp
      pattern.lastIndex = 0
      for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        // A zero-width match cannot advance the cursor, so it is skipped
        // rather than allowed to spin.
        if (match[0].length > 0) {
          hits.push({
            start: match.index, end: match.index + match[0].length, rank,
            id: matcher.id, placeholder: matcher.placeholder,
          })
        }
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1
      }
    }
    if (hits.length === 0) return text
    // Start then rank is a total order over real hits: one matcher never
    // produces two hits at the same index, and the literal matchers are
    // position-ordered. A single scan therefore cannot tie.
    hits.sort((a, b) => (a.start - b.start) || (a.rank - b.rank))
    let applied = 0
    const parts: string[] = []
    for (const hit of hits) {
      if (hit.start < applied) continue
      parts.push(text.slice(applied, hit.start), hit.placeholder)
      byRule[hit.id] = (byRule[hit.id] ?? 0) + 1
      applied = hit.end
    }
    parts.push(text.slice(applied))
    return parts.join('')
  }

  const totals = (byRule: Record<string, number>): RedactionCounts => ({
    byRule,
    total: Object.values(byRule).reduce((sum, count) => sum + count, 0),
  })

  const redact = (text: string): RedactionResult<string> => {
    const byRule = empty()
    return { value: scan(text, byRule), counts: totals(byRule) }
  }

  const redactValue = <T extends RedactableValue>(value: T): RedactionResult<T> => {
    const byRule = empty()
    const seen = new WeakSet<object>()
    const walk = (node: RedactableValue): RedactableValue => {
      if (typeof node === 'string') return scan(node, byRule)
      if (node === null || typeof node === 'number' || typeof node === 'boolean') return node
      // A cyclic value is not JSON, and the artifacts this feeds are JSON; walk
      // it rather than let one runaway structure exhaust the process.
      if (seen.has(node)) throw new TypeError('redactValue requires a JSON value; the input contains a cycle')
      seen.add(node)
      if (Array.isArray(node)) {
        const entries = (node as readonly RedactableValue[]).map(entry => walk(entry))
        seen.delete(node)
        return entries
      }
      const out: Record<string, RedactableValue> = {}
      for (const [key, entry] of Object.entries(node)) out[key] = walk(entry)
      seen.delete(node)
      return out
    }
    return { value: walk(value) as T, counts: totals(byRule) }
  }

  return { redact, redactValue }
}
