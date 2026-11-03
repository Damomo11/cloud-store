'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const { DEFAULT_CONFIG } = require('../../src/config')
const { planToCraftCommand } = require('../../src/craft')

test('warehouse plan binds concrete ingredients to the owner stock and configured timeout', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.craft.timeoutMs = 90000
  const result = planToCraftCommand({ item: 'stick', quantity: 4, available: { oak_planks: 2 }, config })
  assert.equal(result.ok, true)
  assert.equal(result.command.budgetMs, 90000)
  assert.deepEqual(result.command.craftSteps[0].inputs, [{ names: ['oak_planks'], count: 2 }])
  assert.deepEqual(result.command.inventoryUses, [{ name: 'oak_planks', quantity: 2 }])
})

test('warehouse planner uses the configured live recipe version', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.craft.table = { x: 0, y: 64, z: 0 }
  const result = planToCraftCommand({ item: 'copper_sword', quantity: 1, available: { copper_ingot: 2, stick: 1 }, config })
  assert.equal(result.ok, true)
  assert.equal(result.command.craftSteps[0].requiresTable, true)
})

test('forceCraft plans the full quantity even when the target is already stocked', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  const planned = planToCraftCommand({ item: 'stick', quantity: 4, available: { stick: 64, oak_planks: 2 }, config, forceCraft: true })
  assert.equal(planned.ok, true)
  assert.deepEqual(planned.command.inventoryUses, [{ name: 'oak_planks', quantity: 2 }])
})

test('forceCraft still refuses items the warehouse alone cannot produce', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  // diamond_ore has no recipe: forceCraft must not hide its stock only to
  // fail plan-reachability instead of the clearer stocked answer.
  const planned = planToCraftCommand({ item: 'diamond_ore', quantity: 4, available: { diamond_ore: 64 }, config, forceCraft: true })
  assert.equal(planned.ok, false)
  assert.equal(['plan_unreachable', 'already_in_warehouse'].includes(planned.reason), true)
})

test('warehouse plan cannot collect missing inputs or accept unsafe quantities', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  assert.equal(planToCraftCommand({ item: 'stick', quantity: 4, available: {}, config }).ok, false)
  for (const quantity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.equal(planToCraftCommand({ item: 'stick', quantity, available: { oak_planks: 2 }, config }).ok, false)
  }
})

