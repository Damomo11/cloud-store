'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const ItemCatalog = require('../../src/itemCatalog')
const { createInventoryExecutor } = require('../../src/craft/inventory-executor')

require('../../src/via').activate()

const registry = require('prismarine-registry')('26.3')
const Item = require('prismarine-item')(registry)
const catalog = new ItemCatalog('26.3', {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })

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
