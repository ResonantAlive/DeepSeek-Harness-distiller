import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REDACTION_RULES,
  LITERAL_RULE_ID,
  MIN_SECRET_LENGTH,
  collectEnvironmentSecrets,
  createRedactor,
  createRedactorFromRules,
} from '../src/index.ts'
import type { RedactionRule } from '../src/index.ts'

/**
 * Synthetic secrets only. Every value below is generated in this file and is
 * never a real credential; the suite's whole point is that a configured value
 * cannot survive redaction.
 */
const API_SECRET = 'sk-fixtureABCDEFGHIJKLMNOPQRSTUVWX'
const KEYRING_SECRET = 'fixture-secret-value-0123456789'
const PRIVATE_KEY = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAfixturefixturefixturefixturefixturefixture',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

const ruleIds = (rules: readonly RedactionRule[]) => rules.map(rule => rule.id)

describe('createRedactor', () => {
  it('replaces a caller-supplied literal secret and counts it', () => {
    const redactor = createRedactor({ secrets: [KEYRING_SECRET] })
    const result = redactor.redact(`token is ${KEYRING_SECRET} for now`)
    expect(result.value).toBe('token is [REDACTED:SECRET] for now')
    expect(result.counts.byRule).toEqual({ [LITERAL_RULE_ID]: 1 })
    expect(result.counts.total).toBe(1)
  })

  it('matches the longest literal first when one secret contains another', () => {
    const redactor = createRedactor({ secrets: ['short-secret', 'short-secret-and-more'] })
    expect(redactor.redact('short-secret-and-more').value).toBe('[REDACTED:SECRET]')
  })

  it('ignores literals shorter than the minimum secret length', () => {
    const redactor = createRedactor({ secrets: ['abc'] })
    const result = redactor.redact('abc stays')
    expect(result.value).toBe('abc stays')
    expect(result.counts).toEqual({ byRule: {}, total: 0 })
  })

  it('never rescans a replacement, so a placeholder cannot be re-matched', () => {
    const redactor = createRedactor({ secrets: ['API_KEY=secretvalue1234'] })
    const result = redactor.redact('export API_KEY=secretvalue1234')
    expect(result.value).toBe('export [REDACTED:SECRET]')
    expect(result.counts.total).toBe(1)
  })

  it('is idempotent: redacting its own output changes nothing', () => {
    const redactor = createRedactor({ secrets: [KEYRING_SECRET] })
    const once = redactor.redact(`${KEYRING_SECRET} and ${API_SECRET}`).value
    const twice = redactor.redact(once)
    expect(twice.value).toBe(once)
    expect(twice.counts.total).toBe(0)
  })

  it('applies the greedy hit for two adjacent key-shaped tokens', () => {
    const redactor = createRedactor({})
    const result = redactor.redact(`${API_SECRET}${API_SECRET}`)
    // `sk-[A-Za-z0-9_-]{8,}` is greedy over the shared alphabet, so the two
    // tokens are one span. Over-redacting a real secret is the safe direction.
    expect(result.value).toBe('[REDACTED:API_KEY]')
    expect(result.counts.byRule).toEqual({ 'sk-key': 1 })
  })

  it('applies two key hits separated by a non-key character', () => {
    const redactor = createRedactor({})
    const result = redactor.redact(`${API_SECRET} and ${API_SECRET}`)
    expect(result.value).toBe('[REDACTED:API_KEY] and [REDACTED:API_KEY]')
    expect(result.counts.byRule).toEqual({ 'sk-key': 2 })
  })

  it('leaves text with no hit untouched and returns an empty count', () => {
    const redactor = createRedactor({})
    const result = redactor.redact('nothing sensitive here')
    expect(result.value).toBe('nothing sensitive here')
    expect(result.counts).toEqual({ byRule: {}, total: 0 })
  })

  it('leaves every input untouched when all rules are disabled', () => {
    const redactor = createRedactor({ disable: ruleIds(DEFAULT_REDACTION_RULES) })
    const result = redactor.redact(`${API_SECRET} ${PRIVATE_KEY}`)
    expect(result.value).toBe(`${API_SECRET} ${PRIVATE_KEY}`)
    expect(result.counts.total).toBe(0)
  })

  it('honours a single disabled rule without affecting the others', () => {
    const redactor = createRedactor({ disable: ['sk-key'] })
    const result = redactor.redact(`${API_SECRET} ${PRIVATE_KEY}`)
    expect(result.value).toContain(API_SECRET)
    expect(result.value).toContain('[REDACTED:PRIVATE_KEY]')
  })

  it('treats an unknown disabled id as a no-op', () => {
    const redactor = createRedactor({ disable: ['no-such-rule'] })
    expect(redactor.redact(API_SECRET).value).toBe('[REDACTED:API_KEY]')
  })
})

