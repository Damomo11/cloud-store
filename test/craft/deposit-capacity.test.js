'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../../src/warehouse')

function fixture (keys, onAttempt) {
  const warehouse = Object.create(Warehouse.prototype)
  let open = true
  let available = false
  const checks = []
  const attempts = []
  const items = keys.map((name, slot) => ({ name, slot, count: 1 }))
  const container = {}
  Object.assign(warehouse, {
    bot: { inventory: { items: () => open ? items : [] } },
    db: { listChests: () => [{}] }, config: { timing: { containerSettleMs: 0 } },
    catalog: { fromPrismarineItem: item => ({ itemKey: item.name }) },
    nextDepositChest: () => ({ chestId: 'a', sameItemFree: 0, emptySlots: 0 }),
    openContainerAt: async () => container,
    closeContainerQuietly: () => { open = false },
    currentDepositItemsFromContainer: () => items,
    containerFreeSpaceFor: (window, key) => { checks.push(key); return key === 'other' || available ? 1 : 0 },
    tryDepositInto: async (window, item) => {
      attempts.push(item.name)
      warehouse.containerFreeSpaceFor(window, item.name)
      if (onAttempt?.(item.name)) available = true
      return 0
    },
    verifyCraftContainer: async () => {}, refreshChestSnapshot () {}, debug () {}, trace () {}, describeChest: () => 'a'
  })
  return { warehouse, checks, attempts }
}

test('craft deposits check a full container once for repeated exact identities', async () => {
  const f = fixture(Array(30).fill('minecart'))
  await f.warehouse.depositAllPossible({ requireServerEvidence: true })
  assert.deepEqual(f.checks, ['minecart'])
  assert.deepEqual(f.attempts, [])
})

test('craft capacity skips distinguish exact variants', async () => {
  const f = fixture(['minecart', 'named-minecart', 'minecart', 'named-minecart'])
  await f.warehouse.depositAllPossible({ requireServerEvidence: true })
  assert.deepEqual(f.checks, ['minecart', 'named-minecart'])
})

test('craft capacity is rechecked after any asynchronous transfer attempt', async () => {
  const f = fixture(['minecart', 'other', 'minecart'], name => name === 'other')
  await f.warehouse.depositAllPossible({ requireServerEvidence: true })
  assert.deepEqual(f.attempts, ['other', 'minecart'])
})

test('ordinary deposits keep checking every source through the original helper', async () => {
  const f = fixture(Array(30).fill('minecart'))
  await f.warehouse.depositAllPossible()
  assert.equal(f.checks.length, 30)
  assert.equal(f.attempts.length, 30)
})
