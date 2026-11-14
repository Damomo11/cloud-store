'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const windows = require('prismarine-windows')('1.21.11')
const Warehouse = require('../../src/warehouse')
const ItemCatalog = require('../../src/itemCatalog')
const { DEFAULT_CONFIG } = require('../../src/config')

function fixture ({ mutateRevision = false } = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.version = '1.21.11'
  const catalog = new ItemCatalog('1.21.11')
  const Item = require('prismarine-item')(catalog.mcData)
  const stoneRow = catalog.fromItemIdAmount('minecraft:stone', 12)
  const stoneKey = stoneRow.itemKey
  const db = {
    chestAmount: 12,
    getItemByKey: () => ({ ...stoneRow, amount: 12 }),
    listSlotsForItemKey: () => [{ chestId: 'source', x: 0, y: 64, z: 0, blockName: 'barrel', slot: 0, itemKey: stoneKey, amount: db.chestAmount }],
    listChestSlots: () => [{ chestId: 'source', x: 0, y: 64, z: 0, blockName: 'barrel', slot: 0, itemKey: stoneKey, amount: db.chestAmount }],
    upsertChest: () => {},
    replaceChestSlots: () => {}
  }
  const bot = Object.assign(new EventEmitter(), {
    username: 'craft-bot',
    registry: catalog.mcData,
    _client: new EventEmitter(),
    inventory: windows.createWindow(0, 'minecraft:inventory', 'Client inventory'),
    entity: { position: { x: 0, y: 64, z: 0 } },
    currentWindow: null
  })
  const warehouse = new Warehouse(bot, db, catalog, config)
  const chestItem = () => new Item(catalog.mcData.itemsByName.stone.id, db.chestAmount)
  const emit = container => bot._client.emit('window_items', {
    windowId: container.id,
    stateId: 1,
    items: container.slots.map(Item.toNotch),
    carriedItem: Item.toNotch(container.selectedItem)
  })
  let openCalls = 0
  let refreshes = 0
  warehouse.openContainerAt = async () => {
    openCalls++
    const container = windows.createWindow(5, 'minecraft:generic_9x3', 'Barrel')
    if (db.chestAmount > 0) container.updateSlot(0, chestItem())
    for (let index = 0; index < 36; index++) container.updateSlot(27 + index, bot.inventory.slots[9 + index] || null)
    bot.currentWindow = container
    bot._client.emit('open_window', { windowId: container.id })
    emit(container)
    return container
  }
  warehouse.closeContainerQuietly = container => {
    if (bot.currentWindow === container) bot.currentWindow = null
  }
  warehouse.tryWithdrawExactFrom = async (container, itemKey, amount) => {
    const source = container.slots[0]
    source.count -= amount
    if (!source.count) container.updateSlot(0, null)
    bot.inventory.updateSlot(9, new Item(catalog.mcData.itemsByName.stone.id, amount))
    container.updateSlot(27, new Item(catalog.mcData.itemsByName.stone.id, amount))
    db.chestAmount -= amount
    emit(container)
    if (mutateRevision) warehouse.warehouseState.chestRevisions.set('source', 99)
    return amount
  }
  warehouse.refreshChestSnapshot = () => { refreshes++ }
  return { warehouse, stoneKey, get openCalls () { return openCalls }, get refreshes () { return refreshes } }
}

async function runBatch (options) {
  const f = fixture(options)
  const result = await f.warehouse.withdrawCraftBatchAllocationsLocked([{
    itemKey: f.stoneKey,
    amount: 4,
    displayName: '石头'
  }], { requireServerEvidence: true })
  return { ...f, result }
}

test('craft batch reuses a confirmed barrel window for final verification', async () => {
  const f = await runBatch()
  assert.deepEqual(f.result.withdrawn.map(value => [value.itemId, value.amount]), [['minecraft:stone', 4]])
  assert.equal(f.openCalls, 1)
  assert.equal(f.refreshes, 1)
})
test('craft batch reopens a barrel when its revision changes during transfer', async () => {
  const f = await runBatch({ mutateRevision: true })
  assert.deepEqual(f.result.withdrawn.map(value => [value.itemId, value.amount]), [['minecraft:stone', 4]])
  assert.equal(f.openCalls, 2)
  assert.equal(f.refreshes, 1)
})