describe('default pattern rules', () => {
  it('redacts a PEM private key block, including its newlines', () => {
    const redactor = createRedactor({})
    const result = redactor.redact(`before\n${PRIVATE_KEY}\nafter`)
    expect(result.value).toBe('before\n[REDACTED:PRIVATE_KEY]\nafter')
    expect(result.counts.byRule).toEqual({ 'private-key': 1 })
  })

  it('redacts a Bearer credential but keeps the scheme word', () => {
    const redactor = createRedactor({})
    expect(redactor.redact('Authorization: Bearer abcdefghijklmnop').value)
      .toBe('Authorization: [REDACTED:BEARER]')
  })

  it('redacts a bare Authorization header value', () => {
    const redactor = createRedactor({})
    expect(redactor.redact('authorization: abcdefghijklmnop').value)
      .toBe('authorization: [REDACTED:AUTHORIZATION]')
  })

  it('redacts the value of an api_key assignment and keeps the name', () => {
    const redactor = createRedactor({})
    expect(redactor.redact('api_key = SUPERLONGSECRETVALUE').value)
      .toBe('api_key = [REDACTED:SECRET]')
    expect(redactor.redact('API-KEY:SUPERLONGSECRETVALUE').value)
      .toBe('API-KEY:[REDACTED:SECRET]')
  })

  it('does not redact a short bare word that merely looks key-shaped', () => {
    const redactor = createRedactor({})
    expect(redactor.redact('the sk-9 short one').value).toBe('the sk-9 short one')
  })

  it('finishes quickly on a pathologically long non-matching input', () => {
    const redactor = createRedactor({})
    const hostile = '-'.repeat(200_000)
    expect(redactor.redact(hostile).value).toBe(hostile)
  })
})

describe('collectEnvironmentSecrets', () => {
  it('collects a secret-shaped name at or above the minimum length', () => {
    expect(collectEnvironmentSecrets({ MY_TOKEN: KEYRING_SECRET })).toEqual([KEYRING_SECRET])
  })

  it('drops a value shorter than the minimum length', () => {
    expect(collectEnvironmentSecrets({ MY_TOKEN: 'on' })).toEqual([])
  })

  it('ignores names that do not match the secret shape', () => {
    expect(collectEnvironmentSecrets({ MY_VALUE: KEYRING_SECRET })).toEqual([])
  })

  it('ignores non-secret settings whose names merely match the shape', () => {
    for (const name of ['APP_KEY_PATH', 'MY_TOKEN_FILE', 'SEARCH_SECRET_NAME', 'KEYBOARD_LAYOUT', 'TOKEN_LENGTH']) {
      expect(collectEnvironmentSecrets({ [name]: KEYRING_SECRET }), name).toEqual([])
    }
  })

  it('collects the real environment without returning empty values', () => {
    const found = collectEnvironmentSecrets({ A: undefined, B: '', C: undefined })
    expect(found).toEqual([])
  })

  it('deduplicates a value shared by several names', () => {
    expect(collectEnvironmentSecrets({ A_TOKEN: KEYRING_SECRET, B_SECRET: KEYRING_SECRET }))
      .toEqual([KEYRING_SECRET])
  })

  it('defaults to the process environment', () => {
    expect(Array.isArray(collectEnvironmentSecrets())).toBe(true)
  })
})

