const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const CloudStoreWebServer = require('../src/webServer')

function extractFunction (source, name) {
  const marker = `function ${name}(`
  const start = source.indexOf(marker)
  assert(start >= 0, `function ${name} not found`)
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++
    if (source[index] === '}') {
      depth--
      if (!depth) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced ${name}`)
}

test('litematic projection exposes unified shortage and craft status', () => {
  const db = {
    getOwnerItemsByItemId: () => [],
    getOwnerShulkersContainingItemId: () => [],
    getPlayerItemNameOverrides: () => new Map(),
    isQuickShulkerExtractionEnabled: () => true
  }
  const service = {
    buildShortageCraftPlan: (owner, requests, allocations) => {
      assert.equal(owner, 'owner-1')
      assert.equal(requests[0].amount, 5)
      assert.deepEqual(allocations, [])
      return {
        shortages: [{ itemId: 'minecraft:stone', displayName: '石头', requested: 5, allocated: 0, missing: 5, reason: 'short' }],
        craft: [{ itemId: 'minecraft:stone', displayName: '石头', amount: 5, status: 'planned', plan: { craftSteps: [] } }]
      }
    }
  }
  const server = new CloudStoreWebServer(db, {}, () => service)
  const plan = server.buildLitematicWithdrawPlan('owner-1', {
    materials: [{ itemId: 'minecraft:stone', displayName: '石头', amount: 5, stackSize: 64 }]
  })
  assert.deepEqual(plan.selected, [])
  assert.equal(plan.missing[0].missing, 5)
  assert.equal(plan.shortage[0].missing, 5)
  assert.equal(plan.craft[0].status, 'planned')
})

test('bulk projection selection uses available amounts after reservations', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/webServer.js'), 'utf8')
  const factory = new Function(`
    ${extractFunction(source, 'isShulkerItem')}
    ${extractFunction(source, 'mergeBulkItem')}
    ${extractFunction(source, 'flattenBulkItems')}
    return { flattenBulkItems }
  `)
  const { flattenBulkItems } = factory()
  const rows = flattenBulkItems([
    { itemKey: 'stone-key', itemId: 'minecraft:stone', amount: 10, available: 3, reserved: 7, displayName: '石头', shulkerContents: [] }
  ])
  assert.equal(rows[0].amount, 3)
})

test('selection pruning removes rows whose available amount reaches zero', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/webServer.js'), 'utf8')
  const factory = new Function('state', 'displayRows', `
    ${extractFunction(source, 'pruneSelection')}
    return pruneSelection
  `)
  const state = { selected: new Map([['stone-key', { itemKey: 'stone-key', amount: 4, max: 4 }]]) }
  factory(state, () => [{ itemKey: 'stone-key', itemId: 'minecraft:stone', amount: 10, available: 0 }])()
  assert.equal(state.selected.size, 0)
})