function fixture () {
  const config = structuredClone(DEFAULT_CONFIG)
  const catalog = new ItemCatalog(config.server.version, {}, {})
  const Item = require('prismarine-item')(config.server.version)
  const make = (name, count) => new Item(catalog.mcData.itemsByName[name].id, count)
  const db = new StoreDb(':memory:', config)
  let inventory = []
  const stored = new Map()
  const chest = { chestId: '0,64,0', x: 0, y: 64, z: 0, blockName: 'barrel' }
  db.upsertChest(chest)
  function refresh () {
    db.replaceChestSlots(chest.chestId, [...stored.values()].filter(item => item.count > 0).map((item, slot) => ({ ...catalog.fromPrismarineItem(item), slot })))
  }
  const bot = new (require('node:events').EventEmitter)()
  bot._client = new (require('node:events').EventEmitter)()
  bot.inventory = { items: () => inventory, selectedItem: null, slots: [] }
  bot.username = 'CraftBot'
  const warehouse = {
    withWarehouseLock: fn => fn(),
    goHomeIfAway: async () => {},
    withdrawAllocationsLocked: async allocations => {
      const withdrawn = []
      for (const a of allocations) {
        const count = Math.min(a.amount, stored.get(a.itemKey)?.count || 0)
        if (count) {
          const source = stored.get(a.itemKey)
          source.count -= count
          inventory.push(make(source.name, count))
          withdrawn.push({ ...db.getItemByKey(a.itemKey), amount: count })
        }
      }
      refresh()
      return { withdrawn, missing: allocations.filter(a => !withdrawn.some(w => w.itemKey === a.itemKey && w.amount === a.amount)) }
    },
    depositAllPossible: async () => {
      for (const item of inventory) {
        const key = catalog.fromPrismarineItem(item).itemKey
        if (!stored.has(key)) stored.set(key, make(item.name, 0))
        stored.get(key).count += item.count
      }
      inventory = []
      refresh()
      return { stopReason: '' }
    },
    openContainerAt: async () => {
      const container = { id: 7, type: 'minecraft:generic_9x3', inventoryStart: 27, inventoryEnd: 63 }
      const items = Array.from({ length: 63 }, () => Item.toNotch(null))
      Array.from(stored.values()).filter(value => value.count > 0).forEach((value, index) => { items[index] = Item.toNotch(value) })
      inventory.forEach((value, index) => { items[27 + index] = Item.toNotch(value) })
      bot.currentWindow = container
      bot._client.emit('open_window', { windowId: container.id })
      bot._client.emit('window_items', { windowId: container.id, items, carriedItem: Item.toNotch(null) })
      bot.emit('windowOpen', container)
      return container
    },
    refreshChestSnapshot: () => refresh(),
    closeContainerQuietly: () => { bot.currentWindow = null }
  }
  function seed (owner, name, count) {
    const item = make(name, count)
    const row = catalog.fromPrismarineItem(item)
    db.addBalanceItems(owner, [row])
    if (!stored.has(row.itemKey)) stored.set(row.itemKey, make(name, 0))
    stored.get(row.itemKey).count += count
    refresh()
    return row
  }
  const executor = {
    execute: async ({ step }) => {
      const before = catalog.aggregatePrismarineItems(inventory)
      inventory = [make(step.result.name, step.result.count)]
      const after = catalog.aggregatePrismarineItems(inventory)
      return { before, after, consumed: before, produced: after }
    },
    cancel: () => {},
    isBusy: () => false
  }
  return { db, config, catalog, bot, warehouse, executor, seed, stored, make, refresh,
    getInventory: () => inventory, setInventory: items => { inventory = items } }
}

test('whole warehouse craft flow converts only Alice stock and returns products to the same warehouse', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const plank = f.seed('alice', 'oak_planks', 2)
    const bob = f.seed('bob', 'spruce_planks', 100)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const result = await controller.run({ actor: 'Alice', owner: { uuid: 'alice', username: 'Alice', scope: 'personal' }, item: 'stick', quantity: 4 })
    assert.equal(result.status, 'complete')
    assert.equal(f.db.getBalance('alice', plank.itemKey), 0)
    assert.equal(f.db.getBalance('bob', bob.itemKey), 100)
    const sticks = f.db.getOwnerItemsByItemId('alice', 'minecraft:stick')
    assert.equal(sticks[0].amount, 4)
    assert.equal(f.stored.get(sticks[0].itemKey).count, 4)
    assert.deepEqual(f.getInventory(), [])
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM inventory_reservations').get().n, 0)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='craft_consume'").get().n, 1)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='craft_produce'").get().n, 1)
    assert.deepEqual(controller.ledger.pending(), [])
  } finally { f.db.close() }
})

test('initial craft journal records the physical baseline before navigation', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const planks = f.seed('alice', 'oak_planks', 2)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    let observed
    f.warehouse.goHomeIfAway = async () => {
      observed = controller.ledger.pending()[0]
      throw new Error('navigation interrupted')
    }
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }), /navigation interrupted/)
    assert.equal(observed.phase, 'ready')
    assert.deepEqual(observed.data.physicalTotals.map(item => [item.itemKey, item.amount]), [[planks.itemKey, 2]])
  } finally { f.db.close() }
})

test('a partial withdrawal is returned without creating a new deposit balance', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const plank = f.seed('alice', 'oak_planks', 2)
    f.stored.get(plank.itemKey).count = 1
    f.warehouse.refreshChestSnapshot()
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice', username: 'Alice' }, item: 'stick', quantity: 4 }), /原料|material/)
    assert.equal(f.db.getBalance('alice', plank.itemKey), 2)
    assert.equal(f.stored.get(plank.itemKey).count, 1)
    assert.deepEqual(f.getInventory(), [])
    assert.deepEqual(controller.ledger.pending(), [])
  } finally { f.db.close() }
})

