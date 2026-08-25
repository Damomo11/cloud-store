const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { logLocalError } = require('../src/localErrorLog')

test('local error logger appends structured JSONL records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-error-log-'))
  try {
    logLocalError('test-category', new Error('test failure'), { botId: 'bot-a', taskId: 7 }, { directory })
    const lines = fs.readFileSync(path.join(directory, 'errors.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const entry = JSON.parse(lines[0])
    assert.equal(entry.category, 'test-category')
    assert.equal(entry.botId, 'bot-a')
    assert.equal(entry.taskId, 7)
    assert.equal(entry.error, 'test failure')
    assert.match(entry.stack, /Error: test failure/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
