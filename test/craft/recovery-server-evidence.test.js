'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const CraftLedger = require('../../src/craft/ledger')
const { CraftController } = require('../../src/craft/controller')
const { DEFAULT_CONFIG } = require('../../src/config')

// Recovery now mirrors withdraw interruption recovery: park the interrupted
// backpack into the warehouse first (depositAllPossible), then reconcile the
// craft journal against the combined physical totals. These tests stub the
// deposit as a plain chest-slot write and assert the reconciliation branch.

function fixture (options = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  const catalog = new ItemCatalog(config.server.version, {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
  const Item = require('prismarine-item')(catalog.mcData)
  const make = (name, count) => new Item(catalog.mcData.itemsByName[name].id, count)
  const before = catalog.aggregatePrismarineItems([make('oak_planks', 2)])
  const products = catalog.aggregatePrismarineItems([make('stick', 4)])
  let inventory = options.ready ? [] : (options.held ? options.held.map(value => make(value.name, value.count)) : [make('stick', 4)])
  let stored = options.ready ? [make('oak_planks', 2)] : []
  const db = new StoreDb(':memory:', config)
  const chest = { chestId: '0,64,0', x: 0, y: 64, z: 0, blockName: 'barrel' }
  db.upsertChest(chest)
  db.addBalanceItems('alice', before)
  const ledger = new CraftLedger(db)
  const id = 'craft:server-evidence'
  ledger.begin({ id, botId: 'bot-a', owner: { uuid: 'alice', username: 'Alice' }, actor: 'Alice', allocations: before,
    data: options.ready ? { held: [], pending: null, physicalTotals: before, stepIndex: 0 } : undefined })
  const data = {
    held: products, pending: { stepId: '0:0', before, expectedConsumed: before, expectedProduced: products },
    physicalTotals: options.physicalTotals || before, stepIndex: 0
  }
  if (!options.ready) {
    ledger.checkpoint(id, 'crafting', { ...data, held: before })
    ledger.markRecovery(id, 'craft output lacked server confirmation', data)
  }
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = catalog.mcData
  bot.inventory = { items: () => inventory, selectedItem: null, slots: [] }
  let deposits = 0
  const refresh = () => db.replaceChestSlots(chest.chestId, stored.map((value, slot) => ({ ...catalog.fromPrismarineItem(value), slot })))
  refresh()
  const warehouse = {
    withWarehouseLock: fn => fn(),
    goHomeIfAway: async () => {},
    // The deposit stub moves the whole backpack into the chest-slot ledger
    // exactly like depositAllPossible + refreshChestSnapshot does in production.
    depositAllPossible: async () => {
      deposits++
      stored.push(...inventory)
      inventory = []
      refresh()
      return { deposited: stored, leftover: [], stopReason: '' }
    }
  }
  const controller = new CraftController({ bot, db, catalog, config, warehouse, ledger, executor: { isBusy: () => false }, botId: 'bot-a' })
  return {
    db, bot, ledger, controller, before, products, chest, warehouse,
    deposits: () => deposits,
    confirmed: () => db.db.prepare('SELECT COUNT(*) AS n FROM craft_batches').get().n,
    close: () => db.close()
  }
}

test('recovery parks the backpack first, then confirms the interrupted conversion exactly once', async () => {
  const f = fixture({})
  try {
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(f.deposits(), 1)
    assert.equal(f.confirmed(), 1)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 0)
    assert.equal(f.db.getBalance('alice', f.products[0].itemKey), 4)
    assert.equal(f.ledger.pending().length, 0)
    assert.equal((await f.controller.recover()).status, 'empty')
    assert.equal(f.confirmed(), 1)
  } finally { f.close() }
})

test('recovery returns unchanged inputs without a conversion when nothing reached the table', async () => {
  // Server truth: the withdrawal never happened, backpack holds the inputs.
  const f = fixture({ held: [{ name: 'oak_planks', count: 2 }] })
  try {
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(f.deposits(), 1)
    assert.equal(f.confirmed(), 0)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 2)
    assert.equal(f.ledger.pending().length, 0)
  } finally { f.close() }
})