test('multi-step recipes keep intermediates reserved and return surplus output to the owner', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const log = f.seed('alice', 'oak_log', 1)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const run = f.executor.execute
    let triggers = 0
    f.executor.execute = async args => {
      triggers++
      assert.equal(controller.ledger.pending().length, 1)
      assert.ok(controller.ledger.listCraftReservations(controller.ledger.pending()[0].id).length)
      assert.throws(() => f.db.adjustBalance('alice', log.itemKey, 1), /合成|craft/)
      return run(args)
    }
    const result = await controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 5 })
    assert.equal(result.status, 'complete')
    assert.equal(triggers, 3)
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:stick')[0].amount, 8)
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:oak_planks').length, 0)
    assert.deepEqual(controller.ledger.pending(), [])
  } finally { f.db.close() }
})

test('requested quantity is crafted on top of existing finished items', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 4)
    const sticks = f.seed('alice', 'stick', 2)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    // 6 requested with 2 already stored: forceCraft crafts the full 6.
    // The graph's cheapest stick recipe yields 4 per trigger (2 planks),
    // so two triggers cover 6: 2 existing + 8 crafted = 10 final.
    await controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 6 })
    assert.equal(f.db.getBalance('alice', sticks.itemKey), 10)
    assert.equal(f.stored.get(sticks.itemKey).count, 10)
  } finally { f.db.close() }
})

test('stock and owner authorization are rechecked when the queued task starts', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const plank = f.seed('alice', 'oak_planks', 2)
    const request = { actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }
    assert.equal(planToCraftCommand({ ...request, available: { oak_planks: 2 }, config: f.config }).ok, true)
    const controller = new CraftController({ ...f, botId: 'bot-a', validateOwner: () => { throw new Error('member removed') } })
    await assert.rejects(controller.run(request), /member removed/)
    controller.validateOwner = () => {}
    f.db.adjustBalance('alice', plank.itemKey, -2)
    await assert.rejects(controller.run(request), /原料|配方/)
    assert.deepEqual(controller.ledger.pending(), [])
    assert.deepEqual(f.getInventory(), [])
  } finally { f.db.close() }
})

test('quota checks every trigger including temporary peak before consuming all inputs', () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 64)
    const controller = new CraftController({ ...f, botId: 'bot-a', quota: () => ({ quotaSlots: 2 }) })
    const plan = planToCraftCommand({ item: 'stick', quantity: 128, available: { oak_planks: 64 }, config: f.config }).plan
    assert.throws(() => controller.checkQuota({ uuid: 'alice' }, plan), /额度/)
  } finally { f.db.close() }
})

test('quota includes returned containers as well as the main craft output', () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'honey_bottle', 64)
    const controller = new CraftController({ ...f, botId: 'bot-a', quota: () => ({ quotaSlots: 5 }) })
    const plan = { inventoryUses: [{ name: 'honey_bottle', quantity: 4 }], craftSteps: [{ times: 1, inputs: [{ names: ['honey_bottle'], count: 4 }],
      result: { name: 'honey_block', count: 1 }, outputs: [{ name: 'honey_block', count: 1 }, { name: 'glass_bottle', count: 4 }] }] }
    assert.throws(() => controller.checkQuota({ uuid: 'alice' }, plan), /额度/)
  } finally { f.db.close() }
})

