const test = require('node:test')
const assert = require('node:assert/strict')

const CloudStoreWebServer = require('../src/webServer')

function createServer (dbOverrides = {}) {
  const db = {
    getOwnerItemsByItemId: () => [],
    getOwnerShulkersContainingItemId: () => [],
    getPlayerItemNameOverrides: () => new Map(),
    isQuickShulkerExtractionEnabled: () => true,
    ...dbOverrides
  }
  return new CloudStoreWebServer(db, { web: {}, language: {} }, () => null)
}

test('litematic plan takes loose first then fills from inside shulker boxes', () => {
  const server = createServer({
    getOwnerItemsByItemId: () => [
      { itemKey: 'stone-key', itemId: 'minecraft:stone', displayName: '石头', amount: 64 }
    ],
    getOwnerShulkersContainingItemId: () => [
      {
        shulkerItemKey: 'box-a', containedItemKey: 'stone-key', containedItemId: 'minecraft:stone',
        containedDisplayName: '石头', containedAmount: 54, shulkerAmount: 3
      }
    ]
  })

  const plan = server.buildLitematicWithdrawPlan('owner-1', {
    materials: [{ itemId: 'minecraft:stone', displayName: '石头', amount: 200, stackSize: 64 }]
  }, 'viewer-1', { includeBoxed: true })

  assert.equal(plan.selected.length, 1)
  const row = plan.selected[0]
  assert.equal(row.itemKey, 'stone-key')
  assert.equal(row.amount, 200)
  assert.equal(row.max, 64 + 54 * 3)
  assert.equal(row.boxedAmount, 200 - 64)
  assert.equal(plan.stats.boxedSelectedAmount, 136)
  assert.equal(plan.missing.length, 0)
})

test('litematic plan selects boxed-only items by their contained item key', () => {
  const server = createServer({
    getOwnerShulkersContainingItemId: () => [
      {
        shulkerItemKey: 'box-b', containedItemKey: 'diamond-key', containedItemId: 'minecraft:diamond',
        containedDisplayName: '钻石', containedAmount: 5, shulkerAmount: 4
      }
    ]
  })

  const plan = server.buildLitematicWithdrawPlan('owner-1', {
    materials: [{ itemId: 'minecraft:diamond', displayName: '钻石', amount: 10, stackSize: 64 }]
  }, 'viewer-1', { includeBoxed: true })

  assert.equal(plan.selected.length, 1)
  const row = plan.selected[0]
  assert.equal(row.itemKey, 'diamond-key')
  assert.equal(row.itemId, 'minecraft:diamond')
  assert.equal(row.amount, 10)
  assert.equal(row.max, 20)
  assert.equal(row.boxedAmount, 10)
  assert.equal(plan.stats.boxedSelectedAmount, 10)
})

test('litematic plan reports shortage against loose plus boxed stock', () => {
  const server = createServer({
    getOwnerItemsByItemId: () => [
      { itemKey: 'stone-key', itemId: 'minecraft:stone', displayName: '石头', amount: 64 }
    ],
    getOwnerShulkersContainingItemId: () => [
      {
        shulkerItemKey: 'box-a', containedItemKey: 'stone-key', containedItemId: 'minecraft:stone',
        containedDisplayName: '石头', containedAmount: 54, shulkerAmount: 3
      }
    ]
  })

  const plan = server.buildLitematicWithdrawPlan('owner-1', {
    materials: [{ itemId: 'minecraft:stone', displayName: '石头', amount: 500, stackSize: 64 }]
  }, 'viewer-1', { includeBoxed: true })

  assert.equal(plan.selected.length, 1)
  assert.equal(plan.selected[0].amount, 226)
  assert.equal(plan.missing.length, 1)
  assert.equal(plan.missing[0].available, 226)
  assert.equal(plan.missing[0].missing, 274)
  assert.equal(plan.missing[0].reason, 'short')
})

test('litematic plan ignores boxed stock by default or when quick extraction is off', () => {
  const shulkerRows = [
    {
      shulkerItemKey: 'box-b', containedItemKey: 'diamond-key', containedItemId: 'minecraft:diamond',
      containedDisplayName: '钻石', containedAmount: 5, shulkerAmount: 4
    }
  ]

  const defaultPlan = createServer({ getOwnerShulkersContainingItemId: () => shulkerRows })
    .buildLitematicWithdrawPlan('owner-1', {
      materials: [{ itemId: 'minecraft:diamond', displayName: '钻石', amount: 10, stackSize: 64 }]
    })
  assert.equal(defaultPlan.selected.length, 0)
  assert.equal(defaultPlan.missing[0].reason, 'unavailable')

  const extractionOff = createServer({
    getOwnerShulkersContainingItemId: () => shulkerRows,
    isQuickShulkerExtractionEnabled: () => false
  })
  const materials = [{ itemId: 'minecraft:diamond', displayName: '钻石', amount: 10, stackSize: 64 }]
  const includeBoxed = false
  const plan = extractionOff.buildLitematicWithdrawPlan('owner-1', { materials }, 'viewer-1', { includeBoxed })
  assert.equal(plan.selected.length, 0)
  assert.equal(plan.missing[0].reason, 'unavailable')
})

test('litematic plan merges boxed top-up into the existing loose selection entry', () => {
  const server = createServer({
    getOwnerItemsByItemId: () => [
      { itemKey: 'stone-key', itemId: 'minecraft:stone', displayName: '石头', amount: 64 }
    ],
    getOwnerShulkersContainingItemId: () => [
      {
        shulkerItemKey: 'box-a', containedItemKey: 'stone-key', containedItemId: 'minecraft:stone',
        containedDisplayName: '石头', containedAmount: 54, shulkerAmount: 1
      },
      {
        shulkerItemKey: 'box-c', containedItemKey: 'stone-key', containedItemId: 'minecraft:stone',
        containedDisplayName: '石头', containedAmount: 10, shulkerAmount: 2
      }
    ]
  })

  const plan = server.buildLitematicWithdrawPlan('owner-1', {
    materials: [{ itemId: 'minecraft:stone', displayName: '石头', amount: 100, stackSize: 64 }]
  }, 'viewer-1', { includeBoxed: true })

  assert.equal(plan.selected.length, 1)
  const row = plan.selected[0]
  assert.equal(row.amount, 100)
  assert.equal(row.max, 64 + 54 + 20)
  assert.equal(row.boxedAmount, 36)
})
