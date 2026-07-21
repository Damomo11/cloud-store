const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../src/warehouse')
const { DEFAULT_CONFIG } = require('../src/config')

function createWarehouse () {
  const config = structuredClone(DEFAULT_CONFIG)
  config.timing.dropIntervalMs = 40
  const bot = {
    entity: { position: { x: 0, y: 0, z: 0 } },
    players: {},
    inventory: { items: () => [] }
  }
  return new Warehouse(bot, {}, { fromPrismarineItem: item => item }, config)
}

test('inventory decrease confirmation polling is faster than the old 100ms step', async () => {
  const warehouse = createWarehouse()
  let calls = 0
  warehouse.inventoryCountByItemKey = () => (++calls >= 2 ? 0 : 1)

  const startedAt = Date.now()
  const moved = await warehouse.waitForInventoryDecrease('xp', 1, { intervalMs: 25 })
  const elapsed = Date.now() - startedAt

  assert.equal(moved, 1)
  assert.ok(elapsed < 90, `expected confirmation faster than 100ms polling, got ${elapsed}ms`)
})

test('drop cooldown respects configured dropIntervalMs', async () => {
  const warehouse = createWarehouse()
  const startedAt = Date.now()
  await warehouse.waitDropCooldown(startedAt)
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed >= 35, `expected cooldown near configured interval, got ${elapsed}ms`)
})

test('partial container withdrawal moves only the requested count and clears the cursor', async () => {
  const warehouse = createWarehouse()
  warehouse.config.timing.containerSettleMs = 0
  warehouse.config.timing.containerClickIntervalMs = 0
  const sourceSlot = 0
  const destSlot = 27
  const container = {
    inventoryStart: destSlot,
    inventoryEnd: 63,
    slots: new Array(63).fill(null),
    selectedItem: null
  }
  container.slots[sourceSlot] = { name: 'stone', count: 20, slot: sourceSlot }

  warehouse.bot.clickWindow = async (slot, button) => {
    if (slot === sourceSlot && button === 0) {
      if (container.selectedItem) {
        container.slots[sourceSlot] = { ...container.selectedItem, slot: sourceSlot }
        container.selectedItem = null
      } else {
        container.selectedItem = { ...container.slots[sourceSlot] }
        container.slots[sourceSlot] = null
      }
      return
    }
    assert.equal(slot, destSlot)
    assert.equal(button, 1)
    const current = container.slots[destSlot]
    container.slots[destSlot] = { name: 'stone', count: Number(current?.count || 0) + 1, slot: destSlot }
    container.selectedItem.count--
  }

  await warehouse.movePartialContainerSlotToInventory(container, sourceSlot, 7)

  assert.equal(container.slots[sourceSlot].count, 13)
  assert.equal(container.slots[destSlot].count, 7)
  assert.equal(container.selectedItem, null)
})

test('partial container withdrawal rejects a non-empty cursor after returning the remainder', async () => {
  const warehouse = createWarehouse()
  warehouse.config.timing.containerSettleMs = 0
  warehouse.config.timing.containerClickIntervalMs = 0
  const sourceSlot = 0
  const destSlot = 27
  let clicks = 0
  const container = {
    inventoryStart: destSlot,
    inventoryEnd: 63,
    slots: new Array(63).fill(null),
    selectedItem: null
  }
  container.slots[sourceSlot] = { name: 'stone', count: 20, slot: sourceSlot }

  warehouse.bot.clickWindow = async (slot, button) => {
    clicks++
    if (clicks === 1) {
      container.selectedItem = { ...container.slots[sourceSlot] }
      container.slots[sourceSlot] = null
      return
    }
    if (slot === destSlot && button === 1) {
      const current = container.slots[destSlot]
      container.slots[destSlot] = { name: 'stone', count: Number(current?.count || 0) + 1, slot: destSlot }
      container.selectedItem.count--
    }
    // Simulate the server not applying the final click that returns the cursor stack.
  }

  await assert.rejects(
    warehouse.movePartialContainerSlotToInventory(container, sourceSlot, 3),
    /拆分取物后鼠标仍持有 stone x17/
  )
})
