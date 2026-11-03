'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const CraftLedger = require('../../src/craft/ledger')
const { CraftController } = require('../../src/craft/controller')
const { DEFAULT_CONFIG } = require('../../src/config')

function fixture (options = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  const catalog = new ItemCatalog(config.server.version, {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
  const Item = require('prismarine-item')(catalog.mcData)
  const make = (name, count) => new Item(catalog.mcData.itemsByName[name].id, count)
  const before = catalog.aggregatePrismarineItems([make('oak_planks', 2)])
  const products = catalog.aggregatePrismarineItems([make('stick', 4)])
  let inventory = options.ready ? [] : [make('stick', 4)]
  let stored = options.ready ? [make('oak_planks', 2)] : []
  const serverInventory = options.ready ? [] : (options.unchanged ? [make('oak_planks', 2)] : [make('stick', 4)])
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
    physicalTotals: before, stepIndex: 0
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
    openContainerAt: async () => {
      if (options.openError) throw new Error('window unavailable')
      const container = { id: 7, type: 'minecraft:generic_9x3', inventoryStart: 27, inventoryEnd: 63 }
      bot.currentWindow = container
      if (!options.noPackets) {
        const items = Array.from({ length: options.shortPacket ? 30 : 63 }, () => Item.toNotch(null))
        if (!options.shortPacket) stored.forEach((value, index) => { items[index] = Item.toNotch(value) })
        if (!options.shortPacket) serverInventory.forEach((value, index) => { items[27 + index] = Item.toNotch(value) })
        bot._client.emit('open_window', { windowId: 7 })
        bot._client.emit('window_items', { windowId: 7, items, carriedItem: Item.toNotch(options.carried ? make('stick', 1) : null) })
      }
      bot.emit('windowOpen', container)
      return container
    },
    refreshChestSnapshot: refresh,
    closeContainerQuietly: () => {
      if (!options.noResync) inventory = serverInventory
      bot.currentWindow = null
    },
    depositAllPossible: async () => { deposits++; stored.push(...inventory); inventory = []; refresh() }
  }
  const controller = new CraftController({ bot, db, catalog, config, warehouse, ledger, executor: { isBusy: () => false }, botId: 'bot-a' })
  return {
    db, bot, ledger, controller, before, products, chest,
    deposits: () => deposits,
    confirmed: () => db.db.prepare('SELECT COUNT(*) AS n FROM craft_batches').get().n,
    close: () => db.close()
  }
}

test('recovery cannot turn unconfirmed locally predicted output into a ledger conversion', async () => {
  const f = fixture({ noPackets: true, noResync: true })
  try {
    await assert.rejects(f.controller.recover(), /server|服务端|快照/)
    assert.equal(f.confirmed(), 0)
    assert.equal(f.deposits(), 0)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 2)
    assert.equal(f.ledger.pending().length, 1)
    assert.equal(f.bot._client.listenerCount('window_items'), 0)
  } finally { f.close() }
})

test('recovery rejects local predicted output that differs from the server player slots', async () => {
  const f = fixture({ unchanged: true, noResync: true })
  try {
    await assert.rejects(f.controller.recover(), /server|服务端|快照/)
    assert.equal(f.confirmed(), 0)
    assert.equal(f.deposits(), 0)
    assert.equal(f.ledger.pending().length, 1)
  } finally { f.close() }
})

test('recovery requires a complete player snapshot and fails closed without registered containers', async () => {
  for (const options of [{ shortPacket: true }, { noChests: true }]) {
    const f = fixture(options)
    if (options.noChests) f.db.listChests = () => []
    try {
      await assert.rejects(f.controller.recover(), /server|服务端|快照/)
      assert.equal(f.confirmed(), 0)
      assert.equal(f.deposits(), 0)
    } finally { f.close() }
  }
})

test('a fresh server snapshot can correct prediction and return unchanged inputs without conversion', async () => {
  const f = fixture({ unchanged: true })
  try {
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(f.confirmed(), 0)
    assert.equal(f.deposits(), 1)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 2)
    assert.equal(f.ledger.pending().length, 0)
  } finally { f.close() }
})

test('a fresh complete server snapshot confirms an interrupted conversion exactly once', async () => {
  const f = fixture({ alias: true })
  try {
    const result = await f.controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(f.confirmed(), 1)
    assert.equal(f.db.getBalance('alice', f.before[0].itemKey), 0)
    assert.equal(f.db.getBalance('alice', f.products[0].itemKey), 4)
    assert.equal(f.ledger.pending().length, 0)
    assert.equal((await f.controller.recover()).status, 'empty')
    assert.equal(f.confirmed(), 1)
  } finally { f.close() }
})

test('recovery removes packet observers when opening a container fails', async () => {
  const f = fixture({ openError: true })
  try {
    await assert.rejects(f.controller.recover(), /window unavailable/)
    assert.equal(f.bot._client.listenerCount('window_items'), 0)
    assert.equal(f.bot._client.listenerCount('container_set_content'), 0)
    assert.equal(f.ledger.pending().length, 1)
  } finally { f.close() }
})

test('recovery rejects a nonempty server cursor despite empty local cursor', async () => {
  const f = fixture({ carried: true })
  try {
    await assert.rejects(f.controller.recover(), /光标|cursor/)
    assert.equal(f.confirmed(), 0)
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