test('full warehouse keeps settled outputs reserved and never issues a second deposit credit', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const plank = f.seed('alice', 'oak_planks', 2)
    f.warehouse.depositAllPossible = async () => ({ stopReason: 'full' })
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }), /空间不足/)
    assert.equal(f.db.getBalance('alice', plank.itemKey), 0)
    const sticks = f.db.getOwnerBalances('alice').find(item => item.itemId === 'minecraft:stick')
    assert.equal(sticks.amount, 4)
    assert.equal(controller.ledger.pending().length, 1)
    assert.equal(controller.ledger.getCraftAvailableItems('alice').length, 0)
    assert.throws(() => f.db.adjustBalance('bob', sticks.itemKey, 1), /合成|craft/)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='craft_produce'").get().n, 1)
  } finally { f.db.close() }
})

test('cancel after a confirmed trigger returns that output and releases only safely stored reservations', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 4)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const run = f.executor.execute
    f.executor.execute = async args => { const result = await run(args); controller.cancel('cancel test'); return result }
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 8 }), /cancel test/)
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:stick')[0].amount, 4)
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:oak_planks')[0].amount, 2)
    assert.deepEqual(f.getInventory(), [])
    assert.deepEqual(controller.ledger.pending(), [])
  } finally { f.db.close() }
})

test('cursor residue after an otherwise complete deposit keeps the craft journal and reservations', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    const deposit = f.warehouse.depositAllPossible
    f.warehouse.depositAllPossible = async () => { await deposit(); f.bot.inventory.selectedItem = f.make('stick', 1) }
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }), /残留/)
    assert.equal(controller.ledger.pending().length, 1)
    assert.equal(controller.ledger.pending()[0].phase, 'recovery_required')
    assert.equal(controller.ledger.listCraftReservations(controller.ledger.pending()[0].id)[0].amount, 4)
  } finally { f.db.close() }
})

module.exports = { fixture }

test('partial return resumes from server snapshots without crediting settled products twice', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    const deposit = f.warehouse.depositAllPossible
    f.warehouse.depositAllPossible = async () => {
      const item = f.getInventory()[0]
      const key = f.catalog.fromPrismarineItem(item).itemKey
      f.stored.set(key, f.make('stick', 2))
      f.setInventory([f.make('stick', 2)])
      f.refresh()
    }
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }), /空间不足/)
    f.warehouse.depositAllPossible = deposit
    assert.equal((await controller.recover()).status, 'recovered')
    assert.equal((await controller.recover()).status, 'empty')
    const sticks = f.db.getOwnerBalances('alice').find(item => item.itemId === 'minecraft:stick')
    assert.equal(sticks.amount, 4)
    assert.equal(f.stored.get(sticks.itemKey).count, 4)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='craft_produce'").get().n, 1)
    assert.deepEqual(controller.ledger.pending(), [])
  } finally { f.db.close() }
})

test('unexplained loss cannot release reservations or turn into a successful recovery', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    f.warehouse.depositAllPossible = async () => {}
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }), /空间不足/)
    f.setInventory([f.make('stick', 3)])
    await assert.rejects(controller.recover(), /实物与记录不一致/)
    assert.equal(controller.ledger.pending().length, 1)
    const sticks = f.db.getOwnerBalances('alice').find(item => item.itemId === 'minecraft:stick')
    assert.equal(sticks.amount, 4)
    assert.equal(controller.ledger.listCraftReservations(controller.ledger.pending()[0].id)[0].amount, 4)
  } finally { f.db.close() }
})

test('recovery holds a cancellable lease until an outstanding container open has drained', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    f.warehouse.depositAllPossible = async () => {}
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }), /空间不足/)
    let release, entered
    const waiting = new Promise(resolve => { entered = resolve })
    const open = f.warehouse.openContainerAt
    f.warehouse.openContainerAt = async (...args) => { entered(); await new Promise(resolve => { release = resolve }); return open(...args) }
    const recovering = controller.recover()
    await waiting
    await assert.rejects(controller.recover(), /旧合成操作/)
    controller.cancel('recovery death test')
    assert.equal(controller.isBusy(), true)
    release()
    await assert.rejects(recovering, /recovery death test/)
    assert.equal(controller.isBusy(), false)
    assert.equal(controller.ledger.pending().length, 1)
  } finally { f.db.close() }
})