test('a mismatched backpack settles through registered diff instead of locking the whole store', async () => {
  // Backpack holds sticks x1: neither the raw inputs nor the full conversion.
  // 旧行为：对账失败 → 抛错 + 保留记录锁全库等人工（2026-11-05 生产事故路径）。
  // 新行为：3 次重试后按中断基线登记逐 key 差异（2 planks missing、1 stick
  // excess）+ 失败销账闭环：实物已回仓、归属与异常都留痕，管理员可在 Web 复核。
  const f = fixture({ held: [{ name: 'stick', count: 1 }] })
  try {
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(result.diffRegistered, true)
    assert.equal(f.deposits(), 3, 'each retry attempt parks the backpack once')
    assert.equal(f.confirmed(), 0)
    // Journal closed: no more global lock on deposits/withdraws.
    assert.equal(f.ledger.pending().length, 0)
    // The diff is registered as an inventory mismatch for admin review.
    const mismatches = f.db.db.prepare('SELECT * FROM inventory_mismatches WHERE status = ? ORDER BY kind').all('open')
    assert.equal(mismatches.length, 2)
    const missing = mismatches.find(row => row.kind === 'missing')
    const excess = mismatches.find(row => row.kind === 'excess')
    assert.equal(missing.item_key, f.before[0].itemKey)
    assert.equal(missing.amount, 2)
    assert.equal(excess.item_key, f.products[0].itemKey)
    assert.equal(excess.amount, 1)
    // Owner keeps the un-consumed balance; the reservation is released.
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 2)
  } finally { f.close() }
})

test('recovery fails closed with no registered containers', async () => {
  const f = fixture({})
  f.db.listChests = () => []
  try {
    await assert.rejects(f.controller.recover(), /木桶|容器/)
    assert.equal(f.deposits(), 0)
    assert.equal(f.ledger.pending().length, 1)
  } finally { f.close() }
})

test('an interrupted ready operation with a recorded baseline can close without conversion', async () => {
  const f = fixture({ ready: true })
  try {
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(f.confirmed(), 0)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 2)
    assert.equal(f.ledger.pending().length, 0)
  } finally { f.close() }
})

test('recovery self-heals an open window before parking the backpack', async () => {
  const f = fixture({})
  try {
    // Simulate a mid-click abort: a crafting window left open. Closing it
    // returns grid items to the backpack server-side, so the recovery must
    // park and settle without human intervention.
    f.bot.closeWindow = () => { f.bot.currentWindow = null }
    f.bot.currentWindow = { id: 3, type: 'minecraft:crafting' }
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(f.confirmed(), 1)
    assert.equal(f.ledger.pending().length, 0)
  } finally { f.close() }
})

test('recovery parks a cursor holding a crafted stack into a backpack slot first', async () => {
  const f = fixture({})
  try {
    const catalog = f.controller.catalog
    const Item = require('prismarine-item')(catalog.mcData)
    // Mid-pickup abort: cursor holds the crafted sticks, backpack empty.
    // Parking merges the cursor into a backpack slot, then the deposit path
    // returns them to the warehouse and the conversion confirms.
    const cursorStack = new Item(catalog.mcData.itemsByName.stick.id, 4)
    let backpack = []
    f.bot.inventory = {
      items: () => backpack,
      selectedItem: cursorStack,
      slots: new Array(46).fill(null)
    }
    f.bot.clickWindow = async slot => {
      f.bot.inventory.slots[slot] = f.bot.inventory.selectedItem
      backpack = [f.bot.inventory.selectedItem]
      f.bot.inventory.selectedItem = null
    }
    f.bot.closeWindow = () => {}
    f.warehouse.depositAllPossible = async () => {
      const rows = backpack.map((value, index) => ({ ...catalog.fromPrismarineItem(value), slot: index }))
      backpack = []
      f.db.db.transaction(() => {
        f.db.db.prepare('DELETE FROM chest_slots WHERE chest_id = ?').run(f.chest.chestId)
        for (const row of rows) {
          f.db.upsertItem({ itemKey: row.itemKey, itemId: row.itemId, displayName: row.displayName, nbtJson: row.nbtJson ?? '', metaJson: row.metaJson ?? '' })
          f.db.db.prepare('INSERT INTO chest_slots (chest_id, slot, item_key, amount) VALUES (?, ?, ?, ?)')
            .run(f.chest.chestId, row.slot, row.itemKey, row.amount)
        }
      })()
      return { deposited: rows, leftover: [], stopReason: '' }
    }
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(f.bot.inventory.selectedItem, null)
    assert.ok(f.bot.inventory.slots.some(Boolean))
    assert.equal(f.ledger.pending().length, 0)
    assert.equal(f.db.getBalance('alice', f.products[0].itemKey), 4)
  } finally { f.close() }
})

test('recovery keeps the journal when the deposit leaves items behind (full warehouse)', async () => {
  const f = fixture({})
  try {
    // Warehouse cannot take anything: deposit is a no-op with leftovers.
    f.warehouse.depositAllPossible = async () => ({ deposited: [], leftover: [], stopReason: 'full' })
    await assert.rejects(f.controller.recover(), /空间不足/)
    assert.equal(f.confirmed(), 0)
    assert.equal(f.ledger.pending().length, 1)
  } finally { f.close() }
})
