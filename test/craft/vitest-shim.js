'use strict'

// Minimal vitest-compatible shim for the ported olela preparation tests.
// The test bodies are copied verbatim from olela; only the runner imports differ.
// Keep this shim small and dependency-free so the ported tests stay readable.

const nodeTest = require('node:test')
const assert = require('node:assert/strict')

function deepEqual (actual, expected) {
  try {
    assert.deepEqual(actual, expected)
    return true
  } catch {
    return false
  }
}

function isObjectContaining (value) {
  return value && typeof value === 'object' && value.__objectContaining === true
}

function matchesObjectContaining (actual, expected) {
  if (actual == null || typeof actual !== 'object') return false
  return Object.keys(expected.value).every(key => deepEqual(actual[key], expected.value[key]))
}

function matchesExpected (actual, expected) {
  if (isObjectContaining(expected)) return matchesObjectContaining(actual, expected)
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false
    return expected.every((entry, index) => matchesExpected(actual[index], entry))
  }
  if (expected && typeof expected === 'object' && actual && typeof actual === 'object' && !Array.isArray(actual)) {
    const actualKeys = Object.keys(actual)
    const expectedKeys = Object.keys(expected)
    if (actualKeys.length !== expectedKeys.length) return false
    return expectedKeys.every(key => matchesExpected(actual[key], expected[key]))
  }
  return deepEqual(actual, expected)
}

function expect (actual) {
  return {
    toBe (expected) { assert.strictEqual(actual, expected) },
    toEqual (expected) {
      assert.ok(matchesExpected(actual, expected),
        `expected to deep-equal (vitest semantics)\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
    },
    toStrictEqual (expected) { assert.deepStrictEqual(actual, expected) },
    toBeUndefined () { assert.strictEqual(actual, undefined) },
    toBeDefined () { assert.notStrictEqual(actual, undefined) },
    toBeNull () { assert.strictEqual(actual, null) },
    toBeNullish () { assert.ok(actual == null) },
    toBeTruthy () { assert.ok(actual) },
    toBeFalsy () { assert.ok(!actual) },
    toBeGreaterThan (n) { assert.ok(actual > n) },
    toBeGreaterThanOrEqual (n) { assert.ok(actual >= n) },
    toBeLessThan (n) { assert.ok(actual < n) },
    toBeLessThanOrEqual (n) { assert.ok(actual <= n) },
    toHaveLength (n) { assert.strictEqual(actual.length, n) },
    toContain (value) {
      if (Array.isArray(actual)) {
        assert.ok(actual.some(entry => deepEqual(entry, value)), `expected array to contain ${JSON.stringify(value)}`)
      } else {
        assert.ok(String(actual).includes(String(value)), `expected string to contain ${value}`)
      }
    },
    toContainEqual (value) {
      assert.ok(actual.some(entry => {
        if (isObjectContaining(value)) return matchesObjectContaining(entry, value)
        return deepEqual(entry, value)
      }), `expected array to contain equal entry ${JSON.stringify(value)}`)
    },
    toMatchObject (expected) {
      assert.ok(matchesObjectContaining(actual, { __objectContaining: true, value: expected }),
        `expected object to match ${JSON.stringify(expected)}`)
    },
    toMatch (pattern) {
      if (pattern instanceof RegExp) assert.match(actual, pattern)
      else assert.ok(String(actual).includes(String(pattern)))
    },
    toThrow (pattern) {
      assert.throws(actual, pattern ? (pattern instanceof RegExp ? pattern : undefined) : undefined)
    },
    toBeInstanceOf (klass) { assert.ok(actual instanceof klass) },
    not: {
      toBe (expected) { assert.notStrictEqual(actual, expected) },
      toEqual (expected) {
        let equal = true
        try { assert.deepEqual(actual, expected) } catch { equal = false }
        assert.ok(!equal, `expected values not to be deep-equal`)
      },
      toContain (value) {
        const found = Array.isArray(actual)
          ? actual.some(entry => deepEqual(entry, value))
          : String(actual).includes(String(value))
        assert.ok(!found, `expected value not to contain ${JSON.stringify(value)}`)
      },
      toContainEqual (value) {
        const found = actual.some(entry => {
          if (isObjectContaining(value)) return matchesObjectContaining(entry, value)
          return deepEqual(entry, value)
        })
        assert.ok(!found, `expected array not to contain ${JSON.stringify(value)}`)
      },
      toMatchObject (expected) {
        const matches = matchesObjectContaining(actual, { __objectContaining: true, value: expected })
        assert.ok(!matches, `expected object not to match ${JSON.stringify(expected)}`)
      },
      toThrow () { assert.doesNotThrow(actual) }
    }
  }
}

expect.objectContaining = value => ({ __objectContaining: true, value })
expect.anything = () => ({ __anything: true })

function parameterized (runner) {
  return (table) => (name, fn) => {
    for (const row of table) {
      const args = Array.isArray(row) ? row : [row]
      const title = String(name).replace(/%s/g, () => String(args[0]))
      runner(title, () => fn(...args))
    }
  }
}

const it = (...args) => nodeTest.it(...args)
it.each = parameterized(nodeTest.it)

module.exports = {
  describe: nodeTest.describe,
  it,
  test: nodeTest.test,
  expect,
  beforeEach: nodeTest.beforeEach,
  afterEach: nodeTest.afterEach,
  beforeAll: nodeTest.beforeAll,
  afterAll: nodeTest.afterAll
}
