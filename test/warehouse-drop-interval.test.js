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
