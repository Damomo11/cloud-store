const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../../src/warehouse')
const ItemCatalog = require('../../src/itemCatalog')
const { DEFAULT_CONFIG } = require('../../src/config')

function fixture () {
  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  config.timing.containerSettleMs = 0
  config.timing.containerClickIntervalMs = 0
  const catalog = new ItemCatalog(config.server.version)
  const Item = require('prismarine-item')(catalog.mcData)
  const windows = require('prismarine-windows')(config.server.version)
  const window = windows.createWindow(7, 'minecraft:generic_9x3', 'Barrel')
  const inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  const clicks = []
  const bot = { username: 'CraftBot', inventory, clickWindow: async (slot, mouseButton, mode) => {
    clicks.push({ slot, mouseButton, mode })
    window.acceptClick({ slot, mouseButton, mode, item: window.slots[slot] })
    for (let index = 0; index < 36; index++) inventory.updateSlot(9 + index, window.slots[window.inventoryStart + index])
  } }
  const warehouse = new Warehouse(bot, {}, catalog, config)
  const make = (name, count) => new Item(catalog.mcData.itemsByName[name].id, count)
  const key = name => catalog.fromPrismarineItem(make(name, 1)).itemKey
  const load = (name, counts) => {
    for (let index = 0; index < window.inventoryStart; index++) window.updateSlot(index, counts[index] ? make(name, counts[index]) : null)
  }
  return { warehouse, window, inventory, catalog, make, key, load, clicks }
}

const pistonInputs = [
  ['birch_planks', [...Array(9).fill(64), 36, 36, 36, 36]],
  ['cobblestone', [...Array(13).fill(64), 41, 48, 39]],
  ['iron_ingot', [64, 64, 64, 48]],
  ['redstone', [64, 64, 64, 48]]
]

test('craft withdrawal packs fragmented inputs for 240 pistons into the budgeted 35 slots', async () => {
  const f = fixture()
  for (const [name, counts] of pistonInputs) {
    f.load(name, counts)
    const amount = counts.reduce((sum, count) => sum + count, 0)
    assert.equal(await f.warehouse.tryWithdrawExactFrom(f.window, f.key(name), amount, [], { requireServerEvidence: true }), amount, name)
    assert.equal(f.warehouse.countContainerItem(f.window, f.key(name)), 0)
    assert.equal(f.window.selectedItem, null)
  }
  assert.equal(f.inventory.items().length, 35)
  assert.equal(f.warehouse.emptyInventorySlotCount(), 1)
})

test('ordinary withdrawal retains its existing transfer path for fragmented stacks', async () => {
  const f = fixture()
  for (const [name, counts] of pistonInputs) {
    f.load(name, counts)
    const amount = counts.reduce((sum, count) => sum + count, 0)
    const moved = await f.warehouse.tryWithdrawExactFrom(f.window, f.key(name), amount)
    assert.equal(moved, name === 'redstone' ? 192 : amount)
  }
  assert.equal(f.inventory.items().length, 36)
  assert.equal(f.window.selectedItem, null)
})

test('craft withdrawal fills a partial stack with left clicks and returns the source remainder', async () => {
  const f = fixture()
  f.load('cobblestone', [41, 48, 39])
  assert.equal(await f.warehouse.tryWithdrawExactFrom(f.window, f.key('cobblestone'), 128, [], { requireServerEvidence: true }), 128)
  assert.deepEqual(f.inventory.items().map(item => item.count).sort((a, b) => a - b), [64, 64])
  assert.ok(f.clicks.every(click => click.mouseButton === 0))
  assert.ok(f.clicks.length <= 12, 'filling stack headroom should not right-click each individual item')
  assert.equal(f.window.selectedItem, null)
})

test('craft packing keeps exact requested amounts and does not merge different item fingerprints', async () => {
  const f = fixture()
  const custom = f.make('cobblestone', 40)
  custom.components = [{ type: 'custom_name', data: 'Reserved stone' }]
  f.window.updateSlot(f.window.inventoryStart, custom)
  f.load('cobblestone', [64])
  assert.equal(await f.warehouse.tryWithdrawExactFrom(f.window, f.key('cobblestone'), 17, [], { requireServerEvidence: true }), 17)
  assert.equal(f.window.slots[f.window.inventoryStart].count, 40)
  assert.equal(f.window.slots[0].count, 47)
  assert.equal(f.window.slots[f.window.inventoryStart + 1].count, 17)
  assert.equal(f.window.selectedItem, null)
})

test('craft packing can fill multiple matching partial stacks without any empty inventory slot', async () => {
  const f = fixture()
  for (let index = 0; index < 36; index++) f.window.updateSlot(f.window.inventoryStart + index, f.make('stone', 64))
  f.window.updateSlot(f.window.inventoryStart, f.make('cobblestone', 50))
  f.window.updateSlot(f.window.inventoryStart + 1, f.make('cobblestone', 50))
  for (let index = 0; index < 36; index++) f.inventory.updateSlot(9 + index, f.window.slots[f.window.inventoryStart + index])
  f.load('cobblestone', [64])
  assert.equal(await f.warehouse.tryWithdrawExactFrom(f.window, f.key('cobblestone'), 28, [], { requireServerEvidence: true }), 28)
  assert.equal(f.window.slots[0].count, 36)
  assert.equal(f.window.slots[f.window.inventoryStart].count, 64)
  assert.equal(f.window.slots[f.window.inventoryStart + 1].count, 64)
  assert.equal(f.clicks.length, 6)
  assert.equal(f.window.selectedItem, null)
})
