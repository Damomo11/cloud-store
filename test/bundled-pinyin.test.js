const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

test('bundled pronunciation API is self-contained and retains required polyphonic readings', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict')
    const Module = require('node:module')
    const originalLoad = Module._load
    Module._load = function (request, ...args) {
      if (request === 'pinyin-pro' || request.startsWith('pinyin-pro/')) {
        throw new Error('npm pronunciation package must not be required')
      }
      return originalLoad.call(this, request, ...args)
    }
    const { polyphonic } = require('./vendor/pinyin-pro')
    const readings = polyphonic('风弹镐杉绿', { toneType: 'none', type: 'array', v: true })
    for (const [index, expected] of ['feng', 'dan', 'gao', 'shan', 'lv'].entries()) {
      assert.ok(readings[index].includes(expected), expected)
    }
    assert.deepEqual(polyphonic('tnt', { type: 'array' }), [['t'], ['n'], ['t']])
  `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
