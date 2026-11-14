'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../../src/warehouse')

function candidateFixture () {
  const warehouse = Object.create(Warehouse.prototype)
  const rows = [
    { chestId: 'far', x: 20, y: 64, z: 0, blockName: 'barrel', slot: 0, itemKey: 'stone', amount: 32 },
    { chestId: 'near', x: 2, y: 64, z: 0, blockName: 'barrel', slot: 0, itemKey: 'stone', amount: 32 }
  ]
  Object.assign(warehouse, {
    config: { warehouse: { containerSlots: 27 } },
    bot: {
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => [{ name: 'stone', count: 32, stackSize: 64 }] }
    },
    db: { listChestSlots: () => rows },
    catalog: {
      fromPrismarineItem: item => ({ itemKey: item.name }),
      getStackSize: () => 64
    },
    debug: () => {}
  })
  return warehouse
}

test('craft return chooses the nearest matching chest when capacities tie', () => {
  const warehouse = candidateFixture()
  const chest = warehouse.nextDepositChest(new Set(), { craftBatch: true })
  assert.equal(chest.chestId, 'near')
})

test('ordinary deposit keeps the existing deterministic chest ordering', () => {
  const warehouse = candidateFixture()
  const chest = warehouse.nextDepositChest(new Set())
  assert.equal(chest.chestId, 'far')
})

test('craft return does not reopen a chest after its pass is complete', async () => {
  const warehouse = Object.create(Warehouse.prototype)
  const chests = [
    { chestId: 'near', x: 2, y: 64, z: 0, blockName: 'barrel', sameItemFree: 2, emptySlots: 1 },
    { chestId: 'far', x: 20, y: 64, z: 0, blockName: 'barrel', sameItemFree: 2, emptySlots: 1 }
  ]
  let inventory = [
    { name: 'stone', slot: 9, count: 1 },
    { name: 'dirt', slot: 10, count: 1 }
  ]
  const opened = []
  Object.assign(warehouse, {
    config: { timing: { containerSettleMs: 0 }, warehouse: { maxEmptyDepositAttempts: 3, maxFullDepositAttempts: 3 } },
    bot: { entity: { position: { x: 0, y: 64, z: 0 } }, inventory: { items: () => inventory } },
    db: { listChests: () => chests },
    nextDepositChest: (skipped, options) => {
      opened.push({ skipped: [...skipped].sort(), options })
      return chests.find(chest => !skipped.has(chest.chestId)) || null
    },
    openContainerAt: async chest => ({ chestId: chest.chestId }),
    closeContainerQuietly: () => {},
    currentDepositItemsFromContainer: () => inventory.map(item => ({ ...item, windowSlot: item.slot })),
    containerFreeSpaceFor: () => 1,
    tryDepositInto: async (container, item) => {
      if (container.chestId === 'near' && item.name === 'stone') {
        inventory = inventory.filter(value => value.name !== item.name)
        return 1
      }
      if (container.chestId === 'far' && item.name === 'dirt') {
        inventory = inventory.filter(value => value.name !== item.name)
        return 1
      }
      return 0
    },
    refreshChestSnapshot: () => {},
    verifyCraftContainer: async () => {},
    describeChest: chest => chest.chestId,
    debug: () => {},
    trace: () => {}
  })

  await warehouse.depositAllPossible({ craftBatch: true })
  assert.deepEqual(opened.map(entry => entry.options.craftBatch), [true, true])
  assert.deepEqual(opened.map(entry => entry.skipped), [[], ['near']])
  assert.deepEqual(inventory, [])
})