describe('redactValue', () => {
  it('redacts strings nested in objects and arrays and keeps the structure', () => {
    const redactor = createRedactor({ secrets: [KEYRING_SECRET] })
    const input = {
      command: `echo ${KEYRING_SECRET}`,
      nested: { list: [API_SECRET, 7, true, null] },
    }
    const result = redactor.redactValue(input)
    expect(result.value).toEqual({
      command: 'echo [REDACTED:SECRET]',
      nested: { list: ['[REDACTED:API_KEY]', 7, true, null] },
    })
    expect(result.counts.byRule).toEqual({ [LITERAL_RULE_ID]: 1, 'sk-key': 1 })
    expect(result.counts.total).toBe(2)
  })

  it('returns a fresh structure instead of mutating the input', () => {
    const redactor = createRedactor({})
    const input = { stdout: API_SECRET }
    const result = redactor.redactValue(input)
    expect(input.stdout).toBe(API_SECRET)
    expect(result.value).not.toBe(input)
  })

  it('handles a bare string and a bare primitive', () => {
    const redactor = createRedactor({})
    expect(redactor.redactValue(API_SECRET).value).toBe('[REDACTED:API_KEY]')
    expect(redactor.redactValue(12).value).toBe(12)
  })

  it('accepts the same child object twice without treating it as a cycle', () => {
    const redactor = createRedactor({})
    const child = { text: API_SECRET }
    const result = redactor.redactValue({ a: child, b: child })
    expect(result.value).toEqual({ a: { text: '[REDACTED:API_KEY]' }, b: { text: '[REDACTED:API_KEY]' } })
    expect(result.counts.total).toBe(2)
  })

  it('rejects a cyclic value whose redaction would never terminate', () => {
    const redactor = createRedactor({})
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => redactor.redactValue(cyclic as never)).toThrow(/contains a cycle/)
  })

  it('redacts a user-supplied secret echoed through a JSON line', () => {
    const redactor = createRedactor({ secrets: [KEYRING_SECRET] })
    const line = JSON.stringify({ type: 'tool_result', stdout: `DEEPSEEK_API_KEY=${KEYRING_SECRET}` })
    const result = redactor.redactValue(JSON.parse(line) as Record<string, unknown>)
    expect(JSON.stringify(result.value)).not.toContain(KEYRING_SECRET)
    expect(result.value).toEqual({ type: 'tool_result', stdout: 'DEEPSEEK_API_KEY=[REDACTED:SECRET]' })
  })
})

describe('overlap and degenerate patterns', () => {
  const overlapping: readonly RedactionRule[] = [
    { id: 'outer', placeholder: '[REDACTED:OUTER]', pattern: /BEGIN[\s\S]*?END/g },
    { id: 'inner', placeholder: '[REDACTED:INNER]', pattern: /sk-[A-Za-z0-9]{8,}/g },
  ]

  it('keeps the earlier hit and drops the hit that overlaps it', () => {
    const redactor = createRedactorFromRules(overlapping)
    const result = redactor.redact(`BEGIN ${API_SECRET} END`)
    expect(result.value).toBe('[REDACTED:OUTER]')
    expect(result.counts.byRule).toEqual({ outer: 1 })
  })

  it('places a later-starting hit after an earlier shorter one', () => {
    const redactor = createRedactorFromRules([
      { id: 'first', placeholder: '[REDACTED:FIRST]', pattern: /alpha/g },
      { id: 'second', placeholder: '[REDACTED:SECOND]', pattern: /beta/g },
    ])
    expect(redactor.redact('alpha and beta').value).toBe('[REDACTED:FIRST] and [REDACTED:SECOND]')
  })

  it('skips a zero-width match instead of spinning on it', () => {
    const redactor = createRedactorFromRules([
      { id: 'empty', placeholder: '[REDACTED:EMPTY]', pattern: /(?=x)/g },
      { id: 'width', placeholder: '[REDACTED:WIDTH]', pattern: /x+/g },
    ])
    const result = redactor.redact('x and xx')
    expect(result.value).toBe('[REDACTED:WIDTH] and [REDACTED:WIDTH]')
    expect(result.counts.byRule).toEqual({ width: 2 })
  })

  it('returns the input unchanged when a rule set is empty', () => {
    const redactor = createRedactorFromRules([])
    expect(redactor.redact('anything at all').value).toBe('anything at all')
  })

  it('prefers a literal secret over a rule matching at the same position', () => {
    const redactor = createRedactor({ secrets: [API_SECRET] })
    const result = redactor.redact(`value ${API_SECRET} end`)
    expect(result.value).toBe('value [REDACTED:SECRET] end')
    expect(result.counts.byRule).toEqual({ [LITERAL_RULE_ID]: 1 })
  })

  it('orders two literals that begin at the same position by length', () => {
    const redactor = createRedactor({ secrets: ['fixture-secret-value', 'fixture-secret-value-0123456789'] })
    const result = redactor.redact('fixture-secret-value-0123456789')
    expect(result.value).toBe('[REDACTED:SECRET]')
    expect(result.counts.byRule).toEqual({ [LITERAL_RULE_ID]: 1 })
  })
})

describe('module constants', () => {
  it('exposes the documented rules, length floor, and literal id', () => {
    expect(ruleIds(DEFAULT_REDACTION_RULES)).toEqual([
      'private-key', 'bearer', 'authorization-header', 'sk-key', 'secret-assignment',
    ])
    expect(MIN_SECRET_LENGTH).toBe(8)
    expect(LITERAL_RULE_ID).toBe('literal')
  })

  it('gives every default rule a global pattern', () => {
    for (const rule of DEFAULT_REDACTION_RULES) {
      expect(rule.pattern.global, rule.id).toBe(true)
    }
  })
})
