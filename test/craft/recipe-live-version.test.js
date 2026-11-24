'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const ItemCatalog = require('../../src/itemCatalog')
const { createInventoryExecutor } = require('../../src/craft/inventory-executor')

require('../../src/via').activate()

const registry = require('prismarine-registry')('26.3')
const Item = require('prismarine-item')(registry)
const catalog = new ItemCatalog('26.3', {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })

function copyItem (value) {
  if (!value) return null
  const copy = new Item(value.type, value.count, value.metadata, value.nbt)
  if (value.components) copy.components = structuredClone(value.components)
  if (value.removedComponents) copy.removedComponents = structuredClone(value.removedComponents)
  return copy
}

test('26.3 selects piston recipes without replacing the legacy recipe table', () => {
  const legacyBot = { registry: require('prismarine-registry')('1.21.4') }
  const legacyPiston = legacyBot.registry.itemsByName.piston.id
  const table = { position: { x: 0, y: 64, z: 0 } }
  require('mineflayer/lib/plugins/craft')({ registry })
  require('mineflayer/lib/plugins/craft')(legacyBot)
  const originalRecipes = legacyBot.recipesAll(legacyPiston, null, table)
  assert.ok(originalRecipes.length)
  for (const [name, requiresTable, inputs] of [
    ['sticky_piston', false, { piston: 1, slime_ball: 1 }],
    ['piston', true, { cherry_planks: 3, cobblestone: 4, iron_ingot: 1, redstone: 1 }]
  ]) {
    const inventory = Object.entries(inputs).map(([input, count]) => new Item(registry.itemsByName[input].id, count))
    const bot = { registry, inventory: { items: () => inventory } }
    const executor = createInventoryExecutor(bot, catalog, { craft: { table: { x: 0, y: 64, z: 0 } } }, {})
    const step = {
      requiresTable,
      result: { name, count: 1 },
      inputs: Object.entries(inputs).map(([input, count]) => ({ names: [input], count }))
    }
    const result = executor.preview(step)
    assert.deepEqual(result.expectedProduced.map(item => [item.itemId, item.amount]), [[`minecraft:${name}`, 1]])
  }
  assert.deepEqual(legacyBot.recipesAll(legacyPiston, null, table), originalRecipes)
})

test('confirmed clicks follow the catalog switched after login', async () => {
  const previousRegistry = require('prismarine-registry')('1.21.11')
  const previousCatalog = new ItemCatalog('1.21.11', {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
  const inventory = require('prismarine-windows')('26.3').createWindow(0, 'minecraft:inventory', 'Inventory')
  inventory.updateSlot(9, new Item(registry.itemsByName.stick.id, 2))
  inventory.updateSlot(10, new Item(registry.itemsByName.stick.id, 3))
  const client = new EventEmitter()
  const bot = Object.assign(new EventEmitter(), {
    registry: previousRegistry,
    supportFeature: () => true,
    inventory,
    currentWindow: null,
    _client: client,
    moveSlotItem: async () => {}
  })
  let cursor = null
  client.write = (name, packet) => {
    assert.equal(name, 'window_click')
    const clicked = inventory.slots[packet.slot]
    if (cursor) {
      const target = clicked && clicked.type === cursor.type ? copyItem(clicked) : null
      if (target) target.count += cursor.count
      inventory.updateSlot(packet.slot, target || copyItem(cursor))
      cursor = null
    } else {
      cursor = copyItem(clicked)
      inventory.updateSlot(packet.slot, null)
    }
    client.emit('window_items', {
      windowId: 0,
      stateId: 1,
      items: inventory.slots.map(Item.toNotch),
      carriedItem: Item.toNotch(cursor)
    })
  }
  const executor = createInventoryExecutor(bot, previousCatalog, {
    craft: { confirmTimeoutMs: 100 }
  }, {})

  bot.registry = registry
  executor.setCatalog(catalog)
  const result = await executor.compactInventoryStacks()

  assert.equal(result.moves, 1)
  assert.deepEqual(inventory.items().map(item => [item.name, item.count]), [['stick', 5]])
})
