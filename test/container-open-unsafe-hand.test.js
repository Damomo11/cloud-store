const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../src/warehouse')

function createWarehouse (config = {}) {
  const bot = {
    QUICK_BAR_START: 36,
    quickBarSlot: 0,
    inventory: { slots: {} },
    setQuickBarSlotCalls: [],
    setQuickBarSlot (slot) {
      this.setQuickBarSlotCalls.push(slot)
      this.quickBarSlot = slot
    }
  }
  Object.defineProperty(bot, 'heldItem', {
    get () { return this.inventory.slots[36 + this.quickBarSlot] }
  })
  const warehouse = new Warehouse(bot, {}, {}, {
    warehouse: {},
    timing: {},
    debug: false,
    ...config
  })
  return { warehouse, bot }
}

test('any spawn egg id counts as unsafe for opening containers, even with server-custom names', () => {
  const { warehouse } = createWarehouse()
  assert.equal(warehouse.isUnsafeContainerOpenHeldItem({ name: 'minecraft:cod_spawn_egg' }), true)
  assert.equal(warehouse.isUnsafeContainerOpenHeldItem({ name: 'zombie_spawn_egg' }), true)
  assert.equal(warehouse.isUnsafeContainerOpenHeldItem({ name: 'minecraft:flint' }), true)
  assert.equal(warehouse.isUnsafeContainerOpenHeldItem({ name: 'minecraft:stone' }), false)
  assert.equal(warehouse.isUnsafeContainerOpenHeldItem(null), false)
})

test('configured extra item ids are also treated as unsafe', () => {
  const { warehouse } = createWarehouse({ warehouse: { containerOpenUnsafeHeldItems: ['flint', 'custom_wand'] } })
  assert.equal(warehouse.isUnsafeContainerOpenHeldItem({ name: 'minecraft:custom_wand' }), true)
  assert.equal(warehouse.isUnsafeContainerOpenHeldItem({ name: 'minecraft:stone' }), false)
})

test('opening a container switches away from a held spawn egg to a safe hotbar slot', () => {
  const { warehouse, bot } = createWarehouse()
  bot.inventory.slots[36] = { name: 'minecraft:cod_spawn_egg', count: 1 }
  bot.inventory.slots[37] = null
  bot.inventory.slots[38] = { name: 'minecraft:stone', count: 32 }

  warehouse.ensureSafeHandForContainerOpen()

  assert.deepEqual(bot.setQuickBarSlotCalls, [1])
})

test('no switch happens when every hotbar slot holds an unsafe item', () => {
  const { warehouse, bot } = createWarehouse()
  for (let slot = 0; slot < 9; slot++) {
    bot.inventory.slots[36 + slot] = { name: 'minecraft:cod_spawn_egg', count: 1 }
  }

  warehouse.ensureSafeHandForContainerOpen()

  assert.deepEqual(bot.setQuickBarSlotCalls, [])
})
